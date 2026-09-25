/**
 * Structural checks over the topic notes themselves.
 *
 * `src/lint.ts` checks a card against the highlight it came from. This checks
 * the wiki: whether a note can be found, whether its links go anywhere, and
 * whether it holds anything Ask could quote. Those are the faults that make
 * the chat look broken while every note looks fine on screen — a note nothing
 * links to is a note the graph can never reach, and a note that indexes to
 * nothing answers no question no matter how carefully it was written.
 *
 * Adapted from gd4ai/obsidian-llm-wiki's lint scanners (`scanOrphans`,
 * `scanDeadLinks`, `delete-empty-stubs`), narrowed to the checks that mean
 * something for a highlight-centric vault.
 *
 * Pure: no `obsidian` import, same rule as src/lint.ts, so the tests bundle it
 * standalone.
 */
import { indexNote, type EvidenceUnit } from "./retrieval";
import { linkKey, noteLinks } from "./graph";
import { noteAliases } from "./topicNote";
import { highlightKey } from "./pdflink";
import { findDuplicates, type DuplicateFinding, type DuplicatePage } from "./duplicates";

export type VaultIssueId =
  | "empty-note"
  | "no-evidence"
  | "dead-link"
  | "duplicate-pages"
  | "orphan"
  | "unlinked"
  | "ungrounded-quote"
  | "unverifiable-quote"
  | "unattributed-quote"
  | "schema-violation"
  | "no-aliases";

export interface VaultIssue {
  id: VaultIssueId;
  /** The note the issue is about. */
  path: string;
  title: string;
  /** The link target, for a dead link; the source cited, for a quote. */
  target?: string;
  /** What is wrong, when the label alone does not say: the quote, the bad tag. */
  detail?: string;
}

/**
 * What a page must look like for the schema checks to mean anything.
 *
 * Passed in rather than hardcoded because the two vaults this plugin runs in
 * use different schemas on purpose: one keys pages by `type` with a closed tag
 * vocabulary, the other by `class` with none. A vault with no rules configured
 * simply skips those checks instead of reporting every page as wrong.
 */
export interface SchemaRules {
  /** Frontmatter key that names the kind of page, e.g. "type". */
  kindKey: string;
  /** Allowed tags per kind. A kind with no entry accepts any tag. */
  tagsByKind: Record<string, readonly string[]>;
  /** Kinds that should carry at least one alias, so a search by another name finds them. */
  aliasKinds: readonly string[];
  /** Kinds the wiki also uses that carry no tag rule: legacy pages the lint must not report as off-schema. */
  freeKinds?: readonly string[];
}

export interface LintOptions {
  schema?: SchemaRules;
  /**
   * Source text to check quotes against, keyed by note path. Anything a quote
   * might have come from: the source pages, and the original notes they were
   * clipped from.
   */
  sources?: Map<string, string>;
}

export interface VaultLintReport {
  notes: number;
  units: number;
  issues: VaultIssue[];
  /**
   * Pairs of pages spelled alike (`findDuplicates` pass `similar`). Not
   * findings: a report that accused two pages on spelling would be wrong
   * about Kinetics and Kinematics. The fix plan offers them to the model, and
   * only a pair the model confirms becomes a finding with cross-link rows.
   */
  candidates: DuplicateFinding[];
}

export interface LintPage {
  path: string;
  content: string;
}


/**
 * The schema the wiki pages in this vault follow.
 *
 * Both vocabularies are what the existing pages actually use, counted across
 * all of them rather than taken from a spec — a rule nobody follows would
 * report every page as broken and teach the reader to ignore the lint.
 */
export const WIKI_SCHEMA: SchemaRules = {
  kindKey: "type",
  tagsByKind: {
    concept: ["method", "theory", "term", "phenomenon", "standard", "field", "other"],
    entity: ["product", "person", "organization", "project", "event", "place", "other"],
    source: ["clippings", "paper", "lecture", "book", "other"],
  },
  aliasKinds: ["concept", "entity"],
  freeKinds: ["topic", "topic-index"],
};

function titleOf(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
}

/** A PDF target that names a span — a selection, an annotation or a rectangle — rather than a page alone. Two pages citing one page are not about one thing; two pages citing one span are. */
function spanTarget(t: NonNullable<EvidenceUnit["target"]>): boolean {
  return t.selection !== undefined || t.annotation !== undefined || t.rect !== undefined;
}

/**
 * Every note link in a body, resolved against the known notes; unresolved ones
 * come back as null.
 *
 * Links are read with `noteLinks` (src/graph.ts), the same scanner the graph
 * walks with, so the lint cannot report a dead link the graph is traversing
 * happily — or miss one it is silently dropping.
 */
function linksOf(content: string, known: Map<string, string>): Array<{ raw: string; target: string | null }> {
  // Embeds count here: `![[Some Note]]` transcludes a note that has to exist,
  // and a broken one is exactly the kind of rot this is looking for.
  return noteLinks(content).map(({ raw }) => ({ raw, target: known.get(linkKey(raw)) ?? null }));
}


/** Frontmatter block of a note, or "" when it has none. */
function frontmatterOf(content: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  return m ? m[1] : "";
}

/** A scalar frontmatter value, unquoted. */
function fmScalar(fm: string, key: string): string | null {
  const m = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(fm);
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, "");
}

/**
 * The `tags:` values, inline or block. Returns [] when the key is absent, so
 * "no tags" and "tags: []" are the same thing to a caller that only cares
 * whether a tag is allowed.
 */
function fmTags(fm: string): string[] {
  const inline = /^tags:\s*\[(.*)\]\s*$/m.exec(fm);
  if (inline) {
    return inline[1]
      .split(",")
      .map((t) => t.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  const block = /^tags:\s*\n((?:\s*-\s*.*\n?)*)/m.exec(fm);
  if (block) {
    return block[1]
      .split("\n")
      .map((l) => l.replace(/^\s*-\s*/, "").trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  const scalar = fmScalar(fm, "tags");
  return scalar ? [scalar] : [];
}

/**
 * Whether the note carries at least one non-empty alias.
 *
 * Checking for the key alone is not enough: `aliases: []`, and a block whose
 * entries are all empty strings, both leave a page findable only under its own
 * title while looking configured.
 */
function hasAlias(fm: string): boolean {
  const inline = /^aliases:\s*\[(.*)\]\s*$/m.exec(fm);
  if (inline) return inline[1].split(",").some((a) => a.trim().replace(/^["']|["']$/g, "").length > 0);
  const block = /^aliases:\s*\n((?:\s*-\s*.*\n?)*)/m.exec(fm);
  if (block) {
    return block[1]
      .split("\n")
      .some((l) => l.replace(/^\s*-\s*/, "").trim().replace(/^["']|["']$/g, "").length > 0);
  }
  const scalar = fmScalar(fm, "aliases");
  return !!scalar && scalar.length > 0;
}

/** Collapse whitespace and case so a quote survives reflowing and smart quotes. */
function normalizeForQuote(s: string): string {
  return s
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Quotes claimed under `## Mentions in Source`, in both forms this vault holds.
 *
 * A PDF++ callout (`> [!PDF|…] [[link]]` then `> > text`) carries its own
 * anchor and is checked by opening it, not by string search — it is returned
 * with `anchored: true` and skipped. A plain `- "quote"` line has no anchor at
 * all, which is the form worth checking, and the one the old generator wrote
 * by the hundred.
 */
function mentionQuotes(body: string): Array<{ quote: string; cited: string | null; anchored: boolean }> {
  const out: Array<{ quote: string; cited: string | null; anchored: boolean }> = [];
  const section = /^##\s+Mentions in Source\s*$/m.exec(body);
  if (!section) return out;
  const start = section.index + section[0].length;
  const rest = body.slice(start);
  const next = /^##\s/m.exec(rest);
  const block = next ? rest.slice(0, next.index) : rest;

  for (const raw of block.split("\n")) {
    const line = raw.trim();
    if (line.startsWith(">")) {
      // A callout line: the quote lives on the `> >` line under a header that
      // already names the page and selection it came from.
      const nested = /^>\s*>\s*(.+)$/.exec(line);
      if (nested) out.push({ quote: nested[1].trim(), cited: null, anchored: true });
      continue;
    }
    const bullet = /^-\s*"(.+?)"\s*(?:\u2014|--|—)?\s*(?:\[\[([^\]]+)\]\])?\s*$/.exec(line);
    if (bullet) {
      const cited = bullet[2] ? bullet[2].split("|")[0].trim() : null;
      // A bullet whose link opens the PDF at a selection is anchored the same
      // way a callout is: the click is the check, not a string search.
      const anchored = cited !== null && /\.pdf(?:#|$)/i.test(cited);
      out.push({ quote: bullet[1].trim(), cited, anchored });
    }
  }
  return out;
}


/**
 * The text a citation points at, or null when the vault does not hold it.
 *
 * A citation is a wikilink, so it may name a path, a path without `.md`, or
 * just a title. `known` already maps a link key to a real path for the
 * dead-link check, so the same resolution is reused here rather than invented
 * a second time.
 */
function resolveSource(cited: string, sources: Map<string, string>, known: Map<string, string>): string | null {
  const direct = sources.get(cited) ?? sources.get(`${cited}.md`);
  if (direct !== undefined) return direct;
  const viaKnown = known.get(linkKey(cited));
  if (viaKnown !== undefined) {
    const text = sources.get(viaKnown);
    if (text !== undefined) return text;
  }
  for (const [path, text] of sources) {
    if (linkKey(path) === linkKey(cited)) return text;
  }
  return null;
}

/**
 * Check the notes as a wiki.
 *
 * `orphan` and `unlinked` are deliberately separate. A note nothing links to
 * and that links to nothing is cut off from the wiki entirely — the graph can
 * neither reach it nor leave it. A note that is merely unlinked *from* still
 * reaches its neighbours, which is a much smaller problem, and in a wiki that
 * is still being written it is the normal state of the newest note. Reporting
 * them as one issue would bury the first in a list of the second.
 */
export function lintVault(pages: LintPage[], options: LintOptions = {}): VaultLintReport {
  const known = new Map<string, string>();
  for (const p of pages) {
    if (!known.has(linkKey(p.path))) known.set(linkKey(p.path), p.path);
  }

  const issues: VaultIssue[] = [];
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const p of pages) {
    incoming.set(p.path, 0);
    outgoing.set(p.path, 0);
  }

  let units = 0;
  const dupPages: DuplicatePage[] = [];
  for (const page of pages) {
    const title = titleOf(page.path);
    const body = page.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
    const indexed: EvidenceUnit[] = indexNote(page.path, page.content);
    units += indexed.length;
    dupPages.push({
      path: page.path,
      title,
      aliases: noteAliases(page.content),
      evidence: indexed
        .filter((u) => u.target !== null && u.pdfBasename !== null && spanTarget(u.target))
        .map((u) => `${u.pdfBasename}#${highlightKey(u.target as NonNullable<EvidenceUnit["target"]>)}`),
    });

    if (body.length === 0) {
      issues.push({ id: "empty-note", path: page.path, title });
    } else if (indexed.length === 0) {
      // Has text, but nothing Ask can quote — an embed-only note, say.
      issues.push({ id: "no-evidence", path: page.path, title });
    }

    // ---- schema, aliases, and quote grounding -------------------------
    // These run per page and only when the caller supplied what they need, so
    // a vault with no schema configured is not reported as entirely wrong.
    const fm = frontmatterOf(page.content);
    const schema = options.schema;
    if (schema) {
      const kind = fmScalar(fm, schema.kindKey);
      const allowed = kind ? schema.tagsByKind[kind] : undefined;
      if (kind && allowed) {
        for (const tag of fmTags(fm)) {
          if (!allowed.includes(tag)) {
            issues.push({ id: "schema-violation", path: page.path, title, detail: `tag “${tag}” is not one of ${allowed.join(", ")}` });
          }
        }
      } else if (kind && !(kind in schema.tagsByKind) && !(schema.freeKinds ?? []).includes(kind)) {
        issues.push({ id: "schema-violation", path: page.path, title, detail: `${schema.kindKey}: ${kind} is not a kind this wiki uses` });
      }
      if (kind && schema.aliasKinds.includes(kind) && !hasAlias(fm)) {
        issues.push({ id: "no-aliases", path: page.path, title });
      }
    }

    if (options.sources) {
      for (const mention of mentionQuotes(body)) {
        // A callout carries its own anchor: it was verified when it was
        // written and reopening it is the real check, not a string search.
        if (mention.anchored) continue;
        const needle = normalizeForQuote(mention.quote);
        if (needle.length === 0) continue;

        if (!mention.cited) {
          // No source named. Nothing can confirm or deny the quote, so this
          // is a fault of the page's record-keeping, not an accusation
          // against the quote. Searching every source for it — what this
          // used to do — reported "the source does not say this" about a
          // source that was never named, and a match found that way would
          // have been coincidence rather than provenance.
          issues.push({ id: "unattributed-quote", path: page.path, title, detail: mention.quote });
          continue;
        }

        const cited = resolveSource(mention.cited, options.sources, known);
        if (cited === null) {
          // It names a source that is not in the vault, so nothing can confirm
          // or deny the quote. Distinct from a wrong quote on purpose.
          issues.push({ id: "unverifiable-quote", path: page.path, title, target: mention.cited, detail: mention.quote });
          continue;
        }
        if (!normalizeForQuote(cited).includes(needle)) {
          issues.push({ id: "ungrounded-quote", path: page.path, title, target: mention.cited, detail: mention.quote });
        }
      }
    }

    const seenTargets = new Set<string>();
    for (const link of linksOf(page.content, known)) {
      if (link.target === null) {
        // One entry per missing target per note, as upstream: a note that
        // names the same missing page four times is one problem, not four.
        if (seenTargets.has(link.raw.toLowerCase())) continue;
        seenTargets.add(link.raw.toLowerCase());
        issues.push({ id: "dead-link", path: page.path, title, target: link.raw });
        continue;
      }
      if (link.target === page.path) continue;
      outgoing.set(page.path, (outgoing.get(page.path) ?? 0) + 1);
      incoming.set(link.target, (incoming.get(link.target) ?? 0) + 1);
    }
  }

  for (const page of pages) {
    const title = titleOf(page.path);
    const inn = incoming.get(page.path) ?? 0;
    const out = outgoing.get(page.path) ?? 0;
    if (inn === 0 && out === 0) issues.push({ id: "orphan", path: page.path, title });
    else if (inn === 0) issues.push({ id: "unlinked", path: page.path, title });
  }

  const candidates: DuplicateFinding[] = [];
  for (const dup of findDuplicates(dupPages)) {
    if (dup.pass === "similar") {
      candidates.push(dup);
      continue;
    }
    issues.push({ id: "duplicate-pages", path: dup.a, title: titleOf(dup.a), target: dup.b, detail: dup.detail });
  }

  // Sorted by how much a finding matters, then by note, so an unchanged vault
  // produces a byte-identical report and the worst thing is always on top.
  const severity = new Map(ORDER.map((id, i) => [id, i]));
  issues.sort(
    (a, b) =>
      (severity.get(a.id) ?? ORDER.length) - (severity.get(b.id) ?? ORDER.length) ||
      a.path.localeCompare(b.path) ||
      a.id.localeCompare(b.id) ||
      (a.detail ?? "").localeCompare(b.detail ?? ""),
  );
  return { notes: pages.length, units, issues, candidates };
}

/** What each issue means, in the order a reader should care about it. */
export const VAULT_ISSUE_LABELS: Record<VaultIssueId, string> = {
  "ungrounded-quote": "Quote not in its source: the page claims something the source does not say",
  "unverifiable-quote": "Quote cannot be checked: the source it cites is not in the vault",
  "unattributed-quote": "No source recorded: nothing can confirm this quote",
  "empty-note": "Empty: nothing written in it yet",
  "no-evidence": "Nothing quotable: Ask cannot answer from this note",
  orphan: "Cut off: no links in or out, so the graph cannot reach it",
  "schema-violation": "Off-schema: a reader filtering by kind or tag will miss it",
  "dead-link": "Dead link: points at a note that does not exist",
  "duplicate-pages": "Two pages, one subject: they share a name or cite the same span",
  "no-aliases": "No aliases: only found under its own exact title",
  unlinked: "Nothing links here: only reachable by searching its own words",
};

/**
 * Worst first, in four classes: provenance and schema (what a page claims and
 * how it is filed), then structure (links), then reachability, then emptiness.
 * A page that misquotes its source leads because it is the one failure that
 * makes an answer wrong rather than merely missing.
 */
const ORDER: VaultIssueId[] = [
  "ungrounded-quote",
  "unverifiable-quote",
  "unattributed-quote",
  "schema-violation",
  "no-aliases",
  "dead-link",
  "duplicate-pages",
  "orphan",
  "unlinked",
  "empty-note",
  "no-evidence",
];

/** The report as markdown for the chat, worst first, with the notes named. */
/** Enough of a quote to recognise it, not enough to fill the log. */
function short(s: string, max = 90): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}\u2026`;
}

export function renderVaultLint(report: VaultLintReport, limit = 8): string {
  const lines = [`**Wiki check** — ${report.notes} notes, ${report.units} passages Ask can quote.`];
  if (report.issues.length === 0) {
    lines.push("", "Nothing to fix: every note holds evidence and is reachable through the wiki.");
    lines.push(...candidatesLine(report));
    return lines.join("\n");
  }

  for (const id of ORDER) {
    const found = report.issues.filter((i) => i.id === id);
    if (found.length === 0) continue;
    lines.push("", `**${VAULT_ISSUE_LABELS[id]}** (${found.length})`);
    for (const issue of found.slice(0, limit)) {
      const where = issue.target ? ` → \`${issue.target}\`` : "";
      // A quote is the evidence for its own finding, so it is shown rather
      // than summarised; anything else is named by its note alone.
      const what = issue.detail ? `: ${short(issue.detail)}` : "";
      lines.push(`- [[${issue.title}]]${where}${what}`);
    }
    if (found.length > limit) lines.push(`- …and ${found.length - limit} more`);
  }
  lines.push(...candidatesLine(report));
  return lines.join("\n");
}

/** The look-alike pairs the report holds back, named as such so their absence from the findings is not a silence. */
function candidatesLine(report: VaultLintReport): string[] {
  // Tolerant of a report built by hand without the field.
  const n = report.candidates?.length ?? 0;
  if (n === 0) return [];
  return ["", `${n} pair${n === 1 ? "" : "s"} spelled alike, not reported: **Suggest fixes** → **Check duplicates with the model** decides them.`];
}
