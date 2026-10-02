/**
 * Repairs for what `src/vaultLint.ts` finds.
 *
 * The lint says a link is dead, by Obsidian's own resolver. This decides
 * whether it is dead because the page is missing or dead because the link
 * spells the page's name differently from its filename, and rewrites the
 * second kind. In this vault that is the overwhelming majority: links are
 * written in prose ("[[Spaced repetition]]") while the files are slugs
 * ("concepts/spaced-repetition.md"), and Obsidian does not open one from the
 * other. The slug fold (`linkKey`, `nameKey`) is used here only to find the
 * page a dead link meant, never to call a link alive.
 *
 * The matching tiers and the alias-preserving rewrite follow the design of
 * gd4ai/obsidian-llm-wiki's dead-link repair (`findDeadLinkTarget`,
 * `replaceDeadLink`), reimplemented here against this plugin's own types.
 *
 * Pure: no `obsidian` import, same rule as src/vaultLint.ts, so the tests
 * bundle it standalone and a fix can be previewed without touching a vault.
 */
import type { VaultIssue } from "./vaultLint";

/** A page a dead link might have meant. */
export interface FixPage {
  path: string;
  /** The filename without its extension — what a wikilink addresses. */
  title: string;
  /** The page's `# Heading`, when it has one: what a reader should see in the link. */
  displayTitle?: string;
  aliases: string[];
}

/** How the page a dead link meant was found, most certain first. */
export type FixConfidence = "title" | "alias" | "slug" | "alias-slug";
const CONFIDENCE_BY_TIER: FixConfidence[] = ["title", "alias", "slug", "alias-slug"];

/** One rewrite, ready to preview or apply. */
export interface LinkFix {
  /** The note being edited. */
  path: string;
  /** The link target as written, e.g. "concepts/Spaced repetition". */
  from: string;
  /** The page it resolves to, e.g. "wiki/concepts/spaced-repetition.md". */
  toPath: string;
  /** The replacement link text, e.g. "[[concepts/spaced-repetition|Spaced repetition]]". */
  to: string;
  /** Which tier matched: an exact title, an exact alias, a slug-folded title, or a slug-folded alias. */
  confidence: FixConfidence;
}

/**
 * Compare names the way a reader means them rather than the way a filesystem
 * stores them: "Spaced repetition", "spaced-repetition" and "Spaced  Repetition"
 * are one name. Punctuation that cannot appear in a filename is dropped so a
 * heading with a comma still matches the file named after it.
 */
export function nameKey(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[/\\:*?"<>|,()'!]/g, "")
    .replace(/[\s._]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * The page a dead link meant, or null when nothing plausibly matches.
 *
 * Four tiers, and they stay separate rather than collapsing into one search: an
 * exact title match must outrank a normalized alias match on a different page,
 * because the first is the reader naming a file and the second is a guess about
 * what they meant. A tie inside a tier is not resolved — the first page wins,
 * and `ambiguous` reports that another had equal claim, so the caller can leave
 * it for a human instead of picking for them.
 */
export function findLinkTarget(
  pages: FixPage[],
  target: string,
): { page: FixPage; ambiguous: boolean; confidence: FixConfidence } | null {
  const basename = target.includes("/") ? (target.split("/").pop() ?? target) : target;
  const lower = basename.trim().toLowerCase();
  const key = nameKey(basename);
  if (!lower) return null;

  const tiers: Array<(p: FixPage) => boolean> = [
    (p) => p.title.toLowerCase() === lower,
    (p) => p.aliases.some((a) => a.toLowerCase() === lower),
    (p) => nameKey(p.title) === key,
    (p) => p.aliases.some((a) => nameKey(a) === key),
  ];

  for (const [i, matches] of tiers.entries()) {
    const hits = pages.filter(matches);
    if (hits.length > 0) return { page: hits[0], ambiguous: hits.length > 1, confidence: CONFIDENCE_BY_TIER[i] };
  }
  return null;
}

/**
 * The display half of a link, made safe to sit inside one.
 *
 * A page's `# Heading` is prose the reader wrote, and prose may hold anything —
 * including a wikilink. Dropped in verbatim, its `]]` closes the link early and
 * the result is markup no reader and no later repair can untangle:
 * `[[concepts/y|[[concepts/y|See [[Other]]]]]]`. A second `|` is milder but
 * still wrong: Obsidian reads it as a further field and the name shows
 * truncated. Both are folded to characters that render as themselves.
 */
function safeDisplay(text: string): string {
  return text.replace(/\[\[/g, "【").replace(/\]\]/g, "】").replace(/\|/g, "｜");
}

/** The link text that replaces a dead one: a vault-relative path, and the name the reader reads. */
export function buildReplacement(page: FixPage, wikiPrefix: string): string {
  const prefix = wikiPrefix.endsWith("/") ? wikiPrefix : `${wikiPrefix}/`;
  const rel = page.path.startsWith(prefix) ? page.path.slice(prefix.length) : page.path;
  return `[[${rel.replace(/\.md$/i, "")}|${safeDisplay(page.displayTitle || page.title)}]]`;
}

/** The display text of a built replacement link, or its path when it carries none. */
function displayOf(replacement: string): string {
  const m = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(replacement.trim());
  if (!m) return replacement;
  return (m[2] ?? m[1]).trim();
}

/**
 * Rewrite every occurrence of one dead target in a note.
 *
 * An occurrence that already carries its own display text keeps it: the reader
 * wrote "[[Spaced repetition|the spacing effect]]" to make a sentence read, and
 * a repair that silently renamed it to the page's title would edit their prose
 * rather than their link. Only the path changes there. This is decided per
 * occurrence, so one note may hold the same target under two different names
 * and keep both.
 *
 * Embeds (`![[...]]`) are rewritten too, and stay embeds: a broken transclusion
 * is as dead as a broken link, and dropping the `!` would turn a figure into a
 * sentence.
 *
 * What is not rewritten is what only looks like a link: an example inside a
 * code fence, an inline code span or a typed frontmatter property. `proseRanges`
 * decides that, and this repair honours it for the same reason `unwrapDeadLink`
 * does — a note documenting how to write a wikilink has its example silently
 * edited otherwise, and the two repairs in one file must agree on what prose is.
 */
export function applyLinkFix(content: string, target: string, replacement: string): string {
  const wanted = target.trim();
  const path = /^\[\[([^\]|]+)/.exec(replacement)?.[1];
  if (!path) return content;
  const skip = proseRanges(content);

  return content.replace(
    /(!?)\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]+))?\]\]/g,
    (
      whole: string,
      bang: string,
      rawTarget: string,
      anchor: string | undefined,
      alias: string | undefined,
      at: number,
    ) => {
      if (rawTarget.trim() !== wanted) return whole;
      if (inSkipped(skip, at)) return whole;
      const tail = anchor ?? "";
      const shown = alias === undefined ? displayOf(replacement) : alias.trim();
      return `${bang}[[${path}${tail}|${shown}]]`;
    },
  );
}

/**
 * Every dead link that can be repaired, and the ones that cannot.
 *
 * `fixable` is what a button can apply unattended. `unresolved` is the rest —
 * a link to a page nobody has written — which is a decision (write the page, or
 * drop the link) rather than a repair, and is never guessed at here.
 */
export function planLinkFixes(
  issues: VaultIssue[],
  pages: FixPage[],
  contents: Map<string, string>,
  wikiPrefix: string,
): { fixable: LinkFix[]; unresolved: VaultIssue[]; ambiguous: VaultIssue[] } {
  const fixable: LinkFix[] = [];
  const unresolved: VaultIssue[] = [];
  const ambiguous: VaultIssue[] = [];

  for (const issue of issues) {
    if (issue.id !== "dead-link" || !issue.target) continue;
    const found = findLinkTarget(pages, issue.target);
    if (!found) {
      unresolved.push(issue);
      continue;
    }
    if (found.ambiguous) {
      ambiguous.push(issue);
      continue;
    }
    // A link that already points at the page it resolves to needs no rewrite;
    // without this a target differing only in case would be "fixed" forever.
    const replacement = buildReplacement(found.page, wikiPrefix);
    const body = contents.get(issue.path);
    if (body === undefined || applyLinkFix(body, issue.target, replacement) === body) continue;
    fixable.push({ path: issue.path, from: issue.target, toPath: found.page.path, to: replacement, confidence: found.confidence });
  }

  return { fixable, unresolved, ambiguous };
}

/** The fixes for one note, applied in one pass so a note is written once. */
export function applyFixesToNote(content: string, fixes: LinkFix[]): string {
  let out = content;
  for (const fix of fixes) out = applyLinkFix(out, fix.from, fix.to);
  return out;
}

/**
 * The spans of a note that are prose, and not the spans that only look like it.
 *
 * A note is one string to every scanner here, so `[[Missing]]` written inside a
 * code fence, an inline code span or a YAML property reads exactly like one
 * written in a sentence. That costs nothing while a repair rewrites one link
 * into another — the result is still a link, and still visibly wrong if it is
 * wrong. An unwrap deletes the brackets, and in a fence the brackets are the
 * content: a note documenting how to write a wikilink would have its example
 * silently edited away.
 *
 * Frontmatter is excluded for a different reason. `related: "[[X]]"` is a typed
 * property that Dataview and Bases query as a link; unwrapping it leaves a
 * string that looks similar and resolves to nothing.
 */
function proseRanges(content: string): Array<[number, number]> {
  const skip: Array<[number, number]> = [];

  // Frontmatter, only when it opens the note.
  const fm = /^---\r?\n[\s\S]*?\r?\n---/.exec(content);
  if (fm && fm.index === 0) skip.push([0, fm[0].length]);

  // Fenced blocks: three or more backticks or tildes, closed by a fence of the
  // same character, or by the end of the note when the writer left it open.
  const fence = /^[ \t]*(`{3,}|~{3,})[^\n]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(content)) !== null) {
    const char = m[1][0];
    const close = new RegExp(`^[ \\t]*${char === "`" ? "`" : "~"}{${m[1].length},}[ \\t]*$`, "gm");
    close.lastIndex = m.index + m[0].length;
    const end = close.exec(content);
    const stop = end ? end.index + end[0].length : content.length;
    skip.push([m.index, stop]);
    fence.lastIndex = stop;
  }

  // Inline code spans, backtick-delimited on one line.
  const span = /`+[^`\n]*`+/g;
  while ((m = span.exec(content)) !== null) skip.push([m.index, m.index + m[0].length]);

  // Indented code blocks: four spaces or a tab, the other way Markdown marks
  // code, and the one a writer reaches for when the example is itself a fence.
  // The run must open after a blank line, or a wrapped list item — which is
  // also indented — would be masked and its dead links left unrepairable.
  // A blank line inside a run does not end it, matching how Markdown reads one.
  const lines = content.split("\n");
  let at = 0;
  let runStart = -1;
  let runEnd = -1;
  let prevBlank = true;
  for (const line of lines) {
    const end = at + line.length;
    const blank = line.trim() === "";
    const indented = /^(?: {4}|\t)/.test(line);
    if (runStart >= 0) {
      // Inside a run: an indented line extends it, a blank line may yet be
      // followed by more of it, anything else closes it.
      if (indented) runEnd = end;
      else if (!blank) {
        skip.push([runStart, runEnd]);
        runStart = -1;
      }
    } else if (indented && prevBlank && !blank) {
      runStart = at;
      runEnd = end;
    }
    prevBlank = blank;
    at = end + 1;
  }
  if (runStart >= 0) skip.push([runStart, runEnd]);

  return skip;
}

/** Whether an offset falls inside any span that is not prose. */
function inSkipped(skip: Array<[number, number]>, at: number): boolean {
  return skip.some(([from, to]) => at >= from && at < to);
}

/**
 * Strip a dead link back to plain text, keeping the words and dropping the
 * brackets.
 *
 * This is the repair for the other kind of dead link: not one that is a
 * spelling apart from its page, but one whose page nobody ever wrote.
 * `findLinkTarget` returns null for those, and upstream's answer — creating a
 * stub — is the one thing this vault's design forbids, because a stub is a page
 * whose entire body says it is a stub, and the wiki already carries three.
 *
 * Unwrapping is the smallest honest edit. The reader's sentence still reads,
 * because the words they wrote stay exactly where they were; only the claim
 * that those words address a page is withdrawn. The display text wins when
 * there is one — "[[Iterative refinement|refining it step by step]]" was
 * written to make a sentence scan, and that sentence is what should survive.
 *
 * An embed is the exception: `![[Missing]]` transcludes a page, so with no page
 * there is nothing to show. When the embed is the whole line, the line goes
 * with it, since a leftover "- " renders as a stray bullet.
 */
export function unwrapDeadLink(content: string, target: string): string {
  const wanted = target.trim();
  if (!wanted) return content;
  const skip = proseRanges(content);

  return content.replace(
    /(^[ \t]*(?:[-*+]|\d+[.)])?[ \t]*)?(!?)\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]+))?\]\](?:[ \t]*(\n[ \t]*\n|\n))?/gm,
    (
      whole: string,
      lead: string | undefined,
      bang: string,
      rawTarget: string,
      _anchor: string | undefined,
      alias: string | undefined,
      eol: string,
      at: number,
    ) => {
      if (rawTarget.trim() !== wanted) return whole;
      // A link that only looks like prose: inside a fence, a code span or the
      // frontmatter. Left exactly as written.
      if (inSkipped(skip, at + (lead ? lead.length : 0))) return whole;

      const tail = eol ?? "";
      if (bang) {
        // An embed of a page that does not exist shows nothing, so nothing is
        // left in its place. When it was a line of its own the line goes too:
        // a leftover "- " renders as a stray bullet, and a leftover blank line
        // turns one paragraph break into a gap. Inline in a sentence, only the
        // embed goes and the words around it close up.
        // The line ends either at a newline this match consumed or at the end
        // of the note. Without the second case the last line of a file keeps
        // its "- ", and because the result no longer holds the embed, a second
        // run has nothing to match and the stray bullet is there for good.
        const atLineStart = at === 0 || content[at - 1] === "\n";
        const atLineEnd = Boolean(tail) || at + whole.length === content.length;
        if (atLineStart && atLineEnd) return "";
        return `${lead ?? ""}${tail}`;
      }

      // The words the reader wrote: their own display text when they chose one,
      // otherwise the target read as a name rather than a path. Each step falls
      // back rather than yielding "", so a link never deletes its own sentence.
      const shown =
        (alias !== undefined ? alias.trim() : "") ||
        (rawTarget.includes("/") ? (rawTarget.split("/").pop() ?? "").trim() : "") ||
        rawTarget.trim();
      return `${lead ?? ""}${shown}${tail}`;
    },
  );
}
