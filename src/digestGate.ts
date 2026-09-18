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
