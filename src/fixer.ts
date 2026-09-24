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
import type { LintPage, VaultLintReport } from "./vaultLint";
import { planLinkFixes, type FixPage } from "./vaultFix";
import {
  groupByNote,
  orderFixes,
  planAliases,
  planAttributions,
  planCrossLinks,
  planHubLinks,
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
} from "./fixPlan";
import { buildGraph, isGraphUsable, pprFromSeeds, type Graph } from "./graph";
import { CONCEPT_TAGS, ENTITY_TAGS, fmList, noteAliases, parseTopicNote } from "./topicNote";
import { pdfsLinkedFrom } from "./pdf";
import { collectPdfHighlights } from "./pdfHighlights";
import { ALIASES_EXCERPT_CHARS, type AliasesPageIn } from "./prompt";

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
    ...planRelatedFrom(ctx.report.issues, infos, neighbourOf(infos, graph), ctx.prefix),
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

/** Whether the provider is configured well enough to be worth asking. */
export function providerReady(settings: WikiLmSettings): boolean {
  // The CLI providers find their own binary; a missing one surfaces as an error
  // Notice when the button is pressed, which is a better answer than a button
  // greyed out for a reason the reader cannot see.
  return settings.provider === "anthropic" ? settings.apiKey.trim() !== "" : true;
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
 */
export async function proposeAliases(
  plugin: WikiLmPlugin,
  infos: Map<string, FixPageInfo>,
  report: VaultLintReport,
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
