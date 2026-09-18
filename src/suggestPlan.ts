// Pure planning layer for the AI highlight suggester: split a PDF into page
// batches, verify a model's proposed spans against the real text layer, turn
// the survivors into manifest rows, and group those rows into wiki notes. No
// `obsidian` import (see src/pageMap.ts:1-8): bundled standalone and exercised
// with node --test (test/suggestPlan.test.mjs).
import { selectionFor, type PageMap } from "./pageMap";
import {
  headingKey,
  mergeWikiHighlights,
  noteAliases,
  noteSections,
  renderWikiNote,
  safeHeading,
  safeTitle,
  type PreparedNote,
  type RelatedLink,
  type WikiSchema,
} from "./topicNote";
import type { SuggestDraft } from "./schemas";
import { MANIFEST_CONTEXT_CHARS, sortAndAssignIds, type ManifestHighlight } from "./manifest";
import { highlightKey, type PdfTarget } from "./pdflink";
import { significantTokens } from "./retrieval";
import { contextFor, pageText, selectionText, type SelectionRange } from "./pdftext";
import { buildGraph, isGraphUsable, pprFromSeeds, type PPROptions } from "./graph";
import { escapeRegExp, normalizeWs } from "./util";

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
  /** The `##` heading of the note this span goes under, or "" for the note as a whole. */
  noteSection: string;
  target: PdfTarget;
  key: string;
  sel: SelectionRange;
}

/** What the planner needs from a span: where it goes. A PDF `VerifiedSpan` satisfies it; a markdown span is mapped to it. */
export type PlannedSpan = Pick<VerifiedSpan, "key" | "noteTitle" | "noteKind" | "noteSection">;

/** One row of the preview the reader accepted: the title as typed, and the highlights left ticked. */
export interface PreviewChoice {
  title: string;
  highlights: Array<{ key: string }>;
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
      noteSection: safeHeading(s.note_section ?? ""),
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
  /** Page format this vault uses. Defaults to `class`, which is what it was. */
  schema?: WikiSchema;
  /**
   * Proposed titles the reader insisted on keeping as their own notes, so the
   * routing below leaves them alone. Set from the preview's "keep as its own
   * note" choice; empty on the first plan.
   */
  keepAsNew?: string[];
  /** Random source for the related-links walk; tests seed it. */
  ppr?: PPROptions;
}

/** A proposed note filed into an existing one instead of being created. */
export interface RoutedNote {
  from: string;
  to: string;
  /** The heading it became inside `to`; empty when it was another name for `to` and its spans went to the note as a whole. */
  heading: string;
  why: string;
}

export interface PlanWikiResult {
  notes: PreparedNote[];
  orphanTitles: string[];
  routed: RoutedNote[];
}

function joinPath(folder: string, file: string): string {
  return `${folder}/${file}`.replace(/\/{2,}/g, "/");
}

interface Group {
  title: string;
  kind: "concept" | "entity";
  rows: ManifestHighlight[];
  /** The section each row was assigned to, by highlight key; "" for the note as a whole. */
  sectionByKey: Map<string, string>;
  /** Proposed notes filed into this group, by their proposed title, with the highlights each brought. */
  routedByFrom: Map<string, { route: Route; keys: string[] }>;
}

/** Where a proposed note goes instead of being created. */
export interface Route {
  to: WikiNoteIn;
  heading: string;
  why: string;
}

/**
 * The existing note a proposed one belongs in, or null at the wall.
 *
 * Three tests, in order, and all of them in code rather than left to the
 * model, because each is a fact about the vault the model can only guess at:
 *
 *   1. The model named a `closest_existing`. It was told that naming one
 *      means the spans belong there, so a "new" note that still names a home
 *      is a slip the planner corrects: it becomes a heading inside that note.
 *   2. The proposed title is already a `##` heading of an existing note. The
 *      subtopic has a home whether or not the model noticed; the spans go
 *      under that heading.
 *   3. The proposed title is an alias of an existing note — another name the
 *      reader gave it. That is the same note, so the spans go to the note as
 *      a whole, not under a heading named after it.
 *   4. The proposed title is a specialization of an existing heading: every
 *      content word of the heading occurs in it — "Receptors" in "Receptor
 *      Subtypes and Off-Target Effects" — so the spans go under that heading.
 *      Headings every page has are excluded, or "Summary of the Trial" would
 *      land under ## Summary.
 *   5. The same test against note titles: "Anti-Doping Code" is a kind of
 *      Doping, and becomes a heading inside it.
 *
 * Titles the reader has insisted on keeping (`keepAsNew`) skip all five.
 */
export function routeProposed(
  title: string,
  proposed: SuggestDraft["new_notes"][number] | undefined,
  wiki: WikiNoteIn[],
  wikiByTitle: Map<string, WikiNoteIn>,
  keepAsNew: Set<string>,
): Route | null {
  if (keepAsNew.has(title.toLowerCase())) return null;

  const closest = safeTitle(proposed?.closest_existing ?? "").trim();
  if (closest && closest !== "Untitled") {
    const home = wikiByTitle.get(closest.toLowerCase()) ?? wiki.find((w) => headingKey(w.title) === headingKey(closest));
    if (home) {
      const why = (proposed?.why_new ?? "").trim();
      return { to: home, heading: title, why: why || `the model named it as part of ${home.title}` };
    }
  }

  const key = headingKey(title);
  for (const w of wiki) {
    const hit = noteSections(w.md).find((h) => headingKey(h) === key);
    if (hit) return { to: w, heading: hit, why: `“${title}” is already a section of ${w.title}` };
  }
  for (const w of wiki) {
    if (noteAliases(w.md).some((a) => headingKey(a) === key)) {
      return { to: w, heading: "", why: `“${title}” is another name for ${w.title}` };
    }
  }

  // A one-word proposal cannot be a specialization of anything; and the
  // heading or title must be the shorter side, or "Drug Metabolism" would
  // count as a kind of "Drug Safety & The Therapeutic Index" on the word
  // they share.
  const words = new Set(significantTokens(title));
  const specializes = (of: string): boolean => {
    const t = significantTokens(of);
    return t.length > 0 && t.length < words.size && t.every((x) => words.has(x));
  };
  if (words.size >= 2) {
    for (const w of wiki) {
      const hit = noteSections(w.md).find((h) => !GENERIC_HEADINGS.has(headingKey(h)) && specializes(h));
      if (hit) return { to: w, heading: hit, why: `“${title}” is a kind of ${w.title}'s “${hit}”` };
    }
    for (const w of wiki) {
      if (specializes(w.title)) return { to: w, heading: title, why: `“${title}” is a kind of ${w.title}` };
    }
  }
  return null;
}

/** Headings a page has because of its schema, not because of its subject; never a home for a specialization. */
const GENERIC_HEADINGS: ReadonlySet<string> = new Set(
  [
    "Summary",
    "Highlights",
    "Mentions in Source",
    "Related topics",
    "Related Concepts",
    "Related Entities",
    "Flashcard Seeds",
    "Key claims",
    "Definition",
    "Description",
    "Key Characteristics",
    "Applications",
    "Notes",
    "References",
    "Sources",
    "See also",
  ].map((h) => headingKey(h)),
);

/**
 * Group verified spans into notes to write. A title the vault already has is
 * merged into (existing text untouched, same-key callouts skipped); a title the
 * model announced in `new_notes` is rendered fresh; anything else is an orphan
 * — the model pointed at a note that neither exists nor was announced — and is
 * planned exactly like a `new_notes` group (kind from the span, no summary),
 * kept under its own title rather than dumped into a note named after the
 * source PDF. `orphanTitles` still records these, in first-seen order, so the
 * preview can flag them.
 *
 * Before any of that, a proposed or orphan title is tested against the vault
 * (`routeProposed`): one that has a home in an existing note is filed there
 * as a heading, and only a title with no home becomes a note of its own. The
 * policy is append-first — a new note is what happens at the wall, not the
 * default for every subject with a name — and `routed` reports each filing
 * so the preview can show it and the reader can overrule it.
 *
 * Within an existing note, spans are filed by the section they named: each
 * section is merged in turn on the same text, so a note gains as many
 * sections as its spans asked for and is still written once. A note written
 * fresh takes its sections from the schema, not from the spans, so a section
 * named on one of those is set aside.
 */
export function planWikiNotes(
  spans: PlannedSpan[],
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

  const keepAsNew = new Set((opts.keepAsNew ?? []).map((t) => safeTitle(t).toLowerCase()));
  // One routing decision per proposed title, cached: every span of a
  // proposed note goes where the note goes.
  const routeByTitle = new Map<string, Route | null>();
  const routeFor = (title: string): Route | null => {
    const k = title.toLowerCase();
    if (!routeByTitle.has(k)) routeByTitle.set(k, routeProposed(title, newByTitle.get(k), wiki ?? [], wikiByTitle, keepAsNew));
    return routeByTitle.get(k) ?? null;
  };

  const groups = new Map<string, Group>();
  const order: string[] = [];
  const orphanTitles: string[] = [];
  const routed: RoutedNote[] = [];

  for (const s of spans) {
    const row = rowByKey.get(s.key);
    if (!row) continue;

    // A span's note is the one it named — unless that note is a proposed or
    // orphan title with a home in the vault, in which case its note is the
    // home and its section is the heading the proposal becomes.
    let title = s.noteTitle;
    let section = s.noteSection;
    let route: Route | null = null;
    if (!wikiByTitle.has(title.toLowerCase())) {
      route = routeFor(title);
      if (route) {
        title = route.to.title;
        section = section || route.heading;
      }
    }

    const key = title.toLowerCase();
    if (!route && !wikiByTitle.has(key) && !newByTitle.has(key)) {
      if (!orphanTitles.includes(title)) orphanTitles.push(title);
    }

    let group = groups.get(key);
    if (!group) {
      group = { title, kind: s.noteKind, rows: [], sectionByKey: new Map(), routedByFrom: new Map() };
      groups.set(key, group);
      order.push(key);
    }
    if (!group.rows.some((r) => r.key === row.key)) {
      group.rows.push(row);
      group.sectionByKey.set(row.key, section);
      if (route) {
        const entry = group.routedByFrom.get(s.noteTitle);
        if (entry) entry.keys.push(row.key);
        else {
          group.routedByFrom.set(s.noteTitle, { route, keys: [row.key] });
          routed.push({ from: s.noteTitle, to: route.to.title, heading: route.heading, why: route.why });
        }
      }
    }
  }

  const notes: PreparedNote[] = [];
  for (const key of order) {
    const group = groups.get(key)!;
    if (group.rows.length === 0) continue;
    const rows = group.rows.slice().sort((a, b) => a.page - b.page);

    const existing = wikiByTitle.get(key);
    if (existing) {
      const bySection = new Map<string, ManifestHighlight[]>();
      for (const row of rows) {
        const section = group.sectionByKey.get(row.key) ?? "";
        const list = bySection.get(section);
        if (list) list.push(row);
        else bySection.set(section, [row]);
      }

      let md = existing.md;
      let added = 0;
      let skipped = 0;
      const sections: NonNullable<PreparedNote["sections"]> = [];
      for (const [section, sectionRows] of bySection) {
        const merged = mergeWikiHighlights(md, opts.pdfBasename, opts.classCode, sectionRows, {
          schema: opts.schema,
          section: section || undefined,
        });
        md = merged.md;
        added += merged.added;
        skipped += merged.skipped;
        if (merged.section) {
          sections.push({ heading: merged.section.heading, keys: sectionRows.map((r) => r.key), created: merged.section.created });
        }
      }
      // Nothing new to write: the note already holds every one of these
      // callouts, so offering it to the user would be a no-op diff.
      if (added === 0) continue;
      notes.push({
        title: group.title,
        path: existing.path,
        exists: true,
        summary: "",
        highlights: rows,
        related: [],
        content: md,
        added,
        skipped,
        sections,
        routed: [...group.routedByFrom.entries()].map(([from, { route, keys }]) => ({ from, heading: route.heading, why: route.why, keys })),
      });
      continue;
    }

    const proposed = newByTitle.get(key);
    const kind = proposed?.kind ?? group.kind;
    const summary = proposed?.summary ?? "";
    const folder = kind === "entity" ? opts.entitiesFolder : opts.conceptsFolder;
    const related = opts.schema === "karpathy" ? relatedLinksFor(group.title, summary, wiki ?? [], opts) : { concepts: [], entities: [] };
    const content = renderWikiNote({
      classCode: opts.classCode,
      pdfBasename: opts.pdfBasename,
      summary,
      highlights: rows,
      schema: opts.schema,
      title: group.title,
      kind,
      aliases: proposed?.aliases ?? [],
      tag: proposed?.tag,
      relatedConcepts: related.concepts,
      relatedEntities: related.entities,
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

  return { notes, orphanTitles, routed };
}

/**
 * The pages a new page should point at, chosen by code from the vault.
 *
 * Two sources, in order. First, pages the title or summary names outright —
 * by title or by alias, as whole words — because a page the prose mentions
 * is the page a reader will want next. Then, when the graph is dense enough
 * to walk (`isGraphUsable`), the neighbours Personalized PageRank reaches
 * from those pages. A page names nothing → it links nothing; an invented
 * link is exactly the dead link the lint exists to catch.
 *
 * Links are written in the schema's full-path form, `[[concepts/page|Title]]`,
 * with the target's own `# Heading` as display text, and only ever to a page
 * in `wiki`, so every link here resolves on the day it is written.
 */
export function relatedLinksFor(
  title: string,
  summary: string,
  wiki: WikiNoteIn[],
  opts: PlanWikiOptions,
): { concepts: RelatedLink[]; entities: RelatedLink[] } {
  if (wiki.length === 0) return { concepts: [], entities: [] };
  const self = safeTitle(title).toLowerCase();
  const haystack = normalizeWs(`${title} ${summary}`).toLowerCase();
  const mentions = (name: string): boolean => {
    const k = normalizeWs(name).toLowerCase();
    if (k.length < 4) return false;
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(k)}([^\\p{L}\\p{N}]|$)`, "u").test(haystack);
  };
  const others = wiki.filter((w) => safeTitle(w.title).toLowerCase() !== self && displayTitle(w).toLowerCase() !== self);
  const seeds = others.filter((w) => [w.title, displayTitle(w), ...noteAliases(w.md)].some(mentions));
  if (seeds.length === 0) return { concepts: [], entities: [] };

  // Named pages outrank walked ones, in the order they were named.
  const score = new Map<string, number>();
  seeds.forEach((w, i) => score.set(w.path, 2 + (seeds.length - i) / (seeds.length + 1)));
  const graph = buildGraph(wiki.map((w) => ({ path: w.path, content: w.md })));
  if (isGraphUsable(graph)) {
    for (const [p, s] of pprFromSeeds(graph, seeds.map((w) => w.path), opts.ppr)) {
      if (!score.has(p)) score.set(p, s);
    }
  }
  const byPath = new Map(others.map((w) => [w.path, w]));
  const ranked = [...score.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([p]) => byPath.get(p))
    .filter((w): w is WikiNoteIn => w !== undefined);
  const link = (w: WikiNoteIn): RelatedLink => ({ path: relatedPath(w.path, opts), display: displayTitle(w) });
  return {
    concepts: ranked.filter((w) => w.kind === "concept").slice(0, 3).map(link),
    entities: ranked.filter((w) => w.kind === "entity").slice(0, 2).map(link),
  };
}

/** `wiki/concepts/x.md` → `concepts/x`: the path relative to the wiki root, which is the parent of the concepts folder. */
function relatedPath(path: string, opts: PlanWikiOptions): string {
  const root = opts.conceptsFolder.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
  const rel = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  return rel.replace(/\.md$/i, "");
}

/** A page's own `# Heading`, else its filename. */
function displayTitle(w: WikiNoteIn): string {
  return /^#\s+(.+?)\s*$/m.exec(w.md)?.[1]?.trim() || w.title;
}

/**
 * Re-aim the spans at what the reader accepted in the preview.
 *
 * The planner is pure, so rather than patch rendered content — which for an
 * existing note is built from the file it merges into — the kept spans are
 * re-pointed at the (possibly renamed) titles and the plan is built again by
 * the caller. Three things happen here: an unticked span is dropped; a title
 * the reader typed over a proposed one is announced as a new note so it keeps
 * the kind and summary the model gave the group it replaced; and a title the
 * planner had filed into an existing note that the reader chose to keep goes
 * back to being a note of its own, with its `closest_existing` cleared so the
 * re-plan does not file it again on the model's say-so.
 */
export function applyPreviewChoices(
  spans: PlannedSpan[],
  choices: PreviewChoice[],
  newNotes: SuggestDraft["new_notes"],
  wiki: WikiNoteIn[],
  routed: RoutedNote[],
): { spans: PlannedSpan[]; newNotes: SuggestDraft["new_notes"]; keepAsNew: string[] } {
  const routedFrom = new Set(routed.map((r) => r.from.toLowerCase()));
  const keepAsNew = [...new Set(choices.map((c) => safeTitle(c.title)).filter((t) => routedFrom.has(t.toLowerCase())))];

  const titleByKey = new Map<string, string>();
  for (const choice of choices) {
    const title = safeTitle(choice.title);
    for (const h of choice.highlights) titleByKey.set(h.key, title);
  }

  const wikiTitles = new Set(wiki.map((w) => w.title.toLowerCase()));
  let edited = newNotes.slice();
  const kept: PlannedSpan[] = [];
  for (const sp of spans) {
    const title = titleByKey.get(sp.key);
    if (title === undefined) continue;
    kept.push(title === sp.noteTitle ? sp : { ...sp, noteTitle: title });

    const key = title.toLowerCase();
    if (wikiTitles.has(key)) continue;
    if (edited.some((n) => safeTitle(n.title).toLowerCase() === key)) continue;
    const original = newNotes.find((n) => safeTitle(n.title).toLowerCase() === sp.noteTitle.toLowerCase());
    edited.push(
      original
        ? { ...original, title }
        : { title, kind: sp.noteKind, summary: "", closest_existing: "", why_new: "", aliases: [], tag: "other" },
    );
  }
  const keep = new Set(keepAsNew.map((t) => t.toLowerCase()));
  edited = edited.map((n) => (keep.has(safeTitle(n.title).toLowerCase()) ? { ...n, closest_existing: "" } : n));
  return { spans: kept, newNotes: edited, keepAsNew };
}
