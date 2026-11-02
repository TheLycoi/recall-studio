import { createHash } from "crypto";
import { z } from "zod";
import { cardSystem, CARD_FIELD_DESCRIPTIONS, writingContext } from "./writerMethod";
export { CARD_WRITING_METHOD as RETRIEVAL_QUALITY_RUBRIC } from "./writerMethod";
import { makeCard, makeHighlight, type Card, type GenerationContext, type GenerationPreparation, type GenerationAuditRecord, type ScopedSourceFinding, type Highlight } from "./model";
import { exportCandidates } from "./cardActions";
import { lintCard } from "./lint";
import { AssessmentFields, CheckDecisionOut, ReviewAssessmentOut, renderedCardReviews, validateAssessment } from "./qualityAcceptance";
export { renderedCardReviews } from "./qualityAcceptance";
import type { RecallSettings } from "./settings";

const text = z.string().min(1).max(16000);
const ids = z.array(text).min(1);
const disposition = z.object({ factIds: ids, reason: text });
const sourceConflict = z.object({ quote: text, reason: text, kind: z.preprocess(v => v === undefined ? "legacy" : v, z.enum(["framing", "contradiction", "insufficient", "legacy"])) });
export const ScopedSourceFindingOut = sourceConflict.extend({ id: text, cardId: text, sourceKey: text, content: z.string() });
const reassessment = z.object({ findingId: text, cardId: text, sourceKey: text, content: z.string(), resolution: z.enum(["resolved", "framing", "unresolved"]), quote: text, reason: text });
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
  ...AssessmentFields,
  reassessments: z.preprocess(v => v === undefined ? [] : v, z.array(reassessment)),
  index: z.number().int(), cardId: text, status: z.enum(["verified", "unverified", "failed"]), reason: text,
  // Required on the wire for strict providers; old responses may lack this field.
  conflicts: z.preprocess(v => v === undefined ? [] : v, z.array(sourceConflict)).describe("Source conflicts or insufficient evidence for this card, separate from retrieval defects. Exact captured quotes and reasons; empty when none."),
})) });
export type GenerationAudit = z.infer<typeof AuditOut>;

const auditVerdict = AuditOut.shape.verdicts.element;
const auditSourceEnvelope = auditVerdict.pick({ index: true, cardId: true, conflicts: true });
// Preserve source evidence before transport rejects malformed quality; never turn it into approval.
export const AuditTransportOut = z.object({ verdicts: z.array(z.preprocess(raw => {
  if (auditVerdict.safeParse(raw).success) return raw;
  const source = auditSourceEnvelope.safeParse(raw);
  return source.success ? { ...source.data, contractVersion: 0, reviews: [], checks: [], reassessments: [],
    status: "unverified", reason: "Quality assessment rejected; source findings retained." } : raw;
}, auditVerdict)) });

/** Constrain provider output to this request; strict local validation still checks uniqueness and meaning. */
export function auditOutputSchema(cards: Card[], checks: string[][]): z.ZodType {
  const variants = cards.map((card, index) => {
    const ordinals = renderedCardReviews(card).map(r => r.ordinal);
    const expectedChecks = checks[index] ?? [];
    return auditVerdict.extend({
      index: z.literal(index), cardId: z.literal(card.id), contractVersion: z.literal(1),
      reviews: z.array(ReviewAssessmentOut.extend({ ordinal: z.literal(ordinals.length ? ordinals : [null]) })).length(ordinals.length).describe("One assessment per supplied ordinal, exactly once."),
      checks: z.array(expectedChecks.length ? CheckDecisionOut.extend({ id: z.enum(expectedChecks) }) : CheckDecisionOut).length(expectedChecks.length).describe("Only the supplied deterministic-check IDs, exactly once; empty when none were supplied."),
    });
  });
  return z.object({ verdicts: z.array(variants.length > 1 ? z.union(variants) : variants[0] ?? auditVerdict).length(cards.length) });
}

// Method adapted from planetjc/anki-process-engine-live; see NOTICE.txt.
export const PREPARATION_SYSTEM = cardSystem(`You are the planner, not the writer. Before grouping, restate supported propositions in facts.statement using plain language without changing meaning; keep facts.quote verbatim. Split independently gradable propositions, not by word count; retain necessary relationships and conditions. Select useful supported targets before locking plan rows. Preserve selected targets and basics, not exhaustive permutations. Resolve grouping before exactly one card per row is locked: combine repeated scaffolds, retaining all factIds. A coherent route or closed list can use one row with distinct cloze numbers, not a mandatory row per member. Plan a visible relation label or directed question; aspect alone is not a cue. Independently cued attributes are not one catch-all predicate. Open lists allow example-seeking questions with acceptable alternatives, not arbitrary missing members.
Quote contiguous captured passages character for character, without cleanup or corrections. Facts have unique F1, F2, ... IDs; rows have unique P1, P2, ... IDs and exact factIds, entity, aspect (empty if unnecessary), value and reason. Every inventoried fact needs a plan or exclusions/omissions with IDs and reasons. Keep unsupported targets in facts/conflicts, not the plan. Empty inventory/plan is allowed; ignore legacy maxCards.
Return conflicts with exact captured quotes, reasons and affected factIds: nonempty factIds hold only the affected targets, not unrelated facts; empty factIds hold the whole capture. Set kind to framing for repairable wording of supported targets, contradiction for contradictory evidence, or insufficient for ambiguous/missing evidence. An accidentally exhaustive question over clear open examples is framing if an example cue preserves the selected target. A required complete set with missing evidence stays held; never silently narrow the plan.`);

export const AUDIT_SYSTEM = cardSystem(`Audit every card against captured text for support, selected coverage, exclusions, duplication and retrieval quality; recheck unchanged siblings after repair. Return one verdict per zero-based index AND card ID. Verified means supported without unresolved defects; unverified means uncertain support; source-supported poor retrieval is failed.
Inspect visibleCue first without hiddenTargets, targetContext or plan; one defective review fails the card. For ordinary attribute, mechanism and consequence retrieval, name the specific system using visibleCue, not a grammatical subject or the hidden consequence. For term-identification use visible definition and essential context to distinguish the term; a hidden name alone is not a defect. In the reason quote exact visibleCue words for the identifying cue and requested relation; if missing, fail. Per ordinal name missing subject/conditions, visible answer/echo of the hidden target, or other concrete defects. Separately justified contexts are not duplication. A different true completion fails unless the task explicitly requests examples and accepts supported alternatives.
Return contractVersion 1. reviews must cover every supplied ordinal once (QA null): status, reason, identifyingCue and relationCue quoted from THAT answer-hidden front, answerable and effortful booleans. Verified requires both booleans true and nonempty quotations. checks must cover every supplied ID once with resolution accepted or defect and a concrete reason. Adjudicate length-policy flags by focus and necessary meaning. Only soft flags can be accepted; hard checks remain defects. Overall verified cannot contradict a review or check.
Report findings only: never repair cards, add facts, delete or merge rows. Report conflicts separately with exact captured quotes, reasons and kind: framing for supported-target wording; contradiction or insufficient for source problems. Clear open examples support example cues, not exhaustive sets. Ambiguous negation or missing required completeness stays held. An explicit captured condition can supersede a broad heading for that target, not ambiguous siblings.
For each sourceFinding reassessed, echo its findingId, cardId, sourceKey and content with resolution resolved, framing or unresolved, a concrete reason and exact captured supporting quote. Resolved needs evidence settling that original concern; framing requires repair/recheck. Omitted/unresolved findings stay held. Generic verified and other targets never clear source holds or authorize changing facts.`);

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
  const payloads = new Map<string, string>();
  for (const row of p.plan) {
    if (!/^P[1-9]\d*$/.test(row.id) || plans.has(row.id)) throw new Error("Invalid or duplicate plan ID.");
    plans.add(row.id); check(row.factIds);
    const payload = JSON.stringify([row.factIds, row.entity, row.aspect, row.value, row.reason]);
    if (payloads.has(payload)) throw new Error(`Duplicate plan payload: ${payloads.get(payload)} and ${row.id}.`);
    payloads.set(payload, row.id);
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

export function validateAudit(raw: unknown, cards: Card[], snapshot?: string, legacySnapshot?: string, checks: string[][] = cards.map(() => []), findings: ScopedSourceFinding[] = []): GenerationAudit {
  const audit = AuditOut.parse(raw);
  const seen = new Set<number>();
  for (const v of audit.verdicts) {
    if (seen.has(v.index) || cards[v.index]?.id !== v.cardId) throw new Error("Audit contains an unknown, mismatched or duplicate card verdict.");
    seen.add(v.index);
    validateAssessment(v, cards[v.index], checks[v.index] ?? [], v.status === "verified");
    const resolved = new Set<string>();
    for (const r of v.reassessments) {
      const f = findings.find(f => f.id === r.findingId && f.cardId === v.cardId);
      if (!f || resolved.has(r.findingId) || r.cardId !== f.cardId || r.sourceKey !== f.sourceKey || r.content !== f.content
        || !r.reason.trim() || !r.quote.trim() || !snapshot?.includes(r.quote)) throw Error("Invalid scoped source reassessment identity, content or captured evidence.");
      resolved.add(r.findingId);
    }
    for (const c of v.conflicts ?? []) {
      if (!c.quote.trim() || (!snapshot?.includes(c.quote) && !legacySnapshot?.includes(c.quote))) throw new Error("Audit conflict quote is not in the captured snapshot.");
    }
  }
  return audit;
}

/** A malformed assessment holds its card; ambiguous identities still reject the whole response. */
export function isolateAuditFailures(raw: unknown, cards: Card[], snapshot: string, checks: string[][], findings: ScopedSourceFinding[] = []): GenerationAudit & { rejected: GenerationAudit["verdicts"] } {
  const audit = AuditOut.parse(raw);
  const seen = new Set<number>();
  for (const v of audit.verdicts) {
    if (seen.has(v.index) || cards[v.index]?.id !== v.cardId) throw new Error("Audit contains an unknown, mismatched or duplicate card verdict.");
    seen.add(v.index);
  }
  const rejected: GenerationAudit["verdicts"] = [];
  const verdicts = audit.verdicts.map(v => {
    try { return validateAudit({ verdicts: [v] }, cards, snapshot, undefined, checks, findings).verdicts[0]; }
    catch (e) {
      rejected.push(v);
      const reason = `Audit response rejected: ${e instanceof Error ? e.message : "Invalid assessment."}`;
      // These local placeholders record missing verification, never model approval or source resolution.
      return { ...v, contractVersion: 1, status: "unverified" as const, reason, conflicts: [], reassessments: [],
        reviews: renderedCardReviews(cards[v.index]).map(r => ({ ordinal: r.ordinal, status: "unverified" as const, reason, identifyingCue: "", relationCue: "", answerable: false, effortful: false })),
        checks: (checks[v.index] ?? []).map(id => ({ id, resolution: "defect" as const, reason })) };
    }
  });
  return { verdicts, rejected };
}

/** Legacy unscoped conflicts remain whole-capture holds. */
export function sourceConflictsForCard(p: GenerationPreparation, c: Card): GenerationPreparation["conflicts"] {
  return p.conflicts.filter(issue => issue.kind !== "framing" && (!issue.factIds?.length || issue.factIds.some(id => c.generation?.factIds.includes(id))));
}

/** Stable finding identities preserve history while allowing only explicit scoped resolution. */
export function retainedSourceFindings(p: GenerationPreparation, records: (GenerationAuditRecord | undefined)[], originals: Card[], sourceKey: string): ScopedSourceFinding[] {
  const findings: ScopedSourceFinding[] = [];
  for (const card of originals) {
    const add = (issue: GenerationPreparation["conflicts"][number], content: string, key = sourceKey) => {
      if (issue.kind === "framing") return;
      const id = createHash("sha256").update(JSON.stringify([key, card.id, content, issue.quote, issue.reason, issue.kind ?? "legacy"])).digest("hex");
      if (!findings.some(f => f.id === id)) findings.push({ ...issue, id, cardId: card.id, sourceKey: key, content });
    };
    sourceConflictsForCard(p, card).forEach(c => add(c, cardAuditContent(card)));
    for (const a of records) {
      for (const f of a?.sourceFindings ?? []) if (f.cardId === card.id && f.sourceKey === sourceKey) add(f, f.content);
      const v = a?.verdicts.find(v => v.cardId === card.id && originals[v.index]?.id === card.id);
      for (const c of v?.conflicts ?? []) add(c, a?.contents?.[v!.index] ?? cardAuditContent(card), a?.provenance?.sourceKey ?? sourceKey);
    }
  }
  return findings;
}

/** A malformed quality assessment must not erase independently valid source holds. */
export function sourceFindingsFromResponse(raw: unknown, cards: Card[], snapshot: string, sourceKey: string): ScopedSourceFinding[] {
  const parsed = z.object({ verdicts: z.array(z.object({ index: z.number().int(), cardId: text, conflicts: z.array(sourceConflict) })) }).safeParse(raw);
  if (!parsed.success) return [];
  const verdicts = parsed.data.verdicts.filter(v => cards[v.index]?.id === v.cardId).map(v => ({ ...v,
    status: "unverified" as const, reason: "Quality assessment rejected; source findings retained.",
    conflicts: v.conflicts.filter(c => c.kind !== "framing" && c.quote.trim() && snapshot.includes(c.quote)),
  }));
  return retainedSourceFindings({ facts: [], plan: [], exclusions: [], omissions: [], conflicts: [] },
    [{ status: "unverified", reason: "Source findings only, not approval.", verdicts, contents: cards.map(cardAuditContent) }], cards, sourceKey);
}

export function activeSourceFindings(findings: ScopedSourceFinding[], records: (GenerationAuditRecord | undefined)[], sourceKey: string, snapshot: string): ScopedSourceFinding[] {
  return findings.filter(f => {
    let active = true;
    for (const a of records) {
      if (!a || (a.provenance && a.provenance.sourceKey !== sourceKey)) continue;
      const v = a.verdicts.find(v => v.cardId === f.cardId);
      const resolution = v?.contractVersion === 1 && v.reassessments?.find(r =>
        r.findingId === f.id && r.cardId === f.cardId && r.sourceKey === sourceKey && f.sourceKey === sourceKey
        && r.content === f.content && r.reason.trim() && r.quote.trim() && snapshot.includes(r.quote));
      if (resolution) active = resolution.resolution === "unresolved";
      // A later concern, or contradictory evidence in this same response, reopens the hold.
      if (a.sourceFindings?.some(s => s.id === f.id && s.cardId === f.cardId && s.sourceKey === f.sourceKey)
        || (v && (!a.contents || a.contents[v.index] === f.content) && v.conflicts?.some(c =>
          c.quote === f.quote && c.reason === f.reason && (c.kind ?? "legacy") === (f.kind ?? "legacy")))) active = true;
    }
    return active;
  });
}

export function sourceConcernsForCard(card: Card, h: Highlight): ScopedSourceFinding[] {
  return [h.generation, ...(h.generationHistory ?? [])].flatMap(batch => {
    if (!batch?.preparation) return [];
    const records = [...(batch.auditHistory ?? []), batch.audit, batch.finalAudit];
    const preparation = batch.id === card.generation?.batchId ? batch.preparation : { ...batch.preparation, conflicts: batch.preparation.conflicts.filter(c => !c.factIds?.length) };
    const originals = batch.id === card.generation?.batchId ? batch.drafts ?? [card] : [card];
    return activeSourceFindings(retainedSourceFindings(preparation, records, originals, batch.provenance?.sourceKey ?? generationSourceKey(h)), records, generationSourceKey(h), h.text).filter(f => f.cardId === card.id);
  });
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
