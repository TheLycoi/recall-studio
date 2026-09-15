import { ItemView, MarkdownView, Menu, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type WikiLmPlugin from "./main";
import {
  WIKILM_ADD_ICON,
  WIKILM_CHEVRON_DOWN_ICON,
  WIKILM_CHEVRON_RIGHT_ICON,
  WIKILM_CLOZE_ICON,
  WIKILM_DISCARD_ICON,
  WIKILM_EDIT_ICON,
  WIKILM_FILE_ICON,
  WIKILM_FIX_ICON,
  WIKILM_ICON,
  WIKILM_MORE_ICON,
  WIKILM_QA_ICON,
  WIKILM_RETRY_ICON,
  WIKILM_SEND_ICON,
  WIKILM_SPARK_ICON,
  WIKILM_STACK_ICON,
} from "./icon";
import { isPdfHighlight, liveCards, makeCard, pendingCards, type Card, type Highlight } from "./model";
import { askInstruction } from "./modals";
import { countClozes, fmtDate, locateQuote, splitFrontmatter } from "./util";
import { describeError } from "./llm";
import { findCrossInterference, LINT_LABELS } from "./lint";
import { ChatPanel } from "./chatPanel";

export const VIEW_TYPE_INBOX = "wikilm-notebook";

type Filter = "review" | "all" | "exported";

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
  /** Which half of the sidebar is showing. Persisted in `settings.sidebarMode`. */
  private mode: "inbox" | "chat" = "inbox";
  /**
   * Scratch state for one render, never persisted: card id -> ids of cards in
   * OTHER highlights that would collide with it in Anki, plus card id -> the
   * highlight it belongs to so the tooltip can name the partner's source.
   * Rebuilt every render, so binning one partner clears the other's badge.
   */
  private crossInterference = new Map<string, string[]>();
  private cardOwner = new Map<string, Highlight>();
  private chat!: ChatPanel;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: WikiLmPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_INBOX;
  }
  getDisplayText(): string {
    return "WikiLM inbox";
  }
  getIcon(): string {
    return WIKILM_ICON;
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("wikilm-notebook");
    this.contentEl.tabIndex = 0;
    this.mode = this.plugin.settings.sidebarMode;
    this.chat = new ChatPanel(this.plugin, this);
    this.registerDomEvent(this.contentEl, "keydown", (e) => this.onKey(e));
    this.unsubscribe = this.plugin.store.onChange(() => this.scheduleRender());
    this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.chat?.dispose();
  }

  /** Switch halves, remember the choice, redraw. Called by `openChat()` in main.ts. */
  async setMode(mode: "inbox" | "chat"): Promise<void> {
    if (this.mode !== mode) {
      this.mode = mode;
      this.plugin.settings.sidebarMode = mode;
      await this.plugin.saveSettings();
    }
    this.render();
  }

  private scheduleRender() {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    window.requestAnimationFrame(() => {
      this.renderScheduled = false;
      this.render();
    });
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
    root.empty();
    root.toggleClass("is-chat", this.mode === "chat");

    this.renderTabs(root);
    this.renderHeader(root);

    if (this.mode === "chat") {
      this.chat.render(root);
      return;
    }

    this.rebuildCrossInterference();

    const hs = this.visibleHighlights();
    if (hs.length === 0) {
      const empty = root.createDiv({ cls: "wikilm-empty" });
      empty.createEl("p", { text: this.filter === "review" ? "Nothing to review." : "Nothing here." });
      empty.createEl("p", {
                cls: "wikilm-muted",
        text: "Turn on highlighter mode (ribbon pen) and drag across a passage in a note or PDF, or select text and run “WikiLM: Send selection to inbox”. Cards are written in the background and show up here.",
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

  /** The Inbox | Chat switch, in its own row above the header so it sits in the same place in both modes. */
  private renderTabs(root: HTMLElement): void {
    const row = root.createDiv({ cls: "wikilm-tabs-row" });
    const tabs = row.createDiv({ cls: "wikilm-tabs" });
    for (const [m, label] of [
      ["inbox", "Inbox"],
      ["chat", "Chat"],
    ] as const) {
      const active = this.mode === m;
      const tab = tabs.createEl("button", { cls: `wikilm-tab${active ? " is-active" : ""}`, text: label });
      tab.setAttribute("aria-pressed", String(active));
      tab.addEventListener("click", () => void this.setMode(m));
    }
  }

  private renderHeader(root: HTMLElement): void {
    const counts = this.plugin.store.counts();
    const chat = this.mode === "chat";
    const header = root.createDiv({ cls: "wikilm-header" });
    const left = header.createDiv({ cls: "wikilm-header-left" });
    left.createEl("h2", { text: chat ? "Ask" : "Inbox" });
    const stats = left.createDiv({ cls: "wikilm-stats" });
    const stat = (label: string, n: number, cls = "") => {
      const s = stats.createSpan({ cls: `wikilm-stat ${cls}` });
      s.createSpan({ cls: "wikilm-stat-n", text: String(n) });
      s.createSpan({ text: ` ${label}` });
      return s;
    };
    if (!chat) {
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
    }

    const right = header.createDiv({ cls: "wikilm-header-right" });

    if (chat) return;

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
    setIcon(deckBtn.createSpan(), WIKILM_STACK_ICON);
    deckBtn.createSpan({ text: this.plugin.settings.defaultDeck });
    deckBtn.title = "Change the target deck";
    deckBtn.addEventListener("click", async () => {
      const d = await this.plugin.chooseDeck();
      if (d) {
        this.plugin.settings.defaultDeck = d;
        await this.plugin.saveSettings();
        this.render();
      }
    });

    const exportAll = right.createEl("button", { cls: "mod-cta", text: "Export all reviewed" });
    exportAll.title = "Send every pending card in the inbox to Anki (⌘⏎)";
    exportAll.addEventListener("click", () => void this.exportHighlights(this.visibleHighlights()));

    const more = right.createEl("button", { cls: "clickable-icon wikilm-icon-btn" });
    setIcon(more, WIKILM_MORE_ICON);
    more.addEventListener("click", (evt) => {
      const menu = new Menu();
      menu.addItem((i) =>
        i
          .setTitle("Retry failed highlights")
          .setIcon(WIKILM_RETRY_ICON)
          .onClick(() => {
            for (const h of this.plugin.store.all()) if (h.status === "error") this.plugin.generator.enqueue(h);
          }),
      );
      menu.addItem((i) =>
        i
          .setTitle("Export reviewed as Anki text file")
          .setIcon(WIKILM_FILE_ICON)
          .onClick(() => void this.plugin.exportAsTextFile(this.visibleHighlights())),
      );
      menu.addItem((i) =>
        i
          .setTitle("Clear exported and dismissed")
          .setIcon(WIKILM_DISCARD_ICON)
          .onClick(() => {
            const n = this.plugin.store.clearExported();
            new Notice(`WikiLM: cleared ${n}.`);
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

  private renderSource(root: HTMLElement, path: string, list: Highlight[]): void {
    const section = root.createDiv({ cls: "wikilm-source" });
    const head = section.createDiv({ cls: "wikilm-source-head" });
    const toggle = head.createSpan({ cls: "wikilm-collapse" });
    setIcon(toggle, this.collapsed.has(path) ? WIKILM_CHEVRON_RIGHT_ICON : WIKILM_CHEVRON_DOWN_ICON);
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
    quote.setText(h.text);
    quote.title = "Open in the note";
    quote.addEventListener("click", () => void this.openSource(h));

    const where = left.createDiv({ cls: "wikilm-hl-where wikilm-muted" });
    where.setText(
      [
        isPdfHighlight(h) ? "PDF" : h.heading ? `§ ${h.heading}` : null,
        h.page ? `page ${h.page}` : `line ${h.line + 1}`,
        h.origin === "highlighter" ? "highlighter" : h.origin === "ai" ? "AI pick" : h.origin === "quiz" ? "quiz miss" : null,
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
      iconBtn(WIKILM_SEND_ICON, "Export this highlight's cards to Anki (Enter)", () => void this.exportHighlights([h]));
    }
    if (h.status === "error") iconBtn(WIKILM_RETRY_ICON, "Retry", () => this.plugin.generator.enqueue(h));
    if (h.status === "ready" || h.status === "exported") {
      iconBtn(WIKILM_SPARK_ICON, "Write more cards for this highlight", async () => {
        const inst = await askInstruction(this.plugin.app, "More cards", "Optional: what should the extra cards cover?");
        if (inst === null) return;
        if (inst) h.instruction = inst;
        this.plugin.generator.more(h);
      });
    }
    iconBtn(WIKILM_ADD_ICON, "Add a card by hand", () => {
      const c = makeCard(h.id, { kind: "qa", front: "", back: "" });
      h.cards.push(c);
      if (h.status === "exported") h.status = "ready";
      this.editing = c.id;
      this.plugin.store.touch();
    });
    if (h.status !== "dismissed") {
      iconBtn(WIKILM_DISCARD_ICON, "Dismiss highlight and its cards", () => {
        h.status = "dismissed";
        this.plugin.store.touch();
      });
    } else {
      iconBtn(WIKILM_DISCARD_ICON, "Delete permanently", () => this.plugin.store.remove(h.id));
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
      setIcon(toggle.createSpan(), expanded ? WIKILM_CHEVRON_DOWN_ICON : WIKILM_CHEVRON_RIGHT_ICON);
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
    top.createSpan({ cls: "wikilm-kind", text: c.kind === "qa" ? "Question" : `Cloze${countClozes(c.text) > 1 ? ` ×${countClozes(c.text)}` : ""}` });
    if (c.status === "exported") top.createSpan({ cls: "wikilm-badge wikilm-badge-exported", text: "in Anki" });
    if (c.status === "duplicate") top.createSpan({ cls: "wikilm-badge wikilm-badge-duplicate", text: "duplicate" });
    if (c.edited && c.status === "pending") top.createSpan({ cls: "wikilm-badge", text: "edited" });
    // Render what the pipeline actually recorded rather than recomputing it:
    // the stored lintFailures are the ones lintMode acted on, so a recomputed
    // check could disagree with the status the card is sitting in. Flagged
    // cards are included because they are exactly the ones whose reasons the
    // reader needs in order to decide.
    if (c.status === "pending" || c.status === "flagged") {
      for (const id of c.lintFailures ?? []) {
        const b = top.createSpan({ cls: "wikilm-badge wikilm-badge-warn", text: LINT_LABELS[id] });
        b.title = `Lint check failed: ${id}`;
      }
      for (const id of c.lintWarnings ?? []) {
        const b = top.createSpan({ cls: "wikilm-badge wikilm-badge-notice", text: LINT_LABELS[id] });
        b.title = `Interference risk: ${id}`;
      }
      const partners = this.crossInterference.get(c.id);
      if (partners) {
        const where = partners
          .map((id) => this.cardOwner.get(id))
          .filter((owner): owner is Highlight => owner !== undefined)
          .map((owner) => (owner.title ? `${owner.sourceTitle} \u2014 ${owner.title}` : owner.sourceTitle));
        const b = top.createSpan({ cls: "wikilm-badge wikilm-badge-notice", text: LINT_LABELS["cross-interference"] });
        b.title = where.length > 0 ? `Same answer as a card in: ${where.join("; ")}` : "Same answer as a card in another highlight";
      }
      if (c.bloom) {
        const b = top.createSpan({ cls: "wikilm-badge wikilm-badge-bloom", text: c.bloom });
        b.title = "Bloom level judged by the critique. 'remember' is right for a plain definition; a mechanism or reason turned into a what-is-it-called card is the case to watch for.";
      }
      if (c.critiqueReason) {
        const b = top.createSpan({ cls: "wikilm-badge wikilm-badge-critique", text: "critique" });
        b.title = c.critiqueReason;
      } else if (c.critiqueRan) {
        // Without this the reviewer cannot tell a card the critique read and
        // kept from one it never saw (pass off, skipped as trivial, or failed).
        const b = top.createSpan({ cls: "wikilm-badge wikilm-badge-checked", text: "checked" });
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
      if (this.lintNotes(c)) {
        btn(WIKILM_FIX_ICON, "Fix with linter notes", () => void this.rewrite(h, c, this.lintInstruction(c)));
      }
      btn(WIKILM_EDIT_ICON, "Edit (e)", () => {
        this.editing = this.editing === c.id ? null : c.id;
        this.render();
      });
      btn(WIKILM_SPARK_ICON, "Rewrite with an instruction", () => void this.rewrite(h, c));
      btn(c.kind === "qa" ? WIKILM_CLOZE_ICON : WIKILM_QA_ICON, c.kind === "qa" ? "Convert to cloze" : "Convert to Q&A", () =>
        void this.rewrite(h, c, c.kind === "qa" ? "Convert this Q&A card into a cloze card." : "Convert this cloze card into a question and answer card."),
      );
      btn(WIKILM_DISCARD_ICON, "Delete (x)", () => this.deleteCard(h, c));
    } else if (c.status === "duplicate") {
      btn(WIKILM_DISCARD_ICON, "Remove", () => this.deleteCard(h, c));
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

    const sync = () => {
      const isQa = kindSel.value === "qa";
      front.toggle(isQa);
      back.toggle(isQa);
      text.toggle(!isQa);
    };
    kindSel.addEventListener("change", sync);
    sync();

    const save = () => {
      const before = JSON.stringify([c.kind, c.front, c.back, c.text, c.extra]);
      c.kind = kindSel.value as Card["kind"];
      c.front = front.value.trim();
      c.back = back.value.trim();
      c.text = text.value.trim();
      c.extra = extra.value.trim();
      const empty = c.kind === "qa" ? !c.front || !c.back : !c.text;
      if (empty) {
        new Notice("WikiLM: empty card discarded.");
        c.status = "deleted";
      } else if (JSON.stringify([c.kind, c.front, c.back, c.text, c.extra]) !== before) {
        c.edited = true;
        // Same reasoning as rewrite(): a manual edit invalidates whatever the
        // linter/critique recorded about the previous wording, and lifts a
        // flagged card back to pending so it can be exported again.
        if (c.status === "flagged") c.status = "pending";
        delete c.lintFailures;
        delete c.lintWarnings;
        delete c.critiqueReason;
      }
      this.editing = null;
      this.plugin.store.touch();
    };
    const cancel = () => {
      const empty = c.kind === "qa" ? !c.front || !c.back : !c.text;
      if (empty) c.status = "deleted";
      this.editing = null;
      this.plugin.store.touch();
    };
    for (const ta of [front, back, text, extra]) {
      ta.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          save();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      });
    }
    const btns = form.createDiv({ cls: "wikilm-editor-btns" });
    btns.createEl("button", { text: "Cancel" }).addEventListener("click", cancel);
    btns.createEl("button", { text: "Save", cls: "mod-cta" }).addEventListener("click", save);
    btns.createSpan({ cls: "wikilm-muted", text: "⌘⏎ save · esc cancel" });
    window.setTimeout(() => (c.kind === "qa" ? front : text).focus(), 10);
  }

  // ---------------------------------------------------------------- actions

  private deleteCard(h: Highlight, c: Card): void {
    c.status = "deleted";
    if (this.focusedCard === c.id) this.focusedCard = this.neighbourCardId(c.id);
    this.plugin.store.touch();
  }

  /** True when the pipeline recorded something for this card worth fixing. */
  private lintNotes(c: Card): boolean {
    return (c.lintFailures?.length ?? 0) > 0 || !!c.critiqueReason;
  }

  /**
   * The instruction handed to the rewrite path, e.g.
   * `Fix these problems: answer is longer than 12 words; the answer restates a
   * word in the question.` Failure labels come from LINT_LABELS so a renamed
   * id changes the wording here too, and the critique reason is appended last
   * because it is a full sentence while the labels are fragments.
   */
  private lintInstruction(c: Card): string {
    const parts = (c.lintFailures ?? []).map((id) => LINT_LABELS[id]);
    if (c.critiqueReason) parts.push(c.critiqueReason.trim().replace(/\.$/, ""));
    return `Fix these problems: ${parts.join("; ")}.`;
  }

  private async rewrite(h: Highlight, c: Card, preset?: string): Promise<void> {
    const instruction = preset ?? (await askInstruction(this.plugin.app, "Rewrite card", "e.g. make the answer shorter, ask about the date instead"));
    if (!instruction) return;
    const notice = new Notice("WikiLM: rewriting…", 0);
    try {
      const d = await this.plugin.llm.rewriteCard(h, c, instruction);
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
    } catch (e) {
      new Notice(`WikiLM: ${describeError(e)}`);
    } finally {
      notice.hide();
    }
  }

  private async exportHighlights(list: Highlight[]): Promise<void> {
    await this.plugin.exportHighlights(list);
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
        console.error("WikiLM: could not re-locate the highlight", e);
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
    // Chat mode hides every card, so j/k/x/e/Enter would act on nothing the
    // reader can see — and Enter belongs to the chat textarea.
    if (this.mode === "chat") return;
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
