/**
 * The vault side of the fix plan: everything `src/fixPlan.ts` is forbidden to know.
 *
 * `fixPlan.ts` is pure — it takes findings and facts and returns rows. This
 * module is where those facts are gathered: which pages are hubs, which page is
 * nearest an orphan in the graph, what words a PDF's text layer holds under a
 * rectangle, and what the model proposes for a page with no aliases. It is also
 * the only place in the feature that writes, and it writes nothing that the
 * reader did not leave ticked.
 *
 * Reads are `cachedRead`-free here on purpose: `runVaultLint` has already read
 * every page under the wiki folder, so the plan is built from the text the lint
 * saw, and the edit is applied through `vault.process` against the text the note
 * holds at apply time. The gap between those two is the reader's decision time,
 * and `process` is what makes it safe.
 */
import { TFile } from "obsidian";
import type WikiLmPlugin from "./main";
import type { WikiLmSettings } from "./settings";
import { quoteUnits, type LintPage, type VaultLintReport, type VaultIssue } from "./vaultLint";
import { planLinkFixes, type FixPage } from "./vaultFix";
import {
  groupByNote,
  orderFixes,
  planAliases,
  planAttributions,
  planCrossLinks,
  planHubLinks,
  planKinds,
  planReviewLinks,
  planRectCallouts,
  planRelatedFrom,
  planRelinks,
  planRepoints,
  planUnwraps,
  applyFixesToNote,
  type AliasProposal,
  type Fix,
  type FixPageInfo,
  type RectText,
  type DuplicateVerdicts,
} from "./fixPlan";
import { buildGraph, isGraphUsable, linkKey, noteLinks, pprFromSeeds, type Graph } from "./graph";
import { CONCEPT_TAGS, ENTITY_TAGS, fmList, noteAliases, parseTopicNote } from "./topicNote";
import { pdfsLinkedFrom } from "./pdf";
import { collectPdfHighlights } from "./pdfHighlights";
import { ALIASES_EXCERPT_CHARS, type AliasesPageIn, type DuplicatePageIn, type DuplicatePairIn } from "./prompt";
import { pairKey, type DuplicateFinding } from "./duplicates";
import { resolveRole, type ModelRole } from "./modelRoles";
import { resolveApiKey, resolveGeminiKey, type KeySource } from "./keys";
import { describeError } from "./llm";
import type { CancelToken } from "./cancel";
import {
  buildReviewInputs,
  directoryOf,
  renderReviewLine,
  REVIEW_BUDGET_CHARS,
  selectPages,
  verifyReview,
  verifyTitleScan,
  type PageKind,
  type ReviewKind,
  type ReviewLink,
} from "./lintReview";

/** What `runVaultLint` already holds when the report is done, handed here whole. */
export interface FixContext {
  report: VaultLintReport;
  pages: LintPage[];
  /** Everything a quote could have come from, path → text. */
  sources: Map<string, string>;
  /** The wiki folder prefix, e.g. `wiki/`. */
  prefix: string;
}

/** How many pages go in one aliases-and-tags request. */
const ALIASES_BATCH = 20;

/** The `---` block's body, or "" when the note has none. */
function frontmatterOf(md: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  return m && m.index === 0 ? m[1] : "";
}

/** The filename without its extension — what a wikilink addresses. */
function titleOf(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
}

/** The page's own `# Heading`, which is the name a reader reads. */
function headingOf(md: string): string | undefined {
  const body = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  return /^#\s+(.+?)\s*$/m.exec(body)?.[1].trim();
}

/**
 * Which schema a page is held under.
 *
 * Both signals must agree: a page is karpathy only when its `type:` is one of
 * the two kinds that schema names *and* it sits in one of the two folders the
 * settings point at. A `type: concept` page filed under a class folder is a
 * class page that borrowed a word, and giving it `## Related Concepts` would
 * put a heading in it that nothing else in that folder has.
 */
function schemaOf(plugin: WikiLmPlugin, path: string, type: string): "class" | "karpathy" {
  if (type !== "concept" && type !== "entity") return "class";
  const folders = [plugin.settings.wikiConceptsFolder, plugin.settings.wikiEntitiesFolder]
    .map((f) => f.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return folders.some((f) => path === f || path.startsWith(`${f}/`)) ? "karpathy" : "class";
}

/** Everything the planners need to know about every page the lint read. */
export function pageInfos(plugin: WikiLmPlugin, pages: LintPage[]): Map<string, FixPageInfo> {
  const out = new Map<string, FixPageInfo>();
  for (const page of pages) {
    const fm = frontmatterOf(page.content);
    const type = (fmList(fm, "type")[0] ?? "").trim().toLowerCase();
    out.set(page.path, {
      path: page.path,
      title: titleOf(page.path),
      displayTitle: headingOf(page.content),
      schema: schemaOf(plugin, page.path, type),
      kind: type === "entity" ? "entity" : "concept",
      classCodes: parseTopicNote(page.content).classCodes,
      content: page.content,
    });
  }
  return out;
}

/** The frontmatter `type:` a page declares, read the same way `pageInfos` reads it. */
function rawTypeOf(content: string): string {
  return (fmList(frontmatterOf(content), "type")[0] ?? "").trim().toLowerCase();
}

/** Which pages are `type: topic-index`, so a hub can be told from a page. */
function isHub(page: FixPageInfo): boolean {
  return (fmList(frontmatterOf(page.content), "type")[0] ?? "").trim().toLowerCase() === "topic-index";
}

/**
 * The index note for each class, keyed by every code it claims.
 *
 * A hub naming two classes is the hub for both; the first hub wins a code, so a
 * second index note for a class does not silently take over the first's list.
 */
export function hubs(infos: Map<string, FixPageInfo>): Map<string, FixPageInfo> {
  const out = new Map<string, FixPageInfo>();
  for (const page of infos.values()) {
    if (!isHub(page)) continue;
    for (const code of page.classCodes) if (!out.has(code)) out.set(code, page);
  }
  return out;
}

/**
 * The page an orphan should be linked from.
 *
 * The graph first, because a walk from the orphan reaches the pages its own
 * links already imply a relation to, which is a better guess than any name
 * comparison. A vault with too few links for the walk to mean anything (or an
 * orphan the walk reaches nothing from) falls back to the alphabetically first
 * page sharing a class code — deterministic, so two runs propose the same row.
 * A hub is never the answer: `planHubLinks` has already had its chance at this
 * page, and listing an orphan in a hub's *related* section is not what a hub is.
 */
export function neighbourOf(
  infos: Map<string, FixPageInfo>,
  graph: Graph,
): (path: string) => FixPageInfo | null {
  const hubPaths = new Set([...infos.values()].filter(isHub).map((p) => p.path));
  const usable = isGraphUsable(graph);

  return (path: string): FixPageInfo | null => {
    const page = infos.get(path);
    if (!page) return null;

    if (usable) {
      let best: { page: FixPageInfo; score: number } | null = null;
      for (const [candidate, score] of pprFromSeeds(graph, [path])) {
        if (candidate === path || hubPaths.has(candidate)) continue;
        const info = infos.get(candidate);
        if (!info) continue;
        // A tie goes to the earlier path, so the row does not depend on the
        // order a Map happened to hand back.
        if (!best || score > best.score || (score === best.score && candidate < best.page.path)) {
          best = { page: info, score };
        }
      }
      if (best) return best.page;
    }

    const codes = new Set(page.classCodes);
    if (codes.size === 0) return null;
    const shared = [...infos.values()]
      .filter((p) => p.path !== path && !hubPaths.has(p.path) && p.classCodes.some((c) => codes.has(c)))
      .sort((a, b) => a.path.localeCompare(b.path));
    return shared[0] ?? null;
  };
}

/**
 * The words under each rectangle a note shows.
 *
 * `collectPdfHighlights` opens the PDF with pdf.js and walks every page, which
 * is by far the most expensive thing the plan does, so this reads only the PDFs
 * cited by the notes that can actually produce a row — the ones the lint called
 * `no-evidence` — rather than every PDF the wiki links to. A vault of two
 * hundred pages and no such finding opens no documents at all, which is what
 * keeps the Wiki check as instant as it was before the plan existed.
 *
 * Each PDF is still read once however many of those notes cite it, and the rows
 * are filtered back to the note by `origins`. A PDF that will not open — moved,
 * corrupt, or no longer a PDF — yields no rows rather than failing the plan: the
 * finding stays in the report, which is the honest outcome for evidence nobody
 * can read.
 */
export async function rectText(
  plugin: WikiLmPlugin,
  paths: Iterable<string>,
): Promise<(path: string) => RectText[]> {
  // `planRectCallouts` is synchronous, so every PDF is read up front and the
  // returned closure only looks up what was found.
  const seen = new Set<string>();
  const perPage = new Map<string, RectText[]>();

  for (const path of paths) {
    const file = plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) continue;
    for (const pdf of pdfsLinkedFrom(plugin.app, file)) {
      if (seen.has(pdf.path)) continue;
      seen.add(pdf.path);
      try {
        const { manifest } = await collectPdfHighlights(plugin, pdf, { paperText: false });
        for (const h of manifest.highlights) {
          if (h.kind !== "rect") continue;
          for (const origin of h.origins) {
            const list = perPage.get(origin) ?? [];
            list.push({ key: h.key, pdfBasename: manifest.pdfBasename, text: h.text });
            perPage.set(origin, list);
          }
        }
      } catch {
        // Unreadable: no rows, and the report keeps the finding.
      }
    }
  }

  return (path: string): RectText[] => perPage.get(path) ?? [];
}

/**
 * The wiki pages as link targets — what a repoint picker and the link fixer
 * both need. Moved here from the chat panel so the plan and the picker agree on
 * what a page is called.
 */
export function fixPagesFor(plugin: WikiLmPlugin, pages: LintPage[]): FixPage[] {
  return pages.map((p) => {
    const cache = plugin.app.metadataCache.getCache(p.path);
    const fmAliases = cache?.frontmatter?.aliases;
    const aliases = Array.isArray(fmAliases)
      ? fmAliases.filter((a): a is string => typeof a === "string")
      : typeof fmAliases === "string"
        ? [fmAliases]
        : // A note the metadata cache has not indexed still has its text, and the
          // picker is more useful with the aliases than without them.
          noteAliases(p.content);
    return {
      path: p.path,
      title: titleOf(p.path),
      displayTitle: cache?.headings?.find((h) => h.level === 1)?.heading ?? headingOf(p.content),
      aliases,
    };
  });
}

/** The mechanical plan: every row a machine can propose without asking a model. */
export async function buildPlan(plugin: WikiLmPlugin, ctx: FixContext): Promise<Fix[]> {
  const infos = pageInfos(plugin, ctx.pages);
  const contents = new Map(ctx.pages.map((p) => [p.path, p.content]));
  const links = planLinkFixes(ctx.report.issues, fixPagesFor(plugin, ctx.pages), contents, ctx.prefix);

  const graph = buildGraph(ctx.pages);
  // Only the notes a rect-callout row could be about; see `rectText`.
  const rectPaths = new Set(ctx.report.issues.filter((i) => i.id === "no-evidence").map((i) => i.path));
  const lookup = await rectText(plugin, rectPaths);

  return orderFixes([
    ...planCrossLinks(ctx.report.issues, infos, ctx.prefix),
    ...planRelinks(links.fixable),
    ...planRepoints(links.unresolved),
    ...planUnwraps(links.unresolved, contents, ctx.prefix),
    ...planHubLinks(ctx.report.issues, infos, hubs(infos), ctx.prefix),
    ...planRelatedFrom(ctx.report.issues, infos, neighbourOf(infos, graph), ctx.prefix, hubs(infos)),
    ...planRectCallouts(ctx.report.issues, lookup),
    ...planAttributions(ctx.report.issues, ctx.sources),
  ]);
}

/** The first 400 characters of what the page says it is. */
function excerptOf(content: string): string {
  const summary = parseTopicNote(content).summary.trim();
  if (summary) return summary.slice(0, ALIASES_EXCERPT_CHARS);
  // No `## Summary`/`## Definition`: the first paragraph after the H1 says the
  // same thing in a page the generator did not write.
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const afterH1 = body.replace(/^[\s\S]*?^#\s+.+?$/m, "");
  const para = afterH1
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith("#") && !p.startsWith(">"));
  return (para ?? "").slice(0, ALIASES_EXCERPT_CHARS);
}

/** How a key is found; the real ones read settings, then the environment, then the keychain. */
type KeyResolver = (settingsKey: string) => { key: string; source: KeySource };

/**
 * Whether the provider a role runs on is configured well enough to be worth
 * asking.
 *
 * The role, because lint may run on its own provider (`resolveRole`); the key
 * as the backend itself finds it, because a key kept in the environment or the
 * keychain is as good as one typed into the settings, and a key typed in for
 * the other API key provider readies nothing. `keys` is there for the tests.
 */
export function providerReady(
  settings: WikiLmSettings,
  role: ModelRole = "lint",
  keys: { anthropic: KeyResolver; gemini: KeyResolver } = { anthropic: resolveApiKey, gemini: resolveGeminiKey },
): boolean {
  const { provider } = resolveRole(settings, role);
  if (provider === "anthropic") return keys.anthropic(settings.apiKey ?? "").key !== "";
  if (provider === "gemini") return keys.gemini(settings.geminiApiKey ?? "").key !== "";
  // The CLI providers find their own binary; a missing one surfaces as an error
  // Notice when the button is pressed, which is a better answer than a button
  // greyed out for a reason the reader cannot see.
  return true;
}

/**
 * What the model review may treat each page as, for both schemas.
 *
 * A page that declares `type: concept` or `type: entity` is that. A page with
 * no `type:` but a class is a class-schema page, and `pageInfos` has already
 * said which kind it reads as. Everything else (a source page, a class's
 * `topic-index` hub, the log) is "other": nothing to review, nothing to link.
 */
export function reviewKindOf(infos: Map<string, FixPageInfo>): (path: string) => PageKind {
  return (path: string): PageKind => {
    const info = infos.get(path);
    if (!info) return "other";
    const type = rawTypeOf(info.content);
    if (type === "concept" || type === "entity") return type;
    if (type === "" && info.classCodes.length > 0) return info.kind;
    return "other";
  };
}

/**
 * Ask the model for the names and the subtype a page is missing.
 *
 * Both proposals come out of one call, because they are one reading of the same
 * excerpt, but only what the lint actually complained about becomes a row: a
 * page with a fine tag and no aliases gets the aliases row alone, and the
 * model's opinion about its tag is discarded rather than offered as a change
 * nobody asked for.
 *
 * Results are matched back **by title**, not by position: a model that returns
 * nineteen entries for twenty pages would otherwise write every page after the
 * gap with the wrong name.
 *
 * `cancel`, when the caller holds the plugin's token, is read between
 * batches: a stop keeps the rows already proposed and asks for no more.
 */
export async function proposeAliases(
  plugin: WikiLmPlugin,
  infos: Map<string, FixPageInfo>,
  report: VaultLintReport,
  cancel?: CancelToken,
): Promise<Fix[]> {
  const wantsAliases = new Set<string>();
  const wantsTag = new Set<string>();
  for (const issue of report.issues) {
    const info = infos.get(issue.path);
    // The tag and alias vocabularies belong to the page's own kind — a
    // `type: source` page has no concept/entity vocabulary to be offered, so
    // only concept and entity pages are eligible at all.
    if (!info) continue;
    const type = rawTypeOf(info.content);
    if (type !== "concept" && type !== "entity") continue;
    if (issue.id === "no-aliases") wantsAliases.add(issue.path);
    else if (issue.id === "schema-violation" && issue.detail?.startsWith("tag “")) wantsTag.add(issue.path);
  }

  const paths = [...new Set([...wantsAliases, ...wantsTag])].filter((p) => infos.has(p)).sort();
  if (paths.length === 0) return [];

  const proposals: AliasProposal[] = [];
  for (let i = 0; i < paths.length; i += ALIASES_BATCH) {
    if (cancel?.cancelled) break;
    const batch = paths.slice(i, i + ALIASES_BATCH);
    // The title the request carries is the title the answer is matched on, so
    // two pages reaching the model under one name would be indistinguishable
    // coming back; the second is sent with its filename appended so the name
    // stays unique and the reply still matches back to the right page.
    const byTitle = new Map<string, FixPageInfo>();
    const asked: AliasesPageIn[] = [];
    for (const path of batch) {
      const info = infos.get(path);
      if (!info) continue;
      const base = info.displayTitle || info.title;
      const name = byTitle.has(base) ? `${base} (${info.title})` : base;
      byTitle.set(name, info);
      asked.push({ title: name, kind: info.kind, excerpt: excerptOf(info.content) });
    }
    if (asked.length === 0) continue;

    const draft = await plugin.llm.aliasesAndTags({
      pages: asked,
      conceptTags: CONCEPT_TAGS,
      entityTags: ENTITY_TAGS,
    });

    for (const row of draft.pages) {
      const info = byTitle.get(row.title.trim());
      if (!info) continue;
      proposals.push({
        path: info.path,
        aliases: wantsAliases.has(info.path) ? row.aliases : [],
        tag: wantsTag.has(info.path) ? row.tag : "",
        kind: info.kind,
      });
    }
  }

  const fixes = planAliases(proposals, { concept: CONCEPT_TAGS, entity: ENTITY_TAGS });
  return orderFixes(
    fixes.filter((f) => (f.kind === "aliases" ? wantsAliases.has(f.path) : f.kind === "tag" ? wantsTag.has(f.path) : false)),
  );
}

/** How many pairs go in one duplicate-verification request. */
const DUPLICATES_BATCH = 20;

/**
 * Ask the model whether each duplicate pair is one subject or two.
 *
 * The pairs are the lint's `duplicate-pages` findings (a shared name or a
 * shared PDF span) and its held-back candidates: names spelled alike, and,
 * when the model review runs it first, the pairs its title scan read as one
 * subject under two names (pass `title`). Each
 * side goes as its title, kind, aliases and the opening of its definition, the
 * same excerpt the aliases request uses. Verdicts are matched back by the
 * pair's number in its batch, never by position.
 *
 * "Same" on a finding changes nothing: its cross-link rows are already in the
 * plan. "Same" on a candidate makes it a finding and earns it rows. "Different"
 * on either withdraws the rows. Nothing merges, whatever the model says.
 */
export async function verifyDuplicates(
  plugin: WikiLmPlugin,
  infos: Map<string, FixPageInfo>,
  report: VaultLintReport,
  prefix: string,
  cancel?: CancelToken,
): Promise<DuplicateVerdicts> {
  type Pair = { a: string; b: string; shared: string; reported: boolean };
  const pairs: Pair[] = [];
  for (const issue of report.issues) {
    if (issue.id === "duplicate-pages" && issue.target) pairs.push({ a: issue.path, b: issue.target, shared: issue.detail ?? "", reported: true });
  }
  for (const c of report.candidates ?? []) pairs.push({ a: c.a, b: c.b, shared: c.detail, reported: false });
  const usable = pairs.filter((p) => infos.has(p.a) && infos.has(p.b));
  const pageIn = (info: FixPageInfo): DuplicatePageIn => ({
    title: info.displayTitle || info.title,
    kind: info.kind,
    aliases: noteAliases(info.content),
    excerpt: excerptOf(info.content),
  });
  const cleared: string[] = [];
  const confirmedNew: VaultIssue[] = [];
  let checked = 0;
  let confirmed = 0;
  let stopped: DuplicateVerdicts["stopped"];
  const of = Math.ceil(usable.length / DUPLICATES_BATCH);
  for (let i = 0; i < usable.length; i += DUPLICATES_BATCH) {
    if (cancel?.cancelled) {
      stopped = { done: i / DUPLICATES_BATCH, of };
      break;
    }
    const batch = usable.slice(i, i + DUPLICATES_BATCH);
    const asked: DuplicatePairIn[] = batch.map((p, k) => ({
      n: k + 1,
      a: pageIn(infos.get(p.a) as FixPageInfo),
      b: pageIn(infos.get(p.b) as FixPageInfo),
      shared: p.shared,
    }));
    const draft = await plugin.llm.verifyDuplicates({ pairs: asked });
    const answered = new Set<number>();
    for (const v of draft.pairs) {
      const p = batch[v.n - 1];
      if (!p || answered.has(v.n)) continue;
      answered.add(v.n);
      checked++;
      if (v.same) {
        confirmed++;
        if (!p.reported) {
          confirmedNew.push({ id: "duplicate-pages", path: p.a, title: titleOf(p.a), target: p.b, detail: `${p.shared}; the model agrees: ${v.reason.trim()}` });
        }
      } else {
        cleared.push(pairKey(p.a, p.b));
      }
    }
  }
  return { rows: orderFixes(planCrossLinks(confirmedNew, infos, prefix)), cleared, checked, confirmed, issues: confirmedNew, ...(stopped ? { stopped } : {}) };
}

/** How many directory entries go in one title-scan request. */
const TITLE_SCAN_BATCH = 300;
/** How many pages go in one page-review request. */
const REVIEW_BATCH = 5;

/** What the model review adds to a Lint wiki run. */
export interface ModelReviewResult {
  /** Findings the review added: confirmed look-alikes, unsupported sentences, missing links, wrong kinds. */
  issues: VaultIssue[];
  /** The report's candidates plus the title scan's, less those the duplicate check confirmed or cleared. */
  candidates: DuplicateFinding[];
  /** Plan rows from the review, in `orderFixes` order. */
  rows: Fix[];
  /** `pairKey`s the duplicate check cleared, for `applyDuplicateVerdicts` on the mechanical plan. */
  cleared: string[];
  /** The review in one report line (`renderReviewLine`). */
  line: string;
  /** One entry per phase that failed or was stopped, in the line's words. */
  failed: string[];
}

function mergeCounts(into: Record<string, number>, from: Record<string, number>): void {
  for (const [k, n] of Object.entries(from)) into[k] = (into[k] ?? 0) + n;
}

/**
 * The model review of Lint wiki: the pure report read by the model, and
 * nothing it says believed until `src/lintReview.ts` has checked it.
 *
 * Three phases, each in its own try so one failure is one line and the others
 * still run; a cancel is read between batches, never mid-call, and a stopped
 * phase is reported the way a failed one is. 2a scans every page's title for
 * pairs a spelling comparison misses, and adds the verified ones to the
 * candidates. 2b runs the duplicate check the fix plan's button runs, over the
 * findings and every candidate; a pair it clears leaves the candidates and,
 * when the scan had reported it, the findings 2c ranks pages by, so a page is
 * not read for a finding that no longer stands. 2c reads the pages with
 * findings in full, five a call, worst first until the budget runs out; each
 * call is its own try, so one failed call costs its five pages and no more.
 * Follows the design of gd4ai/obsidian-llm-wiki's lint phases, reimplemented.
 * Nothing is written here: every proposal is a row the reader ticks.
 *
 * `plan` is the mechanical plan the review's rows will join, read only so a
 * turned-round link row can see the page already has a hub or neighbour row
 * (`planReviewLinks`).
 */
export async function runModelReview(
  plugin: WikiLmPlugin,
  ctx: FixContext,
  infos: Map<string, FixPageInfo>,
  status: (s: string) => void,
  cancel?: CancelToken,
  plan: Fix[] = [],
): Promise<ModelReviewResult> {
  const { report, pages, prefix } = ctx;
  const kindOf = reviewKindOf(infos);
  // What the page review sends, capped so it cannot crowd out the pages. The
  // title scan is not capped: a pair it cannot see is a pair it cannot find.
  const directory = directoryOf(pages, kindOf);
  const everyTitle = directoryOf(pages, kindOf, Infinity, Infinity);
  const contentOf = new Map(pages.map((p) => [p.path, p.content]));

  const issues: VaultIssue[] = [];
  let candidates: DuplicateFinding[] = [...(report.candidates ?? [])];
  const rows: Fix[] = [];
  const cleared: string[] = [];
  const failed: string[] = [];
  const dropped: Record<string, number> = {};
  const stopped = (phase: string, done: number, of: number): void => {
    failed.push(`${phase} stopped after ${done} of ${of} batch${of === 1 ? "" : "es"}`);
  };

  // 2a: the title scan.
  try {
    const existing = new Set<string>();
    for (const i of report.issues) if (i.id === "duplicate-pages" && i.target) existing.add(pairKey(i.path, i.target));
    for (const c of candidates) existing.add(pairKey(c.a, c.b));
    const of = Math.ceil(everyTitle.length / TITLE_SCAN_BATCH);
    for (let b = 0; b < of; b++) {
      if (cancel?.cancelled) {
        stopped("title scan", b, of);
        break;
      }
      status(of > 1 ? `model review: title scan ${b + 1} of ${of}` : "model review: title scan");
      // Each call sees only its own batch, so two names that land in different
      // batches are never compared: a pair cannot cross a batch. Titles are in
      // path order, which keeps a folder's pages together in one batch more
      // often than not. What comes back is resolved against every title, so a
      // title that two pages share names neither, wherever the other one fell.
      const batch = everyTitle.slice(b * TITLE_SCAN_BATCH, (b + 1) * TITLE_SCAN_BATCH);
      const out = await plugin.llm.scanTitles({ pages: batch });
      const v = verifyTitleScan(out, everyTitle, existing);
      for (const c of v.candidates) existing.add(pairKey(c.a, c.b));
      candidates.push(...v.candidates);
      mergeCounts(dropped, v.dropped);
    }
  } catch (e) {
    failed.push(`title scan failed: ${describeError(e)}`);
  }

  // 2b: the duplicate check, over the findings and every candidate.
  try {
    if (!cancel?.cancelled) status("model review: duplicates");
    const v = await verifyDuplicates(plugin, infos, { ...report, candidates }, prefix, cancel);
    issues.push(...v.issues);
    rows.push(...v.rows);
    cleared.push(...v.cleared);
    if (v.stopped) stopped("duplicate check", v.stopped.done, v.stopped.of);
    const decided = new Set([...v.issues.map((i) => pairKey(i.path, i.target ?? "")), ...v.cleared]);
    candidates = candidates.filter((c) => !decided.has(pairKey(c.a, c.b)));
  } catch (e) {
    failed.push(`duplicate check failed: ${describeError(e)}`);
  }

  // 2c: the page review.
  let read = 0;
  let withFindings = 0;
  let skipped = 0;
  try {
    // A reported pair the check cleared is no longer a finding, here or in the
    // plan's report (`mergeReview`).
    const gone = new Set(cleared);
    const standing = report.issues.filter((i) => !(i.id === "duplicate-pages" && i.target && gone.has(pairKey(i.path, i.target))));
    const working: VaultLintReport = { ...report, issues: [...standing, ...issues], candidates };
    const chosen = selectPages(working, pages, REVIEW_BUDGET_CHARS, kindOf);
    skipped = chosen.skipped;
    withFindings = chosen.chosen.length + chosen.skipped;
    const sent = buildReviewInputs(working, chosen.chosen, kindOf, pages);
    const links: ReviewLink[] = [];
    const kinds: ReviewKind[] = [];
    const units = (path: string) => quoteUnits(path, contentOf.get(path) ?? "");
    // For a page cut off from the graph the link row goes on the target,
    // linking back, so whether it is already there is read off the target.
    const cutOff = new Set(working.issues.filter((i) => i.id === "orphan" || i.id === "unlinked").map((i) => i.path));
    const linksOf = (path: string): string[] => noteLinks(contentOf.get(path) ?? "").map((l) => linkKey(l.raw)).filter(Boolean);
    const of = Math.ceil(sent.length / REVIEW_BATCH);
    for (let b = 0; b < of; b++) {
      if (cancel?.cancelled) {
        stopped("page review", b, of);
        break;
      }
      status(`model review: page ${b * REVIEW_BATCH + 1} of ${sent.length}`);
      const batch = sent.slice(b * REVIEW_BATCH, (b + 1) * REVIEW_BATCH);
      try {
        const out = await plugin.llm.reviewPages({ pages: batch, directory });
        const v = verifyReview(batch, out.pages, directory, units, { cutOff, linksOf });
        issues.push(...v.issues);
        links.push(...v.links);
        kinds.push(...v.kinds);
        mergeCounts(dropped, v.dropped);
        read += batch.length;
      } catch (e) {
        failed.push(`page review: batch ${b + 1} of ${of} failed: ${describeError(e)}`);
      }
    }
    rows.push(...planReviewLinks(links, working.issues, infos, prefix, plan), ...planKinds(kinds, infos));
  } catch (e) {
    failed.push(`page review failed: ${describeError(e)}`);
  }

  return {
    issues,
    candidates,
    rows: orderFixes(rows),
    cleared,
    line: renderReviewLine({ read, withFindings, skipped, findings: issues.length, dropped, failed, cleared: cleared.length }),
    failed,
  };
}

/**
 * Write the ticked rows, one pass per note.
 *
 * `process` rather than `modify`, so a note edited between the plan and the
 * click is edited from what it says now. A note whose fixes all turn out to be
 * no-ops — the link was already repaired, the alias was already there — is
 * counted as skipped rather than changed, so the Notice says what happened
 * instead of what was attempted.
 */
export async function applyPlan(
  plugin: WikiLmPlugin,
  fixes: Fix[],
): Promise<{ notes: number; fixes: number; skipped: number }> {
  const enabled = fixes.filter((f) => f.enabled);
  const byNote = groupByNote(enabled);
  let notes = 0;
  let skipped = 0;

  for (const [path, list] of byNote) {
    const file = plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      skipped += list.length;
      continue;
    }
    let changed = false;
    await plugin.app.vault.process(file, (data) => {
      const next = applyFixesToNote(data, list);
      changed = next !== data;
      return next;
    });
    if (changed) notes += 1;
    else skipped += list.length;
  }

  return { notes, fixes: enabled.length - skipped, skipped };
}
