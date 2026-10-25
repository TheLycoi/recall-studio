import { App, ButtonComponent, Modal, Notice, Setting, SuggestModal, TFile } from "obsidian";
import { describeError } from "./llm";
import type { Proposal } from "./schemaNote";
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

/**
 * The proposals waiting in `recall-suggestions.md`, one decision each.
 *
 * Nothing here writes until a button is pressed, and the two buttons are the
 * only writes there are: Accept appends the rule under `## Learned` in the
 * schema note, Dismiss marks the proposal answered and silences the pattern
 * for a month. Opening this modal, reading it and closing it leaves both files
 * exactly as they were.
 *
 * The rule is a text input rather than a line of prose because the wording
 * matters: it goes to the model verbatim on every call from then on, and the
 * reader is the one who knows whether "six words" should have been "eight".
 * The evidence is listed under it so the rule is a claim they can check
 * against the edits that produced it.
 */
export class SchemaSuggestionsModal extends Modal {
  private opened = false;
  constructor(
    app: App,
    private schema: SchemaFileLike,
    private onChange?: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.opened = true;
    const { contentEl } = this;
    contentEl.addClass("wikilm-modal");
    contentEl.createEl("h3", { text: "Card rule suggestions" });
    void this.renderList().catch(e => new Notice(`Recall Studio: Could not load suggestions. ${describeError(e)}`));
  }

  onClose(): void {
    this.opened = false;
    this.contentEl.empty();
  }

  /** Read once; successful decisions remove only their own row, preserving every other draft. */
  private async renderList(): Promise<void> {
    const open = (await this.schema.proposals()).filter((p) => p.status === "open");
    if (!this.opened) return;
    const { contentEl } = this;
    const old = contentEl.querySelector(".wikilm-schema-list");
    old?.remove();
    const list = contentEl.createDiv({ cls: "wikilm-schema-list" });

    this.onChange?.();

    const link = list.createEl("p", { cls: "wikilm-muted" });
    const a = link.createEl("a", { text: "Open the card rules note", href: "#" });
    a.addEventListener("click", (e) => {
      e.preventDefault();
      this.close();
      void this.openSchemaNote();
    });

    if (open.length === 0) {
      list.createEl("p", {
        text: "No suggestions yet. Recall Studio proposes a rule once it sees the same correction three or four times.",
      });
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    for (const p of open) {
      const box = list.createDiv({ cls: "wikilm-schema-proposal" });
      box.createEl("h4", { text: p.summary });

      const input = box.createEl("input", { type: "text", cls: "wikilm-schema-rule" });
      input.value = p.rule;
      input.placeholder = "The rule as it will be written into the card rules note";

      if (p.evidence.length) {
        box.createEl("p", { cls: "wikilm-muted", text: `From ${p.count} edit${p.count === 1 ? "" : "s"}:` });
        const ul = box.createEl("ul", { cls: "wikilm-schema-evidence" });
        for (const e of p.evidence) ul.createEl("li", { text: e });
      }

      const row = new Setting(box);
      let accept: ButtonComponent | null = null;
      let dismiss: ButtonComponent | null = null;
      let busy = false;
      const sync = () => {
        accept?.setDisabled(busy || input.value.trim() === "");
        dismiss?.setDisabled(busy);
      };
      const decide = async (action: "accept" | "dismiss") => {
        if (busy) return;
        busy = true;
        sync();
        try {
          const id = p.occurrenceId ?? p.id;
          if (action === "accept") await this.schema.accept(id, input.value.trim(), today);
          else await this.schema.dismiss(id, today);
          if (!this.opened) return;
          box.remove();
          this.onChange?.();
          if (!list.querySelector(".wikilm-schema-proposal")) {
            list.createEl("p", { text: "No suggestions waiting." });
          }
        } catch (e) {
          new Notice(`Recall Studio: Could not ${action} this suggestion. ${describeError(e)}`);
        } finally {
          busy = false;
          sync();
        }
      };
      row.addButton((b) => {
        accept = b;
        return b
          .setCta()
          .setButtonText("Accept")
          .setTooltip("Write this rule into the card rules note's Learned section")
          .onClick(() => { void decide("accept"); });
      });
      row.addButton((b) => {
        dismiss = b;
        return b
          .setButtonText("Dismiss")
          .setTooltip("Not a rule you want. Recall Studio stays quiet about this pattern for a month.")
          .onClick(() => { void decide("dismiss"); });
      });
      // An empty rule would append a bullet with no rule in it, so Accept is
      // only live while there is something to write.
      input.addEventListener("input", sync);
      sync();
    }
  }

  private async openSchemaNote(): Promise<void> {
    try {
      const file = await this.schema.ensure();
      await this.app.workspace.getLeaf(false).openFile(file);
    } catch (e) {
      new Notice(`Recall Studio: ${describeError(e)}`);
    }
  }
}

/**
 * What the modal needs of `SchemaFile` (src/schemaFile.ts), named structurally
 * rather than imported: modals.ts is reached from the commands and the
 * inbox, and importing the class would pull the plugin's whole graph in behind
 * it for the sake of four methods.
 */
export interface SchemaFileLike {
  proposals(): Promise<SchemaProposal[]>;
  accept(id: string, rule: string, today: string): Promise<void>;
  dismiss(id: string, today: string): Promise<void>;
  ensure(): Promise<TFile>;
}

type SchemaProposal = Pick<Proposal, "id" | "occurrenceId" | "status" | "summary" | "rule" | "evidence" | "count">;
