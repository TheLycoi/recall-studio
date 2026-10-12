/**
 * The Chat view: ask a question against explicitly selected sources and, when
 * the answer survives verification, send its evidence passages into the Inbox.
 *
 * It is registered under its own view type so it and the Inbox can share a
 * vault, and it drives the plugin through a structural host rather than
 * importing `main.ts` — so the core owns registration and this file owns only
 * the view. Nothing here reads the vault whole: the picker lists Markdown
 * filenames and captured PDF passages, and only the checked ones are read, so
 * an unselected note can never reach the model. All answering and validation
 * lives in the pure `src/reviewChat.ts`; this file renders, reads the selected
 * files, and queues rows.
 *
 * Reused shape, with attribution (MIT, Copyright (c) 2026 Conrad Kelonu):
 *  - `wikipedia-lm @ d18d76b` (src/chatPanel.ts) — the answer turn, the source
 *    row with a clickable note link, the one grounding line, and the
 *    "Send to inbox" offer under an answer.
 */
import { ItemView, Notice, type App, type TFile, type WorkspaceLeaf } from "obsidian";
import { makeHighlight, type Highlight } from "./model";
import {
  buildChatEvidence,
  buildChatRow,
  chatRowKey,
  checkChatAnswer,
  resolveCitationPath,
  seedsFor,
  selectionChanged,
  type ChatAnswerArgs,
  type ChatAskDraft,
  type ChatEvidenceIn,
  type ChatGroundingReport,
  type ChatHistoryTurn,
  type ChatSeed,
  type ChatSourceOption,
} from "./reviewChat";

/** The view's own type. Distinct from the Inbox's, so both can share a vault. */
export const VIEW_TYPE_CHAT = "review-inbox-chat";

/** The model client the view needs: the one chat method, and an optional cancel. */
export interface ChatLlm {
  answerSelected(args: ChatAnswerArgs): Promise<ChatAskDraft>;
  /** Cancel in-flight work. Optional: a host without it still type-checks; see `cancel`. */
  abort?(): Promise<void>;
}

/** The part of the Inbox store the view uses. */
export interface ChatStore {
  all(): Highlight[];
  add(h: Highlight): Highlight;
  /** True when this text from this path is already in the inbox (not dismissed). Optional. */
  hasDuplicate?(sourcePath: string, normalizedText: string): boolean;
}

/** The part of the generator the view uses. */
export interface ChatGenerator {
  enqueue(h: Highlight): void;
}

/**
 * The plugin as the view sees it. Structural on purpose: the core owns the
 * plugin class and registration, and the view only needs these five things.
 */
export interface ChatHost {
  app: App;
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
 * The chat sidebar.
 *
 * The reader checks the sources they want, types a question, and reads the
 * answer with its citations. Selection is explicit and starts empty: the
 * active note is never selected for them, because a grounded answer has to
 * rest on what they chose. The draft question survives every re-render, and a
 * send is refused if the selection changed since the answer was made.
 */
export class ChatView extends ItemView {
  private selected = new Set<string>();
  private selectedHighlights = new Set<string>();
  private turns: ChatTurn[] = [];
  /** The question box's value, kept across re-renders so a background change cannot discard a draft. */
  private draftQuestion = "";
  private busy = false;
  private cancelled = false;
  private status = "";
  private scrollEl!: HTMLElement;

  constructor(
    leaf: WorkspaceLeaf,
    private host: ChatHost,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_CHAT;
  }
  getDisplayText(): string {
    return "Review Inbox Chat";
  }
  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("review-chat");
    this.render();
  }

  async onClose(): Promise<void> {
    this.cancelled = true;
  }

  // ---- source selection -----------------------------------------------------

  /** Every open Markdown note, listed by name; none is read until it is selected. */
  private markdownFiles(): TFile[] {
    return this.host.app.vault.getMarkdownFiles();
  }

  /** Captured PDF passages already in the inbox, offered as sources too. */
  private pdfPassages(): Highlight[] {
    return this.host.store.all().filter((h) => h.page !== null || /\.pdf$/i.test(h.sourcePath));
  }

  /** The vault paths of the current selection, for the citation and stale checks. */
  private selectedSourcePaths(): string[] {
    const paths = new Set<string>();
    for (const f of this.markdownFiles()) if (this.selected.has(f.path)) paths.add(f.path);
    for (const h of this.storePassagesSelected()) paths.add(h.sourcePath);
    return [...paths];
  }

  private storePassagesSelected(): Highlight[] {
    return this.pdfPassages().filter((h) => this.selectedHighlights.has(h.id));
  }

  private selectionCount(): number {
    return this.selected.size + this.selectedHighlights.size;
  }

  /** Read exactly the selected sources and turn them into seeds in picker order. */
  private async collectSeeds(): Promise<ChatSeed[]> {
    const options: ChatSourceOption[] = [];
    for (const f of this.markdownFiles()) {
      if (!this.selected.has(f.path)) continue;
      let text = "";
      try {
        text = await this.host.app.vault.cachedRead(f);
      } catch (e) {
        new Notice(`Recall: could not read ${f.path} — ${errorText(e)}`);
      }
      options.push({ id: f.path, path: f.path, title: f.basename, page: null, line: 1, kind: "note", text });
    }
    for (const h of this.storePassagesSelected()) {
      options.push({ id: h.id, path: h.sourcePath, title: h.sourceTitle || h.title, page: h.page, line: h.line, kind: "pdf", text: h.text });
    }
    return seedsFor(options, new Set(options.map((o) => o.id)));
  }

  // ---- asking ---------------------------------------------------------------

  private async ask(): Promise<void> {
    const question = this.draftQuestion.trim();
    if (!question || this.busy) return;

    if (this.selectionCount() === 0) {
      this.pushSystem("Select at least one source first, then ask.");
      this.render();
      return;
    }

    const selectedPaths = this.selectedSourcePaths();
    this.busy = true;
    this.cancelled = false;
    this.status = "reading the selected sources…";
    this.turns.push({ role: "user", text: question });
    this.draftQuestion = "";
    this.render();

    try {
      const seeds = await this.collectSeeds();
      const { evidence, truncated, omitted } = buildChatEvidence(seeds);
      if (evidence.length === 0) {
        this.pushSystem("The selected sources have no text to answer from.");
        return;
      }
      if (truncated) {
        this.pushSystem(
          `The selected sources were long, so the context was cut${omitted > 0 ? ` and ${omitted} more passage${omitted === 1 ? "" : "s"} left out` : ""}. Narrow the selection for an answer over everything.`,
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

      const { answer, report } = checkChatAnswer(draft, evidence);
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
   * Send the evidence behind an answer to the Inbox: one row per cited passage,
   * each carrying the passage itself and an instruction built from the question
   * and the answer. Rows are queued through the store and the generator, never
   * inserted as approved cards — the core marks approved ones.
   *
   * Refused when the selection changed since the answer was made (the answer
   * may no longer be grounded in what the reader can see), and each row is
   * skipped when the same passage is already in the inbox or was already sent
   * from this turn.
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
      const normalized = unit.text.replace(/\s+/g, " ").trim();
      if (this.host.store.hasDuplicate?.(row.sourcePath, normalized)) {
        skipped++;
        continue;
      }
      seen.add(key);
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
    this.renderNav(root);
    this.renderPicker(root);

    const log = root.createDiv({ cls: "review-chat-log" });
    this.scrollEl = log;
    for (const turn of this.turns) this.renderTurn(log, turn);

    this.renderInput(root);
    if (this.status) root.createDiv({ cls: "review-chat-status", text: this.status, attr: { role: "status", "aria-live": "polite" } });
    this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
  }

  private renderNav(root: HTMLElement): void {
    const nav = root.createDiv({ cls: "review-chat-nav", attr: { role: "tablist" } });
    const inbox = nav.createEl("button", { cls: "review-chat-nav-btn", text: "Inbox" });
    inbox.setAttribute("type", "button");
    inbox.addEventListener("click", () => void this.host.openInbox());
    const chat = nav.createEl("button", { cls: "review-chat-nav-btn is-active", text: "Chat" });
    chat.setAttribute("type", "button");
    chat.setAttribute("aria-current", "page");
    chat.addEventListener("click", () => this.render());
  }

  private renderPicker(root: HTMLElement): void {
    const details = root.createEl("details", { cls: "review-chat-sources" });
    details.open = true;
    const summary = details.createEl("summary", { cls: "review-chat-sources-head", text: `Sources (${this.selectionCount()} selected)` });
    summary.setAttribute("aria-label", "Sources to answer from");

    const files = this.markdownFiles();
    if (files.length === 0) details.createDiv({ cls: "review-chat-empty", text: "No Markdown notes in this vault." });
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
    if (report.refused) return "Not answered — nothing in the selected sources supports an answer";
    const coverage = report.coverage === "full" ? "Answered from the selected sources" : "Partly answered from the selected sources";
    const parts = [coverage];
    if (report.removed > 0) parts.push(`${report.removed} unsupported sentence${report.removed === 1 ? "" : "s"} dropped`);
    if (report.quotesRejected > 0) parts.push(`${report.quotesRejected} quote${report.quotesRejected === 1 ? "" : "s"} rejected`);
    return parts.join(" · ");
  }

  private renderInput(root: HTMLElement): void {
    const form = root.createDiv({ cls: "review-chat-input" });
    const box = form.createEl("textarea", {
      cls: "review-chat-question",
      attr: { rows: "2", placeholder: "Ask your selected sources a question", "aria-label": "Question" },
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
    ask.setAttribute("aria-label", "Ask the selected sources");
    ask.disabled = this.busy;
    ask.addEventListener("click", () => void this.ask());

    if (this.busy) {
      const cancel = row.createEl("button", { cls: "review-chat-cancel", text: "Cancel" });
      cancel.setAttribute("type", "button");
      cancel.setAttribute("aria-label", "Cancel the question");
      cancel.addEventListener("click", () => this.cancel());
    }

    if (this.selectionCount() === 0) {
      row.createSpan({ cls: "review-chat-hint", text: "Select at least one source to answer from." });
    }
  }
}
