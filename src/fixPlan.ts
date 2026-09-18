/**
 * The plan behind the **Suggest fixes** button: one proposed edit per finding.
 *
 * `src/vaultLint.ts` reports and repairs nothing; `src/vaultFix.ts` repairs one
 * kind of finding, the dead link that is only a spelling apart from its page.
 * This module turns every other finding into the same shape — a `Fix`: a label
 * a reader can read in one line, and a pure function from the note's text to
 * the note's text. Nothing here writes. The plan modal applies the fixes the
 * reader leaves ticked, through `vault.process`, so the edit runs against what
 * the note says at apply time rather than what it said when the plan was built.
 *
 * The order the planners are applied in is upstream's (gd4ai/obsidian-llm-wiki
 * Smart Fix All, Apache-2.0 — the causal order is reimplemented, no code
 * copied): names first, then the links that depend on names, then the evidence
 * that depends on the links. `orderFixes` is that order.
 *
 * Two rules hold for every edit function here, and the tests check both:
 * applying it twice equals applying it once, and it returns its input
 * byte-identical when there is nothing to do. A planner is deterministic: the
 * same findings give the same rows in the same order.
 *
 * Pure: no `obsidian` import, the same rule as `vaultLint` and `vaultFix`, so
 * the tests bundle it standalone and a plan can be built without a vault.
 */
import type { VaultIssue } from "./vaultLint";
import type { FixPage, LinkFix, FixConfidence } from "./vaultFix";
import { applyLinkFix, buildReplacement } from "./vaultFix";
import { findAllPdfReferences, highlightKey, parsePdfSubpath, renderCallout } from "./pdflink";
import { linkKey } from "./graph";
import { findSection, spliceIntoSection, insertBeforeTrailing } from "./topicNote";

/** What a row of the plan does, which is also what heading it sits under. */
export type FixKind =
  | "cross-link"
  | "relink"
  | "repoint"
  | "hub-link"
  | "related-link"
  | "rect-callout"
  | "attribute"
  | "aliases"
  | "tag";

/** One proposed edit: a row in the plan, and the pure function it applies. */
export interface Fix {
  /** `${kind}:${path}:${n}` — stable within a plan, so a row can be replaced by id. */
  id: string;
  kind: FixKind;
  /** The note the edit is applied to, which is not always the note the finding is about. */
  path: string;
  /** One line for the row: what changes, in words. */
  label: string;
  /** Ticked by default? */
  enabled: boolean;
  /** A repoint waits for the reader to pick a note; until then it applies nothing. */
  needsTarget?: boolean;
  /** The dead link a repoint row is about, carried rather than parsed back out of the label. */
  target?: string;
  /** Pure; returns `content` unchanged when there is nothing to do. */
  apply: (content: string) => string;
}

/** Which of the two schemas this vault holds a page under. */
export type PageSchema = "class" | "karpathy";

/** What a planner needs to know about a page to propose an edit to or about it. */
export interface FixPageInfo {
  path: string;
  title: string;
  displayTitle?: string;
  schema: PageSchema;
  kind: "concept" | "entity";
  classCodes: string[];
  content: string;
}

/** The name a row shows for a page: its heading when it has one, else its filename. */
function shown(page: { title: string; displayTitle?: string }): string {
  return page.displayTitle || page.title;
}

/**
 * Compare quotes the way a reader means them rather than the way a keyboard
 * typed them. The same folding as `vaultLint`'s `normalizeForQuote`, kept local
 * because that one is private and this module must not depend on its internals.
 */
function fold(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** A link target as a page identity: no folder, no `|display`, no `#heading`, no extension. */
function targetKey(rawTarget: string): string {
  const noAnchor = rawTarget.split("#")[0];
  return linkKey(noAnchor.trim());
}

/** Every `[[…]]` target in a stretch of markdown, folded to a page identity. */
function linkedKeys(section: string): Set<string> {
  const keys = new Set<string>();
  const re = /!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section))) keys.add(targetKey(m[1]));
  return keys;
}

/** The related section a page of this schema keeps links to a target of this kind under. */
export function relatedHeading(schema: PageSchema, kind: "concept" | "entity"): string {
  if (schema === "class") return "Related topics";
  return kind === "entity" ? "Related Entities" : "Related Concepts";
}

// ------------------------------------------------------------------ edits

/**
 * Add `- [[linkPath|display]]` to the page's related section.
 *
 * The section is the one the schema names — `## Related topics` for a class
 * page, `## Related Concepts` or `## Related Entities` for a karpathy page, by
 * the *target's* kind, because that is what the section is a list of. A link
 * already there under any spelling (a slug path, a display alias, a heading
 * anchor) counts as there: the comparison is `linkKey`, the same identity the
 * graph resolves links by, so the fix does not add a second link to one page.
 *
 * A karpathy page missing the section gains it before its trailing headings,
 * where `mergeWikiHighlights` puts a new one: there Related Concepts and
 * Related Entities do precede Mentions in Source. A class page's order is the
 * one `renderTopicNote` writes — Summary, Highlights, Related topics,
 * Flashcard Seeds — so a created `## Related topics` goes before
 * `## Flashcard Seeds` when the page has one and at the end when it does not,
 * never ahead of Highlights.
 *
 * The new line joins the existing list rather than going through
 * `spliceIntoSection`: that one separates what it appends with a blank line,
 * which is right for a block of highlights and wrong for a bullet list, where
 * a blank line ends the list and starts another.
 */
export function addRelatedLink(
  md: string,
  linkPath: string,
  display: string,
  schema: PageSchema,
  kind: "concept" | "entity",
): string {
  const heading = relatedHeading(schema, kind);
  const wanted = targetKey(linkPath);
  if (!wanted) return md;

  const line = `- [[${linkPath}|${display}]]`;
  const found = findSection(md, heading);
  if (!found) {
    // Nowhere to look, so nothing can already be there.
    // `renderTopicNote` writes the list directly under its heading; a created
    // section matches that rather than the blank-line shape of a prose section.
    const section = `## ${heading}\n${line}`;
    if (schema !== "class") return insertBeforeTrailing(md, section);
    const seeds = /^##\s+Flashcard Seeds\s*$/m.exec(md);
    if (!seeds) return `${md.replace(/\n*$/, "")}\n\n${section}\n`;
    return `${md.slice(0, seeds.index).replace(/\n*$/, "")}\n\n${section}\n\n${md.slice(seeds.index)}`;
  }

  const rest = md.slice(found.end);
  const next = /^##\s/m.exec(rest);
  const sectionEnd = next ? found.end + next.index : md.length;
  const section = md.slice(found.end, sectionEnd);
  if (linkedKeys(section).has(wanted)) return md;

  // After the section's last list line, so the list stays one list. A section
  // holding prose and no list falls back to the block append.
  const listLine = /^[ \t]*-\s.*$/gm;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = listLine.exec(section))) last = m;
  // A section with prose and no list gets the line as its own block; an empty
  // one gets it on the line under the heading, where the renderer puts it.
  if (!last) return section.trim() ? spliceIntoSection(md, found.end, line) : `${md.slice(0, found.end)}\n${line}${md.slice(found.end)}`;

  const at = found.end + last.index + last[0].length;
  return `${md.slice(0, at)}\n${line}${md.slice(at)}`;
}

/**
 * Add the page to a hub's list of pages.
 *
 * A hub reads `# PHED163`, then a module heading with `- [[Page]]` lines under
 * it, then `## Sources` with the PDFs. The new line goes after the last list
 * line that comes before Sources — the end of the last module — rather than at
 * EOF, where it would land among the sources and read as one.
 */
export function hubListLink(md: string, linkPath: string, display: string): string {
  const wanted = targetKey(linkPath);
  if (!wanted) return md;
  if (linkedKeys(md).has(wanted)) return md;

  const line = `- [[${linkPath}|${display}]]`;
  const sources = /^##\s+Sources\s*$/m.exec(md);
  const limit = sources ? sources.index : md.length;
  const head = md.slice(0, limit);

  const listLine = /^[ \t]*-\s*!?\[\[/gm;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = listLine.exec(head))) last = m;

  if (last) {
    const lineEnd = head.indexOf("\n", last.index);
    const at = lineEnd < 0 ? head.length : lineEnd;
    return `${md.slice(0, at)}\n${line}${md.slice(at)}`;
  }

  if (sources) return `${md.slice(0, limit).replace(/\n*$/, "")}\n\n${line}\n\n${md.slice(limit)}`;
  return `${md.replace(/\n*$/, "")}\n\n${line}\n`;
}

/**
 * Turn a bare rectangle embed into the PDF++ callout that carries its text.
 *
 * A rect embed shows the reader a picture of the page and tells the lint
 * nothing: no text means no evidence. The callout says the same words in
 * markdown, keeping the link, so the quote is searchable and checkable. With no
 * text — a scan with no text layer — there is nothing to say and the note is
 * returned unchanged rather than mangled into an empty callout.
 */
export function rectToCallout(md: string, key: string, pdfBasename: string, text: string): string {
  if (!text.trim()) return md;

  const ref = findAllPdfReferences(md).find(
    (r) => r.embed && r.pdfBasename === pdfBasename && highlightKey(r.target) === key,
  );
  if (!ref) return md;

  const lines = md.split("\n");
  if (ref.line < 0 || ref.line >= lines.length) return md;
  const replacement = renderCallout(pdfBasename, ref.target, ref.display, text.trim());
  const line = lines[ref.line];
  if (line === replacement) return md;

  // Only the embed's own `![[…]]` span is rewritten, so prose sharing the line
  // and a second embed beside it both survive. A callout must begin at the
  // start of a line, so what sat before the embed keeps its own line above the
  // callout and what sat after it gets its own line below.
  const embeds = /!\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = embeds.exec(line))) {
    const hash = m[1].indexOf("#");
    if (hash < 0) continue;
    const parsed = parsePdfSubpath(m[1].slice(hash + 1).split("|")[0]);
    if (!parsed || highlightKey(parsed) !== key) continue;

    const before = line.slice(0, m.index).replace(/\s+$/, "");
    const after = line.slice(m.index + m[0].length).replace(/^\s+/, "");
    const parts = [before, replacement, after].filter((p) => p !== "");
    lines.splice(ref.line, 1, ...parts.join("\n").split("\n"));
    return lines.join("\n");
  }
  return md;
}

/**
 * Name the source a quote came from, on the bullet that holds it.
 *
 * The search is bounded to `## Mentions in Source`, from that heading to the
 * next `## ` heading or EOF, because that block is the only place
 * `vaultLint`'s `mentionQuotes` raises an `unattributed-quote` from. A note
 * repeating the same bullet under `## Highlights` would otherwise have the
 * wrong bullet cited: the finding would stand and the next Apply would cite
 * again.
 *
 * Only a bullet with no citation is touched: one that already says
 * ` — [[somewhere]]` is the reader's attribution, right or wrong, and not this
 * module's to overwrite. The match folds smart quotes and runs of whitespace,
 * so a quote copied out of a PDF still finds its bullet.
 */
export function attributeQuote(md: string, quote: string, sourceLinkPath: string): string {
  const needle = fold(quote).replace(/^["']|["']$/g, "");
  if (!needle) return md;

  const heading = /^##\s+Mentions in Source\s*$/m.exec(md);
  if (!heading) return md;
  const blockStart = heading.index + heading[0].length;
  const after = /^##\s/m.exec(md.slice(blockStart));
  const blockEnd = after ? blockStart + after.index : md.length;

  const lines = md.split("\n");
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    // Where this line starts in `md`, so the scan can stay inside the block.
    const lineStart = offset;
    offset += lines[i].length + 1;
    if (lineStart < blockStart) continue;
    if (lineStart >= blockEnd) break;

    const line = lines[i];
    if (!/^[ \t]*-\s/.test(line)) continue;
    if (line.includes(" — [[")) continue;
    const body = fold(line.replace(/^[ \t]*-\s*/, "")).replace(/^["']|["']$/g, "");
    if (body !== needle) continue;
    lines[i] = `${line.replace(/\s*$/, "")} — [[${sourceLinkPath}]]`;
    return lines.join("\n");
  }
  return md;
}

/** Frontmatter as text, and where it sits, or null when the note has none. */
function frontmatter(md: string): { body: string; start: number; end: number } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m || m.index !== 0) return null;
  return { body: m[1], start: m.index, end: m.index + m[0].length };
}

/** Replace the frontmatter's body, keeping the fences. */
function withFrontmatter(md: string, fm: { start: number; end: number }, body: string): string {
  return `${md.slice(0, fm.start)}---\n${body}\n---${md.slice(fm.end)}`;
}

/**
 * Write the page's other names into `aliases:`, existing ones first.
 *
 * Always the quoted block form, because that is what the vault's own pages
 * hold and a mixed file is harder to read than a rewritten one. A name already
 * there under a different case is not added twice; a proposal that adds nothing
 * new leaves the note alone.
 */
export function setAliases(md: string, aliases: string[]): string {
  const clean = aliases.map((a) => a.trim()).filter(Boolean);
  if (clean.length === 0) return md;

  const fm = frontmatter(md);
  const existing = fm ? readList(fm.body, "aliases") : [];
  const seen = new Set(existing.map((a) => a.toLowerCase()));
  const merged = [...existing];
  for (const a of clean) {
    if (seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    merged.push(a);
  }

  const block = ["aliases:", ...merged.map((a) => `  - ${JSON.stringify(a)}`)].join("\n");
  if (!fm) return `---\n${block}\n---\n\n${md.replace(/^\n+/, "")}`;
  if (merged.length === existing.length && hasBlockAliases(fm.body, merged)) return md;

  const stripped = dropKey(fm.body, "aliases");
  const tags = /^tags:.*$/m.exec(stripped);
  const body = tags
    ? `${stripped.slice(0, tags.index + tags[0].length)}\n${block}${stripped.slice(tags.index + tags[0].length)}`
    : `${stripped.replace(/\n*$/, "")}\n${block}`;
  return withFrontmatter(md, fm, body);
}

/** Whether `aliases` is already exactly this block, so rewriting it would change nothing. */
function hasBlockAliases(fm: string, wanted: string[]): boolean {
  const block = ["aliases:", ...wanted.map((a) => `  - ${JSON.stringify(a)}`)].join("\n");
  return fm.includes(block);
}

/** A frontmatter key's values, inline (`[a, b]`) or as a block list. */
function readList(fm: string, key: string): string[] {
  const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "").trim();
  const inline = new RegExp(`^${key}:\\s*\\[(.*)\\]\\s*$`, "m").exec(fm);
  if (inline) return inline[1].split(",").map(unquote).filter(Boolean);
  const block = new RegExp(`^${key}:\\s*\\n((?:[ \\t]*-[^\\n]*\\n?)*)`, "m").exec(fm);
  if (block) return block[1].split("\n").map((l) => unquote(l.replace(/^[ \t]*-\s*/, ""))).filter(Boolean);
  return [];
}

/** Remove a key and whatever block list hangs off it. */
function dropKey(fm: string, key: string): string {
  const block = new RegExp(`^${key}:\\s*\\n(?:[ \\t]*-[^\\n]*\\n?)*`, "m");
  if (block.test(fm)) return fm.replace(block, "").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "");
  return fm.replace(new RegExp(`^${key}:.*\\n?`, "m"), "").replace(/\n+$/, "");
}

/**
 * Set the page's one tag, in the inline form the generator writes.
 *
 * A page carries a single subtype, so a `tags:` holding two is replaced rather
 * than appended to; a page with no `tags:` at all gets one after `type:`, where
 * the schema's own renderer puts it.
 */
export function setTag(md: string, tag: string): string {
  const clean = tag.trim();
  if (!clean) return md;

  const fm = frontmatter(md);
  const line = `tags: [${clean}]`;
  if (!fm) return `---\n${line}\n---\n\n${md.replace(/^\n+/, "")}`;
  if (readList(fm.body, "tags").join(",") === clean) return md;

  const stripped = dropKey(fm.body, "tags");
  const type = /^type:.*$/m.exec(stripped);
  const body = type
    ? `${stripped.slice(0, type.index + type[0].length)}\n${line}${stripped.slice(type.index + type[0].length)}`
    : `${line}\n${stripped}`;
  return withFrontmatter(md, fm, body);
}

/** Point a dead link at the page the reader chose, keeping any display text they wrote. */
export function repoint(md: string, fromTarget: string, page: FixPage, wikiPrefix: string): string {
  return applyLinkFix(md, fromTarget, buildReplacement(page, wikiPrefix));
}

// --------------------------------------------------------------- planners

/** How a relink's tier reads in a row: why the plugin thinks these are one page. */
const CONFIDENCE_WORDS: Record<FixConfidence, string> = {
  title: "same name",
  alias: "an alias of the page",
  slug: "same name, different spelling",
  "alias-slug": "an alias, different spelling",
};

/** The path a wikilink should carry: vault-relative, without the wiki folder or the extension. */
function linkPathOf(path: string, wikiPrefix = "wiki/"): string {
  const prefix = wikiPrefix.endsWith("/") ? wikiPrefix : `${wikiPrefix}/`;
  const rel = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  return rel.replace(/\.md$/i, "");
}

/**
 * Two pages about one subject, linked both ways.
 *
 * The design's second decision: never merged. A merge picks a winner and
 * destroys a page the reader wrote; a cross-link says "these two are about the
 * same thing" and leaves both standing, which is the claim the lint actually
 * made.
 */
export function planCrossLinks(issues: VaultIssue[], pages: Map<string, FixPageInfo>): Fix[] {
  const fixes: Fix[] = [];
  let n = 0;
  for (const issue of issues) {
    if (issue.id !== "duplicate-pages" || !issue.target) continue;
    const a = pages.get(issue.path);
    const b = pages.get(issue.target);
    if (!a || !b) continue;

    const label = `Link ${shown(a)} ↔ ${shown(b)}`;
    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as Array<[FixPageInfo, FixPageInfo]>) {
      fixes.push({
        id: `cross-link:${from.path}:${n++}`,
        kind: "cross-link",
        path: from.path,
        label,
        enabled: true,
        apply: (content) => addRelatedLink(content, linkPathOf(to.path), shown(to), from.schema, to.kind),
      });
    }
  }
  return fixes;
}

/** The dead links the link fixer already resolved, as rows a reader can untick. */
export function planRelinks(fixable: LinkFix[]): Fix[] {
  return fixable.map((fix, n) => ({
    id: `relink:${fix.path}:${n}`,
    kind: "relink" as const,
    path: fix.path,
    label: `Rewrite → ${linkPathOf(fix.toPath)} (${CONFIDENCE_WORDS[fix.confidence]})`,
    enabled: true,
    apply: (content: string) => applyLinkFix(content, fix.from, fix.to),
  }));
}

/**
 * A dead link to a page nobody wrote.
 *
 * There is no repair here that a machine can make honestly — the design forbids
 * stubs, unlinking and guessing — so the row is a question, not an edit: it
 * applies nothing and stays unticked until the reader names a note, at which
 * point `repointFix` turns it into a concrete rewrite.
 */
export function planRepoints(unresolved: VaultIssue[]): Fix[] {
  const fixes: Fix[] = [];
  let n = 0;
  for (const issue of unresolved) {
    if (issue.id !== "dead-link" || !issue.target) continue;
    fixes.push({
      id: `repoint:${issue.path}:${n++}`,
      kind: "repoint",
      path: issue.path,
      label: `Point at… (${issue.target})`,
      enabled: false,
      needsTarget: true,
      target: issue.target,
      apply: (content: string) => content,
    });
  }
  return fixes;
}

/**
 * The target of a repoint row, once the reader has picked one. The row keeps
 * its id, so the modal can swap it in place, and reads the dead link off the
 * row's `target` rather than out of its label, which is prose and may hold
 * anything a link target may hold.
 */
export function repointFix(row: Fix, page: FixPage, wikiPrefix: string): Fix {
  const target = row.target ?? "";
  return {
    ...row,
    label: `Point at ${linkPathOf(page.path, wikiPrefix)} (${target})`,
    enabled: true,
    needsTarget: false,
    apply: (content: string) => (target ? repoint(content, target, page, wikiPrefix) : content),
  };
}

/** The issues that say a page hangs off the graph, deduplicated by path. */
function unlinkedPaths(issues: VaultIssue[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const issue of issues) {
    if (issue.id !== "unlinked" && issue.id !== "orphan") continue;
    if (seen.has(issue.path)) continue;
    seen.add(issue.path);
    out.push(issue.path);
  }
  return out;
}

/**
 * List an unlinked page in its class's index note.
 *
 * A hub is where a class's pages are meant to be reachable from, so a page its
 * class has a hub for belongs in that hub's list rather than bolted onto some
 * neighbour. The hub itself is skipped: a note linking to itself is not a fix.
 */
export function planHubLinks(
  issues: VaultIssue[],
  pages: Map<string, FixPageInfo>,
  hubs: Map<string, FixPageInfo>,
): Fix[] {
  const fixes: Fix[] = [];
  let n = 0;
  for (const path of unlinkedPaths(issues)) {
    const page = pages.get(path);
    if (!page) continue;
    const code = page.classCodes.find((c) => hubs.has(c));
    if (!code) continue;
    const hub = hubs.get(code);
    if (!hub || hub.path === page.path) continue;

    fixes.push({
      id: `hub-link:${hub.path}:${n++}`,
      kind: "hub-link",
      path: hub.path,
      label: `List ${shown(page)} in ${shown(hub)} hub`,
      enabled: true,
      apply: (content) => hubListLink(content, linkPathOf(page.path), shown(page)),
    });
  }
  return fixes;
}

/**
 * Link an unlinked page from the page nearest it in the graph.
 *
 * For a page whose class has no hub. The edit goes in the *neighbour*, not the
 * orphan: a page is an orphan because nothing points at it, and adding outgoing
 * links to it would not change that.
 */
export function planRelatedFrom(
  issues: VaultIssue[],
  pages: Map<string, FixPageInfo>,
  neighbourOf: (path: string) => FixPageInfo | null,
): Fix[] {
  const fixes: Fix[] = [];
  let n = 0;
  for (const path of unlinkedPaths(issues)) {
    const page = pages.get(path);
    if (!page) continue;
    const neighbour = neighbourOf(path);
    if (!neighbour || neighbour.path === page.path) continue;

    fixes.push({
      id: `related-link:${neighbour.path}:${n++}`,
      kind: "related-link",
      path: neighbour.path,
      label: `Relate ${shown(page)} from ${shown(neighbour)}`,
      enabled: true,
      apply: (content) => addRelatedLink(content, linkPathOf(page.path), shown(page), neighbour.schema, page.kind),
    });
  }
  return fixes;
}

/** A rectangle embed and the words the PDF's text layer holds under it. */
export interface RectText {
  key: string;
  pdfBasename: string;
  text: string;
}

/**
 * Quote the rectangles a page shows but does not say.
 *
 * One row per note, applying every rectangle that has text, because the reader
 * is deciding about the note rather than about each rectangle. A rectangle with
 * no text layer is dropped from the row and stays in the report — honesty over
 * coverage — and a note whose rectangles are all textless gets no row at all.
 */
export function planRectCallouts(issues: VaultIssue[], rectText: (path: string) => RectText[]): Fix[] {
  const fixes: Fix[] = [];
  let n = 0;
  const seen = new Set<string>();
  for (const issue of issues) {
    if (issue.id !== "no-evidence" || seen.has(issue.path)) continue;
    seen.add(issue.path);

    const rects = rectText(issue.path).filter((r) => r.text.trim());
    if (rects.length === 0) continue;

    const pdfs = [...new Set(rects.map((r) => r.pdfBasename))].join(", ");
    fixes.push({
      id: `rect-callout:${issue.path}:${n++}`,
      kind: "rect-callout",
      path: issue.path,
      label: `Quote ${rects.length} rectangle${rects.length === 1 ? "" : "s"} from ${pdfs}`,
      enabled: true,
      apply: (content) => rects.reduce((md, r) => rectToCallout(md, r.key, r.pdfBasename, r.text), content),
    });
  }
  return fixes;
}

/**
 * Name the source of a quote that names none — when exactly one source says it.
 *
 * Two sources holding the same sentence is not evidence about which one the
 * page was reading, and zero is not evidence at all; both stay in the report
 * unrepaired. Only a unique match is a fact about provenance, and only when the
 * quote is long enough for the match to mean anything.
 */
/** Shorter than this, a quote is a phrase any document might hold: no evidence of provenance. */
const MIN_ATTRIBUTE_CHARS = 20;

export function planAttributions(issues: VaultIssue[], sources: Map<string, string>): Fix[] {
  const folded = [...sources.entries()].map(([path, content]) => [path, fold(content)] as const);
  const fixes: Fix[] = [];
  let n = 0;
  for (const issue of issues) {
    if (issue.id !== "unattributed-quote" || !issue.detail) continue;
    const needle = fold(issue.detail).replace(/^["']|["']$/g, "");
    if (needle.length < MIN_ATTRIBUTE_CHARS) continue;

    const hits = folded.filter(([, content]) => content.includes(needle));
    if (hits.length !== 1) continue;

    const sourcePath = hits[0][0];
    const quote = issue.detail;
    fixes.push({
      id: `attribute:${issue.path}:${n++}`,
      kind: "attribute",
      path: issue.path,
      label: `Cite ${sourcePath.split("/").pop() ?? sourcePath}`,
      enabled: true,
      apply: (content) => attributeQuote(content, quote, sourcePath.replace(/\.md$/i, "")),
    });
  }
  return fixes;
}

/** What the model proposed for one page, before any of it is believed. */
export interface AliasProposal {
  path: string;
  aliases: string[];
  tag: string;
  kind: "concept" | "entity";
}

/**
 * The model's proposals as rows — the only rows a model writes.
 *
 * A tag outside the kind's closed vocabulary is not silently accepted and not
 * silently dropped: it becomes `other`, and the row says so, so the reader can
 * see the model guessed and override it in the dropdown.
 */
export function planAliases(
  proposals: AliasProposal[],
  vocab: Record<string, readonly string[]>,
): Fix[] {
  const fixes: Fix[] = [];
  let n = 0;
  for (const p of proposals) {
    const aliases = p.aliases.map((a) => a.trim()).filter(Boolean);
    if (aliases.length > 0) {
      fixes.push({
        id: `aliases:${p.path}:${n++}`,
        kind: "aliases",
        path: p.path,
        label: `Add aliases: ${aliases.map((a) => JSON.stringify(a)).join(", ")}`,
        enabled: true,
        apply: (content) => setAliases(content, aliases),
      });
    }

    const proposed = p.tag.trim();
    if (!proposed) continue;
    const allowed = vocab[p.kind];
    const known = !allowed || allowed.includes(proposed);
    const tag = known ? proposed : "other";
    fixes.push({
      id: `tag:${p.path}:${n++}`,
      kind: "tag",
      path: p.path,
      label: known ? `Tag: ${tag}` : `Tag: other (${proposed} is not a ${p.kind} tag)`,
      enabled: true,
      apply: (content) => setTag(content, tag),
    });
  }
  return fixes;
}

// ------------------------------------------------------------ order & apply

/**
 * Upstream's causal order: names, then the links that depend on names, then the
 * evidence that depends on the links. Aliases first because a dead link may
 * resolve through an alias the page did not have a moment ago; cross-links
 * before relinks because a cross-link writes a link that must then be spelled
 * correctly; the rectangles and citations last because they say nothing about
 * the graph.
 */
const KIND_ORDER: FixKind[] = [
  "aliases",
  "tag",
  "cross-link",
  "relink",
  "repoint",
  "hub-link",
  "related-link",
  "rect-callout",
  "attribute",
];

/** The plan in causal order, and by path inside a kind, so two runs read alike. */
export function orderFixes(fixes: Fix[]): Fix[] {
  return [...fixes].sort((a, b) => {
    const byKind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    if (byKind !== 0) return byKind;
    return a.path.localeCompare(b.path) || a.id.localeCompare(b.id);
  });
}

/** The fixes for each note, in the order they must be applied. */
export function groupByNote(fixes: Fix[]): Map<string, Fix[]> {
  const out = new Map<string, Fix[]>();
  for (const fix of orderFixes(fixes)) {
    const list = out.get(fix.path);
    if (list) list.push(fix);
    else out.set(fix.path, [fix]);
  }
  return out;
}

/**
 * Fold one note's ticked fixes into its text, in one pass, so a note is written
 * once. An unticked fix is not applied and a fix with nothing to do returns the
 * text it was given, which is what makes a second Apply a no-op.
 */
export function applyFixesToNote(content: string, fixes: Fix[]): string {
  let out = content;
  for (const fix of fixes) {
    if (!fix.enabled) continue;
    out = fix.apply(out);
  }
  return out;
}
