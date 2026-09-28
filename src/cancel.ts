/**
 * A request to stop a long run at its next safe point.
 *
 * The suggester and the ingest both loop over batches; a half-written page is
 * worse than a slow one, so a cancel is a flag those loops read between
 * batches, never an abort of an in-flight model call. Work accepted before
 * the flag is kept. Follows the design of gd4ai/obsidian-llm-wiki's
 * `cancel-ingestion`, which stops at the next batch boundary.
 *
 * One token per plugin. A folder run owns it across files; a single-file run
 * owns it only when nothing else does (`active` is the test).
 *
 * `begin` hands back an owner id, and only that owner can relabel or end the
 * run. Without it, a run that ended in its `finally` ended whatever held the
 * token at that moment: lint could end a folder ingest the reader started
 * while the review was still reading. `cancel` takes no id, because it is the
 * reader's request to stop whatever is running.
 *
 * Pure: no `obsidian` import; test/cancel.test.mjs bundles it standalone.
 */
export class CancelToken {
  private _active = false;
  private _cancelled = false;
  private _label = "";
  private _owner = 0;
  private lastOwner = 0;
  private listeners = new Set<() => void>();

  get active(): boolean {
    return this._active;
  }
  get cancelled(): boolean {
    return this._cancelled;
  }
  /** What is running, for the status bar: "highlighting Deck", "3/9 Notes". */
  get label(): string {
    return this._label;
  }

  /** Take the token for a run; the id returned is what `progress` and `end` must be given. */
  begin(label: string): number {
    this._owner = ++this.lastOwner;
    this._active = true;
    this._cancelled = false;
    this._label = label;
    this.emit();
    return this._owner;
  }

  /** Whether `owner` holds the token now; undefined, a run that never took it, never does. */
  private owns(owner: number | undefined): boolean {
    return this._active && owner !== undefined && owner === this._owner;
  }

  progress(label: string, owner: number | undefined): void {
    if (!this.owns(owner)) return;
    this._label = label;
    this.emit();
  }

  cancel(): void {
    if (!this._active) return;
    this._cancelled = true;
    this.emit();
  }

  end(owner: number | undefined): void {
    if (!this.owns(owner)) return;
    this._active = false;
    this._cancelled = false;
    this._label = "";
    this.emit();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
