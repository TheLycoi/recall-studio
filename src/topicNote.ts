// Pure topic-note render/parse/merge and the digest planner. No `obsidian`
// import (see src/lint.ts:1-6); bundled standalone and exercised with
// node --test (test/topicNote.test.mjs).
import { splitFrontmatter } from "./util";
import { findAllPdfReferences, highlightKey, pdfFileName, renderCallout, renderPdfLink, type PdfTarget } from "./pdflink";
import type { ManifestHighlight, Manifest } from "./manifest";
import type { DigestDraft } from "./schemas";
import { routeProposed, type WikiNoteIn } from "./suggestPlan";

/** Strip characters illegal in vault filenames, collapse whitespace, "Untitled" when empty. */
export function safeTitle(title: string): string {
  const stripped = title.replace(/[\\/:*?"<>|#^[\]]/g, "");
  const collapsed = stripped.replace(/\s+/g, " ").trim();
  return collapsed || "Untitled";
}

/**
 * A heading as a reader reads it: the markup a hand-written heading carries
 * (`==mark==`, `**bold**`, a wikilink's brackets and alias) is not part of
 * its name, and neither is the trailing space or colon that so often follows
 * one. `## Receptors ` and `**Receptors**:` both read "Receptors".
 */
function headingDisplay(raw: string): string {
  return raw
    .replace(/==|\*\*|__|`/g, "")
    .replace(/!?\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
      const s = String(inner);
      const pipe = s.lastIndexOf("|");
      return pipe >= 0 ? s.slice(pipe + 1) : s.replace(/#.*$/, "");
    })
    .replace(/\s+/g, " ")
    .replace(/[\s:]+$/, "")
    .trim();
}

/**
 * A section heading the model named, as it will be matched or written.
 *
 * The model is asked to copy a heading exactly and sometimes copies the `## `
 * with it; a heading is also the one place a stray newline would split a
 * page, so both go. Capped because a heading is a label, not a sentence.
 */
export function safeHeading(heading: string): string {
  const oneLine = heading.replace(/[\r\n]+/g, " ").replace(/^\s*#+\s*/, "");
  return headingDisplay(oneLine).slice(0, 80).trim();
}

/** The form two headings are compared in: display form, case folded. */
export function headingKey(heading: string): string {
  return headingDisplay(heading.replace(/^\s*#+\s*/, "")).toLowerCase();
}

export interface HeadingLine {
  heading: string;
  key: string;
  /** Offset just past the heading's text, before its line break. */
  end: number;
}

/** Every `##` heading in a body with its offset, skipping fenced code, where a `## ` is text. */
function scanHeadings(body: string): HeadingLine[] {
  const out: HeadingLine[] = [];
  let fenced = false;
  let offset = 0;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
    } else if (!fenced) {
      const m = /^ {0,3}##\s+(.+?)\s*$/.exec(line);
      if (m) {
        const heading = headingDisplay(m[1]);
        if (heading) out.push({ heading, key: heading.toLowerCase(), end: offset + line.length });
      }
    }
    offset += line.length + 1;
  }
  return out;
}

/**
 * The start offset of the first `##` heading at or after `offset`, or
 * `body.length` when the rest of the body holds none.
 *
 * Every section boundary goes through here rather than a bare `/^##\s/m`,
 * because a `## ` line inside a fenced block is text the reader wrote — a
 * page that documents the note format quotes its own headings. Scanning
 * without the fence, a merge splices new rows into the middle of the reader's
 * code block, and a parse stops a section early and returns the fence's
 * contents plus a stray closing ```. An unclosed fence runs to EOF, which is
 * how a Markdown renderer reads it too.
 */
export function nextHeadingAfter(body: string, offset: number): number {
  let fenced = false;
  let at = 0;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
    } else if (!fenced && at >= offset && /^ {0,3}##\s/.test(line)) {
      return at;
    }
    at += line.length + 1;
  }
  return body.length;
}

/**
 * The first match of a heading pattern that is a real heading and not a line
 * inside a fenced block. `re` must be an anchored, multiline heading pattern
 * (`/^##\s+Highlights\s*$/m`); the match is retried past each fenced hit, so
 * a page whose fenced example names the same heading still merges into the
 * real one below it.
 */
export function execHeading(body: string, re: RegExp): RegExpExecArray | null {
  const scan = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (let m = scan.exec(body); m; m = scan.exec(body)) {
    if (nextHeadingAfter(body, m.index) === m.index) return m;
    // Zero-length matches would spin here; a heading pattern cannot produce
    // one, but advancing guarantees it regardless.
    if (scan.lastIndex === m.index) scan.lastIndex = m.index + 1;
  }
  return null;
}

/**
 * The `##` headings of a note, in order, as the reader wrote them.
 *
 * These are the note's subtopics, and they are what the suggester shows the
 * model so a span can be filed under one instead of founding a new note
 * beside it. Only `##`: that is the level every page in both vaults uses for
 * its subtopics, and a deeper heading is a division of one of these rather
 * than a place of its own.
 */
export function noteSections(md: string): string[] {
  const body = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const h of scanHeadings(body)) {
    if (seen.has(h.key)) continue;
    seen.add(h.key);
    out.push(h.heading);
  }
  return out;
}

/**
 * The `aliases:` of a note's frontmatter, inline (`[a, b]`) or as a block
 * list, unquoted. Another name a reader gave the note is another name the
 * suggester should not found a second note under.
 */
export function noteAliases(md: string): string[] {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)?.[1] ?? "";
  const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "").trim();
  const inline = /^aliases:\s*\[(.*)\]\s*$/m.exec(fm);
  if (inline) return inline[1].split(",").map(unquote).filter(Boolean);
  const block = /^aliases:\s*\n((?:[ \t]*-[^\n]*\n?)*)/m.exec(fm);
  if (block) {
    return block[1]
      .split("\n")
      .map((l) => unquote(l.replace(/^[ \t]*-\s*/, "")))
      .filter(Boolean);
  }
  return [];
}

/** A frontmatter key's values: a scalar, an inline `[a, b]` list, or a block list. Empty when absent. */
export function fmList(fm: string, key: string): string[] {
  const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "").trim();
  const inline = new RegExp(`^${key}:\\s*\\[(.*)\\]\\s*$`, "m").exec(fm);
  if (inline) return inline[1].split(",").map(unquote).filter(Boolean);
  const block = new RegExp(`^${key}:\\s*\\n((?:[ \\t]*-[^\\n]*\\n?)*)`, "m").exec(fm);
  if (block) return block[1].split("\n").map((l) => unquote(l.replace(/^[ \t]*-\s*/, ""))).filter(Boolean);
  const scalar = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(fm);
  return scalar ? [unquote(scalar[1])].filter(Boolean) : [];
}

export interface RenderTopicNoteArgs {
  title: string;
  classCode: string;
  created: string;
  pdfBasename: string;
  summary: string;
  highlights: ManifestHighlight[];
  related: string[];
  /** Whether the page is a concept or a named thing; becomes `type:`. */
  kind: WikiKind;
  /** Other names a reader would search the page under; becomes the `aliases:` block when non-empty. */
  aliases: string[];
  /** The page's subtype, checked against the kind's vocabulary; becomes the one `tags:` entry. */
  tag: string;
  /** Every class the page belongs to; defaults to `[classCode]`. */
  classCodes?: string[];
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
  const codes = (args.classCodes && args.classCodes.length ? args.classCodes : [classCode]).filter(Boolean);
  lines.push("---");
  lines.push(`type: ${args.kind}`);
  lines.push(codes.length > 1 ? `class: [${codes.join(", ")}]` : `class: ${codes[0] ?? classCode}`);
  lines.push(`created: ${created}`);
  lines.push(`source_file: "[[${pdfFileName(pdfBasename)}]]"`);
  lines.push(`tags: [${validTag(args.kind, args.tag)}]`);
  const aliases = args.aliases.map((s) => s.trim()).filter(Boolean);
  if (aliases.length) {
    lines.push("aliases:");
    for (const al of aliases) lines.push(`  - ${JSON.stringify(al)}`);
  }
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
  /** Every code in `class:`, in order; `classCode` is the first. */
  classCodes: string[];
  sourceBasename: string;
  summary: string;
  highlights: ParsedTopicHighlight[];
}

/** Find the `## Highlights` section body (the lines after the heading, up to the next `## ` heading or EOF). */
function highlightsSectionRange(body: string): { start: number; end: number } | null {
  const m = execHeading(body, /^##\s+Highlights\s*$/m);
  if (!m) return null;
  const headingEnd = m.index + m[0].length;
  return { start: headingEnd, end: nextHeadingAfter(body, headingEnd) };
}

/**
 * The quote of a bullet row: the line's text with its link and marker
 * removed, then the nested items under it joined with "; ", so evidence
 * reads "involves 4 factors: Absorption; Distribution" rather than stopping
 * at the colon. Nested items end at the first line not indented under it.
 */
function bulletRowText(lines: string[], at: number): string {
  const head = (lines[at] ?? "")
    .replace(/!?\[\[[^\]]*\.pdf#[^\]]*\]\]/gi, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  const items: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const m = /^\s{2,}(?:[-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
    if (!m) break;
    items.push(m[1].trim());
  }
  return items.length ? `${head} ${items.join("; ")}`.trim() : head;
}

export function parseTopicNote(md: string): ParsedTopicNote {
  const { body: raw } = splitFrontmatter(md);
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  const frontmatter = fmMatch ? fmMatch[1] : "";

  const classCodes = fmList(frontmatter, "class");
  const classCode = classCodes[0] ?? "";

  const sourceMatch = /^source_file:\s*"?\[\[(.+?)\.pdf\]\]"?\s*$/m.exec(frontmatter);
  const sourceBasename = sourceMatch ? sourceMatch[1] : "";

  const titleMatch = /^#\s+(.+?)\s*$/m.exec(raw);
  const title = titleMatch ? titleMatch[1].trim() : "";

  let summary = "";
  const summaryHeadingMatch = execHeading(raw, /^##\s+Summary\s*$/m);
  if (summaryHeadingMatch) {
    const headingEnd = summaryHeadingMatch.index + summaryHeadingMatch[0].length;
    summary = raw.slice(headingEnd, nextHeadingAfter(raw, headingEnd)).trim();
  }

  const highlights: ParsedTopicHighlight[] = [];
  const range = highlightsSectionRange(raw);
  if (range) {
    const section = raw.slice(range.start, range.end);
    const lines = section.split("\n");
    const refs = findAllPdfReferences(section);
    for (const r of refs) {
      highlights.push({
        pdfBasename: r.pdfBasename,
        target: r.target,
        key: highlightKey(r.target),
        page: r.target.page,
        text: r.embed ? "" : (r.quote ?? bulletRowText(lines, r.line)),
        line: r.line,
      });
    }
  }

  return { title, classCode, classCodes, sourceBasename, summary, highlights };
}

export interface MergeResult {
  md: string;
  added: number;
  skipped: number;
  /** The section the highlights went under, when the merge was aimed at one and added something. */
  section?: { heading: string; created: boolean };
}

/**
 * Give a page a second class. A scalar `class:` becomes a list at the second
 * value; a list grows; a page with no class gains one after `type:` when it
 * has that key and at the top of the frontmatter otherwise. A class already
 * present leaves the page byte-identical.
 */
export function addClassCode(md: string, code: string): string {
  const c = code.trim();
  if (!c) return md;
  const m = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(md);
  if (!m) return `---\nclass: ${c}\n---\n${md}`;
  let fm = m[2];
  const have = fmList(fm, "class");
  if (have.includes(c)) return md;
  const next = [...have, c];
  const line = next.length > 1 ? `class: [${next.join(", ")}]` : `class: ${c}`;
  if (/^class:\s*\[.*\]\s*$/m.test(fm)) fm = fm.replace(/^class:\s*\[.*\]\s*$/m, line);
  else if (/^class:\s*\n(?:[ \t]*-[^\n]*\n?)*/m.test(fm)) fm = fm.replace(/^class:\s*\n(?:[ \t]*-[^\n]*\n?)*/m, `${line}\n`).replace(/\n$/, "");
  else if (/^class:.*$/m.test(fm)) fm = fm.replace(/^class:.*$/m, line);
  else if (/^type:.*$/m.test(fm)) fm = fm.replace(/^(type:.*)$/m, `$1\n${line}`);
  else fm = `${line}\n${fm}`;
  return md.slice(0, m.index) + m[1] + fm + m[3] + md.slice(m.index + m[0].length);
}

/** Where a merge puts the highlights, and which class the page ends up carrying. */
export interface MergeTopicOptions {
  /** The class this digest run is for; appended to the page's `class:` when it is missing. */
  classCode?: string;
  /** A `##` heading inside the page the highlights belong under, instead of its highlights section. */
  section?: string;
}

/**
 * Append highlights not already present (by `highlightKey`) into the
 * `## Highlights` section of `existingMd`, in page order. When the section is
 * missing, it is inserted (with its new callouts) before `## Related topics`
 * when present, else at EOF. Everything else is byte-identical.
 *
 * A page the digest merges into may belong to another class than the run's:
 * it gains this one rather than being copied, so the concept keeps one page.
 * With a `section`, the highlights go under that heading instead, which is
 * what the class schema's own merge already does.
 */
export function mergeTopicHighlights(
  existingMd: string,
  pdfBasename: string,
  highlights: ManifestHighlight[],
  opts: MergeTopicOptions = {},
): MergeResult {
  const result = opts.section
    ? mergeWikiHighlights(existingMd, pdfBasename, opts.classCode ?? "", highlights, { schema: "class", section: opts.section })
    : mergeTopicHighlightsBody(existingMd, pdfBasename, highlights);
  return opts.classCode ? { ...result, md: addClassCode(result.md, opts.classCode) } : result;
}

function mergeTopicHighlightsBody(existingMd: string, pdfBasename: string, highlights: ManifestHighlight[]): MergeResult {
  const headingMatch = execHeading(existingMd, /^##\s+Highlights\s*$/m);

  if (headingMatch) {
    const headingEnd = headingMatch.index + headingMatch[0].length;
    const sectionEnd = nextHeadingAfter(existingMd, headingEnd);
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

  const relatedMatch = execHeading(existingMd, /^##\s+Related topics\s*$/m);
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

/** One page already in the vault, anywhere under the topic folder, as the planner sees it. */
export interface ExistingPage {
  path: string;
  title: string;
  kind: WikiKind;
  aliases: string[];
  classCodes: string[];
  md: string;
}

export interface PlanTopicNotesOptions {
  classCode: string;
  topicFolder: string;
  created: string;
  /** Every page the draft may merge into or be filed under, across every class. */
  pages: ExistingPage[];
  /**
   * Titles the reader accepted as new pages in the preview. Routing skips
   * them: a row shown as "create this page" and ticked must not come back from
   * the re-plan as an append to a page the reader was never shown.
   */
  keepAsNew?: string[];
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
  /**
   * For an existing note, the sections its highlights were filed under and
   * which of them the merge created, keyed back to the highlights by `key` so
   * the preview can label each one. Absent for a note written fresh.
   */
  sections?: Array<{ heading: string; keys: string[]; created: boolean }>;
  /**
   * Notes the model proposed that the planner filed into this one instead of
   * creating: what each was called, the heading it became (empty when it was
   * another name for this note), why, and which highlights it brought.
   */
  routed?: Array<{ from: string; heading: string; why: string; keys: string[] }>;
  /** What the page is, when the planner knows: the kind it was created as, or the kind of the page merged into. */
  kind?: WikiKind;
  /** For a page created fresh, the model's one sentence on why nothing existing could hold it. */
  whyNew?: string;
  /**
   * The draft group titles (after `safeTitle`) that produced this row, in
   * order. A row is unique by `path` — two groups filed into one page are
   * coalesced into one row — so the group is the only handle the digest has on
   * "which of the model's proposals did the reader keep" (see
   * `applyDigestChoices`). `planWikiNotes` does not use it.
   */
  groups: string[];
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
  // group title) and the titles of the pages in `opts.pages`.
  const draftTitles = new Set(groupOrder.map((k) => groups.get(k)!.title));
  const existingTitles = new Set(opts.pages.map((p) => p.title));

  // A page answers to its title and to every alias the reader gave it, so a
  // draft title that is another name for a page it already has merges into
  // that page rather than founding a second one beside it.
  //
  // Two vaults can hold a page of the same name in two classes ("Receptors" in
  // AAA and in BBB). The first one seen used to win regardless of class, which
  // merged a BBB run into AAA's page; the run's own class is asked first.
  const byNamePages = opts.pages
    .map((p, i) => ({ p, i, mine: p.classCodes.includes(opts.classCode) ? 0 : 1 }))
    .sort((a, b) => a.mine - b.mine || a.i - b.i)
    .map((x) => x.p);
  const byName = new Map<string, ExistingPage>();
  for (const p of byNamePages) {
    for (const name of [p.title, ...p.aliases]) {
      const k = safeTitle(name).toLowerCase();
      if (k && !byName.has(k)) byName.set(k, p);
    }
  }
  const wiki: WikiNoteIn[] = opts.pages.map((p) => ({ title: p.title, kind: p.kind, path: p.path, md: p.md }));
  const wikiByTitle = new Map(wiki.map((w) => [w.title.toLowerCase(), w]));
  // Titles the reader ticked as new pages. `routeProposed` skips them, so a
  // rename that happens to specialize an existing title ("Receptor Subtypes"
  // over "Receptors") cannot turn an accepted creation into an append.
  const keepAsNew = new Set((opts.keepAsNew ?? []).map((t) => safeTitle(t).toLowerCase()));

  // Two groups routed into the same page must each see the previous one's
  // work, or the second merge would be computed against the file on disk and
  // silently drop the first.
  const latest = new Map<string, string>();
  const mdOf = (page: ExistingPage): string => latest.get(page.path) ?? page.md;

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

    const draftNote = draft.notes.find((n) => safeTitle(n.title).toLowerCase() === groupKey);

    const home = byName.get(group.title.toLowerCase());
    if (home) {
      const merged = mergeTopicHighlights(mdOf(home), manifest.pdfBasename, group.highlights, { classCode: opts.classCode });
      latest.set(home.path, merged.md);
      notes.push({
        title: home.title,
        path: home.path,
        exists: true,
        summary: group.summary,
        highlights: group.highlights,
        related: relatedTitles,
        content: merged.md,
        added: merged.added,
        skipped: merged.skipped,
        kind: home.kind,
        groups: [group.title],
      });
      continue;
    }

    const route = routeProposed(
      group.title,
      draftNote
        ? {
            title: group.title,
            kind: draftNote.kind,
            summary: draftNote.summary,
            closest_existing: draftNote.closest_existing,
            why_new: draftNote.why_new,
            aliases: draftNote.aliases,
            tag: draftNote.tag,
          }
        : undefined,
      wiki,
      wikiByTitle,
      keepAsNew,
    );
    if (route) {
      const target = opts.pages.find((p) => p.path === route.to.path)!;
      const merged = mergeTopicHighlights(mdOf(target), manifest.pdfBasename, group.highlights, {
        classCode: opts.classCode,
        section: route.heading || undefined,
      });
      latest.set(target.path, merged.md);
      notes.push({
        title: target.title,
        path: target.path,
        exists: true,
        summary: group.summary,
        highlights: group.highlights,
        related: relatedTitles,
        content: merged.md,
        added: merged.added,
        skipped: merged.skipped,
        kind: target.kind,
        sections: merged.section
          ? [{ heading: merged.section.heading, keys: group.highlights.map((h) => h.key), created: merged.section.created }]
          : undefined,
        routed: [{ from: group.title, heading: route.heading, why: route.why, keys: group.highlights.map((h) => h.key) }],
        groups: [group.title],
      });
      continue;
    }

    const kind: WikiKind = draftNote?.kind ?? "concept";
    notes.push({
      title: group.title,
      path: `${opts.topicFolder}/${opts.classCode}/${group.title}.md`,
      exists: false,
      summary: group.summary,
      highlights: group.highlights,
      related: relatedTitles,
      content: renderTopicNote({
        title: group.title,
        classCode: opts.classCode,
        created: opts.created,
        pdfBasename: manifest.pdfBasename,
        summary: group.summary,
        highlights: group.highlights,
        related: relatedTitles,
        kind,
        aliases: draftNote?.aliases ?? [],
        tag: draftNote?.tag ?? "other",
      }),
      added: group.highlights.length,
      skipped: 0,
      kind,
      whyNew: draftNote?.why_new ?? "",
      groups: [group.title],
    });
  }

  // Two proposals can land in one page — two names for it, or two topics filed
  // under it — and each pass through the loop pushed a row. Two rows for one
  // path would give the preview two checkboxes over the same file, where
  // unticking either still wrote the other's text (the merges are sequential,
  // so the later row's content already contains the earlier one's). Fold them
  // into the one row the page deserves: the last content is the full text, and
  // the counts, highlights, sections and filings are the sum of the parts.
  const byPath = new Map<string, PreparedNote>();
  const coalesced: PreparedNote[] = [];
  for (const note of notes) {
    const seen = byPath.get(note.path);
    if (!seen) {
      byPath.set(note.path, note);
      coalesced.push(note);
      continue;
    }
    const keys = new Set(seen.highlights.map((h) => h.key));
    for (const h of note.highlights) {
      if (keys.has(h.key)) continue;
      keys.add(h.key);
      seen.highlights.push(h);
    }
    seen.content = note.content;
    seen.added += note.added;
    seen.skipped += note.skipped;
    if (note.sections?.length) seen.sections = [...(seen.sections ?? []), ...note.sections];
    if (note.routed?.length) seen.routed = [...(seen.routed ?? []), ...note.routed];
    for (const r of note.related) if (!seen.related.includes(r)) seen.related.push(r);
    for (const g of note.groups) if (!seen.groups.includes(g)) seen.groups.push(g);
  }

  return { notes: coalesced, unknownIds, unassignedIds, droppedNotes };
}

/** One row of the digest preview as the reader left it: the row it was, and the title in its box. */
export interface DigestChoice {
  path: string;
  title: string;
}

/**
 * The draft narrowed to what the reader kept in the preview: notes whose group
 * sits in a checked row survive; a checked NEW row's edited title renames its
 * one group; edits to an existing row's title are ignored (the page's name is
 * the page's).
 *
 * The digest re-plans the narrowed draft rather than filtering the planned
 * rows, because a rename can move a row between "create" and "merge into a
 * page that already exists", and the content of a merge is built from the file
 * it merges into. Narrowing by group, not by title, is what makes this exact:
 * coalescing makes `path` the unique key of a row, so two groups can share a
 * title or a path, and only the group says which proposal a reader unticked.
 */
export function applyDigestChoices(
  draft: DigestDraft,
  planned: PreparedNote[],
  chosen: DigestChoice[],
): { draft: DigestDraft; keepAsNew: string[] } {
  const byPath = new Map(planned.map((n) => [n.path, n]));
  const keptGroups = new Set<string>();
  const renamed = new Map<string, string>();
  // Every row the reader ticked that the preview showed as a page to create,
  // under whatever title they left in the box. The re-plan is told to keep
  // these new: the reader agreed to a new page, so a new page is what they get.
  const keepAsNew: string[] = [];
  for (const choice of chosen) {
    const row = byPath.get(choice.path);
    const groups = row ? row.groups : [safeTitle(choice.title)];
    for (const g of groups) keptGroups.add(g.toLowerCase());
    if (!row || row.exists === false) keepAsNew.push(safeTitle(choice.title));
    // Only a new page can be renamed, and only when the row stands for exactly
    // one group — otherwise there is no one proposal the new name belongs to.
    if (row && row.exists === false && groups.length === 1) {
      const to = safeTitle(choice.title);
      if (to !== groups[0]) renamed.set(groups[0].toLowerCase(), to);
    }
  }

  return {
    draft: {
      ...draft,
      notes: draft.notes
        .filter((n) => keptGroups.has(safeTitle(n.title).toLowerCase()))
        .map((n) => {
          const key = safeTitle(n.title).toLowerCase();
          return renamed.has(key) ? { ...n, title: renamed.get(key)! } : n;
        }),
    },
    keepAsNew: [...new Set(keepAsNew)],
  };
}

// ---- wiki notes

/** PDF++'s own display text for a link, as pdf-plus copies it: "<basename>, p.N". */
export function wikiDisplay(pdfBasename: string, page: number): string {
  return `${pdfBasename}, p.${page}`;
}

/** Indent of a nested list item under a row's lead bullet. Two spaces: the least CommonMark accepts under `- `. */
const NESTED_INDENT = "  ";

/**
 * A quote split into the list the slide printed it as.
 *
 * The text layer joins a slide's bullets into one line — "4 factors:•
 * Absorption• Distribution" — and a hand-pasted callout keeps them as
 * separate lines. Both read as a list on the slide, so both render as one
 * here: the words before the first marker are the lead, each marker starts an
 * item. A numbered run keeps its numbers when it has at least two items in
 * sequence — from 1, or from wherever the previous slide's list left off
 * ("4. Fat solubility … 5. Physio-chemical …") — and a lone number in a
 * sentence ("2 important properties") is not a list, so the text stays whole.
 */
export function splitInlineList(text: string): { lead: string; items: string[]; ordered: boolean; start: number } {
  const whole = text.replace(/\r/g, "").trim();
  const lines = whole.split("\n").map((l) => l.trim()).filter(Boolean);
  const joined = lines.join(" ");

  const bulletParts = joined.split(/\s*[•▪◦]\s*/).map((p) => p.trim());
  if (bulletParts.length >= 3 || (bulletParts.length === 2 && joined.trimStart().startsWith("•"))) {
    const [lead, ...items] = bulletParts;
    return { lead, items: items.filter(Boolean), ordered: false, start: 1 };
  }
  if (lines.length >= 2 && lines.slice(1).every((l) => /^[-*•▪◦]\s+/.test(l))) {
    return { lead: lines[0].replace(/^[-*•▪◦]\s+/, ""), items: lines.slice(1).map((l) => l.replace(/^[-*•▪◦]\s+/, "")), ordered: false, start: 1 };
  }

  const parts = joined.split(/(?:^|\s)(?=\d+\.\s)/).map((p) => p.trim()).filter(Boolean);
  const numberOf = (p: string): number => Number(/^(\d+)\.\s/.exec(p)?.[1] ?? NaN);
  const firstNumbered = parts.findIndex((p) => !Number.isNaN(numberOf(p)));
  if (firstNumbered >= 0 && firstNumbered <= 1) {
    const run = parts.slice(firstNumbered);
    const start = numberOf(run[0]);
    const consecutive = run.length >= 2 && run.every((p, i) => numberOf(p) === start + i);
    if (consecutive) {
      return { lead: firstNumbered === 1 ? parts[0] : "", items: run.map((p) => p.replace(/^\d+\.\s+/, "")), ordered: true, start };
    }
  }
  return { lead: joined, items: [], ordered: false, start: 1 };
}

/**
 * One highlight as a page prints it.
 *
 * A note-sourced row is its citation line; a rectangle with no text is the
 * bare embed, so the figure draws. Everything else is a bullet: the quote,
 * then a short `p.N` link that opens the PDF at the selection. The link's
 * display used to be the full "<basename>, p.N" that PDF++ copies, which put
 * a sixty-character filename on every line of a note; the page number is
 * what a reader wants to see, and the filename is in the link for the click.
 * A quote that was a list on the slide is a list here, nested under its lead.
 */
export function renderHighlightRow(pdfBasename: string, h: ManifestHighlight): string {
  if (h.mention) return h.mention;
  if (h.target.rect && !h.text) return renderCallout(pdfBasename, h.target, wikiDisplay(pdfBasename, h.page), h.text);
  const link = renderPdfLink(pdfBasename, h.target, `p.${h.page}`);
  const { lead, items, ordered, start } = splitInlineList(h.text);
  const first = lead ? `- ${lead} ${link}` : `- ${link}`;
  const rest = items.map((item, i) => `${NESTED_INDENT}${ordered ? `${start + i}.` : "-"} ${item}`);
  return [first, ...rest].join("\n");
}

/** One highlight as a page prints it: the note-sourced citation line when it has one, else the bullet row. */
function rowMarkdown(pdfBasename: string, h: ManifestHighlight): string {
  return renderHighlightRow(pdfBasename, h);
}

/** Whether a rendered row is a list item, so neighbours can decide how to sit against it. */
function isListRow(md: string): boolean {
  return /^\s*(?:[-*+]|\d+[.)])\s/.test(md);
}

/**
 * Rendered rows as one block. Two list items sit on consecutive lines, or the
 * list breaks in two with a gap between; anything else — an embed, a callout
 * — keeps a blank line either side, which is what markdown needs to end a
 * list before it and start one after.
 */
export function joinRows(rows: string[]): string {
  let out = "";
  rows.forEach((row, i) => {
    if (i === 0) {
      out = row;
      return;
    }
    out += isListRow(rows[i - 1]) && isListRow(row) ? `\n${row}` : `\n\n${row}`;
  });
  return out;
}

/** Case, whitespace and smart quotes folded, so a quote survives reflowing when it is looked for in a page. */
function foldQuote(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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

/** The tag as the page will carry it: the model's when it is in the kind's vocabulary, `other` when it is not. The lint reports the fallback, which is the reader's cue to set it. */
export function validTag(kind: WikiKind, tag: string | undefined): string {
  const t = (tag ?? "").trim().toLowerCase();
  const allowed: readonly string[] = kind === "entity" ? ENTITY_TAGS : CONCEPT_TAGS;
  return allowed.includes(t) ? t : "other";
}

/** A link the planner resolved, rendered by code and never by the model. */
export interface RelatedLink {
  /** Full-path target, e.g. "concepts/chunking". */
  path: string;
  /** Display text, e.g. "Chunking". */
  display: string;
  /** Optional gloss after an em dash, as the entity pages use. */
  note?: string;
}

/**
 * Which page format a vault uses.
 *
 * `karpathy`: `type: concept|entity` with Definition / Key Characteristics /
 * Applications and the two Related sections. `class`: `class: <CODE>` with
 * `## Summary` and `## Highlights`.
 *
 * Both are live in different vaults on purpose, and neither is migrated to the
 * other — a page written in the wrong one is what the older generator's linter
 * treated as malformed and "repaired".
 */
export type WikiSchema = "karpathy" | "class";

export interface RenderWikiNoteArgs {
  classCode: string;
  pdfBasename: string;
  summary: string;
  highlights: ManifestHighlight[];
  /** Defaults to `class`, the format this renderer has always emitted. */
  schema?: WikiSchema;
  /** Needed by the karpathy schema, which puts the page's own name in an H1. */
  title?: string;
  kind?: WikiKind;
  /** Other names the page answers to; quoted into `aliases:`. Karpathy schema only. */
  aliases?: string[];
  /** The subtype tag; falls back to `other` when not in the kind's vocabulary. Karpathy schema only. */
  tag?: string;
  /** Links the planner resolved to real pages. Karpathy schema only; rendered by code, never by the model. */
  relatedConcepts?: RelatedLink[];
  relatedEntities?: RelatedLink[];
  /** Today, so a caller can render a fixed date in a test. */
  today?: string;
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
 * Frontmatter key order is fixed — `type`, `created`, `updated`, `tags`,
 * `aliases`, `generation_complete` — so a reordering does not show up as a
 * diff on every page the merge touches.
 *
 * There is deliberately no `sources:` key. A page's sources are the PDF++
 * callouts under `## Mentions in Source`: each one links to the PDF at the
 * exact span it came from, so it can be clicked and checked. A frontmatter
 * wikilink naming a source note is a second, weaker copy of the same claim,
 * and it is the copy that rots — it survives the note being renamed, moved or
 * never written, which is how the old generator accumulated dead links.
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
    lines.push(joinRows(sorted.map((h) => rowMarkdown(a.pdfBasename, h))));
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
  if (a.schema === "karpathy") {
    const day = a.today ?? new Date().toISOString().slice(0, 10);
    const kind = a.kind ?? "concept";
    return renderKarpathyNote({
      title: a.title ?? "Untitled",
      kind,
      tag: validTag(kind, a.tag),
      aliases: (a.aliases ?? []).map((s) => s.trim()).filter(Boolean),
      created: day,
      updated: day,
      definition: a.summary,
      keyCharacteristics: [],
      applications: [],
      relatedConcepts: a.relatedConcepts ?? [],
      relatedEntities: a.relatedEntities ?? [],
      highlights: a.highlights,
      pdfBasename: a.pdfBasename,
    });
  }
  const { classCode, pdfBasename, summary, highlights } = a;
  const sorted = highlights.slice().sort((x, y) => x.page - y.page);
  const callouts = sorted.map((h) => rowMarkdown(pdfBasename, h));

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
  if (callouts.length > 0) lines.push(joinRows(callouts));
  return lines.join("\n") + "\n";
}


/**
 * Refresh the frontmatter a merge is allowed to touch.
 *
 * `updated` always moves and `created` never does. Everything else in the
 * frontmatter, including any `aliases` the reader added by hand, is returned
 * byte-identical.
 */
function touchFrontmatter(md: string, options: MergeWikiOptions): string {
  const m = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(md);
  if (!m) return md;
  const day = options.today ?? new Date().toISOString().slice(0, 10);
  let fm = m[2];

  fm = /^updated:/m.test(fm) ? fm.replace(/^updated:.*$/m, `updated: ${day}`) : `${fm}\nupdated: ${day}`;

  return md.slice(0, m.index) + m[1] + fm + m[3] + md.slice(m.index + m[0].length);
}

/**
 * Append `text` at the end of the section whose heading ends at `headingEnd`,
 * keeping whatever blank lines separated that section from the next heading
 * so the page's own spacing survives the edit.
 */
export function spliceIntoSection(body: string, headingEnd: number, text: string): string {
  const sectionEnd = nextHeadingAfter(body, headingEnd);
  const section = body.slice(headingEnd, sectionEnd);

  const trailingBlanksMatch = /\n*$/.exec(section);
  const trailingBlanks = trailingBlanksMatch ? trailingBlanksMatch[0] : "";
  const sectionCore = trailingBlanks ? section.slice(0, section.length - trailingBlanks.length) : section;
  // A list item appended to a section that ends in a list item continues that
  // list; a blank line between them would render two lists with a gap.
  const lastLine = sectionCore.slice(sectionCore.lastIndexOf("\n") + 1);
  const gap = isListRow(lastLine) && isListRow(text) ? "\n" : "\n\n";
  const appended = sectionCore.length > 0 ? `${sectionCore}${gap}${text}` : text;

  return body.slice(0, headingEnd) + appended + trailingBlanks + body.slice(sectionEnd);
}

/** The `##` heading in `body` that names `wanted`, compared as a reader would. */
export function findSection(body: string, wanted: string): HeadingLine | null {
  const key = headingKey(wanted);
  return scanHeadings(body).find((h) => h.key === key) ?? null;
}

/**
 * The headings that close a page in either schema. A reader's subtopics come
 * before these, so a section created for a new subtopic is placed ahead of
 * the first of them that the page has, and at the end when it has none.
 */
const TRAILING_HEADINGS = [
  /^##\s+Highlights\s*$/m,
  /^##\s+Mentions in Source\s*$/m,
  /^##\s+Related Concepts\s*$/m,
  /^##\s+Related Entities\s*$/m,
  /^##\s+Related topics\s*$/m,
  /^##\s+Flashcard Seeds\s*$/m,
  /^##\s+Key claims\s*$/m,
];

export function insertBeforeTrailing(body: string, sectionText: string): string {
  let at = -1;
  for (const re of TRAILING_HEADINGS) {
    const m = execHeading(body, re);
    if (m && (at < 0 || m.index < at)) at = m.index;
  }
  if (at < 0) return `${body.replace(/\n*$/, "")}\n\n${sectionText}\n`;
  return `${body.slice(0, at).replace(/\n*$/, "")}\n\n${sectionText}\n\n${body.slice(at)}`;
}

/**
 * Append highlights not already present anywhere in `existingMd` (by
 * `highlightKey`, checked over the whole note since hand-written wiki notes
 * carry PDF++ links inside prose and under arbitrary headings, not only under
 * `## Highlights`) into the `## Highlights` section, in page order. When the
 * section is missing, it is appended at EOF. Everything else is
 * byte-identical.
 *
 * With `section`, the highlights go under that `##` heading instead — the
 * reader's own subtopic — and the heading is created inside the page when it
 * does not exist yet. The result says which, so a preview can show it.
 */
export interface MergeWikiOptions {
  schema?: WikiSchema;
  /** Today, so a caller can pin the date in a test. */
  today?: string;
  /** The heading the highlights belong under; empty or absent means the page's highlights section. */
  section?: string;
}

export function mergeWikiHighlights(
  existingMd: string,
  pdfBasename: string,
  classCode: string,
  highlights: ManifestHighlight[],
  options: MergeWikiOptions = {},
): MergeResult {
  const schema = options.schema ?? "class";
  if (existingMd.trim() === "") {
    return {
      md: renderWikiNote({ classCode, pdfBasename, summary: "", highlights, schema }),
      added: highlights.length,
      skipped: 0,
    };
  }

  const existingKeys = new Set(findAllPdfReferences(existingMd).map((r) => highlightKey(r.target)));
  // A PDF row is already on the page when its key is; a note-sourced row has
  // no key the page could carry, so its quote is looked for instead.
  const existingText = foldQuote(existingMd);
  const toAdd = highlights
    .filter((h) => (h.mention ? !existingText.includes(foldQuote(h.text)) : !existingKeys.has(h.key)))
    .slice()
    .sort((a, b) => a.page - b.page);
  const skipped = highlights.length - toAdd.length;

  // A page the reader has marked `reviewed: true` is theirs. Highlights may
  // still be appended — that is additive and is the whole point of a merge —
  // but no frontmatter of theirs is rewritten, not even `updated`.
  const reviewed = /^reviewed:\s*true\s*$/m.test(existingMd);
  const body = schema === "karpathy" && !reviewed ? touchFrontmatter(existingMd, options) : existingMd;

  // A span may name the section of the page it belongs under — "Receptors" in
  // a pharmacology note — rather than the page as a whole. Its callouts go at
  // the end of that section, and a section the page lacks is created for it,
  // placed with the other subtopics rather than after the highlights: that is
  // where the reader will look for it.
  const wanted = safeHeading(options.section ?? "");
  if (wanted) {
    if (toAdd.length === 0) return { md: body, added: 0, skipped };
    const callouts = joinRows(toAdd.map((h) => rowMarkdown(pdfBasename, h)));
    const found = findSection(body, wanted);
    if (found) {
      return {
        md: spliceIntoSection(body, found.end, callouts),
        added: toAdd.length,
        skipped,
        section: { heading: found.heading, created: false },
      };
    }
    // A section the plugin writes takes its heading from the slide it came
    // from: the heading is a link to the page of its first row, so the title
    // itself opens the deck there. Only a created heading: one the reader
    // wrote is theirs and is matched, never rewritten.
    const firstPdf = toAdd.find((h) => !h.mention);
    const heading = firstPdf ? renderPdfLink(pdfBasename, { page: firstPdf.page }, wanted) : wanted;
    return {
      md: insertBeforeTrailing(body, `## ${heading}\n\n${callouts}`),
      added: toAdd.length,
      skipped,
      section: { heading: wanted, created: true },
    };
  }

  // Karpathy pages keep their quotes under `## Mentions in Source`; the class
  // schema uses `## Highlights`. Merging into the wrong one would append a
  // second section the page's own schema does not have.
  const headingRe = schema === "karpathy" ? /^##\s+Mentions in Source\s*$/m : /^##\s+Highlights\s*$/m;
  const headingMatch = execHeading(body, headingRe);

  if (headingMatch) {
    if (toAdd.length === 0) {
      return { md: body, added: 0, skipped };
    }
    const newCallouts = toAdd.map((h) => rowMarkdown(pdfBasename, h));
    const headingEnd = headingMatch.index + headingMatch[0].length;
    return { md: spliceIntoSection(body, headingEnd, joinRows(newCallouts)), added: toAdd.length, skipped };
  }

  if (toAdd.length === 0) {
    return { md: body, added: 0, skipped };
  }

  const newCallouts = toAdd.map((h) => rowMarkdown(pdfBasename, h));
  const sectionText = `## ${schema === "karpathy" ? "Mentions in Source" : "Highlights"}\n\n${joinRows(newCallouts)}`;

  // Insert before the first of `## Related topics` or `## Flashcard Seeds`
  // (WikiLM's own digest skeleton), whichever appears first; else append at EOF.
  const relatedMatch = execHeading(body, /^##\s+Related topics\s*$/m);
  const seedsMatch = execHeading(body, /^##\s+Flashcard Seeds\s*$/m);
  let anchorMatch: RegExpExecArray | null = null;
  if (relatedMatch && seedsMatch) {
    anchorMatch = relatedMatch.index <= seedsMatch.index ? relatedMatch : seedsMatch;
  } else {
    anchorMatch = relatedMatch ?? seedsMatch;
  }

  let newMd: string;
  if (anchorMatch) {
    const before = body.slice(0, anchorMatch.index);
    const after = body.slice(anchorMatch.index);
    const beforeTrimmed = before.replace(/\n*$/, "");
    newMd = `${beforeTrimmed}\n\n${sectionText}\n\n${after}`;
  } else {
    const beforeTrimmed = body.replace(/\n*$/, "");
    newMd = `${beforeTrimmed}\n\n${sectionText}\n`;
  }

  return { md: newMd, added: toAdd.length, skipped };
}
