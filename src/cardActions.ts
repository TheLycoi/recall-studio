import type { Card, Highlight } from "./model";
import { lintCard, LINT_LABELS, LINT_FIX_INSTRUCTIONS } from "./lint";

export interface CardCheck {
  content: string;
  at: string;
  issues: string[];
}

/** Includes source context: a verdict is not reusable after its evidence changes. */
export function cardContent(card: Card, highlight: Highlight): string {
  return JSON.stringify([card.kind, card.front, card.back, card.text, card.extra,
    highlight.text, highlight.before, highlight.after, highlight.sourcePath,
    highlight.sourceTitle, highlight.heading, highlight.instruction,
    highlight.cards.filter(c => c.id !== card.id && c.status !== "deleted")
      .map(c => [c.id, c.kind, c.front, c.back, c.text])]);
}

export function currentCardCheck(card: Card, highlight: Highlight): CardCheck | undefined {
  return card.userCheck?.content === cardContent(card, highlight) ? card.userCheck : undefined;
}

/** Authorization is tied to the wording and lifecycle the reader acted on. */
export function cardAuthorization(card: Card, highlight: Highlight, active: () => boolean = () => true): () => boolean {
  const content = cardContent(card, highlight);
  const status = card.status;
  return () => active() && cardContent(card, highlight) === content && card.status === status
    && ["pending", "flagged", "approved"].includes(card.status)
    && highlight.status === "ready" && !highlight.archived;
}

/** Explicit, read-only critique. Never applies the model's proposed rewrite. */
export async function checkCard(
  card: Card,
  highlight: Highlight,
  critique: (highlight: Highlight, cards: Card[], siblings: Card[], authorized: () => boolean) => Promise<Array<{ verdict: string; reason?: string }>>,
  active: () => boolean = () => true,
): Promise<void> {
  delete card.userCheck;
  const content = cardContent(card, highlight);
  const current = cardAuthorization(card, highlight, active);
  if (!current()) return;
  const siblings = highlight.cards.filter(c => c.id !== card.id && c.status !== "deleted");
  const { failures, warnings } = lintCard(card, highlight, siblings);
  const verdicts = await critique(structuredClone(highlight), [structuredClone(card)], structuredClone(siblings), current);
  if (!current()) return;
  const verdict = verdicts[0];
  if (verdicts.length !== 1 || !verdict || !["keep", "revise", "drop"].includes(verdict.verdict)) throw new Error("The check must return exactly one valid verdict.");
  const issues = [...failures, ...warnings].map(id => LINT_LABELS[id]);
  if (verdict.verdict !== "keep") issues.push(verdict.reason?.trim() || `The model recommends ${verdict.verdict === "drop" ? "discarding" : "revising"} this card.`);
  card.userCheck = { content, at: new Date().toISOString(), issues };
}

type RepairDraft = Pick<Card, "kind" | "front" | "back" | "text">;

/** Validate a replacement before any of its fields reach the original. */
export function cardReplacement(card: Card, highlight: Highlight, draft: RepairDraft): Card {
  const candidate: Card = { ...structuredClone(card), kind: draft.kind,
    front: draft.kind === "qa" ? draft.front.trim() : "",
    back: draft.kind === "qa" ? draft.back.trim() : "",
    text: draft.kind === "cloze" ? draft.text.trim() : "" };
  exportCandidates([{ ...highlight, cards: [candidate] }]);
  const { failures } = lintCard(candidate, highlight, []);
  if (failures.includes("qa-empty")) throw new Error("The replacement is empty. The original is unchanged.");
  if (failures.includes("cloze-not-grounded")) {
    throw new Error("The replacement hides text absent from the captured source. The original is unchanged.");
  }
  return candidate;
}

type Critique = Parameters<typeof checkCard>[2];
export type CardRepairResult = { status: "checked" | "repaired" | "cancelled" | "busy"; instruction?: string };
const repairing = new WeakSet<Card>();

/** Share the per-card lock between explicit rewrites and automatic repairs. */
export function beginCardRewrite(card: Card): (() => void) | undefined {
  if (repairing.has(card)) return;
  repairing.add(card);
  return () => repairing.delete(card);
}

/** One explicit repair attempt. The original survives until the replacement passes. */
export async function checkAndRepairCard(
  card: Card,
  highlight: Highlight,
  critique: Critique,
  rewrite: (highlight: Highlight, card: Card, instruction: string, authorized: () => boolean) => Promise<RepairDraft>,
  active: () => boolean = () => true,
): Promise<CardRepairResult> {
  const release = beginCardRewrite(card);
  if (!release) return { status: "busy" };
  const content = cardContent(card, highlight);
  const current = cardAuthorization(card, highlight, active);
  try {
    if (!current()) return { status: "cancelled" };
    if (!currentCardCheck(card, highlight)?.issues.length) await checkCard(card, highlight, critique, current);
    if (!current()) return { status: "cancelled" };
    const check = currentCardCheck(card, highlight);
    if (!check) return { status: "cancelled" };
    if (!check.issues.length) return { status: "checked" };
    const siblings = highlight.cards.filter(c => c.id !== card.id && c.status !== "deleted");
    const { failures, warnings } = lintCard(card, highlight, siblings);
    const findings = [...failures, ...warnings].map(id => LINT_FIX_INSTRUCTIONS[id]).concat(check.issues);
    const instruction = `Repair this card using the source and card-writing best practices. Fix these findings:\n${findings.map(issue => `- ${issue}`).join("\n")}\nKeep only supported facts, avoid repeating sibling cards, and preserve a clear retrieval cue. Return one corrected card, not a critique.`;
    const draft = await rewrite(structuredClone(highlight), structuredClone(card), instruction, current);
    if (!current()) return { status: "cancelled" };
    const candidate = cardReplacement(card, highlight, draft);

    if (cardContent(candidate, highlight) === content) throw new Error("The repair returned the same card. The original is unchanged.");
    await checkCard(candidate, highlight, critique, current);
    if (!current()) return { status: "cancelled" };
    const checked = currentCardCheck(candidate, highlight);
    if (!checked || checked.issues.length) throw new Error(`The replacement did not pass its check. The original is unchanged.${checked?.issues.length ? ` ${checked.issues.join(" · ")}` : ""}`);
    card.kind = candidate.kind;
    card.front = candidate.front;
    card.back = candidate.back;
    card.text = candidate.text;
    card.edited = true;
    card.status = "pending";
    delete card.lintFailures;
    delete card.lintWarnings;
    delete card.critiqueReason;
    delete card.bloom;
    delete card.critiqueRan;
    card.userCheck = checked;
    return { status: "repaired", instruction };
  } catch (error) {
    if (!current()) return { status: "cancelled" };
    throw error;
  } finally {
    release();
  }
}

export type ExportItem = { card: Card; highlight: Highlight };

/** Only an explicit export action calls this. Legacy approved cards remain readable. */
export function exportCandidates(list: Highlight[], ids?: ReadonlySet<string>): ExportItem[] {
  const items: ExportItem[] = [];
  for (const highlight of list) {
    if (highlight.archived || highlight.status !== "ready") continue;
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
