import type { Card, Highlight } from "./model";
import { lintCard, LINT_LABELS } from "./lint";

export interface CardCheck {
  content: string;
  at: string;
  issues: string[];
}

/** Includes source context: a verdict is not reusable after its evidence changes. */
export function cardContent(card: Card, highlight: Highlight): string {
  return JSON.stringify([card.kind, card.front, card.back, card.text, card.extra,
    highlight.text, highlight.before, highlight.after, highlight.sourcePath]);
}

export function currentCardCheck(card: Card, highlight: Highlight): CardCheck | undefined {
  return card.userCheck?.content === cardContent(card, highlight) ? card.userCheck : undefined;
}

/** Explicit, read-only critique. Never applies the model's proposed rewrite. */
export async function checkCard(
  card: Card,
  highlight: Highlight,
  critique: (highlight: Highlight, cards: Card[], siblings: Card[]) => Promise<Array<{ verdict: string; reason?: string }>>,
  active: () => boolean = () => true,
): Promise<void> {
  delete card.userCheck;
  const content = cardContent(card, highlight);
  const siblings = highlight.cards.filter(c => c.id !== card.id && c.status !== "deleted");
  const { failures, warnings } = lintCard(card, highlight, siblings);
  const [verdict] = await critique({ ...highlight }, [{ ...card }], siblings.map(c => ({ ...c })));
  if (!verdict || !["keep", "revise", "drop"].includes(verdict.verdict)) throw new Error("The check returned no valid verdict.");
  if (!active() || cardContent(card, highlight) !== content || card.status === "deleted" || highlight.status === "dismissed") return;
  const issues = [...failures, ...warnings].map(id => LINT_LABELS[id]);
  if (verdict.verdict !== "keep") issues.push(verdict.reason?.trim() || `The model recommends ${verdict.verdict === "drop" ? "discarding" : "revising"} this card.`);
  card.userCheck = { content, at: new Date().toISOString(), issues };
}

export type ExportItem = { card: Card; highlight: Highlight };

/** Only an explicit export action calls this. Legacy approved cards remain readable. */
export function exportCandidates(list: Highlight[], ids?: ReadonlySet<string>): ExportItem[] {
  const items: ExportItem[] = [];
  for (const highlight of list) {
    if (highlight.status !== "ready") continue;
    for (const card of highlight.cards) {
      if (ids && !ids.has(card.id)) continue;
      if (!["pending", "flagged", "approved"].includes(card.status)) continue;
      if (card.kind === "qa") {
        if (!card.front.trim() || !card.back.trim()) throw new Error("Cannot export an empty question or answer. Edit or delete it first.");
      } else if (card.kind === "cloze") {
        if (!/\{\{c[1-9]\d*::[^{}]+\}\}/.test(card.text) || /\{\{|\}\}/.test(card.text.replace(/\{\{c[1-9]\d*::[^{}]+\}\}/g, ""))) {
          throw new Error("Cannot export a malformed cloze. Add a valid {{c1::answer}} deletion.");
        }
      } else throw new Error("Unsupported card type.");
      items.push({ card, highlight });
    }
  }
  return items;
}

/** Reuse the strict transport gate; acceptance lasts only for this export attempt. */
export async function withExportAcceptance<T>(items: ExportItem[], send: () => Promise<T>): Promise<T> {
  const previous = items.map(({ card }) => card.status);
  for (const { card } of items) card.status = "approved";
  try { return await send(); }
  finally {
    items.forEach(({ card }, i) => {
      if (card.status === "approved") card.status = previous[i];
    });
  }
}
