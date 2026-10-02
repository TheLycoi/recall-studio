// Pure topic-note render/parse/merge and the digest planner. No `obsidian`
// import (see src/lint.ts:1-6); bundled standalone and exercised with
// node --test (test/topicNote.test.mjs).
import { splitFrontmatter } from "./util";
import { calloutHeader, findAllPdfReferences, highlightKey, pdfFileName, renderCallout, renderPdfLink, type PdfTarget } from "./pdflink";
import type { ManifestHighlight, Manifest } from "./manifest";
import type { DigestDraft } from "./schemas";
import { routeProposed, type WikiNoteIn } from "./suggestPlan";
import { resolveProseLinks, type LinkablePage } from "./proseLinks";

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
 * beside it. Only `##`: that is the level every page uses for its subtopics,
 * and a deeper heading is a division of one of these rather than a place of
 * its own.
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

/** One heading of a page and the first sentence of prose beneath it: what the page already says there. */
export interface OutlineEntry {
  heading: string;
  lead: string;
}

/** The most of a lead sentence that is shown. */
const LEAD_MAX = 160;

/**
 * Each `##` heading of a page with the first sentence of prose under it,
 * links reduced to their words. This is what the digest is shown for a page
 * in the run's class, in place of one summary sentence: enough to tell that
 * a page already states a fact, without sending the page.
 */
export function noteOutline(md: string): OutlineEntry[] {
  const body = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const out: OutlineEntry[] = [];
  let current: OutlineEntry | null = null;
  let fenced = false;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const h = /^##\s+(.*)$/.exec(line);
    if (h) {
      current = { heading: headingDisplay(h[1]), lead: "" };
      out.push(current);
      continue;
    }
    if (/^#/.test(line)) {
      current = null;
      continue;
    }
    if (!current || current.lead || !line) continue;
    if (/^(>|!\[\[|[-*+]\s|\d+[.)]\s|(-{3,}|\*{3,}|_{3,})$)/.test(line)) continue;
    const words = plainProse(line);
    if (!words) continue;
    const sentence = (/^[\s\S]*?[.!?](?=\s|$)/.exec(words)?.[0] ?? words).trim();
    current.lead = sentence.length > LEAD_MAX ? `${sentence.slice(0, LEAD_MAX - 1).replace(/\s+\S*$/, "")}…` : sentence;
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
  /** The body in the article shape; when absent the older Summary / Highlights body is written. */
  article?: Article;
}

function highlightsBody(pdfBasename: string, highlights: ManifestHighlight[]): string {
  const sorted = highlights.slice().sort((a, b) => a.page - b.page);
  return joinRows(sorted.map((h) => rowMarkdown(pdfBasename, h)));
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
  if (args.article) {
    lines.push(renderArticleBody(pdfBasename, args.kind, args.article, related));
    return lines.join("\n").replace(/\n*$/, "") + "\n";
  }
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
    // A passage row is `- [[link|label]]: passage`; with the link gone, the
    // colon that joined them is not part of the text.
    .replace(/^\s*[:—–-]\s*/, "")
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
  const summaryHeadingMatch = execHeading(raw, /^##\s+(?:Summary|Definition|Description)\s*$/m);
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

    const newRows = joinRows(toAdd.map((h) => rowMarkdown(pdfBasename, h)));
    const appended = sectionCore.length > 0 ? `${sectionCore}\n\n${newRows}` : newRows;

    const newMd = existingMd.slice(0, headingEnd) + appended + trailingBlanks + existingMd.slice(sectionEnd);
    return { md: newMd, added: toAdd.length, skipped };
  }

  // No `## Highlights` heading: build the section fresh and insert it.
  const toAdd = highlights.slice().sort((a, b) => a.page - b.page);
  const sectionText = `## Highlights\n\n${joinRows(toAdd.map((h) => rowMarkdown(pdfBasename, h)))}`;

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
  /**
   * Whether a page — or, with `pagePath` null, any page of the class —
   * already states `text` in other words (src/retrieval.ts coveredBy, over
   * the page's evidence units). Injected by the caller, which has the
   * index; the planner stays pure.
   */
  coveredBy?: (pagePath: string | null, text: string) => boolean;
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
  /** Quotes and paragraphs the page already stated in other words, left out. */
  said?: number;
  /**
   * For an existing note, the sections its highlights were filed under and
   * which of them the merge created, keyed back to the highlights by `key` so
   * the preview can label each one. Absent for a note written fresh.
   */
  sections?: Array<{ heading: string; keys: string[]; created: boolean }>;
  /**
   * The article this row was planned from, so the write can replay the same
   * merge against the page as it reads at write time (src/digest.ts
   * remergeNote). `articleSection` is the one heading the whole article was
   * filed under, when the proposal was a subtopic of an existing page.
   * When coalescing folds several groups into one page these two stay the
   * first group's; `articles` holds every group's, in the order they merged.
   */
  article?: Article;
  articleSection?: string;
  /** Every article merged into this row, in order, each with the heading it was filed under (see `replayArticles`). */
  articles?: Array<{ article: Article; section?: string }>;
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
  /** Highlights the model filed but marked as only named by the source; left out of every page. */
  namedIds: string[];
  /** Page names the prose mentioned that no page answers to; left as plain words. */
  orphans: string[];
  /** Ids the prose cited that the manifest does not hold; the citations were dropped. */
  droppedIds: string[];
  droppedNotes: number;
}

/**
 * One passage of a draft note, as the planner reads it. The strict schema
 * (`DigestOut`) always supplies every field; a draft written before 2.0, or
 * a test, may supply only the id, and a passage with no text is a verbatim
 * row.
 */
export interface DraftPassage {
  highlight_id: string;
  label?: string;
  text?: string;
  verbatim?: boolean;
  coverage?: string;
}

/** One section of a draft note: a subtopic, its prose, and the highlights it quotes beneath. */
export interface DraftSection {
  heading: string;
  prose: string;
  quote_ids: string[];
}

/**
 * A draft note as the planner needs it: `sections` from the article schema,
 * or the shapes drafts took before it — `passages` (each one section's worth
 * of prose over one quote) or a bare `highlight_ids` list (quotes only).
 */
export type PlannerNote = Omit<DigestDraft["notes"][number], "sections"> & {
  sections?: DraftSection[];
  passages?: DraftPassage[];
  highlight_ids?: string[];
};

export interface PlannerDraft {
  notes: PlannerNote[];
  unused_ids: string[];
}

/** The sections of a draft note, older shapes read as unnamed sections; `named` lists passage ids a pre-article draft marked as only named by the source. */
function sectionsOf(note: PlannerNote): { sections: DraftSection[]; named: string[] } {
  if (Array.isArray(note.sections)) return { sections: note.sections, named: [] };
  if (Array.isArray(note.passages)) {
    const named = note.passages.filter((p) => p.coverage === "named").map((p) => p.highlight_id);
    const sections = note.passages
      .filter((p) => p.coverage !== "named")
      .map((p) => ({ heading: "", prose: p.verbatim ? "" : (p.text ?? "").trim(), quote_ids: [p.highlight_id] }));
    return { sections, named };
  }
  if (Array.isArray(note.highlight_ids)) return { sections: [{ heading: "", prose: "", quote_ids: note.highlight_ids }], named: [] };
  return { sections: [], named: [] };
}

/** One section of an article as the page prints it: the heading, the resolved prose, and the highlights quoted beneath it. */
export interface ArticleSection {
  heading: string;
  prose: string;
  highlights: ManifestHighlight[];
}

/** A page's body in the article shape: the opening, the sections, and the figures. */
export interface Article {
  definition: string;
  sections: ArticleSection[];
  /** Rectangle highlights with no text: figures, rendered as embeds under their own heading. */
  figures: ManifestHighlight[];
}

/** Prose with its wikilinks reduced to their display text, for a card writer or a "have we said this" check. */
function plainProse(prose: string): string {
  return prose
    .replace(/!?\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
      const t = String(inner);
      const pipe = t.lastIndexOf("|");
      return pipe >= 0 ? t.slice(pipe + 1) : t.replace(/#.*$/, "");
    })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Prose as a claim to check for coverage: PDF++ citations removed outright
 * (their display text is a file title and a page, which would dilute the
 * claim's words), other wikilinks reduced to their words.
 */
function proseWords(prose: string): string {
  return plainProse(prose.replace(/\s*!?\[\[[^\]]*\.pdf#[^\]]*\]\]/gi, "")).replace(/\s+([.,;:!?])/g, "$1");
}


/**
 * A paragraph with the sentences the page already states removed.
 *
 * The check compares one claim with one passage of the page, so it is run
 * sentence by sentence; a sentence the page already states is dropped, and
 * the rest are kept, with their citations. The dropped sentence is usually
 * the topic sentence — the one the model restated from the page — and the
 * page's own version sits directly above in the same section, so the
 * paragraph still reads in context. `said` is how many were dropped; an
 * empty `text` means the whole paragraph was.
 */
function pruneSaid(prose: string, covered: (text: string) => boolean): { text: string; said: number; total: number } {
  const kept: string[] = [];
  let said = 0;
  let total = 0;
  // One claim, judged whole: counted and dropped when the page already states
  // it, kept otherwise. A fragment too short to carry a claim is neither.
  const keep = (words: string): boolean => {
    if (words.length < 20) return true;
    total++;
    if (covered(words)) {
      said++;
      return false;
    }
    return true;
  };
  // Line by line, because a section in the mindmap shape is a lead line and
  // a list, and a list has no sentence ends: split on those alone, three
  // bullets read as one sentence and came back as one line. A bullet is one
  // claim and keeps its own line and indent; a paragraph line is still judged
  // a sentence at a time, as before.
  for (const line of prose.split("\n")) {
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+([\s\S]*)$/.exec(line);
    if (bullet) {
      // The check sees the bullet's words: marker gone, emphasis marks gone.
      if (keep(proseWords(bullet[1].replace(/\*\*|__|\*|_/g, "")))) kept.push(line);
      continue;
    }
    const sentences = line
      .split(/(?<=[.!?])\s+/)
      .map((x) => x.trim())
      .filter(Boolean);
    const rest = sentences.filter((sentence) => keep(proseWords(sentence)));
    // A paragraph line stays while any of it does; a blank line stays as the
    // gap it was, so the list it separates is still a list.
    if (rest.length > 0 || sentences.length === 0) kept.push(rest.join(" "));
  }
  return { text: kept.join("\n").trim(), said, total };
}

/** Whether a rectangle row is a figure: geometry only, no words. */
function isFigure(h: ManifestHighlight): boolean {
  return !!h.target.rect && !h.text;
}

/**
 * The article body: the opening under Definition (a concept) or Description
 * (an entity), then each section's prose with the highlights it quotes as
 * PDF++ callouts beneath, figures under their own heading, and the related
 * pages last. Unnamed sections — older drafts — sit under the opening.
 */
function renderArticleBody(pdfBasename: string, kind: WikiKind, article: Article, related: string[]): string {
  const lines: string[] = [];
  const callouts = (hs: ManifestHighlight[]) => joinRows(hs.filter((h) => !isFigure(h)).map((h) => renderQuoteCallout(pdfBasename, h)));

  lines.push(kind === "entity" ? "## Description" : "## Definition");
  if (article.definition.trim()) lines.push(article.definition.trim());
  for (const sec of article.sections.filter((x) => !x.heading)) {
    if (sec.prose.trim()) lines.push("", sec.prose.trim());
    const rows = callouts(sec.highlights);
    if (rows) lines.push("", rows);
  }
  lines.push("");

  for (const sec of article.sections.filter((x) => x.heading)) {
    lines.push(`## ${sec.heading}`);
    if (sec.prose.trim()) lines.push(sec.prose.trim());
    const rows = callouts(sec.highlights);
    if (rows) lines.push(sec.prose.trim() ? "" : "", rows);
    lines.push("");
  }

  if (article.figures.length) {
    lines.push("## Figures");
    for (const f of article.figures) lines.push(renderCallout(pdfBasename, f.target, wikiDisplay(pdfBasename, f.page), f.text));
    lines.push("");
  }

  lines.push("## Related topics");
  for (const r of related) lines.push(`- [[${r}]]`);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

export interface ArticleMergeResult extends MergeResult {
  /** Every section the merge wrote into or created, with the keys of the highlights it placed there. */
  sections: Array<{ heading: string; keys: string[]; created: boolean }>;
  /** Quotes and paragraphs the page already stated in other words, left out (see src/retrieval.ts coveredBy). */
  said: number;
}

/**
 * Merge an article into a page that already exists. Each section goes under
 * the page's heading of that name, or a new heading placed with the other
 * subtopics; prose the page already holds is not written twice, and a
 * highlight already on the page (by key) is not quoted again. With
 * `opts.section`, the whole article is filed under that one heading of the
 * page — the case where the model's proposal was a subtopic of a page the
 * reader already has — with each section's heading as a lead line. The
 * page's own opening is never touched: it already says what the page is.
 */
export function mergeArticle(
  existingMd: string,
  pdfBasename: string,
  article: Article,
  opts: { section?: string; classCode?: string; covered?: (text: string) => boolean } = {},
): ArticleMergeResult {
  const existingKeys = new Set(findAllPdfReferences(existingMd).map((r) => highlightKey(r.target)));
  // Links reduced to their words on both sides, so prose that was written
  // with its citations rendered still reads as already present.
  const existingText = foldQuote(plainProse(existingMd));
  // Whether the page already states a thing in other words: the caller's
  // check, from the page's own evidence units. Without one, only exact
  // repeats are caught.
  const covered = opts.covered ?? (() => false);
  let body = existingMd;
  let added = 0;
  let skipped = 0;
  let said = 0;
  const filed: ArticleMergeResult["sections"] = [];

  const blockFor = (
    secs: ArticleSection[],
    leadLines: boolean,
  ): { text: string; keys: string[]; firstPage: number | null; quotes: ManifestHighlight[] } => {
    const parts: string[] = [];
    const keys: string[] = [];
    const quotes: ManifestHighlight[] = [];
    let firstPage: number | null = null;
    for (const sec of secs) {
      let prose = sec.prose.trim() && !existingText.includes(foldQuote(plainProse(sec.prose))) ? sec.prose.trim() : "";
      if (prose) {
        const pruned = pruneSaid(prose, covered);
        said += pruned.said;
        // A section the page has mostly said already is a restatement of what
        // the reader wrote, and the sentence or two the check let through is
        // not worth a heading of its own beside theirs. The whole section is
        // dropped, and its count says so.
        // Half is enough. A section the page has already said half of is a
        // rewrite of the reader's own words, and the rest of it is the model
        // filling around what it just restated; measured on a real digest
        // run, the sentences that survived at half were the weakest in the
        // draft.
        const mostlySaid = pruned.total >= 2 && pruned.said * 2 >= pruned.total;
        prose = mostlySaid ? "" : pruned.text;
        if (mostlySaid) said += pruned.total - pruned.said;
      }
      const quotable = sec.highlights.filter((h) => !isFigure(h));
      const unseen = quotable.filter((h) => !existingKeys.has(h.key));
      skipped += quotable.length - unseen.length;
      const fresh = unseen.filter((h) => {
        if (!covered(h.text)) return true;
        h.covered = true;
        said++;
        return false;
      });
      if (!prose && fresh.length === 0) continue;
      added += fresh.length;
      for (const h of fresh) {
        existingKeys.add(h.key);
        keys.push(h.key);
        if (firstPage === null) firstPage = h.page;
      }
      const chunk: string[] = [];
      if (leadLines && sec.heading) chunk.push(`**${sec.heading}**`);
      if (prose) chunk.push(prose);
      if (fresh.length) {
        chunk.push(joinRows(fresh.map((h) => renderQuoteCallout(pdfBasename, h))));
        quotes.push(...fresh);
      }
      parts.push(chunk.join("\n\n"));
    }
    return { text: parts.join("\n\n"), keys, firstPage, quotes };
  };

  const place = (heading: string, text: string, keys: string[], firstPage: number | null) => {
    if (!heading) {
      body = insertBeforeTrailing(body, text);
      filed.push({ heading: "", keys, created: false });
      return;
    }
    const found = findSection(body, heading);
    if (found) {
      body = spliceIntoSection(body, found.end, text);
      filed.push({ heading: found.heading, keys, created: false });
      return;
    }
    // Before founding a heading, look for one the page already has that
    // covers the same ground: the model renames freely ("Conduct Disorder and
    // Oppositional Defiant Disorder" for a section the reader called
    // "Attachment Disorders, Conduct Disorder, and Oppositional Defiant
    // Disorder"), and two headings about one subject is the duplication this
    // merge exists to avoid.
    const near = nearestHeading(body, heading);
    if (near) {
      body = spliceIntoSection(body, near.end, text);
      filed.push({ heading: near.heading, keys, created: false });
      return;
    }
    // A created heading links to the slide its first quote came from, as the
    // row merge does; one the reader wrote is matched, never rewritten.
    const link = firstPage !== null ? renderPdfLink(pdfBasename, { page: firstPage }, heading) : heading;
    body = insertBeforeTrailing(body, `## ${link}\n\n${text}`);
    filed.push({ heading, keys, created: true });
  };

  if (opts.section) {
    const secs: ArticleSection[] = [{ heading: "", prose: article.definition, highlights: [] }, ...article.sections];
    const { text, keys, firstPage } = blockFor(secs, true);
    if (text) place(safeHeading(opts.section), text, keys, firstPage);
    return { md: opts.classCode ? addClassCode(body, opts.classCode) : body, added, skipped, said, sections: filed };
  }

  for (const sec of article.sections) {
    const { text, keys, firstPage, quotes } = blockFor([sec], false);
    if (!text) continue;
    const heading = safeHeading(sec.heading);
    const found = heading ? findSection(body, heading) : null;
    if (!found) {
      place(heading, text, keys, firstPage);
      continue;
    }
    // Fold: each quote goes beside the line that already cites its slide;
    // what has no such line, and the section's prose, go at the end where a
    // summary belongs.
    const folded = new Set<string>();
    for (const h of quotes) {
      const end = nextHeadingAfter(body, found.end);
      const next = spliceBesideCitation(body, found.end, end, pdfBasename, h.page, renderQuoteCallout(pdfBasename, h));
      if (next !== null) {
        body = next;
        folded.add(h.key);
      }
    }
    const rest: string[] = [];
    const loose = quotes.filter((h) => !folded.has(h.key));
    if (loose.length) rest.push(joinRows(loose.map((h) => renderQuoteCallout(pdfBasename, h))));
    const prose = sec.prose.trim() ? text.split("\n\n").filter((part) => !part.startsWith("> ")).join("\n\n") : "";
    if (prose) rest.push(prose);
    if (rest.length) body = spliceIntoSection(body, found.end, rest.join("\n\n"));
    filed.push({ heading: found.heading, keys, created: false });
  }
  return { md: opts.classCode ? addClassCode(body, opts.classCode) : body, added, skipped, said, sections: filed };
}

export function planTopicNotes(draft: PlannerDraft, manifest: Manifest, opts: PlanTopicNotesOptions): PlanTopicNotesResult {
  const byId = new Map(manifest.highlights.map((h) => [h.id, h]));
  const unknownIds: string[] = [];
  const seenIds = new Set<string>();
  // Highlights the model filed but reported as only named by the source — a
  // slide title, a heading — which no page should hold. Kept apart from
  // unused_ids, which is the model's own list.
  const namedIds: string[] = [];

  interface Group {
    title: string;
    summary: string;
    highlights: ManifestHighlight[];
    related: string[];
    /** The page's opening, links resolved. */
    definition: string;
    sections: ArticleSection[];
  }
  // Merge duplicate titles (case-insensitive after safeTitle).
  const groups = new Map<string, Group>();
  const groupOrder: string[] = [];
  const orphans: string[] = [];
  const droppedIds: string[] = [];
  let droppedNotes = 0;

  // What a marker or a citation may resolve to: the pages the model was
  // shown, then the notes of this draft at the paths they would be written
  // to, so a page may mention another page born in the same run.
  const linkable: LinkablePage[] = [
    ...opts.pages.map((pg) => ({ path: pg.path, title: pg.title, aliases: pg.aliases })),
    ...draft.notes.map((n) => ({ path: `${opts.topicFolder}/${opts.classCode}/${safeTitle(n.title)}.md`, title: safeTitle(n.title), aliases: n.aliases ?? [] })),
  ];
  const citable = manifest.highlights.map((h) => ({ id: h.id, page: h.page, target: h.target }));
  const resolve = (text: string) =>
    resolveProseLinks(text ?? "", linkable, citable, manifest.pdfBasename, (page) => wikiDisplay(manifest.pdfBasename, page));

  for (const note of draft.notes) {
    const title = safeTitle(note.title);
    const groupKey = title.toLowerCase();

    const validHighlights: ManifestHighlight[] = [];
    const cited = new Set<string>();
    const noteOrphans = new Set<string>();
    const take = (r: ReturnType<typeof resolve>) => {
      for (const o of r.orphans) noteOrphans.add(o);
      for (const d of r.droppedIds) {
        seenIds.add(d);
        if (!droppedIds.includes(d)) droppedIds.push(d);
        if (!unknownIds.includes(d)) unknownIds.push(d);
      }
      for (const id of r.citedIds) {
        seenIds.add(id);
        cited.add(id);
      }
    };

    const definition = resolve(note.summary ?? "");
    take(definition);

    const shaped = sectionsOf(note);
    for (const id of shaped.named) {
      seenIds.add(id);
      if (!namedIds.includes(id)) namedIds.push(id);
    }
    const sections: ArticleSection[] = [];
    for (const sec of shaped.sections) {
      const prose = resolve(sec.prose ?? "");
      take(prose);
      const quoted: ManifestHighlight[] = [];
      for (const id of sec.quote_ids ?? []) {
        seenIds.add(id);
        const h = byId.get(id);
        if (!h) {
          if (!unknownIds.includes(id)) unknownIds.push(id);
          continue;
        }
        // A copy: the manifest records what the reader highlighted, the row
        // records what the page did with it. The prose around the quote rides
        // along for the card writer.
        const row: ManifestHighlight = { ...h, verbatim: true };
        if (prose.prose) row.passage = plainProse(prose.prose);
        if (!quoted.some((x) => x.key === h.key)) quoted.push(row);
        if (!validHighlights.some((x) => x.key === h.key)) validHighlights.push(row);
      }
      if (prose.prose || quoted.length) sections.push({ heading: safeHeading(sec.heading ?? ""), prose: prose.prose, highlights: quoted });
    }
    // A highlight cited in prose but quoted nowhere still belongs to the page.
    for (const id of cited) {
      const h = byId.get(id);
      if (h && !validHighlights.some((x) => x.key === h.key)) validHighlights.push({ ...h, verbatim: true });
    }

    if (validHighlights.length === 0) {
      droppedNotes++;
      continue;
    }
    for (const o of noteOrphans) if (!orphans.includes(o)) orphans.push(o);

    let group = groups.get(groupKey);
    if (!group) {
      group = { title, summary: plainProse(definition.prose) || (note.summary ?? ""), highlights: [], related: [], definition: definition.prose, sections: [] };
      groups.set(groupKey, group);
      groupOrder.push(groupKey);
    } else if (!group.definition && definition.prose) {
      group.definition = definition.prose;
    }
    for (const h of validHighlights) {
      if (!group.highlights.some((existing) => existing.key === h.key)) group.highlights.push(h);
    }
    group.sections.push(...sections);
    for (const r of note.related) {
      if (!group.related.includes(r)) group.related.push(r);
    }
  }

  // Unassigned: highlights that appear in no note and are not in unused_ids.
  // A named highlight was filed and set aside on purpose, so it is neither.
  const unusedSet = new Set([...draft.unused_ids, ...namedIds]);
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

    const article: Article = {
      definition: group.definition,
      sections: group.sections,
      figures: group.highlights.filter(isFigure),
    };
    const coveredIn = (path: string | null) => (opts.coveredBy ? (text: string) => opts.coveredBy!(path, text) : undefined);

    const home = byName.get(group.title.toLowerCase());
    if (home) {
      const merged = mergeArticle(mdOf(home), manifest.pdfBasename, article, { classCode: opts.classCode, covered: coveredIn(home.path) });
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
        said: merged.said,
        kind: home.kind,
        sections: merged.sections.length ? merged.sections : undefined,
        article,
        articles: [{ article }],
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
      const merged = mergeArticle(mdOf(target), manifest.pdfBasename, article, { section: route.heading || undefined, classCode: opts.classCode, covered: coveredIn(target.path) });
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
        said: merged.said,
        kind: target.kind,
        sections: merged.sections.length ? merged.sections : undefined,
        article,
        articleSection: route.heading || undefined,
        articles: [{ article, section: route.heading || undefined }],
        routed: [{ from: group.title, heading: route.heading, why: route.why, keys: group.highlights.map((h) => h.key) }],
        groups: [group.title],
      });
      continue;
    }

    const kind: WikiKind = draftNote?.kind ?? "concept";
    // A new page quotes every highlight filed under it — they belong there —
    // but a row some page of the class already states is flagged, so the
    // preview can say so and no card is written for it.
    const classWide = coveredIn(null);
    let saidElsewhere = 0;
    if (classWide) {
      for (const h of group.highlights) {
        if (!isFigure(h) && classWide(h.text)) {
          h.covered = true;
          saidElsewhere++;
        }
      }
    }
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
        article,
      }),
      added: group.highlights.length,
      skipped: 0,
      said: saidElsewhere,
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
    if (note.said) seen.said = (seen.said ?? 0) + note.said;
    if (note.sections?.length) seen.sections = [...(seen.sections ?? []), ...note.sections];
    if (note.routed?.length) seen.routed = [...(seen.routed ?? []), ...note.routed];
    // The content above is the sequential merge of every group, so the write's
    // replay must run every group's article too, or the later ones are counted
    // as appended and never written.
    if (note.articles?.length) seen.articles = [...(seen.articles ?? []), ...note.articles];
    for (const r of note.related) if (!seen.related.includes(r)) seen.related.push(r);
    for (const g of note.groups) if (!seen.groups.includes(g)) seen.groups.push(g);
  }

  return { notes: coalesced, unknownIds, unassignedIds, namedIds, orphans, droppedIds, droppedNotes };
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
export function applyDigestChoices<D extends PlannerDraft>(
  draft: D,
  planned: PreparedNote[],
  chosen: DigestChoice[],
): { draft: D; keepAsNew: string[] } {
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
 * One highlight as a page prints it, by the reader's rule of 2026-09-24.
 *
 * A note-sourced row is its citation line; a rectangle with no text is the
 * bare embed, so the figure draws. A row the digest wrote a passage for is a
 * bullet whose link text is the label — the same shape the reader's own
 * class notes use, `[[slide|phrase]]: what it means` — and whose body is the
 * passage. Everything else is a direct quote, and a direct quote is a PDF++
 * callout whose link text is the file's title and page, the way PDF++ itself
 * copies one. A quote that was a list on the slide is a list inside the
 * callout.
 */
export function renderHighlightRow(pdfBasename: string, h: ManifestHighlight): string {
  if (h.mention) return h.mention;
  if (h.target.rect && !h.text) return renderCallout(pdfBasename, h.target, wikiDisplay(pdfBasename, h.page), h.text);
  const passage = h.verbatim ? "" : (h.passage ?? "").replace(/\s*\n+\s*/g, " ").replace(/\s+/g, " ").trim();
  if (passage) return `- ${renderPdfLink(pdfBasename, h.target, rowLabel(h))}: ${passage}`;
  return renderQuoteCallout(pdfBasename, h);
}

/** The most a label may run to before the quote's first clause stands in for it. */
const LABEL_MAX = 60;

/**
 * The link text of a passage row: the model's label when it gave one, else
 * the quote when it is short enough to read as one, else the quote's first
 * clause. Never link syntax — a pipe or a bracket inside the display text
 * would end the link early.
 */
export function rowLabel(h: ManifestHighlight): string {
  const clean = (s: string) => s.replace(/[|[\]]/g, "").replace(/\s+/g, " ").trim();
  const label = clean(h.label ?? "");
  if (label) return label;
  const text = clean(h.text);
  if (text.length <= LABEL_MAX) return text;
  const clause = text.split(/[.;:—–]\s|,\s/)[0].trim();
  if (clause.length > 0 && clause.length <= LABEL_MAX) return clause;
  return `${text.slice(0, LABEL_MAX - 1).replace(/\s+\S*$/, "")}…`;
}

/** A direct quote as PDF++ writes one: the callout header with the Title-and-page link, the quote beneath, a list kept as a list. */
function renderQuoteCallout(pdfBasename: string, h: ManifestHighlight): string {
  const link = renderPdfLink(pdfBasename, h.target, wikiDisplay(pdfBasename, h.page));
  const lines = [`> ${calloutHeader(h.color ?? h.target.color ?? null)} ${link}`];
  const { lead, items, ordered, start } = splitInlineList(h.text);
  if (lead) lines.push(`> > ${lead}`);
  items.forEach((item, i) => lines.push(`> > ${ordered ? `${start + i}.` : "-"} ${item}`));
  if (!lead && items.length === 0) lines.push(`> > ${h.text.replace(/\s+/g, " ").trim()}`);
  return lines.join("\n");
}

/**
 * What the card writer is told about a highlight the digest filed: which
 * page took it, the label it wears there, the passage the page holds for it,
 * and the reader's own notes. The card is a view of the note — the passage
 * is the knowledge — but the highlight stays the source it must be true to,
 * so cloze grounding still checks against the slide's words.
 */
export function renderRowInstruction(h: ManifestHighlight, pageTitle: string): string {
  const lines = [`This highlight was digested into the wiki page "${pageTitle}", filed as: ${rowLabel(h)}.`];
  const passage = h.verbatim ? "" : (h.passage ?? "").trim();
  if (passage) lines.push(`The page's passage for it:\n${passage}`);
  else lines.push("The page keeps the highlight's own wording, verbatim.");
  if (h.notes?.trim()) lines.push(`The reader's own notes under it:\n${h.notes.trim()}`);
  lines.push(
    "Card what the page says about this highlight. Everything the card asserts has to be in the highlight itself; where the passage or the notes go further than the highlight does, follow the highlight.",
  );
  return lines.join("\n");
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
 * The closed tag vocabularies, as existing pages actually use them.
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
 * quote nearly all of their aliases, so emitting a bare scalar where one is
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
 * A wiki page in karpathywiki's schema, so the pages already in the vault
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
 * `class:` + `## Summary` / `## Highlights` form some vaults use, chosen
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
/**
 * Insert `text` in a section, directly after the last line that already cites
 * the same page of the same PDF; null when the section cites it nowhere.
 *
 * This is the fold: the reader's own note already links the slide, often as
 * a heading of their own with their bullets beneath it, and the quote from
 * that slide belongs there rather than in a block at the end. The insert
 * goes after the line's own indented continuation lines, so a quote never
 * splits a list from its lead.
 */
export function spliceBesideCitation(body: string, headingEnd: number, sectionEnd: number, pdfBasename: string, page: number, text: string): string | null {
  const section = body.slice(headingEnd, sectionEnd);
  const lines = section.split("\n");
  const wanted = pdfFileName(pdfBasename).toLowerCase();
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    for (const ref of findAllPdfReferences(lines[i])) {
      if (`${ref.pdfBasename.toLowerCase()}.pdf` === wanted && ref.target.page === page) at = i;
    }
  }
  if (at < 0) return null;
  // Past the cited line's own nested lines, so a list stays whole.
  let end = at;
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") break;
    // A blockquote line at any depth continues it: a PDF++ callout is the
    // header line plus its `> >` quote and `>` comment lines, and a quote
    // inserted after the header alone would split the reader's callout.
    if (!/^\s+\S/.test(l) && !/^\s*(?:[-*+]|\d+[.)])\s/.test(l) && !/^\s*>/.test(l)) break;
    end = i;
  }
  const before = lines.slice(0, end + 1).join("\n").replace(/\n*$/, "");
  const after = lines.slice(end + 1).join("\n").replace(/^\n*/, "");
  return body.slice(0, headingEnd) + `${before}\n\n${text}` + (after ? `\n\n${after}` : "\n") + body.slice(sectionEnd);
}

/**
 * Replay a planned row's articles against the page as it reads now, in the
 * order the planner merged them, so a page that took two groups gets both.
 */
export function replayArticles(
  current: string,
  pdfBasename: string,
  articles: Array<{ article: Article; section?: string }>,
  opts: { classCode?: string; covered?: (text: string) => boolean },
): string {
  let md = current;
  for (const { article, section } of articles) {
    md = mergeArticle(md, pdfBasename, article, { classCode: opts.classCode, section, covered: opts.covered }).md;
  }
  return md;
}

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

/** Words of a heading worth matching on: the significant ones, folded. */
function headingWords(heading: string): Set<string> {
  const stop = new Set(["and", "or", "the", "of", "in", "a", "an", "for", "with", "to", "disorder", "disorders"]);
  return new Set(
    headingDisplay(heading)
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3 && !stop.has(w)),
  );
}

/**
 * A heading the page already has that covers the same subject as `wanted`:
 * one whose significant words are a subset of the other's, in either
 * direction. "Conduct Disorder and Oppositional Defiant Disorder" finds the
 * reader's "Attachment Disorders, Conduct Disorder, and Oppositional Defiant
 * Disorder"; "Treatment" does not match "Causes". Null when nothing fits.
 */
export function nearestHeading(body: string, wanted: string): HeadingLine | null {
  const want = headingWords(wanted);
  if (want.size === 0) return null;
  for (const h of scanHeadings(body)) {
    const have = headingWords(h.heading);
    if (have.size === 0) continue;
    const shared = [...want].filter((w) => have.has(w)).length;
    if (shared === want.size || shared === have.size) return h;
  }
  return null;
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
