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

export type VaultIssueId = "empty-note" | "no-evidence" | "dead-link" | "orphan" | "unlinked";

export interface VaultIssue {
  id: VaultIssueId;
  /** The note the issue is about. */
  path: string;
  title: string;
  /** The link target, for a dead link. */
  target?: string;
}

export interface VaultLintReport {
  notes: number;
  units: number;
  issues: VaultIssue[];
}

export interface LintPage {
  path: string;
  content: string;
}

function titleOf(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/i, "");
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
export function lintVault(pages: LintPage[]): VaultLintReport {
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
  for (const page of pages) {
    const title = titleOf(page.path);
    const body = page.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
    const indexed: EvidenceUnit[] = indexNote(page.path, page.content);
    units += indexed.length;

    if (body.length === 0) {
      issues.push({ id: "empty-note", path: page.path, title });
    } else if (indexed.length === 0) {
      // Has text, but nothing Ask can quote — an embed-only note, say.
      issues.push({ id: "no-evidence", path: page.path, title });
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

  return { notes: pages.length, units, issues };
}

/** What each issue means, in the order a reader should care about it. */
export const VAULT_ISSUE_LABELS: Record<VaultIssueId, string> = {
  "empty-note": "Empty: nothing written in it yet",
  "no-evidence": "Nothing quotable: Ask cannot answer from this note",
  orphan: "Cut off: no links in or out, so the graph cannot reach it",
  "dead-link": "Dead link: points at a note that does not exist",
  unlinked: "Nothing links here: only reachable by searching its own words",
};

const ORDER: VaultIssueId[] = ["empty-note", "no-evidence", "orphan", "dead-link", "unlinked"];

/** The report as markdown for the chat, worst first, with the notes named. */
export function renderVaultLint(report: VaultLintReport, limit = 8): string {
  const lines = [`**Wiki check** — ${report.notes} notes, ${report.units} passages Ask can quote.`];
  if (report.issues.length === 0) {
    lines.push("", "Nothing to fix: every note holds evidence and is reachable through the wiki.");
    return lines.join("\n");
  }

  for (const id of ORDER) {
    const found = report.issues.filter((i) => i.id === id);
    if (found.length === 0) continue;
    lines.push("", `**${VAULT_ISSUE_LABELS[id]}** (${found.length})`);
    for (const issue of found.slice(0, limit)) {
      lines.push(issue.target ? `- [[${issue.title}]] → \`${issue.target}\`` : `- [[${issue.title}]]`);
    }
    if (found.length > limit) lines.push(`- …and ${found.length - limit} more`);
  }
  return lines.join("\n");
}
