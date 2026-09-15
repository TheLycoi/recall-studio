// Pure manifest model: render/parse the wikilm-manifest note format, and the
// merge/sort helpers that build it. No `obsidian` import (see src/lint.ts:1-6);
// bundled standalone and exercised with node --test (test/manifest.test.mjs).
import { splitFrontmatter, normalizeWs } from "./util";
import { calloutHeader, highlightKey, parsePdfSubpath, renderPdfLink, type PdfTarget } from "./pdflink";

export interface ManifestHighlight {
  id: string;
  key: string;
  page: number;
  kind: "selection" | "annotation" | "rect";
  color: string | null;
  target: PdfTarget;
  text: string;
  before: string;
  after: string;
  origins: string[];
}

export interface Manifest {
  pdfPath: string;
  pdfBasename: string;
  classCode: string;
  extracted: string;
  sources: string[];
  highlights: ManifestHighlight[];
}

export const MANIFEST_CONTEXT_CHARS = 150;

function kindOf(t: PdfTarget): "selection" | "annotation" | "rect" {
  if (t.selection) return "selection";
  if (t.annotation !== undefined) return "annotation";
  return "rect";
}

/**
 * Order highlights for stable id assignment: by page, then by position
 * within the page. Selections sort by their begin index/offset. Annotations
 * and rects carry no positional data at this layer (that lives upstream in
 * pdf.js text-content order); they sort after the page's selections, in the
 * order they were given.
 */
export function sortAndAssignIds(highlights: ManifestHighlight[], prefix = "H"): ManifestHighlight[] {
  const indexed = highlights.map((h, i) => ({ h, i }));
  indexed.sort((a, b) => {
    if (a.h.page !== b.h.page) return a.h.page - b.h.page;
    const posA = positionKey(a.h);
    const posB = positionKey(b.h);
    if (posA !== posB) return posA - posB;
    return a.i - b.i;
  });
  const digits = Math.max(2, String(indexed.length).length);
  return indexed.map(({ h }, i) => ({ ...h, id: `${prefix}${String(i + 1).padStart(digits, "0")}` }));
}

function positionKey(h: ManifestHighlight): number {
  if (h.kind === "selection" && h.target.selection) {
    const s = h.target.selection;
    return s.beginIndex * 1000 + s.beginOffset;
  }
  return 1e9;
}

/**
 * Merge highlights that describe the same location: same `key` collapse to
 * one entry (origins unioned, first non-empty text kept); a selection and an
 * annotation on the same page whose text is equal after normalizeWs+lowercase
 * collapse to one entry keyed by the annotation (origins unioned).
 */
export function mergeHighlights(highlights: ManifestHighlight[]): ManifestHighlight[] {
  const byKey = new Map<string, ManifestHighlight>();
  const order: string[] = [];

  for (const h of highlights) {
    const existing = byKey.get(h.key);
    if (existing) {
      existing.text = existing.text || h.text;
      existing.origins = Array.from(new Set([...existing.origins, ...h.origins]));
      continue;
    }
    byKey.set(h.key, { ...h, origins: [...h.origins] });
    order.push(h.key);
  }

  // Second pass: fold a selection into an annotation on the same page with
  // equal text (or vice versa), keyed by the annotation.
  const merged: ManifestHighlight[] = order.map((k) => byKey.get(k)!);
  const result: ManifestHighlight[] = [];
  const consumed = new Set<number>();

  for (let i = 0; i < merged.length; i++) {
    if (consumed.has(i)) continue;
    const a = merged[i];
    if (a.kind !== "selection" && a.kind !== "annotation") {
      result.push(a);
      continue;
    }
    let match: { h: ManifestHighlight; idx: number } | null = null;
    for (let j = 0; j < merged.length; j++) {
      if (j === i || consumed.has(j)) continue;
      const b = merged[j];
      if (b.page !== a.page) continue;
      if (!((a.kind === "selection" && b.kind === "annotation") || (a.kind === "annotation" && b.kind === "selection")))
        continue;
      if (!a.text || !b.text) continue;
      if (normalizeWs(a.text).toLowerCase() !== normalizeWs(b.text).toLowerCase()) continue;
      match = { h: b, idx: j };
      break;
    }
    if (match) {
      const annotationEntry = a.kind === "annotation" ? a : match.h;
      const selectionEntry = a.kind === "selection" ? a : match.h;
      const combined: ManifestHighlight = {
        ...annotationEntry,
        text: annotationEntry.text || selectionEntry.text,
        origins: Array.from(new Set([...annotationEntry.origins, ...selectionEntry.origins])),
      };
      result.push(combined);
      consumed.add(i);
      consumed.add(match.idx);
    } else {
      result.push(a);
    }
  }

  return result;
}

export function manifestPath(folder: string, pdfBasename: string): string {
  return `${folder}/${pdfBasename}.md`;
}

function renderFrontmatter(m: Manifest): string {
  const fromBacklinks = m.highlights.filter((h) => h.origins.some((o) => o !== "pdf annotation")).length;
  const fromPdfAnnotations = m.highlights.filter((h) => h.origins.includes("pdf annotation")).length;
  const withoutText = m.highlights.filter((h) => !h.text).length;
  const sourcesJson = `[${m.sources.map((s) => `"${s}"`).join(", ")}]`;
  const lines = [
    "---",
    "type: wikilm-manifest",
    `pdf: "${m.pdfPath}"`,
    `pdf_link: "[[${m.pdfBasename}.pdf]]"`,
    `class: ${m.classCode}`,
    `extracted: ${m.extracted}`,
    `highlights: ${m.highlights.length}`,
    `from_backlinks: ${fromBacklinks}`,
    `from_pdf_annotations: ${fromPdfAnnotations}`,
    `without_text: ${withoutText}`,
    `sources: ${sourcesJson}`,
    "---",
  ];
  return lines.join("\n");
}

function renderHighlightBlock(pdfBasename: string, h: ManifestHighlight): string {
  const link = renderPdfLink(pdfBasename, h.target, `p.${h.page}`);
  const header = calloutHeader(h.color);
  const lines: string[] = [];
  lines.push(`> ${header} ${link}`);
  lines.push(`> > ${h.text}`);
  lines.push(">");
  lines.push(`> id:: ${h.id}`);
  lines.push(`> page:: ${h.page}`);
  lines.push(`> kind:: ${h.kind}`);
  lines.push(`> color:: ${h.color ?? ""}`);
  lines.push(`> origin:: ${h.origins.join("; ")}`);
  lines.push(`> before:: ${h.before}`);
  lines.push(`> after:: ${h.after}`);
  return lines.join("\n");
}

export function renderManifest(m: Manifest): string {
  const parts: string[] = [];
  parts.push(renderFrontmatter(m));
  parts.push("");
  parts.push(`# Highlights: ${m.pdfBasename}`);
  parts.push("");
  parts.push(
    "Extracted by Recall. One callout per highlight; the callout title link is the PDF++ link reused in topic notes (display text `p.N`). Fields are `key:: value`. Re-running the extract command overwrites this file.",
  );
  for (const h of m.highlights) {
    parts.push("");
    parts.push(renderHighlightBlock(m.pdfBasename, h));
  }
  return parts.join("\n") + "\n";
}

const HIGHLIGHT_HEADER_RE = /^>\s*\[!PDF(?:\|[^\]]*)?\]\s*\[\[(.+?)\]\]$/i;
const FIELD_RE = /^>\s*([a-z]+)::\s?(.*)$/;

function parseScalar(frontmatter: string, key: string): string | null {
  const re = new RegExp(`^${key}:\\s*"?(.*?)"?\\s*$`, "m");
  const m = re.exec(frontmatter);
  if (!m) return null;
  return m[1];
}

function parseSources(frontmatter: string): string[] {
  const m = /^sources:\s*\[(.*)\]\s*$/m.exec(frontmatter);
  if (!m) return [];
  const inner = m[1].trim();
  if (!inner) return [];
  return inner
    .split(",")
    .map((s) => s.trim().replace(/^"(.*)"$/, "$1"));
}

export function parseManifest(md: string): Manifest {
  const { body } = splitFrontmatter(md);
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  const frontmatter = fmMatch ? fmMatch[1] : "";

  const pdfPath = parseScalar(frontmatter, "pdf") ?? "";
  const classCode = parseScalar(frontmatter, "class") ?? "";
  const extracted = parseScalar(frontmatter, "extracted") ?? "";
  const sources = parseSources(frontmatter);

  const pdfLink = parseScalar(frontmatter, "pdf_link") ?? "";
  const linkMatch = /\[\[(.+?)\.pdf\]\]/i.exec(pdfLink);
  const pdfBasename = linkMatch ? linkMatch[1] : "";

  const blocks = body.split(/\n\s*\n/);
  const highlights: ManifestHighlight[] = [];
  let ordinal = 0;

  for (const block of blocks) {
    const nonEmpty = block.split("\n");
    if (nonEmpty.length === 0) continue;
    const headerLine = nonEmpty[0];
    const headerMatch = HIGHLIGHT_HEADER_RE.exec(headerLine.trim());
    if (!headerMatch) continue;

    const linkInner = headerMatch[1];
    const pipeIdx = linkInner.indexOf("|");
    const linkPath = pipeIdx >= 0 ? linkInner.slice(0, pipeIdx) : linkInner;
    const hashIdx = linkPath.indexOf("#");
    const subpath = hashIdx >= 0 ? linkPath.slice(hashIdx + 1) : "";
    const target = parsePdfSubpath(subpath);
    if (!target) continue;

    const quoteLines: string[] = [];
    const fields = new Map<string, string>();
    for (let i = 1; i < nonEmpty.length; i++) {
      const line = nonEmpty[i];
      if (/^>\s*>\s?/.test(line)) {
        const text = line.replace(/^>\s*>\s?/, "");
        quoteLines.push(text);
        continue;
      }
      const fieldMatch = FIELD_RE.exec(line);
      if (fieldMatch) {
        fields.set(fieldMatch[1], fieldMatch[2]);
      }
    }

    const text = quoteLines.join(" ");
    const key = highlightKey(target);
    ordinal++;
    const id = fields.get("id") ?? `H${String(ordinal).padStart(2, "0")}`;
    const page = fields.has("page") ? Number(fields.get("page")) : target.page;
    const kindField = fields.get("kind");
    const kind: "selection" | "annotation" | "rect" =
      kindField === "selection" || kindField === "annotation" || kindField === "rect"
        ? kindField
        : kindOf(target);
    const colorField = fields.get("color");
    const color = colorField !== undefined && colorField !== "" ? colorField : null;
    const origin = fields.get("origin") ?? "";
    const origins = origin
      ? origin.split(";").map((s) => s.trim()).filter((s) => s !== "")
      : [];
    const before = fields.get("before") ?? "";
    const after = fields.get("after") ?? "";

    highlights.push({ id, key, page, kind, color, target, text, before, after, origins });
  }

  return { pdfPath, pdfBasename, classCode, extracted, sources, highlights };
}
