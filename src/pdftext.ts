/**
 * Text extraction over pdf.js page data, ported from PDF++ 0.40.31
 * (MIT, Ryota Ushio; see NOTICE).
 *
 * Obsidian-free and pdf.js-free by design: every function here takes plain
 * data (the `items` array of `page.getTextContent({ includeChars: true })`
 * and the array of `page.getAnnotations()`) and returns plain data, so
 * test/pdftext.test.mjs can bundle this module standalone with esbuild and
 * run it under `node --test`. The caller (src/pdfHighlights.ts) owns the
 * pdf.js document and hands the shapes over.
 *
 * The pdf.js shapes below (`chars[].u`, `chars[].r`, `includeChars`) are what
 * PDF++ relies on in Obsidian's bundled pdf.js build; they are verified live
 * in T6, not here.
 */
import { contextWindow, locateQuote, normalizeWs } from "./util";

/** `[minX, minY, maxX, maxY]` in PDF user space (y grows upward). */
export type Rect = [number, number, number, number];

/** One glyph: `u` is the unicode text, `r` its bounding box. */
export interface TextChar {
  u: string;
  r: Rect;
}

/** One text item of `getTextContent({ includeChars: true }).items`. */
export interface TextItem {
  str: string;
  hasEOL?: boolean;
  chars?: TextChar[];
}

/** One entry of `page.getAnnotations()`, narrowed to what we read. */
export interface Annot {
  id: string;
  subtype: string;
  /** Either a flat sequence of 8 numbers per quad, or an array of point quads. */
  quadPoints?: ArrayLike<number> | Array<Array<{ x: number; y: number }>>;
  /** `[r, g, b]`, either 0..1 or 0..255 depending on the pdf.js build. */
  color?: ArrayLike<number> | null;
  contentsObj?: { str?: string } | null;
}

/** A position inside `items`: which item, which char offset. */
export interface TextPos {
  index: number;
  offset: number;
}

/** The result of reading one rectangle: PDF++'s `getTextByRect` return. */
export interface RectText {
  text: string;
  from: TextPos;
  to: TextPos;
}

/** A `selection=a,b,c,d` subpath, resolved against `items`. */
export interface SelectionRange {
  beginIndex: number;
  beginOffset: number;
  endIndex: number;
  endOffset: number;
}

/** One embedded text-markup annotation with its extracted text. */
export interface AnnotationHighlight {
  id: string;
  subtype: string;
  /** `"r,g,b"` with components in 0..255, or null when the annot has no colour. */
  color: string | null;
  rects: Rect[];
  text: string;
  /** Where the text starts in `items`; `{index:-1, offset:-1}` when nothing matched. */
  from: TextPos;
  /** Top edge of the first quad, used as the fallback sort key. */
  top: number;
  /** The annotation's popup note, when it has one. */
  comment: string | null;
}

/** The four text-markup subtypes PDF++ treats as highlights. */
const MARKUP_SUBTYPES = ["Highlight", "Underline", "Squiggly", "StrikeOut"];

function isPointQuads(q: unknown): q is Array<Array<{ x: number; y: number }>> {
  return Array.isArray(q) && q.length > 0 && Array.isArray(q[0]);
}

/**
 * Convert an annotation's `quadPoints` to rectangles.
 *
 * PDF++ `dg(n)`:
 *   if (ArrayBuffer.isView(n)) { if (n.length % 8) return []; for (t = 0; t < n.length; t += 8)
 *     { let [i,r,o,s,a,c,l,d] = n.slice(t, t+8), h = Math.min(i,o,a,l), u = Math.max(i,o,a,l),
 *       p = Math.min(r,s,c,d), f = Math.max(r,s,c,d); e.push([h,p,u,f]) } return e }
 *   for (let t of n) { let i = t[1], r = t[2], o = [r.x, r.y, i.x, i.y];
 *     o = window.pdfjsLib.Util.normalizeRect(o); e.push(o) }
 *
 * Two shapes, because pdf.js changed the representation: a flat (typed) array
 * of 8 numbers per quad, or an array of 4-point quads. `normalizeRect` is
 * inlined here as min/max per axis — a pure module cannot reach pdfjsLib.
 */
export function quadPointsToRects(quadPoints: Annot["quadPoints"] | null | undefined): Rect[] {
  const out: Rect[] = [];
  if (!quadPoints) return out;

  if (isPointQuads(quadPoints)) {
    for (const quad of quadPoints) {
      if (!quad || quad.length < 3) continue;
      const p1 = quad[1];
      const p2 = quad[2];
      if (!p1 || !p2) continue;
      out.push(normalizeRect([p2.x, p2.y, p1.x, p1.y]));
    }
    return out;
  }

  const flat = quadPoints as ArrayLike<number>;
  const n = flat.length;
  // A flat quadPoints array carries 8 numbers (4 points) per quad. Anything
  // else is a shape we do not understand, and PDF++ bails on the whole
  // annotation rather than guessing at a partial quad.
  if (n === 0 || n % 8 !== 0) return out;
  for (let t = 0; t < n; t += 8) {
    const x1 = flat[t], y1 = flat[t + 1];
    const x2 = flat[t + 2], y2 = flat[t + 3];
    const x3 = flat[t + 4], y3 = flat[t + 5];
    const x4 = flat[t + 6], y4 = flat[t + 7];
    out.push([
      Math.min(x1, x2, x3, x4),
      Math.min(y1, y2, y3, y4),
      Math.max(x1, x2, x3, x4),
      Math.max(y1, y2, y3, y4),
    ]);
  }
  return out;
}

/** `pdfjsLib.Util.normalizeRect`: order each axis so min comes first. */
function normalizeRect(r: [number, number, number, number]): Rect {
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

/**
 * Read the text inside `rect`, in item order.
 *
 * PDF++ `getTextByRect(e, t)`:
 *   let [i,r,o,s] = t, a = "", c = {index:-1, offset:-1}, l = {index:-1, offset:-1};
 *   for (let d = 0; d < e.length; d++) { let h = e[d];
 *     if (h.chars && h.chars.length) for (let u = 0; u < h.chars.length; u++) {
 *       let p = h.chars[u], f = (p.r[0]+p.r[2])/2, m = (p.r[1]+p.r[3])/2;
 *       i <= f && f <= o && r <= m && m <= s && (a += p.u,
 *         c.index === -1 && c.offset === -1 && (c = {index:d, offset:u}),
 *         l = {index:d, offset:u+1}) } }
 *   return { text: a, from: c, to: l }
 *
 * The test is the char's *centre* against inclusive bounds, so a glyph
 * straddling the edge of a hand-drawn highlight is in or out by its middle.
 * Items without `chars` contribute nothing: without per-char geometry there
 * is no way to know which part of the item the rect covers.
 */
export function textInRect(items: TextItem[], rect: Rect): RectText {
  const [left, bottom, right, top] = rect;
  let text = "";
  const from: TextPos = { index: -1, offset: -1 };
  let to: TextPos = { index: -1, offset: -1 };
  for (let d = 0; d < items.length; d++) {
    const item = items[d];
    if (!item.chars || !item.chars.length) continue;
    for (let u = 0; u < item.chars.length; u++) {
      const ch = item.chars[u];
      if (!ch || !ch.r) continue;
      const cx = (ch.r[0] + ch.r[2]) / 2;
      const cy = (ch.r[1] + ch.r[3]) / 2;
      if (left <= cx && cx <= right && bottom <= cy && cy <= top) {
        text += ch.u;
        if (from.index === -1 && from.offset === -1) {
          from.index = d;
          from.offset = u;
        }
        to = { index: d, offset: u + 1 };
      }
    }
  }
  return { text, from, to };
}

/**
 * Collapse the line breaks of extracted PDF text into one line.
 *
 * PDF++ `Yc(n)` (CJK handling dropped — it needs a CJK character class and a
 * setting we do not have; `removeWhitespaceBetweenCJChars` defaults off):
 *   n.replace(/(.?)([\r\n]+)(.?)/g, (i, r, o, s) =>
 *     r === "-" && s.match(/[a-zA-Z]/) ? s : s ? r + " " + s : r)
 *
 * So a hyphen at a line end before a letter is a syllable break and both the
 * hyphen and the newline go; every other break becomes a single space.
 */
export function singleLine(s: string): string {
  return s.replace(/(.?)([\r\n]+)(.?)/g, (_m, before: string, _nl: string, after: string) => {
    if (before === "-" && /[a-zA-Z]/.test(after)) return after;
    return after ? `${before} ${after}` : before;
  });
}

/**
 * Normalize an annotation colour to `"r,g,b"` with components in 0..255.
 *
 * PDF's own colour space is 0..1, but Obsidian's pdf.js build has been seen
 * to hand back 0..255 already. Scale only when every component is within
 * 0..1 *and* at least one is fractional: `[1, 0, 0]` is ambiguous, and pure
 * red is far likelier than a near-black `[1,0,0]/255`, so leave it alone.
 * The exact behaviour of this build is verified live in T6.
 */
function normalizeColor(color: Annot["color"]): string | null {
  if (!color || color.length < 3) return null;
  const raw = [Number(color[0]), Number(color[1]), Number(color[2])];
  if (raw.some((n) => !Number.isFinite(n))) return null;
  const allUnit = raw.every((n) => n >= 0 && n <= 1);
  const anyFractional = raw.some((n) => !Number.isInteger(n));
  const scaled = allUnit && anyFractional ? raw.map((n) => Math.round(n * 255)) : raw.map((n) => Math.round(n));
  return scaled.join(",");
}

/**
 * Extract every text-markup annotation of a page with its underlying text.
 *
 * PDF++ `getAnnotatedTextsInPage(e)`:
 *   let [{items:t}, i] = await Promise.all([e.getTextContent({includeChars:!0}), e.getAnnotations()]), r = [];
 *   for (let s of i) { if (!["Highlight","Underline","Squiggly","StrikeOut"].includes(s.subtype)) continue;
 *     let c = dg(s.quadPoints); if (!c.length) continue;
 *     let l = c.map(u => this.getTextByRect(t, u)),
 *       d = s.color ? {r: s.color[0], g: s.color[1], b: s.color[2]} : null,
 *       h = s.contentsObj?.str;
 *     r.push({id: s.id, textRanges: l, rgb: d, comment: h, left: c[0][0], top: c[0][3]}) }
 *   return new Map(r.sort((s,a) => {
 *       if (s.textRanges.length && a.textRanges.length) {
 *         let c = s.textRanges[0].from, l = a.textRanges[0].from;
 *         return c.index - l.index || c.offset - l.offset }
 *       return a.top - s.top || s.left - a.left })
 *     .map(s => { let a = s.textRanges.map(c => c.text).join("\n");
 *       a = this.lib.toSingleLine(a); return [s.id, {text: a, rgb: s.rgb, comment: s.comment}] }))
 *
 * The sort reads oddly: `textRanges.length` is the number of *quads*, not the
 * number of quads that matched text, so two annotations with quads always
 * compare by their first quad's `from` — which is `{-1,-1}` when nothing
 * matched, i.e. text-less annotations sort to the front. That is PDF++'s
 * behaviour and it is kept, so a page reads the same way in both plugins;
 * only annotations whose quadPoints produced no rect at all fall through to
 * the geometric top/left comparison.
 */
export function annotationHighlights(items: TextItem[], annots: Annot[]): AnnotationHighlight[] {
  interface Row extends AnnotationHighlight {
    ranges: RectText[];
    left: number;
  }
  const rows: Row[] = [];
  for (const annot of annots ?? []) {
    if (!annot || !MARKUP_SUBTYPES.includes(annot.subtype)) continue;
    const rects = quadPointsToRects(annot.quadPoints);
    if (!rects.length) continue;
    const ranges = rects.map((r) => textInRect(items, r));
    const text = singleLine(ranges.map((r) => r.text).join("\n"));
    const comment = annot.contentsObj?.str ? annot.contentsObj.str : null;
    rows.push({
      id: annot.id,
      subtype: annot.subtype,
      color: normalizeColor(annot.color),
      rects,
      text,
      from: ranges[0].from,
      top: rects[0][3],
      comment,
      ranges,
      left: rects[0][0],
    });
  }
  rows.sort((a, b) => {
    if (a.ranges.length && b.ranges.length) {
      return a.ranges[0].from.index - b.ranges[0].from.index || a.ranges[0].from.offset - b.ranges[0].from.offset;
    }
    return b.top - a.top || a.left - b.left;
  });
  return rows.map(({ ranges, left, ...rest }) => rest);
}

/**
 * Resolve a `selection=beginIndex,beginOffset,endIndex,endOffset` subpath
 * against the page's text items. Returns null when the indices are out of
 * range — a callout's own quote is authoritative, so the caller falls back to
 * it rather than inventing text.
 *
 * PDF++ `getSelectedText(e, t, i, r, o)`:
 *   if (t === r) return this.toSingleLine(e[t].str.slice(i, o));
 *   let s = []; s.push(e[t].str.slice(i));
 *   for (let a = t+1; a < r; a++) s.push(e[a].str);
 *   return s.push(e[r].str.slice(0, o)), this.toSingleLine(s.join("\n"))
 *
 * The pieces are joined with a newline and then single-lined, which turns
 * each join into one space.
 */
export function selectionText(items: TextItem[], sel: SelectionRange): string | null {
  const { beginIndex, beginOffset, endIndex, endOffset } = sel;
  if (!Number.isInteger(beginIndex) || !Number.isInteger(endIndex)) return null;
  if (beginIndex < 0 || endIndex < 0 || beginIndex >= items.length || endIndex >= items.length) return null;
  if (endIndex < beginIndex) return null;
  if (beginOffset < 0 || endOffset < 0) return null;
  if (beginIndex === endIndex) {
    if (endOffset < beginOffset) return null;
    return singleLine(items[beginIndex].str.slice(beginOffset, endOffset));
  }
  const parts: string[] = [items[beginIndex].str.slice(beginOffset)];
  for (let i = beginIndex + 1; i < endIndex; i++) parts.push(items[i].str);
  parts.push(items[endIndex].str.slice(0, endOffset));
  return singleLine(parts.join("\n"));
}

/**
 * The whole page as readable text: items joined by a newline where the item
 * ends a line and a space otherwise, then whitespace-collapsed. This is the
 * haystack `contextFor` searches and, page by page, the paper text the digest
 * prompt sees.
 */
export function pageText(items: TextItem[]): string {
  let out = "";
  for (let i = 0; i < items.length; i++) {
    out += items[i].str ?? "";
    if (i < items.length - 1) out += items[i].hasEOL ? "\n" : " ";
  }
  return normalizeWs(out);
}

/**
 * Locate `text` in the page and return the surrounding context, so a
 * highlight carries the sentence it came out of into the card writer.
 * Empty strings when the text cannot be located.
 */
export function contextFor(
  page: string,
  text: string,
  chars: number,
): { before: string; after: string } {
  const trimmed = (text ?? "").trim();
  if (!trimmed || !page) return { before: "", after: "" };
  const found = locateQuote(page, trimmed);
  if (!found) return { before: "", after: "" };
  return contextWindow(page, found.start, found.end, chars);
}

/**
 * Whether this pdf.js build gave us per-character geometry. Without it every
 * rect-based extraction (embedded annotations, rect embeds) yields empty
 * text, and the caller warns once instead of writing empty highlights
 * silently.
 */
export function hasCharGeometry(items: TextItem[]): boolean {
  return (items ?? []).some((it) => Array.isArray(it.chars) && it.chars.length > 0);
}

/**
 * Join per-page text into the paper text the digest prompt sees. The `[page N]`
 * markers exist so the model can cite a page by eye in a summary; nothing
 * parses them back.
 */
export function joinPages(pages: string[]): string {
  return pages.map((text, i) => `[page ${i + 1}]\n${text}`).join("\n\n");
}
