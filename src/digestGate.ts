/**
 * Whether a source has enough highlights to digest, or needs some first.
 *
 * The defining mechanic of the notebook product (plan, Stage 2 Phase 3): a
 * source digests into pages only from highlights, and a source with none is
 * offered ways to get some rather than digested silently. What lands here is
 * the decision; how it is presented — a Notice from the palette, chips in the
 * chat — is the caller's.
 *
 * "Usable" means a highlight with text. A rect embed with no text layer under
 * it is a real highlight for merging (it renders as an embed and dedupes by
 * key) but gives the digest nothing to read, so it does not count here.
 *
 * Pure: no `obsidian` import; test/digestGate.test.mjs bundles it standalone.
 */
import type { Manifest } from "./manifest";

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
 * Which files under a folder a "Digest folder" run digests. Only PDFs are
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

/** How a folder run went, counted as it goes. */
export interface DigestFolderTally {
  /** PDFs planned to be digested. */
  queued: number;
  /** Wrote notes or queued flashcards. */
  digested: number;
  /** The reader closed a prompt or the preview for that PDF. */
  skipped: number;
  /** The model call or a write threw. */
  failed: number;
  /** PDFs under the folder with no highlights that carry text. */
  bare: number;
  /** The reader stopped the run; the rest of the queue was never reached. */
  stopped: boolean;
}

/**
 * The one line a folder run ends on: "digested 3 of 5 PDFs, 2 skipped". The
 * counts that are zero are left out, so the common case reads as one clause.
 */
export function digestFolderSummary(t: DigestFolderTally): string {
  const bits = [`digested ${t.digested} of ${t.queued} PDF${t.queued === 1 ? "" : "s"}`];
  if (t.skipped) bits.push(`${t.skipped} skipped`);
  if (t.failed) bits.push(`${t.failed} failed`);
  const unreached = t.queued - t.digested - t.skipped - t.failed;
  if (t.stopped && unreached > 0) bits.push(`${unreached} not reached (stopped)`);
  if (t.bare) bits.push(`${t.bare} with no highlights`);
  return bits.join(", ");
}
