// Pure manifest model: render/parse the wikilm-manifest note format, and the
// merge/sort helpers that build it. No `obsidian` import (see src/lint.ts:1-6);
// bundled standalone and exercised with node --test (test/manifest.test.mjs).
import { normalizeWs } from "./util";
import type { PdfTarget } from "./pdflink";

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
  /**
   * A pre-rendered citation line for a highlight whose source is a markdown
   * note rather than a PDF: `- "quote" — [[note#heading|Note › Heading]]`.
   * Renderers print it in place of a PDF++ callout, and a merge dedupes it by
   * its quote text, since it has no PDF++ key. Absent for every PDF row.
   */
  mention?: string;
  /**
   * The reader's own words under the link this highlight came from, as
   * `findAllPdfReferences` read them (src/pdflink.ts `PdfReference.notes`),
   * and the heading that stood above it. Both are what the digest sends the
   * model beside the quote. Absent for a callout reference, an embedded
   * annotation, and a link with nothing under it.
   */
  notes?: string;
  heading?: string;
  /**
   * Set by the digest planner, never by the manifest: what the model wrote
   * for this highlight. `passage` is the digested text in the model's words
   * and `label` the few words that name it; `verbatim` says the quote itself
   * is what the page should hold, in which case `passage` is ignored.
   * `coverage` is how the source treats the highlight — a slide title is
   * `named`, and the planner keeps those out of pages.
   */
  passage?: string;
  label?: string;
  verbatim?: boolean;
  coverage?: "defined" | "discussed" | "named";
  /** Set by the planner: a page in the class already states this highlight, so it is reported as already said and not carded. */
  covered?: boolean;
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
      if (!existing.notes && h.notes) existing.notes = h.notes;
      if (!existing.heading && h.heading) existing.heading = h.heading;
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
