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
import { findCrossInterference, lintCard, LINT_FIX_INSTRUCTIONS, LINT_LABELS, wrapCloze } from "./lint";
import { DEFAULT_SETTINGS } from "./settings";
import { QuizPanel } from "./quizPanel";

export const VIEW_TYPE_INBOX = "recall-inbox";

type Filter = "review" | "all" | "exported";

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
 * The inbox: every highlight grouped under its source note, cards packed
 * densely beside the highlight they came from, built for fast triage.
 */
export class InboxView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private filter: Filter = "review";
  private collapsed = new Set<string>();
  private editing: string | null = null;
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
  /** Which half of the sidebar is showing. Persisted in `settings.sidebarMode`. */
  private mode: "inbox" | "quiz" = "inbox";
  /**
   * Scratch state for one render, never persisted: card id -> ids of cards in
   * OTHER highlights that would collide with it in Anki, plus card id -> the
   * highlight it belongs to so the tooltip can name the partner's source.
   * Rebuilt every render, so binning one partner clears the other's badge.
   */
  private crossInterference = new Map<string, string[]>();
  private cardOwner = new Map<string, Highlight>();
  private quiz!: QuizPanel;

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
    return "Recall inbox";
  }
  getIcon(): string {
    return RECALL_ICON;
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("wikilm-notebook");
    this.contentEl.tabIndex = 0;
    this.mode = this.plugin.settings.sidebarMode;
    this.quiz = new QuizPanel(this.plugin, this);
    this.registerDomEvent(this.contentEl, "keydown", (e) => this.onKey(e));
    this.unsubscribe = this.plugin.store.onChange(() => this.scheduleRender());
    this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.quiz?.dispose();
  }

  /** The quiz panel, so a command or a live check can reach the running quiz. */
  quizPanel(): QuizPanel {
    return this.quiz;
  }

  /** Switch halves, remember the choice, redraw. Called by `openQuiz()` in main.ts. */
  async setMode(mode: "inbox" | "quiz"): Promise<void> {
    if (this.mode !== mode) {
      this.mode = mode;
      this.plugin.settings.sidebarMode = mode;
      await this.plugin.saveSettings();
    }
    this.render();
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
   * the DOM rather than from the flag alone, so a card the filter or quiz mode
   * hid, or a new hand-written card not drawn yet, does not hold renders back.
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
    const root = this.contentEl;
    const scrollTop = root.scrollTop;
    this.dirty = false;
    root.empty();
    root.toggleClass("is-chat", this.mode === "quiz");

    this.renderTabs(root);
    this.renderHeader(root);

    if (this.mode === "quiz") {
      this.quiz.render(root);
      return;
    }

    this.rebuildCrossInterference();

    const hs = this.visibleHighlights();
    if (hs.length === 0) {
      const empty = root.createDiv({ cls: "wikilm-empty" });
      empty.createEl("p", { text: this.filter === "review" ? "Nothing to review." : "Nothing here." });
      empty.createEl("p", {
                cls: "wikilm-muted",
        text: "Turn on highlighter mode (ribbon pen) and drag across a passage in a note or PDF, or select text and run “Recall: Send selection to inbox”. Cards are written in the background and show up here.",
      });
      return;
    }

    const groups = this.groupBySource(hs);
    for (const [path, list] of groups) this.renderSource(root, path, list);

    root.scrollTop = scrollTop;
  }

  /**
   * Recompute the cross-highlight collisions over the WHOLE store, not the
   * filtered view: a partner hidden by the current filter still collides in
   * Anki. The population matches main.ts's pendingItems (ready highlights,
   * pending cards) so the badge means exactly "this would collide on export".
   * Derived, never stored, so it cannot go stale.
   */
  private rebuildCrossInterference(): void {
    const items: Array<{ card: Card; highlightId: string }> = [];
    this.cardOwner.clear();
    for (const h of this.plugin.store.all()) {
      if (h.status !== "ready") continue;
      for (const c of h.cards) {
        if (c.status !== "pending") continue;
        items.push({ card: c, highlightId: h.id });
        this.cardOwner.set(c.id, h);
      }
    }
    this.crossInterference = findCrossInterference(items);
  }

  /** The Inbox | Quiz switch, in its own row above the header so it sits in the same place in both modes. */
  private renderTabs(root: HTMLElement): void {
    const row = root.createDiv({ cls: "wikilm-tabs-row" });
    const tabs = row.createDiv({ cls: "wikilm-tabs" });
    for (const [m, label] of [
      ["inbox", "Inbox"],
      ["quiz", "Quiz"],
    ] as const) {
      const active = this.mode === m;
      const tab = tabs.createEl("button", { cls: `wikilm-tab${active ? " is-active" : ""}`, text: label });
      tab.setAttribute("aria-pressed", String(active));
      tab.addEventListener("click", () => void this.setMode(m));
    }
  }

  private renderHeader(root: HTMLElement): void {
    const counts = this.plugin.store.counts();
    const quiz = this.mode === "quiz";
    const header = root.createDiv({ cls: "wikilm-header" });
    const left = header.createDiv({ cls: "wikilm-header-left" });
    left.createEl("h2", { text: quiz ? "Quiz" : "Inbox" });
    const stats = left.createDiv({ cls: "wikilm-stats" });
    const stat = (label: string, n: number, cls = "") => {
      const s = stats.createSpan({ cls: `wikilm-stat ${cls}` });
      s.createSpan({ cls: "wikilm-stat-n", text: String(n) });
      s.createSpan({ text: ` ${label}` });
      return s;
    };
    if (!quiz) {
      stat("to review", counts.toReview);
      let withBloom = 0;
      let remember = 0;
      for (const h of this.plugin.store.all()) {
        if (h.status !== "ready") continue;
        for (const c of h.cards) {
          if (c.status !== "pending" || !c.bloom) continue;
          withBloom++;
          if (c.bloom === "remember") remember++;
        }
      }
      if (withBloom > 0) {
        const s = stat("at remember", remember, remember === withBloom && withBloom >= 5 ? "is-flagged" : "");
        s.title = "Cards the critique placed at Bloom 'remember'. When every judged card sits there, the set is testing labels, not understanding.";
      }
      if (counts.flagged) stat("flagged", counts.flagged, "is-flagged");
      if (counts.queued + counts.generating) stat("writing", counts.queued + counts.generating, "is-busy");
      if (counts.errors) stat("failed", counts.errors, "is-error");
      // Failures are otherwise fixed only from the overflow menu, three clicks
      // away; a count the reader is already looking at is where the fix belongs.
      if (counts.errors) {
        const retryBtn = stats.createEl("button", { cls: "wikilm-retry-btn", text: `Retry failed (${counts.errors})` });
        retryBtn.addEventListener("click", () => this.retryFailedHighlights());
      }
    }

    const right = header.createDiv({ cls: "wikilm-header-right" });

    if (quiz) return;

    const filter = right.createEl("select", { cls: "dropdown wikilm-filter" });
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
    // reads as though a choice has been made when none has. Naming the action
    // instead makes the button say what it does until there is a real deck to
    // report — after that the deck name is the more useful label.
    const deck = this.plugin.settings.defaultDeck;
    const chosen = deck && deck !== DEFAULT_SETTINGS.defaultDeck;
    deckBtn.createSpan({ text: chosen ? deck : "Choose deck" });
    deckBtn.title = chosen ? `Cards export to “${deck}”. Click to change the target deck.` : "Choose the Anki deck these cards export to";
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
      chip.title = "Rules Recall noticed in your own edits, waiting for your decision";
      chip.addEventListener("click", () => {
        new SchemaSuggestionsModal(this.plugin.app, this.plugin.schema, () => this.scheduleRender()).open();
      });
    }

    // The label names its destination. Without "to Anki" the button reads as a
    // generic export, and a reader who wants their cards in Spaced Repetition
    // presses it, sees nothing arrive there, and reports the wrong thing broken.
    // The command palette entry is "Export all reviewed cards to Anki"; the
    // in-note action says the same. Only this button omitted it.
    const exportAll = right.createEl("button", { cls: "mod-cta", text: "Export all reviewed to Anki" });
    exportAll.title = "Send every pending card in the inbox to Anki (⌘⏎)";
    exportAll.addEventListener("click", () => void this.exportHighlights(this.visibleHighlights()));

    const more = right.createEl("button", { cls: "clickable-icon wikilm-icon-btn" });
    setIcon(more, RECALL_MORE_ICON);
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
          .setTitle("Export reviewed as Anki text file")
          .setIcon(RECALL_FILE_ICON)
          .onClick(() => void this.plugin.exportAsTextFile(this.visibleHighlights())),
      );
      menu.addItem((i) =>
        i
          .setTitle("Send reviewed cards to Spaced Repetition")
          .setIcon(RECALL_STACK_ICON)
          .onClick(() => void this.sendToSpacedRepetition(this.visibleHighlights())),
      );
      menu.addItem((i) =>
        i
          .setTitle("Clear exported and dismissed")
          .setIcon(RECALL_DISCARD_ICON)
          .onClick(() => {
            const n = this.plugin.store.clearExported();
            new Notice(`Recall: cleared ${n}.`);
          }),
      );
      menu.addItem((i) =>
        i
          .setTitle("Keyboard: j/k move · e edit · x delete · Enter export highlight")
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
    toggle.addEventListener("click", () => {
      if (this.collapsed.has(path)) this.collapsed.delete(path);
      else this.collapsed.add(path);
      this.render();
    });
    const title = head.createEl("a", { cls: "wikilm-source-title", text: list[0].sourceTitle });
    title.addEventListener("click", () => void this.plugin.app.workspace.openLinkText(path, "", "tab"));
    const pending = list.reduce((n, h) => n + pendingCards(h).length, 0);
    head.createSpan({
      cls: "wikilm-muted",
      text: `${list.length} highlight${list.length === 1 ? "" : "s"} · ${pending} card${pending === 1 ? "" : "s"} to review`,
    });
    const actions = head.createDiv({ cls: "wikilm-source-actions" });
    if (pending) {
      const b = actions.createEl("button", { text: "Export note" });
      b.title = "Send all reviewed cards from this note to Anki";
      b.addEventListener("click", () => void this.exportHighlights(list));
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
                : `${pendingCards(h).length} to review`,
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
        // A quiz miss, or an answer carded from Ask in an older row, sits on no line of its note, so "line 1" would point nowhere.
        h.page ? `page ${h.page}` : h.origin === "ask" || h.origin === "quiz" ? null : `line ${h.line + 1}`,
        ORIGIN_LABELS[h.origin] ?? null,
        fmtDate(h.createdAt),
      ]
        .filter(Boolean)
        .join(" · "),
    );
    if (h.instruction) left.createDiv({ cls: "wikilm-hl-instruction", text: `“${h.instruction}”` });
    if (h.status === "error" && h.error) left.createDiv({ cls: "wikilm-error", text: h.error });

    const hlActions = left.createDiv({ cls: "wikilm-hl-actions" });
    const iconBtn = (icon: string, tip: string, fn: () => void) => {
      const b = hlActions.createEl("button", { cls: "clickable-icon wikilm-icon-btn" });
      setIcon(b, icon);
      b.title = tip;
      b.addEventListener("click", fn);
      return b;
    };
    if (h.status === "ready" && pendingCards(h).length) {
      iconBtn(RECALL_SEND_ICON, "Export this highlight's cards to Anki (Enter)", () => void this.exportHighlights([h]));
      iconBtn(RECALL_STACK_ICON, "Send this highlight's cards to Spaced Repetition", () =>
        void this.sendToSpacedRepetition([h]),
      );
    }
    if (h.status === "error") iconBtn(RECALL_RETRY_ICON, "Retry", () => this.plugin.generator.enqueue(h));
    if (h.status === "ready" || h.status === "exported") {
      iconBtn(RECALL_SPARK_ICON, "Write more cards for this highlight", async () => {
        const inst = await askInstruction(this.plugin.app, "More cards", "Optional: what should the extra cards cover?");
        if (inst === null) return;
        // For this run only: h.instruction keeps the quiz-miss
        // instruction the highlight was captured with.
        this.plugin.generator.more(h, inst);
      });
    }
    iconBtn(RECALL_ADD_ICON, "Add a card by hand", () => {
      const c = makeCard(h.id, { kind: "qa", front: "", back: "" });
      h.cards.push(c);
      if (h.status === "exported") h.status = "ready";
      this.editing = c.id;
      this.plugin.store.touch();
    });
    if (h.status !== "dismissed") {
      iconBtn(RECALL_DISCARD_ICON, "Dismiss highlight and its cards", () => {
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
    // dropping them: they are still created in the DOM (invariant 3, nothing
    // is silently destroyed), just inside a container that starts collapsed.
    // Expanding the group puts them back into j/k navigation too — see
    // cardIds(), which skips only the cards a collapsed group is hiding.
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
    if (c.status === "exported") meta.createSpan({ cls: "wikilm-badge wikilm-badge-exported", text: "in Anki" });
    if (c.status === "duplicate") meta.createSpan({ cls: "wikilm-badge wikilm-badge-duplicate", text: "duplicate" });
    if (c.edited && c.status === "pending") meta.createSpan({ cls: "wikilm-badge", text: "edited" });
    // Render what the pipeline actually recorded rather than recomputing it:
    // the stored lintFailures are the ones lintMode acted on, so a recomputed
    // check could disagree with the status the card is sitting in. Flagged
    // cards are included because they are exactly the ones whose reasons the
    // reader needs in order to decide.
    if (c.status === "pending" || c.status === "flagged") {
      for (const id of c.lintFailures ?? []) {
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
          .map((owner) => (owner.title ? `${owner.sourceTitle} \u2014 ${owner.title}` : owner.sourceTitle));
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
      } else if (c.critiqueRan) {
        // Without this the reviewer cannot tell a card the critique read and
        // kept from one it never saw (pass off, skipped as trivial, or failed).
        const b = meta.createSpan({ cls: "wikilm-badge wikilm-badge-checked", text: "checked" });
        b.title = "The critique pass reviewed this card and kept it as written.";
      }
    }
    const actions = top.createDiv({ cls: "wikilm-card-actions" });
    const btn = (icon: string, tip: string, fn: () => void) => {
      const b = actions.createEl("button", { cls: "clickable-icon wikilm-icon-btn" });
      setIcon(b, icon);
      b.title = tip;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
      });
    };
    // Flagged cards get the same actions as pending ones: the reader has to be
    // able to edit or bin a card the critique objected to, not just re-run the
    // fix. Only the export path treats flagged differently (main.ts pendingItems).
    if (c.status === "pending" || c.status === "flagged") {
      btn(RECALL_EDIT_ICON, "Edit (e)", () => {
        this.editing = this.editing === c.id ? null : c.id;
        this.render();
      });
      // The star is the button a reader reaches for to improve a card, so when
      // the pipeline already recorded what is wrong it fixes the card on one
      // click instead of asking for an instruction that only restates the
      // critique. Typing your own instruction is still available on a card
      // with notes, one icon along, and is the star's only job without them.
      if (this.lintNotes(c)) {
        btn(RECALL_SPARK_ICON, this.fixTooltip(c), () => void this.rewrite(h, c, this.lintInstruction(c)));
        // Retry, not the check: the check reads as "accept", which is the one
        // thing this button does not do.
        btn(RECALL_RETRY_ICON, "Rewrite with your own instruction", () => void this.rewrite(h, c));
      } else {
        btn(RECALL_SPARK_ICON, "Rewrite with an instruction", () => void this.rewrite(h, c));
      }
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

    if (c.critiqueReason && (c.status === "pending" || c.status === "flagged")) {
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
    kindSel.createEl("option", { value: "qa", text: "Question / answer" });
    kindSel.createEl("option", { value: "cloze", text: "Cloze" });
    kindSel.value = c.kind;

    const front = form.createEl("textarea", { attr: { rows: "2", placeholder: "Question" } });
    front.value = c.front;
    const back = form.createEl("textarea", { attr: { rows: "2", placeholder: "Answer" } });
    back.value = c.back;
    const text = form.createEl("textarea", { attr: { rows: "3", placeholder: "Sentence with {{c1::deletions}}" } });
    text.value = c.text;
    const extra = form.createEl("textarea", { attr: { rows: "1", placeholder: "Extra (optional, shown on the back)" } });
    extra.value = c.extra;

    // Instruction box: a rewrite request typed against the card in front of
    // you, rather than in a modal that hides it. Empty means "just save".
    const instruction = form.createEl("textarea", {
      cls: "wikilm-editor-instruction",
      attr: { rows: "1", placeholder: "Instruction for the model (optional) — e.g. shorten the answer, ask about the date" },
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

    /**
     * Run the card rules against the draft: the mechanical linter first, then
     * the model critique. The linter is free and synchronous, so its verdict
     * is on screen before the model call starts.
     */
    const check = async (btn: HTMLButtonElement) => {
      const d = draft();
      if (d.kind === "qa" ? !d.front || !d.back : !d.text) {
        new Notice("Recall: nothing to check yet.");
        return;
      }
      const siblings = h.cards.filter((x) => x.id !== c.id && x.status !== "deleted");
      const { failures, warnings } = lintCard(d, h, siblings);

      report.empty();
      report.show();
      const list = report.createDiv({ cls: "wikilm-editor-report-list" });
      for (const id of failures) list.createDiv({ cls: "wikilm-report-line wikilm-report-fail", text: `✗ ${LINT_LABELS[id]}` });
      for (const id of warnings) list.createDiv({ cls: "wikilm-report-line wikilm-report-warn", text: `! ${LINT_LABELS[id]}` });
      if (!failures.length && !warnings.length) list.createDiv({ cls: "wikilm-report-line wikilm-report-ok", text: "✓ passes every mechanical rule" });

      const pending = report.createDiv({ cls: "wikilm-report-line wikilm-muted", text: "asking the critique…" });
      btn.disabled = true;
      try {
        const [verdict] = await this.plugin.llm.critiqueCards(h, [d], siblings);
        pending.remove();
        if (!verdict) {
          report.createDiv({ cls: "wikilm-report-line wikilm-muted", text: "the critique returned nothing for this card." });
          return;
        }
        const line = report.createDiv({ cls: "wikilm-report-line" });
        line.createSpan({ cls: `wikilm-badge wikilm-badge-bloom`, text: verdict.bloom });
        const label = verdict.verdict === "keep" ? "keep" : verdict.verdict === "revise" ? "suggests a revision" : "would drop this";
        line.createSpan({ text: ` ${label}` });
        if (verdict.verdict !== "keep" && verdict.reason) {
          report.createDiv({ cls: "wikilm-report-line wikilm-report-reason", text: verdict.reason });
        }
        // Check is the reader asking "is this OK?" mid-edit, not a background
        // pass they might not be watching (unlike the generator's own critique,
        // which only flags — invariant 3). Clicking Check already is the
        // decision to hear the verdict out, so a revision drops straight into
        // the fields: nothing reaches the card until Save is pressed, and the
        // fields stay editable in case the revision needs a tweak first.
        if (verdict.verdict === "revise") {
          kindSel.value = verdict.kind;
          if (verdict.kind === "qa") {
            front.value = verdict.front.trim();
            back.value = verdict.back.trim();
          } else {
            text.value = verdict.text.trim();
          }
          sync();
          report.createDiv({ cls: "wikilm-report-line wikilm-report-ok", text: "✓ revision applied below — Save to keep it" });
        }
      } catch (e) {
        pending.remove();
        report.createDiv({ cls: "wikilm-report-line wikilm-report-fail", text: describeError(e) });
      } finally {
        btn.disabled = false;
      }
    };

    const save = async () => {
      const ask = instruction.value.trim();
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
        new Notice("Recall: empty card discarded.");
        c.status = "deleted";
      } else if (JSON.stringify([c.kind, c.front, c.back, c.text, c.extra]) !== before) {
        c.edited = true;
        edited = true;
        // Same reasoning as rewrite(): a manual edit invalidates whatever the
        // linter/critique recorded about the previous wording, and lifts a
        // flagged card back to pending so it can be exported again.
        if (c.status === "flagged") c.status = "pending";
        delete c.lintFailures;
        delete c.lintWarnings;
        delete c.critiqueReason;
      }
      this.editing = null;
      if (edited) {
        // What the reader typed, as one revision. Recorded before the
        // instruction runs, and with the saved text as its `after`, so a hand
        // edit followed by "now shorten it" is two corrections in the history
        // rather than one blurred into the other — `rewrite()` records its own
        // pass from the text this one left behind.
        this.plugin.store.recordRevision({
          cardId: c.id,
          at: new Date().toISOString(),
          via: "edit",
          instruction: "",
          before: was,
          after: snapshot(c),
        });
      }
      this.plugin.store.touch();
      // The instruction runs against the just-saved text, so a hand edit and a
      // "now shorten it" land in one pass rather than fighting each other.
      if (ask && c.status !== "deleted") await this.rewrite(h, c, ask);
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

  /** True when the pipeline recorded something for this card worth fixing. */
  private lintNotes(c: Card): boolean {
    return (c.lintFailures?.length ?? 0) > 0 || !!c.critiqueReason;
  }

  /**
   * What the one-click fix button says it will do. The instruction itself is
   * a paragraph now, which is right for the model and far too long for a
   * tooltip, so this names the defects with the badge labels the reader is
   * already looking at and lets the critique's own sentence speak for itself.
   */
  private fixTooltip(c: Card): string {
    const labels = (c.lintFailures ?? []).map((id) => LINT_LABELS[id]);
    const what = labels.length ? labels.join(", ") : "the critique's note";
    return c.critiqueReason ? `Fix in one click — ${what}. ${c.critiqueReason.trim()}` : `Fix in one click — ${what}.`;
  }

  /**
   * The instruction handed to the rewrite path. Each failure contributes the
   * sentence from LINT_FIX_INSTRUCTIONS saying what would count as fixed —
   * the badge labels in LINT_LABELS are fragments written for a glance, and
   * as an instruction they left the model guessing. The critique reason is
   * appended last because it is already a full sentence about this card.
   */
  private lintInstruction(c: Card): string {
    const parts = (c.lintFailures ?? []).map((id) => LINT_FIX_INSTRUCTIONS[id]);
    if (c.critiqueReason) parts.push(c.critiqueReason.trim().replace(/\.$/, ""));
    // "Keep what is right" matters because the failures name only the defect:
    // told just to fix the grounding, a rewrite will happily also re-open a
    // question the reader already narrowed, or switch a card back to qa.
    return `Fix these problems, changing nothing else that already works: ${parts.join("; ")}.`;
  }

  private async rewrite(h: Highlight, c: Card, preset?: string): Promise<void> {
    const instruction = preset ?? (await askInstruction(this.plugin.app, "Rewrite card", "e.g. make the answer shorter, ask about the date instead"));
    if (!instruction) return;
    const notice = new Notice("Recall: rewriting…", 0);
    const was = snapshot(c);
    try {
      const d = await this.plugin.llm.rewriteCard({ ...h, text: plainText(h.text) }, c, instruction);
      c.kind = d.kind;
      c.front = d.kind === "qa" ? d.front.trim() : "";
      c.back = d.kind === "qa" ? d.back.trim() : "";
      c.text = d.kind === "cloze" ? d.text.trim() : "";
      c.edited = true;
      // The recorded lint failures and critique reason described the previous
      // wording, so they are stale once the card has been rewritten. Clearing
      // them also lifts a flagged card back to pending, which is the point of
      // the fix action; the linter runs again on the next generation pass.
      if (c.status === "flagged") c.status = "pending";
      delete c.lintFailures;
      delete c.lintWarnings;
      delete c.critiqueReason;
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
      new Notice(`Recall: ${describeError(e)}`);
    } finally {
      notice.hide();
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
        new Notice(`Recall: ${n} new card rule suggestion${n === 1 ? "" : "s"}. See the inbox header.`);
        this.render();
      }
    } catch (e) {
      // Learning is a nicety on top of an edit that already succeeded; a
      // failure here must not look to the reader like the edit failed.
      console.error("Recall: could not write a schema suggestion", e);
    }
  }

  private async exportHighlights(list: Highlight[]): Promise<void> {
    await this.plugin.exportHighlights(list);
  }

  private async sendToSpacedRepetition(list: Highlight[]): Promise<void> {
    await this.plugin.exportToSpacedRepetition(list);
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
        console.error("Recall: could not re-locate the highlight", e);
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
    // keeps the cursor on what the reader can actually see; expanding the
    // group brings them straight back into the sequence.
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
    // Quiz mode hides every card, so j/k/x/e/Enter would act on nothing the
    // reader can see, and Enter belongs to the quiz textarea.
    if (this.mode === "quiz") return;
    if (this.editing) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
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
        if (found && (found.card.status === "pending" || found.card.status === "flagged")) {
          e.preventDefault();
          this.deleteCard(found.highlight, found.card);
        }
        break;
      case "e":
        if (found && (found.card.status === "pending" || found.card.status === "flagged")) {
          e.preventDefault();
          this.editing = found.card.id;
          this.render();
        }
        break;
      case "Enter":
        if (found) {
          e.preventDefault();
          void this.exportHighlights([found.highlight]);
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
