import type { Highlight } from "./model";
import { cardContent, currentCardCheck, exportCandidates, type ExportItem } from "./cardActions";
import { cardAuditLabel, generationSourceKey } from "./generation";
import { lintCard, LINT_LABELS } from "./lint";
import { countClozes } from "./util";

/** Invalidate an open confirmation on changes to wording, evidence, checks or destination. */
export function exportSelectionKey(items: ExportItem[], settings: unknown): string {
  return JSON.stringify([settings, items.map(({ card, highlight }) => [
    card.id, highlight.id, cardContent(card, highlight), generationSourceKey(highlight),
    card.status, highlight.status, highlight.archived, card.generation, card.userCheck, card.critiqueReason,
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
    for (const id of [...lint.failures, ...lint.warnings]) {
      const policy = id === "card-long" || id === "qa-answer-long" ? " (product style policy)" : "";
      reasons.add(`${LINT_LABELS[id]}${policy}`);
    }
    if (crossInterference.has(card.id)) reasons.add(LINT_LABELS["cross-interference"]);
    const audit = cardAuditLabel(card, highlight);
    const check = currentCardCheck(card, highlight);
    if (!audit.startsWith("Audit verified") && (!check || check.issues.length || card.generation?.audit.status === "failed")) reasons.add(audit);
    if (card.critiqueReason) reasons.add(card.critiqueReason);
    for (const issue of currentCardCheck(card, highlight)?.issues ?? []) reasons.add(issue);
    if (reasons.size) warnings.push({ cardId: card.id, source: highlight.sourceTitle, reasons: [...reasons] });
  }
  return { notes: items.length, tasks, warnings };
}
