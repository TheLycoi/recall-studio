import type { App } from "obsidian";
import { Notice, normalizePath } from "obsidian";
import { randomUUID } from "crypto";
import type { Highlight, InboxData, Card, CardRevision, TranscriptRecord } from "./model";
import { emptyInbox, parseInboxJson, pushRevision, rememberInstruction } from "./inboxData";

/** `YYYYMMDD-HHMMSS` in local time, for a moved-aside file's suffix. */
function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

type Listener = () => void;

/**
 * Persistent inbox. Lives in the Recall folder (the Recall folder
 * setting) as inbox.json, beside the house rules, so everything the plugin
 * keeps for the reader sits in one vault folder (by design) and syncs with
 * it. Earlier versions kept it in the plugin folder; that file is moved in
 * on first load. Writes are debounced.
 */
export class InboxStore {
  private data: InboxData = emptyInbox();
  private listeners = new Set<Listener>();
  private saveTimer: number | null = null;
  private path: string;
  /**
   * Set when inbox.json could not be read at all, or was unreadable and
   * could not even be moved aside.
   * Writing in that state would still destroy whatever the reader has —
   * only now there is no copy at all, not even the renamed original — so
   * every save is a no-op until the plugin is reloaded.
   */
  private readOnly = false;
  /**
   * Set by close() when the plugin unloads. A model call that completes in
   * an unloaded instance would otherwise write its stale copy of the inbox
   * over the one the reloaded plugin is keeping.
   */
  private closed = false;
  /** The write in progress, if any. Each flush waits on it, so writes land in the order they were asked for. */
  private flushing: Promise<void> = Promise.resolve();
  private dirty = false;
  private revision = 0;

  private legacyPath: string | null;

  constructor(
    private app: App,
    dir: string,
    legacyDir: string | null = null,
  ) {
    this.path = normalizePath(`${dir}/inbox.json`);
    this.legacyPath = legacyDir ? normalizePath(`${legacyDir}/inbox.json`) : null;
  }

  /** The vault path the inbox is kept at. */
  get filePath(): string {
    return this.path;
  }

  /** True until the latest in-memory change has been written successfully. */
  get hasUnsavedChanges(): boolean {
    return this.dirty;
  }

  /** Move a plugin-folder inbox.json into the Recall folder, once, when no inbox is there yet. */
  private async migrate(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const dir = this.path.slice(0, this.path.lastIndexOf("/"));
    if (dir && !(await adapter.exists(dir))) await adapter.mkdir(dir);
    if (!this.legacyPath || (await adapter.exists(this.path)) || !(await adapter.exists(this.legacyPath))) return;
    await adapter.rename(this.legacyPath, this.path);
    console.debug(`Review Inbox: inbox moved from the plugin folder to ${this.path}`);
  }

  async load(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const backup = `${this.path}.backup`;
    try {
      if (await adapter.exists(backup)) {
        if (await adapter.exists(this.path)) {
          const live = parseInboxJson(await adapter.read(this.path));
          if (live.ok) {
            await adapter.remove(backup);
          } else {
            const saved = parseInboxJson(await adapter.read(backup));
            if (!saved.ok) throw new Error(`Neither inbox nor backup is readable: ${saved.detail}`);
            const moved = `${this.path}.corrupt-${timestamp(new Date())}`;
            await adapter.rename(this.path, moved);
            await adapter.rename(backup, this.path);
            new Notice(`Review Inbox: recovered inbox.json from backup; damaged file kept at ${moved}.`, 0);
          }
        } else {
          const saved = parseInboxJson(await adapter.read(backup));
          if (!saved.ok) throw new Error(`Inbox backup is unreadable: ${saved.detail}`);
          await adapter.rename(backup, this.path);
          new Notice("Review Inbox: recovered inbox.json from an interrupted save.");
        }
      }
    } catch (e) {
      console.error("Review Inbox: could not recover inbox.json backup", e);
      this.readOnly = true;
      new Notice("Review Inbox: inbox.json backup could not be recovered; storage is read-only until restart.", 0);
      return;
    }
    try {
      await this.migrate();
    } catch (e) {
      console.error("Review Inbox: could not move the inbox into the Review Inbox folder", e);
    }
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
            console.error(`Review Inbox: inbox.json could not be read; moved to ${moved}`, parsed.detail);
            const basename = moved.split("/").pop() ?? moved;
            new Notice(
              `Review Inbox: inbox.json was unreadable and has been moved to ${basename}. The inbox starts empty; the old file is kept.`,
              0,
            );
          } catch (renameError) {
            // Couldn't even move it aside — leave it in place, untouched,
            // and never schedule a write, or the next save would clobber
            // the one copy of the reader's inbox that still exists on disk.
            console.error("Review Inbox: inbox.json is unreadable and could not be moved aside", renameError);
            this.readOnly = true;
          }
        }
      }
    } catch (e) {
      // The file may be there and simply unreadable right now (evicted by
      // iCloud, locked by a sync). Writing would put an empty inbox over it,
      // so nothing is saved until the plugin is loaded again.
      console.error("Review Inbox: failed to read inbox.json", e);
      this.readOnly = true;
      new Notice("Review Inbox: inbox.json could not be read; the inbox is read-only until Obsidian is restarted.");
    }
    // Anything interrupted mid-generation goes back to the queue.
    for (const h of this.data.highlights) if (h.status === "generating") h.status = "queued";
  }

  private scheduleSave() {
    if (this.readOnly || this.closed) return;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.flush().catch((e) => {
      console.error("Review Inbox: failed to write inbox.json; changes remain in memory for retry", e);
      new Notice("Review Inbox: inbox.json could not be saved. Changes are not yet durable; retry after fixing storage.");
    }), 400);
  }

  async flush(): Promise<void> {
    if (this.readOnly || this.closed) return;
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const snapshot = JSON.stringify(this.data, null, 2);
    const revision = this.revision;
    const attempt = this.flushing.then(async () => {
      if (this.closed || this.readOnly) return;
      const adapter = this.app.vault.adapter;
      const staged = `${this.path}.pending-${randomUUID()}`;
      const backup = `${this.path}.backup`;
      try {
        if (await adapter.exists(backup)) throw new Error("Inbox backup still exists; reload before saving.");
        await adapter.write(staged, snapshot);
        if (this.closed || this.readOnly) return;
        // Obsidian's adapter refuses rename onto an existing destination.
        // Keep the previous file recoverable across the gap between renames.
        const existing = await adapter.exists(this.path);
        if (this.closed || this.readOnly) return;
        if (existing) await adapter.rename(this.path, backup);
        if (this.closed || this.readOnly) {
          if (existing && !(await adapter.exists(this.path))) await adapter.rename(backup, this.path);
          return;
        }
        try {
          await adapter.rename(staged, this.path);
        } catch (e) {
          if (existing && !(await adapter.exists(this.path))) await adapter.rename(backup, this.path);
          throw e;
        }
        if (existing) await adapter.remove(backup);
        if (revision === this.revision) this.dirty = false;
      } catch (e) {
        console.error("Review Inbox: failed to write inbox.json", e);
        throw e;
      } finally {
        if (await adapter.exists(staged)) await adapter.remove(staged);
      }
    });
    // A failed write must not poison the chain: the next flush writes the
    // current full snapshot, including everything that failed to persist.
    this.flushing = attempt.catch(() => {});
    await attempt;
  }

  /** Stop saving for good. Called on unload, after the last flush. */
  close(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.closed = true;
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Call after mutating a highlight or card in place. */
  touch(): void {
    this.dirty = true;
    this.revision++;
    this.scheduleSave();
    for (const fn of this.listeners) fn();
  }

  all(): Highlight[] {
    return this.data.highlights.filter((h) => !h.archived);
  }

  /** All captured passages, active and archived, in their original order. */
  allHistory(): Highlight[] {
    return this.data.highlights;
  }

  /** Passage history for a source, including archived cards and exact PDF locators. */
  sourceHistory(sourcePath: string): Highlight[] {
    return this.data.highlights.filter((h) => h.sourcePath === sourcePath);
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

  /** Active captures and retained cards block recapture; empty completed passages do not. */
  hasDuplicate(sourcePath: string, normalizedText: string): boolean {
    return this.data.highlights.some(
      (h) =>
        h.sourcePath === sourcePath &&
        ((!h.archived && h.status !== "exported" && h.status !== "dismissed") || h.cards.some((c) => c.status !== "deleted")) &&
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
    for (const h of this.all()) {
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
    if (this.readOnly || this.closed) throw new Error("Inbox cannot be archived while storage is read-only or closed.");
    let archived = 0;
    for (const h of this.data.highlights) {
      if (!h.archived && (h.status === "exported" || h.status === "dismissed")) {
        h.archived = true;
        archived++;
      }
    }
    if (archived) this.touch();
    return archived;
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

  /** The last instruction AI highlight was run with on this file, or "" for none. */
  getHighlightInstruction(sourcePath: string): string {
    return this.data.highlightInstructions?.[sourcePath] ?? "";
  }

  /** Remember (or, when empty, forget) the instruction for this file; capped by rememberInstruction. */
  setHighlightInstruction(sourcePath: string, instruction: string): void {
    rememberInstruction(this.data, sourcePath, instruction);
    this.touch();
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
