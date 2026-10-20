import { Notice } from "obsidian";
import { newId, plainText } from "./util";
import type RecallPlugin from "./main";
import { makeCard, type Card, type GenerationBatch, type Highlight } from "./model";
import { describeError } from "./llm";
import { lintCard, demoteSingleCloze } from "./lint";
import { nextInstruction } from "./inboxData";
import { cardAuditContent, generationKey, generationSource, generationSourceKey, validatePreparation, validateDrafts, validateAudit } from "./generation";

class Interrupted extends Error {}

/** Existing queue, with three bounded logical stages and durable checkpoints. */
export class Generator {
  private running = new Set<string>();
  private stopped = false;
  private lifetime = 0;
  private requests = new Map<string, number>();
  /** Only checkpoints serialize; independent model requests remain concurrent. */
  private saving: Promise<void> = Promise.resolve();

  constructor(private plugin: RecallPlugin) {}

  start(): void { this.stopped = false; this.kick(); }
  stop(): void { this.stopped = true; this.lifetime++; }

  enqueue(h: Highlight): void {
    if (h.archived || h.status === "dismissed") return;
    this.requests.set(h.id, (this.requests.get(h.id) ?? 0) + 1);
    h.status = "queued";
    h.error = null;
    this.plugin.store.touch();
    this.kick();
  }

  private batch(instruction = ""): GenerationBatch {
    return { version: 1, id: newId("g"), instruction, inputKey: "", phase: "preparing" };
  }

  private replaceBatch(h: Highlight, instruction: string): GenerationBatch {
    const old = h.generation;
    if (old?.preparation || old?.audit) {
      const { drafts: _drafts, ...record } = old;
      h.generationHistory ??= [];
      if (!h.generationHistory.some(g => g.id === old.id)) h.generationHistory.push(record);
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
      void this.run(h).finally(() => { this.running.delete(h.id); this.kick(); });
    }
    this.plugin.refreshStatusBar();
  }

  private async run(h: Highlight): Promise<void> {
    if (this.stopped || h.archived || h.status === "dismissed") return;
    const lifetime = this.lifetime;
    const request = this.requests.get(h.id);
    const source = generationSource(h);
    const appended: Card[] = [];
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
      let context = await this.plugin.llm.generationContext(batch.id);
      assertCurrent();
      let key = generationKey(h, context, this.plugin.settings, batch.id);
      if (batch.version !== 1 || (batch.inputKey && batch.inputKey !== key)) {
        batch = this.replaceBatch(h, batch.instruction);
        context = await this.plugin.llm.generationContext(batch.id);
        assertCurrent();
        key = generationKey(h, context, this.plugin.settings, batch.id);
      }
      batch.inputKey = key;
      // Recompute provider, instructions and existing-card inputs after awaits.
      const checkInputs = () => {
        assertCurrent();
        if (generationKey(h, context, this.plugin.settings, batch.id) !== key) throw new Interrupted("Generation inputs changed. Retry to use the current settings or cards.");
      };
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
      const words: Highlight = { ...h, text: plainText(h.text), instruction: nextInstruction(h.instruction, batch.instruction) };
      const existing = h.cards.filter(c => c.status !== "deleted" && c.generation?.batchId !== batch.id);
      if (!batch.preparation) {
        const raw = await this.plugin.llm.prepareGeneration(words, existing, context);
        checkInputs();
        batch.preparation = validatePreparation(raw, words.text, context.maxCards);
        batch.phase = "writing";
        await save();
      }
      const preparation = validatePreparation(batch.preparation, words.text, context.maxCards);
      if (!batch.drafts) {
        const raw = await this.plugin.llm.writeGroundedCards(words, existing, preparation, context);
        checkInputs();
        const drafts = validateDrafts({ cards: raw }, preparation, context.maxCards);
        const cards = drafts.map(d => {
          const normalized = demoteSingleCloze(d);
          const card = makeCard(h.id, { kind: normalized.kind, front: normalized.kind === "qa" ? normalized.front.trim() : "", back: normalized.kind === "qa" ? normalized.back.trim() : "", text: normalized.kind === "cloze" ? normalized.text.trim() : "" });
          card.generation = { batchId: batch.id, planId: d.planId, factIds: [...d.factIds], audit: { status: "unverified", reason: "Independent audit has not run.", content: cardAuditContent(card), sourceKey: generationSourceKey(h) } };
          return card;
        });
        for (const c of cards) {
          const lint = lintCard(c, words, cards.filter(s => s !== c));
          if (lint.failures.length) c.lintFailures = lint.failures;
          if (lint.warnings.length) c.lintWarnings = lint.warnings;
          if (lint.failures.length && this.plugin.settings.lintMode !== "badge") c.status = "flagged";
        }
        batch.drafts = cards;
        batch.phase = "auditing";
        await save();
      }
      const cards = batch.drafts;
      // Check persisted links as well as newly returned model output.
      validateDrafts({ cards: cards.map(c => ({ ...c, planId: c.generation?.planId, factIds: c.generation?.factIds })) }, preparation, context.maxCards);
      if (new Set(cards.map(c => c.id)).size !== cards.length || cards.some(c => c.highlightId !== h.id || c.generation?.batchId !== batch.id)) throw new Error("Invalid saved draft identity.");
      if (!batch.audit) {
        if (!this.plugin.settings.critiquePass || !cards.length) {
          batch.audit = { status: "unverified", reason: cards.length ? "Independent audit is disabled." : "No cards to audit.", verdicts: [] };
        } else if (batch.auditRequested) {
          batch.audit = { status: "unverified", reason: "The prior audit was interrupted. Its outcome is unknown; it was not requested again.", verdicts: [] };
        } else {
          batch.auditRequested = true;
          await save();
          try {
            const raw = await this.plugin.llm.auditGeneration(words, cards, existing, preparation, context);
            checkInputs();
            const audit = validateAudit(raw, cards);
            const complete = audit.verdicts.length === cards.length;
            batch.audit = { status: audit.verdicts.some(v => v.status === "failed") ? "failed" : complete && audit.verdicts.every(v => v.status === "verified") && !preparation.conflicts.length ? "verified" : "unverified", reason: complete ? "Independent audit completed; see each card's verdict." : "Independent audit returned missing verdicts; those cards remain unverified.", verdicts: audit.verdicts };
          } catch (e) {
            checkInputs();
            batch.audit = { status: "failed", reason: `Independent audit failed: ${describeError(e)}`, verdicts: [] };
          }
        }
        // A failed audit is terminal for this batch, not an automatic repair loop.
        await save();
      }
      validateAudit({ verdicts: batch.audit.verdicts }, cards);
      if (batch.audit.status === "verified" && cards.some(c => c.lintFailures?.includes("cloze-not-grounded"))) {
        batch.audit.status = "unverified";
        batch.audit.reason = "A deterministic grounding check failed; affected cards remain unverified.";
      }
      if (!batch.committed) {
        for (const c of cards) {
          const verdict = batch.audit.verdicts.find(v => v.index === cards.indexOf(c) && v.cardId === c.id);
          const groundingFailed = c.lintFailures?.includes("cloze-not-grounded");
          const status = verdict?.status === "failed" ? "failed" : preparation.conflicts.length || groundingFailed ? "unverified" : verdict?.status ?? "unverified";
          const reason = verdict?.status === "failed" ? verdict.reason : groundingFailed ? "The cloze failed mechanical source grounding; the model verdict does not override it." : preparation.conflicts.length ? "Source conflicts need human review." : verdict?.reason ?? batch.audit.reason;
          c.generation!.audit = { status, reason, content: cardAuditContent(c), sourceKey: generationSourceKey(h) };
          c.critiqueRan = !!verdict;
          if (status === "failed") { c.status = "flagged"; c.critiqueReason = verdict?.reason; }
          if (!h.cards.some(existing => existing.id === c.id)) { h.cards.push(c); appended.push(c); }
        }
        h.generatedAt = new Date().toISOString();
        batch.committed = true;
      }
      batch.phase = "complete";
      h.status = "ready";
      h.error = null;
      await save();
      if (this.plugin.settings.notifyWhenReady) new Notice(`Review Inbox: ${cards.length} cards ready for “${h.title || h.sourceTitle}”. Audit ${batch.audit.status}.`);
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
        else { h.status = "error"; h.error = describeError(e); }
      }
      if (rollback || !superseded) this.plugin.store.touch();
      if (rollback && !this.stopped) {
        try {
          await this.plugin.store.flush();
          if (this.plugin.store.hasUnsavedChanges) throw new Error("Rollback was not saved.");
        } catch (saveError) {
          if (!superseded) { h.status = "error"; h.error = `Stale generation removed in memory, but saving failed: ${describeError(saveError)}`; }
          new Notice("Review Inbox: stale generation could not be removed from storage. Changes remain in memory; fix storage and retry.");
          this.plugin.store.touch();
        }
      }
    }
  }
}
