import { MAX_REWRITE_CARDS, rewriteCandidates } from "./explicitRewrite";
import { lintCard } from "./lint";
import { AssessmentFields, cardChecks } from "./qualityAcceptance";
import { z } from "zod";
import { assertAuthorized } from "./backend";
import type { CompletionRequest, LlmBackend } from "./backend";
import { agentRoute } from "./modelRoles";
import { CodexBackend, CodexError } from "./codex";
import { DeepSeekBackend } from "./deepseek";
import { OpenCodeBackend, OpenCodeError } from "./opencode";
import { DeepSeekError } from "./deepseekError";
import { sanitizeDiagnostic } from "./providerDiagnostic";
import { writingContext, cardSystem, CARD_FIELD_DESCRIPTIONS, GROUNDED_WRITING_EXAMPLE } from "./writerMethod";
import { LINT_FIX_INSTRUCTIONS } from "./lint";
import type { BloomLevel, Card, Highlight, GenerationContext, GenerationPreparation, ScopedSourceFinding } from "./model";
import { PreparationOut, GroundedCardsOut, AuditTransportOut, auditOutputSchema, PREPARATION_SYSTEM, AUDIT_SYSTEM, renderedCardReviews, type GroundedDraft, type GenerationAudit } from "./generation";
import type { RecallSettings } from "./settings";

const CardOut = z.object({
  kind: z.enum(["qa", "cloze"]).describe(CARD_FIELD_DESCRIPTIONS.kind),
  front: z
    .string()
    .describe(CARD_FIELD_DESCRIPTIONS.front),
  back: z.string().describe(CARD_FIELD_DESCRIPTIONS.back),
  text: z
    .string()
    .describe(CARD_FIELD_DESCRIPTIONS.text),
});
const CardsOut = z.object({ cards: z.array(CardOut) });
const RewriteCardOut = CardOut.extend({
  front: CardOut.shape.front.max(4000), back: CardOut.shape.back.max(4000), text: CardOut.shape.text.max(4000),
});
const RewriteCardsOut = z.object({ cards: z.array(RewriteCardOut).min(1).max(MAX_REWRITE_CARDS) });
const RewriteAuditOut = z.object({
  preservesFacts: z.boolean().describe("True only when the replacement set retains every supported fact tested by the original, with its conditions and relationships."),
  reason: z.string(),
  verdicts: z.array(z.object({ index: z.number().int(), verdict: z.enum(["keep", "revise", "drop"]), reason: z.string() })).max(MAX_REWRITE_CARDS),
});

export type CardDraft = z.infer<typeof CardOut>;

/**
 * One verdict per drafted card, from the critique pass.
 *
 * Flat and strict on purpose: the Codex backend writes this schema to
 * `--output-schema` (`toStrictSchema` in src/codex.ts), which runs strict
 * with required object fields. Card variants retain flat sentinels, so `front`/`back`/`text` are
 * sentinel empty strings rather than optionals, exactly as `CardOut` above
 * does it.
 *
 * The `bloom` members must stay identical to `BloomLevel` in src/model.ts;
 * `bloomLevelsInSync` below is the compile-time guard on that.
 */
const VerdictOut = z.object({
  ...AssessmentFields,
  index: z.number().int().describe("0-based index of the card being judged, as numbered in the list."),
  verdict: z
    .enum(["keep", "revise", "drop"])
    .describe("keep: use the card as drafted. revise: replace it with the fields below. drop: flag it for the reader."),
  reason: z.string().describe("One sentence, written to the reader, saying what is wrong with this card."),
  bloom: z
    .enum(["remember", "understand", "apply", "analyze", "evaluate", "create"])
    .describe("Bloom's level this card actually sits at, reported for every verdict."),
  kind: z.enum(["qa", "cloze"]).describe("The revised card's kind; echo the original's kind for keep and drop."),
  front: z.string().describe("revise + qa only: the corrected question. Empty string otherwise."),
  back: z.string().describe("revise + qa only: the corrected answer. Empty string otherwise."),
  text: z.string().describe("revise + cloze only: the corrected sentence with {{c1::...}} deletions. Empty string otherwise."),
});
const VerdictsOut = z.object({ verdicts: z.array(VerdictOut) });

export type CritiqueVerdict = z.infer<typeof VerdictOut>;

/**
 * Compile-time guard: assignable both ways, so adding, removing or renaming a
 * member on either side is a type error here rather than a silent drift
 * between what the critique returns and what `Card.bloom` can hold.
 */
type BloomInSync = CritiqueVerdict["bloom"] extends BloomLevel
  ? BloomLevel extends CritiqueVerdict["bloom"]
    ? true
    : never
  : never;
const bloomLevelsInSync: BloomInSync = true;
void bloomLevelsInSync;

function cardData(c: Card) {
  return { id: c.id, kind: c.kind, front: c.front, back: c.back, text: c.text };
}

const WRITER_SYSTEM = cardSystem("You are the writer. Write source-grounded flashcards for explicit human review before Anki export. Follow the supplied task and preserve any locked plan's coverage; do not approve your own output.");

const CRITIC_SYSTEM = cardSystem(`You are the independent checker for the supplied cards, not their writer. Judge grounding and retrieval quality, including siblings and existing duplicates. Report the Bloom level actually supported, not a higher level the capture cannot supply. When verdict fields request a revision, only a source-supported wording repair is allowed: keep/drop echo kind and leave front/back/text empty; revise returns the whole corrected variant with its unused fields empty. Drop flags the card for human review, never deletes it. Give a concrete reader-facing reason and exactly one verdict per supplied index. When the task asks for findings only, do not write or repair cards.
Assess the ORIGINAL supplied card, not a proposed revision. Return contractVersion 1 and reviews covering every supplied ordinal exactly once (QA null), each with status, reason, identifyingCue and relationCue quoted from that answer-hidden visibleCue, and answerable/effortful booleans. Verified requires both booleans and actual nonempty cue quotations. Return checks covering every supplied ID once, with resolution accepted or defect and a concrete reason. Only soft findings can be accepted; hard checks remain defects. Keep requires all rendered reviews verified and all checks accepted. Revise/drop must still supply complete findings, using empty cue quotations for missing cues rather than inventing them.`);

const EXPLICIT_REWRITE_SCOPE = "\nAn explicit user request to split overrides the default grouping preference: produce separate note records, not just extra cloze numbers in one note. Keep a self-contained supported cue in every note and restart cloze numbering at c1 in each note. Do not add unsupported categories or explanations to distinguish the cards. Shared condition words alone are not an answer leak; judge the complete hidden target in its visible cue. Source, coverage and retrieval-quality requirements still apply.";

/**
 * Prompts and schemas live here. The backend for the chosen provider — the
 * Codex CLI, the DeepSeek API, or the opencode CLI — does the call.
 */
export class LlmClient {
  private codex: CodexBackend;
  private deepseek: DeepSeekBackend;
  private opencode: OpenCodeBackend;
  private epoch = 0;

  /** Legacy callbacks remain accepted for older callers, but are never read. */
  constructor(
    private getSettings: () => RecallSettings,
    _getHighlights: () => Highlight[] = () => [],
    _getSchema: () => Promise<{ cards: string } | null> = async () => ({ cards: "" }),
  ) {
    this.codex = new CodexBackend(getSettings);
    this.deepseek = new DeepSeekBackend(getSettings);
    this.opencode = new OpenCodeBackend(getSettings);
  }

  /**
   * The provider chosen in settings, read per request so switching providers
   * in the settings tab takes effect immediately, with no reload.
   */
  private backend(): LlmBackend {
    const provider = this.getSettings().provider;
    if (provider === "deepseek") return this.deepseek;
    if (provider === "opencode") return this.opencode;
    return this.codex;
  }

  private complete<T>(role: "strong" | "cheap", request: CompletionRequest<T>): Promise<T> {
    return this.backend().complete({ ...request, ...agentRoute(this.getSettings(), role) });
  }

  /** One tiny request, so the settings tab can say whether the provider works. */
  probe(model?: string): Promise<{ model: string; via: string }> {
    return this.backend().probe(model);
  }

  /** The models the active provider offers, for the settings dropdown. */
  listModels(): Promise<string[]> {
    return this.backend().listModels();
  }

  /** Cancel in-flight work (plugin unload). */
  async abort(): Promise<void> {
    this.epoch++;
    // All of them, not just the active one: the provider may have been switched
    // while a request was in flight, and both CLI backends have child processes
    // to kill.
    await Promise.all([this.codex.abort(), this.deepseek.abort(), this.opencode.abort()]);
  }

  /** Capture lifecycle authorization before asynchronous UI or prompt preparation. */
  requestAuthorization(authorized?: () => boolean): () => boolean {
    const epoch = this.epoch;
    return () => epoch === this.epoch && (!authorized || authorized());
  }

  /** Capture prompt-dependent inputs once for a bounded generation batch. */
  async generationContext(_excludeBatchId?: string): Promise<GenerationContext> {
    return writingContext(this.getSettings());
  }

  async prepareGeneration(h: Highlight, existing: Card[], context: GenerationContext, authorized?: () => boolean, capturedOriginal = h.text): Promise<GenerationPreparation> {
    const authorization = { authorized: this.requestAuthorization(authorized) };
    assertAuthorized(authorization);
    const safeContext = writingContext(context);
    const result = await this.complete("strong", {
      ...authorization,
      system: PREPARATION_SYSTEM,
      user: JSON.stringify({ captured: h.text, sourceTitle: h.sourceTitle, heading: h.heading, contextBefore: h.before, contextAfter: h.after, instruction: h.instruction, ...safeContext, capturedOriginal, existing }),
      schema: PreparationOut, label: "preparation", maxTokens: 8000, retryInvalidResponse: false,
    });
    assertAuthorized(authorization);
    return result;
  }

  async writeGroundedCards(h: Highlight, existing: Card[], preparation: GenerationPreparation, context: GenerationContext, authorized?: () => boolean): Promise<GroundedDraft[]> {
    const authorization = { authorized: this.requestAuthorization(authorized) };
    assertAuthorized(authorization);
    const safeContext = writingContext(context);
    const result = await this.complete("cheap", {
      ...authorization,
      system: WRITER_SYSTEM + "\n\n" + GROUNDED_WRITING_EXAMPLE + "\n\nWrite exactly one card per supplied plan row with its planId and exact factIds. Respect exclusions and omissions; the inventory is not independent evidence.",
      user: JSON.stringify({ captured: h.text, sourceTitle: h.sourceTitle, heading: h.heading, contextBefore: h.before, contextAfter: h.after, instruction: h.instruction, ...safeContext, preparation, existing }),
      schema: GroundedCardsOut, label: "grounded cards", maxTokens: 8000, retryInvalidResponse: false,
    });
    assertAuthorized(authorization);
    return result.cards;
  }

  /** Separate writer request: only rejected new candidates, never user-edit history. */
  async repairGeneration(h: Highlight, cards: Card[], existing: Card[], preparation: GenerationPreparation, context: GenerationContext, findings: { cardId: string; reasons: string[] }[], authorized?: () => boolean): Promise<GroundedDraft[]> {
    const authorization = { authorized: this.requestAuthorization(authorized) };
    assertAuthorized(authorization);
    const safeContext = writingContext(context);
    const result = await this.complete("cheap", {
      ...authorization,
      system: WRITER_SYSTEM + "\n\n" + GROUNDED_WRITING_EXAMPLE + "\n\nRepair only the supplied rejected candidates using all findings, captured source, plan/fact links and siblings. Return exactly one replacement per supplied candidate with its planId, exact factIds and all planned meaning. Do not return clean siblings, split rows, waive findings or shorten away required context. If a sound one-card repair is impossible, retain supported coverage for the independent final audit to hold; do not approve it.",
      user: JSON.stringify({ captured: h.text, sourceTitle: h.sourceTitle, heading: h.heading, contextBefore: h.before, contextAfter: h.after, instruction: h.instruction, ...safeContext, preparation, candidates: cards.map(c => ({ ...cardData(c), planId: c.generation?.planId, factIds: c.generation?.factIds })), findings, existing: existing.map(cardData) }),
      schema: GroundedCardsOut, label: "generation repair", maxTokens: 8000, retryInvalidResponse: false,
    });
    assertAuthorized(authorization);
    return result.cards;
  }

  async auditGeneration(h: Highlight, cards: Card[], existing: Card[], preparation: GenerationPreparation, context: GenerationContext, authorized?: () => boolean, final = false, capturedOriginal = h.text, sourceFindings: ScopedSourceFinding[] = []): Promise<GenerationAudit> {
    const authorization = { authorized: this.requestAuthorization(authorized) };
    assertAuthorized(authorization);
    const safeContext = writingContext(context);
    const checks = cards.map(c => cardChecks(c, h, [...existing, ...cards.filter(s => s.id !== c.id)]));
    const result = await this.complete("strong", {
      ...authorization,
      system: AUDIT_SYSTEM,
      user: JSON.stringify({ captured: h.text, sourceTitle: h.sourceTitle, heading: h.heading, contextBefore: h.before, contextAfter: h.after, instruction: h.instruction, ...safeContext, capturedOriginal, sourceFindings, preparation, cards: cards.map((c, index) => ({ index, ...cardData(c), planId: c.generation?.planId, factIds: c.generation?.factIds, reviews: renderedCardReviews(c), targetContext: (() => { const row = preparation.plan.find(p => p.id === c.generation?.planId); return row ? { entity: row.entity, aspect: row.aspect } : null; })(), checks: checks[index].map(id => ({ id, finding: LINT_FIX_INSTRUCTIONS[id as keyof typeof LINT_FIX_INSTRUCTIONS] })) })), existing }),
      schema: AuditTransportOut, outputSchema: auditOutputSchema(cards, checks), label: final ? "final audit" : "audit", maxTokens: 8000, retryInvalidResponse: false,
    });
    assertAuthorized(authorization);
    return result;
  }

  /** "write cards": one highlight (plus context) in, a handful of cards out. */
  async writeCards(h: Highlight, existing: Card[] = []): Promise<CardDraft[]> {
    const s = this.getSettings();
    const parsed = await this.complete("cheap", {
      system: WRITER_SYSTEM,
      user: JSON.stringify({
        source: { title: h.sourceTitle, heading: h.heading, contextBefore: h.before, highlight: h.text, contextAfter: h.after },
        ...writingContext(s), highlightInstruction: h.instruction, existing: existing.map(cardData),
        task: "Write cards from this highlight; do not repeat facts tested by existing cards.",
      }),
      schema: CardsOut,
      label: "cards",
      maxTokens: 8000,
    });
    return parsed.cards.filter((c) =>
      c.kind === "qa"
        ? c.front.trim() && c.back.trim()
        : [...c.text.matchAll(/\{\{c\d+::([\s\S]*?)(?:::[^}]*)?\}\}/g)].some((m) => m[1].trim()),
    );
  }

  /**
   * "critique": grade every card drafted for one highlight in a single call,
   * so the critic can see interference between siblings. Never mutates
   * `cards`; the caller applies the verdicts. Verdicts whose index does not
   * point at a card are dropped rather than thrown on, since a stray index is
   * a model slip, not a reason to lose the whole highlight.
   */
  async critiqueCards(h: Highlight, cards: Card[], existing: Card[] = [], authorized?: () => boolean): Promise<CritiqueVerdict[]> {
    if (!cards.length) return [];
    const authorization = { authorized: this.requestAuthorization(authorized) };
    assertAuthorized(authorization);
    const s = this.getSettings();
    assertAuthorized(authorization);
    const parsed = await this.complete("strong", {
      system: CRITIC_SYSTEM,
      ...authorization,
      user: JSON.stringify({
        source: { title: h.sourceTitle, heading: h.heading, contextBefore: h.before, highlight: h.text, contextAfter: h.after },
        cards: cards.map((c, index) => ({ index, ...cardData(c), reviews: renderedCardReviews(c),
          checks: cardChecks(c, h, [...existing, ...cards.filter(s => s.id !== c.id)]).map(id => ({ id, finding: LINT_FIX_INSTRUCTIONS[id as keyof typeof LINT_FIX_INSTRUCTIONS] })) })),
        ...writingContext(s), highlightInstruction: h.instruction, existing: existing.map(cardData),
        task: `Return exactly one verdict for each of the ${cards.length} drafted cards, using its index. A new card repeating an existing card's retrieval is a duplicate.`,
      }),
      schema: VerdictsOut,
      label: "verdicts",
      maxTokens: 8000,
    });
    assertAuthorized(authorization);
    return parsed.verdicts.filter((v) => Number.isInteger(v.index) && v.index >= 0 && v.index < cards.length);
  }

  /** Rewrite one card according to an instruction ("convert to cloze", "shorter", ...). */
  async rewriteCard(h: Highlight, card: Card, instruction: string, authorized?: () => boolean): Promise<CardDraft> {
    const authorization = { authorized: this.requestAuthorization(authorized) };
    assertAuthorized(authorization);
    const s = this.getSettings();
    // The siblings are why a rewrite can make interference worse: fixing one
    // card's wording can walk it straight into the card next to it.
    const siblings = h.cards.filter((c) => c.id !== card.id && c.status !== "deleted");
    assertAuthorized(authorization);
    const result = await this.complete("cheap", {
      system: WRITER_SYSTEM,
      user: JSON.stringify({
        source: { title: h.sourceTitle, heading: h.heading, contextBefore: h.before, highlight: h.text, contextAfter: h.after },
        currentCard: cardData(card), rewriteInstruction: instruction, siblings: siblings.map(cardData),
        ...writingContext(s), highlightInstruction: h.instruction,
        task: "Rewrite this one card. Do not duplicate or become confusable with its siblings.",
      }),
      schema: CardOut, label: "card", maxTokens: 4000, ...authorization,
    });
    assertAuthorized(authorization);
    return result;
  }

  /** Explicit user rewrites may split. Repairs and Convert keep rewriteCard's single-card contract. */
  async rewriteCards(h: Highlight, card: Card, instruction: string, authorized?: () => boolean): Promise<CardDraft[]> {
    const settings = JSON.stringify(this.getSettings());
    const authorization = { authorized: this.requestAuthorization(() => (!authorized || authorized()) && JSON.stringify(this.getSettings()) === settings) };
    assertAuthorized(authorization);
    const s = this.getSettings();
    const siblings = h.cards.filter(c => c.id !== card.id && c.status !== "deleted");
    const source = { title: h.sourceTitle, heading: h.heading, contextBefore: h.before, highlight: h.text, contextAfter: h.after };
    const context = { source, currentCard: cardData(card), rewriteInstruction: instruction, siblings: siblings.map(cardData),
      ...writingContext(s), highlightInstruction: h.instruction };
    const result = await this.complete("cheap", { system: WRITER_SYSTEM + EXPLICIT_REWRITE_SCOPE,
      user: JSON.stringify({ ...context, task: `Rewrite the requested card as one card, or split it into focused cards when requested or necessary. Return 1 to ${MAX_REWRITE_CARDS} cards; this is an operational bound, not a quota. Retain every source-supported fact tested by the original, including necessary conditions and relationships. Do not silently drop facts or duplicate siblings. If the request cannot fit safely, fail rather than truncate.` }),
      schema: RewriteCardsOut, label: "rewrite cards", maxTokens: 8000, retryInvalidResponse: false, ...authorization });
    assertAuthorized(authorization);
    let drafts = result.cards, candidates = rewriteCandidates(card, h, drafts);
    const rejected = (audit: z.infer<typeof RewriteAuditOut>): Error => {
      const reason = (!audit.preservesFacts ? audit.reason.trim() : audit.verdicts.find(v => v.verdict !== "keep")?.reason.trim()) || audit.reason.trim();
      return Error(`Rewrite kept the original. ${sanitizeDiagnostic(reason, [s.deepseekApiKey]).replace(/\s+/g, " ").slice(0, 300) || "The replacement set did not pass its source, coverage and quality check."}`);
    };
    const check = async (label: string) => {
      assertAuthorized(authorization);
      const audit = await this.complete("strong", { system: cardSystem("You are the independent checker, not the writer. Judge every answer-hidden review against the supplied source and writing method. Return only the requested set-coverage result and indexed keep/revise/drop verdicts with concrete reasons; do not write or repair cards.") + EXPLICIT_REWRITE_SCOPE,
      user: JSON.stringify({ ...context, cards: candidates.map((c, index) => ({ index, ...cardData(c), reviews: renderedCardReviews(c),
        checks: (() => { const lint = lintCard(c, h, [...siblings, ...candidates.filter(other => other !== c)]); return [...lint.failures, ...lint.warnings].map(id => ({ id, finding: LINT_FIX_INSTRUCTIONS[id] })); })() })),
        task: "Independently check every replacement against the source, current writing rules, its fellow replacements and existing siblings. Return exactly one indexed verdict per replacement. Separately compare the complete replacement set with currentCard: preservesFacts is true only if no source-supported fact or necessary condition/relationship tested by the original has been lost or changed. For unsupported original facts, require their omission instead of preserving an error. Judge grounding, self-contained context, retrieval quality, cloze syntax/leaks and duplicate retrievals. Any missing fact, unsupported claim, unadjudicated warning or quality failure must not receive keep. Do not write or repair cards in this check." }),
      schema: RewriteAuditOut, outputSchema: RewriteAuditOut.extend({ verdicts: z.array(RewriteAuditOut.shape.verdicts.element.extend({ index: z.number().int().min(0).max(candidates.length - 1) })).length(candidates.length) }),
      label, maxTokens: 4000, retryInvalidResponse: false, ...authorization });
      assertAuthorized(authorization);
      if (audit.verdicts.length !== candidates.length || new Set(audit.verdicts.map(v => v.index)).size !== candidates.length
        || audit.verdicts.some(v => v.index < 0 || v.index >= candidates.length)) {
        throw Error("The rewrite check returned incomplete or ambiguous card coverage. The original is unchanged.");
      }
      if (!audit.preservesFacts || audit.verdicts.some(v => v.verdict === "drop")) throw rejected(audit);
      return audit;
    };
    const audit = await check("rewrite audit");
    const findings = audit.verdicts.filter(v => v.verdict === "revise").map(({ index, reason }) => ({ index, reason }));
    if (findings.length) {
      const indices = new Set(findings.map(v => v.index));
      const repair = await this.complete("cheap", { system: WRITER_SYSTEM + EXPLICIT_REWRITE_SCOPE,
        user: JSON.stringify({ ...context, candidates: candidates.flatMap((c, index) => indices.has(index) ? [{ index, ...cardData(c) }] : []),
          accepted: candidates.filter((_, index) => !indices.has(index)).map(cardData), findings,
          task: "Repair only the supplied rejected replacement cards, using every finding and the captured source. Return exactly one changed card for each supplied index, preserving that index, supported facts, conditions and relationships. Do not return or alter the accepted siblings, add cards, waive findings or invent distinguishing facts. The complete replacement set will be independently checked again." }),
        schema: z.object({ cards: z.array(RewriteCardOut.extend({ index: z.number().int().min(0).max(candidates.length - 1) })).length(findings.length) }),
        label: "rewrite repair", maxTokens: 8000, retryInvalidResponse: false, ...authorization });
      assertAuthorized(authorization);
      if (repair.cards.length !== indices.size || new Set(repair.cards.map(c => c.index)).size !== indices.size
        || repair.cards.some(c => !indices.has(c.index))) throw Error("The rewrite repair changed the requested card set. The original is unchanged.");
      drafts = [...drafts];
      for (const { index, ...draft } of repair.cards) {
        if ((["kind", "front", "back", "text"] as const).every(k => draft[k] === drafts[index][k])) throw Error("The rewrite repair did not change the rejected card. The original is unchanged.");
        drafts[index] = draft;
      }
      candidates = rewriteCandidates(card, h, drafts);
      const final = await check("rewrite final audit");
      if (final.verdicts.some(v => v.verdict !== "keep")) throw rejected(final);
    }
    return drafts;
  }

}

export function describeError(e: unknown): string {
  if (e instanceof CodexError) return e.message;
  if (e instanceof DeepSeekError) return e.message;
  if (e instanceof OpenCodeError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
