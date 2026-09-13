// Offset-preserving view of a PDF page's text items, so a quote found in the
// page text can be turned back into a `selection=a,b,c,d` subpath. `pageText`
// (src/pdftext.ts:323-331) ends in `normalizeWs`, which collapses runs of
// whitespace and trims: the result is readable but not invertible, so an
// offset into it cannot be mapped back to an item index and char offset. This
// module builds the same join WITHOUT the normalization and records where each
// item starts, which makes the mapping exact. No `obsidian` import: bundled
// standalone and exercised with node --test (test/pageMap.test.mjs).
import { selectionText, type SelectionRange, type TextItem, type TextPos } from "./pdftext";
import { locateQuote, normalizeWs } from "./util";

/**
 * A page's items with the raw joined text and the offset each item starts at.
 * `text` joins `items[i].str` with "\n" when the item ends a line and " "
 * otherwise — the `pageText` rule minus `normalizeWs`, so
 * `starts[i] + items[i].str.length <= text.length` always holds.
 */
export interface PageMap {
  text: string;
  starts: number[];
  items: TextItem[];
}

export function buildPageMap(items: TextItem[]): PageMap {
  const list = items ?? [];
  const starts: number[] = new Array(list.length);
  let out = "";
  for (let i = 0; i < list.length; i++) {
    starts[i] = out.length;
    out += list[i]?.str ?? "";
    if (i < list.length - 1) out += list[i]?.hasEOL ? "\n" : " ";
  }
  return { text: out, starts, items: list };
}

interface Normalized {
  text: string;
  /** Raw offset of each kept character; for a collapsed run, the run's first char. */
  normToRaw: number[];
}

/**
 * Collapse every whitespace run in `raw` to a single space, without trimming,
 * keeping a raw offset for every character that survives. Not trimming matters:
 * the indices stay usable for a leading-whitespace page.
 */
function normalizeWithMap(raw: string): Normalized {
  let text = "";
  const normToRaw: number[] = [];
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (/\s/.test(ch)) {
      const runStart = i;
      while (i < raw.length && /\s/.test(raw[i])) i++;
      text += " ";
      normToRaw.push(runStart);
      continue;
    }
    text += ch;
    normToRaw.push(i);
    i++;
  }
  return { text, normToRaw };
}

/**
 * Find `quote` in the page's raw text. Exact `indexOf` first; otherwise the
 * whitespace-collapsed copy, mapped back to raw offsets. A fuzzy hit from
 * `locateQuote` (src/util.ts:42-70) is only accepted when the matched text
 * really is the quote modulo whitespace and case — the fuzzy regex path can
 * span text that differs from the quote, and a wrong selection is worse than
 * none.
 */
export function locateInPage(map: PageMap, quote: string): { start: number; end: number } | null {
  const q = (quote ?? "").trim();
  if (!q) return null;

  const exact = map.text.indexOf(q);
  if (exact >= 0) return { start: exact, end: exact + q.length };

  const norm = normalizeWithMap(map.text);
  const hit = locateQuote(norm.text, q);
  if (!hit) return null;
  if (hit.start < 0 || hit.end > norm.normToRaw.length || hit.end <= hit.start) return null;
  if (!hit.exact) {
    const got = normalizeWs(norm.text.slice(hit.start, hit.end)).toLowerCase();
    if (got !== normalizeWs(q).toLowerCase()) return null;
  }
  return { start: norm.normToRaw[hit.start], end: norm.normToRaw[hit.end - 1] + 1 };
}

/** Largest i with starts[i] <= offset, or -1 when there is none. */
function itemAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= offset) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * Map a raw offset into `map.text` to a position in `items`. The join
 * characters between items belong to no item, so an offset landing on one is
 * pushed to the nearest real character: an exclusive `"end"` clamps back to the
 * end of the preceding item, a `"begin"` advances to the start of the next, and
 * a selection therefore never begins or ends on a separator.
 */
export function offsetToPos(map: PageMap, offset: number, side: "begin" | "end"): TextPos {
  const { starts, items } = map;
  if (items.length === 0) return { index: 0, offset: 0 };

  const clamped = Math.max(0, Math.min(offset, map.text.length));
  if (side === "end") {
    // An exclusive end of 0 or less has no preceding character.
    const idx = Math.max(0, itemAt(starts, Math.max(0, clamped - 1)));
    const len = items[idx]?.str?.length ?? 0;
    const within = clamped - starts[idx];
    return { index: idx, offset: Math.max(0, Math.min(within, len)) };
  }

  const idx = Math.max(0, itemAt(starts, clamped));
  const len = items[idx]?.str?.length ?? 0;
  const within = clamped - starts[idx];
  if (within >= len && idx + 1 < items.length) return { index: idx + 1, offset: 0 };
  return { index: idx, offset: Math.max(0, Math.min(within, len)) };
}

/**
 * Turn a quote into the selection range that reproduces it, or null. The
 * round-trip through `selectionText` (src/pdftext.ts:301-315) is the oracle:
 * it is the same algorithm PDF++ uses to render `selection=` back to text, so
 * a range that does not reproduce the quote there would not reproduce it in
 * the viewer either.
 */
export function selectionFor(map: PageMap, quote: string): SelectionRange | null {
  const span = locateInPage(map, quote);
  if (!span) return null;
  const begin = offsetToPos(map, span.start, "begin");
  const end = offsetToPos(map, span.end, "end");
  const sel: SelectionRange = {
    beginIndex: begin.index,
    beginOffset: begin.offset,
    endIndex: end.index,
    endOffset: end.offset,
  };
  const got = selectionText(map.items, sel);
  if (got === null) return null;
  if (normalizeWs(got).toLowerCase() !== normalizeWs(quote).toLowerCase()) return null;
  return sel;
}
