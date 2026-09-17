import { ItemView, MarkdownRenderer, TAbstractFile, TFile } from "obsidian";
import type WikiLmPlugin from "./main";
import { describeError } from "./llm";
import {
  indexNote,
  numberEvidence,
  rankEvidence,
  type EvidenceUnit,
  questionScorer,
  expandWithGraph,
  rankByKeywords,
  mergeEvidence,
} from "./retrieval";
import type { Graph } from "./graph";
import { lintVault, renderVaultLint, WIKI_SCHEMA, type LintPage } from "./vaultLint";
import { planLinkFixes, applyFixesToNote, type FixPage, type LinkFix } from "./vaultFix";
import { LintReportModal } from "./modals";
import { checkAnswer, emptyIndexAnswer, noEvidenceAnswer, renderGroundingLine, VERIFY_BANNER, type GroundingReport } from "./askCheck";
import { matchCommand, renderHelp, tokenOverlapScorer } from "./chatCommands";
import { WIKILM_COMMANDS, type WikiLmCommand } from "./commands";
import { captureQuizMisses } from "./capture";
import {
  acceptQuestion,
  applyGrade,
  checkQuestion,
  dropUnit,
  isDontKnow,
  nextRequest,
  parseQuizCommand,
  renderGradeMarkdown,
  renderQuestionMarkdown,
  renderSummaryMarkdown,
  resolvePool,
  startSession,
  missesForInbox,
  usableUnits,
  verifyGradeQuote,
  type QuizMiss,
  type QuizScope,
  type QuizSession,
  type Verdict,
  feedbackGrounded,
  disputeGrade,
} from "./quiz";
import type { AskHistoryTurn } from "./prompt";
import { pdfFileName, renderPdfSubpath } from "./pdflink";

/** The linktext that opens a unit's PDF at the page and selection it came from. */
function pdfLinktext(u: EvidenceUnit): string {
  return u.target && u.pdfBasename ? `${pdfFileName(u.pdfBasename)}#${renderPdfSubpath(u.target)}` : "";
}

/**
 * One turn in the chat log.
 *
 * An assistant turn carries the evidence it was answered from, error or not,
 * and the `report` of what the grounding checks did to the draft
 * (src/askCheck.ts:21-29). A system turn is the panel talking about itself —
 * a command running, a command that cannot run, `/help` — and never reaches
 * the model. An `offer` turn is the one-click chip the matcher asks for when a
 * plain sentence merely resembles a command (src/chatCommands.ts:119): it
 * carries the question it was typed as, so "Ask instead" can still ask it.
 *
 * A `quiz` turn is one of the three shapes a quiz puts in the log — the
 * question, the grade, the closing summary. The marker is what `history()`
 * filters on (a quiz is not a conversation the model should see on the next
 * Ask) and what `renderTurn` styles on, and it carries only what the DOM needs
 * that the markdown does not already say: the index for the badge, the verdict
 * for the border colour, the missed units for the summary's chip.
 */
interface ChatTurn {
  role: "user" | "assistant" | "system";
  text: string;
  evidence?: EvidenceUnit[];
  error?: string;
  report?: GroundingReport;
  offer?: { id: string; name: string; question: string };
  quiz?: {
    kind: "question" | "grade" | "summary";
    index?: number;
    verdict?: Verdict;
    misses?: QuizMiss[];
    unverified?: boolean;
  };
}

/**
 * The Ask panel: the chat half of the WikiLM sidebar, owned by `InboxView`.
 *
 * It never imports `./inboxView` — the view hands itself in as an `ItemView`,
 * which is all this needs (a `Component` for `MarkdownRenderer.render`'s
 * lifecycle, obsidian.d.ts:4147, and `registerEvent`, :1886, for the vault
 * listeners that invalidate the index).
 *
 * State lives in memory on the instance, not in the DOM, because the view
 * re-renders on every store change: `render` rebuilds the log from `turns` and
 * the textarea from `draft`, so a card written in the background cannot wipe a
 * half-typed question or the conversation so far.
 *
 * A line typed into the box is not assumed to be a question. `ask` routes it
 * through `matchCommand` (src/chatCommands.ts:73) first, so the chat is also
 * the command line: `/help`, `/extract`, an exact command name, or a chip
 * offering to run the command a sentence resembles. Only what is left over
 * reaches `askQuestion` and the model.
 */
export class ChatPanel {
  private turns: ChatTurn[] = [];
  private busy = false;
  private draft = "";
  private status = "";
  /** The topic-folder index, built on the first question and kept until the vault changes under that folder. */
  private index: EvidenceUnit[] | null = null;
  /** The wikilink graph over the same folder, invalidated with the index. */
  private graph: Graph | null = null;
  private eventsRegistered = false;
  /** The element the panel was last mounted into, so an answer can redraw itself. */
  private root: HTMLElement | null = null;
  /**
   * The quiz being run, or null. Public because it is the whole of the quiz's
   * state: the live run reads it through `view.chat.session` between turns, and
   * `null` is the one test for "is a quiz running" everywhere in this file.
   */
  session: QuizSession | null = null;
  /** What the last finished quiz was and what was missed, kept for the summary's two chips. */
  private lastQuiz: { scope: QuizScope; query: string; misses: QuizMiss[] } | null = null;
  /** Set by the first `/quiz` typed during a quiz; the next one restarts, any other message clears it. */
  private restartArmed = false;

  constructor(
    private plugin: WikiLmPlugin,
    private view: ItemView,
  ) {}

  /** The folder every indexed note must sit under, always with a trailing slash. */
  private folderPrefix(): string {
    const folder = this.plugin.settings.topicFolder.replace(/\/+$/, "");
    return `${folder}/`;
  }

  /**
   * Vault events invalidate the index rather than patching it: rebuilding is a
   * `cachedRead` per topic note, which is cheaper than keeping a correct
   * incremental index across renames. Registered through the view
   * (obsidian.d.ts:1886) so they die with the leaf.
   */
  private registerVaultEvents(): void {
    if (this.eventsRegistered) return;
    this.eventsRegistered = true;
    const vault = this.plugin.app.vault;
    const touched = (path: string) => path.startsWith(this.folderPrefix());
    const invalidate = (file: TAbstractFile) => {
      if (touched(file.path)) {
        this.index = null;
        this.graph = null;
      }
    };
    // obsidian.d.ts:7558 (create), :7564 (modify), :7570 (delete), :7576 (rename).
    this.view.registerEvent(vault.on("create", invalidate));
    this.view.registerEvent(vault.on("modify", invalidate));
    this.view.registerEvent(vault.on("delete", invalidate));
    this.view.registerEvent(
      vault.on("rename", (file, oldPath) => {
        if (touched(file.path) || touched(oldPath)) {
          this.index = null;
          this.graph = null;
        }
      }),
    );
  }

  /** Every evidence unit under the topic folder. Built lazily, cached until a vault event clears it. */
  private async buildIndex(): Promise<EvidenceUnit[]> {
    if (this.index) return this.index;
    this.registerVaultEvents();
    const prefix = this.folderPrefix();
    const units: EvidenceUnit[] = [];
    // obsidian.d.ts:7543 (getMarkdownFiles), :7420 (cachedRead).
    const files = this.plugin.app.vault.getMarkdownFiles().filter((f: TFile) => f.path.startsWith(prefix));
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const file of files) {
      const md = await this.plugin.app.vault.cachedRead(file);
      units.push(...indexNote(file.path, md));
    }
    this.index = units;
    return units;
  }

  /**
   * `/wiki`: what is wrong with the notes, as structure rather than content.
   *
   * No model call — every check is counting links and indexed passages — so
   * this is instant and safe to run whenever the chat feels wrong. It is the
   * answer to "the chatbot can't find anything": a note with nothing quotable
   * in it, or one the graph cannot reach, is invisible to Ask no matter how
   * good it looks in the editor, and this says which notes those are.
   */
  async runVaultLint(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.status = "checking the wiki…";
    this.rerender();
    try {
      const prefix = this.folderPrefix();
      const files = this.plugin.app.vault.getMarkdownFiles().filter((f: TFile) => f.path.startsWith(prefix));
      if (files.length === 0) {
        this.pushSystem(`No notes under “${prefix.replace(/\/$/, "")}”. Set the topic notes folder in WikiLM's settings.`);
        return;
      }
      const pages: LintPage[] = [];
      for (const file of files) {
        pages.push({ path: file.path, content: await this.plugin.app.vault.cachedRead(file) });
      }

      // Everything a quote could have come from: the wiki's own source pages,
      // and every note outside the wiki folder, since a clipping usually lives
      // in the vault rather than under `wiki/`. Read once and shared across
      // pages — the cost is one cachedRead per note, not per quote.
      const sources = new Map<string, string>();
      for (const file of this.plugin.app.vault.getMarkdownFiles()) {
        if (file.path.startsWith(prefix) && !file.path.startsWith(`${prefix}sources/`)) continue;
        sources.set(file.path, await this.plugin.app.vault.cachedRead(file));
      }

      const report = lintVault(pages, { schema: WIKI_SCHEMA, sources });
      const rendered = renderVaultLint(report);
      this.turns.push({ role: "assistant", text: rendered });
      this.trim();

      // The report is a turn in the log either way; the modal is what makes it
      // actionable. Planning the fixes here rather than inside the modal keeps
      // the button's count honest — it says what will actually change, not how
      // many dead links were found.
      const plan = planLinkFixes(report.issues, this.fixPages(pages), new Map(pages.map((p) => [p.path, p.content])), prefix);
      const schemaViolations = report.issues.filter((i) => i.id === "schema-violation").length;
      new LintReportModal(
        this.plugin.app,
        rendered,
        { deadLinksFixable: plan.fixable.length, deadLinksUnresolved: plan.unresolved.length, schemaViolations },
        { onFixDeadLinks: () => void this.applyLinkFixes(plan.fixable) },
      ).open();
    } catch (e) {
      this.pushSystem(`Wiki check failed: ${describeError(e)}`);
    } finally {
      this.busy = false;
      this.status = "";
      this.rerender();
    }
  }

  /**
   * The wiki pages as link targets.
   *
   * `title` is the filename, because that is what a wikilink addresses.
   * `displayTitle` is the page's own `# Heading`, which is what a repaired
   * link should show the reader — a slug in prose reads as a filename, and
   * title-casing one cannot recover the punctuation a real heading has.
   */
  private fixPages(pages: LintPage[]): FixPage[] {
    return pages.map((p) => {
      const cache = this.plugin.app.metadataCache.getCache(p.path);
      const fmAliases = cache?.frontmatter?.aliases;
      const aliases = Array.isArray(fmAliases)
        ? fmAliases.filter((a): a is string => typeof a === "string")
        : typeof fmAliases === "string"
          ? [fmAliases]
          : [];
      return {
        path: p.path,
        title: (p.path.split("/").pop() ?? p.path).replace(/\.md$/i, ""),
        displayTitle: cache?.headings?.find((h) => h.level === 1)?.heading,
        aliases,
      };
    });
  }

  /**
   * Write the planned link rewrites, one pass per note.
   *
   * Grouped by note so a page with six bad links is read and written once, and
   * `process` is used rather than `modify` so a note edited between the lint
   * and the click is rewritten from what it says now, not from the stale copy
   * the lint read.
   */
  private async applyLinkFixes(fixes: LinkFix[]): Promise<void> {
    if (this.busy || fixes.length === 0) return;
    this.busy = true;
    this.status = "fixing links…";
    this.rerender();
    try {
      const byNote = new Map<string, LinkFix[]>();
      for (const fix of fixes) {
        const list = byNote.get(fix.path);
        if (list) list.push(fix);
        else byNote.set(fix.path, [fix]);
      }

      let changed = 0;
      let skipped = 0;
      for (const [notePath, list] of byNote) {
        const file = this.plugin.app.vault.getAbstractFileByPath(notePath);
        if (!(file instanceof TFile)) {
          skipped += list.length;
          continue;
        }
        let touched = false;
        await this.plugin.app.vault.process(file, (data) => {
          const next = applyFixesToNote(data, list);
          touched = next !== data;
          return next;
        });
        if (touched) changed += list.length;
        else skipped += list.length;
      }

      const note = skipped > 0 ? ` ${skipped} left as they were.` : "";
      this.pushSystem(`Fixed ${changed} link${changed === 1 ? "" : "s"} across ${byNote.size} note${byNote.size === 1 ? "" : "s"}.${note}`);
    } catch (e) {
      this.pushSystem(`Fixing links failed: ${describeError(e)}`);
    } finally {
      this.busy = false;
      this.status = "";
      this.rerender();
    }
  }

  /**
   * Widen thin evidence: graph neighbours first, then the model's own terms.
   *
   * A cascade rather than one search, adapted from gd4ai/obsidian-llm-wiki.
   * Each stage only runs when the one before it left the answer short, so the
   * common case — a question whose words are in the notes — costs exactly what
   * it did before, and the expensive stage is paid for only when the cheap
   * ones have visibly failed:
   *
   *   1. lexical (already done by the caller)
   *   2. graph   — passages from notes the matched notes link to. Local, free.
   *   3. keywords — one model call turning the question into the terms the
   *      notes would use, then a local scan with them. Costs a call, so it is
   *      last and is skipped entirely when stages 1-2 filled the slots.
   *
   * Every stage appends; none reorders or drops what lexical search found, so
   * widening can only ever add evidence to an answer.
   */
  private async widenEvidence(q: string, units: EvidenceUnit[], lexical: EvidenceUnit[], k: number): Promise<EvidenceUnit[]> {
    if (lexical.length >= k) return lexical;

    let out = expandWithGraph(lexical, units, this.buildGraphIndex(), k);
    if (out.length >= k || !this.plugin.settings.askKeywordExpansion) return out;

    // The terms are worth asking for even when nothing matched at all: that
    // is the case they exist for, a question phrased in words the notes never
    // use. A failure here is not an error the reader needs to see — the
    // answer simply stays as wide as the local stages made it.
    try {
      this.status = "looking for other wording…";
      this.rerender();
      const titles = [...new Set(units.map((u) => u.noteTitle))];
      const { keywords } = await this.plugin.llm.keywords({ question: q, noteTitles: titles });
      const byKeyword = rankByKeywords(units, keywords, k);
      out = mergeEvidence(out, byKeyword, k);
      // Neighbours of anything the new terms turned up.
      out = expandWithGraph(out, units, this.buildGraphIndex(), k);
    } catch (e) {
      console.debug("[wikilm] keyword expansion failed:", e);
    }
    return out;
  }

  /**
   * The wikilink graph over the topic folder, cached alongside the unit index.
   *
   * Built from `resolvedLinks` (obsidian.d.ts:4438) rather than by re-reading
   * the notes: Obsidian has already resolved every link in the vault to a real
   * path, which is the same work `buildGraph` would redo, and reading files
   * here would make this async in the middle of ranking. `buildGraph` is still
   * what the tests exercise, since it is the pure half.
   */
  private buildGraphIndex(): Graph {
    if (this.graph) return this.graph;
    const prefix = this.folderPrefix();
    const resolved = this.plugin.app.metadataCache.resolvedLinks;
    const nodes = this.plugin.app.vault
      .getMarkdownFiles()
      .filter((f: TFile) => f.path.startsWith(prefix))
      .map((f: TFile) => f.path);
    const known = new Set(nodes);

    const edges = new Map<string, string[]>();
    for (const path of nodes) {
      const targets = Object.keys(resolved[path] ?? {}).filter((t) => t !== path && known.has(t));
      edges.set(path, targets);
    }
    this.graph = { nodes, edges };
    return this.graph;
  }

  /**
   * The last `askMaxTurns` turns, as the prompt wants them (src/prompt.ts:97-106).
   *
   * System turns are the panel narrating itself and offers have no text at all,
   * so neither is conversation: sending them would teach the model that
   * "Ran Extract PDF highlights to manifest." is something it said.
   */
  private history(): AskHistoryTurn[] {
    const keep = Math.max(0, this.plugin.settings.askMaxTurns);
    return this.turns
      .filter((t): t is ChatTurn & { role: "user" | "assistant" } => t.role === "user" || t.role === "assistant")
      // Quiz turns are excluded for the same reason: a question the model was
      // told to write and an answer typed to it are not a conversation about
      // the notes, and replaying them would have the next Ask answer the quiz.
      .filter((t) => !t.error && !t.offer && !t.quiz && t.text.trim().length > 0)
      .slice(-keep)
      .map((t) => ({ role: t.role, text: t.text }));
  }

  /** Keep the log bounded the way the settings ask: `askMaxTurns` exchanges, so twice that many entries. */
  private trim(): void {
    const cap = Math.max(2, this.plugin.settings.askMaxTurns * 2);
    if (this.turns.length > cap) this.turns = this.turns.slice(this.turns.length - cap);
  }

  // --------------------------------------------------------------- routing

  /**
   * What a typed line means, decided before anything is sent anywhere.
   *
   * The command matcher gets `tokenOverlapScorer` (src/chatCommands.ts): shared
   * words between the message and a command name or alias, the same scorer the
   * tests use, so `OFFER_THRESHOLD` means the same thing in the app as in the
   * tests. Obsidian's `prepareFuzzySearch` score scale is undocumented, which is
   * why it is not used for this decision.
   * has been seen in the app.
   */
  async ask(text: string): Promise<void> {
    if (this.busy) return;
    const q = text.trim();

    // `/wiki` is intercepted here as well as being registered as `lint-wiki`,
    // so the report lands in this log rather than opening a second chat. The
    // registry entry is what puts it in the palette and in `/help`; both reach
    // the same `runVaultLint`.
    if (/^\/wiki\b|^\/lint\b|^\/lint-wiki\b/i.test(q)) {
      this.draft = "";
      await this.runVaultLint();
      return;
    }

    // The quiz is tried before the command matcher, because `/quiz`, `/hint`,
    // `/skip`, `/idk` and `/stop` are chat-local and not in the registry
    // (src/quiz.ts:102-126). `parseQuizCommand` returning null is what lets a
    // mistyped `/skpi` still reach `matchCommand` and get its ordinary line.
    const quizCommand = parseQuizCommand(q, !!this.session);
    if (quizCommand) {
      this.draft = "";
      if (quizCommand.kind === "start") {
        // What the reader typed goes in the log like any other line of theirs.
        // Starting a quiz used to be swallowed — the log jumped from nothing to
        // "Quiz on X: 5 questions", so a reader scrolling back could not see
        // what they had asked for, and a quiz that came back on the wrong
        // subject looked like the panel ignoring them rather than a query that
        // read differently than intended. The other quiz commands are left
        // alone: `/skip` and `/idk` are echoed by `gradeWithout`, and `/hint`
        // and `/stop` are answered by the line that follows them.
        this.turns.push({ role: "user", text: q });
        if (this.session && !this.restartArmed) {
          this.restartArmed = true;
          this.pushSystem("A quiz is running. Type /quiz again to restart it.");
          return;
        }
        this.restartArmed = false;
        await this.startQuiz(quizCommand.scope, quizCommand.query);
        return;
      }
      this.restartArmed = false;
      if (!this.session) {
        this.pushSystem("No quiz is running. Type /quiz.");
        return;
      }
      switch (quizCommand.kind) {
        case "stop":
          await this.finishQuiz();
          return;
        case "hint":
          this.showHint();
          return;
        default:
          // `q` is the command itself, so the log shows which one was typed.
          await this.gradeWithout("skipped", q);
          return;
      }
    }

    this.restartArmed = false;

    // Anything that is not a slash command, while a quiz is running, is an
    // answer — including an empty one, which `isDontKnow` (src/quiz.ts:148)
    // reads as "I don't know" so the grader's promise that a blank never
    // reaches it is kept here rather than in the prompt.
    if (this.session && !q.startsWith("/")) {
      this.draft = "";
      if (isDontKnow(q)) {
        await this.gradeWithout("skipped", q);
        return;
      }
      await this.answerQuiz(q);
      return;
    }

    if (!q) return;

    const match = matchCommand(q, WIKILM_COMMANDS, tokenOverlapScorer);

    switch (match.kind) {
      case "help":
        this.draft = "";
        this.pushSystem(this.helpText());
        return;
      case "run": {
        this.draft = "";
        await this.runCommand(match.id);
        return;
      }
      case "unknown":
        this.draft = "";
        this.pushSystem(`No command matches /${match.query}. Type /help.`);
        return;
      case "offer": {
        const command = WIKILM_COMMANDS.find((c) => c.id === match.id);
        if (!command) {
          await this.askQuestion(q);
          return;
        }
        this.draft = "";
        this.turns.push({ role: "user", text: q });
        this.turns.push({
          role: "assistant",
          text: "",
          offer: { id: command.id, name: command.name, question: q },
        });
        this.trim();
        this.rerender();
        return;
      }
      default:
        await this.askQuestion(q);
    }
  }

  /** `/help`: every command, its first alias, its hint, and whether it can run right now. */
  private helpText(): string {
    return renderHelp(
      WIKILM_COMMANDS.map((c) => ({ ...c, available: c.available(this.plugin) })),
      true,
    );
  }

  /** Push a system turn and redraw. System turns are the panel's own voice. */
  private pushSystem(text: string): void {
    this.turns.push({ role: "system", text });
    this.trim();
    this.rerender();
  }

  /**
   * Run one registry command from the chat.
   *
   * The log says what happened and nothing more: the command behaves exactly as
   * it does from the palette, modals and Notices included, so the panel would
   * be lying if it claimed to know the outcome. The "Running…" turn is rewritten
   * in place rather than followed by a second turn, so a burst of commands does
   * not fill the log with pairs.
   */
  private async runCommand(id: string): Promise<void> {
    const command: WikiLmCommand | undefined = WIKILM_COMMANDS.find((c) => c.id === id);
    if (!command) {
      this.pushSystem(`No command matches /${id}. Type /help.`);
      return;
    }
    if (!command.available(this.plugin)) {
      this.pushSystem(`${command.name}: not available now (${command.hint}).`);
      return;
    }

    const turn: ChatTurn = { role: "system", text: `Running ${command.name}…` };
    this.turns.push(turn);
    this.trim();
    this.rerender();

    try {
      await command.run(this.plugin);
      turn.text = `Ran ${command.name}.`;
    } catch (e) {
      turn.text = `${command.name} failed: ${describeError(e)}`;
    } finally {
      this.rerender();
    }
  }

  /**
   * One question: index, rank, number, ask, check the answer against its evidence.
   *
   * Retrieval finding nothing is answered here, not by the model: a model handed
   * no evidence is exactly the situation that invents one, so `noEvidenceAnswer`
   * (src/askCheck.ts:147) says so and the provider is never called — which is
   * also why a vault with no matching notes answers instantly and without a
   * provider error.
   *
   * The evidence is pushed with the assistant turn whether the model answered
   * or failed, because the sources are the part the reader can still use when
   * there is no provider configured.
   */
  private async askQuestion(question: string): Promise<void> {
    const q = question.trim();
    if (!q || this.busy) return;

    this.busy = true;
    this.status = "searching…";
    this.draft = "";
    this.turns.push({ role: "user", text: q });
    this.trim();
    this.rerender();

    let evidence: EvidenceUnit[] = [];
    try {
      const units = await this.buildIndex();
      // `prepareSimpleSearch` (obsidian.d.ts:5260) returns null for no match and
      // a `SearchResult` whose `score` (:5593) `rankEvidence` reads as
      // higher-is-better (src/retrieval.ts:128-134).
      // Weighted by how rare each word is in this vault, so the term that
      // names the topic outranks the one every note happens to use.
      const scorer = questionScorer(q, units);
      const k = this.plugin.settings.askEvidenceCount;
      evidence = rankEvidence(units, q, scorer, k);

      // An empty index is a misconfigured folder, not an unanswerable
      // question: "your notes don't cover this" would blame the notes for a
      // setting. Name the folder that was searched so it can be corrected.
      if (units.length === 0) {
        const { answer, report } = emptyIndexAnswer(this.folderPrefix());
        this.turns.push({ role: "assistant", text: answer, evidence: [], report });
        return;
      }

      evidence = await this.widenEvidence(q, units, evidence, k);

      // Retrieval found nothing. Either say so and stop, or let the model
      // answer from what it knows behind a warning — upstream's choice
      // (gd4ai/obsidian-llm-wiki), and the reader's to make in settings. The
      // model is still called with an empty evidence list in that case, so the
      // prompt's "two honest options" rule is what decides the reply, not this.
      if (evidence.length === 0 && !this.plugin.settings.askGeneralKnowledge) {
        const { answer, report } = noEvidenceAnswer(q);
        this.turns.push({ role: "assistant", text: answer, evidence: [], report });
        return;
      }

      this.status = "asking the model…";
      this.rerender();

      const numbered = numberEvidence(evidence);
      const draft = await this.plugin.llm.ask({
        question: q,
        evidence: numbered,
        history: this.history(),
        standingInstructions: this.plugin.settings.askInstructions,
      });

      const { answer, report } = checkAnswer(draft, numbered);
      this.turns.push({ role: "assistant", text: answer, evidence, report });
    } catch (e) {
      this.turns.push({ role: "assistant", text: "", evidence, error: describeError(e) });
    } finally {
      this.busy = false;
      this.status = "";
      this.trim();
      this.rerender();
    }
  }

  // ------------------------------------------------------------------ quiz

  /**
   * Start a quiz: resolve the pool, then ask the first question.
   *
   * An empty pool is answered here and the provider is never called — the same
   * rule `askQuestion` follows for retrieval finding nothing (above), and the
   * reason `/quiz receptors` in a vault with no digested notes costs nothing
   * and answers instantly. The line names the scope, because "no evidence" is
   * ambiguous between "this note has none" and "the whole folder has none".
   */
  private async startQuiz(scope: "all" | "this" | "query", query: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.status = "gathering evidence…";
    this.draft = "";
    this.rerender();

    let pool: EvidenceUnit[] = [];
    let label = "";
    try {
      const units = await this.buildIndex();
      // obsidian.d.ts:1954 (getActiveFile): null when nothing is open, which
      // `resolvePool` reads as "this note has no evidence".
      const activePath = this.plugin.app.workspace.getActiveFile()?.path ?? null;
      const resolved = resolvePool(
        scope,
        query,
        units,
        activePath,
        questionScorer(query || "", units),
        this.plugin.settings.quizPoolSize,
      );
      pool = resolved.pool;
      label = resolved.label;
    } catch (e) {
      this.turns.push({ role: "assistant", text: "", error: describeError(e) });
      this.busy = false;
      this.status = "";
      this.trim();
      this.rerender();
      return;
    }

    this.busy = false;
    this.status = "";

    if (pool.length === 0) {
      this.session = null;
      this.pushSystem(this.noEvidenceLine(scope, query));
      return;
    }

    const kind: QuizScope["kind"] = scope === "all" ? "all" : scope === "this" ? "note" : "query";
    this.session = startSession({ kind, label }, query, pool, Math.max(1, this.plugin.settings.quizCap));
    this.pushSystem(
      `Quiz on ${label}: questions keep coming until the edge of what you know is found, then the misses go to your inbox as cards. /hint, /skip, /stop.`,
    );
    await this.nextQuestion();
  }

  /** Why a scope has nothing to quiz on, in the scope's own words. */
  private noEvidenceLine(scope: "all" | "this" | "query", query: string): string {
    if (scope === "query") return `No highlights or claims match “${query.trim()}”.`;
    if (scope === "this") return "The active note has no highlights or claims.";
    return `No topic notes under ${this.folderPrefix()} yet.`;
  }

  /**
   * Write the next question, checking its grounding before the reader sees it.
   *
   * The loop is the Design's two-strike rule: a draft that fails
   * `checkQuestion` (src/quiz.ts:259) is asked for once more with the failure
   * named in the prompt, and a second failure drops the cited unit
   * (src/quiz.ts:379) rather than the question, so the numbering stays frozen
   * and the next attempt has one fewer passage to get wrong. A draft whose
   * `evidence_n` is out of range cannot be dropped by id, so that case breaks
   * out instead of looping forever on a model that keeps citing [99].
   */
  private async nextQuestion(): Promise<void> {
    const session = this.session;
    if (!session) return;

    this.busy = true;
    this.status = "writing a question…";
    this.rerender();

    let failure = "";
    try {
      for (;;) {
        const live = this.session;
        if (!live) return;

        if (usableUnits(live).length === 0) {
          this.turns.push({ role: "system", text: "No more passages to quiz on." });
          this.busy = false;
          this.status = "";
          await this.finishQuiz();
          return;
        }

        const req = nextRequest(live);
        const draft = await this.plugin.llm.quizQuestion({
          evidence: live.numbered,
          difficulty: req.difficulty,
          askedQuestions: req.askedQuestions,
          retryOfN: req.retryOfN,
          retryAngle: req.retryAngle,
          standingInstructions: this.plugin.settings.quizInstructions,
          failure,
        });

        const check = checkQuestion(draft, live);
        if (check.ok) {
          const next = acceptQuestion(live, check.question);
          this.session = next;
          const current = next.current;
          if (!current) return;
          this.turns.push({
            role: "assistant",
            text: renderQuestionMarkdown(current),
            quiz: { kind: "question", index: current.n },
          });
          return;
        }

        if (!failure) {
          failure = check.reason;
          continue;
        }

        // Second failure on the same passage: drop it and start over clean.
        failure = "";
        const cited = live.pool[draft.evidence_n - 1];
        if (!cited) {
          this.turns.push({ role: "system", text: `The model could not write a grounded question (${check.reason}).` });
          this.busy = false;
          this.status = "";
          await this.finishQuiz();
          return;
        }
        this.session = dropUnit(live, cited.id);
        this.turns.push({ role: "system", text: "Skipped a passage the model could not turn into a question." });
        this.trim();
        this.rerender();
      }
    } catch (e) {
      this.turns.push({ role: "assistant", text: "", error: describeError(e) });
      this.session = null;
    } finally {
      this.busy = false;
      this.status = "";
      this.trim();
      this.rerender();
    }
  }

  /**
   * One typed answer: graded against the one passage its question came from.
   *
   * A failed model call keeps the session, because the answer is still on the
   * screen and typing it again is the whole recovery — ending the quiz on a
   * provider hiccup would throw away four graded questions.
   */
  private async answerQuiz(text: string): Promise<void> {
    const session = this.session;
    const current = session?.current;
    if (!session || !current || this.busy) return;

    this.busy = true;
    this.status = "grading…";
    this.draft = "";
    this.turns.push({ role: "user", text, quiz: { kind: "grade" } });
    this.trim();
    this.rerender();

    const evidence = session.numbered[current.evidenceN - 1];
    try {
      const grade = await this.plugin.llm.quizGrade({
        evidence,
        question: current.question,
        expected: current.answer,
        userAnswer: text,
      });
      // A grade quoting words the passage does not contain is exactly what the
      // reader needs to spot, so an unverified quote is dropped rather than shown.
      const gradeQuote = verifyGradeQuote(grade.quote, evidence.text);
      const extras = {
        gradeQuoteRejected: !!grade.quote.trim() && !gradeQuote,
        feedbackGrounded: feedbackGrounded(grade.feedback, evidence.text, text),
        dispute: disputeGrade(text, current.answer, grade.verdict, !!gradeQuote),
        gap: grade.gap,
        gapNote: grade.gapNote,
      };
      this.pushGrade(applyGrade(session, grade.verdict, grade.feedback, gradeQuote, text, extras), current.evidenceN);
    } catch (e) {
      this.turns.push({ role: "assistant", text: "", error: describeError(e) });
      this.busy = false;
      this.status = "";
      this.trim();
      this.rerender();
      return;
    }

    this.busy = false;
    this.status = "";
    await this.afterGrade();
  }

  /**
   * A verdict that needs no model call: `/skip` and `/idk` (and a blank line,
   * which `ask` routes here) are one and the same — a declined answer. It shows
   * the expected answer and the passage, because the point of declining in the
   * reference quiz is to be told rather than to be marked wrong.
   */
  private async gradeWithout(verdict: Verdict, userAnswer: string): Promise<void> {
    const session = this.session;
    const current = session?.current;
    if (!session || !current || this.busy) return;
    if (userAnswer.trim()) {
      this.turns.push({ role: "user", text: userAnswer, quiz: { kind: "grade" } });
    }
    // Nothing was graded, so nothing diagnosed it — but declining is its own
    // diagnosis: a passage the reader would not attempt, which is exactly what
    // a card is for.
    const extras = { gap: "detail" as const, gapNote: "could not recall it at all" };
    this.pushGrade(applyGrade(session, verdict, "", "", userAnswer, extras), current.evidenceN);
    await this.afterGrade();
  }

  /** Put the grade on the log and keep the new session. */
  private pushGrade(next: QuizSession, evidenceN: number): void {
    this.session = next;
    const asked = next.asked[next.asked.length - 1];
    const unit = next.pool[evidenceN - 1];
    if (!asked || !unit) return;
    this.turns.push({
      role: "assistant",
      text: renderGradeMarkdown(asked, unit),
      quiz: { kind: "grade", verdict: asked.verdict, unverified: asked.gradeQuoteRejected || !asked.feedbackGrounded },
    });
    this.trim();
    this.rerender();
  }

  /** After any grade: the summary when the count is reached, otherwise the next question. */
  private async afterGrade(): Promise<void> {
    const session = this.session;
    if (!session) return;
    if (session.finished) await this.finishQuiz();
    else await this.nextQuestion();
  }

  /** `/hint`: the generator's one clause, once. Asking twice says so rather than repeating it. */
  private showHint(): void {
    const session = this.session;
    const current = session?.current;
    if (!session || !current) return;
    if (session.hintShown) {
      this.pushSystem("Hint already shown.");
      return;
    }
    this.session = { ...session, hintShown: true };
    this.pushSystem(current.hint ? `Hint: ${current.hint}` : "No hint for this one.");
  }

  /**
   * End the quiz and offer the misses.
   *
   * The session goes to null, but the scope and the missed units stay on the
   * panel: the two chips outlive the session they came from, so "Quiz again"
   * still knows what was being quizzed after the summary has scrolled up.
   */
  private async finishQuiz(): Promise<void> {
    const session = this.session;
    if (!session) return;
    // Each miss carries the question the reader failed, so the card written
    // from it tests that fact and not another one in the same passage.
    const misses = missesForInbox(session);

    this.lastQuiz = { scope: session.scope, query: session.query, misses };
    this.turns.push({
      role: "assistant",
      text: renderSummaryMarkdown(session),
      quiz: { kind: "summary", misses },
    });
    this.session = null;
    this.restartArmed = false;
    this.trim();
    this.rerender();
  }

  /**
   * The summary's first chip. Public because the live run drives it through
   * `eval` on the view, and because the chip is the only thing in the plugin
   * that writes to the inbox from a quiz — nothing is written without it.
   */
  async sendMissesToInbox(): Promise<void> {
    const last = this.lastQuiz;
    if (!last || last.misses.length === 0) {
      this.pushSystem("Nothing was missed.");
      return;
    }
    const { added, skipped } = captureQuizMisses(this.plugin, last.misses);
    this.pushSystem(
      `Sent ${added} passage${added === 1 ? "" : "s"} to the inbox${skipped ? `, ${skipped} already there` : ""}.`,
    );
  }

  /** The summary's second chip: the same scope and the same words, a fresh pool. */
  async quizAgain(): Promise<void> {
    const last = this.lastQuiz;
    if (!last) {
      this.pushSystem("No quiz to repeat. Type /quiz.");
      return;
    }
    const scope = last.scope.kind === "all" ? "all" : last.scope.kind === "note" ? "this" : "query";
    await this.startQuiz(scope, last.query);
  }

  /** Empty the log. The index survives: nothing about the vault changed. */
  clear(): void {
    this.turns = [];
    this.draft = "";
    this.status = "";
    this.session = null;
    this.restartArmed = false;
    this.rerender();
  }

  /** Drop the cached index; the vault listeners belong to the view and go with it. */
  dispose(): void {
    this.index = null;
    this.root = null;
  }

  /** Redraw where the panel is mounted; a no-op when the view is in inbox mode. */
  private rerender(): void {
    const root = this.root;
    if (root?.isConnected) this.render(root);
  }

  // ---------------------------------------------------------------- render

  render(root: HTMLElement): void {
    this.root = root;
    root.querySelector(".wikilm-chat")?.remove();
    const wrap = root.createDiv({ cls: "wikilm-chat" });

    const log = wrap.createDiv({ cls: "wikilm-chat-log" });
    this.wireInternalLinks(log);

    const prefix = this.folderPrefix();
    if (this.turns.length === 0) {
      const hasNotes = this.plugin.app.vault.getMarkdownFiles().some((f: TFile) => f.path.startsWith(prefix));
      log.createDiv({
        cls: "wikilm-muted",
        text: hasNotes
          ? "Ask a question about your topic notes. Answers cite the highlights they came from. Type /help for commands."
          : `No topic notes under ${prefix} yet. Digest a PDF first, or type /help for commands.`,
      });
    }

    for (const turn of this.turns) this.renderTurn(log, turn);

    this.renderInput(wrap);
    log.scrollTop = log.scrollHeight;
  }

  /**
   * Make the wikilinks inside rendered markdown open their notes.
   *
   * `MarkdownRenderer.render` writes a real `a.internal-link` carrying its
   * target in `data-href`, but it attaches no click handler: Obsidian wires
   * those inside its own `MarkdownView`, and this is a plain `ItemView`, so in
   * the panel they rendered as links that did nothing. The quiz felt the gap
   * most — a grade cites `[17] Self-Efficacy` (src/quiz.ts:604), and the note
   * behind the citation is the thing a reader wants after getting one wrong.
   *
   * One delegated listener on the log covers every turn that goes through the
   * markdown renderer — grades, the closing "Missed" list (src/quiz.ts:617),
   * `/help` — rather than each render site wiring its own. `render` rebuilds
   * the log on every state change, so the handler is recreated with it and
   * cannot stack up.
   *
   * Links open in the root split (`"tab"`, obsidian.d.ts:7883), not in the
   * active leaf: the panel usually *is* the active leaf, and a note opened
   * over it would replace the conversation it was opened from. `inboxView.ts`
   * opens its links the same way. The source path is empty because the links
   * evidence writes are vault-absolute, so there is nothing relative to
   * resolve against (obsidian.d.ts:7914).
   */
  private wireInternalLinks(log: HTMLElement): void {
    const open = (e: MouseEvent): void => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const link = target.closest<HTMLElement>("a.internal-link");
      if (!link || !log.contains(link)) return;
      const href = link.getAttribute("data-href") ?? link.getAttribute("href");
      if (!href) return;
      e.preventDefault();
      void this.plugin.app.workspace.openLinkText(href, "", "tab");
    };

    log.addEventListener("click", open);
    // Middle-click, which everywhere else in Obsidian also opens a tab.
    log.addEventListener("auxclick", (e) => {
      if (e.button === 1) open(e);
    });
  }

  private renderTurn(log: HTMLElement, turn: ChatTurn): void {
    const cls =
      turn.role === "user" ? "is-user" : turn.role === "system" ? "is-system" : "is-assistant";
    // The quiz classes are additive: a grade turn is still an assistant turn,
    // it just carries a verdict-coloured border and its own spacing.
    const quizCls =
      turn.quiz && turn.role === "assistant"
        ? turn.quiz.kind === "question"
          ? " wikilm-quiz-question"
          : turn.quiz.kind === "grade"
            ? ` wikilm-quiz-grade is-${turn.quiz.verdict ?? "skipped"}${turn.quiz.unverified ? " is-unverified" : ""}`
            : " wikilm-quiz-summary"
        : "";
    const el = log.createDiv({ cls: `wikilm-chat-turn ${cls}${quizCls}` });
    if (turn.role === "user") {
      el.setText(turn.text);
      return;
    }
    if (turn.role === "system") {
      // `/help` is a markdown list; everything else is one plain line, and
      // plain text is set as text so a command name containing `*` or `_`
      // cannot be read as markup.
      if (turn.text.startsWith("- ")) void MarkdownRenderer.render(this.plugin.app, turn.text, el.createDiv(), "", this.view);
      else el.setText(turn.text);
      return;
    }

    if (turn.offer) {
      this.renderOffer(el, turn);
      return;
    }

    // Above the answer, not below it: a reader who acts on the first sentence
    // must have seen the warning before they read it.
    if (turn.report?.fromGeneralKnowledge) {
      el.createDiv({ cls: "wikilm-chat-verify-banner", text: VERIFY_BANNER });
    }

    if (turn.text.trim()) {
      // sourcePath "" — the evidence links the evidence rows write are
      // vault-absolute (`[[classes/HBIO250/Receptors|Receptors]]`), so there is
      // no relative link for a source path to resolve (obsidian.d.ts:4143).
      void MarkdownRenderer.render(this.plugin.app, turn.text, el.createDiv(), "", this.view);
    }
    if (turn.quiz?.kind === "grade" && turn.quiz.unverified) {
      el.createDiv({ cls: "wikilm-chat-grounding is-unverified" }).createSpan({ cls: "wikilm-badge wikilm-badge-warn", text: "unverified" });
    }
    if (turn.error) el.createDiv({ cls: "wikilm-error", text: turn.error });

    if (turn.quiz?.kind === "summary") {
      this.renderSummaryChips(el, turn.quiz.misses ?? []);
      return;
    }

    const report = turn.report;
    if (report && this.plugin.settings.askShowGrounding) this.renderGrounding(el, report);

    const evidence = turn.evidence ?? [];
    if (evidence.length === 0 || !report) return;
    this.renderSources(el, evidence, report);
  }

  /**
   * The notes behind an answer: one or two links, not the search results.
   *
   * The panel used to print every retrieved passage under every answer — seven
   * boxes for a question the model answered from two of them — so the reader
   * had to scan the evidence to find out which part of it mattered. The model
   * now names the pieces it actually used, and only those are shown: the note,
   * what it contributed, and the page, each one clickable.
   *
   * When the model named nothing (a `none` answer, or a reply that cited
   * badly) the best-ranked passage is shown instead, so there is always
   * somewhere to click through to.
   */
  private renderSources(el: HTMLElement, evidence: EvidenceUnit[], report: GroundingReport): void {
    const picked = report.sources.map((s) => ({ unit: evidence[s.n - 1], why: s.why })).filter((p) => !!p.unit);
    if (picked.length === 0 && report.coverage !== "none") picked.push({ unit: evidence[0], why: "" });
    if (picked.length === 0) return;

    el.createDiv({ cls: "wikilm-chat-sources-head", text: picked.length === 1 ? "Source" : "Sources" });
    for (const { unit, why } of picked) {
      const row = el.createDiv({ cls: "wikilm-chat-source" });

      const link = row.createEl("a", { cls: "wikilm-chat-source-note", text: unit.noteTitle, href: unit.notePath });
      link.addEventListener("click", (e) => {
        e.preventDefault();
        // obsidian.d.ts: openLinkText(linktext, sourcePath, newLeaf).
        void this.plugin.app.workspace.openLinkText(unit.notePath, "", false);
      });

      if (why) row.createSpan({ cls: "wikilm-chat-source-why", text: why });

      if (unit.target && unit.pdfBasename) {
        const page = row.createSpan({ cls: "wikilm-chat-source-page", text: `p.${unit.page}` });
        page.addEventListener("click", (e) => {
          e.preventDefault();
          void this.plugin.app.workspace.openLinkText(pdfLinktext(unit), "", false);
        });
      }

      // The passage itself, quiet under the link: enough to confirm the answer
      // at a glance without becoming the evidence board again.
      row.createDiv({ cls: "wikilm-chat-source-text", text: unit.text });
    }
  }

  /**
   * The one line under an answer: how well the notes covered the question.
   *
   * It used to carry the checker's bookkeeping — sentences kept, sentences
   * removed, quotes verified and rejected — plus the verified quotes
   * themselves in a block quote. That was a second copy of the evidence for a
   * reader who had not asked for the first. What is left is the part that
   * changes what they do next: whether their notes answered the question.
   */
  private renderGrounding(el: HTMLElement, report: GroundingReport): void {
    const line = el.createDiv({ cls: `wikilm-chat-grounding${report.coverage === "none" ? " is-unverified" : ""}` });
    line.createSpan({ text: renderGroundingLine(report) });
  }

  /**
   * The chip for a line that resembles a command without being one.
   *
   * Nothing has been sent anywhere yet at this point: the matcher only guessed,
   * and the two buttons are the two readings of what was typed. Either way the
   * offer turn goes, so the log does not keep a chip whose choice was already
   * made.
   */
  private renderOffer(el: HTMLElement, turn: ChatTurn): void {
    const offer = turn.offer;
    if (!offer) return;
    const row = el.createDiv({ cls: "wikilm-chat-offer" });
    row.createSpan({ cls: "wikilm-muted", text: "Did you mean to run a command?" });

    const run = row.createEl("button", { cls: "mod-cta", text: `Run “${offer.name}”` });
    run.disabled = this.busy;
    run.addEventListener("click", () => {
      this.dropTurn(turn);
      void this.runCommand(offer.id);
    });

    const askInstead = row.createEl("button", { text: "Ask instead" });
    askInstead.disabled = this.busy;
    askInstead.addEventListener("click", () => {
      this.dropTurn(turn);
      void this.askQuestion(offer.question);
    });
  }

  /**
   * The two chips under a summary.
   *
   * The misses are on the turn rather than read from `lastQuiz`, so an old
   * summary still says how many it was about; the buttons call the public
   * methods, which read `lastQuiz` and therefore always act on the most recent
   * quiz. Sending nothing is not offered: the chip is disabled at zero rather
   * than writing an empty batch to the inbox.
   */
  private renderSummaryChips(el: HTMLElement, misses: QuizMiss[]): void {
    const row = el.createDiv({ cls: "wikilm-chat-offer" });
    const send = row.createEl("button", {
      cls: "mod-cta",
      text: `Send ${misses.length} missed to inbox`,
    });
    send.disabled = this.busy || misses.length === 0;
    send.addEventListener("click", () => void this.sendMissesToInbox());

    const again = row.createEl("button", { text: "Quiz again" });
    again.disabled = this.busy;
    again.addEventListener("click", () => void this.quizAgain());
  }

  /** Remove one turn by identity; the user turn that preceded an offer stays, because it was typed. */
  private dropTurn(turn: ChatTurn): void {
    const i = this.turns.indexOf(turn);
    if (i >= 0) this.turns.splice(i, 1);
  }

  private renderInput(wrap: HTMLElement): void {
    const box = wrap.createDiv({ cls: "wikilm-chat-input" });
    const ta = box.createEl("textarea", { cls: "wikilm-chat-textarea" });
    ta.rows = 3;
    ta.placeholder = "Ask your notes, or type /help…";
    ta.value = this.draft;
    ta.disabled = this.busy;
    // The draft lives on the panel, so a store-driven re-render restores it.
    ta.addEventListener("input", () => {
      this.draft = ta.value;
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        ta.blur();
        return;
      }
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      this.draft = ta.value;
      void this.ask(ta.value);
    });

    const row = box.createDiv({ cls: "wikilm-chat-buttons" });
    const send = row.createEl("button", { cls: "mod-cta", text: "Send" });
    send.disabled = this.busy;
    send.addEventListener("click", () => {
      this.draft = ta.value;
      void this.ask(ta.value);
    });
    const clear = row.createEl("button", { text: "Clear" });
    clear.addEventListener("click", () => this.clear());

    row.createSpan({ cls: "wikilm-muted", text: this.status });

    if (!this.busy) window.setTimeout(() => ta.focus(), 0);
  }
}
