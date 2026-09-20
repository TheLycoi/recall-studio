import type { App } from "obsidian";
import { Notice, normalizePath } from "obsidian";
import type { Highlight, InboxData, Card, CardRevision, TranscriptRecord } from "./model";
import { emptyInbox, parseInboxJson, pushRevision } from "./inboxData";

/** `YYYYMMDD-HHMMSS` in local time, for a moved-aside file's suffix. */
function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

type Listener = () => void;

/**
 * Persistent inbox. Lives in the plugin folder as inbox.json so the vault's
 * notes stay untouched. Writes are debounced.
 */
export class InboxStore {
  private data: InboxData = emptyInbox();
  private listeners = new Set<Listener>();
  private saveTimer: number | null = null;
  private path: string;
  /**
   * Set when inbox.json was unreadable and could not even be moved aside.
   * Writing in that state would still destroy whatever the reader has —
   * only now there is no copy at all, not even the renamed original — so
   * every save is a no-op until the plugin is reloaded.
   */
  private readOnly = false;

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
        const parsed = parseInboxJson(raw);
        if (parsed.ok) {
          this.data = parsed.data;
        } else {
          // A corrupt or truncated file must never be silently overwritten
          // by the next scheduled save — move it aside first, so the
          // reader's inbox is only ever renamed, not lost.
          const moved = `${this.path}.corrupt-${timestamp(new Date())}`;
          try {
            await this.app.vault.adapter.rename(this.path, moved);
            console.error(`WikiLM: inbox.json could not be read; moved to ${moved}`, parsed.detail);
            const basename = moved.split("/").pop() ?? moved;
            new Notice(
              `WikiLM: inbox.json was unreadable and has been moved to ${basename}. The inbox starts empty; the old file is kept.`,
              0,
            );
          } catch (renameError) {
            // Couldn't even move it aside — leave it in place, untouched,
            // and never schedule a write, or the next save would clobber
            // the one copy of the reader's inbox that still exists on disk.
            console.error("WikiLM: inbox.json is unreadable and could not be moved aside", renameError);
            this.readOnly = true;
          }
        }
      }
    } catch (e) {
      console.error("WikiLM: failed to read inbox.json", e);
    }
    // Anything interrupted mid-generation goes back to the queue.
    for (const h of this.data.highlights) if (h.status === "generating") h.status = "queued";
  }

  private scheduleSave() {
    if (this.readOnly) return;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.flush(), 400);
  }

  async flush(): Promise<void> {
    if (this.readOnly) return;
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

  ingestedHash(sourcePath: string): string | undefined {
    return this.data.ingested?.[sourcePath];
  }

  markIngested(sourcePath: string, hash: string): void {
    this.data.ingested ??= {};
    this.data.ingested[sourcePath] = hash;
    this.touch();
  }

  /** Record one card edit for the schema-learning feature (src/preferences.ts). */
  recordRevision(rev: CardRevision): void {
    pushRevision(this.data, rev);
    this.touch();
  }

  revisions(): CardRevision[] {
    return this.data.revisions ?? [];
  }
}
