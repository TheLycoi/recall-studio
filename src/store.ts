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

// Symbol.for survives plugin bundle re-evaluation; only identities and settlement
// promises live here, never serialized inbox data or settings.
const handoverKey = Symbol.for("recall-studio.inbox-handovers.v1");
function handovers(): WeakMap<object, Map<string, Promise<void>>> {
  const host = globalThis as typeof globalThis & { [handoverKey]?: WeakMap<object, Map<string, Promise<void>>> };
  return host[handoverKey] ??= new WeakMap();
}

// Commit ownership is shared across bundle reloads and desktop adapters for one vault.
const writesKey = Symbol.for("recall-studio.inbox-writes.v1");
function serializeInbox(adapter: App["vault"]["adapter"], path: string, work: () => Promise<void>): Promise<void> {
  const host = globalThis as typeof globalThis & { [writesKey]?: Map<object | string, Map<string, Promise<void>>> };
  const registry = host[writesKey] ??= new Map();
  const desktop = adapter as typeof adapter & { getBasePath?: () => string };
  const identity = desktop.getBasePath?.() || adapter;
  let paths = registry.get(identity);
  if (!paths) registry.set(identity, paths = new Map());
  const attempt = (paths.get(path) ?? Promise.resolve()).then(work);
  const settled = attempt.catch(() => {});
  paths.set(path, settled);
  void settled.then(() => {
    if (paths.get(path) === settled) paths.delete(path);
    if (!paths.size) registry.delete(identity);
  });
  return attempt;
}

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
   * Set when no usable snapshot can be loaded or recovery fails. Every save
   * is a no-op until reload, so uncertain inbox and backup bytes stay intact.
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
  private handingOver?: Promise<void>;
  private loading?: Promise<void>;
  private loaded = false;
  private persistedRaw: string | null = null;

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
    if (this.closed) return;
    const adapter = this.app.vault.adapter;
    const dir = this.path.slice(0, this.path.lastIndexOf("/"));
    if (dir) {
      const exists = await adapter.exists(dir);
      if (this.closed) return;
      if (!exists) await adapter.mkdir(dir);
    }
    if (this.closed || !this.legacyPath) return;
    const destinationExists = await adapter.exists(this.path);
    if (this.closed || destinationExists) return;
    const legacyExists = await adapter.exists(this.legacyPath);
    if (this.closed || !legacyExists) return;
    await adapter.rename(this.legacyPath, this.path);
    console.debug(`Recall Studio: inbox moved from the plugin folder to ${this.path}`);
  }

  load(): Promise<void> {
    return this.loading ??= (async () => {
      this.readOnly = true;
      await handovers().get(this.app.vault.adapter)?.get(this.path);
      await serializeInbox(this.app.vault.adapter, this.path, () => this.readInbox());
    })();
  }

  private async readInbox(): Promise<void> {
    const adapter = this.app.vault.adapter;
    // Native Component.unload does not await onunload. Do not even inspect
    // recovery files until the previous instance's rollback and save settle.
    if (this.closed) return;
    this.readOnly = false;
    const backup = `${this.path}.backup`;
    let loaded = false;
    try {
      if (await adapter.exists(backup)) {
        const backupVersion = parseInboxJson(await adapter.read(backup));
        if (!backupVersion.ok && backupVersion.reason === "unsupported-version") throw new Error(backupVersion.detail);
        if (await adapter.exists(this.path)) {
          const liveRaw = await adapter.read(this.path);
          const live = parseInboxJson(liveRaw);
          if (!live.ok && live.reason === "unsupported-version") throw new Error(live.detail);
          if (live.ok && !live.fresh) {
            await adapter.remove(backup);
            this.data = live.data;
            this.persistedRaw = liveRaw;
          } else {
            const savedRaw = await adapter.read(backup);
            const saved = parseInboxJson(savedRaw);
            if (!saved.ok || saved.fresh) throw new Error(`Neither inbox nor backup is readable: ${saved.ok ? "backup is blank" : saved.detail}`);
            const moved = `${this.path}.corrupt-${timestamp(new Date())}`;
            await adapter.rename(this.path, moved);
            await adapter.rename(backup, this.path);
            this.data = saved.data;
            this.persistedRaw = savedRaw;
            new Notice(`Recall Studio: recovered inbox.json from backup; damaged file kept at ${moved}.`, 0);
          }
        } else {
          const savedRaw = await adapter.read(backup);
          const saved = parseInboxJson(savedRaw);
          if (!saved.ok || saved.fresh) throw new Error(`Inbox backup is unreadable: ${saved.ok ? "backup is blank" : saved.detail}`);
          await adapter.rename(backup, this.path);
          this.data = saved.data;
          this.persistedRaw = savedRaw;
          new Notice("Recall Studio: recovered inbox.json from an interrupted save.");
        }
        // Consume the exact snapshot that justified removing recovery data.
        loaded = true;
      }
    } catch (e) {
      console.error("Recall Studio: could not recover inbox.json backup", e);
      this.readOnly = true;
      new Notice("Recall Studio: inbox.json backup could not be recovered; storage is read-only until restart.", 0);
      return;
    }
    if (this.closed) return;
    try {
      await this.migrate();
      if (this.closed) return;
    } catch (e) {
      console.error("Recall Studio: could not move the inbox into the Recall Studio folder", e);
      this.readOnly = true;
      new Notice("Recall Studio: inbox migration failed; the original file is kept and storage is read-only until restart.", 0);
      return;
    }
    try {
      if (!loaded && await this.app.vault.adapter.exists(this.path)) {
        const raw = await this.app.vault.adapter.read(this.path);
        const parsed = parseInboxJson(raw);
        if (parsed.ok) {
          this.data = parsed.data;
          this.persistedRaw = raw;
        } else {
          // Without a usable snapshot, keep the original in place and refuse
          // writes rather than turning uncertain history into an empty inbox.
          console.error("Recall Studio: inbox.json has unusable records", parsed.detail);
          this.readOnly = true;
          new Notice("Recall Studio: inbox.json could not be read; the original file is kept and storage is read-only until restart.", 0);
        }
      }
    } catch (e) {
      // The file may be there and simply unreadable right now (evicted by
      // iCloud, locked by a sync). Writing would put an empty inbox over it,
      // so nothing is saved until the plugin is loaded again.
      console.error("Recall Studio: failed to read inbox.json", e);
      this.readOnly = true;
      new Notice("Recall Studio: inbox.json could not be read; the inbox is read-only until Obsidian is restarted.");
    }
    // Anything interrupted mid-generation goes back to the queue.
    for (const h of this.data.highlights) if (h.status === "generating") h.status = "queued";
    this.loaded = true;
  }

  private scheduleSave() {
    if (this.readOnly || this.closed) return;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.flush().catch((e) => {
      console.error("Recall Studio: failed to write inbox.json; changes remain in memory for retry", e);
      new Notice("Recall Studio: inbox.json could not be saved. Changes are not yet durable; retry after fixing storage.");
    }), 400);
  }

  async flush(): Promise<void> {
    if (!this.loaded || this.readOnly || this.closed) return;
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const snapshot = JSON.stringify(this.data, null, 2);
    const revision = this.revision;
    const attempt = serializeInbox(this.app.vault.adapter, this.path, async () => {
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
        const current = existing ? await adapter.read(this.path) : null;
        if (current !== this.persistedRaw) throw new Error("Inbox changed outside this store; reload before saving. Unsaved changes remain in memory.");
        if (this.closed || this.readOnly) return;
        if (existing) await adapter.rename(this.path, backup);
        if (this.closed || this.readOnly) {
          if (existing && !(await adapter.exists(this.path))) await adapter.rename(backup, this.path);
          return;
        }
        try {
          if (existing && await adapter.read(backup) !== this.persistedRaw) throw new Error("Inbox changed during save; the newer snapshot is preserved.");
          if (this.closed || this.readOnly) {
            if (existing && !(await adapter.exists(this.path))) await adapter.rename(backup, this.path);
            return;
          }
          await adapter.rename(staged, this.path);
          this.persistedRaw = snapshot;
        } catch (e) {
          if (existing && !(await adapter.exists(this.path))) await adapter.rename(backup, this.path);
          throw e;
        }
        if (existing) await adapter.remove(backup);
        if (revision === this.revision) this.dirty = false;
      } catch (e) {
        console.error("Recall Studio: failed to write inbox.json", e);
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

  /** Register before cleanup starts, including its first asynchronous boundary. */
  handover(cleanup: () => Promise<void>): Promise<void> {
    if (this.handingOver) return this.handingOver;
    const registry = handovers();
    let paths = registry.get(this.app.vault.adapter);
    if (!paths) registry.set(this.app.vault.adapter, paths = new Map());
    const previous = paths.get(this.path);
    let resolve!: () => void, reject!: (error: unknown) => void;
    const settled = this.handingOver = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    paths.set(this.path, settled);
    // Observe the host's ignored rejection. Keep a failed handover registered:
    // a new instance must not accept an uncertain rollback as durable state.
    void settled.then(() => {
      if (paths.get(this.path) === settled) paths.delete(this.path);
    }, () => {});
    try { void Promise.all([previous, this.loading, cleanup()]).then(() => resolve(), reject); } catch (e) { reject(e); }
    return settled;
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
    this.notify();
  }

  /** Refresh views for transient queue state without dirtying a durable checkpoint. */
  notify(): void {
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

  /** Preserve source references when Obsidian renames a note, PDF, or folder. */
  moveSource(oldPath: string, newPath: string): number {
    if (this.readOnly || this.closed || !oldPath || !newPath || oldPath === newPath) return 0;
    const move = (path: string) => path === oldPath ? newPath : path.startsWith(`${oldPath}/`) ? newPath + path.slice(oldPath.length) : path;
    const maps = [this.data.transcripts, this.data.highlightInstructions, this.data.ingested];
    if (newPath.startsWith(`${oldPath}/`) || maps.some(map => map && Object.keys(map).some(key => move(key) !== key && Object.hasOwn(map, move(key))))) {
      new Notice("Recall Studio: source rename conflicts with retained metadata. History remains under its original path; no records were overwritten.", 0);
      return 0;
    }
    let changed = 0;
    for (const h of this.data.highlights) {
      const next = move(h.sourcePath);
      if (next === h.sourcePath) continue;
      h.sourcePath = next;
      h.sourceTitle = next.split("/").pop()?.replace(/\.[^.]+$/, "") ?? next;
      changed++;
    }
    // These maps are keyed by source path; moving them keeps the source-specific context attached.
    for (const map of [this.data.transcripts, this.data.highlightInstructions, this.data.ingested]) {
      if (!map) continue;
      for (const key of Object.keys(map)) {
        const next = move(key);
        if (next !== key) { map[next] = map[key]; delete map[key]; changed++; }
      }
    }
    if (changed) this.touch();
    return changed;
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
