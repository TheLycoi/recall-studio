import { makeCard, type Card, type CardRevision, type CardSnapshot, type Highlight } from "./model";
import { cardAuthorization, cardReplacement, cardContent, currentCardCheck } from "./cardActions";
import { lintCard, isHardLintFailure, LINT_LABELS } from "./lint";

/** Operational response limit, not a card-writing quota. */
export const MAX_REWRITE_CARDS = 12;
type Draft = Pick<Card, "kind" | "front" | "back" | "text">;
export type RewriteRevision = CardRevision & { replacements?: { cardId: string; after: CardSnapshot }[] };
type RewrittenCard = Card & { rewrite?: { sourceCardId: string; instruction: string; at: string; replacementIds: string[] } };
const snapshot = ({ kind, front, back, text, extra }: Card): CardSnapshot => ({ kind, front, back, text, extra });

/** Explicit writes also depend on saved evidence, receipts and sibling lifecycle. */
export function explicitRewriteAuthorization(card: Card, highlight: Highlight, active: () => boolean): () => boolean {
  const baseline = JSON.stringify(highlight);
  const current = cardAuthorization(card, highlight, active);
  return () => current() && JSON.stringify(highlight) === baseline;
}

/** Validate the entire set before auditing it or changing the original. */
export function rewriteCandidates(card: Card, highlight: Highlight, drafts: Draft[]): Card[] {
  if (!Array.isArray(drafts) || !drafts.length || drafts.length > MAX_REWRITE_CARDS) throw Error("The rewrite must return a bounded, nonempty card list. The original is unchanged.");
  const fork = drafts.length > 1 || card.ankiNoteId !== undefined || card.srNote !== undefined || card.textExport !== undefined;
  const candidates = drafts.map(draft => {
    if (!draft || !["qa", "cloze"].includes(draft.kind) || ![draft.front, draft.back, draft.text].every(v => typeof v === "string" && v.length <= 4000)
      || (draft.kind === "qa" ? !!draft.text || !draft.front.trim() || !draft.back.trim() : !!draft.front || !!draft.back || !draft.text.trim())) {
      throw Error("The rewrite returned malformed card fields. The original is unchanged.");
    }
    const candidate = cardReplacement(card, highlight, draft);
    if (!fork) return candidate;
    return makeCard(highlight.id, { kind: candidate.kind, front: candidate.front, back: candidate.back, text: candidate.text,
      extra: card.extra, edited: true, generation: card.generation ? { ...structuredClone(card.generation),
        audit: { status: "unverified", reason: "Explicit rewrite; original staged audit retained on the source card.", content: "" } } : undefined });
  });
  const siblings = highlight.cards.filter(c => c.id !== card.id && c.status !== "deleted");
  for (const candidate of candidates) {
    const lint = lintCard(candidate, highlight, [...siblings, ...candidates.filter(c => c !== candidate)]);
    const hard = lint.failures.filter(isHardLintFailure);
    if (hard.length) throw Error(`The rewrite did not pass validation. The original is unchanged. ${hard.map(id => LINT_LABELS[id]).join(" · ")}`);
  }
  const contents = candidates.map(c => JSON.stringify([c.kind, c.front, c.back, c.text]));
  if (new Set(contents).size !== contents.length) throw Error("The rewrite repeated a replacement card. The original is unchanged.");
  return candidates;
}

/** Commit in one synchronous step, after independent acceptance of every candidate. */
export function applyExplicitRewrite(card: Card, highlight: Highlight, candidates: Card[], instruction: string): RewriteRevision | undefined {
  if (candidates.length === 1 && cardContent(candidates[0], highlight) === cardContent(card, highlight)) return;
  const at = new Date().toISOString(), before = snapshot(card);
  const fork = candidates.length > 1 || card.ankiNoteId !== undefined || card.srNote !== undefined || card.textExport !== undefined;
  const index = highlight.cards.indexOf(card);
  if (index < 0) throw Error("The original card is no longer present.");
  const replacementHighlight = { ...highlight, cards: [...highlight.cards.slice(0, index), ...candidates, ...highlight.cards.slice(index + 1)] };
  for (const candidate of candidates) {
    candidate.status = "pending";
    candidate.edited = true;
    delete candidate.lintFailures;
    delete candidate.lintWarnings;
    delete candidate.critiqueReason;
    delete candidate.bloom;
    delete candidate.critiqueRan;
    candidate.userCheck = { content: cardContent(candidate, replacementHighlight), at, issues: [] };
  }
  if (fork) {
    const provenance = { sourceCardId: card.id, instruction, at, replacementIds: candidates.map(c => c.id) };
    for (const candidate of candidates) (candidate as RewrittenCard).rewrite = structuredClone(provenance);
    // Retain all original fields, evidence and receipts under their original ID.
    card.status = "deleted";
    highlight.cards.splice(index + 1, 0, ...candidates);
    // A fork is not a one-card shortening or format correction for the preference learner.
    return { cardId: card.id, at, via: "rewrite", instruction, before, after: before,
      replacements: candidates.map(c => ({ cardId: c.id, after: snapshot(c) })) };
  }
  Object.assign(card, candidates[0]);
  for (const key of ["lintFailures", "lintWarnings", "critiqueReason", "bloom", "critiqueRan"] as const) delete card[key];
  card.userCheck = currentCardCheck(candidates[0], highlight);
  return { cardId: card.id, at, via: "rewrite", instruction, before, after: snapshot(card) };
}
