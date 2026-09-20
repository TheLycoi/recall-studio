// Pure inbox-file logic: parsing inbox.json and appending a CardRevision.
// Kept free of Obsidian imports (see src/util.ts) so InboxStore's disk format
// can be unit-tested with node directly; InboxStore itself imports `obsidian`
// and so cannot be.
import type { CardRevision, InboxData } from "./model";

/** Revisions are kept vault-wide, not per-card, so one number bounds the file. */
export const REVISION_CAP = 200;

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
 * Deliberately shallow: only `highlights` being an array is checked, the same
 * depth the store always validated at. A stricter check here would reject old
 * files that predate a field added later.
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
