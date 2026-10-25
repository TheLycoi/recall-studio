import { App, Modal, Setting, SuggestModal } from "obsidian";
import type { ExportSummary } from "./exportSummary";
import type { ExportItem } from "./cardActions";

/** Ask for a free-text instruction. Resolves null when cancelled. */
export class InstructionModal extends Modal {
  private value = "";
  private resolved = false;

  constructor(
    app: App,
    private title: string,
    private placeholder: string,
    private resolve: (v: string | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("wikilm-modal");
    contentEl.createEl("h3", { text: this.title });
    const ta = contentEl.createEl("textarea", { attr: { rows: "4", placeholder: this.placeholder } });
    ta.addClass("wikilm-modal-textarea");
    ta.addEventListener("input", () => (this.value = ta.value));
    ta.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        this.submit();
      }
    });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setCta()
          .setButtonText("Send")
          .onClick(() => this.submit()),
      );
    window.setTimeout(() => ta.focus(), 20);
  }

  private submit() {
    this.resolved = true;
    this.resolve(this.value.trim());
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) this.resolve(null);
  }
}

export function askInstruction(app: App, title: string, placeholder: string): Promise<string | null> {
  return new Promise((resolve) => new InstructionModal(app, title, placeholder, resolve).open());
}

/** Closing the warning is cancellation; only the explicit button accepts. */
export class ExportWarningModal extends Modal {
  private resolved = false;
  constructor(app: App, private summary: ExportSummary, private items: ExportItem[], private resolve: (accepted: boolean) => void) { super(app); }
  onOpen(): void {
    this.contentEl.createEl("h3", { text: "Review export warnings" });
    this.contentEl.createEl("p", { text: `${this.summary.notes} notes / ${this.summary.tasks} reviews selected. ${this.summary.warnings.length} notes need your review. Exporting does not mark them verified.` });
    for (const warning of this.summary.warnings) {
      const card = this.items.find(item => item.card.id === warning.cardId)!.card;
      const box = this.contentEl.createDiv();
      box.createEl("h4", { text: warning.source || "Captured source" });
      box.createEl("p", { text: card.kind === "qa" ? `${card.front} Answer: ${card.back}` : card.text });
      const list = box.createEl("ul");
      for (const reason of warning.reasons) list.createEl("li", { text: reason });
    }
    new Setting(this.contentEl)
      .addButton(b => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton(b => b.setButtonText("Export despite warnings").onClick(() => {
        this.resolved = true; this.resolve(true); this.close();
      }));
  }
  onClose(): void { this.contentEl.empty(); if (!this.resolved) this.resolve(false); }
}
export function confirmExport(app: App, summary: ExportSummary, items: ExportItem[]): Promise<boolean> {
  return new Promise(resolve => new ExportWarningModal(app, structuredClone(summary), structuredClone(items), resolve).open());
}

/** Pick an Anki deck; typing a new name creates it on export. */
export class DeckSuggestModal extends SuggestModal<string> {
  private resolved = false;

  constructor(
    app: App,
    private decks: string[],
    private resolve: (v: string | null) => void,
  ) {
    super(app);
    this.setPlaceholder("Deck name (type a new one to create it)");
  }

  getSuggestions(query: string): string[] {
    const q = query.toLowerCase();
    const hits = this.decks.filter((d) => d.toLowerCase().includes(q));
    if (query && !this.decks.includes(query)) hits.unshift(query);
    return hits;
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value);
    if (!this.decks.includes(value)) el.createSpan({ text: "  (new deck)", cls: "wikilm-muted" });
  }

  onChooseSuggestion(item: string): void {
    this.resolved = true;
    this.resolve(item);
  }

  /**
   * Obsidian's `selectSuggestion` closes the modal *before* it calls
   * `onChooseSuggestion`, so at this point a real pick still looks like a
   * dismissal: `resolved` is false and resolving null here would settle the
   * promise first, making the later `resolve(item)` a no-op and handing the
   * caller null for a deck the reader did choose. Deferring one microtask
   * lets onChooseSuggestion set `resolved` before the cancel path reads it;
   * a genuine dismissal has no such callback and still resolves null.
   */
  onClose(): void {
    super.onClose();
    queueMicrotask(() => {
      if (!this.resolved) this.resolve(null);
    });
  }
}

export function pickDeck(app: App, decks: string[]): Promise<string | null> {
  return new Promise((resolve) => new DeckSuggestModal(app, decks, resolve).open());
}
