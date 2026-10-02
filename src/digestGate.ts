/**
 * Whether a source has enough highlights to digest, or needs some first.
 *
 * The defining mechanic of the notebook product: a source digests into pages
 * only from highlights, and a source with none is offered ways to get some
 * rather than digested silently. What lands here is the decision; how it is
 * presented — a Notice from the palette, chips in the chat — is the caller's.
 *
 * "Usable" means a highlight with text. A rect embed with no text layer under
 * it is a real highlight for merging (it renders as an embed and dedupes by
 * key) but gives the digest nothing to read, so it does not count here.
 *
 * Pure: no `obsidian` import; test/digestGate.test.mjs bundles it standalone.
 */
import type { Manifest } from "./manifest";
import { isUnderFolder } from "./util";

export type GateAction = "digest" | "offer";

export interface GateDecision {
  action: GateAction;
  /** Highlights carrying text. */
  usable: number;
  /** Every highlight, text or not. */
  total: number;
}

export function decideGate(manifest: Pick<Manifest, "highlights">): GateDecision {
  const total = manifest.highlights.length;
  const usable = manifest.highlights.filter((h) => h.text.trim().length > 0).length;
  return { action: usable > 0 ? "digest" : "offer", usable, total };
}

/** The two facts the folder planner needs about a file, so it can be tested without a vault. */
export interface FolderFile {
  path: string;
  extension: string;
}

export interface DigestFolderPlan<T extends FolderFile> {
  /** PDFs that pass the gate, in path order: what the run digests, one by one. */
  queue: T[];
  /** PDFs that do not, in path order: counted in the summary, never opened. */
  bare: T[];
}

/**
 * Which of the chosen files a "Digest…" run digests. Only PDFs are
 * asked about, since `qualifies` is the digest gate and reading a PDF's
 * highlights is the costly part; a markdown note is never a digest source.
 * Path order so a run over lecture decks goes L01, L02, … the way the reader
 * filed them.
 */
export function planDigestFolder<T extends FolderFile>(files: T[], qualifies: (file: T) => boolean): DigestFolderPlan<T> {
  const byPath = (a: T, b: T) => a.path.localeCompare(b.path);
  const pdfs = files.filter((f) => f.extension.toLowerCase() === "pdf").sort(byPath);
  const queue: T[] = [];
  const bare: T[] = [];
  for (const f of pdfs) (qualifies(f) ? queue : bare).push(f);
  return { queue, bare };
}

/** How a run over several PDFs went, counted as it goes. */
export interface DigestFolderTally {
  /** PDFs planned to be digested. */
  queued: number;
  /** Wrote notes or queued flashcards. */
  digested: number;
  /** The reader closed a prompt or the preview for that PDF. */
  skipped: number;
  /** The model call or a write threw. */
  failed: number;
  /** PDFs chosen with no highlights that carry text. */
  bare: number;
  /** PDFs chosen whose highlights could not even be read (a parse or resolve failure); never double-counted in `bare`. */
  unreadable: number;
  /** The reader stopped the run; the rest of the queue was never reached. */
  stopped: boolean;
}

/**
 * The one line a run over several PDFs ends on: "digested 3 of 5 PDFs, 2 skipped". The
 * counts that are zero are left out, so the common case reads as one clause.
 *
 * `unreadable` is reported apart from `bare`: a bare PDF was read fine and
 * simply has no highlights, while an unreadable one never got that far, so
 * "no highlights" would misstate why it was left out.
 */
export function digestFolderSummary(t: DigestFolderTally): string {
  const bits = [`digested ${t.digested} of ${t.queued} PDF${t.queued === 1 ? "" : "s"}`];
  if (t.skipped) bits.push(`${t.skipped} skipped`);
  if (t.failed) bits.push(`${t.failed} failed`);
  const unreached = t.queued - t.digested - t.skipped - t.failed;
  if (t.stopped && unreached > 0) bits.push(`${unreached} not reached (stopped)`);
  if (t.bare) bits.push(`${t.bare} with no highlights`);
  if (t.unreadable) bits.push(`${t.unreadable} could not be read`);
  return bits.join(", ");
}

/** A row of the Digest picker: a folder with a PDF somewhere under it. */
export interface PickerFolder<T extends FolderFile> {
  /** Vault-relative folder path; "" for the vault root. */
  path: string;
  /** How many folders deep, for indenting: 0 at the top. */
  depth: number;
  /** PDFs directly in this folder, path order. */
  pdfs: T[];
  /** Every PDF under this folder, recursive, path order: what ticking the folder ticks. */
  all: T[];
}

/**
 * The folders the Digest picker lists, in path order, each with the PDFs it
 * holds and every PDF below it.
 *
 * Every ancestor of a PDF gets a row, with or without PDFs of its own, so a
 * course folder whose decks sit in week subfolders can still be ticked as
 * one. A folder with no PDF anywhere under it is not a row: the picker is
 * for choosing what to digest, and such a folder offers nothing. Notes are
 * never listed; a markdown note is not a digest source (see
 * `planDigestFolder`).
 */
export function pickerFolders<T extends FolderFile>(files: T[]): PickerFolder<T>[] {
  const pdfs = files.filter((f) => f.extension.toLowerCase() === "pdf").sort((a, b) => a.path.localeCompare(b.path));
  const rows = new Map<string, PickerFolder<T>>();
  const row = (path: string): PickerFolder<T> => {
    let r = rows.get(path);
    if (!r) {
      r = { path, depth: path === "" ? 0 : path.split("/").length - 1, pdfs: [], all: [] };
      rows.set(path, r);
    }
    return r;
  };
  for (const f of pdfs) {
    const parts = f.path.split("/");
    parts.pop();
    row(parts.join("/")).pdfs.push(f);
    if (parts.length === 0) row("").all.push(f);
    for (let i = 1; i <= parts.length; i++) row(parts.slice(0, i).join("/")).all.push(f);
  }
  return [...rows.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** The folder settings that decide which notes under the topic folder are the plugin's own. */
export interface DigestTargetFolders {
  topicFolder: string;
  schemaFolder: string;
  transcriptFolder: string;
}

/**
 * Whether a note may be offered to a digest as a page to merge into.
 *
 * Only topic pages qualify. Ask and Lint already skip the schema and
 * transcript folders (isWikiPage in src/chatPanel.ts); a digest skips them
 * too, plus the topic folder's own `sources/` (source summaries, which Lint
 * reads as sources rather than pages) and the engine's `index.md` and
 * `log.md` at the top of the topic folder. Without this a digest could write
 * a section into the reader's transcript.
 */
export function isDigestTarget(path: string, opts: DigestTargetFolders): boolean {
  const topic = opts.topicFolder.replace(/^\/+|\/+$/g, "");
  if (!topic || !path.startsWith(`${topic}/`)) return false;
  if (isUnderFolder(path, opts.schemaFolder) || isUnderFolder(path, opts.transcriptFolder)) return false;
  if (isUnderFolder(path, `${topic}/sources`)) return false;
  return path !== `${topic}/index.md` && path !== `${topic}/log.md`;
}

/** The parts of a preview row the nothing-new check reads. */
export interface PreviewRowShape {
  exists: boolean;
  added: number;
  sections?: unknown[];
  highlights: Array<{ page: number }>;
}

/**
 * Why a digest preview would write nothing, in one sentence the reader can
 * act on, or "" when some row would write. The digest only arranges the
 * highlights the PDF already carries; when every one of them is already on a
 * page, an instruction naming another subject cannot conjure material from
 * slides nobody highlighted. The reader's way forward is to highlight those
 * slides, or to run AI highlight, which reads every page.
 */
export function nothingNewHint(rows: PreviewRowShape[]): string {
  if (rows.length === 0) return "";
  const writes = rows.some((r) => !r.exists || r.added > 0 || (r.sections?.length ?? 0) > 0);
  if (writes) return "";
  const pages = rows.flatMap((r) => r.highlights.map((h) => h.page)).filter((p) => Number.isFinite(p));
  const count = pages.length;
  const span = pages.length ? `pages ${Math.min(...pages)} to ${Math.max(...pages)}` : "no pages";
  return (
    `Nothing new to write: all ${count} highlights in this PDF (${span}) are already on these pages. ` +
    `Digest arranges the highlights you made; it cannot add slides nobody highlighted. ` +
    `To cover other parts of the deck, highlight them in PDF++ and run Digest again, or run AI highlight… with your instruction, which reads every page.`
  );
}
