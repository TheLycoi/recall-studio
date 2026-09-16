/**
 * Repairs for what `src/vaultLint.ts` finds.
 *
 * The lint says a link is dead. This decides whether it is dead because the
 * page is missing or dead because the link spells the page's name differently
 * from its filename, and rewrites the second kind. In this vault that is the
 * overwhelming majority: links are written in prose ("[[Spaced repetition]]")
 * while the files are slugs ("concepts/spaced-repetition.md"), so the two never
 * compare equal and the graph cannot cross them.
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
export function findLinkTarget(pages: FixPage[], target: string): { page: FixPage; ambiguous: boolean } | null {
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

  for (const matches of tiers) {
    const hits = pages.filter(matches);
    if (hits.length > 0) return { page: hits[0], ambiguous: hits.length > 1 };
  }
  return null;
}

/** The link text that replaces a dead one: a vault-relative path, and the name the reader reads. */
export function buildReplacement(page: FixPage, wikiPrefix: string): string {
  const prefix = wikiPrefix.endsWith("/") ? wikiPrefix : `${wikiPrefix}/`;
  const rel = page.path.startsWith(prefix) ? page.path.slice(prefix.length) : page.path;
  return `[[${rel.replace(/\.md$/i, "")}|${page.displayTitle || page.title}]]`;
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
 */
export function applyLinkFix(content: string, target: string, replacement: string): string {
  const wanted = target.trim();
  const path = /^\[\[([^\]|]+)/.exec(replacement)?.[1];
  if (!path) return content;

  return content.replace(
    /(!?)\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]+))?\]\]/g,
    (whole, bang: string, rawTarget: string, anchor: string | undefined, alias: string | undefined) => {
      if (rawTarget.trim() !== wanted) return whole;
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
    fixable.push({ path: issue.path, from: issue.target, toPath: found.page.path, to: replacement });
  }

  return { fixable, unresolved, ambiguous };
}

/** The fixes for one note, applied in one pass so a note is written once. */
export function applyFixesToNote(content: string, fixes: LinkFix[]): string {
  let out = content;
  for (const fix of fixes) out = applyLinkFix(out, fix.from, fix.to);
  return out;
}
