/**
 * The model review of Lint wiki, minus the model: what is sent, and what of
 * the answer is believed.
 *
 * The pure scan (`lintVault`, src/vaultLint.ts) finds what can be measured.
 * The review then asks the model to read the pages with findings and judge
 * what cannot: whether a sentence the page's quotes do not obviously state is
 * backed by one of them, which existing page a page plainly discusses without
 * linking, and whether a page is filed as the wrong kind. This module builds
 * the inputs for those calls and checks every proposal that comes back before
 * it can reach the report: a verdict about a page that was not sent, a quote
 * that is not on the page, a link to a page that does not exist are counted
 * with a reason and dropped. The model nominates; code decides.
 *
 * Follows the design of gd4ai/obsidian-llm-wiki's lint phases (orphan
 * linking against the index, the title scan, and the section clamp of its
 * PR #492), reimplemented here: the model judges a page it can read in full,
 * never a wiki it cannot.
 *
 * Pure: no `obsidian`, no zod, no llm import. The shapes below are the
 * contract with the prompt and schema side (src/prompt.ts, src/schemas.ts),
 * which is why they are plain objects.
 */
import { linkKey, noteLinks } from "./graph";
import { fmList, nextHeadingAfter, noteAliases } from "./topicNote";
import { pairKey, type DuplicateFinding } from "./duplicates";
import { compareIssues, ORDER, type LintPage, type VaultIssue, type VaultLintReport } from "./vaultLint";
import type { EvidenceUnit } from "./retrieval";

export { pairKey };

export interface ReviewClaimIn {
  n: number;
  text: string;
}

export interface ReviewPageIn {
  title: string;
  kind: "concept" | "entity";
  tags: string[];
  aliases: string[];
  body: string;
  omitted: string[];
  claims: ReviewClaimIn[];
  linked: string[];
}

export interface DirectoryEntry {
  title: string;
  kind: string;
  aliases: string[];
}

export interface ReviewPageOut {
  title: string;
  kind: { kind: "concept" | "entity"; reason: string } | null;
  claims: Array<{ n: number; supported: boolean; by: string; reason: string }>;
  links: Array<{ target: string; reason: string }>;
}

export interface TitleScanOut {
  pairs: Array<{ a: string; b: string; reason: string }>;
}

/** A link the review proposes, resolved to real paths: the fix plan's `add-link` row. */
export interface ReviewLink {
  path: string;
  targetPath: string;
  targetTitle: string;
  reason: string;
}

/** A kind the review proposes for a page: the fix plan's `kind` row. */
export interface ReviewKind {
  path: string;
  kind: "concept" | "entity";
  reason: string;
}

/** Why a proposal was not believed. The review line names these, so each is a phrase a reader can read. */
export type DropReason =
  | "target not in wiki"
  | "already linked"
  | "self link"
  | "claim not sent"
  | "quote not on page"
  | "page not sent";

/** The longest fragment a claim verdict may cite as its quote: long enough to name a passage, short enough that it cannot be the claim restated. */
export const MAX_BY_WORDS = 12;

/** Default run budget for page bodies, and the per-page clamp, from the design. */
export const REVIEW_BUDGET_CHARS = 60_000;
export const PAGE_BODY_CHARS = 6_000;

// ---- small readers ---------------------------------------------------------

function frontmatter(content: string): string {
  return /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? "";
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function basename(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
}

/** The page's kind from its frontmatter, or "" when it has none. */
function kindOf(content: string, kindKey: string): string {
  return fmList(frontmatter(content), kindKey)[0] ?? "";
}

/**
 * The name a page goes by for the model: its H1, else its filename.
 *
 * The wiki's files are slugs (`spaced-repetition.md`) while its pages are
 * headed in words, and the model reads and answers in words; the directory
 * and the review inputs use this one function so a title the model echoes
 * back finds the page it was given for.
 */
export function pageTitle(path: string, content: string): string {
  const h1 = /^#\s+(.+?)\s*$/m.exec(stripFrontmatter(content));
  return h1 ? h1[1].trim() : basename(path);
}

/** Collapse case, whitespace and curly quotes, so a quote survives the model retyping it. */
function fold(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** A title as the model may write it back: a wikilink's brackets and display text removed. */
function bareTitle(s: string): string {
  return s.trim().replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0].trim();
}

/** Only reasons that fired, so an empty record means nothing was dropped. */
function count(dropped: Record<string, number>, reason: string): void {
  dropped[reason] = (dropped[reason] ?? 0) + 1;
}

// ---- inputs ----------------------------------------------------------------

/**
 * Which pages the review reads this run.
 *
 * A page earns a read by carrying a finding or a residue sentence; a page the
 * scan found nothing on has nothing for the model to judge. The worst finding
 * decides the order, by the report's own `ORDER`, so a budget that runs out
 * runs out on the least serious pages; a page with residue alone comes after
 * every page with a finding, because residue is a guess by word overlap and a
 * finding is a measurement. The budget counts the clamped body each page
 * sends, since that is what the calls cost, and taking stops at the first
 * page that would pass it so the order stays the order.
 *
 * `kindKey`, when given, keeps only concept and entity pages: the review has
 * nothing to say about a source page, and spending budget on one would push a
 * page it can judge out of the run.
 */
export function selectPages(
  report: VaultLintReport,
  pages: LintPage[],
  budgetChars = REVIEW_BUDGET_CHARS,
  kindKey?: string,
): { chosen: LintPage[]; skipped: number } {
  const worst = new Map<string, number>();
  for (const issue of report.issues) {
    const rank = ORDER.indexOf(issue.id);
    const r = rank < 0 ? ORDER.length : rank;
    worst.set(issue.path, Math.min(worst.get(issue.path) ?? Infinity, r));
  }
  const withClaims = new Set((report.claims ?? []).map((c) => c.path));

  const candidates = pages
    .filter((p) => worst.has(p.path) || withClaims.has(p.path))
    .filter((p) => kindKey === undefined || ["concept", "entity"].includes(kindOf(p.content, kindKey)))
    .map((p) => ({ page: p, rank: worst.get(p.path) ?? ORDER.length + 1 }))
    .sort((a, b) => a.rank - b.rank || a.page.path.localeCompare(b.page.path));

  const chosen: LintPage[] = [];
  let used = 0;
  for (const { page } of candidates) {
    const size = clampBody(page.content).body.length;
    if (used + size > budgetChars) break;
    used += size;
    chosen.push(page);
  }
  return { chosen, skipped: candidates.length - chosen.length };
}

/**
 * A page body that fits the call, with what was left out named.
 *
 * Follows the design of gd4ai/obsidian-llm-wiki's section clamp (PR #492):
 * cut in whole `## ` sections from the end, never mid-sentence, and tell the
 * model which sections it is not seeing, so it does not judge a sentence
 * unsupported because the quote behind it was in a section it never got.
 * Section boundaries are found fence-aware (`nextHeadingAfter`,
 * src/topicNote.ts:93), so a `## ` inside a code block is not a heading. A page
 * with no boundary to cut at, or whose opening alone is over the limit, is
 * cut at the limit and says so.
 */
export function clampBody(md: string, max = PAGE_BODY_CHARS): { body: string; omitted: string[] } {
  const body = stripFrontmatter(md).trim();
  if (body.length <= max) return { body, omitted: [] };

  // Where each droppable section starts. A `## ` on the first line is not a
  // boundary: cutting there would leave nothing.
  const starts: number[] = [];
  for (let at = nextHeadingAfter(body, 1); at < body.length; at = nextHeadingAfter(body, at + 1)) starts.push(at);
  const heading = (at: number): string => {
    const end = body.indexOf("\n", at);
    return body.slice(at, end < 0 ? body.length : end).replace(/^\s*##\s+/, "").trim();
  };

  const omitted: string[] = [];
  for (let k = starts.length - 1; k >= 0; k--) {
    omitted.unshift(heading(starts[k]));
    const kept = body.slice(0, starts[k]).trimEnd();
    if (kept.length <= max) return { body: kept, omitted };
  }
  // No boundary, or what comes before the first one is over the limit alone.
  const first = starts.length > 0 ? body.slice(0, starts[0]).trimEnd() : body;
  return { body: first.slice(0, max), omitted: [...omitted, "(cut mid-page)"] };
}

/**
 * Every page the wiki holds, one short line each, so a link the model
 * nominates is a choice from what exists rather than a title it invented.
 *
 * Sorted by path so an unchanged wiki sends the same directory, and capped
 * both by entries and by the characters its lines would take, whichever comes
 * first: a large wiki's directory must not crowd out the pages under review.
 */
export function directoryOf(
  pages: Array<{ path: string; content: string }>,
  kindKey: string,
  max = 400,
  maxChars = 12_000,
): DirectoryEntry[] {
  const out: DirectoryEntry[] = [];
  let chars = 0;
  for (const p of [...pages].sort((a, b) => a.path.localeCompare(b.path))) {
    if (out.length >= max) break;
    const entry: DirectoryEntry = { title: pageTitle(p.path, p.content), kind: kindOf(p.content, kindKey), aliases: noteAliases(p.content) };
    const line = `${entry.title} (${entry.kind}): ${entry.aliases.join(", ")}`.length + 1;
    if (chars + line > maxChars) break;
    chars += line;
    out.push(entry);
  }
  return out;
}

/**
 * What the model sees of each chosen page.
 *
 * `linked` is the page's outgoing links reduced to `linkKey`, so the model can
 * see what is already linked and code can refuse a nomination that repeats
 * one. A page whose kind is neither concept nor entity is left out: the kind
 * verdict can only move a page between those two, and the other checks are
 * about pages that explain a subject.
 */
export function buildReviewInputs(report: VaultLintReport, chosen: LintPage[], kindKey: string): ReviewPageIn[] {
  const out: ReviewPageIn[] = [];
  for (const page of chosen) {
    const kind = kindOf(page.content, kindKey);
    if (kind !== "concept" && kind !== "entity") continue;
    const { body, omitted } = clampBody(page.content);
    out.push({
      title: pageTitle(page.path, page.content),
      kind,
      tags: fmList(frontmatter(page.content), "tags"),
      aliases: noteAliases(page.content),
      body,
      omitted,
      claims: (report.claims ?? []).filter((c) => c.path === page.path).map((c) => ({ n: c.n, text: c.text })),
      linked: [...new Set(noteLinks(page.content).map((l) => linkKey(l.raw)).filter(Boolean))],
    });
  }
  return out;
}

// ---- verification ----------------------------------------------------------

/** Title or alias, folded by `linkKey`, to its directory entry; the first entry to claim a key keeps it. */
function directoryIndex(directory: DirectoryEntry[]): Map<string, DirectoryEntry> {
  const byKey = new Map<string, DirectoryEntry>();
  for (const entry of directory) {
    for (const name of [entry.title, ...entry.aliases]) {
      const key = linkKey(name);
      if (key && !byKey.has(key)) byKey.set(key, entry);
    }
  }
  return byKey;
}

/**
 * Whether a claim verdict's quote is really on the page.
 *
 * The model's word that a sentence is supported is worth nothing on its own:
 * it has to name the fragment, and the fragment has to be found, folded,
 * inside one of the page's quote units. The length cap keeps the check honest
 * in the other direction: a "quote" as long as the sentence could be the
 * sentence itself, restated.
 */
function quoteOnPage(by: string, units: EvidenceUnit[]): boolean {
  const needle = fold(by).replace(/^["']+|["']+$/g, "").trim();
  if (needle.length === 0) return false;
  if (needle.split(" ").length > MAX_BY_WORDS) return false;
  return units.some((u) => fold(u.text).includes(needle));
}

/**
 * The review's answer, checked proposal by proposal.
 *
 * A page verdict must name a page that was sent; a claim verdict a claim
 * number that was sent. A claim is cleared only when its quote is on the page
 * (`quoteOnPage`); judged unsupported, or claimed supported by a quote that is
 * not there, it becomes an `unsupported-prose` finding, the latter also
 * counted as `quote not on page` so the reader can see the model overclaiming.
 * A claim the model did not judge stays what it was, a candidate: silence is
 * not a verdict. A link must resolve through the directory to a page that is
 * not this one and is not already linked from it. A kind verdict is a finding
 * only when it moves the page. `pagesByKey` maps `linkKey(title)` to the page,
 * for both the reviewed page and a link's target.
 */
export function verifyReview(
  sent: ReviewPageIn[],
  out: ReviewPageOut[],
  directory: DirectoryEntry[],
  pagesByKey: Map<string, { path: string; title: string }>,
  units: (path: string) => EvidenceUnit[],
): { issues: VaultIssue[]; links: ReviewLink[]; kinds: ReviewKind[]; dropped: Record<string, number> } {
  const issues: VaultIssue[] = [];
  const links: ReviewLink[] = [];
  const kinds: ReviewKind[] = [];
  const dropped: Record<string, number> = {};
  const sentByKey = new Map(sent.map((p) => [linkKey(p.title), p]));
  const dirByKey = directoryIndex(directory);
  const done = new Set<string>();

  for (const verdict of out) {
    const key = linkKey(bareTitle(verdict.title));
    const page = sentByKey.get(key);
    const where = page ? pagesByKey.get(linkKey(page.title)) : undefined;
    if (!page || !where) {
      count(dropped, "page not sent");
      continue;
    }
    // A second verdict for the same page adds nothing the first did not say.
    if (done.has(key)) continue;
    done.add(key);
    const title = basename(where.path);

    const judged = new Set<number>();
    for (const c of verdict.claims) {
      const claim = page.claims.find((x) => x.n === c.n);
      if (!claim) {
        count(dropped, "claim not sent");
        continue;
      }
      if (judged.has(c.n)) continue;
      judged.add(c.n);
      if (c.supported) {
        if (quoteOnPage(c.by, units(where.path))) continue;
        count(dropped, "quote not on page");
      }
      issues.push({ id: "unsupported-prose", path: where.path, title, target: undefined, detail: claim.text });
    }

    const linked = new Set(page.linked);
    for (const l of verdict.links) {
      const entry = dirByKey.get(linkKey(bareTitle(l.target)));
      const target = entry ? pagesByKey.get(linkKey(entry.title)) : undefined;
      if (!entry || !target) {
        count(dropped, "target not in wiki");
        continue;
      }
      if (target.path === where.path) {
        count(dropped, "self link");
        continue;
      }
      // The page may link its target by filename, by title or by an alias.
      const names = [basename(target.path), entry.title, ...entry.aliases].map(linkKey);
      if (names.some((n) => linked.has(n))) {
        count(dropped, "already linked");
        continue;
      }
      linked.add(linkKey(basename(target.path)));
      links.push({ path: where.path, targetPath: target.path, targetTitle: entry.title, reason: l.reason });
      issues.push({ id: "missing-link", path: where.path, title, target: entry.title, detail: l.reason });
    }

    if (verdict.kind && verdict.kind.kind !== page.kind && (verdict.kind.kind === "concept" || verdict.kind.kind === "entity")) {
      kinds.push({ path: where.path, kind: verdict.kind.kind, reason: verdict.kind.reason });
      issues.push({ id: "wrong-kind", path: where.path, title, detail: `${page.kind} → ${verdict.kind.kind}: ${verdict.kind.reason}` });
    }
  }

  issues.sort(compareIssues);
  return { issues, links, kinds, dropped };
}

/**
 * The title scan's pairs, checked.
 *
 * Both titles must be pages the directory names (by title or alias), two
 * different pages, and a pair the scan has not already found by name, span or
 * spelling: `existingPairs` holds `pairKey(pathA, pathB)` for every finding
 * and candidate the report already carries. What survives is a candidate like
 * a spelling look-alike, for the duplicate check to confirm, never a finding.
 * `pathOfTitle` is keyed by a directory entry's title, exact or by `linkKey`.
 */
export function verifyTitleScan(
  out: TitleScanOut,
  directory: DirectoryEntry[],
  pathOfTitle: Map<string, string>,
  existingPairs: Set<string>,
): { candidates: DuplicateFinding[]; dropped: Record<string, number> } {
  const dirByKey = directoryIndex(directory);
  const pathOf = (name: string): string | undefined => {
    const entry = dirByKey.get(linkKey(bareTitle(name)));
    return entry ? pathOfTitle.get(entry.title) ?? pathOfTitle.get(linkKey(entry.title)) : undefined;
  };
  const candidates: DuplicateFinding[] = [];
  const dropped: Record<string, number> = {};
  const seen = new Set(existingPairs);
  for (const pair of out.pairs) {
    const pa = pathOf(pair.a);
    const pb = pathOf(pair.b);
    if (!pa || !pb) {
      count(dropped, "title not in wiki");
      continue;
    }
    if (pa === pb) {
      count(dropped, "self pair");
      continue;
    }
    const key = pairKey(pa, pb);
    if (seen.has(key)) {
      count(dropped, "already paired");
      continue;
    }
    seen.add(key);
    const [a, b] = pa < pb ? [pa, pb] : [pb, pa];
    candidates.push({ a, b, pass: "title", detail: `the model reads the titles as one subject: ${pair.reason}` });
  }
  candidates.sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  return { candidates, dropped };
}

// ---- report ----------------------------------------------------------------

/** Drop reasons in the order the design lists them, so the line reads the same run to run. */
const DROP_ORDER: string[] = ["target not in wiki", "already linked", "self link", "claim not sent", "quote not on page", "page not sent", "title not in wiki", "self pair", "already paired"];

/**
 * The review in one report line: how much was read, what it found, and what
 * of its answer was not believed, with each reason counted. A reader who sees
 * "3 over budget" knows the report is partial; one who sees proposals dropped
 * knows the model was checked. When the review did not run, the line says why
 * instead, so its absence is not a silence.
 */
export function renderReviewLine(stats: {
  read: number;
  withFindings: number;
  skipped: number;
  findings: number;
  dropped: Record<string, number>;
  failed: string[];
  off?: string;
}): string {
  if (stats.off) return `Model review off: ${stats.off}`;
  const s = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
  const parts = [`read ${stats.read} of ${s(stats.withFindings, "page")} with findings${stats.skipped > 0 ? ` (${stats.skipped} over budget)` : ""}`, s(stats.findings, "finding")];

  const reasons = Object.keys(stats.dropped)
    .filter((r) => stats.dropped[r] > 0)
    .sort((a, b) => {
      const ia = DROP_ORDER.indexOf(a);
      const ib = DROP_ORDER.indexOf(b);
      return (ia < 0 ? DROP_ORDER.length : ia) - (ib < 0 ? DROP_ORDER.length : ib) || a.localeCompare(b);
    });
  const total = reasons.reduce((n, r) => n + stats.dropped[r], 0);
  if (total > 0) parts.push(`${s(total, "proposal")} dropped (${reasons.map((r) => `${stats.dropped[r]} ${r}`).join(", ")})`);
  parts.push(...stats.failed);
  return `**Model review** — ${parts.join("; ")}.`;
}
