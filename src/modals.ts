import { App, ButtonComponent, FuzzySuggestModal, Modal, Notice, Setting, SuggestModal, TFile } from "obsidian";
import type { TranscriptRecord } from "./model";
import type { PreparedNote } from "./topicNote";
import type { ManifestHighlight } from "./manifest";
import type { LinkFix } from "./vaultFix";

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
    private resolve: (v: TFile | null) => void,
  ) {
    super(app);
    this.setPlaceholder("Transcript file (md, txt, vtt, srt)");
  }

  getItems(): TFile[] {
    const exts = new Set(["md", "txt", "vtt", "srt"]);
    return this.app.vault
      .getFiles()
      .filter((f) => exts.has(f.extension.toLowerCase()))
      .sort((a, b) => a.path.localeCompare(b.path));
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
        new TranscriptFileSuggestModal(this.app, async (file) => {
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

export function askTranscript(app: App, current: TranscriptRecord | undefined): Promise<TranscriptChoice | null> {
  return new Promise((resolve) => new TranscriptModal(app, current, resolve).open());
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

/** Paste a model's raw JSON output (the interim, provider-less path). */
export class PasteJsonModal extends Modal {
  private value = "";
  private resolved = false;

  constructor(
    app: App,
    private title: string,
    private help: string,
    private resolve: (v: string | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("wikilm-modal");
    contentEl.createEl("h3", { text: this.title });
    contentEl.createEl("p", { text: this.help, cls: "wikilm-muted" });

    const ta = contentEl.createEl("textarea", { attr: { rows: "14", placeholder: "Paste the model's JSON here…" } });
    ta.addClass("wikilm-modal-textarea");

    let useBtn!: ButtonComponent;
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => {
        useBtn = b;
        b.setCta()
          .setButtonText("Use")
          .setDisabled(true)
          .onClick(() => this.submit());
      });

    ta.addEventListener("input", () => {
      this.value = ta.value;
      useBtn.setDisabled(this.value.trim().length === 0);
    });

    window.setTimeout(() => ta.focus(), 20);
  }

  private submit() {
    const text = this.value.trim();
    if (!text) return;
    this.resolved = true;
    this.resolve(text);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) this.resolve(null);
  }
}

export function askPastedJson(app: App, title: string, help: string): Promise<string | null> {
  return new Promise((resolve) => new PasteJsonModal(app, title, help, resolve).open());
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
    this.checked = notes.map((n) => !(n.exists && n.added === 0));
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
      titleInput.addEventListener("input", () => {
        this.titles[i] = titleInput.value;
      });

      const badgeText = note.exists ? `exists: +${note.added}, ${note.skipped} skipped` : "new";
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
        badgeText = `exists: +${note.added}, ${note.skipped} skipped`;
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
        li.createEl("strong", { text: `p.${h.page} ` });
        const cut = h.text.length > 120 ? `${h.text.slice(0, 120)}…` : h.text;
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
}

/** What each button does. An absent callback hides its button. */
export interface LintFixActions {
  onFixDeadLinks?: () => void;
  onRetagViolations?: () => void;
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
  constructor(
    app: App,
    private report: string,
    private counts: LintFixCounts,
    private actions: LintFixActions,
    private fixes: LinkFix[] = [],
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("wikilm-modal");
    contentEl.createEl("h3", { text: "Wiki check" });

    const box = contentEl.createDiv({ cls: "wikilm-lint-report" });
    // The report is this plugin's own markdown, not user input, but it is
    // rendered as text rather than HTML so a note title containing angle
    // brackets cannot become markup.
    for (const line of this.report.split("\n")) box.createDiv({ text: line });

    const { deadLinksFixable, deadLinksUnresolved, schemaViolations } = this.counts;
    const row = new Setting(contentEl);

    if (deadLinksFixable > 0 && this.actions.onFixDeadLinks) {
      row.addButton((b) =>
        b
          .setCta()
          .setButtonText(`Fix ${deadLinksFixable} link${deadLinksFixable === 1 ? "" : "s"}`)
          .setTooltip("Rewrite links whose page exists under another spelling")
          .onClick(() => {
            this.close();
            this.actions.onFixDeadLinks?.();
          }),
      );
    }

    if (schemaViolations > 0 && this.actions.onRetagViolations) {
      row.addButton((b) =>
        b
          .setButtonText(`Retag ${schemaViolations}`)
          .setTooltip("Set each page's tag to one this wiki uses")
          .onClick(() => {
            this.close();
            this.actions.onRetagViolations?.();
          }),
      );
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
    this.contentEl.empty();
  }
}
