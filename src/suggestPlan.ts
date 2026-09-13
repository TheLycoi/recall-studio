// Pure planning layer for the AI highlight suggester: split a PDF into page
// batches, verify a model's proposed spans against the real text layer, turn
// the survivors into manifest rows, and group those rows into wiki notes. No
// `obsidian` import (see src/pageMap.ts:1-8): bundled standalone and exercised
// with node --test (test/suggestPlan.test.mjs).
import { selectionFor, type PageMap } from "./pageMap";
import { mergeWikiHighlights, renderWikiNote, safeTitle, type PreparedNote } from "./topicNote";
import type { SuggestDraft } from "./schemas";
import { MANIFEST_CONTEXT_CHARS, sortAndAssignIds, type ManifestHighlight } from "./manifest";
import { highlightKey, type PdfTarget } from "./pdflink";
import { contextFor, pageText, selectionText, type SelectionRange } from "./pdftext";
import { normalizeWs } from "./util";

/**
 * 1-based inclusive page ranges of at most `perBatch` pages. A `perBatch`
 * below 1 would loop forever, so it is treated as 1.
 */
export function batchPages(pageCount: number, perBatch: number): Array<{ from: number; to: number }> {
  const size = Number.isFinite(perBatch) && perBatch >= 1 ? Math.floor(perBatch) : 1;
  const count = Number.isFinite(pageCount) && pageCount > 0 ? Math.floor(pageCount) : 0;
  const out: Array<{ from: number; to: number }> = [];
  for (let from = 1; from <= count; from += size) {
    out.push({ from, to: Math.min(from + size - 1, count) });
  }
  return out;
}

export interface VerifiedSpan {
  page: number;
  quote: string;
  label: string;
  noteTitle: string;
  noteKind: "concept" | "entity";
  target: PdfTarget;
  key: string;
  sel: SelectionRange;
}

export interface VerifyOptions {
  perPage: number;
  remaining: number;
  existingKeys: Set<string>;
  batch: { from: number; to: number };
}

export interface VerifyResult {
  spans: VerifiedSpan[];
  dropped: { outOfBatch: number; unlocated: number; duplicate: number; overCap: number };
}

/** Lexicographic compare of a selection's (index, offset) begin/end tuples. */
function cmpPos(aIndex: number, aOffset: number, bIndex: number, bOffset: number): number {
  if (aIndex !== bIndex) return aIndex - bIndex;
  return aOffset - bOffset;
}

function overlaps(a: SelectionRange, b: SelectionRange): boolean {
  // Half-open on the (index, offset) tuple: a starts before b ends and b
  // starts before a ends.
  const aBeforeBEnd = cmpPos(a.beginIndex, a.beginOffset, b.endIndex, b.endOffset) < 0;
  const bBeforeAEnd = cmpPos(b.beginIndex, b.beginOffset, a.endIndex, a.endOffset) < 0;
  return aBeforeBEnd && bBeforeAEnd;
}

/**
 * Keep only the spans that survive every check, in response order: inside the
 * batch and on a page we have a text layer for, locatable in that page, not a
 * key we already hold, not overlapping something accepted on the same page,
 * and within both the per-page and the overall cap. Order matters — an earlier
 * span wins the page against a later one that overlaps it.
 */
export function verifySpans(draft: SuggestDraft, maps: Map<number, PageMap>, opts: VerifyOptions): VerifyResult {
  const spans: VerifiedSpan[] = [];
  const dropped = { outOfBatch: 0, unlocated: 0, duplicate: 0, overCap: 0 };
  const acceptedKeys = new Set<string>();
  const byPage = new Map<number, VerifiedSpan[]>();

  for (const s of draft.spans ?? []) {
    const page = s.page;
    const map = maps.get(page);
    if (!Number.isInteger(page) || page < opts.batch.from || page > opts.batch.to || !map) {
      dropped.outOfBatch++;
      continue;
    }

    const sel = selectionFor(map, s.quote ?? "");
    if (!sel) {
      dropped.unlocated++;
      continue;
    }

    const target: PdfTarget = { page, selection: sel, color: "yellow" };
    const key = highlightKey(target);
    if (opts.existingKeys.has(key) || acceptedKeys.has(key)) {
      dropped.duplicate++;
      continue;
    }

    const onPage = byPage.get(page) ?? [];
    if (onPage.some((prev) => overlaps(prev.sel, sel))) {
      dropped.duplicate++;
      continue;
    }

    if (onPage.length >= opts.perPage || spans.length >= opts.remaining) {
      dropped.overCap++;
      continue;
    }

    const span: VerifiedSpan = {
      page,
      quote: s.quote,
      label: s.label,
      noteTitle: safeTitle(s.note_title ?? ""),
      noteKind: s.note_kind,
      target,
      key,
      sel,
    };
    spans.push(span);
    acceptedKeys.add(key);
    onPage.push(span);
    byPage.set(page, onPage);
  }

  return { spans, dropped };
}

/**
 * Manifest rows for verified spans. The text is the text layer's own rendering
 * of the selection (`selectionText`, src/pdftext.ts:301), not the model's
 * quote, so the callout body and the link it carries say the same thing; the
 * quote is only the fallback for the impossible case of a selection that no
 * longer renders. Ids are `S01…` to keep AI suggestions apart from the
 * extracted `H01…` manifest.
 */
export function toManifestHighlights(
  spans: VerifiedSpan[],
  maps: Map<number, PageMap>,
  contextChars = MANIFEST_CONTEXT_CHARS,
): ManifestHighlight[] {
  const rows: ManifestHighlight[] = spans.map((s) => {
    const map = maps.get(s.page);
    const items = map?.items ?? [];
    // singleLine (src/pdftext.ts:198-203) joins item slices with a single
    // space at every break; when an item's own str already ends in a space
    // that produces a double space in the callout quote, which must read the
    // way the page reads.
    const text = normalizeWs((map ? selectionText(items, s.sel) : null) ?? s.quote);
    const { before, after } = contextFor(pageText(items), text, contextChars);
    return {
      id: "",
      key: s.key,
      page: s.page,
      kind: "selection" as const,
      color: "yellow",
      target: s.target,
      text,
      before,
      after,
      origins: ["ai suggestion"],
    };
  });
  return sortAndAssignIds(rows, "S");
}

export interface WikiNoteIn {
  title: string;
  kind: "concept" | "entity";
  path: string;
  md: string;
}

export interface PlanWikiOptions {
  classCode: string;
  pdfBasename: string;
  conceptsFolder: string;
  entitiesFolder: string;
}

export interface PlanWikiResult {
  notes: PreparedNote[];
  orphanTitles: string[];
}

function joinPath(folder: string, file: string): string {
  return `${folder}/${file}`.replace(/\/{2,}/g, "/");
}

interface Group {
  title: string;
  kind: "concept" | "entity";
  rows: ManifestHighlight[];
}

/**
 * Group verified spans into notes to write. A title the vault already has is
 * merged into (existing text untouched, same-key callouts skipped); a title the
 * model announced in `new_notes` is rendered fresh; anything else is an orphan
 * — the model pointed at a note that neither exists nor was announced — and is
 * planned exactly like a `new_notes` group (kind from the span, no summary),
 * kept under its own title rather than dumped into a note named after the
 * source PDF. `orphanTitles` still records these, in first-seen order, so the
 * preview can flag them.
 */
export function planWikiNotes(
  spans: VerifiedSpan[],
  highlights: ManifestHighlight[],
  newNotes: SuggestDraft["new_notes"],
  wiki: WikiNoteIn[],
  opts: PlanWikiOptions,
): PlanWikiResult {
  const rowByKey = new Map(highlights.map((h) => [h.key, h]));
  const wikiByTitle = new Map<string, WikiNoteIn>();
  for (const w of wiki ?? []) {
    const k = (w.title ?? "").toLowerCase();
    if (!wikiByTitle.has(k)) wikiByTitle.set(k, w);
  }
  const newByTitle = new Map<string, SuggestDraft["new_notes"][number]>();
  for (const n of newNotes ?? []) {
    const k = safeTitle(n.title ?? "").toLowerCase();
    if (!newByTitle.has(k)) newByTitle.set(k, n);
  }

  const groups = new Map<string, Group>();
  const order: string[] = [];
  const orphanTitles: string[] = [];

  for (const s of spans) {
    const row = rowByKey.get(s.key);
    if (!row) continue;

    const key = s.noteTitle.toLowerCase();
    if (!wikiByTitle.has(key) && !newByTitle.has(key)) {
      if (!orphanTitles.includes(s.noteTitle)) orphanTitles.push(s.noteTitle);
    }

    let group = groups.get(key);
    if (!group) {
      group = { title: s.noteTitle, kind: s.noteKind, rows: [] };
      groups.set(key, group);
      order.push(key);
    }
    if (!group.rows.some((r) => r.key === row.key)) group.rows.push(row);
  }

  const notes: PreparedNote[] = [];
  for (const key of order) {
    const group = groups.get(key)!;
    if (group.rows.length === 0) continue;
    const rows = group.rows.slice().sort((a, b) => a.page - b.page);

    const existing = wikiByTitle.get(key);
    if (existing) {
      const merged = mergeWikiHighlights(existing.md, opts.pdfBasename, opts.classCode, rows);
      // Nothing new to write: the note already holds every one of these
      // callouts, so offering it to the user would be a no-op diff.
      if (merged.added === 0) continue;
      notes.push({
        title: group.title,
        path: existing.path,
        exists: true,
        summary: "",
        highlights: rows,
        related: [],
        content: merged.md,
        added: merged.added,
        skipped: merged.skipped,
      });
      continue;
    }

    const proposed = newByTitle.get(key);
    const kind = proposed?.kind ?? group.kind;
    const summary = proposed?.summary ?? "";
    const folder = kind === "entity" ? opts.entitiesFolder : opts.conceptsFolder;
    const content = renderWikiNote({
      classCode: opts.classCode,
      pdfBasename: opts.pdfBasename,
      summary,
      highlights: rows,
    });
    notes.push({
      title: group.title,
      path: joinPath(folder, `${safeTitle(group.title)}.md`),
      exists: false,
      summary,
      highlights: rows,
      related: [],
      content,
      added: rows.length,
      skipped: 0,
    });
  }

  return { notes, orphanTitles };
}
