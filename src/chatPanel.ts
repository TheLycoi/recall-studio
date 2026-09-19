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
import { planLinkFixes, applyFixesToNote, type LinkFix } from "./vaultFix";
import { FixPlanModal, LintReportModal, pickNote } from "./modals";
import { repointFix, type Fix, type FixPageInfo } from "./fixPlan";
import { applyPlan, buildPlan, fixPagesFor, pageInfos, proposeAliases, providerReady, type FixContext } from "./fixer";
import { checkAnswer, emptyIndexAnswer, noEvidenceAnswer, renderGroundingLine, VERIFY_BANNER, type GroundingReport } from "./askCheck";
import { matchIntent, renderHelp, type Intent, type IntentContext, type IntentPage, type Target } from "./chatCommands";
import { WIKILM_COMMANDS, type WikiLmCommand } from "./commands";
import { captureQuizMisses } from "./capture";
import {
  acceptQuestion,
  applyGrade,
  armRetry,
  checkQuestion,
  dropUnit,
  isDontKnow,
  nextRequest,
  parseQuizCommand,
  renderGradeMarkdown,
  renderQuestionMarkdown,
  renderSummaryMarkdown,
  retryLine,
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
import { pdfFileName, renderPdfSubpath, findAllPdfReferences } from "./pdflink";
import { parseTopicNote, noteAliases } from "./topicNote";
import { isPdfFile, pdfsLinkedFrom } from "./pdf";
import { isManifestNote } from "./pdfHighlights";
import { digestPdf } from "./digest";
import type { GateDecision } from "./digestGate";
import { suggestPdfHighlights } from "./suggest";
import { askTranscript } from "./modals";
import { normalizeTranscript, truncateTranscript } from "./util";

/** The linktext that opens a unit's PDF at the page and selection it came from. */
function pdfLinktext(u: EvidenceUnit): string {
  return u.target && u.pdfBasename ? `${pdfFileName(u.pdfBasename)}#${renderPdfSubpath(u.target)}` : "";
}

/** What a chip calls a target: the file's own name, so the button says what it opens. */
function targetLabel(t: Target): string {
  switch (t.kind) {
    case "pdf":
      return t.basename;
    case "manifest":
      return (t.path.split("/").pop() ?? t.path).replace(/\.md$/i, "");
    case "page":
      return t.title;
    case "class":
      return t.code;
    case "query":
      return t.words;
    default:
      return "the open file";
  }
}

/**
 * One turn in the chat log.
 *
 * An assistant turn carries the evidence it was answered from, error or not,
 * and the `report` of what the grounding checks did to the draft
 * (src/askCheck.ts:21-29). A system turn is the panel talking about itself —
 * a command running, a command that cannot run, `/help` — and never reaches
 * the model. A `chips` turn is the panel's own follow-up question with buttons
 * — which of two files was meant, whether to highlight before digesting,
 * whether to paste a transcript first. It is the shape of "never guess": a
 * target that fits two files is asked about rather than picked.
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
  chips?: { prompt: string; options: Array<{ label: string; run: () => void }> };
  quiz?: {
    kind: "question" | "grade" | "retry" | "summary";
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
 * through `matchIntent` (src/chatCommands.ts) first, so the chat is the
 * studio: a plain phrase with a verb and a target — "quiz me", "digest the
 * doping pdf", "highlight Ch3" — runs the action, a target that fits two
 * files is offered as chips rather than guessed, and only what is left over
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
  private lastQuiz: { scope: QuizScope; query: string; misses: QuizMiss[]; notePath: string | null; classCode: string | null } | null = null;
  /** Set by the first quiz phrase typed during a quiz; the next one restarts, any other message clears it. */
  private restartArmed = false;
  /** The note and class the running quiz was scoped to, so "Quiz again" can repeat it. */
  private lastQuizNotePath: string | null = null;
  private lastQuizClassCode: string | null = null;

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
    const meta: IntentPage[] = [];
    for (const file of files) {
      const md = await this.plugin.app.vault.cachedRead(file);
      units.push(...indexNote(file.path, md));
      // The same read serves the intent matcher: what a page is called, what
      // else it answers to, which class it belongs to, and whether it cites a
      // PDF at all — enough for "digest receptors" to find a file without a
      // second pass over the vault.
      const parsed = parseTopicNote(md);
      meta.push({
        path: file.path,
        title: parsed.title || file.basename,
        aliases: noteAliases(md),
        classCodes: parsed.classCodes,
        hasPdfLinks: findAllPdfReferences(md).length > 0,
      });
    }
    this.index = units;
    this.pageMeta = meta;
    return units;
  }

  /** The pages the intent matcher may name, rebuilt with the index. */
  private pageMeta: IntentPage[] = [];

  /** Everything in the vault a typed target could name. */
  private intentContext(): IntentContext {
    const pdfs = this.plugin.app.vault.getFiles().filter((f) => isPdfFile(f)).map((f) => ({ path: f.path, basename: f.basename }));
    const manifests = this.plugin.app.vault.getMarkdownFiles().filter((f) => isManifestNote(this.plugin, f)).map((f) => f.path);
    return { pages: this.pageMeta, pdfs, manifests, commands: WIKILM_COMMANDS };
  }

  /** The panel's own follow-up with buttons: which file, whether to highlight first, whether to paste a transcript. */
  private pushChips(prompt: string, options: Array<{ label: string; run: () => void }>): void {
    this.turns.push({ role: "assistant", text: "", chips: { prompt, options } });
    this.trim();
    this.rerender();
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
      const links = planLinkFixes(report.issues, fixPagesFor(this.plugin, pages), new Map(pages.map((p) => [p.path, p.content])), prefix);
      const schemaViolations = report.issues.filter((i) => i.id === "schema-violation").length;

      const ctx: FixContext = { report, pages, sources, prefix };
      const infos = pageInfos(this.plugin, pages);
      const plan = await buildPlan(this.plugin, ctx);

      // The model's rows are not in `plan` — they cost a request and are only
      // asked for from inside the modal — so a vault whose only findings are
      // missing aliases would otherwise have no way to reach the button that
      // proposes them. That is what `aliasWork` keeps open.
      const aliasWork = report.issues.some(
        (i) => i.id === "no-aliases" || (i.id === "schema-violation" && i.detail?.startsWith("tag “")),
      );
      const canSuggest = plan.length > 0 || aliasWork;

      new LintReportModal(
        this.plugin.app,
        rendered,
        { deadLinksFixable: links.fixable.length, deadLinksUnresolved: links.unresolved.length, schemaViolations },
        { onFixDeadLinks: () => void this.applyLinkFixes(links.fixable) },
        links.fixable,
        canSuggest ? () => this.openFixPlan(plan, infos, ctx) : undefined,
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
   * Open the plan the Wiki check offered, and write what comes back ticked.
   *
   * The hooks are wired here rather than inside the modal because all three
   * need the plugin: the picker needs the vault's pages, the model button needs
   * the client and the settings, and Apply needs `vault.process`.
   *
   * The re-lint is deliberately *not* awaited inside `apply`. This method is
   * called from the report modal's button, long after `runVaultLint`'s
   * `finally` has cleared `busy` — but `runVaultLint` returns early while busy,
   * and `applyPlan` is itself the reader's write, so the re-run is started once
   * the writes have resolved and the panel is idle again. `void` rather than
   * `await` so the modal's Apply does not sit open across a second full lint.
   */
  private openFixPlan(plan: Fix[], infos: Map<string, FixPageInfo>, ctx: FixContext): void {
    const pages = fixPagesFor(this.plugin, ctx.pages);
    new FixPlanModal(this.plugin.app, plan, {
      pickTarget: (row) => pickNote(this.plugin.app, pages).then((p) => (p ? repointFix(row, p, ctx.prefix) : null)),
      proposeAliases: providerReady(this.plugin.settings)
        ? () => proposeAliases(this.plugin, infos, ctx.report)
        : null,
      apply: async (fixes) => {
        try {
          const r = await applyPlan(this.plugin, fixes);
          const noteWord = r.notes === 1 ? "note" : "notes";
          const fixWord = r.fixes === 1 ? "fix" : "fixes";
          const skipped = r.skipped > 0 ? ` ${r.skipped} had nothing left to change.` : "";
          this.pushSystem(`Applied ${r.fixes} ${fixWord} across ${r.notes} ${noteWord}.${skipped}`);
        } catch (e) {
          this.pushSystem(`Applying the fixes failed: ${describeError(e)}`);
          return;
        }
        // Outside the write's own promise chain: the check the reader now wants
        // is about the vault after the writes, and it re-opens its own modal.
        void this.runVaultLint();
      },
    }).open();
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
   * System turns are the panel narrating itself and chips have no text at all,
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
      .filter((t) => !t.error && !t.chips && !t.quiz && t.text.trim().length > 0)
      .slice(-keep)
      .map((t) => ({ role: t.role, text: t.text }));
  }

  /**
   * Keep the log bounded the way the settings ask: `askMaxTurns` exchanges, so
   * twice that many entries.
   *
   * A chips turn is never dropped, however old it is. Chips are a question the
   * panel is waiting on — a gate, or the transcript prompt — and the promise
   * behind them is resolved by the click on one of those buttons. Evicting the
   * turn takes its buttons off the screen with nothing left to resolve the
   * promise, so the awaiting command hangs and the panel stays busy forever.
   * A pending chips turn is removed when it is answered, not when it is old.
   */
  private trim(): void {
    const cap = Math.max(2, this.plugin.settings.askMaxTurns * 2);
    if (this.turns.length <= cap) return;
    const keep = new Set(this.turns.filter((t) => t.chips));
    for (const t of this.turns.filter((t) => !t.chips).slice(-cap)) keep.add(t);
    this.turns = this.turns.filter((t) => keep.has(t));
  }

  // --------------------------------------------------------------- routing

  /**
   * What a typed line means, decided before anything is sent anywhere.
   *
   * `matchIntent` (src/chatCommands.ts) reads a verb and a target out of a
   * plain phrase, so the chat is the studio rather than a command line with a
   * chat attached. The index is built first because the matcher needs the page
   * titles, aliases and class codes in it to resolve a target at all.
   */
  async ask(text: string): Promise<void> {
    if (this.busy) return;
    const q = text.trim();

    // The quiz controls are chat-local and not in the registry
    // (src/quiz.ts:102-126), and while a session runs they outrank everything
    // else: "skip" during a quiz is a skipped question, not a search. Starting
    // one is no longer handled here — a quiz phrase flows through `matchIntent`
    // like every other verb, so "quiz me on receptors" and "digest" are read
    // the same way.
    const quizCommand = parseQuizCommand(q, !!this.session);
    if (quizCommand && quizCommand.kind !== "start") {
      this.draft = "";
      this.restartArmed = false;
      if (!this.session) {
        this.pushSystem("No quiz is running. Say “quiz me”.");
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

    // Anything that is not a quiz control, while a quiz is running, is an
    // answer — including an empty one, which `isDontKnow` (src/quiz.ts:148)
    // reads as "I don't know" so the grader's promise that a blank never
    // reaches it is kept here rather than in the prompt. A quiz phrase is the
    // exception: it means restart, and `quizTarget` handles the confirmation.
    if (this.session && !(quizCommand && quizCommand.kind === "start")) {
      this.draft = "";
      this.restartArmed = false;
      if (isDontKnow(q)) {
        await this.gradeWithout("skipped", q);
        return;
      }
      await this.answerQuiz(q);
      return;
    }

    if (!q) return;

    await this.buildIndex();
    const intent = matchIntent(q, this.intentContext());
    this.draft = "";
    if (intent.kind === "question") {
      this.restartArmed = false;
      await this.askQuestion(q);
      return;
    }
    // What the reader typed goes in the log like any other line of theirs: a
    // studio action that came back on the wrong subject should look like a
    // phrase read differently than intended, not like the panel ignoring them.
    this.turns.push({ role: "user", text: q });
    await this.runIntent(intent);
  }

  /** Carry out what a phrase asked for. Every branch either acts or says why it cannot. */
  private async runIntent(intent: Intent): Promise<void> {
    switch (intent.kind) {
      case "help":
        this.pushSystem(renderHelp());
        return;
      case "lint":
        await this.runVaultLint();
        return;
      case "export":
        await this.runCommand("export-reviewed");
        return;
      case "inbox":
        await this.runCommand("open-inbox");
        return;
      case "command":
        await this.runCommand(intent.id);
        return;
      case "ambiguous":
        if (intent.candidates.length === 0) {
          this.pushSystem(`Nothing called “${intent.words}” to ${intent.verb}. Open the PDF and say “${intent.verb}”, or name it as the file is named.`);
          return;
        }
        this.pushChips(
          `Which one to ${intent.verb}?`,
          intent.candidates.map((c) => ({ label: targetLabel(c), run: () => void this.runIntent({ kind: intent.verb, target: c }) })),
        );
        return;
      case "quiz":
        await this.quizTarget(intent.target);
        return;
      case "digest":
        await this.digestTarget(intent.target);
        return;
      case "highlight":
        await this.highlightTarget(intent.target);
        return;
    }
  }

  /**
   * Start a quiz on whatever the phrase named.
   *
   * A quiz already running is confirmed rather than replaced: the first phrase
   * says so, the second restarts, which is the same two-step the slash command
   * had. Losing four graded questions to a misread line is worse than one extra
   * message.
   */
  private async quizTarget(target: Target): Promise<void> {
    if (this.session && !this.restartArmed) {
      this.restartArmed = true;
      this.pushSystem("A quiz is running. Say “quiz me” again to restart it.");
      return;
    }
    this.restartArmed = false;
    switch (target.kind) {
      case "active": {
        const active = this.plugin.app.workspace.getActiveFile();
        if (active && active.extension === "md") await this.startQuiz("this", "", active.path);
        else {
          this.pushSystem("No note is open, so this quiz covers every topic note.");
          await this.startQuiz("all", "");
        }
        return;
      }
      case "page":
        await this.startQuiz("this", "", target.path);
        return;
      case "class":
        await this.startQuiz("all", "", null, target.code);
        return;
      case "query":
        await this.startQuiz(target.words ? "query" : "all", target.words);
        return;
      default:
        this.pushSystem("A quiz needs a note, a class, or a subject.");
    }
  }

  /**
   * Digest whatever the phrase named: a PDF or manifest directly, or the PDFs
   * a note cites. A note citing several is asked about rather than guessed.
   */
  private async digestTarget(target: Target): Promise<void> {
    const file = this.fileFor(target);
    if (!file) {
      this.pushSystem("Open a PDF, a manifest, or a note that holds PDF++ links, then say “digest”.");
      return;
    }
    // A plain boolean rather than `isPdfFile`: that is a `file is TFile` guard,
    // and testing an already-`TFile` binding with it narrows everything below
    // to `never`, which is not what "this is not a PDF" should mean here.
    const digestible = file.extension.toLowerCase() === "pdf" || isManifestNote(this.plugin, file);
    if (digestible) {
      await this.narrate(`Digesting ${file.basename}…`, () => digestPdf(this.plugin, file, "model", { gate: (d) => this.gateChips(d) }));
      return;
    }
    const pdfs = pdfsLinkedFrom(this.plugin.app, file);
    if (pdfs.length === 0) {
      this.pushSystem(`${file.basename} holds no PDF++ links that resolve to a PDF in this vault.`);
      return;
    }
    if (pdfs.length === 1) {
      await this.narrate(`Digesting ${pdfs[0].basename}…`, () => digestPdf(this.plugin, pdfs[0], "model", { gate: (d) => this.gateChips(d) }));
      return;
    }
    this.pushChips(
      `${file.basename} cites ${pdfs.length} PDFs. Which one?`,
      pdfs.slice(0, 4).map((p) => ({ label: p.basename, run: () => void this.digestTarget({ kind: "pdf", path: p.path, basename: p.basename }) })),
    );
  }

  /** The file a target names, or null when it names none. */
  private fileFor(target: Target): TFile | null {
    if (target.kind === "active") return this.plugin.app.workspace.getActiveFile();
    if (target.kind === "pdf" || target.kind === "manifest" || target.kind === "page") {
      const f = this.plugin.app.vault.getAbstractFileByPath(target.path);
      return f instanceof TFile ? f : null;
    }
    return null;
  }

  /** Run a studio action with a system line that says what happened. */
  private async narrate(text: string, run: () => Promise<void>): Promise<void> {
    const turn: ChatTurn = { role: "system", text };
    this.turns.push(turn);
    this.trim();
    this.rerender();
    try {
      await run();
      turn.text = text.replace(/…$/, ": done.");
    } catch (e) {
      turn.text = `${text.replace(/…$/, "")} failed: ${describeError(e)}`;
    } finally {
      this.rerender();
    }
  }

  /**
   * The digest gate, as chips instead of a Notice: a PDF with no highlights
   * carrying text has nothing to digest, and the way out is to let the model
   * suggest some first (src/digest.ts:184-192).
   */
  private gateChips(decision: GateDecision): Promise<"highlight" | "cancel"> {
    return new Promise((resolve) => {
      this.pushChips(
        `No highlights with text in this PDF (${decision.total} without). Highlight it in PDF++ first, or let the model suggest highlights.`,
        [
          { label: "AI highlight first", run: () => resolve("highlight") },
          { label: "Cancel", run: () => resolve("cancel") },
        ],
      );
    });
  }

  /** Suggest highlights in whatever PDF the phrase named, after offering the transcript gate. */
  private async highlightTarget(target: Target): Promise<void> {
    const file = this.fileFor(target);
    if (!file || !isPdfFile(file)) {
      this.pushSystem("Open a PDF, then say “highlight”.");
      return;
    }
    await this.narrate(`Suggesting highlights in ${file.basename}…`, () =>
      suggestPdfHighlights(this.plugin, file, { transcriptGate: () => this.transcriptChips(file) }),
    );
  }

  /**
   * The context the suggester asks for before it picks anything: a lecture
   * transcript or a study guide is what says which spans the class cared about.
   */
  private transcriptChips(pdf: TFile): Promise<"paste" | "skip" | "cancel"> {
    return new Promise((resolve) => {
      this.pushChips("A lecture transcript or a study guide sharpens the picks. Paste one first?", [
        {
          label: "Paste transcript or study guide",
          run: () => {
            void askTranscript(this.plugin.app, this.plugin.store.getTranscript(pdf.path)).then((choice) => {
              if (choice === null || choice.action === "clear") {
                resolve("skip");
                return;
              }
              const cleaned = normalizeTranscript(choice.text);
              const { text, truncated } = truncateTranscript(cleaned, this.plugin.settings.transcriptMaxChars);
              this.plugin.store.setTranscript(pdf.path, { text, origin: choice.origin, sourceFile: choice.sourceFile, addedAt: new Date().toISOString(), truncated });
              resolve("paste");
            });
          },
        },
        { label: "Highlight without", run: () => resolve("skip") },
        { label: "Cancel", run: () => resolve("cancel") },
      ]);
    });
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
      this.pushSystem(`No command matches “${id}”. Say help.`);
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
  private async startQuiz(
    scope: "all" | "this" | "query",
    query: string,
    notePath: string | null = null,
    classCode: string | null = null,
  ): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.status = "gathering evidence…";
    this.draft = "";
    this.rerender();

    let pool: EvidenceUnit[] = [];
    let label = "";
    try {
      const all = await this.buildIndex();
      // A phrase can name the note to quiz ("quiz me on Receptors"), so the
      // pool is not always the file in front of the reader. obsidian.d.ts:1954
      // (getActiveFile): null when nothing is open, which `resolvePool` reads
      // as "this note has no evidence".
      const activePath = notePath ?? this.plugin.app.workspace.getActiveFile()?.path ?? null;
      // A class scope is the whole vault narrowed to one code, which is what
      // makes "quiz me on HBIO250" different from "quiz me on everything".
      const units = classCode ? all.filter((u) => u.classCodes.includes(classCode)) : all;
      const resolved = resolvePool(
        scope,
        query,
        units,
        activePath,
        questionScorer(query || "", units),
        this.plugin.settings.quizPoolSize,
      );
      pool = resolved.pool;
      label = classCode || resolved.label;
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
      this.pushSystem(this.noEvidenceLine(scope, query, classCode));
      return;
    }

    // Kept so "Quiz again" repeats the same scope rather than falling back to
    // whatever file happens to be open when the button is pressed.
    this.lastQuizNotePath = notePath;
    this.lastQuizClassCode = classCode;
    const kind: QuizScope["kind"] = scope === "all" ? "all" : scope === "this" ? "note" : "query";
    this.session = startSession({ kind, label }, query, pool, Math.max(1, this.plugin.settings.quizCap));
    this.pushSystem(
      `Quiz on ${label}: questions keep coming until the edge of what you know is found, then the misses go to your inbox as cards. Say hint, skip or stop.`,
    );
    await this.nextQuestion();
  }

  /** Why a scope has nothing to quiz on, in the scope's own words. */
  private noEvidenceLine(scope: "all" | "this" | "query", query: string, classCode: string | null = null): string {
    if (scope === "query") return `No highlights or claims match “${query.trim()}”.`;
    if (scope === "this") return "The active note has no highlights or claims.";
    if (classCode) return `No topic notes carry class ${classCode} yet.`;
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
      if (session.attempt === 1 && (grade.verdict === "incorrect" || grade.verdict === "partial")) {
        this.session = armRetry(session);
        this.turns.push({ role: "assistant", text: retryLine(current), quiz: { kind: "retry", verdict: grade.verdict } });
        this.busy = false;
        this.status = "";
        this.trim();
        this.rerender();
        return;
      }
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

    this.lastQuiz = { scope: session.scope, query: session.query, misses, notePath: this.lastQuizNotePath, classCode: this.lastQuizClassCode };
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
      this.pushSystem("No quiz to repeat. Say “quiz me”.");
      return;
    }
    const scope = last.scope.kind === "all" ? "all" : last.scope.kind === "note" ? "this" : "query";
    await this.startQuiz(scope, last.query, last.notePath, last.classCode);
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
          ? "Ask a question about your topic notes, or say “quiz me”, “digest”, “highlight”. Answers cite the highlights they came from. Say “help” for the rest."
          : `No topic notes under ${prefix} yet. Open a PDF and say “digest”, or say “help”.`,
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
            : turn.quiz.kind === "retry"
              ? ` wikilm-quiz-grade is-${turn.quiz.verdict ?? "skipped"}`
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

    if (turn.chips) {
      this.renderChips(el, turn);
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
    // The best-ranked passage stands in when the model named nothing. It must
    // not stand in when the model named sources that all failed verification:
    // there is no honest source to show, and showing one would dress an
    // unsupported answer in a citation the model never made.
    const allCitationsDropped = report.dropped > 0 && report.sources.length === 0;
    if (picked.length === 0 && report.coverage !== "none" && !allCitationsDropped) {
      picked.push({ unit: evidence[0], why: "" });
    }
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
   * The panel's own question, with a button per answer.
   *
   * This is where "never guess" is kept: a name that fits two PDFs, a PDF with
   * no highlights to digest, a suggester that would work better with a
   * transcript. The turn goes when a button is pressed, so the log does not
   * keep a question whose answer was already given.
   */
  private renderChips(el: HTMLElement, turn: ChatTurn): void {
    const chips = turn.chips;
    if (!chips) return;
    const row = el.createDiv({ cls: "wikilm-chat-offer" });
    row.createSpan({ cls: "wikilm-muted", text: chips.prompt });
    chips.options.forEach((o, i) => {
      const b = row.createEl("button", { cls: i === 0 ? "mod-cta" : "", text: o.label });
      b.disabled = this.busy;
      b.addEventListener("click", () => {
        this.dropTurn(turn);
        this.rerender();
        o.run();
      });
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

  /** Remove one turn by identity; the user turn that preceded a chip stays, because it was typed. */
  private dropTurn(turn: ChatTurn): void {
    const i = this.turns.indexOf(turn);
    if (i >= 0) this.turns.splice(i, 1);
  }

  private renderInput(wrap: HTMLElement): void {
    const box = wrap.createDiv({ cls: "wikilm-chat-input" });
    const studio = box.createDiv({ cls: "wikilm-chat-studio" });
    const active = this.plugin.app.workspace.getActiveFile();
    const isNote = !!active && active.extension === "md";
    const isPdf = isPdfFile(active);
    const canDigest =
      isPdf ||
      (!!active && (isManifestNote(this.plugin, active) || (isNote && pdfsLinkedFrom(this.plugin.app, active).length > 0)));
    const studioButton = (label: string, enabled: boolean, why: string, run: () => void) => {
      const b = studio.createEl("button", { text: label });
      b.disabled = this.busy || !enabled;
      b.title = enabled ? label : why;
      b.addEventListener("click", run);
    };
    studioButton("Quiz me", true, "", () => void this.runIntent({ kind: "quiz", target: { kind: "active" } }));
    studioButton("AI digest", canDigest, "Open a PDF, a manifest, or a note with PDF++ links", () =>
      void this.runIntent({ kind: "digest", target: { kind: "active" } }),
    );
    studioButton("AI highlight", isPdf, "Open a PDF", () =>
      void this.runIntent({ kind: "highlight", target: { kind: "active" } }),
    );
    const ta = box.createEl("textarea", { cls: "wikilm-chat-textarea" });
    ta.rows = 3;
    ta.placeholder = "Ask your notes, or say: quiz me · digest · highlight · help";
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
