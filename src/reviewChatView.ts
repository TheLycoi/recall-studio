/**
 * Chat searches local notes for relevant passages, verifies the answer, and
 * can send its evidence into the Inbox.
 *
 * It is mounted inside Inbox and drives the plugin through a structural host.
 * Retrieval reads eligible Markdown notes locally, one at a time.
 * Only bounded, relevant passages reach the model. Optional source selection
 * narrows the search before reading. Answer validation lives in reviewChat.ts.
 *
 * Reused shape, with attribution (MIT, Copyright (c) 2026 Conrad Kelonu):
 *  - `wikipedia-lm @ d18d76b` (src/chatPanel.ts) — the answer turn, the source
 *    row with a clickable note link, the one grounding line, and the
 *    "Send to inbox" offer under an answer.
 */
import { Notice, type App, type TFile } from "obsidian";
import { makeHighlight, type Highlight } from "./model";
import { ChatRetriever } from "./chatRetrieval";
import {
  buildChatEvidence,
  selectChatPassages,
  buildChatRow,
  chatRowKey,
  checkChatAnswer,
  resolveCitationPath,
  selectionChanged,
  type ChatAnswerArgs,
  type ChatAskDraft,
  type ChatEvidenceIn,
  type ChatGroundingReport,
  type ChatHistoryTurn,
  type ChatSeed,
  type ChatVerification,
} from "./reviewChat";

/** Legacy view type, used only when migrating saved workspace leaves. */
export const VIEW_TYPE_CHAT = "review-inbox-chat";

/** The model client the view needs: the one chat method, and an optional cancel. */
export interface ChatLlm {
  answerSelected(args: ChatAnswerArgs): Promise<ChatAskDraft>;
  expandChatQuery?(question: string): Promise<string[]>;
  verifySelected?(args: ChatAnswerArgs, draft: ChatAskDraft): Promise<ChatVerification>;
  /** Cancel in-flight work. Optional: a host without it still type-checks; see `cancel`. */
  abort?(): Promise<void>;
}

/** The part of the Inbox store the view uses. */
export interface ChatStore {
  all(): Highlight[];
  add(h: Highlight): Highlight;
}

/** The part of the generator the view uses. */
export interface ChatGenerator {
  enqueue(h: Highlight): void;
  /**
   * Ask for more cards on a highlight that already has some, steered for this
   * run only. Used when a cited passage is already captured: the existing
   * highlight is reused so its cards are never duplicated, and this run's
   * instruction never overwrites the one the capture stored.
   */
  more?(h: Highlight, instruction: string): void;
}

/**
 * The plugin as the view sees it. Structural on purpose: the core owns the
 * plugin class and registration, and the view only needs these five things.
 */
export interface ChatHost {
  app: App;
  settings?: { schemaFolder?: string; exportFolder?: string };
  llm: ChatLlm;
  store: ChatStore;
  generator: ChatGenerator;
  openInbox(): void | Promise<void>;
}

/** One turn in the chat log. */
interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  /** A message the view wrote (a status, a refusal note), not a model answer. */
  system?: boolean;
  error?: string;
  evidence?: ChatEvidenceIn[];
  report?: ChatGroundingReport;
  /** The reader's selection when the answer was made, for the stale guard. */
  selectedPaths?: string[];
  sentToInbox?: boolean;
}

/** A short, human error string; local so the view does not pull in the client's backends. */
function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * The embedded Inbox chat.
 *
 * Questions search eligible vault notes by default. The optional picker
 * narrows the search. The question survives re-renders, and a send is refused
 * if its source scope changed after the answer.
 */
export class ChatView {
  private selected = new Set<string>();
  private selectedHighlights = new Set<string>();
  private turns: ChatTurn[] = [];
  /** The question box's value, kept across re-renders so a background change cannot discard a draft. */
  private draftQuestion = "";
  private busy = false;
  private cancelled = false;
  private status = "";
  private scrollEl!: HTMLElement;
  private retriever: ChatRetriever;

  constructor(
    private contentEl: HTMLElement,
    private host: ChatHost,
  ) {
    this.retriever = new ChatRetriever(host.app, path => this.allowedPath(path));
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("review-chat");
    this.render();
  }

  async onClose(): Promise<void> {
    this.cancelled = true;
  }

  // ---- source selection -----------------------------------------------------

  private allowedPath(path: string): boolean {
    if (path.split("/").some(part => part.startsWith("."))) return false;
    const ignored = this.host.app.metadataCache as unknown as { isUserIgnored?: (path: string) => boolean } | undefined;
    if (ignored?.isUserIgnored?.(path)) return false;
    for (const folder of [this.host.app.vault.configDir, this.host.settings?.schemaFolder, this.host.settings?.exportFolder]) {
      const root = folder?.replace(/\/+$/, "");
      if (root && (path === root || path.startsWith(`${root}/`))) return false;
    }
    return true;
  }

  /** Notes and PDFs, excluding hidden, ignored and plugin-managed paths. */
  private sourceFiles(): TFile[] {
    return this.host.app.vault.getFiles().filter(f => /^(md|pdf)$/i.test(f.extension) && this.allowedPath(f.path));
  }

  /** Captured PDF passages already in the inbox, offered as sources too. */
  private pdfPassages(): Highlight[] {
    return this.host.store.all().filter((h) => h.status !== "dismissed" && this.allowedPath(h.sourcePath) && (h.page !== null || /\.pdf$/i.test(h.sourcePath)));
  }

  /** The vault paths of the current selection, for the citation and stale checks. */
  private selectedSourcePaths(): string[] {
    const paths = new Set<string>();
    for (const f of this.sourceFiles()) if (!this.selectionCount() || this.selected.has(f.path)) paths.add(f.path);
    for (const h of this.storePassagesSelected()) paths.add(h.sourcePath);
    return [...paths];
  }

  private storePassagesSelected(): Highlight[] {
    return this.pdfPassages().filter((h) => !this.selectionCount() || this.selectedHighlights.has(h.id));
  }

  private selectionCount(): number {
    return this.selected.size + this.selectedHighlights.size;
  }

  /** Search locally, keeping only a bounded set of relevant passage candidates. */
  private async collectSeeds(question: string, terms: readonly string[] = []): Promise<ChatSeed[]> {
    const result = await this.retriever.search(question, {
      paths: this.selectionCount() ? [...this.selected] : undefined,
      terms,
      cancelled: () => this.cancelled,
    });
    if (this.cancelled) return [];
    const captures = this.storePassagesSelected().map(h => ({
      path: h.sourcePath, title: h.sourceTitle || h.title, page: h.page, line: h.line,
      kind: "pdf" as const, text: h.text.slice(0, 1_000_000),
    }));
    this.pushSystem(`Searched ${result.searched} notes and PDFs locally${result.skipped.length ? `; skipped ${result.skipped.length}: ${result.skipped.slice(0, 3).join("; ")}` : "."}`);
    return selectChatPassages([...result.seeds, ...captures], question, 40, terms);
  }

  // ---- asking ---------------------------------------------------------------

  private async ask(): Promise<void> {
    const question = this.draftQuestion.trim();
    if (!question || this.busy) return;

    const selectedPaths = this.selectedSourcePaths();
    this.busy = true;
    this.cancelled = false;
    this.status = "searching your notes…";
    this.turns.push({ role: "user", text: question });
    this.draftQuestion = "";
    this.render();

    try {
      let terms: string[] = [];
      if (this.host.llm.expandChatQuery) {
        this.status = "planning wiki search…";
        this.render();
        try { terms = await this.host.llm.expandChatQuery(question); }
        catch { this.pushSystem("Search expansion unavailable; searching the original question."); }
      }
      if (this.cancelled) return;
      this.status = "searching notes and PDFs…";
      this.render();
      const seeds = await this.collectSeeds(question, terms);
      if (this.cancelled || selectionChanged(selectedPaths, this.selectedSourcePaths())) {
        this.pushSystem("Search cancelled because its source scope changed. Ask again.");
        return;
      }
      const { evidence, truncated, omitted } = buildChatEvidence(seeds);
      if (evidence.length === 0) {
        this.pushSystem("I could not find relevant passages in the notes searched. Try naming the topic more specifically.");
        return;
      }
      if (truncated) {
        this.pushSystem(
          `Using the highest-ranked passages within the context limit${omitted > 0 ? `; ${omitted} further matches were not sent` : ""}.`,
        );
      }

      this.status = "asking the model…";
      this.render();

      const args: ChatAnswerArgs = {
        question,
        evidence,
        history: this.history(),
        standingInstructions: "",
      };
      const draft = await this.host.llm.answerSelected(args);
      if (this.cancelled || selectionChanged(selectedPaths, this.selectedSourcePaths())) {
        this.pushSystem("Ask cancelled.");
        return;
      }

      let verification: ChatVerification | undefined;
      if (draft.coverage !== "none" && this.host.llm.verifySelected) {
        this.status = "checking the answer against its sources…";
        this.render();
        try { verification = await this.host.llm.verifySelected(args, draft); }
        catch { this.pushSystem("Answer verification failed; only exact source excerpts can be shown."); }
      }
      if (this.cancelled || selectionChanged(selectedPaths, this.selectedSourcePaths())) return;
      const { answer, report } = checkChatAnswer(draft, evidence, verification);
      this.turns.push({
        role: "assistant",
        text: answer,
        evidence,
        report,
        selectedPaths,
      });
    } catch (e) {
      this.turns.push({ role: "assistant", text: "", error: errorText(e) });
    } finally {
      this.busy = false;
      this.cancelled = false;
      this.status = "";
      this.render();
    }
  }

  /**
   * Cancel the running ask.
   *
   * The answer is discarded when it arrives either way. `abort` is called when
   * the host offers it — the existing completion API has no per-call signal, so
   * the client's `abort()` (which stops every backend) is the only primitive
   * available. <ceiling> A per-request `AbortSignal` on `CompletionRequest`
   * would let this stop one call without touching a background card run.
   */
  private cancel(): void {
    if (!this.busy) return;
    this.cancelled = true;
    this.status = "cancelling…";
    // shortcut: discard this answer without aborting shared background generation.
    // A request-scoped AbortSignal can stop network work in a future backend API.
    this.render();
  }

  private history(): ChatHistoryTurn[] {
    // Each request uses only its current selection. Old turns remain visible,
    // but never re-enter the prompt after their sources have been excluded.
    return [];
  }

  /** The question an answer replied to: the user turn just above it. */
  private questionFor(turn: ChatTurn): string {
    const i = this.turns.indexOf(turn);
    for (let j = i - 1; j >= 0; j--) {
      if (this.turns[j].role === "user") return this.turns[j].text;
    }
    return "";
  }

  private pushSystem(text: string): void {
    this.turns.push({ role: "assistant", text, system: true });
  }

  // ---- answer to inbox ------------------------------------------------------

  /**
   * The captured highlight this passage already is, or undefined. A dismissed
   * highlight is ignored, so a passage the reader binned can be captured again.
   * The predicate matches the store's own duplicate rule (same path, same text
   * after whitespace collapse, not dismissed), so the view and the store agree
   * on what "already captured" means.
   */
  private existingCapture(sourcePath: string, normalized: string): Highlight | undefined {
    return this.host.store.all().find(
      (h) => h.sourcePath === sourcePath && h.status !== "dismissed" && h.text.replace(/\s+/g, " ").trim() === normalized,
    );
  }

  /**
   * Send the evidence behind an answer to the Inbox: one row per cited passage,
   * each carrying the passage itself and an instruction built from the question
   * and the answer. A passage not captured yet is added as a new highlight; a
   * passage that is already captured reuses that highlight and asks for more
   * drafts on it, so its cards are never duplicated. Rows are queued through the
   * store and the generator, never inserted as approved cards — the core marks
   * approved ones.
   *
   * Refused when the selection changed since the answer was made (the answer
   * may no longer be grounded in what the reader can see), and a row already
   * queued from this turn is skipped so one send never queues it twice.
   */
  private async sendToInbox(turn: ChatTurn): Promise<void> {
    if (turn.sentToInbox || !turn.evidence || !turn.report || turn.report.refused) return;
    const snapshot = turn.selectedPaths ?? this.selectedSourcePaths();
    if (selectionChanged(snapshot, this.selectedSourcePaths())) {
      this.pushSystem("The selected sources changed since this answer. Ask again before sending it to the inbox.");
      this.render();
      return;
    }

    const question = this.questionFor(turn);
    let added = 0;
    let skipped = 0;
    const seen = new Set<string>();
    for (const n of turn.report.cited) {
      const unit = turn.evidence[n - 1];
      if (!unit) continue;
      const row = buildChatRow({ question, answer: turn.text, why: "", unit, selectedPaths: snapshot });
      if ("reason" in row) continue;
      const key = chatRowKey(row);
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      seen.add(key);
      const normalized = row.text.replace(/\s+/g, " ").trim();
      // The cited passage may already be captured. Reuse that highlight rather
      // than add a second copy of it: queue more drafts on it, steered by this
      // answer. Its existing cards (approved, exported or otherwise) are left
      // exactly as they are, and nothing is scheduled.
      const existing = this.existingCapture(row.sourcePath, normalized);
      if (existing) {
        if (this.host.generator.more) this.host.generator.more(existing, row.instruction);
        else this.host.generator.enqueue(existing);
        added++;
        continue;
      }
      const h = makeHighlight({
        sourcePath: row.sourcePath,
        sourceTitle: row.sourceTitle,
        text: row.text,
        line: row.line,
        page: row.page,
        title: row.title,
        instruction: row.instruction,
        origin: "ask",
      });
      this.host.store.add(h);
      this.host.generator.enqueue(h);
      added++;
    }

    turn.sentToInbox = true;
    this.pushSystem(
      added === 0
        ? `Nothing sent${skipped ? ": already in the inbox" : ""}.`
        : `Sent ${added} source${added === 1 ? "" : "s"} to the inbox${skipped ? `, ${skipped} already there` : ""}. Cards are being written.`,
    );
    this.render();
  }

  // ---- rendering ------------------------------------------------------------

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.createEl("h3", { text: "Chat" });
    this.renderPicker(root);

    const log = root.createDiv({ cls: "review-chat-log" });
    this.scrollEl = log;
    for (const turn of this.turns) this.renderTurn(log, turn);

    this.renderInput(root);
    if (this.status) root.createDiv({ cls: "review-chat-status", text: this.status, attr: { role: "status", "aria-live": "polite" } });
    this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
  }


  private renderPicker(root: HTMLElement): void {
    if (this.selectionCount()) {
      root.createDiv({ cls: "review-chat-hint", text: "Searching only selected sources, not the whole wiki." });
      const reset = root.createEl("button", { text: "Search whole wiki", attr: { type: "button" } });
      reset.disabled = this.busy;
      reset.addEventListener("click", () => {
        if (this.busy) return;
        this.selected.clear();
        this.selectedHighlights.clear();
        this.render();
      });
    }
    const details = root.createEl("details", { cls: "review-chat-sources" });
    details.open = false;
    const summary = details.createEl("summary", { cls: "review-chat-sources-head", text: this.selectionCount() ? `Search scope (${this.selectionCount()} selected)` : "Search scope: vault (optional)" });
    summary.setAttribute("aria-label", "Optionally narrow the search to specific sources");

    const files = this.sourceFiles();
    if (files.length === 0) details.createDiv({ cls: "review-chat-empty", text: "No searchable notes or PDFs in this vault." });
    for (const f of files) {
      const label = details.createEl("label", { cls: "review-chat-source" });
      const box = label.createEl("input", { type: "checkbox" });
      box.checked = this.selected.has(f.path);
      box.disabled = this.busy;
      box.setAttribute("aria-label", `Include ${f.basename}`);
      box.addEventListener("change", () => {
        if (box.checked) this.selected.add(f.path);
        else this.selected.delete(f.path);
        this.render();
      });
      label.createSpan({ text: f.basename });
    }

    const passages = this.pdfPassages();
    if (passages.length > 0) {
      details.createDiv({ cls: "review-chat-picker-sub", text: "Captured passages" });
      for (const h of passages) {
        const label = details.createEl("label", { cls: "review-chat-source" });
        const box = label.createEl("input", { type: "checkbox" });
        box.checked = this.selectedHighlights.has(h.id);
        box.disabled = this.busy;
        box.setAttribute("aria-label", `Include ${h.sourceTitle}${h.page ? `, page ${h.page}` : ""}`);
        box.addEventListener("change", () => {
          if (box.checked) this.selectedHighlights.add(h.id);
          else this.selectedHighlights.delete(h.id);
          this.render();
        });
        label.createSpan({ text: `${h.sourceTitle}${h.page ? ` · p.${h.page}` : ""}` });
      }
    }
  }

  private renderTurn(log: HTMLElement, turn: ChatTurn): void {
    const el = log.createDiv({ cls: `review-chat-turn is-${turn.role}${turn.system ? " is-system" : ""}` });
    if (turn.error) {
      el.createDiv({ cls: "review-chat-error", text: `The model call failed: ${turn.error}` });
      return;
    }
    if (turn.role === "user") {
      el.createDiv({ cls: "review-chat-q", text: turn.text });
      return;
    }
    if (turn.system || !turn.evidence || !turn.report) {
      el.createDiv({ cls: "review-chat-a", text: turn.text });
      return;
    }
    const answerEl = el.createDiv({ cls: "review-chat-a" });
    this.renderAnswerText(answerEl, turn);
    this.renderSources(el, turn);
    this.renderAnswerActions(el, turn);
  }

  /** Render the answer as text, turning each `[n]` marker into a link to its passage. */
  private renderAnswerText(el: HTMLElement, turn: ChatTurn): void {
    const evidence = turn.evidence ?? [];
    const selected = turn.selectedPaths ?? [];
    for (const part of turn.text.split(/(\[\d+\])/g)) {
      const m = /^\[(\d+)\]$/.exec(part);
      if (m) {
        const n = Number(m[1]);
        const path = resolveCitationPath(n, evidence, selected);
        const a = el.createEl("a", { cls: "review-chat-cite", text: part, href: path ?? undefined });
        a.setAttribute("role", "button");
        a.setAttribute("aria-label", path ? `Open source ${n}` : `Source ${n} unavailable`);
        a.addEventListener("click", (e) => {
          e.preventDefault();
          if (path) this.openPassage(evidence[n - 1]);
        });
        continue;
      }
      if (part) el.createSpan({ text: part });
    }
  }

  /** Open the note (or the PDF at its page) a passage came from. */
  private async openPassage(unit: ChatEvidenceIn): Promise<void> {
    const link = unit.page !== null ? `${unit.path}#page=${unit.page}` : unit.path;
    await this.host.app.workspace.openLinkText(link, "", false, { eState: { line: Math.max(0, unit.line - 1) } });
  }

  /**
   * The passages the answer rested on: only the evidence numbers it actually
   * cited, each a link that opens the exact passage. A refused answer shows
   * none, because there is nothing verified to point at.
   */
  private renderSources(el: HTMLElement, turn: ChatTurn): void {
    const report = turn.report;
    if (!report || report.refused || report.cited.length === 0) return;
    const evidence = turn.evidence ?? [];
    const head = el.createDiv({ cls: "review-chat-sources-head2", text: report.cited.length === 1 ? "Source" : "Sources" });
    head.setAttribute("role", "heading");
    head.setAttribute("aria-level", "4");
    for (const n of report.cited) {
      const unit = evidence[n - 1];
      if (!unit) continue;
      const row = el.createDiv({ cls: "review-chat-source-row" });
      const link = row.createEl("a", { cls: "review-chat-source-note", text: unit.title, href: unit.path });
      link.addEventListener("click", (e) => {
        e.preventDefault();
        this.openPassage(unit);
      });
      if (unit.page !== null) row.createSpan({ cls: "review-chat-source-page", text: `p.${unit.page}` });
      row.createDiv({ cls: "review-chat-source-text", text: unit.text });
    }
  }

  private renderAnswerActions(el: HTMLElement, turn: ChatTurn): void {
    const report = turn.report;
    if (!report) return;
    const row = el.createDiv({ cls: "review-chat-actions" });
    row.createDiv({ cls: `review-chat-grounding${report.refused ? " is-unverified" : ""}`, text: this.groundingLine(report) });
    if (report.refused || report.cited.length === 0) return;
    const send = row.createEl("button", { cls: "mod-cta review-chat-send", text: turn.sentToInbox ? "Sent to inbox" : `Send ${report.cited.length === 1 ? "source" : `${report.cited.length} sources`} to inbox` });
    send.setAttribute("type", "button");
    send.disabled = this.busy || !!turn.sentToInbox;
    send.addEventListener("click", () => void this.sendToInbox(turn));
  }

  private groundingLine(report: ChatGroundingReport): string {
    if (report.refused) return "Not answered: the retrieved passages do not support an answer";
    const coverage = report.coverage === "full" ? "Answered from cited passages" : "Partly answered from cited passages";
    const parts = [coverage];
    if (report.paraphrases) parts.push("AI-checked synthesis; verify the cited sources");
    if (report.removed > 0) parts.push(`${report.removed} unsupported sentence${report.removed === 1 ? "" : "s"} dropped`);
    if (report.quotesRejected > 0) parts.push(`${report.quotesRejected} quote${report.quotesRejected === 1 ? "" : "s"} rejected`);
    return parts.join(" · ");
  }

  private renderInput(root: HTMLElement): void {
    const form = root.createDiv({ cls: "review-chat-input" });
    const box = form.createEl("textarea", {
      cls: "review-chat-question",
      attr: { rows: "2", placeholder: "Ask your vault a question", "aria-label": "Question" },
    });
    box.maxLength = 4000;
    box.value = this.draftQuestion;
    box.disabled = this.busy;
    box.addEventListener("input", () => {
      this.draftQuestion = box.value;
    });

    const row = form.createDiv({ cls: "review-chat-input-actions" });
    const ask = row.createEl("button", { cls: "mod-cta review-chat-ask", text: this.busy ? "Asking…" : "Ask" });
    ask.setAttribute("type", "button");
    ask.setAttribute("aria-label", "Search your notes and ask");
    ask.disabled = this.busy;
    ask.addEventListener("click", () => void this.ask());

    if (this.busy) {
      const cancel = row.createEl("button", { cls: "review-chat-cancel", text: "Cancel" });
      cancel.setAttribute("type", "button");
      cancel.setAttribute("aria-label", "Cancel the question");
      cancel.addEventListener("click", () => this.cancel());
    }

    if (this.selectionCount() === 0) {
      row.createSpan({ cls: "review-chat-hint", text: "Searches your notes locally. Only relevant passages go to the model." });
    }
  }
}
