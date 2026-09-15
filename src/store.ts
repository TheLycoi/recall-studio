import type { App } from "obsidian";
import { normalizePath } from "obsidian";
import type { Highlight, InboxData, Card, TranscriptRecord } from "./model";

type Listener = () => void;

/**
 * Persistent inbox. Lives in the plugin folder as inbox.json so the vault's
 * notes stay untouched. Writes are debounced.
 */
export class InboxStore {
  private data: InboxData = { version: 1, highlights: [] };
  private listeners = new Set<Listener>();
  private saveTimer: number | null = null;
  private path: string;

  constructor(
    private app: App,
    pluginDir: string,
  ) {
    this.path = normalizePath(`${pluginDir}/inbox.json`);
  }

  async load(): Promise<void> {
    try {
      if (await this.app.vault.adapter.exists(this.path)) {
        const raw = await this.app.vault.adapter.read(this.path);
        const parsed = JSON.parse(raw) as InboxData;
        if (parsed && Array.isArray(parsed.highlights)) this.data = parsed;
      }
    } catch (e) {
      console.error("WikiLM: failed to read inbox.json", e);
    }
    // Anything interrupted mid-generation goes back to the queue.
    for (const h of this.data.highlights) if (h.status === "generating") h.status = "queued";
  }

  private scheduleSave() {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.flush(), 400);
  }

  async flush(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      await this.app.vault.adapter.write(this.path, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.error("WikiLM: failed to write inbox.json", e);
    }
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Call after mutating a highlight or card in place. */
  touch(): void {
    this.scheduleSave();
    for (const fn of this.listeners) fn();
  }

  all(): Highlight[] {
    return this.data.highlights;
  }

  get(id: string): Highlight | undefined {
    return this.data.highlights.find((h) => h.id === id);
  }

  findCard(cardId: string): { highlight: Highlight; card: Card } | undefined {
    for (const h of this.data.highlights) {
      const c = h.cards.find((x) => x.id === cardId);
      if (c) return { highlight: h, card: c };
    }
    return undefined;
  }

  add(h: Highlight): Highlight {
    this.data.highlights.unshift(h);
    this.touch();
    return h;
  }

  remove(id: string): void {
    this.data.highlights = this.data.highlights.filter((h) => h.id !== id);
    this.touch();
  }

  /** True when the same text from the same note is already in the inbox (not dismissed). */
  hasDuplicate(sourcePath: string, normalizedText: string): boolean {
    return this.data.highlights.some(
      (h) =>
        h.sourcePath === sourcePath &&
        h.status !== "dismissed" &&
        h.text.replace(/\s+/g, " ").trim() === normalizedText,
    );
  }

  /**
   * `flagged` is counted separately from `toReview` rather than folded into
   * it: a flagged card is neither pending nor exported, so without its own
   * figure it would vanish from every count while still sitting in the inbox
   * waiting for the reviewer to decide. `toReview` keeps meaning exactly what
   * it meant before — pending cards under a ready highlight.
   */
  counts(): { queued: number; generating: number; toReview: number; flagged: number; errors: number } {
    let queued = 0;
    let generating = 0;
    let toReview = 0;
    let flagged = 0;
    let errors = 0;
    for (const h of this.data.highlights) {
      if (h.status === "queued") queued++;
      else if (h.status === "generating") generating++;
      else if (h.status === "error") errors++;
      if (h.status === "ready") {
        toReview += h.cards.filter((c) => c.status === "pending").length;
        flagged += h.cards.filter((c) => c.status === "flagged").length;
      }
    }
    return { queued, generating, toReview, flagged, errors };
  }

  clearExported(): number {
    const before = this.data.highlights.length;
    this.data.highlights = this.data.highlights.filter((h) => h.status !== "exported" && h.status !== "dismissed");
    this.touch();
    return before - this.data.highlights.length;
  }

  getTranscript(sourcePath: string): TranscriptRecord | undefined {
    return this.data.transcripts?.[sourcePath];
  }

  setTranscript(sourcePath: string, rec: TranscriptRecord): void {
    this.data.transcripts ??= {};
    this.data.transcripts[sourcePath] = rec;
    this.touch();
  }

  clearTranscript(sourcePath: string): boolean {
    if (!this.data.transcripts || !(sourcePath in this.data.transcripts)) return false;
    delete this.data.transcripts[sourcePath];
    this.touch();
    return true;
  }
}
