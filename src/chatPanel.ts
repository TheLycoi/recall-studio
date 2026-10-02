import { ItemView, MarkdownRenderer, Notice, TAbstractFile, TFile } from "obsidian";
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
  lexicalIsStrong,
  pageContextFor,
  scopeFor,
} from "./retrieval";
import type { Graph } from "./graph";
import { lintVault, renderVaultLint, WIKI_SCHEMA, type LintPage, type VaultLintReport } from "./vaultLint";
import { renderReviewLine, renderReviewTurn } from "./lintReview";
import { planLinkFixes, applyFixesToNote, type LinkFix } from "./vaultFix";
import { FixPlanModal, LintReportModal, pickNote } from "./modals";
import { mergeReview, repointFix, type Fix, type FixPageInfo } from "./fixPlan";
import type { CancelToken } from "./cancel";
import { applyPlan, buildPlan, fixPagesFor, pageInfos, proposeAliases, providerReady, runModelReview, verifyDuplicates, type FixContext } from "./fixer";
import {
  canSendAnswer,
  checkAnswer,
  emptyIndexAnswer,
  filteredOutAnswer,
  MAX_SOURCES,
  noEvidenceAnswer,
  renderGroundingLine,
  renderUnmatchedClaims,
  routeForReport,
  VERIFY_BANNER,
  type GroundingReport,
  pickSources,
  type PickedSource as PickedSourceOf,
} from "./askCheck";
import { describeNarrowing, narrowEvidence, RELEVANCE_MIN_CANDIDATES } from "./relevance";
import { historyFor } from "./askHistory";
import { checkClaims } from "./answerClaims";
import { matchIntent, renderHelp, type Intent, type IntentContext, type IntentPage, type Target } from "./chatCommands";
import { WIKILM_COMMANDS, type WikiLmCommand } from "./commands";
import { captureAskAnswer, captureQuizMisses } from "./capture";
import { isDontKnow, parseQuizCommand, type QuizMiss, type QuizScope, type Verdict } from "./quiz";
import {
  acceptCue,
  afterCuedAttempt,
  afterFirstAttempt,
  checkCue,
  checkRecallGrade,
  fallbackCue,
  itemById,
  nextItem,
  openPoints,
  recallMisses,
  renderCueMarkdown,
  renderCuedMarkdown,
  renderRecallSummaryMarkdown,
  renderRevealMarkdown,
  resolveRecallPool,
  resultVerdict,
  sectionIn,
  skipRecall,
  startRecall,
  type RecallItem,
  type RecallSession,
} from "./recall";
import type { CueShape } from "./schemas";
import type { AskHistoryTurn } from "./prompt";
import { pdfFileName, renderPdfSubpath, findAllPdfReferences } from "./pdflink";
import { parseTopicNote, noteAliases } from "./topicNote";
import { isPdfFile, pdfsLinkedFrom } from "./pdf";
import { frontmatterClasses } from "./pdfHighlights";
import { digestPdf } from "./digest";
import type { GateDecision } from "./digestGate";
import { suggestPdfHighlights } from "./suggest";
import { askTranscript } from "./modals";
import { isUnderFolder, normalizeTranscript, truncateTranscript } from "./util";

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

/** A source under an answer, bound to the panel's evidence type. */
type PickedSource = PickedSourceOf<EvidenceUnit>;

/**
 * One turn in the chat log.
 *
 * An assistant turn carries the evidence it was answered from, error or not,
 * and the `report` of what the grounding checks did to the draft
 * (`GroundingReport`, src/askCheck.ts). A system turn is the panel talking about itself —
 * a command running, a command that cannot run, `/help` — and never reaches
 * the model. A `chips` turn is the panel's own follow-up question with buttons
 * — which of two files was meant, whether to highlight before digesting,
 * whether to paste a transcript first. It is the shape of "never guess": a
 * target that fits two files is asked about rather than picked.
 *
 * A `quiz` turn is one of the three shapes a quiz puts in the log — the
 * question, the grade, the closing summary. The marker is what `historyFor`
 * (src/askHistory.ts) filters on (a quiz is not a conversation the model
 * should see on the next Ask) and what `renderTurn` styles on, and it carries
 * only what the DOM needs that the markdown does not already say: the index
 * for the badge, the verdict for the border colour, the missed units for the
 * summary's chip.
 */
interface ChatTurn {
  role: "user" | "assistant" | "system";
  text: string;
  evidence?: EvidenceUnit[];
  error?: string;
  report?: GroundingReport;
  /**
   * Which retrieval route found the evidence — "notes", "notes + graph",
   * "notes + keywords", "keywords" — and what the relevance judge did to it
   * ("notes · 18 → 6 kept"). Printed on the grounding line unless the report
   * is general knowledge or canned (`routeForReport`, src/askCheck.ts).
   */
  route?: string;
  /** The class scope: "in CODE", "the whole vault (CODE has N notes)" when a class fell back, or "" when none applied. */
  scope?: string;
  /** The question this answer replied to, kept on the answer so a trimmed log cannot take the card's title with it. */
  question?: string;
  /** Copied from `report.canned`: the plugin wrote this text, not the model, so it is never replayed to the model as its own words. */
  canned?: boolean;
  /** A typed line that ran a studio action ("send to inbox", "quiz me") rather than asking anything; kept out of the model's history. */
  command?: boolean;
  /** Set once this answer, or this quiz summary's misses, is in the inbox (added now or already there), so it is not sent twice. */
  sentToInbox?: boolean;
  /** `cancel`, when set, is what `clear()` runs so a command awaiting the chips is answered rather than left hanging. */
  chips?: { prompt: string; options: Array<{ label: string; run: () => void }>; cancel?: () => void };
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
  /** Each indexed note's text, for the page context an answer is given (src/retrieval.ts pageContextFor). Filled with the index, cleared with it. */
  private mdByPath = new Map<string, string>();
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
  session: RecallSession | null = null;
  /** What the last finished quiz was, kept so “Quiz again” repeats it; each summary turn carries its own misses for its send button. */
  private lastQuiz: { scope: QuizScope; query: string; notePath: string | null; classCode: string | null } | null = null;
  /** Set by the first quiz phrase typed during a quiz; the next one restarts, any other message clears it. */
  private restartArmed = false;
  /** The note and class the running quiz was scoped to, so "Quiz again" can repeat it. */
  private lastQuizNotePath: string | null = null;
  private lastQuizClassCode: string | null = null;
  /**
   * The log's scroll position and whether the reader is at its foot, kept
   * across rebuilds: the view redraws on every store change, and only a turn
   * the panel pushes may move the reader (`render`).
   */
  private logScroll = 0;
  private atBottom = true;
  private lastRenderedTurn: ChatTurn | null = null;
  /** Set by the reader's own submit or Clear; the next idle render focuses the input and clears it. A background redraw never does. */
  private wantFocus = true;

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
   * Is this note one of the wiki's pages? Under the topic folder, and neither
   * a schema note nor a transcript. Both live inside the wiki by default
   * (`wiki/sources/schema`, `wiki/sources/wispr`) but are not knowledge: the
   * schema is house rules and a transcript is a lens on a PDF, never a
   * source. Neither is evidence for Ask or a node of the graph, and lint
   * would only ever call them orphans and off-schema.
   */
  private isWikiPage(path: string): boolean {
    const s = this.plugin.settings;
    return path.startsWith(this.folderPrefix()) && !isUnderFolder(path, s.schemaFolder) && !isUnderFolder(path, s.transcriptFolder);
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
    const touched = (path: string) => this.isWikiPage(path);
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
    const units: EvidenceUnit[] = [];
    // obsidian.d.ts:7543 (getMarkdownFiles), :7420 (cachedRead).
    const files = this.plugin.app.vault.getMarkdownFiles().filter((f: TFile) => this.isWikiPage(f.path));
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const meta: IntentPage[] = [];
    this.mdByPath = new Map();
    for (const file of files) {
      const md = await this.plugin.app.vault.cachedRead(file);
      this.mdByPath.set(file.path, md);
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
    const manifests: string[] = [];
    return { pages: this.pageMeta, pdfs, manifests, commands: WIKILM_COMMANDS };
  }

  /** The panel's own follow-up with buttons: which file, whether to highlight first, whether to paste a transcript. */
  private pushChips(prompt: string, options: Array<{ label: string; run: () => void }>, cancel?: () => void): void {
    this.turns.push({ role: "assistant", text: "", chips: { prompt, options, cancel } });
    this.trim();
    this.rerender();
  }

  /**
   * `/wiki`: what is wrong with the notes, as structure rather than content.
   *
   * The scan makes no model call — every check is counting links and indexed
   * passages — so its report is instant and is shown before anything else
   * runs. It is the answer to "the chatbot can't find anything": a note with
   * nothing quotable in it, or one the graph cannot reach, is invisible to Ask
   * no matter how good it looks in the editor, and this says which notes
   * those are. Then, when the lint role has a provider and the setting is on,
   * the model review (`runModelReview`) reads the pages with findings and adds
   * a second turn; its rows join the plan before the modal opens.
   *
   * `review: false` skips the model review for this run. The re-check after
   * Apply passes it: the reader has just acted on a review, and running a
   * second one to see the writes land would pay for every call again.
   */
  async runVaultLint(opts: { review?: boolean } = {}): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.status = "checking the wiki…";
    this.rerender();
    try {
      const prefix = this.folderPrefix();
      const files = this.plugin.app.vault.getMarkdownFiles().filter((f: TFile) => this.isWikiPage(f.path));
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
        if (isUnderFolder(file.path, this.plugin.settings.schemaFolder)) continue;
        sources.set(file.path, await this.plugin.app.vault.cachedRead(file));
      }

      const report = lintVault(pages, { schema: WIKI_SCHEMA, sources });
      const settings = this.plugin.settings;
      const ready = providerReady(settings, "lint");
      const asked = opts.review !== false;
      const reviewing = ready && settings.lintModelReview && asked;
      // A review that does not run says why, so its absence is not a silence.
      const off = !asked ? "not repeated after Apply" : settings.lintModelReview ? "no provider configured" : "off in settings";
      const rendered = reviewing
        ? renderVaultLint(report)
        : `${renderVaultLint(report)}\n\n${renderReviewLine({ read: 0, withFindings: 0, skipped: 0, findings: 0, dropped: {}, failed: [], cleared: 0, off })}`;
      this.turns.push({ role: "assistant", text: rendered });
      this.trim();
      this.rerender();

      // The report is a turn in the log either way; the modal is what makes it
      // actionable. Planning the fixes here rather than inside the modal keeps
      // the button's count honest — it says what will actually change, not how
      // many dead links were found.
      const links = planLinkFixes(report.issues, fixPagesFor(this.plugin, pages), new Map(pages.map((p) => [p.path, p.content])), prefix);
      const schemaViolations = report.issues.filter((i) => i.id === "schema-violation").length;

      const ctx: FixContext = { report, pages, sources, prefix };
      const infos = pageInfos(this.plugin, pages);
      let plan = await buildPlan(this.plugin, ctx);

      // The model review, after the scan's turn is on screen. Its findings are
      // a turn of their own; the modal gets both turns and one plan: the
      // mechanical rows less the pairs the duplicate check cleared, plus the
      // review's rows.
      let shown = rendered;
      let planReport: VaultLintReport = report;
      if (reviewing) {
        // The plugin's one cancel token, which the status bar and the stop
        // command already reach; taken only when no other run holds it.
        const cancel = this.plugin.cancel;
        const owner = cancel.active ? undefined : cancel.begin("model review of the wiki");
        try {
          const review = await runModelReview(
            this.plugin,
            ctx,
            infos,
            (s) => {
              this.status = s;
              cancel.progress(s, owner);
              this.rerender();
            },
            owner !== undefined ? cancel : undefined,
            plan,
          );
          const turn = renderReviewTurn(report, review.issues, review.line);
          this.turns.push({ role: "assistant", text: turn });
          this.trim();
          shown = `${rendered}\n\n${turn}`;
          ({ plan, report: planReport } = mergeReview(plan, report, review));
        } catch (e) {
          this.pushSystem(`Model review failed: ${describeError(e)}`);
        } finally {
          cancel.end(owner);
          this.status = "checking the wiki…";
        }
      }
      const planCtx: FixContext = { ...ctx, report: planReport };

      // The aliases-and-tags rows are not in `plan` — they cost a request and
      // are only asked for from inside the modal — so a vault whose only
      // findings are missing aliases would otherwise have no way to reach the
      // button that proposes them. That is what `aliasWork` keeps open.
      const aliasWork = report.issues.some(
        (i) => i.id === "no-aliases" || (i.id === "schema-violation" && i.detail?.startsWith("tag “")),
      );
      // Look-alike pairs are not rows yet; the plan is still worth opening
      // for the button that lets the model decide them.
      const candidateWork = ready && (planReport.candidates?.length ?? 0) > 0;
      const canSuggest = plan.length > 0 || aliasWork || candidateWork;

      new LintReportModal(
        this.plugin.app,
        shown,
        { deadLinksFixable: links.fixable.length, deadLinksUnresolved: links.unresolved.length, schemaViolations, schemaSuggestions: 0 },
        { onFixDeadLinks: () => void this.applyLinkFixes(links.fixable) },
        links.fixable,
        canSuggest ? () => this.openFixPlan(plan, infos, planCtx) : undefined,
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
   *
   * The two model buttons take the plugin's cancel token the way the lint's
   * review does, only when nothing else holds it, so the status bar's stop
   * reaches them between batches.
   */
  private openFixPlan(plan: Fix[], infos: Map<string, FixPageInfo>, ctx: FixContext): void {
    const pages = fixPagesFor(this.plugin, ctx.pages);
    const withToken = async <T>(label: string, run: (cancel: CancelToken | undefined) => Promise<T>): Promise<T> => {
      const cancel = this.plugin.cancel;
      const owner = cancel.active ? undefined : cancel.begin(label);
      try {
        return await run(owner !== undefined ? cancel : undefined);
      } finally {
        cancel.end(owner);
      }
    };
    new FixPlanModal(this.plugin.app, plan, {
      pickTarget: (row) => pickNote(this.plugin.app, pages).then((p) => (p ? repointFix(row, p, ctx.prefix) : null)),
      proposeAliases: providerReady(this.plugin.settings, "lint")
        ? () => withToken("proposing aliases and tags", (c) => proposeAliases(this.plugin, infos, ctx.report, c))
        : null,
      verifyDuplicates:
        providerReady(this.plugin.settings, "lint") &&
        (ctx.report.issues.some((i) => i.id === "duplicate-pages") || (ctx.report.candidates?.length ?? 0) > 0)
          ? () => withToken("checking duplicates", (c) => verifyDuplicates(this.plugin, infos, ctx.report, ctx.prefix, c))
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
        // The scan only: the review has just been acted on.
        void this.runVaultLint({ review: false });
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
   *      last and is skipped when the words matched strongly or already found
   *      `keywordGate` passages.
   *
   * Every stage appends; none reorders or drops what lexical search found, so
   * widening can only ever add evidence to an answer.
   *
   * `fill` is how many passages to widen to (the judge's pool when the
   * relevance filter is on); `keywordGate` is the evidence count the drafter
   * reads. They differ on purpose: gating the call on the pool would make a
   * question with 6-17 lexical hits at k=6 pay for a keyword call it never
   * needed, a third round trip before the answer.
   */
  private async widenEvidence(
    q: string,
    units: EvidenceUnit[],
    lexical: EvidenceUnit[],
    fill: number,
    keywordGate: number,
  ): Promise<{ evidence: EvidenceUnit[]; route: string }> {
    let route = lexical.length > 0 ? "notes" : "none";
    if (lexical.length >= fill) return { evidence: lexical, route };

    let out = expandWithGraph(lexical, units, this.buildGraphIndex(), fill);
    if (out.length > lexical.length) route = "notes + graph";

    // The model call is paid for only when the words themselves failed —
    // upstream's gate (gd4ai/obsidian-llm-wiki, select-seeds.ts): a match is
    // weak by what the best hit covers — and when they found fewer passages
    // than the drafter reads. A question the notes plainly answer used to
    // cost a second round trip whenever the vault set the evidence count high.
    if (lexicalIsStrong(q, lexical) || lexical.length >= keywordGate || !this.plugin.settings.askKeywordExpansion) {
      return { evidence: out, route };
    }

    // The terms are worth asking for even when nothing matched at all: that
    // is the case they exist for, a question phrased in words the notes never
    // use. A failure here is not an error the reader needs to see — the
    // answer simply stays as wide as the local stages made it.
    try {
      this.status = "looking for other wording…";
      this.rerender();
      const titles = [...new Set(units.map((u) => u.noteTitle))];
      const { keywords } = await this.plugin.llm.keywords({ question: q, noteTitles: titles });
      const byKeyword = rankByKeywords(units, keywords, fill);
      const merged = mergeEvidence(out, byKeyword, fill);
      if (merged.length > out.length || (out.length === 0 && merged.length > 0)) route = lexical.length > 0 ? "notes + keywords" : "keywords";
      // Neighbours of anything the new terms turned up.
      out = expandWithGraph(merged, units, this.buildGraphIndex(), fill);
    } catch (e) {
      console.debug("[wikilm] keyword expansion failed:", e);
    }
    return { evidence: out, route: out.length > 0 ? route : "none" };
  }

  /** The smallest class worth answering from alone; below it the whole vault is searched. */
  private static readonly MIN_SCOPE_NOTES = 5;

  /** The first class code of the note the reader is looking at, or null. */
  private activeClass(): string | null {
    const file = this.plugin.app.workspace.getActiveFile();
    if (!file || file.extension.toLowerCase() !== "md") return null;
    return frontmatterClasses(this.plugin, file.path)[0] ?? null;
  }

  /**
   * The question an answer replied to. Answers carry their own (`question`);
   * the walk up the log is only for a turn written before they did.
   */
  private questionBefore(turn: ChatTurn): string {
    if (turn.question) return turn.question;
    const at = this.turns.indexOf(turn);
    for (let i = at - 1; i >= 0; i--) if (this.turns[i].role === "user") return this.turns[i].text;
    return "Question";
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
    const resolved = this.plugin.app.metadataCache.resolvedLinks;
    const nodes = this.plugin.app.vault
      .getMarkdownFiles()
      .filter((f: TFile) => this.isWikiPage(f.path))
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
   * The conversation sent with the question now being asked, at most
   * `maxEntries` entries (a question and its answer are two).
   *
   * `historyFor` (src/askHistory.ts) decides what counts as conversation,
   * takes out typed studio commands ("send to inbox" is the reader's line but
   * not something to answer on the next Ask), and drops the pending question,
   * which the prompt carries on its own.
   */
  private history(maxEntries: number): AskHistoryTurn[] {
    return historyFor(
      this.turns,
      { maxEntries, excludeLast: true },
    );
  }

  /**
   * Keep the log bounded: twice `askMaxTurns` entries, so the log always
   * holds at least the history the model is sent.
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
    // The reader submitted: once the panel is idle again, the cursor goes back
    // in the box. Not for an empty Enter outside a quiz, which returns below
    // without drawing, so the flag would fire on some later, unrelated redraw.
    if (q || this.session) this.wantFocus = true;

    // The quiz controls are chat-local and not in the registry
    // (`parseQuizCommand`, src/quiz.ts), and while a session runs they
    // outrank everything else: "skip" during a quiz is a skipped question, not
    // a search. A quiz phrase that starts one flows through `matchIntent` like
    // every other verb, so "quiz me on receptors" and "digest" are read the
    // same way.
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
          await this.skipQuiz(q);
          return;
      }
    }

    // Anything that is not a quiz control, while a quiz is running, is an
    // answer — including an empty one, which `isDontKnow` (src/quiz.ts)
    // reads as "I don't know" so the grader's promise that a blank never
    // reaches it is kept here rather than in the prompt. A quiz phrase is the
    // exception: it means restart, and `quizTarget` handles the confirmation.
    if (this.session && !(quizCommand && quizCommand.kind === "start")) {
      this.draft = "";
      this.restartArmed = false;
      if (isDontKnow(q)) {
        await this.skipQuiz(q);
        return;
      }
      await this.answerQuiz(q);
      return;
    }

    if (!q) return;

    // A cold index is a read of every topic note, the longest silent wait in
    // the panel: say so and hold the input before it starts, or a second
    // Enter starts a second rebuild.
    if (!this.index) {
      this.busy = true;
      this.status = "reading your notes…";
      this.rerender();
      let failed: unknown = null;
      try {
        await this.buildIndex();
      } catch (e) {
        failed = e;
      } finally {
        this.busy = false;
        this.status = "";
      }
      if (failed) {
        this.turns.push({ role: "assistant", text: "", error: describeError(failed) });
        this.trim();
        this.rerender();
        return;
      }
    }
    const intent = matchIntent(q, this.intentContext());
    this.draft = "";
    if (intent.kind === "question") {
      this.restartArmed = false;
      await this.askQuestion(intent.text ?? q, intent.classCode);
      return;
    }
    // What the reader typed goes in the log like any other line of theirs: a
    // studio action that came back on the wrong subject should look like a
    // phrase read differently than intended, not like the panel ignoring them.
    // Marked as a command so it is never replayed to the model as conversation.
    this.turns.push({ role: "user", text: q, command: true });
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
      case "send-answer":
        await this.sendLastAnswerToInbox();
        return;
    }
  }

  /**
   * The typed form of the button under an answer: card the newest reply.
   *
   * Only the newest one. Walking back past a reply that cannot be sent meant a
   * phrase typed twice carded the answer before last, and one typed after a
   * quiz carded something from before it; a reader who types "card it" means
   * the thing just above. A quiz summary there means its misses.
   */
  private async sendLastAnswerToInbox(): Promise<void> {
    const turn = this.newestReply();
    if (!turn) {
      this.pushSystem("Ask something first: there is no answer to card yet.");
      return;
    }
    if (turn.quiz?.kind === "summary") {
      await this.sendMissesToInbox(turn);
      return;
    }
    if (turn.sentToInbox) {
      this.pushSystem("The last answer is already in the inbox.");
      return;
    }
    if (turn.quiz || turn.error || !turn.report || !canSendAnswer(turn.report, turn.text)) {
      this.pushSystem("Nothing to card: the last reply is not an answer from your notes or from general knowledge.");
      return;
    }
    await this.sendAnswerToInbox(turn);
  }

  /** The newest assistant turn that is a reply rather than the panel's own chips, or null. */
  private newestReply(): ChatTurn | null {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const t = this.turns[i];
      if (t.role === "assistant" && !t.chips) return t;
    }
    return null;
  }

  /**
   * Card the answer: one inbox item holding the answer and the passages it
   * rested on, or, for a general-knowledge answer, the answer alone marked
   * unverified and linked to the open note or the class's hub.
   *
   * Reads the turn it was rendered on rather than the panel's last answer —
   * the log holds every answer of the session, and the button under a question
   * asked four turns ago has to send that one. Speaks once: a Notice when a
   * row was added, one line in the log when it was not, with the reason.
   */
  async sendAnswerToInbox(turn: ChatTurn): Promise<void> {
    const report = turn.report;
    if (turn.sentToInbox || turn.error || !report || !canSendAnswer(report, turn.text)) return;
    const result = captureAskAnswer(this.plugin, {
      question: this.questionBefore(turn),
      answer: turn.text,
      cited: pickSources(turn.evidence ?? [], report),
      generalKnowledge: report.fromGeneralKnowledge,
      fallbackSourcePath: this.fallbackSourcePath(turn),
    });
    // "Sent" means a row for this answer is in the inbox, new or old; a
    // skipped send leaves the button live so it can be tried again.
    if (result.status === "added" || result.status === "duplicate") turn.sentToInbox = true;
    if (result.status === "added") {
      new Notice("Sent to the inbox; cards are being written.");
      if (this.plugin.settings.openInboxOnCapture) void this.plugin.openInbox();
      this.rerender();
      return;
    }
    this.pushSystem(`Not sent: ${result.reason ?? "nothing to card."}`);
  }

  /**
   * The note a general-knowledge answer is carded against, since it cites
   * none: the hub of the class the question was scoped to (the page named
   * after its own folder, classes/HBIO250/HBIO250.md, the same test the
   * digest uses to find hubs), since "in HBIO250" says where it belongs; else
   * the markdown note the reader has open.
   */
  private fallbackSourcePath(turn: ChatTurn): string | undefined {
    const code = /^in (.+)$/.exec(turn.scope ?? "")?.[1];
    const hub = code
      ? this.pageMeta.find((p) => {
          const parts = p.path.split("/");
          return parts[parts.length - 1] === `${code}.md` && parts[parts.length - 2] === code;
        })?.path
      : undefined;
    if (hub) return hub;
    const active = this.plugin.app.workspace.getActiveFile();
    return active && active.extension.toLowerCase() === "md" ? active.path : undefined;
  }

  /**
   * Start a quiz on whatever the phrase named.
   *
   * A quiz already running is confirmed rather than replaced: the first phrase
   * says so, the second restarts. Losing four graded questions to a misread
   * line is worse than one extra message.
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
    const digestible = file.extension.toLowerCase() === "pdf";
    if (digestible) {
      await this.narrate(`Digesting ${file.basename}…`, () => digestPdf(this.plugin, file, { gate: (d) => this.gateChips(d) }));
      return;
    }
    const pdfs = pdfsLinkedFrom(this.plugin.app, file);
    if (pdfs.length === 0) {
      this.pushSystem(`${file.basename} holds no PDF++ links that resolve to a PDF in this vault.`);
      return;
    }
    if (pdfs.length === 1) {
      await this.narrate(`Digesting ${pdfs[0].basename}…`, () => digestPdf(this.plugin, pdfs[0], { gate: (d) => this.gateChips(d) }));
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
  private async narrate(text: string, run: () => Promise<unknown>): Promise<void> {
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
   * suggest some first (`digestPdf`'s `gate` option, src/digest.ts).
   */
  private gateChips(decision: GateDecision): Promise<"highlight" | "cancel"> {
    return new Promise((resolve) => {
      this.pushChips(
        `No highlights with text in this PDF (${decision.total} without). Highlight it in PDF++ first, or let the model suggest highlights.`,
        [
          { label: "AI highlight first", run: () => resolve("highlight") },
          { label: "Cancel", run: () => resolve("cancel") },
        ],
        () => resolve("cancel"),
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
            void askTranscript(this.plugin.app, this.plugin.store.getTranscript(pdf.path), this.plugin.settings.transcriptFolder).then((choice) => {
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
      ], () => resolve("cancel"));
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
   * (src/askCheck.ts) says so and the provider is never called — which is
   * also why a vault with no matching notes answers instantly and without a
   * provider error.
   *
   * Two optional stages sit either side of the drafter. Before it, behind
   * `askRelevanceFilter`: retrieval runs three times as wide and one model
   * call names the passages that bear on the question, so the drafter reads a
   * narrowed list rather than everything the words happened to hit;
   * `narrowEvidence` (src/relevance.ts) decides what the verdict, or the
   * judge's failure, leaves, and a judge that kept nothing is answered with
   * `filteredOutAnswer` rather than a drafter reading an empty list. After it,
   * behind `askClaimCheck`: each sentence of the answer is matched locally
   * against the passages it cited, and the ones no passage states are listed
   * under the answer — marked, never deleted, because a bar made of token
   * overlap fails faithful sentences too and deleting them was this file's
   * old failure mode (the header of src/askCheck.ts).
   *
   * The evidence is pushed with the assistant turn whether the model answered
   * or failed, and an error turn shows the top passages (`renderTurn`), because
   * the sources are the part the reader can still use when there is no
   * provider configured.
   */
  private async askQuestion(question: string, classCode?: string): Promise<void> {
    const q = question.trim();
    if (!q || this.busy) return;

    this.busy = true;
    this.status = "searching…";
    this.draft = "";
    this.turns.push({ role: "user", text: q });
    this.trim();
    this.rerender();

    let evidence: EvidenceUnit[] = [];
    let route = "";
    let scope = "";
    // Every reply to this question is pushed through here, so each carries
    // its question (the card's title), its route and scope as they stand, and
    // the canned flag that keeps a refusal out of the model's history.
    const reply = (turn: Pick<ChatTurn, "text" | "evidence" | "report" | "error">): void => {
      this.turns.push({ role: "assistant", question: q, route, scope, canned: turn.report?.canned, ...turn });
    };
    try {
      const all = await this.buildIndex();

      // An empty index is a misconfigured folder, not an unanswerable
      // question: "your notes don't cover this" would blame the notes for a
      // setting. Name the folder that was searched so it can be corrected.
      if (all.length === 0) {
        const { answer, report } = emptyIndexAnswer(this.folderPrefix());
        reply({ text: answer, evidence: [], report });
        return;
      }

      // Scope: the class the phrase named, else the class of the note the
      // reader is looking at. A class with too few notes to answer from falls
      // back to the whole vault. Which happened is printed on the grounding
      // line under the reply, where it stays; the status only says where the
      // search is looking.
      const scoped = scopeFor(all, q, { named: classCode ?? null, inferred: this.activeClass() }, { minNotes: ChatPanel.MIN_SCOPE_NOTES });
      const units = scoped.units;
      scope = scoped.scope;
      this.status = scope.startsWith("in ") ? `searching ${scope}…` : "searching…";
      this.rerender();

      // Weighted by how rare each word is in this vault, so the term that
      // names the topic outranks the one every note happens to use.
      const scorer = questionScorer(q, units);
      const k = this.plugin.settings.askEvidenceCount;
      // With the filter on, retrieval runs wide and the model narrows it: the
      // judge earns its call only when it has more candidates than the
      // drafter will read. The ceiling is the reader's wait, not the context
      // — thirty lines is already a long pause for one question.
      const filtering = this.plugin.settings.askRelevanceFilter;
      const kPool = filtering ? Math.min(3 * k, 30) : k;
      const lexical = rankEvidence(units, q, scorer, kPool);

      // Widened to the pool; the keyword call is gated on `k`.
      const widened = await this.widenEvidence(q, units, lexical, kPool, k);
      route = widened.route;

      if (filtering) {
        // Below the gate there is nothing worth a round trip to narrow, and
        // `narrowEvidence` reads the pool as skipped whatever the verdict.
        let verdict: { relevant: number[] } | Error = { relevant: [] };
        if (widened.evidence.length >= RELEVANCE_MIN_CANDIDATES) {
          this.status = "judging the evidence…";
          this.rerender();
          try {
            verdict = await this.plugin.llm.relevance({
              question: q,
              candidates: numberEvidence(widened.evidence),
              // One exchange: the previous question and its answer, enough to
              // resolve "why is that" without paying for the whole log.
              history: this.history(2),
            });
          } catch (e) {
            // Not an error the reader needs in red: the evidence falls back
            // to the retriever's top k, and the route label says the judge failed.
            console.debug("[wikilm] relevance filter failed:", e);
            verdict = e instanceof Error ? e : new Error(String(e));
          }
        }
        const narrowed = narrowEvidence(widened.evidence, verdict, k, (u) => u.notePath);
        evidence = narrowed.evidence;
        // Only onto a route there is one for: "none" is the sentinel that
        // prints nothing, and appending to it would print the word itself.
        const label = describeNarrowing(narrowed);
        if (label && route && route !== "none") route = `${route} · ${label}`;

        // The judge read the passages and kept none. Saying "nothing matches"
        // would be false, and the drafter would be reading an empty list, so
        // no model is called — unless the reader allows general knowledge,
        // which is the path below with no evidence.
        if (narrowed.state === "nothing" && !this.plugin.settings.askGeneralKnowledge) {
          const { answer, report } = filteredOutAnswer(narrowed.before, q);
          reply({ text: answer, evidence: [], report });
          return;
        }
      } else {
        evidence = widened.evidence.slice(0, k);
      }

      // Retrieval found nothing. Either say so and stop, or let the model
      // answer from what it knows behind a warning — upstream's choice
      // (gd4ai/obsidian-llm-wiki), and the reader's to make in settings. The
      // model is still called with an empty evidence list in that case, so the
      // prompt's "two honest options" rule is what decides the reply, not this.
      if (evidence.length === 0 && !this.plugin.settings.askGeneralKnowledge) {
        const { answer, report } = noEvidenceAnswer(q);
        reply({ text: answer, evidence: [], report });
        return;
      }

      this.status = "asking the model…";
      this.rerender();

      const numbered = numberEvidence(evidence);
      const draft = await this.plugin.llm.ask({
        question: q,
        evidence: numbered,
        pages: pageContextFor(evidence, (path) => this.mdByPath.get(path) ?? null),
        history: this.history(this.plugin.settings.askMaxTurns),
        standingInstructions: this.plugin.settings.askInstructions,
      });

      // The setting is enforced on the draft: with general knowledge off, a
      // draft that took that option becomes the refusal, whatever the prompt offered.
      const { answer, report } = checkAnswer(draft, numbered, { allowGeneralKnowledge: this.plugin.settings.askGeneralKnowledge });
      // The sentence check. Local and instant, so there is no status step: a
      // rerender nothing awaits would flicker a line the reader cannot read.
      // Skipped when the answer came from general knowledge (the banner above
      // it already says every sentence is unverified), when the plugin wrote
      // the text, and when the notes covered nothing, where there is no
      // passage to match against anyway.
      if (this.plugin.settings.askClaimCheck && !report.fromGeneralKnowledge && !report.canned && answer.trim() && report.coverage !== "none") {
        // What the drafter read, plus the rest of every note it cited: a
        // sentence may rest on a line next to the one retrieved, and that is
        // still the reader's own note. Not the whole index — a stray match in
        // a note the answer never cited is not support for anything.
        // The check is synchronous on the UI thread, so it gets a ceiling: 200
        // single-line units is more than a cited page holds.
        const CLAIM_CHECK_UNIT_CAP = 200;
        const citedPaths = new Set(report.sources.map((s) => evidence[s.n - 1]?.notePath).filter((p): p is string => !!p));
        const unitsToCheck: EvidenceUnit[] = [];
        const seen = new Set<string>();
        for (const u of evidence) {
          if (unitsToCheck.length >= CLAIM_CHECK_UNIT_CAP) break;
          if (seen.has(u.id)) continue;
          seen.add(u.id);
          unitsToCheck.push(u);
        }
        for (const u of this.index ?? []) {
          if (unitsToCheck.length >= CLAIM_CHECK_UNIT_CAP) break;
          if (!citedPaths.has(u.notePath) || seen.has(u.id)) continue;
          seen.add(u.id);
          unitsToCheck.push(u);
        }
        const verdicts = checkClaims(answer, unitsToCheck);
        report.claims = { total: verdicts.length, unmatched: verdicts.filter((v) => v.status === "unmatched").map((v) => v.text) };
      }
      reply({ text: answer, evidence, report });
    } catch (e) {
      reply({ text: "", evidence, error: describeError(e) });
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

    let items: RecallItem[] = [];
    let label = "";
    try {
      const all = await this.buildIndex();
      // A phrase can name the note to quiz ("quiz me on Receptors"), so the
      // pool is not always the file in front of the reader. obsidian.d.ts
      // (`Workspace.getActiveFile`): null when nothing is open, which `resolveRecallPool` reads
      // as "this note has no evidence".
      const activePath = notePath ?? this.plugin.app.workspace.getActiveFile()?.path ?? null;
      // A class scope is the whole vault narrowed to one code, which is what
      // makes "quiz me on HBIO250" different from "quiz me on everything".
      const units = classCode ? all.filter((u) => u.classCodes.includes(classCode)) : all;
      const resolved = resolveRecallPool(
        scope,
        query,
        units,
        activePath,
        questionScorer(query || "", units),
        this.plugin.settings.quizPoolSize,
      );
      items = resolved.items;
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

    if (items.length === 0) {
      this.session = null;
      this.pushSystem(this.noEvidenceLine(scope, query, classCode));
      return;
    }

    // Kept so "Quiz again" repeats the same scope rather than falling back to
    // whatever file happens to be open when the button is pressed.
    this.lastQuizNotePath = notePath;
    this.lastQuizClassCode = classCode;
    const kind: QuizScope["kind"] = scope === "all" ? "all" : scope === "this" ? "note" : "query";
    this.session = startRecall({ kind, label }, query, items, Math.max(1, this.plugin.settings.quizCap));
    this.pushSystem(
      `Quiz on ${label}: ${items.length} section${items.length === 1 ? "" : "s"}, one at a time. Write everything you remember of each, in any order; you get a cue for what you miss, then the section. Say skip or stop.`,
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
   * Write the cue for the next section, checking it before the reader sees it.
   *
   * The two-strike rule of the passage quiz, with a different last resort: a
   * cue that fails `checkCue` (src/recall.ts) is asked for once more with the
   * failure named, and a second failure falls back to a cue written by code
   * from the heading path. A section is never set aside because the model
   * could not phrase it, so the quiz cannot loop or stall on one.
   */
  private async nextQuestion(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const item = nextItem(session);
    if (!item) {
      await this.finishQuiz();
      return;
    }

    this.busy = true;
    this.status = "writing a question…";
    this.rerender();

    try {
      let failure = "";
      let accepted: { cue: string; shape: CueShape; fallback: boolean } | null = null;
      for (let attempt = 0; attempt < 2 && !accepted; attempt++) {
        const draft = await this.plugin.llm.quizCue({
          ...sectionIn(item),
          standingInstructions: this.plugin.settings.quizInstructions,
          failure,
        });
        const check = checkCue(draft, item);
        if (check.ok) accepted = { cue: check.cue, shape: check.shape, fallback: false };
        else failure = check.reason;
      }
      const live = this.session;
      if (!live) return;
      const q = accepted ?? { cue: fallbackCue(item), shape: "concept" as const, fallback: true };
      const next = acceptCue(live, item, q.cue, q.shape, q.fallback);
      this.session = next;
      if (!next.current) return;
      this.turns.push({ role: "assistant", text: renderCueMarkdown(next.current, item), quiz: { kind: "question", index: next.current.n } });
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
   * One typed answer, marked point by point against the section.
   *
   * On the free attempt, points still open with a cue to give arm the cued
   * attempt, and the reader sees the cues, not the points. On the cued
   * attempt only the open points are sent. A failed model call keeps the
   * session, because the answer is still on the screen and typing it again is
   * the whole recovery.
   */
  private async answerQuiz(text: string): Promise<void> {
    const session = this.session;
    const current = session?.current;
    const item = session && current ? itemById(session, current.itemId) : undefined;
    if (!session || !current || !item || this.busy) return;

    this.busy = true;
    this.status = "marking…";
    this.draft = "";
    this.turns.push({ role: "user", text, quiz: { kind: "grade" } });
    this.trim();
    this.rerender();

    const cued = session.attempt === 2;
    const points = cued ? openPoints(session) : item.points;
    try {
      const draft = await this.plugin.llm.quizRecallGrade({
        ...sectionIn(item),
        points: points.map((p) => p.text),
        cue: current.cue,
        answer: text,
        cued,
      });
      const { marks, feedback, feedbackGrounded } = checkRecallGrade(draft, points, text);
      const next = cued
        ? afterCuedAttempt(session, text, marks, feedback, feedbackGrounded)
        : afterFirstAttempt(session, text, marks, feedback, feedbackGrounded);
      if (next.attempt === 2 && next.current) {
        this.session = next;
        this.turns.push({ role: "assistant", text: renderCuedMarkdown(next), quiz: { kind: "retry", verdict: "partial" } });
        this.busy = false;
        this.status = "";
        this.trim();
        this.rerender();
        return;
      }
      this.pushReveal(next);
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
   * A declined answer: `/skip`, `/idk` or a blank line. No model call; every
   * point still open is missed and the section is shown, because the point
   * of declining is to be told.
   */
  private async skipQuiz(userAnswer: string): Promise<void> {
    const session = this.session;
    if (!session?.current || this.busy) return;
    if (userAnswer.trim()) this.turns.push({ role: "user", text: userAnswer, quiz: { kind: "grade" } });
    this.pushReveal(skipRecall(session, userAnswer));
    await this.afterGrade();
  }

  /** Put the reveal of the section just closed on the log and keep the new session. */
  private pushReveal(next: RecallSession): void {
    this.session = next;
    const result = next.results[next.results.length - 1];
    const item = result ? itemById(next, result.itemId) : undefined;
    if (!result || !item) return;
    this.turns.push({
      role: "assistant",
      text: renderRevealMarkdown(result, item),
      quiz: {
        kind: "grade",
        verdict: resultVerdict(result),
        unverified: !result.feedbackGrounded || result.marks.some((m) => !m.verified),
      },
    });
    this.trim();
    this.rerender();
  }

  /** After a reveal: the summary when the quiz is done, otherwise the next section. */
  private async afterGrade(): Promise<void> {
    const session = this.session;
    if (!session) return;
    if (session.finished) await this.finishQuiz();
    else await this.nextQuestion();
  }

  /**
   * `/hint`. Free recall has no hint before the attempt, because any word
   * about the content would turn it into cued recall; the cues come after the
   * first answer, one per point missed. So the hint says that.
   */
  private showHint(): void {
    const session = this.session;
    if (!session?.current) return;
    this.pushSystem(
      session.attempt === 2
        ? "The cues above are the hints. Write what they bring back, or say skip."
        : "Write whatever you can, in any order. After your answer you get a cue for each point you missed, before anything is shown.",
    );
  }

  /**
   * End the quiz and offer the misses.
   *
   * The session goes to null, but the scope and the missed points stay on the
   * panel: the two chips outlive the session they came from, so "Quiz again"
   * still knows what was being quizzed after the summary has scrolled up.
   */
  private async finishQuiz(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const misses = recallMisses(session);
    this.lastQuiz = { scope: session.scope, query: session.query, notePath: this.lastQuizNotePath, classCode: this.lastQuizClassCode };
    this.turns.push({
      role: "assistant",
      text: renderRecallSummaryMarkdown(session),
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
   *
   * Sends the misses of the summary it is given — the one the button sits
   * under — or, called bare, of the newest summary in the log. Like the
   * answer button it turns to "Sent" once the rows are in the inbox, new or
   * already there, so an old summary cannot send a newer quiz's misses and a
   * second click cannot report "0 sent".
   */
  async sendMissesToInbox(summary?: ChatTurn): Promise<void> {
    const turn = summary ?? [...this.turns].reverse().find((t) => t.quiz?.kind === "summary");
    const misses = turn?.quiz?.misses ?? [];
    if (!turn || misses.length === 0) {
      this.pushSystem("Nothing was missed.");
      return;
    }
    if (turn.sentToInbox) {
      this.pushSystem("Those misses are already in the inbox.");
      return;
    }
    // `duplicates` are the misses whose row was already in the inbox;
    // `skipped` also counts passages too short to card. Only an added or a
    // duplicate row means the misses are in the inbox: a send that skipped
    // them all as too short sent nothing and keeps its button.
    const { added, duplicates, reason } = captureQuizMisses(this.plugin, misses);
    if (added > 0 || duplicates > 0) turn.sentToInbox = true;
    if (added > 0) {
      new Notice(`Sent ${added} passage${added === 1 ? "" : "s"} to the inbox${duplicates ? `, ${duplicates} already there` : ""}.`);
      this.rerender();
      return;
    }
    this.pushSystem(`Not sent: ${reason ?? "nothing to card."}`);
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

  /**
   * Empty the log. The index survives: nothing about the vault changed.
   *
   * Not while busy: an answer in flight would land under no question, and a
   * quiz question being written would bring the cleared quiz back. The button
   * is disabled too; this covers any other caller.
   */
  clear(): void {
    if (this.busy) return;
    // A digest gate or transcript prompt is a command awaiting its chips
    // without holding `busy`; dropping the turn would leave it hanging, so
    // each is answered "Cancel" once the log is empty.
    const pending = this.turns.flatMap((t) => (t.chips?.cancel ? [t.chips.cancel] : []));
    this.wantFocus = true;
    this.turns = [];
    this.draft = "";
    this.status = "";
    this.session = null;
    this.restartArmed = false;
    this.rerender();
    for (const cancel of pending) cancel();
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
      const hasNotes = this.plugin.app.vault.getMarkdownFiles().some((f: TFile) => this.isWikiPage(f.path));
      log.createDiv({
        cls: "wikilm-muted",
        text: hasNotes
          ? "Ask a question about your topic notes, or say “quiz me”, “digest”, “highlight”. Answers cite the highlights they came from. Say “help” for the rest."
          : `No topic notes under ${prefix} yet. Open a PDF and say “digest”, or say “help”.`,
      });
    }

    for (const turn of this.turns) this.renderTurn(log, turn);

    this.renderInput(wrap);

    // Only a turn the panel pushed moves the log to its foot. Every other
    // redraw — a status step, or a store change (inboxView's `onChange`
    // subscription redraws the whole view when a card is written in the
    // background) — puts the reader back where they were: at the foot if they
    // were there, else at the same offset, so scrolling back is not undone.
    const newest = this.turns[this.turns.length - 1] ?? null;
    if (newest !== this.lastRenderedTurn) this.atBottom = true;
    this.lastRenderedTurn = newest;
    // Where to put the log is decided once, here. The scrolls `place` itself
    // causes are not the reader's and are not recorded: markdown that grows
    // between the assignment and its scroll event would read as "scrolled up"
    // and pin the second `place` part-way down the answer. A scroll event
    // fires before the frame's rAF callbacks, so `placing` clears one frame
    // after the last `place`.
    const stick = this.atBottom;
    const offset = this.logScroll;
    let placing = false;
    let placed = 0;
    const place = (): void => {
      placing = true;
      const mine = ++placed;
      log.scrollTop = stick ? log.scrollHeight : offset;
      window.requestAnimationFrame(() => {
        if (mine === placed) placing = false;
      });
    };
    place();
    // Markdown renders asynchronously, so the height is not final yet.
    window.requestAnimationFrame(() => {
      if (log.isConnected) place();
    });
    log.addEventListener("scroll", () => {
      if (placing) return;
      this.logScroll = log.scrollTop;
      this.atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
    });
  }

  /**
   * Make the wikilinks inside rendered markdown open their notes.
   *
   * `MarkdownRenderer.render` writes a real `a.internal-link` carrying its
   * target in `data-href`, but it attaches no click handler: Obsidian wires
   * those inside its own `MarkdownView`, and this is a plain `ItemView`, so in
   * the panel they rendered as links that did nothing. The quiz felt the gap
   * most — a grade cites `[17] Self-Efficacy` (`renderGradeMarkdown`, src/quiz.ts), and the note
   * behind the citation is the thing a reader wants after getting one wrong.
   *
   * One delegated listener on the log covers every turn that goes through the
   * markdown renderer — grades, the closing "Missed" list (`renderSummaryMarkdown`, src/quiz.ts),
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
      this.renderSummaryChips(el, turn);
      return;
    }

    const report = turn.report;
    if (report && this.plugin.settings.askShowGrounding) this.renderGrounding(el, report, turn);

    const evidence = turn.evidence ?? [];
    // A failed model call still found passages, and they are what the reader
    // can use while the provider is down: the top few, without a send button,
    // since there is no answer to send.
    if (turn.error) {
      if (evidence.length > 0) {
        this.renderSources(
          el,
          evidence.slice(0, MAX_SOURCES).map((unit) => ({ unit, why: "" })),
          "Closest passages in your notes",
        );
      }
      return;
    }
    if (!report || turn.quiz) return;
    // The sources shown and the sources sent are the same list, stand-in and
    // all: a button that queued something other than what is printed above it
    // would be a different answer than the one the reader read.
    const picked = evidence.length > 0 ? pickSources(evidence, report) : [];
    if (picked.length > 0) this.renderSources(el, picked);
    // No button that can only say "Not sent": an answer on the notes with no
    // source left to card is refused by the capture, so it gets none.
    if (canSendAnswer(report, turn.text) && (picked.length > 0 || report.fromGeneralKnowledge)) this.renderAnswerActions(el, turn);
  }

  /**
   * What the reader can do with an answer: card it.
   *
   * Offered on every answer `canSendAnswer` (src/askCheck.ts) accepts: the
   * model's own text resting on the notes, or a general-knowledge answer,
   * which is carded with an "unverified" note and no passage. A refusal or a
   * fallback the plugin wrote is not an answer and gets no button.
   */
  private renderAnswerActions(el: HTMLElement, turn: ChatTurn): void {
    const row = el.createDiv({ cls: "wikilm-chat-offer" });
    const send = row.createEl("button", {
      cls: turn.sentToInbox ? "" : "mod-cta",
      text: turn.sentToInbox ? "Sent to inbox" : "Send answer to inbox",
    });
    // The log is rebuilt wholesale on every rerender, so "already sent" has
    // to live on the turn: a disabled flag set on the button would not
    // survive the next answer.
    send.disabled = this.busy || !!turn.sentToInbox;
    send.addEventListener("click", () => void this.sendAnswerToInbox(turn));
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
   * When the model named nothing on an answer it says the notes cover, the
   * best-ranked passage stands in, its `why` saying it was not cited
   * (`pickSources`, src/askCheck.ts). A refusal or a general-knowledge answer
   * shows none. An error turn passes its top passages under its own heading.
   */
  private renderSources(el: HTMLElement, picked: PickedSource[], head = picked.length === 1 ? "Source" : "Sources"): void {
    el.createDiv({ cls: "wikilm-chat-sources-head", text: head });
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
  private renderGrounding(el: HTMLElement, report: GroundingReport, turn?: ChatTurn): void {
    const line = el.createDiv({ cls: `wikilm-chat-grounding${report.coverage === "none" ? " is-unverified" : ""}` });
    // The route says which stage found the evidence — the notes' own words,
    // the graph around them, or the model's keywords — and what the judge
    // kept. Upstream shows the same as a chip. None for a general-knowledge
    // or canned reply (`routeForReport`): the first already says where it
    // came from, and the second came from no route.
    const bits = [renderGroundingLine(report)];
    const route = routeForReport(report, turn?.route ?? "");
    if (route && route !== "none") bits.push(route);
    // The scope always, refusals included, since it is what was searched:
    // "in HBIO408", or the whole vault when the class was too small.
    const scope = (turn?.scope ?? "").replace(/^the /, "");
    if (scope) bits.push(scope);
    line.createSpan({ text: bits.join(" · ") });

    // The sentences the local check could not find a passage for, quiet under
    // the line that counted them. They stay in the answer above, unaltered:
    // this is a pointer to what to go and look at, not a verdict on it. The
    // count on the line stays when the list is turned off.
    if (!this.plugin.settings.askShowUnmatched) return;
    const unmatched = renderUnmatchedClaims(report);
    if (unmatched.length === 0) return;
    const block = el.createDiv({ cls: "wikilm-unmatched" });
    block.createDiv({ text: "Matched no passage:" });
    for (const text of unmatched.slice(0, ChatPanel.UNMATCHED_SHOWN)) block.createDiv({ text });
    const more = unmatched.length - ChatPanel.UNMATCHED_SHOWN;
    if (more > 0) block.createDiv({ text: `… and ${more} more` });
  }

  /** How many unmatched sentences are listed under an answer before the rest are counted. */
  private static readonly UNMATCHED_SHOWN = 5;

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
   * The misses are on the turn, and the send button sends that turn's misses
   * and remembers it did, so an old summary sends its own quiz and reads
   * "Sent to inbox" afterwards, like the button under an answer. "Quiz again"
   * reads `lastQuiz` and so always repeats the most recent quiz. Sending
   * nothing is not offered: the chip is disabled at zero rather than writing
   * an empty batch to the inbox.
   */
  private renderSummaryChips(el: HTMLElement, turn: ChatTurn): void {
    const misses = turn.quiz?.misses ?? [];
    const row = el.createDiv({ cls: "wikilm-chat-offer" });
    const send = row.createEl("button", {
      cls: turn.sentToInbox ? "" : "mod-cta",
      text: turn.sentToInbox ? "Sent to inbox" : `Send ${misses.length} missed to inbox`,
    });
    send.disabled = this.busy || misses.length === 0 || !!turn.sentToInbox;
    send.addEventListener("click", () => void this.sendMissesToInbox(turn));

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
      (!!active && isNote && pdfsLinkedFrom(this.plugin.app, active).length > 0);
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
    clear.disabled = this.busy;
    clear.addEventListener("click", () => this.clear());

    row.createSpan({ cls: "wikilm-muted", text: this.status });

    // Focus follows the reader's own submit or Clear, once the panel is idle
    // again, and nothing else: a redraw driven by a store change must not
    // pull the cursor out of the note they are editing.
    if (!this.busy && this.wantFocus) {
      this.wantFocus = false;
      window.setTimeout(() => ta.focus(), 0);
    }
  }
}
