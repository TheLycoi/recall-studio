import { App, ButtonComponent, Component, FuzzySuggestModal, MarkdownRenderer, Modal, Notice, Setting, SuggestModal, TFile, TFolder } from "obsidian";
import type { TranscriptRecord } from "./model";
import { orderTranscriptFiles, transcriptRecord } from "./util";
import type { PreparedNote } from "./topicNote";
import { rowLabel } from "./topicNote";
import type { ManifestHighlight } from "./manifest";
import type { FixPage, LinkFix } from "./vaultFix";
import { applyDuplicateVerdicts, orderFixes, type DuplicateVerdicts, type Fix, type FixKind } from "./fixPlan";
import { describeError } from "./llm";

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

export type TranscriptChoice =
  | { action: "save"; text: string; origin: "pasted" | "file"; sourceFile: string | null }
  | { action: "clear" };

/** Pick a transcript file from the vault (md, txt, vtt, srt). */
class TranscriptFileSuggestModal extends FuzzySuggestModal<TFile> {
  private resolved = false;

  constructor(
    app: App,
    private folder: string,
    private resolve: (v: TFile | null) => void,
  ) {
    super(app);
    this.setPlaceholder(folder ? `Transcript file — ${folder} first, newest on top` : "Transcript file (md, txt, vtt, srt)");
  }

  getItems(): TFile[] {
    const exts = new Set(["md", "txt", "vtt", "srt"]);
    const files = this.app.vault.getFiles().filter((f) => exts.has(f.extension.toLowerCase()));
    // The lecture you just exported is the one you want: the transcript
    // folder comes first, newest first, and the rest of the vault after.
    const order = orderTranscriptFiles(
      files.map((f) => ({ path: f.path, mtime: f.stat.mtime, file: f })), // obsidian.d.ts:7332 (stat)
      this.folder,
    );
    return order.map((o) => o.file);
  }

  getItemText(item: TFile): string {
    return item.path;
  }

  onChooseItem(item: TFile): void {
    this.resolved = true;
    this.resolve(item);
  }

  /** Same close-before-choose ordering as DeckSuggestModal.onClose above. */
  onClose(): void {
    super.onClose();
    queueMicrotask(() => {
      if (!this.resolved) this.resolve(null);
    });
  }
}

/** Attach, replace, or clear the transcript used for document-wide AI highlighting. */
export class TranscriptModal extends Modal {
  private value: string;
  private origin: "pasted" | "file";
  private sourceFile: string | null;
  private resolved = false;
  private ta!: HTMLTextAreaElement;

  constructor(
    app: App,
    private current: TranscriptRecord | undefined,
    private folder: string,
    private resolve: (v: TranscriptChoice | null) => void,
  ) {
    super(app);
    this.value = current?.text ?? "";
    this.origin = current?.origin ?? "pasted";
    this.sourceFile = current?.sourceFile ?? null;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("wikilm-modal");
    contentEl.createEl("h3", { text: "Transcript for document highlighting" });

    if (this.current) {
      const c = this.current;
      const from = c.origin === "file" ? `from ${c.sourceFile}` : "pasted";
      const cut = c.truncated ? ", cut to the size limit" : "";
      contentEl.createEl("p", {
        text: `Current: ${from}, ${c.text.length.toLocaleString()} characters, added ${c.addedAt}${cut}`,
        cls: "wikilm-muted",
      });
    } else {
      contentEl.createEl("p", {
        text: "No transcript attached. Paste one below or choose a file.",
        cls: "wikilm-muted",
      });
    }

    const ta = contentEl.createEl("textarea", {
      attr: { rows: "10", placeholder: "Paste the lecture transcript here…" },
    });
    ta.addClass("wikilm-modal-textarea");
    ta.value = this.value;
    this.ta = ta;
    ta.addEventListener("input", () => {
      this.value = ta.value;
      this.origin = "pasted";
      this.sourceFile = null;
    });
    ta.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        this.submit();
      }
    });

    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Choose a file from the vault…").onClick(() => {
        new TranscriptFileSuggestModal(this.app, this.folder, async (file) => {
          if (!file) return;
          const text = await this.app.vault.cachedRead(file);
          this.value = text;
          this.origin = "file";
          this.sourceFile = file.path;
          this.ta.value = text;
        }).open();
      }),
    );

    const buttons = new Setting(contentEl).addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
    if (this.current) {
      buttons.addButton((b) =>
        b.setButtonText("Clear").onClick(() => {
          this.resolved = true;
          this.resolve({ action: "clear" });
          this.close();
        }),
      );
    }
    buttons.addButton((b) =>
      b
        .setCta()
        .setButtonText("Save")
        .onClick(() => this.submit()),
    );

    window.setTimeout(() => ta.focus(), 20);
  }

  private submit() {
    const text = this.value.trim();
    if (!text) {
      new Notice("WikiLM: paste a transcript or choose a file first.");
      return;
    }
    this.resolved = true;
    this.resolve({ action: "save", text, origin: this.origin, sourceFile: this.sourceFile });
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) this.resolve(null);
  }
}

export function askTranscript(app: App, current: TranscriptRecord | undefined, folder = ""): Promise<TranscriptChoice | null> {
  return new Promise((resolve) => new TranscriptModal(app, current, folder, resolve).open());
}

/** What AI highlight on a note produces: inbox cards, or passages filed into wiki pages. */
export type HighlightProduct = "cards" | "wiki";

/** What the reader did to the file's guide in the modal; applied by the caller on Run, never on Cancel. */
export type GuideChange = { action: "keep" } | { action: "set"; record: TranscriptRecord } | { action: "clear" };

export interface HighlightOptionsArgs {
  /** Shown in the heading. */
  fileName: string;
  /** A PDF has one product (wiki notes behind the preview), so it gets no product choice. */
  kind: "note" | "pdf";
  /** The instruction remembered for this file, "" when none. */
  instruction: string;
  /** The guide stored for this file, if any. */
  guide: TranscriptRecord | undefined;
  transcriptFolder: string;
  transcriptMaxChars: number;
}

export interface HighlightOptions {
  instruction: string;
  product: HighlightProduct;
  guide: GuideChange;
}

/**
 * The one form behind "AI highlight…": what to look for, the guide that says
 * what the class cared about, and (for a note) what to make. It replaced four
 * commands (AI-highlight with and without instructions, the PDF highlighter,
 * and Add transcript), so everything those asked for separately is on one
 * screen and the reader sees which guide will be used before anything runs.
 *
 * The modal touches nothing: a guide picked or cleared here is handed back as
 * a change, so Cancel leaves the stored guide exactly as it was.
 */
export class HighlightOptionsModal extends Modal {
  private instruction: string;
  private product: HighlightProduct = "cards";
  private guide: TranscriptRecord | undefined;
  private change: GuideChange = { action: "keep" };
  private resolved = false;
  private guideRow!: Setting;
  private clearButton: ButtonComponent | null = null;

  constructor(
    app: App,
    private args: HighlightOptionsArgs,
    private resolve: (v: HighlightOptions | null) => void,
  ) {
    super(app);
    this.instruction = args.instruction;
    this.guide = args.guide;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("wikilm-modal");
    contentEl.createEl("h3", { text: `AI highlight: ${this.args.fileName}` });

    new Setting(contentEl).setName("Instructions").setDesc("What to look for. Remembered for this file.");
    const ta = contentEl.createEl("textarea", {
      attr: { rows: "3", placeholder: "e.g. only the definitions and the numbers in the Results section" },
    });
    ta.addClass("wikilm-modal-textarea");
    ta.value = this.instruction;
    ta.addEventListener("input", () => (this.instruction = ta.value));
    ta.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        this.submit();
      }
    });

    this.guideRow = new Setting(contentEl)
      .setName("Guide")
      .addButton((b) => b.setButtonText("Pick a note…").onClick(() => this.pickGuide()))
      .addButton((b) => b.setButtonText("Paste…").onClick(() => this.pasteGuide()))
      .addButton((b) => {
        this.clearButton = b;
        b.setButtonText("Clear").onClick(() => this.setGuide(undefined, { action: "clear" }));
      });
    this.renderGuide();

    if (this.args.kind === "note") {
      const row = new Setting(contentEl).setName("Make").setDesc("Cards go to the inbox; wiki notes are filed into pages behind a preview.");
      const group = `wikilm-highlight-product-${Date.now()}`;
      const labels: Record<HighlightProduct, string> = { cards: "Cards", wiki: "Wiki notes" };
      for (const value of Object.keys(labels) as HighlightProduct[]) {
        const label = row.controlEl.createEl("label", { cls: "wikilm-radio" });
        const input = label.createEl("input", { attr: { type: "radio", name: group, value } });
        input.checked = this.product === value;
        input.addEventListener("change", () => {
          if (input.checked) this.product = value;
        });
        label.appendText(` ${labels[value]} `);
      }
    }

    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setCta()
          .setButtonText("Run")
          .onClick(() => this.submit()),
      );

    window.setTimeout(() => ta.focus(), 20);
  }

  /** The guide row's description: where the guide came from and how big it is, or that there is none. */
  private renderGuide(): void {
    const g = this.guide;
    if (!g) {
      this.guideRow.setDesc("None. A study guide or lecture transcript tells the highlighter what the class cared about.");
    } else {
      const from = g.origin === "file" ? `from ${g.sourceFile}` : "pasted";
      const cut = g.truncated ? ", cut to the size limit" : "";
      this.guideRow.setDesc(`${from}, ${g.text.length.toLocaleString()} characters${cut}`);
    }
    this.clearButton?.setDisabled(!g);
  }

  private setGuide(record: TranscriptRecord | undefined, change: GuideChange): void {
    this.guide = record;
    this.change = change;
    this.renderGuide();
  }

  /** Save a picked or pasted guide the way "Add transcript" did: cleaned, then cut to the size limit. */
  private saveGuide(text: string, origin: TranscriptRecord["origin"], sourceFile: string | null): void {
    if (!text.trim()) {
      new Notice("WikiLM: that guide is empty.");
      return;
    }
    const record = transcriptRecord({ text, origin, sourceFile }, this.args.transcriptMaxChars, new Date().toISOString());
    this.setGuide(record, { action: "set", record });
  }

  private pickGuide(): void {
    new TranscriptFileSuggestModal(this.app, this.args.transcriptFolder, async (file) => {
      if (!file) return;
      this.saveGuide(await this.app.vault.cachedRead(file), "file", file.path);
    }).open();
  }

  /** The transcript editor the chat also uses, opened on the guide as it stands in this form. */
  private pasteGuide(): void {
    void askTranscript(this.app, this.guide, this.args.transcriptFolder).then((choice) => {
      if (choice === null) return;
      if (choice.action === "clear") this.setGuide(undefined, { action: "clear" });
      else this.saveGuide(choice.text, choice.origin, choice.sourceFile);
    });
  }

  private submit() {
    this.resolved = true;
    this.resolve({
      instruction: this.instruction.trim(),
      // A PDF has no choice to make: its highlights become wiki notes.
      product: this.args.kind === "pdf" ? "wiki" : this.product,
      guide: this.change,
    });
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) this.resolve(null);
  }
}

export function askHighlightOptions(app: App, args: HighlightOptionsArgs): Promise<HighlightOptions | null> {
  return new Promise((resolve) => new HighlightOptionsModal(app, args, resolve).open());
}

/** What a digest run should produce. */
export type DigestProduct = "notes" | "flashcards" | "both";

const DIGEST_PRODUCT_LABELS: Record<DigestProduct, string> = {
  notes: "Topic notes",
  flashcards: "Flashcards",
  both: "Both",
};

/** Choose the product of a digest run and an optional per-PDF instruction. */
export class DigestOptionsModal extends Modal {
  private product: DigestProduct;
  private instruction: string;
  private resolved = false;

  constructor(
    app: App,
    private defaults: { product: DigestProduct; instruction: string },
    private resolve: (v: { product: DigestProduct; instruction: string } | null) => void,
    private title = "Digest PDF highlights",
  ) {
    super(app);
    this.product = defaults.product;
    this.instruction = defaults.instruction;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("wikilm-modal");
    contentEl.createEl("h3", { text: this.title });

    new Setting(contentEl).setName("Produce").addDropdown((d) => {
      (Object.keys(DIGEST_PRODUCT_LABELS) as DigestProduct[]).forEach((key) =>
        d.addOption(key, DIGEST_PRODUCT_LABELS[key]),
      );
      d.setValue(this.product);
      d.onChange((v) => (this.product = v as DigestProduct));
    });

    const ta = contentEl.createEl("textarea", {
      attr: { rows: "3", placeholder: "e.g. split receptors and enzymes into separate notes" },
    });
    ta.addClass("wikilm-modal-textarea");
    ta.value = this.instruction;
    ta.addEventListener("input", () => (this.instruction = ta.value));
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
          .setButtonText("Continue")
          .onClick(() => this.submit()),
      );

    window.setTimeout(() => ta.focus(), 20);
  }

  private submit() {
    this.resolved = true;
    this.resolve({ product: this.product, instruction: this.instruction.trim() });
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) this.resolve(null);
  }
}

export function askDigestOptions(
  app: App,
  defaults: { product: DigestProduct; instruction: string },
  title = "Digest PDF highlights",
): Promise<{ product: DigestProduct; instruction: string } | null> {
  return new Promise((resolve) => new DigestOptionsModal(app, defaults, resolve, title).open());
}


/**
 * Preview the notes a digest run would write. Checkbox state defaults to
 * checked, except an existing note that would gain nothing (`exists && added
 * === 0`). Titles are editable inline; edits update the resolved note's
 * `title` (the caller re-derives `path` and re-checks existence before
 * writing — this modal never touches the vault).
 */
export class DigestPreviewModal extends Modal {
  private checked: boolean[];
  private titles: string[];
  private resolved = false;
  private writeBtn!: ButtonComponent;

  constructor(
    app: App,
    private notes: PreparedNote[],
    private extras: { flashcards: number; unknownIds: string[]; unassignedIds: string[] },
    private pdfBasename: string,
    private resolve: (v: PreparedNote[] | null) => void,
  ) {
    super(app);
    // A merge that adds no quote may still add prose — an article section
    // written into a page — and `sections` records where it went, so such a
    // row is ticked; a row that would change nothing is not.
    this.checked = notes.map((n) => !(n.exists && n.added === 0 && !(n.sections && n.sections.length)));
    this.titles = notes.map((n) => n.title);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("wikilm-modal");
    contentEl.addClass("wikilm-preview");
    contentEl.createEl("h3", { text: `Proposed topic notes for ${this.pdfBasename}` });

    const totalHighlights = this.notes.reduce((sum, n) => sum + n.highlights.length, 0);
    const alreadyPresent = this.notes.reduce((sum, n) => sum + (n.exists ? n.skipped : 0), 0);
    let countsText =
      `${this.notes.length} notes · ${totalHighlights} highlights · ${alreadyPresent} already present · ` +
      `${this.extras.unknownIds.length} unknown ids dropped · ${this.extras.unassignedIds.length} unassigned`;
    if (this.extras.flashcards > 0) countsText += ` · ${this.extras.flashcards} flashcards will be queued`;
    contentEl.createEl("p", { text: countsText, cls: "wikilm-muted wikilm-preview-counts" });

    const list = contentEl.createDiv();
    this.notes.forEach((note, i) => {
      const card = list.createDiv({ cls: "wikilm-preview-note" });
      const head = card.createDiv({ cls: "wikilm-preview-head" });

      const checkbox = head.createEl("input", { attr: { type: "checkbox" } }) as HTMLInputElement;
      checkbox.checked = this.checked[i];
      checkbox.addEventListener("change", () => {
        this.checked[i] = checkbox.checked;
        this.updateWriteButton();
      });

      const titleInput = head.createEl("input", { attr: { type: "text" } }) as HTMLInputElement;
      titleInput.addClass("wikilm-inline-input");
      titleInput.addClass("wikilm-preview-title");
      titleInput.value = note.title;
      // A page that already exists keeps its name: `applyDigestChoices`
      // (src/topicNote.ts) ignores an edit to an existing row's title, since
      // renaming the file is the vault's job and not the digest's. Saying so
      // in the box beats silently discarding what was typed into it.
      if (note.exists) {
        titleInput.readOnly = true;
        titleInput.title = "An existing page keeps its name";
      }
      titleInput.addEventListener("input", () => {
        this.titles[i] = titleInput.value;
      });

      // A merge and a filing both land in a page that exists; only the badge
      // tells them apart, and a page created fresh says what it is and why it
      // had to be one.
      const badgeText = note.exists
        ? `${note.routed?.length ? "filed" : "merge"}: +${note.added}, ${note.skipped} skipped${note.said ? `, ${note.said} already said` : ""}`
        : `new ${note.kind ?? "concept"}${note.said ? ` (${note.said} already said elsewhere)` : ""}${note.whyNew ? ` — ${note.whyNew}` : ""}`;
      head.createSpan({ text: badgeText, cls: "wikilm-badge wikilm-preview-badge" });

      card.createEl("div", { text: note.path, cls: "wikilm-muted" });
      card.createEl("p", { text: note.summary });

      const hlList = card.createEl("ul", { cls: "wikilm-preview-highlights" });
      note.highlights.forEach((h) => {
        const li = hlList.createEl("li");
        li.createEl("strong", { text: `p.${h.page} ` });
        const cut = h.text.length > 80 ? `${h.text.slice(0, 80)}…` : h.text;
        li.createSpan({ text: cut });
      });

      for (const r of note.routed ?? []) {
        card.createDiv({
          cls: "wikilm-muted wikilm-preview-routed",
          text: r.heading
            ? `Filed here as \u201C${r.heading}\u201D instead of a new note \u201C${r.from}\u201D \u2014 ${r.why}.`
            : `Filed here instead of a new note \u201C${r.from}\u201D \u2014 ${r.why}.`,
        });
      }

      if (note.related.length > 0) {
        card.createEl("div", { text: `Related: ${note.related.join(", ")}`, cls: "wikilm-muted" });
      }
    });

    const buttons = new Setting(contentEl).addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
    buttons.addButton((b) => {
      this.writeBtn = b;
      b.setCta().onClick(() => this.submit());
    });
    this.updateWriteButton();
  }

  private checkedCount(): number {
    return this.checked.filter(Boolean).length;
  }

  private updateWriteButton(): void {
    const n = this.checkedCount();
    this.writeBtn.setButtonText(`Write ${n} notes`);
    this.writeBtn.setDisabled(n === 0);
  }

  private submit() {
    if (this.checkedCount() === 0) return;
    this.resolved = true;
    const result = this.notes
      .map((note, i) => ({ ...note, title: this.titles[i] }))
      .filter((_, i) => this.checked[i]);
    this.resolve(result);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) this.resolve(null);
  }
}

export function previewDigest(
  app: App,
  notes: PreparedNote[],
  extras: { flashcards: number; unknownIds: string[]; unassignedIds: string[] },
  pdfBasename: string,
): Promise<PreparedNote[] | null> {
  return new Promise((resolve) => new DigestPreviewModal(app, notes, extras, pdfBasename, resolve).open());
}

export interface SuggestPreviewExtras {
  flashcards: number;
  unlocated: number;
  orphanTitles: string[];
  alreadyPresent: number;
  /** Proposed notes the planner filed into existing ones instead of creating. */
  routed: number;
  /** Spans left out because their page already states them in other words. */
  covered?: number;
}

export interface SuggestPreviewChoice {
  note: PreparedNote;
  title: string;
  highlights: ManifestHighlight[];
}

/**
 * Preview the highlights a suggestion run would write per note, with a
 * per-highlight checkbox (not per-note). Titles are editable inline; a note
 * with nothing checked is omitted from the resolved result.
 */
export class SuggestPreviewModal extends Modal {
  private checked: boolean[][];
  private titles: string[];
  private resolved = false;
  private writeBtn!: ButtonComponent;
  /** Routed groups the reader has taken back as notes of their own, as `<card index>|<proposed title>`. */
  private unrouted = new Set<string>();

  constructor(
    app: App,
    private notes: PreparedNote[],
    private extras: SuggestPreviewExtras,
    private pdfBasename: string,
    private resolve: (v: SuggestPreviewChoice[] | null) => void,
  ) {
    super(app);
    this.checked = notes.map((n) => n.highlights.map(() => true));
    this.titles = notes.map((n) => n.title);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("wikilm-modal");
    contentEl.addClass("wikilm-preview");
    contentEl.createEl("h3", { text: `Suggested highlights for ${this.pdfBasename}` });

    const totalSpans = this.notes.reduce((sum, n) => sum + n.highlights.length, 0);
    let countsText =
      `${this.notes.length} notes · ${totalSpans} spans · ${this.extras.alreadyPresent} already present · ` +
      `${this.extras.unlocated} could not be located`;
    if (this.extras.orphanTitles.length) {
      countsText += ` · unmatched titles: ${this.extras.orphanTitles.join(", ")}`;
    }
    if (this.extras.routed > 0) {
      countsText += ` · ${this.extras.routed} proposed note${this.extras.routed === 1 ? "" : "s"} filed into existing ones`;
    }
    if (this.extras.covered) countsText += ` · ${this.extras.covered} already said by the page`;
    if (this.extras.flashcards > 0) countsText += ` · ${this.extras.flashcards} flashcards will be queued`;
    contentEl.createEl("p", { text: countsText, cls: "wikilm-muted wikilm-preview-counts" });

    const list = contentEl.createDiv();
    this.notes.forEach((note, i) => {
      const card = list.createDiv({ cls: "wikilm-preview-note" });
      const head = card.createDiv({ cls: "wikilm-preview-head" });

      const titleInput = head.createEl("input", { attr: { type: "text" } }) as HTMLInputElement;
      titleInput.addClass("wikilm-inline-input");
      titleInput.addClass("wikilm-preview-title");
      titleInput.value = note.title;
      titleInput.addEventListener("input", () => {
        this.titles[i] = titleInput.value;
      });

      let badgeText: string;
      if (!note.exists) {
        const parent = note.path.slice(0, note.path.lastIndexOf("/"));
        const kind = parent.endsWith("entities") ? "entity" : "concept";
        badgeText = `new (${kind})`;
      } else {
        badgeText = `exists: +${note.added}, ${note.skipped} skipped${note.said ? `, ${note.said} already said` : ""}`;
      }
      head.createSpan({ text: badgeText, cls: "wikilm-badge wikilm-preview-badge" });

      card.createEl("div", { text: note.path, cls: "wikilm-muted" });
      if (note.summary) card.createEl("p", { text: note.summary });

      const hlList = card.createEl("ul", { cls: "wikilm-preview-highlights" });
      note.highlights.forEach((h, j) => {
        const li = hlList.createEl("li");
        const checkbox = li.createEl("input", { attr: { type: "checkbox" } }) as HTMLInputElement;
        checkbox.checked = this.checked[i][j];
        checkbox.addEventListener("change", () => {
          this.checked[i][j] = checkbox.checked;
          this.updateWriteButton();
        });
        // A row the model wrote a passage for previews as the page will print
        // it: the label, then the passage. A verbatim row previews its quote.
        const shown = h.verbatim === false && h.passage ? h.passage : h.text;
        li.createEl("strong", { text: `${h.label ? rowLabel(h) : `p.${h.page}`} ` });
        const cut = shown.length > 120 ? `${shown.slice(0, 120)}…` : shown;
        li.createSpan({ text: cut });
        // Where in the note this one lands, when it is going under a heading
        // rather than into the highlights: the reader is choosing per span,
        // and a span filed under the wrong subtopic is worth unticking.
        const section = note.sections?.find((s) => s.keys.includes(h.key));
        if (section) {
          li.createSpan({ cls: "wikilm-muted", text: ` → ${section.heading}${section.created ? " (new section)" : ""}` });
        }
      });

      // A proposed note the planner filed into this one, with the reason and
      // a way out: the policy is append-first, but the reader outranks it, and
      // taking a group back is one click rather than a re-run.
      for (const r of note.routed ?? []) {
        const row = card.createDiv({ cls: "wikilm-muted wikilm-preview-routed" });
        const id = `${i}|${r.from}`;
        const line = row.createSpan();
        const button = row.createEl("button", { cls: "wikilm-preview-routed-btn" });
        const draw = () => {
          const kept = this.unrouted.has(id);
          line.setText(
            kept
              ? `Will be its own note “${r.from}”. `
              : r.heading
                ? `Filed here as “${r.heading}” instead of a new note “${r.from}” — ${r.why}. `
                : `Filed here instead of a new note “${r.from}” — ${r.why}. `,
          );
          button.setText(kept ? "File here after all" : "Keep as its own note");
        };
        button.addEventListener("click", () => {
          if (this.unrouted.has(id)) this.unrouted.delete(id);
          else this.unrouted.add(id);
          draw();
        });
        draw();
      }
    });

    const buttons = new Setting(contentEl).addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
    buttons.addButton((b) => {
      this.writeBtn = b;
      b.setCta().onClick(() => this.submit());
    });
    this.updateWriteButton();
  }

  private counts(): { spans: number; notes: number } {
    let spans = 0;
    let notesWithAnySpan = 0;
    this.checked.forEach((row) => {
      const n = row.filter(Boolean).length;
      spans += n;
      if (n > 0) notesWithAnySpan += 1;
    });
    return { spans, notes: notesWithAnySpan };
  }

  private updateWriteButton(): void {
    const { spans, notes } = this.counts();
    this.writeBtn.setButtonText(`Write ${spans} spans into ${notes} notes`);
    this.writeBtn.setDisabled(spans === 0);
  }

  private submit() {
    const { spans } = this.counts();
    if (spans === 0) return;
    this.resolved = true;
    const result: SuggestPreviewChoice[] = [];
    this.notes.forEach((note, i) => {
      const checked = note.highlights.filter((_, j) => this.checked[i][j]);
      // A routed group the reader took back leaves this card as a choice of
      // its own under the proposed title; the caller re-plans per highlight,
      // so one card can resolve to several notes.
      const taken = new Set<string>();
      for (const r of note.routed ?? []) {
        if (!this.unrouted.has(`${i}|${r.from}`)) continue;
        const own = checked.filter((h) => r.keys.includes(h.key));
        for (const h of own) taken.add(h.key);
        if (own.length > 0) result.push({ note, title: r.from, highlights: own });
      }
      const rest = checked.filter((h) => !taken.has(h.key));
      if (rest.length > 0) result.push({ note, title: this.titles[i], highlights: rest });
    });
    this.resolve(result);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) this.resolve(null);
  }
}

export function previewSuggestions(
  app: App,
  notes: PreparedNote[],
  extras: SuggestPreviewExtras,
  pdfBasename: string,
): Promise<SuggestPreviewChoice[] | null> {
  return new Promise((resolve) => new SuggestPreviewModal(app, notes, extras, pdfBasename, resolve).open());
}

/** What the lint found, in the shape the report modal needs to draw its buttons. */
export interface LintFixCounts {
  deadLinksFixable: number;
  deadLinksUnresolved: number;
  schemaViolations: number;
  /** Open proposals from the card observer; they are a question, not a wiki fault. */
  schemaSuggestions: number;
}

/** What each button does. An absent callback hides its button. */
export interface LintFixActions {
  onFixDeadLinks?: () => void;
}

/**
 * The lint report, with a button per repair the report makes possible.
 *
 * The report itself is markdown rendered into a scrolling box, so it reads the
 * same here as it does in the chat log. The buttons below it are gated on
 * counts rather than always shown: a button offering to fix nothing teaches
 * the reader to ignore the row it sits in.
 *
 * Only repairs that need no judgement appear. A dead link whose page exists
 * under another spelling is a rewrite; a dead link to a page nobody has
 * written is a decision, and is reported but never offered as a button.
 *
 * Shape follows gd4ai/obsidian-llm-wiki's lint modal — report, then
 * count-gated fix buttons — reimplemented against this plugin's own types.
 */
const CONFIDENCE_LABEL: Record<LinkFix["confidence"], string> = {
  title: "exact title",
  alias: "exact alias",
  slug: "same name, different spelling",
  "alias-slug": "an alias, different spelling",
};

/** Most repairs listed before the list folds; enough to audit, not a wall. */
const FIXES_SHOWN = 30;

export class LintReportModal extends Modal {
  /**
   * The lifetime the rendered markdown hangs off.
   *
   * `MarkdownRenderer.render` wants a `Component` (obsidian.d.ts:4147) and a
   * `Modal` is not one in these typings, so the modal owns one, loads it when
   * the report is drawn and unloads it on close. Without the unload, whatever
   * the renderer registered — an embed's own child components — would outlive
   * the modal that asked for them.
   */
  private renderHost = new Component();

  constructor(
    app: App,
    private report: string,
    private counts: LintFixCounts,
    private actions: LintFixActions,
    private fixes: LinkFix[] = [],
    private onSuggestFixes?: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("wikilm-modal");
    contentEl.createEl("h3", { text: "Wiki check" });

    const box = contentEl.createDiv({ cls: "wikilm-lint-report" });
    // Rendered as markdown, so the report reads here the way it reads in the
    // chat log — and so its wikilinks are links. sourcePath "" because the
    // report's links are vault-absolute and have nothing to resolve against.
    this.renderHost.load();
    void MarkdownRenderer.render(this.app, this.report, box, "", this.renderHost);

    // Obsidian only wires internal links inside a MarkdownView; in a modal they
    // render as anchors that go nowhere, so the click is handled here. The
    // modal closes first: the note opens behind it, and leaving the report over
    // the note the reader asked to see would hide it.
    box.addEventListener("click", (e) => {
      const target = (e.target as HTMLElement | null)?.closest("a.internal-link");
      if (!target) return;
      const href = target.getAttribute("href") ?? target.getAttribute("data-href");
      if (!href) return;
      e.preventDefault();
      this.close();
      void this.app.workspace.openLinkText(href, "", false);
    });

    const { deadLinksFixable, deadLinksUnresolved } = this.counts;
    const row = new Setting(contentEl);

    // Before Close, and a CTA, because it is the one button that offers every
    // repair rather than one kind of repair.
    if (this.onSuggestFixes) {
      row.addButton((b) =>
        b
          .setCta()
          .setButtonText("Suggest fixes")
          .setTooltip("Open a plan of the repairs for what this check found")
          .onClick(() => {
            this.close();
            this.onSuggestFixes?.();
          }),
      );
    }

    if (deadLinksFixable > 0 && this.actions.onFixDeadLinks) {
      row.addButton((b) => {
        // Still here, and unchanged, for one release. It stops being the
        // primary action once the plan exists: two CTAs in a row tell the
        // reader nothing about which one to press.
        if (!this.onSuggestFixes) b.setCta();
        return b
          .setButtonText(`Fix ${deadLinksFixable} link${deadLinksFixable === 1 ? "" : "s"}`)
          .setTooltip("Rewrite links whose page exists under another spelling")
          .onClick(() => {
            this.close();
            this.actions.onFixDeadLinks?.();
          });
      });
    }

    row.addButton((b) => b.setButtonText("Close").onClick(() => this.close()));

    // Each repair, with the page it points at and how sure the match is, so
    // the button above is a decision the reader can audit rather than trust.
    if (this.fixes.length > 0) {
      contentEl.createEl("p", { cls: "wikilm-muted", text: "What the fix would rewrite:" });
      const list = contentEl.createEl("ul", { cls: "wikilm-lint-fixes" });
      for (const fix of this.fixes.slice(0, FIXES_SHOWN)) {
        list.createEl("li", { text: `${fix.from} → ${fix.toPath.replace(/\.md$/i, "")} (${CONFIDENCE_LABEL[fix.confidence]})` });
      }
      if (this.fixes.length > FIXES_SHOWN) list.createEl("li", { cls: "wikilm-muted", text: `…and ${this.fixes.length - FIXES_SHOWN} more` });
    }

    // Said plainly rather than left as the gap between two numbers: these are
    // the links a button cannot honestly fix.
    if (deadLinksUnresolved > 0) {
      contentEl.createEl("p", {
        cls: "wikilm-muted",
        text: `${deadLinksUnresolved} dead link${deadLinksUnresolved === 1 ? "" : "s"} point at pages that do not exist. Write the page or drop the link — the report lists them.`,
      });
    }
  }

  onClose(): void {
    this.renderHost.unload();
    this.contentEl.empty();
  }
}

/** Pick a folder of notes to read into the wiki. */
class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
  private resolved = false;
  constructor(
    app: App,
    private resolve: (v: TFolder | null) => void,
  ) {
    super(app);
    this.setPlaceholder("Folder to ingest");
  }
  getItems(): TFolder[] {
    return this.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder && f.path !== "/");
  }
  getItemText(f: TFolder): string {
    return f.path;
  }
  onChooseItem(f: TFolder): void {
    this.resolved = true;
    this.resolve(f);
  }
  onClose(): void {
    if (!this.resolved) this.resolve(null);
  }
}

export function pickFolder(app: App): Promise<TFolder | null> {
  return new Promise((resolve) => new FolderSuggestModal(app, resolve).open());
}

/** Pick one PDF among several a note cites. */
class PdfSuggestModal extends SuggestModal<TFile> {
  private resolved = false;
  constructor(
    app: App,
    private pdfs: TFile[],
    private resolve: (v: TFile | null) => void,
  ) {
    super(app);
    this.setPlaceholder("Which PDF?");
  }
  getSuggestions(query: string): TFile[] {
    const q = query.toLowerCase();
    return this.pdfs.filter((f) => f.basename.toLowerCase().includes(q));
  }
  renderSuggestion(f: TFile, el: HTMLElement): void {
    el.setText(f.basename);
  }
  onChooseSuggestion(f: TFile): void {
    this.resolved = true;
    this.resolve(f);
  }
  onClose(): void {
    if (!this.resolved) this.resolve(null);
  }
}

export function pickPdf(app: App, pdfs: TFile[]): Promise<TFile | null> {
  return new Promise((resolve) => new PdfSuggestModal(app, pdfs, resolve).open());
}


/**
 * A heading per kind of repair, in the order `orderFixes` puts them in.
 *
 * The words are the reader's rather than the code's: a row under "Dead links"
 * is about a link that goes nowhere, whatever the planner that produced it is
 * called.
 */
const FIX_GROUP: Record<FixKind, string> = {
  aliases: "Aliases and tags",
  tag: "Aliases and tags",
  kind: "Filed wrong",
  "cross-link": "Duplicate pages",
  relink: "Dead links",
  repoint: "Dead links",
  unwrap: "Dead links",
  "hub-link": "Unlinked pages",
  "related-link": "Unlinked pages",
  "add-link": "Missing links",
  "rect-callout": "Rect-only notes",
  attribute: "Unattributed quotes",
};

/**
 * The order the groups are shown in: the groups that write links first.
 *
 * The reader's rule (2026-10-01) is that creating links is the first job of a
 * lint, so the plan opens on the rows that add one — a missing link the review
 * found, the cross-link between two pages about one subject, a way in for a
 * page nothing reaches — then the dead links, the quotes, and last the
 * aliases, tags and kinds. This is only what the eye meets first; the rows
 * are still applied in `orderFixes`'s causal order.
 */
const GROUP_ORDER = ["Missing links", "Duplicate pages", "Unlinked pages", "Dead links", "Unattributed quotes", "Rect-only notes", "Aliases and tags", "Filed wrong"];

/** What the plan needs from the vault, so the modal itself stays about the list. */
export interface FixPlanHooks {
  /** Ask the reader which note a dead link meant; null when they cancel. */
  pickTarget: (row: Fix) => Promise<Fix | null>;
  /** Ask the model for the aliases and tags the lint says are missing. Null hides the button. */
  proposeAliases: (() => Promise<Fix[]>) | null;
  /** Ask the model whether each duplicate pair is one subject or two. Null hides the button. */
  verifyDuplicates: (() => Promise<DuplicateVerdicts>) | null;
  /** Write the ticked rows. */
  apply: (fixes: Fix[]) => Promise<void>;
}

/**
 * The plan: one row per proposed edit, and nothing happens to any of them until
 * Apply.
 *
 * The rows are grouped by what they repair rather than by note, because the
 * reader is deciding whether to trust a *kind* of repair — every cross-link, or
 * none — far more often than they are deciding about one page. A row that needs
 * a target is drawn muted and cannot be ticked: there is nothing to tick yet,
 * and a checkbox that applies nothing is a lie about what Apply will do.
 *
 * The rows the model review proposed during Lint wiki are here when the modal
 * opens (missing links, kinds, confirmed duplicates), since the review has
 * already been paid for. The aliases-and-tags rows are not: they cost a
 * request, and a plan that spent one before the reader had decided to want it
 * would charge for a modal they may close.
 */
export class FixPlanModal extends Modal {
  private applyBtn!: ButtonComponent;
  private list!: HTMLElement;
  private asking = false;
  private checking = false;

  constructor(
    app: App,
    private fixes: Fix[],
    private hooks: FixPlanHooks,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("wikilm-modal");
    contentEl.createEl("h3", { text: "Fix plan" });
    contentEl.createEl("p", {
      cls: "wikilm-muted",
      text: "Nothing is written until Apply, and only the rows left ticked. No pages are created or merged, and a link is only unlinked by a row you left ticked.",
    });

    this.list = contentEl.createDiv({ cls: "wikilm-fix-plan" });
    this.draw();

    const row = new Setting(contentEl);
    if (this.hooks.proposeAliases) {
      row.addButton((b) =>
        b
          .setButtonText("Ask the model for aliases and tags")
          .setTooltip("One request per 20 pages; every proposal becomes a row you can untick")
          .onClick(() => void this.ask(b)),
      );
    }
    if (this.hooks.verifyDuplicates) {
      row.addButton((b) =>
        b
          .setButtonText("Check duplicates with the model")
          .setTooltip("Reads both pages of every duplicate pair and says one subject or two; a pair that is merely related loses its link rows. Nothing is merged.")
          .onClick(() => void this.check(b)),
      );
    }
    row.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
    row.addButton((b) => {
      this.applyBtn = b;
      b.setCta().onClick(() => void this.submit());
    });
    this.updateApply();
  }

  /** Redraw the list in place; the buttons below it keep their state. */
  private draw(): void {
    this.list.empty();
    if (this.fixes.length === 0) {
      this.list.createEl("p", { cls: "wikilm-muted", text: "Nothing here needs a mechanical repair." });
      return;
    }

    for (const heading of GROUP_ORDER) {
      const rows = this.fixes.filter((fix) => FIX_GROUP[fix.kind] === heading);
      if (rows.length === 0) continue;
      const group = this.list.createDiv({ cls: "wikilm-fix-group" });
      group.createEl("h4", { text: heading });
      for (const fix of rows) this.drawRow(group, fix);
    }
  }

  private drawRow(group: HTMLElement, fix: Fix): void {
    const row = group.createDiv({ cls: "wikilm-fix-row" });
    if (fix.needsTarget) row.addClass("is-pending");

    const checkbox = row.createEl("input", { attr: { type: "checkbox" } }) as HTMLInputElement;
    checkbox.checked = fix.enabled;
    checkbox.disabled = Boolean(fix.needsTarget);
    checkbox.addEventListener("change", () => {
      fix.enabled = checkbox.checked;
      this.updateApply();
    });

    // The note the edit lands in, which is not always the note the finding is
    // about: a hub-link row edits the hub, not the orphan it lists.
    row.createSpan({ cls: "wikilm-fix-note", text: (fix.path.split("/").pop() ?? fix.path).replace(/\.md$/i, "") });
    row.createSpan({ cls: "wikilm-fix-label", text: fix.label });

    if (fix.kind === "repoint" && fix.needsTarget) {
      const btn = row.createEl("button", { text: "Point at…" });
      btn.addEventListener("click", () => {
        void this.hooks.pickTarget(fix).then((chosen) => {
          if (!chosen) return;
          const at = this.fixes.findIndex((f) => f.id === fix.id);
          if (at < 0) return;
          this.fixes[at] = chosen;
          this.draw();
          this.updateApply();
        });
      });
    }
  }

  /**
   * The model's rows, appended once. Asking twice would pay for the same answer
   * again, so rows already in the plan are skipped by id rather than added
   * beside their twins.
   */
  private async ask(button: ButtonComponent): Promise<void> {
    if (this.asking || !this.hooks.proposeAliases) return;
    this.asking = true;
    button.setDisabled(true);
    button.setButtonText("asking…");
    try {
      const rows = await this.hooks.proposeAliases();
      const known = new Set(this.fixes.map((f) => f.id));
      const added = rows.filter((r) => !known.has(r.id));
      if (added.length === 0) new Notice("The model proposed nothing new.");
      // Prepended rather than appended: aliases and tags are the first group in
      // `orderFixes`, and the list is drawn in the order it is held in.
      this.fixes = [...added, ...this.fixes];
      this.draw();
      this.updateApply();
      button.setButtonText(`Asked (${added.length} row${added.length === 1 ? "" : "s"})`);
    } catch (e) {
      new Notice(`Could not get aliases and tags: ${describeError(e)}`);
      button.setDisabled(false);
      button.setButtonText("Ask the model for aliases and tags");
    } finally {
      this.asking = false;
    }
  }

  /**
   * The model's verdicts on the duplicate pairs, applied once: a cleared pair
   * loses its cross-link rows, a confirmed look-alike gains them. The reader
   * still ticks what is written.
   */
  private async check(button: ButtonComponent): Promise<void> {
    if (this.checking || !this.hooks.verifyDuplicates) return;
    this.checking = true;
    button.setDisabled(true);
    button.setButtonText("checking…");
    try {
      const v = await this.hooks.verifyDuplicates();
      const known = new Set(this.fixes.map((f) => f.id));
      const added = v.rows.filter((r) => !known.has(r.id));
      this.fixes = orderFixes(applyDuplicateVerdicts([...added, ...this.fixes], v.cleared));
      this.draw();
      this.updateApply();
      const related = v.cleared.length;
      new Notice(
        v.checked === 0
          ? "No duplicate pair got a verdict."
          : `${v.checked} pair${v.checked === 1 ? "" : "s"} checked: ${v.confirmed} one subject, ${related} related only.`,
      );
      button.setButtonText(`Checked (${v.checked})`);
    } catch (e) {
      new Notice(`Could not check duplicates: ${describeError(e)}`);
      button.setDisabled(false);
      button.setButtonText("Check duplicates with the model");
    } finally {
      this.checking = false;
    }
  }

  private enabledFixes(): Fix[] {
    return this.fixes.filter((f) => f.enabled && !f.needsTarget);
  }

  private updateApply(): void {
    const n = this.enabledFixes().length;
    this.applyBtn.setButtonText(`Apply ${n} fix${n === 1 ? "" : "es"}`);
    this.applyBtn.setDisabled(n === 0);
  }

  private async submit(): Promise<void> {
    const chosen = this.enabledFixes();
    if (chosen.length === 0) return;
    this.close();
    await this.hooks.apply(chosen);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Pick the note a dead link meant.
 *
 * Aliases are searched as well as titles, because the reader is typing the name
 * they wrote in the link, and the link is dead precisely because that name is
 * not the filename. The path is shown under each row: two pages can share a
 * heading, and the folder is what tells them apart.
 */
class NoteSuggestModal extends SuggestModal<FixPage> {
  private resolved = false;
  constructor(
    app: App,
    private pages: FixPage[],
    private resolve: (v: FixPage | null) => void,
  ) {
    super(app);
    this.setPlaceholder("Which note did this link mean?");
  }
  getSuggestions(query: string): FixPage[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.pages;
    return this.pages.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        (p.displayTitle ?? "").toLowerCase().includes(q) ||
        p.aliases.some((a) => a.toLowerCase().includes(q)),
    );
  }
  renderSuggestion(p: FixPage, el: HTMLElement): void {
    el.createDiv({ text: p.displayTitle || p.title });
    el.createDiv({ cls: "wikilm-muted", text: p.path });
  }
  onChooseSuggestion(p: FixPage): void {
    this.resolved = true;
    this.resolve(p);
  }
  onClose(): void {
    if (!this.resolved) this.resolve(null);
  }
}

export function pickNote(app: App, pages: FixPage[]): Promise<FixPage | null> {
  return new Promise((resolve) => new NoteSuggestModal(app, pages, resolve).open());
}

/**
 * The proposals waiting in `wikilm-suggestions.md`, one decision each.
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
  constructor(
    app: App,
    private schema: SchemaFileLike,
    private onChange?: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("wikilm-modal");
    contentEl.createEl("h3", { text: "Schema suggestions" });
    void this.renderList();
  }

  /** Re-read and redraw in place, so accepting the first of four leaves the other three on screen. */
  private async renderList(): Promise<void> {
    const { contentEl } = this;
    const old = contentEl.querySelector(".wikilm-schema-list");
    old?.remove();
    const list = contentEl.createDiv({ cls: "wikilm-schema-list" });

    const open = (await this.schema.proposals()).filter((p) => p.status === "open");
    this.onChange?.();

    const link = list.createEl("p", { cls: "wikilm-muted" });
    const a = link.createEl("a", { text: "Open schema note", href: "#" });
    a.addEventListener("click", (e) => {
      e.preventDefault();
      this.close();
      void this.openSchemaNote();
    });

    if (open.length === 0) {
      list.createEl("p", {
        text: "No suggestions yet. WikiLM proposes a rule once it sees the same correction three or four times.",
      });
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    for (const p of open) {
      const box = list.createDiv({ cls: "wikilm-schema-proposal" });
      box.createEl("h4", { text: p.summary });

      const input = box.createEl("input", { type: "text", cls: "wikilm-schema-rule" });
      input.value = p.rule;
      input.placeholder = "The rule as it will be written into the schema";

      if (p.evidence.length) {
        box.createEl("p", { cls: "wikilm-muted", text: `From ${p.count} edit${p.count === 1 ? "" : "s"}:` });
        const ul = box.createEl("ul", { cls: "wikilm-schema-evidence" });
        for (const e of p.evidence) ul.createEl("li", { text: e });
      }

      const row = new Setting(box);
      let accept: ButtonComponent | null = null;
      row.addButton((b) => {
        accept = b;
        return b
          .setCta()
          .setButtonText("Accept")
          .setTooltip("Write this rule into the schema note's Learned section")
          .onClick(() => {
            b.setDisabled(true);
            void this.schema.accept(p.id, input.value.trim(), today).then(() => this.renderList());
          });
      });
      row.addButton((b) =>
        b
          .setButtonText("Dismiss")
          .setTooltip("Not a rule you want. WikiLM stays quiet about this pattern for a month.")
          .onClick(() => {
            b.setDisabled(true);
            void this.schema.dismiss(p.id, today).then(() => this.renderList());
          }),
      );
      // An empty rule would append a bullet with no rule in it, so Accept is
      // only live while there is something to write.
      const sync = () => accept?.setDisabled(input.value.trim() === "");
      input.addEventListener("input", sync);
      sync();
    }
  }

  private async openSchemaNote(): Promise<void> {
    try {
      const file = await this.schema.ensure();
      await this.app.workspace.getLeaf(false).openFile(file);
    } catch (e) {
      new Notice(`WikiLM: ${describeError(e)}`);
    }
  }
}

/**
 * What the modal needs of `SchemaFile` (src/schemaFile.ts), named structurally
 * rather than imported: modals.ts is reached from the settings tab and the
 * chat, and importing the class would pull the plugin's whole graph in behind
 * it for the sake of four methods.
 */
export interface SchemaFileLike {
  proposals(): Promise<SchemaProposal[]>;
  accept(id: string, rule: string, today: string): Promise<void>;
  dismiss(id: string, today: string): Promise<void>;
  ensure(): Promise<TFile>;
}

type SchemaProposal = {
  id: string;
  status: "open" | "applied" | "dismissed";
  summary: string;
  rule: string;
  evidence: string[];
  count: number;
};
