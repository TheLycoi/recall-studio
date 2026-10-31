import { z } from "zod";
import type { Card, Highlight, QualityAcceptance } from "./model";
import { isHardLintFailure, lintCard, reviewText } from "./lint";
import { WRITING_METHOD_ID } from "./writerMethod";

export const ReviewAssessmentOut = z.object({
  ordinal: z.number().int().nullable(), status: z.enum(["verified", "unverified", "failed"]), reason: z.string().min(1),
  identifyingCue: z.string(), relationCue: z.string(), answerable: z.boolean(), effortful: z.boolean(),
});
export const CheckDecisionOut = z.object({ id: z.string().min(1), resolution: z.enum(["accepted", "defect"]), reason: z.string().min(1) });
export const AssessmentFields = {
  // Preprocessing retains legacy readability, never legacy approval. Fields remain required on the wire.
  contractVersion: z.preprocess(v => v === undefined ? 0 : v, z.number().int()),
  reviews: z.preprocess(v => v === undefined ? [] : v, z.array(ReviewAssessmentOut)),
  checks: z.preprocess(v => v === undefined ? [] : v, z.array(CheckDecisionOut)),
};
export const QualityAcceptanceOut = z.object({ version: z.literal(1), method: z.string(), content: z.string(), at: z.string(), accepted: z.array(z.object({ id: z.string(), reason: z.string().min(1) })) });

export type ReviewAssessment = z.infer<typeof ReviewAssessmentOut>;
export type CheckDecision = z.infer<typeof CheckDecisionOut>;

/** The answer-hidden front, including one review for repeated same-number spans. */
export function renderedCardReviews(c: Card): { ordinal: number | null; visibleCue: string; hiddenTargets: string[] }[] {
  if (c.kind === "qa") return [{ ordinal: null, visibleCue: reviewText(c.front), hiddenTargets: [reviewText(c.back)] }];
  const rendered = reviewText(c.text);
  const spans = [...rendered.matchAll(/\{\{c(\d+)::([\s\S]*?)(?:::([^}]*))?\}\}/g)];
  return [...new Set(spans.map(m => Number(m[1])))].sort((a, b) => a - b).map(ordinal => ({
    ordinal,
    visibleCue: rendered.replace(/\{\{c(\d+)::([\s\S]*?)(?:::([^}]*))?\}\}/g, (_, n, body, hint) => Number(n) === ordinal ? `[${hint || "..."}]` : body),
    hiddenTargets: spans.filter(m => Number(m[1]) === ordinal).map(m => m[2]),
  }));
}

function isHardCheck(id: string): boolean {
  return !["duplicate-card", "shared-answer", "cross-interference"].includes(id) && isHardLintFailure(id as Parameters<typeof isHardLintFailure>[0]);
}

export function cardChecks(card: Card, h: Highlight, siblings: Card[]): string[] {
  const lint = lintCard(card, h, siblings);
  return [...new Set([...lint.failures, ...lint.warnings])];
}

/** Validate coverage independently of a model's top-level positive assertion. */
export function validateAssessment(v: { contractVersion: number; reviews: ReviewAssessment[]; checks: CheckDecision[] }, card: Card, checks: string[], positive: boolean): void {
  if (v.contractVersion !== 1) throw Error("Incomplete legacy audit contract; a fresh independent check is required.");
  const fronts = renderedCardReviews(card);
  if (!fronts.length || v.reviews.length !== fronts.length || new Set(v.reviews.map(r => r.ordinal)).size !== fronts.length) throw Error("Audit requires exact rendered-review coverage.");
  for (const r of v.reviews) {
    const front = fronts.find(f => f.ordinal === r.ordinal);
    if (!front) throw Error("Audit contains an unknown review ordinal.");
    for (const quote of [r.identifyingCue, r.relationCue]) {
      if ((r.status === "verified" && !quote.trim()) || (quote && !front.visibleCue.includes(quote))) throw Error("Audit cue quotation is absent from that answer-hidden front.");
    }
    if ((r.status === "verified" && (!r.answerable || !r.effortful)) || (positive && r.status !== "verified")) throw Error("Overall audit contradicts a rendered review.");
  }
  if (v.checks.length !== checks.length || new Set(v.checks.map(c => c.id)).size !== checks.length || v.checks.some(c => !checks.includes(c.id))) throw Error("Audit requires the exact complete deterministic-check ID set.");
  if (v.checks.some(c => (c.resolution === "accepted" && isHardCheck(c.id)) || (positive && c.resolution !== "accepted"))) throw Error("Hard checks cannot be waived or unresolved checks approved.");
}

/** Exact current evidence, siblings and method, not a general quality certificate. */
export function acceptanceContent(card: Card, h: Highlight): string {
  return JSON.stringify([WRITING_METHOD_ID, card.kind, card.front, card.back, card.text, card.extra,
    h.text, h.before, h.after, h.sourcePath, h.sourceTitle, h.heading, h.instruction, h.line, h.page, h.blockId, h.subpath,
    h.cards.filter(c => c.id !== card.id && c.status !== "deleted").map(c => [c.id, c.kind, c.front, c.back, c.text, c.extra])]);
}

export function currentQualityAcceptance(card: Card, h: Highlight): QualityAcceptance | undefined {
  const a = card.qualityAcceptance;
  return a?.version === 1 && a.method === WRITING_METHOD_ID && a.content === acceptanceContent(card, h)
    && !card.critiqueReason && !(card.userCheck?.content === a.content && card.userCheck?.issues.length) ? a : undefined;
}

export function recordQualityAcceptance(card: Card, h: Highlight, checks: CheckDecision[]): void {
  card.qualityAcceptance = { version: 1, method: WRITING_METHOD_ID, content: acceptanceContent(card, h), at: new Date().toISOString(),
    accepted: checks.filter(c => c.resolution === "accepted" && !isHardCheck(c.id)).map(c => ({ id: c.id, reason: c.reason })) };
}

export function unacceptedChecks(card: Card, h: Highlight, checks: string[]): string[] {
  const accepted = currentQualityAcceptance(card, h)?.accepted ?? [];
  return checks.filter(id => isHardCheck(id) || !accepted.some(c => c.id === id));
}
