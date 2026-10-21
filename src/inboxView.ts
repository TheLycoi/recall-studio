import { ItemView, MarkdownView, Menu, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type RecallPlugin from "./main";
import {
  RECALL_ADD_ICON,
  RECALL_CHEVRON_DOWN_ICON,
  RECALL_CHEVRON_RIGHT_ICON,
  RECALL_CLOZE_ICON,
  RECALL_DISCARD_ICON,
  RECALL_EDIT_ICON,
  RECALL_FILE_ICON,
  RECALL_ICON,
  RECALL_MORE_ICON,
  RECALL_QA_ICON,
  RECALL_RETRY_ICON,
  RECALL_SEND_ICON,
  RECALL_SPARK_ICON,
  RECALL_STACK_ICON,
} from "./icon";
import { isPdfHighlight, liveCards, makeCard, pendingCards, type Card, type CardSnapshot, type Highlight } from "./model";
import { askInstruction, SchemaSuggestionsModal } from "./modals";
import { countClozes, fmtDate, locateQuote, splitFrontmatter, plainText } from "./util";
import { describeError } from "./llm";
import { cardAuditLabel } from "./generation";
import { findCrossInterference, lintCard, LINT_LABELS, wrapCloze } from "./lint";
import { DEFAULT_SETTINGS } from "./settings";
import { beginCardRewrite, cardAuthorization, cardContent, cardReplacement, checkCard, checkAndRepairCard, currentCardCheck } from "./cardActions";
import { QuizView as ChatView } from "./quizView";
import { runNamedCommand } from "./commands";

export const VIEW_TYPE_INBOX = "review-inbox";

type Filter = "review" | "exported" | "all";

/** Which half of the view is on screen. One at a time; Inbox is the default. */
type Panel = "inbox" | "chat";

/**
 * How each card status reads to the reviewer. "pending" is the internal name
 * for a card that has not been accepted; it is shown as "Draft" so the label
 * says what the card is, not what the code calls it.
 */
const STATUS_LABELS: Record<Card["status"], string> = {
  pending: "Draft",
  approved: "Draft",
  exported: "Exported",
  duplicate: "Duplicate",
  flagged: "Flagged",
  deleted: "Deleted",
};

/**
 * How a highlight got here, for the provenance line. Only the origins worth
 * naming appear: "selection" and "pdf" are the ordinary ways to capture one,
 * and labelling them would say nothing the quote does not already show.
 */
const ORIGIN_LABELS: Partial<Record<Highlight["origin"], string>> = {
  highlighter: "highlighter",
  ai: "AI pick",
  quiz: "quiz miss",
  ask: "from a question",
};

/**
 * The inbox: every highlight grouped under its source note, the highlighted
 * passage on the left and its cards on the right, built for fast triage.
 * Export accepts drafts. Quiz stays inside this view, without a dashboard
 * or scheduler.
 */
export class InboxView extends ItemView {
  private chat?: ChatView;
  private chatEl!: HTMLElement;
  private headerEl!: HTMLElement;
  private inboxHeaderEl!: HTMLElement;
  private commandEl!: HTMLElement;
  private cardsEl!: HTMLElement;
  private unsubscribe: (() => void) | null = null;
  private filter: Filter = "review";
  // shortcut: the selected panel is per-open state, always Inbox on the next
  // open. Persisting it would need a settings field (as the old sidebarMode had).
  private panel: Panel = "inbox";
  private panelScroll: Record<Panel, number> = { inbox: 0, chat: 0 };
  private tabInbox?: HTMLButtonElement;
  private tabChat?: HTMLButtonElement;
  private checking = new Set<string>();
  private verifying = false;
  private closed = false;
  private checkEpoch = 0;
  private collapsed = new Set<string>();
  private editing: string | null = null;
  private editorDraft?: { content: () => string; saved: () => boolean };
  private focusedCard: string | null = null;
  /** Highlight ids whose flagged-card group is expanded under lintMode "hide". */
  private expandedFlagged = new Set<string>();
  private renderScheduled = false;
  /**
   * A store change arrived while a card editor was open and its render was
   * held back. Every path that closes the editor renders, which draws the
   * held change and clears this.
   */
  private dirty = false;
  /**
   * Scratch state for one render, never persisted: card id -> ids of cards in
   * OTHER highlights that would collide with it in Anki, plus card id -> the
   * highlight it belongs to so the tooltip can name the partner's source.
   * Rebuilt every render, so binning one partner clears the other's badge.
   */
  private crossInterference = new Map<string, string[]>();
  private cardOwner = new Map<string, Highlight>();

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: RecallPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_INBOX;
  }
  getDisplayText(): string {
    return "Recall Studio";
  }
  getIcon(): string {
    return RECALL_ICON;
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.panel = "inbox";
    this.panelScroll = { inbox: 0, chat: 0 };
    this.contentEl.empty();
    this.contentEl.addClass("wikilm-notebook");
    this.headerEl = this.contentEl.createDiv();
    this.renderTabs(this.headerEl);
    this.inboxHeaderEl = this.headerEl.createDiv();
    this.commandEl = this.headerEl.createDiv({ cls: "review-inbox-command" });
    this.renderCommandBox(this.commandEl);
    this.chatEl = this.contentEl.createDiv({ cls: "review-inbox-chat" });
    this.chat = new ChatView(this.chatEl, this.plugin);
    await this.chat.onOpen();
    this.cardsEl = this.contentEl.createDiv({ cls: "review-inbox-cards" });
    this.contentEl.tabIndex = 0;
    this.registerDomEvent(this.contentEl, "keydown", (e) => this.onKey(e));
    this.unsubscribe = this.plugin.store.onChange(() => this.scheduleRender());
    this.render();
  }

  async onClose(): Promise<void> {
    this.closed = true;
    this.checkEpoch++;
    this.unsubscribe?.();
    await this.chat?.onClose();
  }

  focusChat(): void {
    // Select Chat first: the question box lives in the hidden half until then,
    // and focusing a node inside a display:none element does nothing.
    this.setPanel("chat");
    this.contentEl.querySelector<HTMLTextAreaElement>(".review-chat textarea")?.focus();
  }

  /**
   * Switch which half is shown. Toggling only visibility, never a redraw, so
   * the mounted chat and an open card editor are both left untouched. Coming
   * back to the Inbox rebuilds the cards — a store change may have arrived
   * while Chat was shown and its render was held — but an open editor is left
   * alone, since a redraw would wipe the half-typed card.
   */
  async startStudy(message: string): Promise<boolean> {
    this.focusChat();
    return this.chat?.submit(message) ?? false;
  }

  private setPanel(panel: Panel): void {
    if (this.panel === panel) return;
    this.panelScroll[this.panel] = this.contentEl.scrollTop;
    this.panel = panel;
    this.applyPanel();
    this.updateTabs();
    if (panel === "inbox" && !this.editorOpen()) this.render();
    this.contentEl.scrollTop = this.panelScroll[panel];
  }

  /**
   * Redraw after a store change, unless the reader has a card editor open: a
   * render empties the root and rebuilds the editor from the stored card, so a
   * background card landing would wipe a half-typed edit. The change is held
   * (`dirty`) and drawn when the editor closes.
   */
  private scheduleRender() {
    if (this.editorOpen()) {
      this.dirty = true;
      return;
    }
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    window.requestAnimationFrame(() => {
      this.renderScheduled = false;
      if (this.editorOpen()) {
        this.dirty = true;
        return;
      }
      this.render();
    });
  }

  /**
   * True when the editor for `this.editing` is actually on screen. Checked in
   * the DOM rather than from the flag alone, so a card the filter hid, or a
   * new hand-written card not drawn yet, does not hold renders back.
   */
  private editorOpen(): boolean {
    if (!this.editing) return false;
    return !!this.contentEl.querySelector(`.wikilm-card[data-id="${this.editing}"] .wikilm-editor`);
  }

  // ---------------------------------------------------------------- data

  private visibleHighlights(): Highlight[] {
    return this.plugin.store.all().filter((h) => {
      if (h.status === "dismissed") return this.filter === "all";
      if (this.filter === "review") return h.status !== "exported";
      if (this.filter === "exported") return h.status === "exported";
      return true;
    });
  }

  private groupBySource(hs: Highlight[]): Map<string, Highlight[]> {
    const m = new Map<string, Highlight[]>();
    for (const h of hs) {
      const arr = m.get(h.sourcePath) ?? [];
      arr.push(h);
      m.set(h.sourcePath, arr);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.line - b.line);
    return m;
  }

  // ---------------------------------------------------------------- render

  private render(): void {
    if (this.closed) return;
    const scrollTop = this.contentEl.scrollTop;
    this.dirty = false;

    this.applyPanel();
    // Chat owns its own DOM and stays mounted while shown, so an unfinished
    // question and an open card editor both survive the switch. The cards are
    // only rebuilt while the Inbox half is selected.
    if (this.panel === "chat") return;

    const root = this.cardsEl;
    root.empty();
    this.inboxHeaderEl.empty();
    this.renderHeader(this.inboxHeaderEl);
    this.rebuildCrossInterference();

    const hs = this.visibleHighlights();
    if (hs.length === 0) {
      const empty = root.createDiv({ cls: "wikilm-empty" });
      empty.createEl("p", { text: this.filter === "review" ? "Nothing to review." : "Nothing here." });
      empty.createEl("p", {
        cls: "wikilm-muted",
        text: "Turn on highlighter mode (ribbon pen) and drag across a passage in a note or PDF, or select text and run “Recall Studio: send selection to inbox”. Cards are written in the background and show up here as drafts.",
      });
      return;
    }

    const groups = this.groupBySource(hs);
    for (const [path, list] of groups) this.renderSource(root, path, list);

    this.contentEl.scrollTop = scrollTop;
  }

  /**
   * The Inbox/Chat switch. Two native buttons, one pressed at a time, so a
   * screen reader announces the state without a tab widget's arrow-key and
   * panel wiring. `is-active` reuses the sidebar-tab styling already in
   * styles.css.
   */
  private renderCommandBox(root: HTMLElement): void {
    const input = root.createEl("textarea", { cls: "review-chat-question", attr: { rows: "1", "aria-label": "Inbox command", placeholder: "Quiz me on… · Make flashcards on… · /command" } });
    const send = root.createEl("button", { text: "Send command", attr: { type: "button" } });
    let busy = false;
    send.disabled = true;
    input.addEventListener("input", () => { send.disabled = busy || !input.value.trim(); });
    const submit = async () => {
      const message = input.value;
      if (this.closed || busy || !message.trim()) return;
      busy = true; send.disabled = true;
      try {
        const result = await runNamedCommand(this.plugin, message);
        const accepted = result === null ? await this.startStudy(message) : result;
        if (accepted && input.value === message) input.value = "";
        else if (!accepted && !this.closed) new Notice("Recall Studio: finish or cancel the current study request before sending another message. Your draft is still in the Inbox.");
      } catch { if (!this.closed) new Notice("Recall Studio: the command could not run. Your draft is still in the Inbox."); }
      finally { busy = false; send.disabled = !input.value.trim(); }
    };
    send.addEventListener("click", submit);
    input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.stopPropagation(); void submit(); } });
  }

  private renderTabs(root: HTMLElement): void {
    const row = root.createDiv({ cls: "wikilm-tabs-row" });
    const tabs = row.createDiv({ cls: "wikilm-tabs" });
    const tab = (panel: Panel, label: string): HTMLButtonElement => {
      const b = tabs.createEl("button", { cls: "wikilm-tab", text: label, attr: { type: "button" } });
      b.setAttribute("aria-label", `${label} panel`);
      b.addEventListener("click", () => this.setPanel(panel));
      return b;
    };
    this.tabInbox = tab("inbox", "Inbox");
    this.tabChat = tab("chat", "Chat");
    this.updateTabs();
  }

  private updateTabs(): void {
    for (const [panel, b] of [["inbox", this.tabInbox], ["chat", this.tabChat]] as Array<[Panel, HTMLButtonElement | undefined]>) {
      if (!b) continue;
      const active = this.panel === panel;
      b.setAttribute("aria-pressed", String(active));
      b.toggleClass("is-active", active);
    }
  }

  /** Show the selected half, hide the other. */
  private applyPanel(): void {
    const chat = this.panel === "chat";
    this.chatEl.toggleClass("review-inbox-hidden", !chat);
    this.cardsEl.toggleClass("review-inbox-hidden", chat);
    this.inboxHeaderEl?.toggleClass("review-inbox-hidden", chat);
    this.commandEl?.toggleClass("review-inbox-hidden", chat);
  }

  /**
   * Recompute the cross-highlight collisions over the WHOLE store, not the
   * filtered view: a partner hidden by the current filter still collides in
   * Anki. Include draft, flagged and legacy approved cards from ready passages,
   * matching the statuses accepted by Export.
   * Derived, never stored, so it cannot go stale.
   */
  private rebuildCrossInterference(): void {
    const items: Array<{ card: Card; highlightId: string }> = [];
    this.cardOwner.clear();
    for (const h of this.plugin.store.all()) {
      if (h.status !== "ready") continue;
      for (const c of h.cards) {
        if (!["pending", "flagged", "approved"].includes(c.status)) continue;
        items.push({ card: c, highlightId: h.id });
        this.cardOwner.set(c.id, h);
      }
    }
    this.crossInterference = findCrossInterference(items);
  }

  private renderHeader(root: HTMLElement): void {
    const counts = this.plugin.store.counts();
    const header = root.createDiv({ cls: "wikilm-header" });
    const left = header.createDiv({ cls: "wikilm-header-left" });
    left.createEl("h2", { text: "Inbox" });
    const stats = left.createDiv({ cls: "wikilm-stats" });
    const stat = (label: string, n: number, cls = "") => {
      const s = stats.createSpan({ cls: `wikilm-stat ${cls}` });
      s.createSpan({ cls: "wikilm-stat-n", text: String(n) });
      s.createSpan({ text: ` ${label}` });
      return s;
    };
    let flagged = 0;
    let withBloom = 0;
    let remember = 0;
    for (const h of this.plugin.store.all()) {
      if (h.status !== "ready") continue;
      for (const c of h.cards) {
        if (c.status === "flagged") flagged++;
        if (c.status !== "pending" || !c.bloom) continue;
        withBloom++;
        if (c.bloom === "remember") remember++;
      }
    }
    stat("to review", counts.toReview);
    // Legacy approved cards count as drafts; Export now accepts the card.
    if (withBloom > 0) {
      const s = stat("at remember", remember, remember === withBloom && withBloom >= 5 ? "is-flagged" : "");
      s.title = "Drafts the critique placed at Bloom 'remember'. When every judged card sits there, the set is testing labels, not understanding.";
    }
    if (flagged) stat("flagged", flagged, "is-flagged");
    if (counts.queued + counts.generating) stat("writing", counts.queued + counts.generating, "is-busy");
    if (counts.errors) stat("failed", counts.errors, "is-error");
    // Failures are otherwise fixed only from the overflow menu; a count the
    // reader is already looking at is where the fix belongs.
    if (counts.errors) {
      const retryBtn = stats.createEl("button", { cls: "wikilm-retry-btn", text: `Retry failed (${counts.errors})` });
      retryBtn.addEventListener("click", () => this.retryFailedHighlights());
    }

    const right = header.createDiv({ cls: "wikilm-header-right" });

    const filter = right.createEl("select", { cls: "dropdown wikilm-filter" });
    filter.setAttribute("aria-label", "Filter the inbox");
    for (const [v, label] of [
      ["review", "To review"],
      ["exported", "Exported"],
      ["all", "Everything"],
    ] as const) {
      const o = filter.createEl("option", { text: label, value: v });
      if (v === this.filter) o.selected = true;
    }
    filter.addEventListener("change", () => {
      this.filter = filter.value as Filter;
      this.render();
    });

    const deckBtn = right.createEl("button", { cls: "wikilm-deck-btn" });
    setIcon(deckBtn.createSpan(), RECALL_STACK_ICON);
    // "Default" is the settings fallback, not a deck the reader picked, so it
    // reads as though a choice has been made when none has.
    const deck = this.plugin.settings.defaultDeck;
    const chosen = deck && deck !== DEFAULT_SETTINGS.defaultDeck;
    deckBtn.createSpan({ text: chosen ? deck : "Choose deck" });
    deckBtn.title = chosen ? `Cards export to “${deck}”. Click to change the target deck.` : "Choose the Anki deck these cards export to";
    deckBtn.setAttribute("aria-label", deckBtn.title);
    deckBtn.addEventListener("click", async () => {
      const d = await this.plugin.chooseDeck();
      if (d) {
        this.plugin.settings.defaultDeck = d;
        await this.plugin.saveSettings();
        this.render();
      }
    });

    const suggestions = this.plugin.schema.openCount();
    if (suggestions > 0) {
      const chip = right.createEl("button", {
        cls: "wikilm-schema-chip",
        text: `${suggestions} card rule suggestion${suggestions === 1 ? "" : "s"}`,
      });
      chip.title = "Rules Recall Studio noticed in your own edits, waiting for your decision";
      chip.addEventListener("click", () => {
        new SchemaSuggestionsModal(this.plugin.app, this.plugin.schema, () => this.scheduleRender()).open();
      });
    }

    // The export action is the explicit acceptance of the visible batch.
    const exportAll = right.createEl("button", { cls: "mod-cta", text: "Export" });
    exportAll.title = "Accept and export visible draft cards to Anki (⌘⏎)";
    exportAll.setAttribute("aria-label", exportAll.title);
    exportAll.addEventListener("click", () => void this.exportHighlights(this.visibleHighlights()));
    this.renderVerify(right, () => this.visibleHighlights(), "inbox");

    const more = right.createEl("button", { cls: "clickable-icon wikilm-icon-btn" });
    setIcon(more, RECALL_MORE_ICON);
    more.title = "More actions";
    more.setAttribute("aria-label", "More actions");
    more.addEventListener("click", (evt) => {
      const menu = new Menu();
      menu.addItem((i) =>
        i
          .setTitle("Retry failed highlights")
          .setIcon(RECALL_RETRY_ICON)
          .onClick(() => this.retryFailedHighlights()),
      );
      menu.addItem((i) =>
        i
          .setTitle("Export as Anki text file")
          .setIcon(RECALL_FILE_ICON)
          .onClick(() => void this.plugin.exportAsTextFile(this.visibleHighlights(), new Set(this.cardIds()))),
      );
      menu.addItem((i) =>
        i
          .setTitle("Archive exported and dismissed")
          .setIcon(RECALL_DISCARD_ICON)
          .onClick(async () => {
            try {
              const n = this.plugin.store.clearExported();
              await this.plugin.store.flush();
              new Notice(n ? `Recall Studio: archived ${n} passage${n === 1 ? "" : "s"}.` : "Recall Studio: inbox saved; no new passages to archive.");
            } catch (e) {
              console.error("Recall Studio: archive was not saved", e);
              new Notice("Recall Studio: archive not saved. Passage history remains in memory; retry after fixing storage.");
            }
          }),
      );
      menu.addItem((i) =>
        i
          .setTitle("Keyboard: j/k move · e edit · x delete · Enter export card")
          .setDisabled(true),
      );
      menu.showAtMouseEvent(evt);
    });
  }

  /** Requeue every highlight sitting in "error", shared by the header button and the overflow menu item. */
  private retryFailedHighlights(): void {
    for (const h of this.plugin.store.all()) if (h.status === "error") this.plugin.generator.enqueue(h);
    this.scheduleRender();
  }

  private renderSource(root: HTMLElement, path: string, list: Highlight[]): void {
    const section = root.createDiv({ cls: "wikilm-source" });
    const head = section.createDiv({ cls: "wikilm-source-head" });
    const toggle = head.createSpan({ cls: "wikilm-collapse" });
    setIcon(toggle, this.collapsed.has(path) ? RECALL_CHEVRON_RIGHT_ICON : RECALL_CHEVRON_DOWN_ICON);
    toggle.setAttribute("aria-label", this.collapsed.has(path) ? "Expand this source" : "Collapse this source");
    toggle.addEventListener("click", () => {
      if (this.collapsed.has(path)) this.collapsed.delete(path);
      else this.collapsed.add(path);
      this.render();
    });
    const title = head.createEl("a", { cls: "wikilm-source-title", text: list[0].sourceTitle });
    title.addEventListener("click", () => void this.plugin.app.workspace.openLinkText(path, "", "tab"));
    const draft = list.reduce((n, h) => n + h.cards.filter(c => ["pending", "flagged", "approved"].includes(c.status)).length, 0);
    head.createSpan({
      cls: "wikilm-muted",
      text: `${list.length} highlight${list.length === 1 ? "" : "s"} · ${draft} draft${draft === 1 ? "" : "s"}`,
    });
    const actions = head.createDiv({ cls: "wikilm-source-actions" });
    if (draft && !this.collapsed.has(path)) {
      const b = actions.createEl("button", { text: "Export" });
      b.title = "Accept and export visible draft cards from this note to Anki";
      b.setAttribute("aria-label", b.title);
      b.addEventListener("click", () => void this.exportHighlights(list));
      this.renderVerify(actions, () => list, "source");
    }
    if (this.collapsed.has(path)) return;

    for (const h of list) this.renderHighlight(section, h);
  }

  private renderHighlight(section: HTMLElement, h: Highlight): void {
    const row = section.createDiv({ cls: `wikilm-hl wikilm-hl-${h.status}` });
    row.dataset.id = h.id;

    // Left column: the highlight itself.
    const left = row.createDiv({ cls: "wikilm-hl-left" });
    const meta = left.createDiv({ cls: "wikilm-hl-meta" });
    const titleEl = meta.createSpan({ cls: "wikilm-hl-title", text: h.title || h.heading || "Highlight" });
    titleEl.title = "Click to rename";
    titleEl.addEventListener("click", () => {
      const input = createEl("input", { type: "text", value: h.title });
      input.addClass("wikilm-inline-input");
      titleEl.replaceWith(input);
      input.focus();
      const commit = () => {
        h.title = input.value.trim();
        this.plugin.store.touch();
      };
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") input.blur();
        if (e.key === "Escape") this.render();
      });
    });
    const badge = meta.createSpan({ cls: `wikilm-badge wikilm-badge-${h.status}` });
    badge.setText(
      h.status === "queued"
        ? "queued"
        : h.status === "generating"
          ? "writing…"
          : h.status === "error"
            ? "failed"
            : h.status === "exported"
              ? "exported"
              : h.status === "dismissed"
                ? "dismissed"
                : `${h.cards.filter(c => ["pending", "flagged", "approved"].includes(c.status)).length} drafts`,
    );

    const quote = left.createDiv({ cls: "wikilm-quote" });
    // Shown as words; the stored text keeps its links so the note can still be reopened at the passage.
    quote.setText(plainText(h.text));
    quote.title = "Open in the note";
    quote.addEventListener("click", () => void this.openSource(h));

    const where = left.createDiv({ cls: "wikilm-hl-where wikilm-muted" });
    where.setText(
      [
        isPdfHighlight(h) ? "PDF" : h.heading ? `§ ${h.heading}` : null,
        h.page ? `page ${h.page}` : h.origin === "ask" || h.origin === "quiz" ? null : `line ${h.line + 1}`,
        ORIGIN_LABELS[h.origin] ?? null,
        fmtDate(h.createdAt),
      ]
        .filter(Boolean)
        .join(" · "),
    );
    if (h.instruction) left.createDiv({ cls: "wikilm-hl-instruction", text: `“${h.instruction}”` });
    if (h.status === "error" && h.error) left.createDiv({ cls: "wikilm-error", text: h.error });
    if (h.generation) {
      const g = h.generation;
      const batchCards = h.cards.filter(c => c.generation?.batchId === g.id);
      const auditStatus = g.audit?.status === "verified" && (!batchCards.length || batchCards.some(c => !cardAuditLabel(c, h).startsWith("Audit verified"))) ? "unverified" : g.audit?.status ?? "unverified";
      left.createDiv({ cls: "wikilm-muted", text: `${g.preparation ? "Preparation saved" : "Preparation pending"} · ${g.drafts ? "Drafts saved" : "Writer pending"} · Audit ${auditStatus}` });
      if (g.audit && auditStatus !== "verified") left.createDiv({ cls: "wikilm-card-reason", text: g.audit.reason });
      for (const [label, rows] of [["Excluded", g.preparation?.exclusions], ["Omitted", g.preparation?.omissions]] as const) {
        for (const row of rows ?? []) left.createDiv({ cls: "wikilm-muted", text: `${label} ${row.factIds.join(", ")}: ${row.reason}` });
      }
      for (const conflict of g.preparation?.conflicts ?? []) left.createDiv({ cls: "wikilm-card-reason", text: `Source conflict: ${conflict.reason} Quote: “${conflict.quote}”` });
    }
    for (const prior of h.generationHistory ?? []) {
      for (const conflict of prior.preparation?.conflicts ?? []) left.createDiv({ cls: "wikilm-card-reason", text: `Previous batch source conflict: ${conflict.reason} Quote: “${conflict.quote}”` });
    }

    const hlActions = left.createDiv({ cls: "wikilm-hl-actions" });
    const iconBtn = (icon: string, tip: string, fn: () => void) => {
      const b = hlActions.createEl("button", { cls: "clickable-icon wikilm-icon-btn" });
      setIcon(b, icon);
      b.title = tip;
      b.setAttribute("aria-label", tip);
      b.addEventListener("click", fn);
      return b;
    };
    if (h.status === "ready" && h.cards.some(c => ["pending", "flagged", "approved"].includes(c.status))) {
      const b = hlActions.createEl("button", { text: "Export" });
      b.title = "Accept and export visible draft cards from this passage to Anki";
      b.setAttribute("aria-label", b.title);
      b.addEventListener("click", () => void this.exportHighlights([h]));
      this.renderVerify(hlActions, () => [h], "passage");
    }
    if (h.status === "error") iconBtn(RECALL_RETRY_ICON, "Retry", () => this.plugin.generator.enqueue(h));
    iconBtn(RECALL_ADD_ICON, "Add a card by hand", () => {
      const c = makeCard(h.id, { kind: "qa", front: "", back: "" });
      h.cards.push(c);
      if (h.status === "exported") h.status = "ready";
      this.editing = c.id;
      this.plugin.store.touch();
    });
    if (h.status !== "dismissed") {
      iconBtn(RECALL_DISCARD_ICON, "Dismiss passage and its cards", () => {
        h.status = "dismissed";
        this.plugin.store.touch();
      });
    } else {
      iconBtn(RECALL_DISCARD_ICON, "Delete permanently", () => this.plugin.store.remove(h.id));
    }

    // Right column: the cards.
    const right = row.createDiv({ cls: "wikilm-cards" });
    const cards = liveCards(h);
    if (h.status === "queued" || h.status === "generating") {
      right.createDiv({ cls: "wikilm-muted wikilm-cards-empty", text: "Cards are being written in the background…" });
    } else if (cards.length === 0) {
      right.createDiv({ cls: "wikilm-muted wikilm-cards-empty", text: "No cards." });
    }
    // lintMode "hide" collapses flagged cards behind a toggle rather than
    // dropping them: they are still created in the DOM, just inside a
    // container that starts collapsed. Expanding puts them back into j/k
    // navigation too — see cardIds().
    if (this.plugin.settings.lintMode === "hide" && cards.some((c) => c.status === "flagged")) {
      for (const c of cards) if (c.status !== "flagged") this.renderCard(right, h, c);
      const flagged = cards.filter((c) => c.status === "flagged");
      const expanded = this.expandedFlagged.has(h.id);
      const toggle = right.createEl("button", { cls: "wikilm-flagged-toggle" });
      setIcon(toggle.createSpan(), expanded ? RECALL_CHEVRON_DOWN_ICON : RECALL_CHEVRON_RIGHT_ICON);
      toggle.createSpan({ text: `${flagged.length} flagged` });
      toggle.title = expanded ? "Hide the flagged cards" : "Show the cards the linter or critique flagged";
      toggle.addEventListener("click", () => {
        if (expanded) this.expandedFlagged.delete(h.id);
        else this.expandedFlagged.add(h.id);
        this.render();
      });
      const box = right.createDiv({ cls: `wikilm-flagged-box${expanded ? "" : " is-collapsed"}` });
      for (const c of flagged) this.renderCard(box, h, c);
      return;
    }
    for (const c of cards) this.renderCard(right, h, c);
  }

  private renderCard(parent: HTMLElement, h: Highlight, c: Card): void {
    const el = parent.createDiv({ cls: `wikilm-card wikilm-card-${c.kind} wikilm-card-${c.status}` });
    el.dataset.id = c.id;
    if (this.focusedCard === c.id) el.addClass("is-focused");
    el.addEventListener("click", () => {
      this.focusedCard = c.id;
      this.contentEl.querySelectorAll(".wikilm-card.is-focused").forEach((x) => x.removeClass("is-focused"));
      el.addClass("is-focused");
    });

    const top = el.createDiv({ cls: "wikilm-card-top" });
    // Badges live in their own wrapping child; the actions are a sibling with a
    // reserved slot, so a long badge row can never push them out of the card.
    const meta = top.createDiv({ cls: "wikilm-card-meta" });
    meta.createSpan({ cls: "wikilm-kind", text: c.kind === "qa" ? "Question" : `Cloze${countClozes(c.text) > 1 ? ` ×${countClozes(c.text)}` : ""}` });
    // The explicit status label: Draft, Approved or Exported, the three states
    // the reviewer moves a card through.
    if (c.status === "pending" || c.status === "approved" || c.status === "exported") {
      meta.createSpan({ cls: `wikilm-badge wikilm-status-${c.status}`, text: STATUS_LABELS[c.status] });
    }
    if (c.status === "duplicate") meta.createSpan({ cls: "wikilm-badge wikilm-badge-duplicate", text: "Duplicate content" });
    if (c.edited) meta.createSpan({ cls: "wikilm-badge", text: "edited" });
    const auditLabel = cardAuditLabel(c, h);
    const auditBadge = meta.createSpan({ cls: "wikilm-badge", text: auditLabel });
    auditBadge.title = c.generation?.audit.reason ?? "No independent staged audit is recorded for this card. Human review is still required.";
    // Render what the pipeline actually recorded rather than recomputing it:
    // the stored lintFailures are the ones lintMode acted on, so a recomputed
    // check could disagree with the status the card is sitting in.
    if (c.status === "pending" || c.status === "approved" || c.status === "flagged") {
      for (const id of c.lintFailures ?? []) {
        // Old count ceilings are not missing-deletion findings under today's rules.
        if (id === "cloze-count" && !lintCard(c, h, []).failures.includes(id)) continue;
        const b = meta.createSpan({ cls: "wikilm-badge wikilm-badge-warn", text: LINT_LABELS[id] });
        b.title = `Lint check failed: ${id}`;
      }
      for (const id of c.lintWarnings ?? []) {
        const b = meta.createSpan({ cls: "wikilm-badge wikilm-badge-notice", text: LINT_LABELS[id] });
        b.title = `Interference risk: ${id}`;
      }
      const partners = this.crossInterference.get(c.id);
      if (partners) {
        const where = partners
          .map((id) => this.cardOwner.get(id))
          .filter((owner): owner is Highlight => owner !== undefined)
          .map((owner) => (owner.title ? `${owner.sourceTitle} — ${owner.title}` : owner.sourceTitle));
        const b = meta.createSpan({ cls: "wikilm-badge wikilm-badge-notice", text: LINT_LABELS["cross-interference"] });
        b.title = where.length > 0 ? `Same answer as a card in: ${where.join("; ")}` : "Same answer as a card in another highlight";
      }
      if (c.bloom) {
        const b = meta.createSpan({ cls: "wikilm-badge wikilm-badge-bloom", text: c.bloom });
        b.title = "Bloom level judged by the critique. 'remember' is right for a plain definition; a mechanism or reason turned into a what-is-it-called card is the case to watch for.";
      }
      if (c.critiqueReason) {
        const b = meta.createSpan({ cls: "wikilm-badge wikilm-badge-critique", text: "critique" });
        b.title = c.critiqueReason;
      }
      const check = currentCardCheck(c, h);
      if (check) {
        const b = meta.createSpan({ cls: `wikilm-badge ${check.issues.length ? "wikilm-badge-warn" : "wikilm-badge-checked"}`, text: check.issues.length ? "checked · issues found" : "checked" });
        b.title = check.issues.length ? check.issues.join("\n") : "User-requested check completed for this wording; no issues found.";
      }
    }
    const actions = top.createDiv({ cls: "wikilm-card-actions" });

    if (["pending", "flagged", "approved"].includes(c.status)) {
      const exportButton = actions.createEl("button", { cls: "mod-cta", text: "Export" });
      exportButton.title = "Accept and export this card to Anki (Enter)";
      exportButton.setAttribute("aria-label", exportButton.title);
      exportButton.addEventListener("click", e => {
        e.stopPropagation();
        void this.exportHighlights([h], new Set([c.id]));
      });
    }
    const btn = (icon: string, tip: string, fn: () => void) => {
      const b = actions.createEl("button", { cls: "clickable-icon wikilm-icon-btn" });
      setIcon(b, icon);
      b.title = tip;
      b.setAttribute("aria-label", tip);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
      });
    };
    // Flagged, approved and pending cards get the same editing actions: the
    // reader has to be able to edit or bin a card at any point. Editing an
    // approved card returns it to Draft (see save()/rewrite()).
    if (c.status === "pending" || c.status === "approved" || c.status === "flagged") {
      btn(RECALL_EDIT_ICON, "Edit (e)", () => {
        this.editing = this.editing === c.id ? null : c.id;
        this.render();
      });
      // The star is the button a reader reaches for to improve a card, so when
      // the pipeline already recorded what is wrong it fixes the card on one
      // click instead of asking for an instruction that only restates the
      // critique.
      btn(RECALL_SPARK_ICON, this.checking.has(c.id) ? "Checking and repairing card…" : "Check card against best practices (repair issues)", () => void this.checkAgainstPractices(h, c));
      btn(c.kind === "qa" ? RECALL_CLOZE_ICON : RECALL_QA_ICON, c.kind === "qa" ? "Convert to cloze" : "Convert to Q&A", () =>
        void this.rewrite(h, c, c.kind === "qa" ? "Convert this Q&A card into a cloze card." : "Convert this cloze card into a question and answer card."),
      );
      btn(RECALL_DISCARD_ICON, "Delete (x)", () => this.deleteCard(h, c));
    } else if (c.status === "duplicate") {
      btn(RECALL_DISCARD_ICON, "Remove", () => this.deleteCard(h, c));
    }

    if (this.editing === c.id) {
      this.renderEditor(el, h, c);
      return;
    }

    if (c.generation && !auditLabel.startsWith("Audit verified")) el.createDiv({ cls: "wikilm-card-reason", text: c.generation.audit.reason });
    const userCheck = currentCardCheck(c, h);
    if (userCheck?.issues.length) el.createDiv({ cls: "wikilm-card-reason", text: userCheck.issues.join(" · ") });

    if (c.critiqueReason && (c.status === "pending" || c.status === "approved" || c.status === "flagged")) {
      el.createDiv({ cls: "wikilm-card-reason", text: c.critiqueReason });
    }

    const body = el.createDiv({ cls: "wikilm-card-body" });
    if (c.kind === "qa") {
      body.createDiv({ cls: "wikilm-field-label", text: "Question" });
      body.createDiv({ cls: "wikilm-field", text: c.front });
      body.createDiv({ cls: "wikilm-field-label", text: "Answer" });
      body.createDiv({ cls: "wikilm-field", text: c.back });
    } else {
      const f = body.createDiv({ cls: "wikilm-field wikilm-cloze" });
      this.renderClozeText(f, c.text);
    }
  }

  private renderClozeText(el: HTMLElement, text: string): void {
    const re = /\{\{(c\d+)::([\s\S]*?)(?:::([^}]*))?\}\}/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m.index > last) el.appendText(text.slice(last, m.index));
      const chip = el.createSpan({ cls: "wikilm-cloze-chip" });
      chip.createSpan({ cls: "wikilm-cloze-n", text: m[1].slice(1) });
      chip.appendText(m[2]);
      chip.title = m[3] ? `hint: ${m[3]}` : m[1];
      last = m.index + m[0].length;
    }
    if (last < text.length) el.appendText(text.slice(last));
  }

  private renderEditor(el: HTMLElement, h: Highlight, c: Card): void {
    const form = el.createDiv({ cls: "wikilm-editor" });
    const kindSel = form.createEl("select", { cls: "dropdown" });
    kindSel.setAttribute("aria-label", "Card type");
    kindSel.createEl("option", { value: "qa", text: "Question / answer" });
    kindSel.createEl("option", { value: "cloze", text: "Cloze" });
    kindSel.value = c.kind;

    const front = form.createEl("textarea", { attr: { rows: "2", placeholder: "Question", "aria-label": "Question" } });
    front.value = c.front;
    const back = form.createEl("textarea", { attr: { rows: "2", placeholder: "Answer", "aria-label": "Answer" } });
    back.value = c.back;
    const text = form.createEl("textarea", { attr: { rows: "3", placeholder: "Sentence with {{c1::deletions}}", "aria-label": "Cloze sentence" } });
    text.value = c.text;
    const extra = form.createEl("textarea", { attr: { rows: "1", placeholder: "Extra (optional, shown on the back)", "aria-label": "Extra" } });
    extra.value = c.extra;

    // Instruction box: a rewrite request typed against the card in front of
    // you, rather than in a modal that hides it. Empty means "just save".
    const instruction = form.createEl("textarea", {
      cls: "wikilm-editor-instruction",
      attr: { rows: "1", placeholder: "Instruction for the model (optional) — e.g. shorten the answer, ask about the date", "aria-label": "Rewrite instruction" },
    });

    // Where "Check" writes its verdict. Kept out of the card's own lint fields
    // so a check on an unsaved draft never overwrites what the pipeline
    // recorded about the card as it currently stands on disk.
    const report = form.createDiv({ cls: "wikilm-editor-report" });
    report.hide();

    const sync = () => {
      const isQa = kindSel.value === "qa";
      front.toggle(isQa);
      back.toggle(isQa);
      text.toggle(!isQa);
    };
    kindSel.addEventListener("change", sync);
    sync();

    /** The card as currently typed, without touching the stored one. */
    const draft = (): Card => ({
      ...c,
      kind: kindSel.value as Card["kind"],
      front: kindSel.value === "qa" ? front.value.trim() : "",
      back: kindSel.value === "qa" ? back.value.trim() : "",
      text: kindSel.value === "qa" ? "" : text.value.trim(),
      extra: extra.value.trim(),
    });

    const editor = this.editorDraft = {
      content: () => JSON.stringify([kindSel.value, front.value, back.value, text.value, extra.value, instruction.value]),
      saved: () => kindSel.value === c.kind && front.value.trim() === c.front && back.value.trim() === c.back
        && text.value.trim() === c.text && extra.value.trim() === c.extra && !instruction.value.trim(),
    };

    const editorEpoch = this.checkEpoch;
    const editorSettings = JSON.stringify(this.plugin.settings);
    const editorActive = this.plugin.llm.requestAuthorization(() => !this.closed && this.checkEpoch === editorEpoch
      && this.editing === c.id && this.editorDraft === editor
      && JSON.stringify(this.plugin.settings) === editorSettings
      && this.plugin.store.all().includes(h) && h.cards.includes(c));
    let originalCurrent = cardAuthorization(c, h, editorActive);

    let checkedDraft: Card | undefined;
    const check = async (btn: HTMLButtonElement) => {
      const d = draft();
      const original = cardContent(c, h);
      const status = c.status;
      const settings = JSON.stringify(this.plugin.settings);
      const epoch = this.checkEpoch;
      checkedDraft = undefined;
      report.empty();
      report.show();
      report.setText("Checking card against best practices…");
      btn.disabled = true;
      try {
        await checkCard(d, h, (source, cards, siblings, authorized) => this.plugin.llm.critiqueCards(source, cards, siblings, authorized),
          () => !this.closed && this.checkEpoch === epoch && this.editing === c.id
            && JSON.stringify(this.plugin.settings) === settings
            && this.plugin.store.all().includes(h) && h.cards.includes(c)
            && c.status === status && cardContent(c, h) === original
            && cardContent(draft(), h) === cardContent(d, h));
        const result = currentCardCheck(d, h);
        if (!result) { report.setText("Draft changed or check cancelled. Check it again."); return; }
        checkedDraft = d;
        report.setText(result.issues.length ? result.issues.join(" · ") : "Check completed; no issues found.");
      } catch (e) {
        report.setText(describeError(e));
      } finally {
        btn.disabled = false;
      }
    };

    const save = async () => {
      if (this.checking.has(c.id) || this.closed || this.editing !== c.id || this.editorDraft !== editor) return;
      const ask = instruction.value.trim();
      if (ask && !originalCurrent()) { new Notice("Card or source changed. Your draft is unchanged; reopen the card before saving."); return; }
      const was = snapshot(c);
      let edited = false;
      const before = JSON.stringify([c.kind, c.front, c.back, c.text, c.extra]);
      c.kind = kindSel.value as Card["kind"];
      c.front = front.value.trim();
      c.back = back.value.trim();
      c.text = text.value.trim();
      c.extra = extra.value.trim();
      const empty = c.kind === "qa" ? !c.front || !c.back : !c.text;
      if (empty) {
        new Notice("Recall Studio: empty card discarded.");
        c.status = "deleted";
      } else if (JSON.stringify([c.kind, c.front, c.back, c.text, c.extra]) !== before) {
        c.edited = true;
        edited = true;
        // A manual edit invalidates whatever the linter/critique recorded about
        // the previous wording and lifts a flagged card back to draft, and it
        // clears an approval too: the approved wording is no longer the stored
        // one, so it must be approved again before it can export.
        if (c.status === "flagged" || c.status === "approved") c.status = "pending";
        delete c.lintFailures;
        delete c.lintWarnings;
        delete c.critiqueReason;
        delete c.userCheck;
      }
      if (checkedDraft && cardContent(c, h) === cardContent(checkedDraft, h)) c.userCheck = currentCardCheck(checkedDraft, h);
      if (!ask || c.status === "deleted") this.editing = null;
      if (edited) {
        // What the reader typed, as one revision. Recorded before the
        // instruction runs, and with the saved text as its `after`.
        this.plugin.store.recordRevision({
          cardId: c.id,
          at: new Date().toISOString(),
          via: "edit",
          instruction: "",
          before: was,
          after: snapshot(c),
        });
      }
      originalCurrent = cardAuthorization(c, h, editorActive);
      this.plugin.store.touch();
      // The instruction runs against the just-saved text, so a hand edit and a
      // "now shorten it" land in one pass rather than fighting each other.
      if (ask && c.status !== "deleted") await this.rewrite(h, c, ask, originalCurrent);
      else if (edited) await this.learnFromEdits();
    };
    const cancel = () => {
      const empty = c.kind === "qa" ? !c.front || !c.back : !c.text;
      if (empty) c.status = "deleted";
      this.editing = null;
      this.plugin.store.touch();
    };
    for (const ta of [front, back, text, extra, instruction]) {
      ta.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          void save();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      });
    }
    // Cloze: wrap what is selected in the sentence box with the next
    // deletion number. Only shown for a cloze card, since a Q&A card has no
    // sentence to mark, and it works on the sentence box alone.
    const clozeSelection = () => {
      const r = wrapCloze(text.value, text.selectionStart, text.selectionEnd);
      if (!r) {
        new Notice("Select the words to hide first.");
        return;
      }
      text.value = r.text;
      text.setSelectionRange(r.cursor, r.cursor);
      text.focus();
    };
    text.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        clozeSelection();
      }
    });
    const btns = form.createDiv({ cls: "wikilm-editor-btns" });
    const clozeBtn = btns.createEl("button", { text: "Cloze" });
    clozeBtn.title = "Hide the selected words behind the next {{cN::…}} (⌘⇧C)";
    clozeBtn.addEventListener("click", clozeSelection);
    const syncCloze = () => clozeBtn.toggle(kindSel.value === "cloze");
    kindSel.addEventListener("change", syncCloze);
    syncCloze();
    btns.createEl("button", { text: "Cancel" }).addEventListener("click", cancel);
    const checkBtn = btns.createEl("button", { text: "Check" });
    checkBtn.title = "Run the card rules and the critique against what you have typed, without saving.";
    checkBtn.addEventListener("click", () => void check(checkBtn));
    btns.createEl("button", { text: "Save", cls: "mod-cta" }).addEventListener("click", () => void save());
    btns.createSpan({ cls: "wikilm-muted", text: "⌘⏎ save · esc cancel · ⌘⇧C cloze" });
    window.setTimeout(() => (c.kind === "qa" ? front : text).focus(), 10);
  }

  // ---------------------------------------------------------------- actions

  private deleteCard(h: Highlight, c: Card): void {
    c.status = "deleted";
    // Deleting the card being edited closes its editor, so the render is not held back.
    if (this.editing === c.id) this.editing = null;
    if (this.focusedCard === c.id) this.focusedCard = this.neighbourCardId(c.id);
    this.plugin.store.touch();
  }

  private renderVerify(row: HTMLElement, highlights: () => Highlight[], scope: string): void {
    const button = row.createEl("button", { cls: "wikilm-verify", text: "Verify", attr: { type: "button" } });
    button.title = `Check visible drafts in this ${scope} against the captured source and writing rules, repair issues and recheck. Does not guarantee factual accuracy or export cards.`;
    button.setAttribute("aria-label", `Verify visible drafts in this ${scope}`);
    button.disabled = this.verifying;
    button.setAttribute("aria-busy", String(this.verifying));
    button.addEventListener("click", () => this.verifyHighlights(highlights()));
  }

  private updateVerifyButtons(): void {
    for (const button of Array.from(this.contentEl.querySelectorAll<HTMLButtonElement>(".wikilm-verify"))) {
      button.disabled = this.verifying;
      button.setAttribute("aria-busy", String(this.verifying));
    }
  }

  private async verifyHighlights(list: Highlight[]): Promise<void> {
    if (this.verifying) return;
    const visible = new Set(this.cardIds());
    const targets = list.flatMap(h => h.status === "ready" && !h.archived
      ? h.cards.filter(c => visible.has(c.id) && ["pending", "flagged", "approved"].includes(c.status)).map(c => ({ h, c }))
      : []);
    if (!targets.length) { new Notice("Recall Studio: no visible draft cards to verify."); return; }
    const settings = JSON.stringify(this.plugin.settings);
    const epoch = this.checkEpoch;
    const active = this.plugin.llm.requestAuthorization(() => !this.closed && this.checkEpoch === epoch
      && this.panel === "inbox" && JSON.stringify(this.plugin.settings) === settings);
    this.verifying = true;
    this.updateVerifyButtons();
    try {
      for (const { h, c } of targets) {
        const current = () => active() && this.visibleHighlights().includes(h) && !this.collapsed.has(h.sourcePath)
          && !(this.plugin.settings.lintMode === "hide" && c.status === "flagged" && !this.expandedFlagged.has(h.id))
          && this.cardIds().includes(c.id);
        if (!current()) { new Notice("Recall Studio: Verify stopped because its scope or authorization changed."); break; }
        if (!await this.checkAgainstPractices(h, c, current) || !current()) break;
      }
    } finally {
      this.verifying = false;
      this.updateVerifyButtons();
    }
  }

  private async checkAgainstPractices(h: Highlight, c: Card, batchActive: () => boolean = () => true): Promise<boolean> {
    if (this.checking.has(c.id)) return false;
    if (this.editing === c.id) { new Notice("Save or cancel this card's edits before checking and repairing it."); return false; }
    this.checking.add(c.id);
    const notice = new Notice("Recall Studio: checking and repairing card…", 0);
    const settings = JSON.stringify(this.plugin.settings);
    const epoch = this.checkEpoch;
    const was = snapshot(c);
    const active = () => batchActive() && !this.closed && this.checkEpoch === epoch && this.editing !== c.id
      && JSON.stringify(this.plugin.settings) === settings
      && this.plugin.store.all().includes(h) && h.cards.includes(c);
    try {
      const result = await checkAndRepairCard(c, h,
        (source, cards, siblings, authorized) => this.plugin.llm.critiqueCards(source, cards, siblings, authorized),
        (source, card, instruction, authorized) => this.plugin.llm.rewriteCard(source, card, instruction, authorized), active);
      if (result.status === "repaired") {
        this.plugin.store.recordRevision({ cardId: c.id, at: new Date().toISOString(), via: "repair",
          instruction: result.instruction!, before: was, after: snapshot(c) });
        new Notice("Card repaired and rechecked. It remains a draft until you export it.");
      } else if (result.status === "cancelled" && !this.closed) {
        new Notice("Card or source changed; the repair was cancelled without replacing it.");
      }
      return result.status === "checked" || result.status === "repaired";
    } catch (e) {
      new Notice(`Recall Studio: check or repair failed. ${describeError(e)}`);
      return false;
    } finally {
      this.checking.delete(c.id);
      this.plugin.store.touch();
      notice.hide();
    }
  }

  private async rewrite(h: Highlight, c: Card, preset?: string, savedEditor?: () => boolean): Promise<void> {
    const epoch = this.checkEpoch;
    const settings = JSON.stringify(this.plugin.settings);
    const editing = this.editing;
    const editor = editing === c.id ? this.editorDraft : undefined;
    if (editing === c.id && (!editor || (!savedEditor && !editor.saved()))) {
      new Notice("Save or cancel this card's edits before converting it.");
      return;
    }
    const draftContent = editor?.content();
    const current = this.plugin.llm.requestAuthorization(cardAuthorization(c, h, () => !this.closed && this.checkEpoch === epoch
      && (!savedEditor || savedEditor())
      && this.editing === editing && (!editor || (this.editorDraft === editor && editor.content() === draftContent))
      && JSON.stringify(this.plugin.settings) === settings
      && this.plugin.store.all().includes(h) && h.cards.includes(c)));
    if (!current()) return;
    const release = beginCardRewrite(c);
    if (!release) return;
    this.checking.add(c.id);
    let notice: Notice | undefined;
    try {
      const instruction = preset ?? (await askInstruction(this.plugin.app, "Rewrite card", "e.g. make the answer shorter, ask about the date instead"));
      if (!instruction || !current()) return;
      notice = new Notice("Recall Studio: rewriting…", 0);
      const was = snapshot(c);
      const source = structuredClone(h);
      source.text = plainText(source.text);
      const d = await this.plugin.llm.rewriteCard(source, structuredClone(c), instruction, current);
      if (!current()) return;
      const candidate = cardReplacement(c, h, d);
      c.kind = candidate.kind;
      c.front = candidate.front;
      c.back = candidate.back;
      c.text = candidate.text;
      c.edited = true;
      // The recorded lint failures and critique reason described the previous
      // wording, so they are stale once the card has been rewritten. Clearing
      // them also lifts a flagged card back to draft, and a rewrite is a
      // regeneration: it invalidates an approval, so an approved card returns
      // to Draft and must be approved again before it exports.
      if (c.status === "flagged" || c.status === "approved") c.status = "pending";
      delete c.lintFailures;
      delete c.lintWarnings;
      delete c.critiqueReason;
      delete c.userCheck;
      if (savedEditor) this.editing = null;
      this.plugin.store.touch();
      // The reader asked for this rewrite from the open editor's own buttons,
      // so the fields are redrawn from the rewritten card rather than held.
      if (this.editing === c.id) this.render();
      // A rewrite the model answered with the card it was given says nothing
      // about how the reader wants cards written, so it is not evidence.
      const now = snapshot(c);
      if (differs(was, now)) {
        this.plugin.store.recordRevision({
          cardId: c.id,
          at: new Date().toISOString(),
          via: "rewrite",
          instruction,
          before: was,
          after: now,
        });
        await this.learnFromEdits();
      }
    } catch (e) {
      if (current()) new Notice(`Recall Studio: ${describeError(e)}`);
    } finally {
      this.checking.delete(c.id);
      release();
      notice?.hide();
    }
  }

  /**
   * Look at the edits so far and propose any rule they now imply.
   *
   * Runs after a recorded revision and only with the setting on. The notice is
   * the only announcement: a proposal is a question, and the chip in the header
   * is where it waits until the reader has time for it.
   */
  private async learnFromEdits(): Promise<void> {
    if (!this.plugin.settings.schemaLearning) return;
    try {
      const n = await this.plugin.schema.learn(new Date().toISOString().slice(0, 10));
      if (n > 0) {
        new Notice(`Recall Studio: ${n} new card rule suggestion${n === 1 ? "" : "s"}. See the inbox header.`);
        this.scheduleRender();
      }
    } catch (e) {
      // Learning is a nicety on top of an edit that already succeeded; a
      // failure here must not look to the reader like the edit failed.
      console.error("Recall Studio: could not write a schema suggestion", e);
    }
  }

  private async exportHighlights(list: Highlight[], ids = new Set(this.cardIds())): Promise<void> {
    await this.plugin.exportHighlights(list, ids);
  }

  private async openSource(h: Highlight): Promise<void> {
    if (h.subpath) {
      await this.plugin.app.workspace.openLinkText(`${h.sourcePath}#${h.subpath}`, "", "tab");
      return;
    }
    if (h.page) {
      await this.plugin.app.workspace.openLinkText(`${h.sourcePath}#page=${h.page}`, "", "tab");
      return;
    }
    const target = h.blockId ? `${h.sourcePath}#^${h.blockId}` : h.sourcePath;
    await this.plugin.app.workspace.openLinkText(target, "", "tab");
    if (h.blockId) return;
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.file?.path !== h.sourcePath) return;
    const editor = view.editor;
    // Nothing is written into the note any more, so the span is found by its
    // text. `h.line` is only a fallback: it goes stale as soon as the note is
    // edited above the highlight.
    const file = this.plugin.app.vault.getAbstractFileByPath(h.sourcePath);
    if (file instanceof TFile) {
      try {
        const raw = await this.plugin.app.vault.read(file);
        const { body, offset } = splitFrontmatter(raw);
        const loc = locateQuote(body, h.text);
        if (loc) {
          const from = editor.offsetToPos(offset + loc.start);
          const to = editor.offsetToPos(offset + loc.end);
          editor.setSelection(from, to);
          editor.scrollIntoView({ from, to }, true);
          return;
        }
      } catch (e) {
        console.error("Recall Studio: could not re-locate the highlight", e);
      }
    }
    const line = Math.min(h.line, editor.lineCount() - 1);
    editor.setCursor({ line, ch: 0 });
    editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
  }

  // ---------------------------------------------------------------- keys

  private cardIds(): string[] {
    // Cards inside a collapsed flagged group are still in the DOM, so they
    // would otherwise take j/k focus while invisible. Skipping them here
    // keeps the cursor on what the reader can actually see.
    return Array.from(this.contentEl.querySelectorAll<HTMLElement>(".wikilm-card"))
      .filter((e) => !e.closest(".wikilm-flagged-box.is-collapsed"))
      .map((e) => e.dataset.id!)
      .filter(Boolean);
  }

  private neighbourCardId(id: string): string | null {
    const ids = this.cardIds();
    const i = ids.indexOf(id);
    if (i === -1) return ids[0] ?? null;
    return ids[i + 1] ?? ids[i - 1] ?? null;
  }

  private focusCard(id: string | null): void {
    this.focusedCard = id;
    this.contentEl.querySelectorAll(".wikilm-card.is-focused").forEach((x) => x.removeClass("is-focused"));
    if (!id) return;
    const el = this.contentEl.querySelector<HTMLElement>(`.wikilm-card[data-id="${id}"]`);
    if (el) {
      el.addClass("is-focused");
      el.scrollIntoView({ block: "nearest" });
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (this.editing) return;
    // The Inbox half's keys act on cards. While Chat is selected those cards
    // are hidden, so the shortcuts must not reach them.
    if (this.panel !== "inbox") return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.tagName === "BUTTON" || target.closest?.("button"))) return;
    const ids = this.cardIds();
    const i = this.focusedCard ? ids.indexOf(this.focusedCard) : -1;
    const found = this.focusedCard ? this.plugin.store.findCard(this.focusedCard) : undefined;

    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void this.exportHighlights(this.visibleHighlights());
      return;
    }
    switch (e.key) {
      case "j":
      case "ArrowDown":
        e.preventDefault();
        this.focusCard(ids[Math.min(ids.length - 1, i + 1)] ?? null);
        break;
      case "k":
      case "ArrowUp":
        e.preventDefault();
        this.focusCard(ids[Math.max(0, i - 1)] ?? null);
        break;
      case "x":
      case "Delete":
      case "Backspace":
        // Flagged cards are the likeliest thing a reader wants to throw away
        // in one keystroke, so triage keys treat them the same as pending.
        if (found && (found.card.status === "pending" || found.card.status === "approved" || found.card.status === "flagged")) {
          e.preventDefault();
          this.deleteCard(found.highlight, found.card);
        }
        break;
      case "e":
        if (found && (found.card.status === "pending" || found.card.status === "approved" || found.card.status === "flagged")) {
          e.preventDefault();
          this.editing = found.card.id;
          this.render();
        }
        break;
      case "Enter":
        if (found) {
          e.preventDefault();
          void this.exportHighlights([found.highlight], new Set([found.card.id]));
        }
        break;
      case "o":
        if (found) {
          e.preventDefault();
          void this.openSource(found.highlight);
        }
        break;
    }
  }
}

/**
 * The five fields a revision compares, copied out of the card. A copy, not a
 * reference: the card is mutated in place a line later, and a reference would
 * record the edit's result as its own starting point.
 */
function snapshot(c: Card): CardSnapshot {
  return { kind: c.kind, front: c.front, back: c.back, text: c.text, extra: c.extra };
}

function differs(a: CardSnapshot, b: CardSnapshot): boolean {
  return a.kind !== b.kind || a.front !== b.front || a.back !== b.back || a.text !== b.text || a.extra !== b.extra;
}
