import type { Card, GenerationAuditRecord, Highlight } from "./model";
import { cardContent, currentCardCheck, exportCandidates, type ExportItem } from "./cardActions";
import { generationSourceKey, sourceConcernsForCard } from "./generation";
import { unacceptedChecks } from "./qualityAcceptance";
import { lintCard, LINT_LABELS } from "./lint";
import { countClozes } from "./util";

/** Keep recorded concerns, not lifecycle messages or positive certification. */
export function auditFinding(audit?: Pick<GenerationAuditRecord, "status" | "reason">): string {
  if (!audit || audit.status === "verified") return "";
  const reason = audit.reason.trim();
  if (/^(?:audit )?(?:unverified|verified|failed)(?: \((?:no staged audit|card changed|capture changed)\))?\.?$/i.test(reason)) return "";
  if (["Independent audit has not run.", "Explicit rewrite; original staged audit retained on the source card.", "Independent audit completed; see each candidate's verdict."].includes(reason)) return "";
  return reason;
}

function sourceConflictFindings(card: Card, highlight: Highlight): string[] {
  return sourceConcernsForCard(card, highlight).map(conflict => `Source conflict: ${conflict.reason} Quote: “${conflict.quote}”`);
}

/** Invalidate an open confirmation on changes to wording, evidence, checks or destination. */
export function exportSelectionKey(items: ExportItem[], settings: unknown, crossInterference: ReadonlyMap<string, string[]> = new Map()): string {
  return JSON.stringify([settings, items.map(({ card, highlight }) => [
    card.id, highlight.id, cardContent(card, highlight), generationSourceKey(highlight),
    card.status, highlight.status, highlight.archived, card.generation, card.userCheck, card.qualityAcceptance, card.critiqueReason,
    sourceConflictFindings(card, highlight),
    [...(crossInterference.get(card.id) ?? [])].sort(),
  ])]);
}

export interface ExportSummary {
  notes: number;
  tasks: number;
  warnings: { cardId: string; source: string; reasons: string[] }[];
  error?: string;
}

/** Use the export gate itself; summaries neither accept cards nor change eligibility. */
export function summarizeExport(
  highlights: Highlight[],
  ids: ReadonlySet<string>,
  crossInterference: ReadonlyMap<string, string[]> = new Map(),
): ExportSummary {
  let items;
  try {
    items = exportCandidates(highlights, ids);
  } catch (error) {
    return { notes: 0, tasks: 0, warnings: [], error: error instanceof Error ? error.message : "Export selection could not be validated." };
  }
  const warnings: ExportSummary["warnings"] = [];
  let tasks = 0;
  for (const { card, highlight } of items) {
    tasks += card.kind === "qa" ? 1 : countClozes(card.text);
    const lint = lintCard(card, highlight, highlight.cards.filter(c => c.id !== card.id && c.status !== "deleted"));
    const reasons = new Set<string>();
    for (const checkId of unacceptedChecks(card, highlight, [...lint.failures, ...lint.warnings])) {
      const id = checkId as keyof typeof LINT_LABELS;
      const policy = id === "card-long" || id === "qa-answer-long" ? " (product style policy)" : "";
      reasons.add(`${LINT_LABELS[id]}${policy}`);
    }
    if (crossInterference.has(card.id)) reasons.add(LINT_LABELS["cross-interference"]);
    const finding = auditFinding(card.generation?.audit);
    const check = currentCardCheck(card, highlight);
    if (finding) reasons.add(finding);
    for (const conflict of sourceConflictFindings(card, highlight)) reasons.add(conflict);
    if (card.critiqueReason) reasons.add(card.critiqueReason);
    for (const issue of check?.issues ?? []) reasons.add(issue);
    if (reasons.size) warnings.push({ cardId: card.id, source: highlight.sourceTitle, reasons: [...reasons] });
  }
  return { notes: items.length, tasks, warnings };
}
