// Pure PDF++ link parsing and rendering. No `obsidian` import: this module is
// bundled standalone by esbuild and exercised with node --test
// (test/pdflink.test.mjs), the same way src/lint.ts is (see src/lint.ts:1-6).
import { normalizeWs } from "./util";

export interface PdfTarget {
  page: number;
  selection?: { beginIndex: number; beginOffset: number; endIndex: number; endOffset: number };
  annotation?: string;
  rect?: [number, number, number, number];
  /** Normalized: color names verbatim, rgb triplets as "255,208,0". */
  color?: string;
}

export interface PdfReference {
  target: PdfTarget;
  embed: boolean;
  display: string;
  quote: string | null;
  line: number;
  calloutColor: string | null;
}

/** Reference with the PDF basename attached, for findAllPdfReferences. */
export interface PdfReferenceAny extends PdfReference {
  pdfBasename: string;
}

function normalizeColor(raw: string): string {
  const parts = raw.split(",").map((p) => p.trim());
  if (parts.length === 3 && parts.every((p) => /^\d+(\.\d+)?$/.test(p))) {
    return parts.join(",");
  }
  return raw.trim();
}

/** Parse a PDF++ link subpath (with or without a leading '#'). Null when there is no valid page. */
export function parsePdfSubpath(subpath: string): PdfTarget | null {
  const s = subpath.startsWith("#") ? subpath.slice(1) : subpath;
  if (!s) return null;

  const params = new Map<string, string>();
  for (const part of s.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    // Obsidian and PDF++ percent-encode the commas in some links, so a value
    // read raw fails the digit tests below. A malformed escape ("%zz") makes
    // decodeURIComponent throw, and one bad link must not take a whole scan
    // down with it, so the raw text stands in.
    let value = part.slice(eq + 1);
    try {
      value = decodeURIComponent(value);
    } catch {
      // Keep the raw value.
    }
    if (!params.has(key)) params.set(key, value);
  }

  const pageRaw = params.get("page");
  if (pageRaw === undefined || !/^\d+$/.test(pageRaw)) return null;
  const page = Number(pageRaw);

  const target: PdfTarget = { page };

  // A selection or rect that will not parse refuses the whole link rather than
  // falling back to the page. A page-only target looks valid and dedupes by
  // `highlightKey`, so every unparseable highlight on one page would collapse
  // into a single row and the reader would lose distinct highlights. Declining
  // to read the link leaves it exactly as they wrote it.
  const selectionRaw = params.get("selection");
  if (selectionRaw !== undefined) {
    const nums = selectionRaw.split(",").map((n) => n.trim());
    if (nums.length !== 4 || !nums.every((n) => /^\d+$/.test(n))) return null;
    const [a, b, c, d] = nums.map(Number);
    target.selection = { beginIndex: a, beginOffset: b, endIndex: c, endOffset: d };
  }

  const annotationRaw = params.get("annotation");
  if (annotationRaw !== undefined && annotationRaw !== "") {
    target.annotation = annotationRaw;
  }

  const rectRaw = params.get("rect");
  if (rectRaw !== undefined) {
    const nums = rectRaw.split(",").map((n) => n.trim());
    if (nums.length !== 4 || !nums.every((n) => /^\d+(\.\d+)?$/.test(n))) return null;
    target.rect = nums.map(Number) as [number, number, number, number];
  }

  const colorRaw = params.get("color");
  if (colorRaw !== undefined && colorRaw !== "") {
    target.color = normalizeColor(colorRaw);
  }

  return target;
}

/** Split a wikilink's inner text into path, subpath (with leading '#' stripped), and display. */
export function splitLinktext(linktext: string): { path: string; subpath: string; display: string } {
  let rest = linktext;
  let display = "";
  const pipeIdx = rest.indexOf("|");
  if (pipeIdx >= 0) {
    display = rest.slice(pipeIdx + 1);
    rest = rest.slice(0, pipeIdx);
  }
  let path = rest;
  let subpath = "";
  const hashIdx = rest.indexOf("#");
  if (hashIdx >= 0) {
    path = rest.slice(0, hashIdx);
    subpath = rest.slice(hashIdx + 1);
  }
  return { path, subpath, display };
}

/** Canonical subpath rendering: page, then selection|annotation|rect, then color. */
export function renderPdfSubpath(t: PdfTarget): string {
  const parts: string[] = [`page=${t.page}`];
  if (t.selection) {
    const s = t.selection;
    parts.push(`selection=${s.beginIndex},${s.beginOffset},${s.endIndex},${s.endOffset}`);
  } else if (t.annotation !== undefined) {
    parts.push(`annotation=${t.annotation}`);
  } else if (t.rect) {
    parts.push(`rect=${t.rect.join(",")}`);
  }
  if (t.color) parts.push(`color=${t.color}`);
  return parts.join("&");
}

/** Accepts the PDF's name with or without its extension ("Foo" or "Foo.pdf", as in TFile.name) and returns "Foo.pdf". */
export function pdfFileName(pdfBasename: string): string {
  return `${pdfBasename.replace(/\.pdf$/i, "")}.pdf`;
}

export function renderPdfLink(pdfBasename: string, t: PdfTarget, display: string): string {
  return `[[${pdfFileName(pdfBasename)}#${renderPdfSubpath(t)}|${display}]]`;
}

export function renderPdfEmbed(pdfBasename: string, t: PdfTarget, display: string): string {
  return `![[${pdfFileName(pdfBasename)}#${renderPdfSubpath(t)}|${display}]]`;
}

/** Canonical subpath without color: identity for dedupe and "already present" checks. */
export function highlightKey(t: PdfTarget): string {
  return renderPdfSubpath({ ...t, color: undefined });
}

/** PDF++ callout header: [!PDF|yellow], [!PDF|255, 208, 0], or [!PDF]. */
export function calloutHeader(color: string | null): string {
  if (!color) return "[!PDF]";
  const parts = color.split(",").map((p) => p.trim());
  if (parts.length === 3 && parts.every((p) => /^\d+(\.\d+)?$/.test(p))) {
    return `[!PDF|${parts.join(", ")}]`;
  }
  return `[!PDF|${color}]`;
}

/**
 * PDF++ "Quote in callout" shape: `> [!PDF|…] [[link|display]]\n> > text`.
 * A rect target with empty text renders as the embed line instead.
 */
export function renderCallout(pdfBasename: string, t: PdfTarget, display: string, text: string): string {
  if (t.rect && !text) {
    return renderPdfEmbed(pdfBasename, t, display);
  }
  const link = renderPdfLink(pdfBasename, t, display);
  return `> ${calloutHeader(t.color ?? null)} ${link}\n> > ${text}`;
}

const LINK_RE = /(!?)\[\[([^\]]+)\]\]/g;
const CALLOUT_HEADER_RE = /^>\s*\[!pdf(?:\|([^\]]*))?\]/i;

function stripQuotePrefix(line: string): string {
  // Strip one leading '>' (with optional space), then an optional second
  // '>' (with optional space) for the nested callout-quote line.
  let s = line.replace(/^>\s?/, "");
  s = s.replace(/^>\s?/, "");
  return s;
}

/**
 * Find every PDF++ link/embed in `markdown` whose path (folders stripped)
 * equals `pdfFilename` (e.g. "Foo.pdf", as in TFile.name) case-insensitively
 * and whose subpath parses.
 */
export function findPdfReferences(markdown: string, pdfFilename: string): PdfReference[] {
  const wantBase = pdfFilename.replace(/\.pdf$/i, "");
  return findAllPdfReferences(markdown).filter((r) => r.pdfBasename.toLowerCase() === wantBase.toLowerCase());
}

/** Same as findPdfReferences but for any PDF basename found in the text. */
export function findAllPdfReferences(markdown: string): PdfReferenceAny[] {
  const lines = markdown.split("\n");
  const out: PdfReferenceAny[] = [];

  let offset = 0;
  const lineStarts: number[] = [];
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(markdown))) {
    const embed = m[1] === "!";
    const inner = m[2];
    const { path, subpath, display } = splitLinktext(inner);
    if (!subpath) continue;

    const base = path.split("/").pop() ?? path;
    const baseNoExt = base.replace(/\.pdf$/i, "");
    if (!/\.pdf$/i.test(base)) continue;

    const target = parsePdfSubpath(subpath);
    if (!target) continue;

    // Find the line this match starts on.
    let lineIdx = 0;
    for (let i = 0; i < lineStarts.length; i++) {
      if (lineStarts[i] <= m.index) lineIdx = i;
      else break;
    }

    const line = lines[lineIdx];
    const headerMatch = CALLOUT_HEADER_RE.exec(line);
    let quote: string | null = null;
    let calloutColor: string | null = null;
    if (headerMatch) {
      calloutColor = headerMatch[1] !== undefined ? normalizeColor(headerMatch[1]) : null;
      const quoteLines: string[] = [];
      for (let i = lineIdx + 1; i < lines.length; i++) {
        const l = lines[i];
        if (!/^>/.test(l)) break;
        const stripped = stripQuotePrefix(l);
        if (stripped.trim() !== "") quoteLines.push(stripped.trim());
      }
      quote = normalizeWs(quoteLines.join(" "));
    }

    out.push({
      target,
      embed,
      display,
      quote,
      line: lineIdx,
      calloutColor,
      pdfBasename: baseNoExt,
    });
  }

  return out;
}
