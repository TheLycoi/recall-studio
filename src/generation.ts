import { createHash } from "crypto";
import { z } from "zod";
import { cardSystem, CARD_FIELD_DESCRIPTIONS, writingContext } from "./writerMethod";
export { CARD_WRITING_METHOD as RETRIEVAL_QUALITY_RUBRIC } from "./writerMethod";
import { makeCard, makeHighlight, type Card, type GenerationContext, type GenerationPreparation, type Highlight } from "./model";
import { exportCandidates } from "./cardActions";
import { lintCard, reviewText } from "./lint";
import type { RecallSettings } from "./settings";

const text = z.string().min(1).max(16000);
const ids = z.array(text).min(1);
const disposition = z.object({ factIds: ids, reason: text });
const sourceConflict = z.object({ quote: text, reason: text });
export const GenerationProvenanceOut = z.object({
  build: z.object({ release: text, commit: text.optional() }).optional(),
  sourceKey: z.string().regex(/^[a-f0-9]{64}$/),
  inputKey: z.string().regex(/^(?:[a-f0-9]{64})?$/),
});
export const PreparationOut = z.object({
  facts: z.array(z.object({ id: text, statement: text, quote: text })),
  plan: z.array(z.object({ id: text, factIds: ids.describe("All inventoried fact IDs covered by this coherent group; retain every selected target's link."), entity: text, aspect: z.string(), value: text.describe("The coherent supported targets for one note, using distinct cloze numbers for independently cued targets when appropriate."), reason: text })),
  exclusions: z.array(disposition),
  omissions: z.array(disposition),
  conflicts: z.array(sourceConflict.extend({ factIds: z.preprocess(v => v === undefined ? [] : v, z.array(text)).describe("Affected inventoried fact IDs; an empty array holds the whole capture.") })),
});
export const GroundedCardsOut = z.object({ cards: z.array(z.object({
  planId: text,
  factIds: ids,
  kind: z.enum(["qa", "cloze"]).describe(CARD_FIELD_DESCRIPTIONS.kind),
  front: z.string().describe(CARD_FIELD_DESCRIPTIONS.front),
  back: z.string().describe(CARD_FIELD_DESCRIPTIONS.back),
  text: z.string().describe(CARD_FIELD_DESCRIPTIONS.text),
})) });
export type GroundedDraft = z.infer<typeof GroundedCardsOut>["cards"][number];
export const AuditOut = z.object({ verdicts: z.array(z.object({
  index: z.number().int(), cardId: text, status: z.enum(["verified", "unverified", "failed"]), reason: text,
  // Required on the wire for strict providers; old responses may lack this field.
  conflicts: z.preprocess(v => v === undefined ? [] : v, z.array(sourceConflict)).describe("Source conflicts or insufficient evidence for this card, separate from retrieval defects. Exact captured quotes and reasons; empty when none."),
})) });
export type GenerationAudit = z.infer<typeof AuditOut>;

// Method adapted from planetjc/anki-process-engine-live; see NOTICE.txt.
export const PREPARATION_SYSTEM = cardSystem(`You are the planner. Prepare a quoted fact inventory and card plan; do not write cards. Select useful retrieval targets before locking plan rows: preserve selected targets and useful basics, not exhaustive permutations, and account for material exclusions/omissions with reasons. Apply the partial-recall test: independently gradable parts need distinct reviews, including each selected member of a complete bounded list. Plan selected member coverage in stable display order, separating original members and later additions; aim for two to three useful distinct cloze numbers per note, not a quota. Before locking plan rows, group source-supported targets from the same coherent sentence or context into one row with distinct numbers when each rendered review has an identifying cue and requested relation; retain all selected targets and their factIds. Before locking, check for near-identical sentence scaffolds differing only in the hidden span and combine those planned targets rather than emitting duplicate sentence rows. Separately justified contexts may need separate rows; do not group unrelated claims or cross-source notes, and do not merge existing cards. One useful deletion remains valid; coherent notes may exceed three without filler or unsupported targets. A coherent route or closed list may use one row with distinct cloze numbers, not a mandatory row per member; use source-driven grouping, not a note-count quota. Prefer a source-supported term-definition pair in one row with different cloze numbers only when both rendered visible cues distinguish the intended answer; otherwise plan only supported focused directions. Do not invent definitions or semantic order. Hold arbitrary open or underspecified missing-member targets, but allow explicitly example-seeking questions with acceptable alternatives supported by the capture. Quote contiguous captured passages character for character without cleanup, ellipses or corrections. Facts have unique F1, F2, ... IDs; rows have unique P1, P2, ... IDs and exact factIds, entity, aspect (empty if unnecessary), value and inclusion reason. The writer must produce exactly one card per row: choose focused groups and complete coverage now, ignoring legacy maxCards. Plan classification, release site and release pathway as independently cued targets, not one catch-all predicate; use separate rows or distinct clearly cued cloze numbers in a coherent note. Name each requested attribute in aspect, and keep its relation visible when the writer hides the answer. Plan a visible relation label or directed question for each target; aspect alone is not a cue. For transitions, keep the starting state and condition visible and retrieve the destination rather than the entire relation. Preserve meaningful causal explanations and short procedures as focused targets rather than splitting them by word count. Every inventoried fact needs a plan or an exclusion/omission with IDs and reasons. Use dispositions for unsupported or weak targets instead of planning them; keep their quotes in facts/conflicts. Return conflicts with exact quotes, reasons and affected factIds; nonempty factIds hold only the affected targets, not unrelated facts; empty factIds hold the whole capture. An empty inventory/plan is allowed.`);

export const AUDIT_SYSTEM = cardSystem(`You are the independent auditor. Audit every drafted card against the captured text, not merely its inventory or plan. A matching quote is not proof of the authored claim. Check support, fluency, coverage, exclusions, duplication and retrieval quality. Flag avoidable split-note duplication: near-identical sentence/context notes differing only in the hidden span belong in one planned note with distinct reviews. Cite the overlapping scaffold and affected targets, and fail the affected cards even when the plan split them. Separately justified contexts are not avoidable duplication. Unresolved grouping stays held under the locked row/candidate cardinality; never drop a row or fact, silently merge records or waive findings to combine notes. Return exactly one verdict per card using BOTH its exact zero-based index and card ID: verified requires complete source support and no unresolved issue; unverified means support cannot be established; failed means a conflict, unsupported claim or other defect. A source-supported card with poor retrieval quality is failed. Neither a matching plan nor clean lint establishes quality. Inspect every supplied rendered review; one defective review fails the card. Apply the partial-recall test to hiddenTargets: if parts could be separately correct and incorrect, fail and name those independent parts. One ordinal or named topic is not proof of atomicity. A complete bounded list must hide one member per review with the remaining members visible, not the whole set or several members across same-number spans. Preserve planned coverage within the selected targets and distinguish originals from later additions; open examples do not establish a fixed set. Accept clearly example-seeking questions with acceptable alternatives supported by the capture; do not fail them merely because more than one example is valid. Read visibleCue first, without borrowing specificity from hiddenTargets, targetContext or the plan. For ordinary attribute, mechanism and consequence reviews, name the specific system and cite its identifying visibleCue words, not just a grammatical subject such as negative feedback or a system inferred from the hidden consequence. If the visible cue does not identify that system, fail the card even when the capture or plan names it. For term-identification reviews, the visible definition or identifying relation and essential context must distinguish the hidden term; do not fail a valid review solely because its name is hidden. For each ordinal, identify the requested attribute, relation or process and the essential conditions; a bare topic, generic predicate or vague hint fails even if its hidden answer describes a specific source-supported relationship. In the reason, for each ordinal quote the exact visibleCue words for the identifying cue and requested relation: the visible subject for ordinary reviews, or the distinguishing definition/identifying relation and context for term identification; if either quote is missing, fail. An aspect, targetContext label or hidden answer is not visible evidence, and a condition alone does not identify a transition. Ask whether a knowledgeable learner could give a different true completion because the visible retrieval task is unspecified, unless the question explicitly requests examples and accepts supported alternatives. Name the affected ordinal and missing subject/conditions or relation, or concrete visible answer/echo revealing the hidden target. Report findings only: never repair cards, add facts or delete cards. Report source conflicts or insufficient evidence separately in conflicts with exact captured quotes and reasons, empty when none. A source hold cannot be waived by a positive quality verdict and never permits changing the fact.`);

/** Only saved legacy stages may also use their former readable snapshot for quotes. */
export function validatePreparation(raw: unknown, snapshot: string, _legacyMaxCards?: number, legacySnapshot?: string): GenerationPreparation {
  const p = PreparationOut.parse(raw);
  const facts = new Set<string>();
  for (const f of p.facts) {
    if (!/^F[1-9]\d*$/.test(f.id) || facts.has(f.id)) throw new Error("Invalid or duplicate fact ID.");
    if (!f.quote.trim() || (!snapshot.includes(f.quote) && !legacySnapshot?.includes(f.quote))) throw new Error(`Fact ${f.id} quote is not in the captured snapshot.`);
    facts.add(f.id);
  }
  const covered = new Set<string>();
  const check = (refs: string[]) => {
    if (new Set(refs).size !== refs.length || refs.some(id => !facts.has(id))) throw new Error("Unknown or duplicate fact reference.");
    refs.forEach(id => covered.add(id));
  };
  const plans = new Set<string>();

  for (const row of p.plan) {
    if (!/^P[1-9]\d*$/.test(row.id) || plans.has(row.id)) throw new Error("Invalid or duplicate plan ID.");
    plans.add(row.id); check(row.factIds);
  }
  for (const row of [...p.exclusions, ...p.omissions]) {
    if (row.factIds.some(id => covered.has(id))) throw new Error("A fact is both planned and excluded/omitted, or has conflicting dispositions.");
    check(row.factIds);
  }
  if ([...facts].some(id => !covered.has(id))) throw new Error("Inventory has an undisposed fact.");
  for (const c of p.conflicts) {
    if (!c.quote.trim() || (!snapshot.includes(c.quote) && !legacySnapshot?.includes(c.quote))) throw new Error("Conflict quote is not in the captured snapshot.");
    if (c.factIds && (new Set(c.factIds).size !== c.factIds.length || c.factIds.some(id => !facts.has(id)))) throw new Error("Unknown or duplicate conflict fact reference.");
  }
  return p;
}

export function validateDrafts(raw: unknown, p: GenerationPreparation, _legacyMaxCards?: number): GroundedDraft[] {
  const drafts = GroundedCardsOut.parse(raw).cards;

  const used = new Set<string>();
  for (const d of drafts) {
    const row = p.plan.find(row => row.id === d.planId);
    if (!row || used.has(d.planId)) throw new Error("Unknown or repeated card plan reference.");
    used.add(d.planId);
    if (new Set(d.factIds).size !== d.factIds.length || d.factIds.length !== row.factIds.length || d.factIds.some(id => !row.factIds.includes(id))) throw new Error("Card fact links do not match its plan.");
    if (d.kind === "qa") {
      d.front = d.front.trim();
      d.back = d.back.trim();
      d.text = "";
    } else {
      d.text = d.text.trim();
      d.front = "";
      d.back = "";
    }
    if (d.kind === "qa" ? !d.front || !d.back : !d.text) throw new Error("Malformed card fields.");
    if (d.kind === "cloze") {
      // Reuse export syntax and empty-answer checks, not lint's style limits.
      const card = makeCard("", d);
      const highlight = makeHighlight({ sourcePath: "", sourceTitle: "", text: "", status: "ready", cards: [card] });
      exportCandidates([highlight]);
      if (/\{\{\{|\}\}\}/.test(d.text) || lintCard(card, highlight, []).failures.includes("qa-empty")) throw new Error("Malformed cloze or empty deletion.");
    }
  }
  if (used.size !== p.plan.length) throw new Error("Writer omitted a planned card.");
  return drafts;
}

export function validateAudit(raw: unknown, cards: Card[], snapshot?: string, legacySnapshot?: string): GenerationAudit {
  const audit = AuditOut.parse(raw);
  const seen = new Set<number>();
  for (const v of audit.verdicts) {
    if (seen.has(v.index) || cards[v.index]?.id !== v.cardId) throw new Error("Audit contains an unknown, mismatched or duplicate card verdict.");
    seen.add(v.index);
    for (const c of v.conflicts ?? []) {
      if (!c.quote.trim() || (!snapshot?.includes(c.quote) && !legacySnapshot?.includes(c.quote))) throw new Error("Audit conflict quote is not in the captured snapshot.");
    }
  }
  return audit;
}

/** Legacy unscoped conflicts remain whole-capture holds. */
export function sourceConflictsForCard(p: GenerationPreparation, c: Card): GenerationPreparation["conflicts"] {
  return p.conflicts.filter(issue => !issue.factIds?.length || issue.factIds.some(id => c.generation?.factIds.includes(id)));
}

/** Render the same numbered spans and inline formatting used by the leak linter. */
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

export function cardAuditContent(c: Card): string {
  return JSON.stringify([c.kind, c.front, c.back, c.text]);
}

export function generationSource(h: Highlight): string {
  return JSON.stringify([h.sourcePath, h.sourceTitle, h.text, h.before, h.after, h.heading, h.line, h.page, h.blockId, h.subpath, h.instruction]);
}

/** Hash inputs, never persist credentials or the house rules as another database. */
export function generationKey(h: Highlight, context: GenerationContext, settings: RecallSettings, batchId: string): string {
  const provider = settings.provider;
  const routing = provider === "deepseek" ? [settings.deepseekModel, settings.deepseekApiKey] : provider === "opencode" ? [settings.opencodeModel, settings.opencodePath] : [settings.codexModel, settings.codexPath];
  return createHash("sha256").update(JSON.stringify({ version: 2, source: generationSource(h), instruction: h.generation?.instruction ?? "", context: writingContext(context), provider, routing, effort: settings.effort, audit: settings.critiquePass, lint: settings.lintMode, language: settings.language,
    existing: h.cards.filter(c => c.generation?.batchId !== batchId).map(c => [c.id, cardAuditContent(c), c.extra, c.status]),
  })).digest("hex");
}

export function generationSourceKey(h: Highlight): string {
  return createHash("sha256").update(generationSource(h)).digest("hex");
}

export function cardAuditLabel(c: Card, h?: Highlight): string {
  if (!c.generation) return "Audit unverified (no staged audit)";
  const a = c.generation.audit;
  if (h && a.sourceKey !== generationSourceKey(h)) return "Audit unverified (capture changed)";
  if (a.content !== cardAuditContent(c)) return "Audit unverified (card changed)";
  return a.status === "verified" ? "Audit verified against captured source" : a.status === "failed" ? "Audit failed; human review needed" : "Audit unverified";
}
