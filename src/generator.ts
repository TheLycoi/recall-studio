import { Notice } from "obsidian";
import { newId, plainText } from "./util";
import type RecallPlugin from "./main";
import { makeCard, type Card, type GenerationAuditRecord, type GenerationBatch, type Highlight } from "./model";
import { describeError } from "./llm";
import { lintCard, LINT_FIX_INSTRUCTIONS } from "./lint";
import { nextInstruction } from "./inboxData";
import { cardAuditContent, generationKey, generationSource, generationSourceKey, validatePreparation, validateDrafts, validateAudit } from "./generation";

class Interrupted extends Error {}
const lengthPolicies = new Set(["cloze-framing", "qa-answer-long", "card-long"]);

/** Private writing, bounded repair and independent publication checkpoints. */
export class Generator {
  private running = new Set<string>();
  private pending = new Set<Promise<void>>();
  private stopped = false;
  private lifetime = 0;
  private requests = new Map<string, number>();
  /** Only checkpoints serialize; independent model requests remain concurrent. */
  private saving: Promise<void> = Promise.resolve();

  constructor(private plugin: RecallPlugin) {}

  start(): void { this.stopped = false; this.kick(); }
  /** Invalidate synchronously; abort providers before awaiting this drain. */
  stop(): Promise<void> {
    this.stopped = true;
    this.lifetime++;
    return Promise.allSettled(this.pending).then(() => {});
  }

  enqueue(h: Highlight): void {
    if (h.archived || h.status === "dismissed") return;
    this.requests.set(h.id, (this.requests.get(h.id) ?? 0) + 1);
    h.status = "queued";
    h.error = null;
    this.plugin.store.touch();
    this.kick();
  }

  canRetry(h: Highlight): boolean {
    return !this.stopped && !h.archived && !this.running.has(h.id)
      && !["queued", "generating", "dismissed"].includes(h.status)
      && (h.status === "error" || !!h.generation?.blocked?.length);
  }

  /** Explicit permission to retry held/unknown work, never used by startup. */
  retry(h: Highlight): void {
    if (h.archived || h.status === "dismissed") return;
    const b = h.generation;
    if (b) {
      b.retryFindings = structuredClone((b.blocked ?? []).filter(f => {
        const repair = [...(b.repairs ?? [])].reverse().find(r => r.cardId === f.cardId);
        return b.finalAudit?.verdicts.some(v => v.cardId === f.cardId && v.status === "failed") || repair?.error || !repair?.candidate;
      }));
      b.repairRound = (b.repairRound ?? 0) + 1;
      if (b.finalAudit) (b.auditHistory ??= []).push(b.finalAudit);
      delete b.finalAudit;
      delete b.finalAuditRequested;
      if (!b.audit?.verdicts.length || b.audit.status === "unverified" || JSON.stringify(b.audit.contents) !== JSON.stringify(b.drafts?.map(cardAuditContent))) {
        if (b.audit) (b.auditHistory ??= []).push(b.audit);
        delete b.audit;
        delete b.auditRequested;
        delete b.retryFindings;
      }
      if (!b.preparation) delete b.preparationRequested;
      if (!b.drafts) {
        if (b.writerOutput) (b.writerHistory ??= []).push(b.writerOutput);
        delete b.writerOutput;
        delete b.writingRequested;
      }
      b.blocked = [];
      b.committed = false;
      b.phase = b.drafts ? "auditing" : b.preparation ? "writing" : "preparing";
    }
    this.enqueue(h);
  }

  private batch(instruction = ""): GenerationBatch {
    return { version: 1, id: newId("g"), instruction, inputKey: "", phase: "preparing" };
  }

  private replaceBatch(h: Highlight, instruction: string): GenerationBatch {
    const old = h.generation;
    if (old) {
      h.generationHistory ??= [];
      if (!h.generationHistory.some(g => g.id === old.id)) h.generationHistory.push(old);
    }
    return h.generation = this.batch(instruction);
  }

  /** Intentional new generation, unlike enqueue's retry of a saved batch. */
  more(h: Highlight, instruction = ""): void {
    if (h.archived || h.status === "dismissed") return;
    this.replaceBatch(h, instruction.trim());
    this.enqueue(h);
  }

  kick(): void {
    if (this.stopped) return;
    const limit = Math.max(1, this.plugin.settings.concurrency);
    for (const h of this.plugin.store.all()) {
      if (this.running.size >= limit) break;
      if (h.archived || h.status !== "queued" || this.running.has(h.id)) continue;
      this.running.add(h.id);
      const task = this.run(h).finally(() => {
        this.running.delete(h.id);
        this.pending.delete(task);
        this.plugin.store.notify(); // Retry controls must see that the final checkpoint is no longer busy.
        this.kick();
      });
      this.pending.add(task);
      void task.catch(e => console.error("Recall Studio: generation failed", e));
    }
    this.plugin.refreshStatusBar();
  }

  private async run(h: Highlight): Promise<void> {
    if (this.stopped || h.archived || h.status === "dismissed") return;
    const lifetime = this.lifetime;
    const request = this.requests.get(h.id);
    const source = generationSource(h);
    const appended: Card[] = [];
    const appendedContents = new Map<Card, string>();
    let batch = h.generation ?? this.batch();
    h.generation = batch;
    h.status = "generating";
    h.error = null;
    this.plugin.store.touch();
    const current = () => !this.stopped && this.lifetime === lifetime && this.requests.get(h.id) === request && h.generation === batch && !h.archived && h.status !== "dismissed" && generationSource(h) === source && this.plugin.store.all().includes(h);
    const assertCurrent = () => { if (!current()) throw new Interrupted("Generation inputs changed or the request was cancelled. Retry to use the current capture."); };
    const checkpoint = async () => {
      const attempt = this.saving.then(async () => {
        assertCurrent();
        this.plugin.store.touch();
        await this.plugin.store.flush();
        assertCurrent();
        // Dirty after a no-op (read-only/closed) save is not a durable stage.
        if (this.plugin.store.hasUnsavedChanges) throw new Error("Generation checkpoint was not saved. Fix inbox storage and retry.");
      });
      this.saving = attempt.catch(() => {});
      await attempt;
    };
    try {
      // Capture dependencies before the first asynchronous rules read.
      const emptyContext = { language: "", instructions: "", rules: "", examples: "" };
      const initialKey = generationKey(h, emptyContext, this.plugin.settings, batch.id);
      const published = JSON.stringify(h.cards);
      let context = await this.plugin.llm.generationContext(batch.id);
      assertCurrent();
      if (generationKey(h, emptyContext, this.plugin.settings, batch.id) !== initialKey || JSON.stringify(h.cards) !== published) throw new Interrupted("Generation inputs changed while reading rules. Retry explicitly.");
      let key = generationKey(h, context, this.plugin.settings, batch.id);
      if (batch.version !== 1 || (batch.inputKey && batch.inputKey !== key)) {
        const unknown = (batch.preparationRequested && !batch.preparation) || (batch.writingRequested && !batch.writerOutput) || (batch.auditRequested && !batch.audit) || (batch.finalAuditRequested && !batch.finalAudit) || batch.repairs?.some(r => r.round === (batch.repairRound ?? 0) && r.requested && !r.output && !r.error);
        if (unknown) throw new Error("A prior paid outcome is unknown; changed inputs require explicit retry.");
        batch = this.replaceBatch(h, batch.instruction);
        const replacementKey = generationKey(h, emptyContext, this.plugin.settings, batch.id);
        context = await this.plugin.llm.generationContext(batch.id);
        assertCurrent();
        if (generationKey(h, emptyContext, this.plugin.settings, batch.id) !== replacementKey || JSON.stringify(h.cards) !== published) throw new Interrupted("Generation inputs changed while reading rules. Retry explicitly.");
        key = generationKey(h, context, this.plugin.settings, batch.id);
      }
      batch.inputKey = key;
      const staged = () => JSON.stringify([batch.preparation, batch.writerOutput, batch.drafts, batch.repairs, batch.audit, batch.finalAudit]);
      let expected = staged();
      const changed = () => { expected = staged(); };
      const checkInputs = () => {
        assertCurrent();
        if (generationKey(h, context, this.plugin.settings, batch.id) !== key || staged() !== expected || JSON.stringify(h.cards.filter(c => !appended.includes(c))) !== published || appended.some(c => JSON.stringify(c) !== appendedContents.get(c))) throw new Interrupted("Generation inputs changed. Retry to use the current settings or cards.");
      };
      const authorized = () => { try { checkInputs(); return true; } catch { return false; } };
      const checkContext = async () => {
        checkInputs();
        const latestContext = await this.plugin.llm.generationContext(batch.id);
        checkInputs();
        if (generationKey(h, latestContext, this.plugin.settings, batch.id) !== key) throw new Interrupted("Generation rules or examples changed. Retry to use the current inputs.");
      };
      const save = async () => {
        await checkContext();
        await checkpoint();
        await checkContext();
      };
      await save();
      // Completed batches are not permission to rewrite already published cards.
      if (batch.committed) {
        h.status = batch.blocked?.length && !h.cards.length ? "error" : "ready";
        h.error = batch.blocked?.length ? `${batch.blocked.length} drafts held for explicit retry.` : null;
        await save();
        return;
      }
      const words: Highlight = { ...h, text: plainText(h.text), instruction: nextInstruction(h.instruction, batch.instruction) };
      const existing = h.cards.filter(c => c.status !== "deleted");
      if (!batch.preparation) {
        if (batch.preparationRequested) throw new Error("The prior preparation outcome is unknown. Use Retry held drafts to authorize another request.");
        batch.preparationRequested = true;
        await save();
        const raw = await this.plugin.llm.prepareGeneration(words, structuredClone(existing), context, authorized);
        await checkContext();
        batch.preparation = validatePreparation(raw, words.text, context.maxCards);
        batch.phase = "writing";
        changed();
        await save();
      }
      const preparation = validatePreparation(batch.preparation, words.text, context.maxCards);
      if (!batch.drafts) {
        if (!batch.writerOutput) {
          if (batch.writingRequested) throw new Error("The prior writer outcome is unknown. Use Retry held drafts to authorize another request.");
          batch.writingRequested = true;
          await save();
          const raw = await this.plugin.llm.writeGroundedCards(words, structuredClone(existing), preparation, context, authorized);
          await checkContext();
          batch.writerOutput = raw;
          changed();
          await save();
        }
        const drafts = validateDrafts({ cards: batch.writerOutput }, preparation, context.maxCards);
        batch.drafts = drafts.map(d => {
          const card = makeCard(h.id, { kind: d.kind, front: d.front, back: d.back, text: d.text });
          card.generation = { batchId: batch.id, planId: d.planId, factIds: [...d.factIds], audit: { status: "unverified", reason: "Independent audit has not run.", content: cardAuditContent(card), sourceKey: generationSourceKey(h) } };
          return card;
        });
        batch.phase = "auditing";
        changed();
        await save();
      }
      const originals = batch.drafts;
      const validateCards = (cards: Card[]) => {
        validateDrafts({ cards: cards.map(c => ({ ...c, planId: c.generation?.planId, factIds: c.generation?.factIds })) }, preparation, context.maxCards);
        if (new Set(cards.map(c => c.id)).size !== cards.length || cards.some(c => c.highlightId !== h.id || c.generation?.batchId !== batch.id)) throw new Error("Invalid saved draft identity.");
      };
      validateCards(originals);
      const audit = async (cards: Card[], final = false): Promise<GenerationAuditRecord> => {
        const saved = final ? batch.finalAudit : batch.audit;
        if (saved) {
          validateAudit(saved, cards);
          if (JSON.stringify(saved.contents) !== JSON.stringify(cards.map(cardAuditContent))) return { status: "unverified", reason: "Saved audit does not match the exact candidates; explicit retry is required.", verdicts: [], contents: cards.map(cardAuditContent) };
          return saved;
        }
        const requested = final ? batch.finalAuditRequested : batch.auditRequested;
        if (requested) return { status: "unverified", reason: "The prior audit outcome is unknown. It was not requested again; use explicit retry.", verdicts: [], contents: cards.map(cardAuditContent) };
        if (final) batch.finalAuditRequested = true;
        else batch.auditRequested = true;
        await save();
        let result: GenerationAuditRecord;
        try {
          const raw = cards.length ? await this.plugin.llm.auditGeneration(words, structuredClone(cards), structuredClone(existing.filter(c => !cards.some(candidate => candidate.id === c.id))), preparation, context, authorized, final) : { verdicts: [] };
          await checkContext();
          const checked = validateAudit(raw, cards);
          result = { status: checked.verdicts.some(v => v.status === "failed") ? "failed" : checked.verdicts.length === cards.length && checked.verdicts.every(v => v.status === "verified") && !preparation.conflicts.length ? "verified" : "unverified", reason: checked.verdicts.length === cards.length ? "Independent audit completed; see each candidate's verdict." : "Independent audit omitted verdicts; affected candidates are held.", verdicts: checked.verdicts, contents: cards.map(cardAuditContent) };
        } catch (e) {
          await checkContext();
          result = { status: "unverified", reason: `Independent audit unavailable: ${describeError(e)}`, verdicts: [], contents: cards.map(cardAuditContent) };
        }
        if (final) batch.finalAudit = result;
        else batch.audit = result;
        changed();
        await save();
        return result;
      };
      const initial = await audit(originals);
      const latestCandidate = (c: Card) => h.cards.find(published => published.id === c.id) ?? [...(batch.repairs ?? [])].reverse().find(r => r.cardId === c.id && r.candidate)?.candidate ?? c;
      let cards = originals.map(latestCandidate);
      validateCards(cards);
      const issues = (card: Card, index: number, checked: GenerationAuditRecord): string[] => {
        const lint = lintCard(card, words, [...existing, ...cards.filter(c => c.id !== card.id)]);
        const hard = lint.failures.filter(id => !lengthPolicies.has(id));
        const verdict = checked.contents?.[index] === cardAuditContent(card) ? checked.verdicts.find(v => v.index === index && v.cardId === card.id) : undefined;
        return [...hard.map(id => LINT_FIX_INSTRUCTIONS[id]), ...(preparation.conflicts.length ? ["Source conflicts need human review."] : []), ...(verdict?.status === "verified" ? [] : [verdict?.reason ?? checked.reason])];
      };
      const round = batch.repairRound ?? 0;
      const targets = cards.map((card, index) => {
        const verdict = initial.verdicts.find(v => v.index === index && v.cardId === card.id);
        const lint = lintCard(card, words, [...existing, ...cards.filter(c => c.id !== card.id)]);
        const confirmed = (initial.contents?.[index] === cardAuditContent(card) && verdict?.status === "failed") || lint.failures.some(id => !lengthPolicies.has(id));
        const retry = batch.retryFindings?.find(f => f.cardId === card.id);
        return { card, reasons: retry?.reasons ?? (confirmed ? [...new Set([...issues(card, index, initial), ...[...lint.failures, ...lint.warnings].map(id => LINT_FIX_INSTRUCTIONS[id])])] : []) };
      }).filter(t => t.reasons.length && !h.cards.some(c => c.id === t.card.id));
      for (const target of targets) {
        if (batch.repairs?.some(r => r.round === round && r.cardId === target.card.id)) continue;
        const repair = { cardId: target.card.id, round, content: cardAuditContent(target.card), findings: target.reasons, requested: true } as NonNullable<GenerationBatch["repairs"]>[number];
        (batch.repairs ??= []).push(repair);
        batch.phase = "repairing";
        changed();
        await save();
        try {
          const output = await this.plugin.llm.repairGeneration(words, structuredClone([target.card]), structuredClone([...new Map([...existing, ...cards].filter(c => c.id !== target.card.id).map(c => [c.id, c])).values()]), preparation, context, [{ cardId: target.card.id, reasons: target.reasons }], authorized);
          await checkContext();
          repair.output = output;
          changed();
          const subset = { ...preparation, plan: preparation.plan.filter(p => p.id === target.card.generation?.planId) };
          const [draft] = validateDrafts({ cards: output }, subset, context.maxCards);
          repair.candidate = { ...structuredClone(target.card), kind: draft.kind, front: draft.front, back: draft.back, text: draft.text };
          changed();
          if (cardAuditContent(repair.candidate) === repair.content) throw new Error("The repair did not change the rejected wording. The original remains held.");
          cards = originals.map(latestCandidate);
          validateCards(cards);
        } catch (e) {
          // Expired authorization is not a repair finding.
          if (!authorized()) throw e;
          await checkContext();
          repair.error = describeError(e);
        }
        changed();
        await save();
      }
      cards = originals.map(latestCandidate);
      validateCards(cards);
      const attempted = !!batch.repairs?.length;
      if (attempted) { batch.phase = "rechecking"; await save(); }
      const final = attempted ? await audit(cards, true) : initial;
      batch.blocked = [];
      for (const [index, card] of cards.entries()) {
        if (h.cards.some(c => c.id === card.id)) continue;
        const reasons = issues(card, index, final);
        const repair = [...(batch.repairs ?? [])].reverse().find(r => r.cardId === card.id);
        if (repair?.error || (repair?.requested && !repair.candidate)) reasons.push(repair.error ?? "The prior repair outcome is unknown. Use explicit retry.");
        if (reasons.length) { batch.blocked.push({ cardId: card.id, reasons: [...new Set(reasons)] }); continue; }
        const lint = lintCard(card, words, [...existing, ...cards.filter(c => c.id !== card.id)]);
        const published = structuredClone(card);
        published.generation!.audit = { status: "verified", reason: final.verdicts.find(v => v.index === index && v.cardId === card.id)!.reason, content: cardAuditContent(card), sourceKey: generationSourceKey(h) };
        published.critiqueRan = true;
        delete published.lintFailures;
        delete published.critiqueReason;
        published.lintWarnings = lint.warnings;
        published.status = "pending";
        h.cards.push(published);
        appended.push(published);
        appendedContents.set(published, JSON.stringify(published));
      }
      h.generatedAt = new Date().toISOString();
      batch.committed = true;
      batch.phase = batch.blocked.length ? "blocked" : "complete";
      h.status = batch.blocked.length && !h.cards.length ? "error" : "ready";
      h.error = batch.blocked.length ? `${batch.blocked.length} drafts held for explicit retry.` : null;
      await save();
      if (this.plugin.settings.notifyWhenReady) new Notice(`Recall Studio: ${appended.length} cards ready, ${batch.blocked.length} held for “${h.title || h.sourceTitle}”.`);
    } catch (e) {
      const rollback = e instanceof Interrupted && appended.length > 0;
      if (rollback) {
        h.cards = h.cards.filter(c => !appended.includes(c));
        batch.committed = false;
        batch.phase = "auditing";
      }
      const superseded = h.archived || (h.status as Highlight["status"]) === "dismissed" || h.generation !== batch || this.requests.get(h.id) !== request;
      if (!superseded) {
        if (this.stopped || this.lifetime !== lifetime) { h.status = "queued"; h.error = null; }
        else {
          h.status = "error";
          h.error = describeError(e);
          const held = batch.drafts?.filter(c => !h.cards.some(published => published.id === c.id));
          if (held?.length) {
            batch.phase = "blocked";
            batch.blocked = held.map(c => ({ cardId: c.id, reasons: [...new Set([...(batch.blocked?.find(f => f.cardId === c.id)?.reasons ?? []), h.error!])] }));
          }
        }
      }
      if (rollback || !superseded) this.plugin.store.touch();
      if (rollback && !this.stopped) {
        try {
          await this.plugin.store.flush();
          if (this.plugin.store.hasUnsavedChanges) throw new Error("Rollback was not saved.");
        } catch (saveError) {
          if (!superseded) { h.status = "error"; h.error = `Stale generation removed in memory, but saving failed: ${describeError(saveError)}`; }
          new Notice("Recall Studio: stale generation could not be removed from storage. Changes remain in memory; fix storage and retry.");
          this.plugin.store.touch();
        }
      }
    }
  }
}
