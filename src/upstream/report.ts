/**
 * The lines WikiLM's upstream reports share: ingest's report
 * (src/upstream/ingest.ts) and the notice after each lint operation
 * (src/upstream/lint.ts) say what the guard did in the same words, and turn
 * a run away with the same reason.
 */
import type WikiLmPlugin from "../main";
import { describeLoss, type GuardRefusal } from "./guardedVault";

/** What stops a run from starting: another run holding the token. Null when nothing does. */
export function busy(plugin: WikiLmPlugin): string | null {
  if (!plugin.cancel.active) return null;
  const running = plugin.cancel.label ? ` (${plugin.cancel.label})` : "";
  return `another run is still going${running}. Start this once it finishes, or stop it from the status bar`;
}

/**
 * What the guard did in a run, as the reader reads it: each page it kept as
 * it was and why, then where the earlier texts are saved. Ingest's report and
 * the lint's (src/upstream/lint.ts) end with these lines.
 */
export function guardLines(kept: GuardRefusal[], snapshots: string | undefined): string[] {
  const lines: string[] = [];
  if (kept.length > 0) lines.push("Not updated, to keep what was there:", ...kept.map(keptLine));
  if (snapshots) lines.push(`The text each page had before this run is saved in ${snapshots}.`);
  return lines;
}

/** A page the guard kept, and why, as the reader reads it. */
function keptLine(k: GuardRefusal): string {
  if (k.detail) return `- ${k.path}: ${k.detail}; it was left as it was.`;
  if (k.action === "remove") return `- ${k.path}: the engine asked to remove it; it was left in place.`;
  if (k.action === "rename") return `- ${k.path}: the engine asked to move it to ${k.to}; it was left where it is.`;
  return `- ${k.path}: the rewrite would have dropped ${describeLoss(k.lost)}. The proposed text is saved at ${k.proposal}.`;
}

/** A message as a sentence: one full stop at the end, never two. */
export function sentence(s: string): string {
  return `${s.trim().replace(/[.\s]+$/, "")}.`;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
