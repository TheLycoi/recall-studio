// Pure topic-note render/parse/merge and the digest planner. No `obsidian`
// import (see src/lint.ts:1-6); bundled standalone and exercised with
// node --test (test/topicNote.test.mjs).
import { splitFrontmatter, basenameNoExt } from "./util";
import { findAllPdfReferences, highlightKey, pdfFileName, renderCallout, type PdfTarget } from "./pdflink";
import type { ManifestHighlight, Manifest } from "./manifest";
import type { DigestDraft } from "./schemas";

/** Strip characters illegal in vault filenames, collapse whitespace, "Untitled" when empty. */
export function safeTitle(title: string): string {
  const stripped = title.replace(/[\\/:*?"<>|#^[\]]/g, "");
  const collapsed = stripped.replace(/\s+/g, " ").trim();
  return collapsed || "Untitled";
}

export interface RenderTopicNoteArgs {
  title: string;
  classCode: string;
  created: string;
  pdfBasename: string;
  summary: string;
  highlights: ManifestHighlight[];
  related: string[];
}

function highlightsBody(pdfBasename: string, highlights: ManifestHighlight[]): string {
  const pages = Array.from(new Set(highlights.map((h) => h.page)));
  const multiPage = pages.length > 1;

  const parts: string[] = [];
  let lastPage: number | null = null;
  for (const h of highlights) {
    if (multiPage && h.page !== lastPage) {
      parts.push(`### Page ${h.page}`);
      parts.push("");
      lastPage = h.page;
    }
    parts.push(renderCallout(pdfBasename, h.target, `p.${h.page}`, h.text));
    parts.push("");
  }
  // Drop the trailing blank line after the last callout; the caller adds
  // exactly one blank line before the next section.
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts.join("\n");
}

export function renderTopicNote(args: RenderTopicNoteArgs): string {
  const { title, classCode, created, pdfBasename, summary, highlights, related } = args;
  const lines: string[] = [];
  lines.push("---");
  lines.push("type: topic");
  lines.push(`class: ${classCode}`);
  lines.push(`created: ${created}`);
  lines.push(`source_file: "[[${pdfFileName(pdfBasename)}]]"`);
  lines.push(`tags: [${classCode.toLowerCase()}]`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${title}`);
  lines.push("");
  lines.push("## Summary");
  lines.push(summary);
  lines.push("");
  lines.push("## Highlights");
  lines.push("");
  const body = highlightsBody(pdfBasename, highlights);
  if (body) lines.push(body);
  lines.push("");
  lines.push("## Related topics");
  for (const r of related) lines.push(`- [[${r}]]`);
  lines.push("");
  lines.push("## Flashcard Seeds");
  return lines.join("\n") + "\n";
}

export interface ParsedTopicHighlight {
  pdfBasename: string;
  target: PdfTarget;
  key: string;
  page: number;
  text: string;
  line: number;
}

export interface ParsedTopicNote {
  title: string;
  classCode: string;
  sourceBasename: string;
  summary: string;
  highlights: ParsedTopicHighlight[];
}

/** Find the `## Highlights` section body (the lines after the heading, up to the next `## ` heading or EOF). */
function highlightsSectionRange(body: string): { start: number; end: number } | null {
  const m = /^##\s+Highlights\s*$/m.exec(body);
  if (!m) return null;
  const headingEnd = m.index + m[0].length;
  const rest = body.slice(headingEnd);
  const next = /^##\s/m.exec(rest);
  const end = next ? headingEnd + next.index : body.length;
  return { start: headingEnd, end };
}

export function parseTopicNote(md: string): ParsedTopicNote {
  const { body: raw } = splitFrontmatter(md);
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  const frontmatter = fmMatch ? fmMatch[1] : "";

  const classMatch = /^class:\s*(.*)$/m.exec(frontmatter);
  const classCode = classMatch ? classMatch[1].trim() : "";

  const sourceMatch = /^source_file:\s*"?\[\[(.+?)\.pdf\]\]"?\s*$/m.exec(frontmatter);
  const sourceBasename = sourceMatch ? sourceMatch[1] : "";

  const titleMatch = /^#\s+(.+?)\s*$/m.exec(raw);
  const title = titleMatch ? titleMatch[1].trim() : "";

  let summary = "";
  const summaryHeadingMatch = /^##\s+Summary\s*$/m.exec(raw);
  if (summaryHeadingMatch) {
    const after = raw.slice(summaryHeadingMatch.index + summaryHeadingMatch[0].length);
    const nextHeading = /^##\s/m.exec(after);
    const sectionBody = nextHeading ? after.slice(0, nextHeading.index) : after;
    summary = sectionBody.trim();
  }

  const highlights: ParsedTopicHighlight[] = [];
  const range = highlightsSectionRange(raw);
  if (range) {
    const section = raw.slice(range.start, range.end);
    const refs = findAllPdfReferences(section);
    for (const r of refs) {
      highlights.push({
        pdfBasename: r.pdfBasename,
        target: r.target,
        key: highlightKey(r.target),
        page: r.target.page,
        text: r.embed ? "" : (r.quote ?? ""),
        line: r.line,
      });
    }
  }

  return { title, classCode, sourceBasename, summary, highlights };
}

export interface MergeResult {
  md: string;
  added: number;
  skipped: number;
}

/**
 * Append highlights not already present (by `highlightKey`) into the
 * `## Highlights` section of `existingMd`, in page order. When the section is
 * missing, it is inserted (with its new callouts) before `## Related topics`
 * when present, else at EOF. Everything else is byte-identical.
 */
export function mergeTopicHighlights(existingMd: string, pdfBasename: string, highlights: ManifestHighlight[]): MergeResult {
  const headingRe = /^##\s+Highlights\s*$/m;
  const headingMatch = headingRe.exec(existingMd);

  if (headingMatch) {
    const headingEnd = headingMatch.index + headingMatch[0].length;
    const rest = existingMd.slice(headingEnd);
    const nextHeadingMatch = /^##\s/m.exec(rest);
    const sectionEnd = nextHeadingMatch ? headingEnd + nextHeadingMatch.index : existingMd.length;
    const section = existingMd.slice(headingEnd, sectionEnd);

    const existingKeys = new Set(findAllPdfReferences(section).map((r) => highlightKey(r.target)));

    const toAdd = highlights
      .filter((h) => !existingKeys.has(h.key))
      .slice()
      .sort((a, b) => a.page - b.page);
    const skipped = highlights.length - toAdd.length;

    if (toAdd.length === 0) {
      return { md: existingMd, added: 0, skipped };
    }

    // Section content up to its trailing blank lines, so new callouts are
    // appended before them rather than after.
    const trailingBlanksMatch = /\n*$/.exec(section);
    const trailingBlanks = trailingBlanksMatch ? trailingBlanksMatch[0] : "";
    const sectionCore = trailingBlanks ? section.slice(0, section.length - trailingBlanks.length) : section;

    const newCallouts = toAdd.map((h) => renderCallout(pdfBasename, h.target, `p.${h.page}`, h.text));
    const appended = sectionCore.length > 0 ? `${sectionCore}\n\n${newCallouts.join("\n\n")}` : newCallouts.join("\n\n");

    const newMd = existingMd.slice(0, headingEnd) + appended + trailingBlanks + existingMd.slice(sectionEnd);
    return { md: newMd, added: toAdd.length, skipped };
  }

  // No `## Highlights` heading: build the section fresh and insert it.
  const toAdd = highlights.slice().sort((a, b) => a.page - b.page);
  const newCallouts = toAdd.map((h) => renderCallout(pdfBasename, h.target, `p.${h.page}`, h.text));
  const sectionText = `## Highlights\n\n${newCallouts.join("\n\n")}`;

  const relatedMatch = /^##\s+Related topics\s*$/m.exec(existingMd);
  let newMd: string;
  if (relatedMatch) {
    const before = existingMd.slice(0, relatedMatch.index);
    const after = existingMd.slice(relatedMatch.index);
    const beforeTrimmed = before.replace(/\n*$/, "");
    newMd = `${beforeTrimmed}\n\n${sectionText}\n\n${after}`;
  } else {
    const beforeTrimmed = existingMd.replace(/\n*$/, "");
    newMd = beforeTrimmed.length > 0 ? `${beforeTrimmed}\n\n${sectionText}\n` : `${sectionText}\n`;
  }

  return { md: newMd, added: toAdd.length, skipped: 0 };
}

export interface PlanTopicNotesOptions {
  classCode: string;
  topicFolder: string;
  created: string;
  existing: Record<string, string>;
}

export interface PreparedNote {
  title: string;
  path: string;
  exists: boolean;
  summary: string;
  highlights: ManifestHighlight[];
  related: string[];
  content: string;
  added: number;
  skipped: number;
}

export interface PlanTopicNotesResult {
  notes: PreparedNote[];
  unknownIds: string[];
  unassignedIds: string[];
  droppedNotes: number;
}

export function planTopicNotes(draft: DigestDraft, manifest: Manifest, opts: PlanTopicNotesOptions): PlanTopicNotesResult {
  const byId = new Map(manifest.highlights.map((h) => [h.id, h]));
  const unknownIds: string[] = [];
  const seenIds = new Set<string>();

  interface Group {
    title: string;
    summary: string;
    highlights: ManifestHighlight[];
    related: string[];
  }
  // Merge duplicate titles (case-insensitive after safeTitle).
  const groups = new Map<string, Group>();
  const groupOrder: string[] = [];

  for (const note of draft.notes) {
    const title = safeTitle(note.title);
    const groupKey = title.toLowerCase();

    const validHighlights: ManifestHighlight[] = [];
    for (const id of note.highlight_ids) {
      seenIds.add(id);
      const h = byId.get(id);
      if (!h) {
        if (!unknownIds.includes(id)) unknownIds.push(id);
        continue;
      }
      validHighlights.push(h);
    }

    if (validHighlights.length === 0) continue;

    let group = groups.get(groupKey);
    if (!group) {
      group = { title, summary: note.summary, highlights: [], related: [] };
      groups.set(groupKey, group);
      groupOrder.push(groupKey);
    }
    for (const h of validHighlights) {
      if (!group.highlights.some((existing) => existing.key === h.key)) group.highlights.push(h);
    }
    for (const r of note.related) {
      if (!group.related.includes(r)) group.related.push(r);
    }
  }

  const droppedNotes = draft.notes.filter((note) => {
    const validCount = note.highlight_ids.filter((id) => byId.has(id)).length;
    return validCount === 0;
  }).length;

  // Unassigned: highlights that appear in no note and are not in unused_ids.
  const unusedSet = new Set(draft.unused_ids);
  const assignedIds = new Set<string>();
  for (const groupKey of groupOrder) {
    const group = groups.get(groupKey)!;
    for (const h of group.highlights) assignedIds.add(h.id);
  }
  const unassignedIds: string[] = [];
  for (const h of manifest.highlights) {
    if (!assignedIds.has(h.id) && !unusedSet.has(h.id)) unassignedIds.push(h.id);
  }

  // Titles available for `related` filtering: other notes in this draft (by
  // group title) and existing notes (by basename of the `existing` keys).
  const draftTitles = new Set(groupOrder.map((k) => groups.get(k)!.title));
  const existingTitles = new Set(Object.keys(opts.existing).map((p) => basenameNoExt(p)));

  const notes: PreparedNote[] = [];
  for (const groupKey of groupOrder) {
    const group = groups.get(groupKey)!;
    group.highlights.sort((a, b) => a.page - b.page);

    const relatedTitles = group.related.filter((r) => {
      const st = safeTitle(r);
      if (st.toLowerCase() === group.title.toLowerCase()) return false;
      return (
        Array.from(draftTitles).some((t) => t.toLowerCase() === st.toLowerCase()) ||
        Array.from(existingTitles).some((t) => t.toLowerCase() === st.toLowerCase())
      );
    });

    const path = `${opts.topicFolder}/${opts.classCode}/${group.title}.md`;
    const existingMd = opts.existing[path];
    const exists = existingMd !== undefined;

    let content: string;
    let added: number;
    let skipped: number;
    if (exists) {
      const result = mergeTopicHighlights(existingMd, manifest.pdfBasename, group.highlights);
      content = result.md;
      added = result.added;
      skipped = result.skipped;
    } else {
      content = renderTopicNote({
        title: group.title,
        classCode: opts.classCode,
        created: opts.created,
        pdfBasename: manifest.pdfBasename,
        summary: group.summary,
        highlights: group.highlights,
        related: relatedTitles,
      });
      added = group.highlights.length;
      skipped = 0;
    }

    notes.push({
      title: group.title,
      path,
      exists,
      summary: group.summary,
      highlights: group.highlights,
      related: relatedTitles,
      content,
      added,
      skipped,
    });
  }

  return { notes, unknownIds, unassignedIds, droppedNotes };
}

// ---- wiki notes

/** PDF++'s own display text for a link, as pdf-plus copies it: "<basename>, p.N". */
export function wikiDisplay(pdfBasename: string, page: number): string {
  return `${pdfBasename}, p.${page}`;
}

/** A wiki page is a concept or a named thing; the two render differently. */
export type WikiKind = "concept" | "entity";

/**
 * The closed tag vocabularies, as the 100 existing pages actually use them.
 * Exactly one tag per page. `other` is the escape hatch, not a default.
 */
export const CONCEPT_TAGS = ["method", "theory", "term", "phenomenon", "standard", "field", "other"] as const;
export const ENTITY_TAGS = ["product", "person", "organization", "project", "event", "place", "other"] as const;
export type ConceptTag = (typeof CONCEPT_TAGS)[number];
export type EntityTag = (typeof ENTITY_TAGS)[number];

/** A link the planner resolved, rendered by code and never by the model. */
export interface RelatedLink {
  /** Full-path target, e.g. "concepts/chunking". */
  path: string;
  /** Display text, e.g. "Chunking". */
  display: string;
  /** Optional gloss after an em dash, as the entity pages use. */
  note?: string;
}

export interface RenderWikiNoteArgs {
  classCode: string;
  pdfBasename: string;
  summary: string;
  highlights: ManifestHighlight[];
}

/**
 * Everything a karpathy-schema page needs. `title` is the H1 and `tag` is the
 * single frontmatter tag; `created` is preserved across a merge while
 * `updated` is always refreshed.
 */
export interface RenderKarpathyNoteArgs {
  title: string;
  kind: WikiKind;
  tag: string;
  /** Source pages this was digested from, as vault paths under `sources/`. */
  sources: string[];
  aliases: string[];
  created: string;
  updated: string;
  /** `## Definition` for a concept, `## Description` for an entity. */
  definition: string;
  /** Concept-only; each bullet must trace to a highlight. */
  keyCharacteristics: string[];
  /** Concept-only. */
  applications: string[];
  relatedConcepts: RelatedLink[];
  relatedEntities: RelatedLink[];
  /** Verified highlights only — the evidence the prose rests on. */
  highlights: ManifestHighlight[];
  pdfBasename: string;
  /** True when `reviewed: true`, which makes a merge append-only. */
  reviewed?: boolean;
  generationComplete?: boolean;
}

/**
 * A double-quoted YAML scalar. Always quoted, never bare: the existing pages
 * quote 262 of their 266 aliases, so emitting a bare scalar where one is
 * allowed would rewrite that line on every page a merge touches.
 */
function yamlStr(s: string): string {
  return JSON.stringify(s);
}

/** `- [[path|Display]]`, with an em-dash gloss when the planner supplied one. */
function relatedLine(l: RelatedLink): string {
  const link = `[[${l.path}|${l.display}]]`;
  return l.note && l.note.trim() !== "" ? `- ${link} \u2014 ${l.note.trim()}` : `- ${link}`;
}

/**
 * A wiki page in karpathywiki's schema, so the 106 pages already in the vault
 * and every page written from here share one format.
 *
 * Frontmatter key order is fixed — `type`, `created`, `updated`, `sources`,
 * `tags`, `aliases`, `generation_complete` — because it is identical in all
 * 100 existing concept and entity pages, and a reordering would show up as a
 * diff on every page the merge touches.
 *
 * Section order differs by kind, also matching what the pages do: a concept
 * runs Definition → Key Characteristics → Applications → Related Concepts →
 * Related Entities, an entity runs Description → Related Entities → Related
 * Concepts. Both end at `## Mentions in Source`.
 *
 * The one deliberate departure: `## Mentions in Source` renders PDF++ callouts
 * rather than the bare quotes karpathywiki emitted. A bare quote cannot be
 * checked against anything, which is what its own lint counts as its 187
 * ungrounded quotes; a callout carries the page and selection it came from.
 */
export function renderKarpathyNote(a: RenderKarpathyNoteArgs): string {
  const isConcept = a.kind === "concept";
  const sorted = a.highlights.slice().sort((x, y) => x.page - y.page);

  const lines: string[] = [];
  lines.push("---");
  lines.push(`type: ${a.kind}`);
  lines.push(`created: ${a.created}`);
  lines.push(`updated: ${a.updated}`);
  lines.push("sources:");
  for (const src of a.sources) lines.push(`  - "[[${src}]]"`);
  lines.push(`tags: [${a.tag}]`);
  lines.push("aliases:");
  for (const al of a.aliases) lines.push(`  - ${yamlStr(al)}`);
  if (a.reviewed) lines.push("reviewed: true");
  lines.push(`generation_complete: ${a.generationComplete ?? true}`);
  lines.push("---");
  lines.push("");
  lines.push("");
  lines.push(`# ${a.title}`);
  lines.push("");

  lines.push(isConcept ? "## Definition" : "## Description");
  lines.push(a.definition.trim());
  lines.push("");

  if (isConcept) {
    lines.push("## Key Characteristics");
    for (const b of a.keyCharacteristics) lines.push(`- ${b}`);
    lines.push("");
    lines.push("## Applications");
    for (const b of a.applications) lines.push(`- ${b}`);
    lines.push("");
  }

  // Concepts lead with concepts, entities lead with entities — each page's
  // nearest neighbours first, which is the order the existing pages use.
  const first = isConcept
    ? (["## Related Concepts", a.relatedConcepts] as const)
    : (["## Related Entities", a.relatedEntities] as const);
  const second = isConcept
    ? (["## Related Entities", a.relatedEntities] as const)
    : (["## Related Concepts", a.relatedConcepts] as const);
  for (const [heading, links] of [first, second]) {
    lines.push(heading);
    for (const l of links) lines.push(relatedLine(l));
    lines.push("");
  }

  lines.push("## Mentions in Source");
  lines.push("");
  if (sorted.length > 0) {
    lines.push(
      sorted.map((h) => renderCallout(a.pdfBasename, h.target, wikiDisplay(a.pdfBasename, h.page), h.text)).join("\n\n"),
    );
  }
  return lines.join("\n").replace(/\n{3,}$/, "\n") + "\n";
}

/**
 * Render a wiki page in the vault's schema.
 *
 * A thin dispatcher on purpose: Stage 2 adds `renderClassNote` for the
 * `secondbrain` vault's `class:` + `## Summary` / `## Highlights` form, chosen
 * per vault. Keeping the seam here means that arrives as a second branch
 * rather than a rewrite of every caller.
 */
export function renderWikiNote(a: RenderWikiNoteArgs): string {
  const { classCode, pdfBasename, summary, highlights } = a;
  const sorted = highlights.slice().sort((x, y) => x.page - y.page);
  const callouts = sorted.map((h) => renderCallout(pdfBasename, h.target, wikiDisplay(pdfBasename, h.page), h.text));

  const lines: string[] = [];
  lines.push("---");
  lines.push(`class: ${classCode}`);
  lines.push("---");
  lines.push("");
  if (summary.trim() !== "") {
    lines.push("## Summary");
    lines.push(summary);
    lines.push("");
  }
  lines.push("## Highlights");
  lines.push("");
  if (callouts.length > 0) lines.push(callouts.join("\n\n"));
  return lines.join("\n") + "\n";
}

/**
 * Append highlights not already present anywhere in `existingMd` (by
 * `highlightKey`, checked over the whole note since hand-written wiki notes
 * carry PDF++ links inside prose and under arbitrary headings, not only under
 * `## Highlights`) into the `## Highlights` section, in page order. When the
 * section is missing, it is appended at EOF. Everything else is
 * byte-identical.
 */
export function mergeWikiHighlights(
  existingMd: string,
  pdfBasename: string,
  classCode: string,
  highlights: ManifestHighlight[],
): MergeResult {
  if (existingMd.trim() === "") {
    return { md: renderWikiNote({ classCode, pdfBasename, summary: "", highlights }), added: highlights.length, skipped: 0 };
  }

  const existingKeys = new Set(findAllPdfReferences(existingMd).map((r) => highlightKey(r.target)));
  const toAdd = highlights
    .filter((h) => !existingKeys.has(h.key))
    .slice()
    .sort((a, b) => a.page - b.page);
  const skipped = highlights.length - toAdd.length;

  const headingRe = /^##\s+Highlights\s*$/m;
  const headingMatch = headingRe.exec(existingMd);

  if (headingMatch) {
    if (toAdd.length === 0) {
      return { md: existingMd, added: 0, skipped };
    }

    const headingEnd = headingMatch.index + headingMatch[0].length;
    const rest = existingMd.slice(headingEnd);
    const nextHeadingMatch = /^##\s/m.exec(rest);
    const sectionEnd = nextHeadingMatch ? headingEnd + nextHeadingMatch.index : existingMd.length;
    const section = existingMd.slice(headingEnd, sectionEnd);

    const trailingBlanksMatch = /\n*$/.exec(section);
    const trailingBlanks = trailingBlanksMatch ? trailingBlanksMatch[0] : "";
    const sectionCore = trailingBlanks ? section.slice(0, section.length - trailingBlanks.length) : section;

    const newCallouts = toAdd.map((h) => renderCallout(pdfBasename, h.target, wikiDisplay(pdfBasename, h.page), h.text));
    const appended = sectionCore.length > 0 ? `${sectionCore}\n\n${newCallouts.join("\n\n")}` : newCallouts.join("\n\n");

    const newMd = existingMd.slice(0, headingEnd) + appended + trailingBlanks + existingMd.slice(sectionEnd);
    return { md: newMd, added: toAdd.length, skipped };
  }

  if (toAdd.length === 0) {
    return { md: existingMd, added: 0, skipped };
  }

  const newCallouts = toAdd.map((h) => renderCallout(pdfBasename, h.target, wikiDisplay(pdfBasename, h.page), h.text));
  const sectionText = `## Highlights\n\n${newCallouts.join("\n\n")}`;

  // Insert before the first of `## Related topics` or `## Flashcard Seeds`
  // (WikiLM's own digest skeleton), whichever appears first; else append at EOF.
  const relatedMatch = /^##\s+Related topics\s*$/m.exec(existingMd);
  const seedsMatch = /^##\s+Flashcard Seeds\s*$/m.exec(existingMd);
  let anchorMatch: RegExpExecArray | null = null;
  if (relatedMatch && seedsMatch) {
    anchorMatch = relatedMatch.index <= seedsMatch.index ? relatedMatch : seedsMatch;
  } else {
    anchorMatch = relatedMatch ?? seedsMatch;
  }

  let newMd: string;
  if (anchorMatch) {
    const before = existingMd.slice(0, anchorMatch.index);
    const after = existingMd.slice(anchorMatch.index);
    const beforeTrimmed = before.replace(/\n*$/, "");
    newMd = `${beforeTrimmed}\n\n${sectionText}\n\n${after}`;
  } else {
    const beforeTrimmed = existingMd.replace(/\n*$/, "");
    newMd = `${beforeTrimmed}\n\n${sectionText}\n`;
  }

  return { md: newMd, added: toAdd.length, skipped };
}
