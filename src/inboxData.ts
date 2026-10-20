// Pure inbox-file logic: parsing inbox.json and appending a CardRevision.
// Kept free of Obsidian imports (see src/util.ts) so InboxStore's disk format
// can be unit-tested with node directly; InboxStore itself imports `obsidian`
// and so cannot be.
import type { CardRevision, InboxData } from "./model";

/** Revisions are kept vault-wide, not per-card, so one number bounds the file. */
export const REVISION_CAP = 200;

/** Remembered highlight instructions are one per file; the cap bounds a vault with thousands of notes. */
export const INSTRUCTION_CAP = 200;

export function emptyInbox(): InboxData {
  return { version: 1, highlights: [] };
}

export type ParsedInbox =
  | { ok: true; data: InboxData; fresh: boolean }
  | { ok: false; reason: "invalid-json" | "bad-shape"; detail: string };

/**
 * Parse the raw contents of inbox.json. Never throws: a truncated write or a
 * hand-edited file becomes a typed failure instead of an exception, so the
 * caller can decide what to do with the bad file rather than losing it.
 *
 * `fresh` distinguishes "no file yet" (empty or whitespace-only, e.g. a file
 * created but never written) from a genuinely corrupt one — both parse to an
 * empty inbox, but only the latter should be moved aside and reported.
 *
 * Deliberately shallow for legacy fields. The optional archive flag is checked
 * when present, so a malformed value cannot silently hide a passage.
 */
export function parseInboxJson(raw: string): ParsedInbox {
  if (raw.trim() === "") return { ok: true, data: emptyInbox(), fresh: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: "invalid-json", detail: (e as Error).message };
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as InboxData).highlights)) {
    return { ok: false, reason: "bad-shape", detail: "parsed JSON is not an inbox object with a highlights array" };
  }
  if ((parsed as InboxData).highlights.some((h) => h && typeof h === "object" && "archived" in h && typeof h.archived !== "boolean")) {
    return { ok: false, reason: "bad-shape", detail: "a highlight has an invalid archive flag" };
  }
  return { ok: true, data: parsed as InboxData, fresh: false };
}

/**
 * Append a card revision, oldest first, dropping from the front once the
 * cap is exceeded. Creates `data.revisions` when this is the first one.
 */
export function pushRevision(data: InboxData, rev: CardRevision, cap = REVISION_CAP): void {
  data.revisions ??= [];
  data.revisions.push(rev);
  if (data.revisions.length > cap) data.revisions.splice(0, data.revisions.length - cap);
}

/**
 * Remember the last instruction the reader gave AI highlight for one file, so
 * the modal opens with it next time. Keys are kept oldest first: setting a
 * file again moves it to the end, and past the cap the least recently used
 * files are forgotten. An empty instruction forgets the file, since an empty
 * box is already the default.
 */
export function rememberInstruction(data: InboxData, path: string, instruction: string, cap = INSTRUCTION_CAP): void {
  const map = (data.highlightInstructions ??= {});
  delete map[path];
  const text = instruction.trim();
  if (!text) return;
  map[path] = text;
  const keys = Object.keys(map);
  for (const k of keys.slice(0, Math.max(0, keys.length - cap))) delete map[k];
}

/**
 * The instruction one generation run reads. An extra instruction typed for
 * "Write more cards" wins for that run only; a blank one falls back to the
 * instruction stored on the highlight. Never writes anything back, so the
 * Ask or quiz-miss instruction the highlight was captured with survives.
 */
export function nextInstruction(base: string | undefined, extra: string): string {
  return extra.trim() ? extra.trim() : (base ?? "");
}
