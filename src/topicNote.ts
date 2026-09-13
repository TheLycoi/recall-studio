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

export interface RenderWikiNoteArgs {
  classCode: string;
  pdfBasename: string;
  summary: string;
  highlights: ManifestHighlight[];
}

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
  // (Recall's own digest skeleton), whichever appears first; else append at EOF.
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
