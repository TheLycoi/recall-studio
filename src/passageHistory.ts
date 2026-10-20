import type { Highlight } from "./model";

export type PassageLocation = { state: "matched"; start: number; end: number; reason: string } | { state: "changed" | "unresolved" | "missing"; reason: string };

/** Removing highlight syntax does not change the captured quote. Keep a map back to source offsets. */
function unmarked(raw: string): { text: string; offsets: number[] } {
  let text = "";
  const offsets: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw.slice(i, i + 2) === "==") { i++; continue; }
    offsets.push(i);
    text += raw[i];
  }
  offsets.push(raw.length);
  return { text, offsets };
}

export function resolvePassage(raw: string | null, h: Highlight): PassageLocation {
  if (raw === null) return { state: "missing", reason: "Source file is missing; saved history remains available." };
  if (h.page != null || /\.pdf$/i.test(h.sourcePath)) return { state: "unresolved", reason: "PDF page locator retained; passage text is not verified against the PDF." };
  if (!h.text) return { state: "unresolved", reason: "No captured quote to locate." };
  const { text, offsets } = unmarked(raw);
  const locations: number[] = [];
  for (let at = text.indexOf(h.text); at !== -1; at = text.indexOf(h.text, at + 1)) locations.push(at);
  if (h.blockId) {
    const escaped = h.blockId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const anchors = [...text.matchAll(new RegExp(`\\^${escaped}(?=[ \\t]*(?:\\r?$))`, "gm"))];
    if (anchors.length > 1) return { state: "unresolved", reason: "Block ID occurs more than once." };
    if (anchors.length === 1) {
      const anchor = anchors[0].index!;
      const preceding = text.slice(0, anchor);
      const blank = [...preceding.matchAll(/\r?\n[ \t]*\r?\n/g)].at(-1);
      const previousIds = [...preceding.matchAll(/\^[A-Za-z0-9-]+[ \t]*\r?\n/g)];
      const previous = previousIds.at(-1);
      const start = Math.max(blank ? blank.index! + blank[0].length : 0, previous ? previous.index! + previous[0].length : 0);
      const found = locations.filter((at) => at >= start && at + h.text.length <= anchor);
      if (found.length === 0) return { state: "changed", reason: "Block ID remains, but its captured quote has changed." };
      if (found.length > 1) return { state: "unresolved", reason: "Quote repeats within its block." };
      // shortcut: without a host AST range, only quotes touching the anchor's line are verified by an ID.
      const anchorLine = text.lastIndexOf("\n", anchor) + 1;
      if (found[0] + h.text.length <= anchorLine) return { state: "unresolved", reason: "Quote precedes the anchored line; its block range cannot be verified." };
      return { state: "matched", start: offsets[found[0]], end: offsets[found[0] + h.text.length - 1] + 1, reason: "Exact quote at saved block ID." };
    }
  }
  if (!locations.length) return { state: "changed", reason: "Exact captured quote no longer occurs in the source." };
  if (locations.length === 1) {
    const at = locations[0];
    return { state: "matched", start: offsets[at], end: offsets[at + h.text.length - 1] + 1, reason: "Unique exact quote." };
  }
  // The saved line is only a hint. Repeated text needs distinguishing context on at least one side.
  const before = h.before.replace(/==/g, "").trim();
  const after = h.after.replace(/==/g, "").trim();
  const matching = locations.filter((at) =>
    (!before || text.slice(0, at).trimEnd().endsWith(before)) &&
    (!after || text.slice(at + h.text.length).trimStart().startsWith(after)),
  );
  if ((before || after) && matching.length === 1) {
    const at = matching[0];
    return { state: "matched", start: offsets[at], end: offsets[at + h.text.length - 1] + 1, reason: "Exact quote and unique surrounding context." };
  }
  return { state: "unresolved", reason: matching.length > 1 ? "Quote and context occur more than once." : "Repeated quote has no uniquely matching context." };
}

export function passageSummary(h: Highlight) {
  const cards = h.cards.filter((c) => c.status !== "deleted");
  const confirmedAnki = cards.filter((c) => c.status === "exported" && Number.isSafeInteger(c.ankiNoteId) && (c.ankiNoteId ?? 0) > 0).length;
  const fileUnconfirmed = cards.filter((c) => c.status === "exported" && !(Number.isSafeInteger(c.ankiNoteId) && (c.ankiNoteId ?? 0) > 0)).length;
  const awaiting = cards.filter((c) => c.status === "pending" || c.status === "approved" || c.status === "flagged").length;
  return {
    locator: h.page == null ? (h.heading ?? h.sourcePath) : `page ${h.page}${h.subpath ? ` · ${h.subpath}` : ""}`,
    counts: { created: cards.length, awaiting, confirmedAnki, fileUnconfirmed,
      partial: confirmedAnki + fileUnconfirmed > 0 && awaiting > 0,
      full: cards.length > 0 && confirmedAnki + fileUnconfirmed === cards.length,
      noCards: cards.length === 0, dismissed: h.status === "dismissed" },
  };
}

export function passageLabel(h: Highlight): string {
  const { counts: c } = passageSummary(h);
  if (c.dismissed && c.noCards) return "Dismissed · no cards";
  if (c.noCards) return "Captured · no cards";
  return `${c.created} card${c.created === 1 ? "" : "s"} created · ${c.awaiting} awaiting · ${c.confirmedAnki} Anki confirmed${c.fileUnconfirmed ? ` · ${c.fileUnconfirmed} export unconfirmed` : ""}`;
}
