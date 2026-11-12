import { createHash, randomUUID } from "crypto";
import { Notice } from "obsidian";
import type RecallPlugin from "./main";
import type { Card, Highlight } from "./model";
import { beginCardRewrite } from "./cardActions";
import { applyExplicitRewrite, explicitRewriteAuthorization, rewriteCandidates } from "./explicitRewrite";
import { sourceConcernsForCard } from "./generation";
import { describeError } from "./llm";
import { plainText } from "./util";

export interface CardEditRequest {
  id: string;
  highlightId: string;
  cardId: string;
  instruction: string;
  createdAt: string;
  state: "queued" | "running" | "failed" | "interrupted" | "completed" | "cancelled";
  sourceKey: string;
  settingsKey: string;
  message?: string;
}

export const EDIT_QUEUE_CAP = 100;
const finished = (r: CardEditRequest) => r.state === "completed" || r.state === "cancelled";
const key = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** One worker per plugin; requests and card changes share the inbox's atomic save. */
export class CardEditQueue {
  private worker?: Promise<void>;
  private stopped = false;
  private guards = new Map<string, () => boolean>();
  private waiting = new Map<string, (changed: boolean) => void>();
  private results = new Map<string, Promise<boolean>>();
  saveError = false;

  constructor(private plugin: Pick<RecallPlugin, "store" | "llm" | "settings">) {
    let recovered = false;
    for (const r of this.items) {
      if (r.state === "queued" || r.state === "running") {
        r.state = "interrupted";
        r.message = "Interrupted. Review the card, then retry; no model request was repeated.";
        recovered = true;
      }
    }
    if (recovered) this.plugin.store.touch();
  }

  get items(): CardEditRequest[] { return this.plugin.store.editRequests(); }

  async enqueue(h: Highlight, c: Card, instruction: string, active: () => boolean): Promise<boolean> {
    if (this.stopped || !this.plugin.store.isWritable) throw Error("The edit queue cannot be saved right now. Your instruction was not submitted.");
    if (!instruction.trim() || instruction.length > 8000) throw Error("Enter an edit instruction of at most 8,000 characters.");
    const duplicate = this.items.find(r => ["queued", "running"].includes(r.state) && r.cardId === c.id
      && r.highlightId === h.id && r.instruction === instruction && r.sourceKey === key(h) && r.settingsKey === key(this.plugin.settings));
    if (duplicate && this.results.has(duplicate.id)) return this.results.get(duplicate.id)!;
    if (this.items.filter(r => !finished(r)).length >= EDIT_QUEUE_CAP) throw Error("The edit queue is full. Resolve or cancel saved requests before adding another.");
    const r: CardEditRequest = { id: randomUUID(), highlightId: h.id, cardId: c.id, instruction,
      createdAt: new Date().toISOString(), state: "queued", sourceKey: key(h), settingsKey: key(this.plugin.settings) };
    this.plugin.store.editRequests(true).push(r);
    this.guards.set(r.id, active);
    const result = new Promise<boolean>(resolve => this.waiting.set(r.id, resolve));
    this.results.set(r.id, result);
    this.plugin.store.touch();
    try { await this.persist(); this.kick(); }
    catch { this.settle(r); }
    return result;
  }

  private kick(): void {
    if (this.worker || this.stopped || this.saveError) return;
    this.worker = this.run().finally(() => {
      this.worker = undefined;
      if (this.items.some(r => r.state === "queued" && this.guards.has(r.id))) this.kick();
    });
  }

  private async persist(): Promise<void> {
    try {
      if (!this.plugin.store.isWritable) throw Error("Storage is unavailable.");
      await this.plugin.store.flush();
      // flush snapshots synchronously; later unrelated edits need not delay this receipt.
      if (!this.plugin.store.isWritable) throw Error("Storage is unavailable.");
    } catch {
      this.saveError = true;
      this.plugin.store.notify?.();
      new Notice("Recall Studio: edit queue could not be saved. Requests remain in memory; use Save queue after fixing storage.", 0);
      throw Error("Edit queue save failed.");
    }
  }

  private settle(r: CardEditRequest, changed = false): void {
    this.waiting.get(r.id)?.(changed);
    this.waiting.delete(r.id);
    this.results.delete(r.id);
    this.guards.delete(r.id);
  }

  private async run(): Promise<void> {
    try {
      await this.persist();
      while (!this.stopped && !this.saveError) {
        const r = this.items.find(item => item.state === "queued");
        if (!r) break;
        const h = this.plugin.store.all().find(item => item.id === r.highlightId);
        const c = h?.cards.find(item => item.id === r.cardId);
        const active = this.guards.get(r.id) ?? (() => false);
        const current = h && c ? this.plugin.llm.requestAuthorization(explicitRewriteAuthorization(c, h, () =>
          !this.stopped && !this.saveError && r.state === "running" && active() && key(h) === r.sourceKey
          && key(this.plugin.settings) === r.settingsKey && this.plugin.store.all().includes(h) && h.cards.includes(c))) : () => false;
        let release: (() => void) | undefined;
        let changed = false;
        r.state = "running";
        this.plugin.store.touch();
        try {
          await this.persist();
          if (!h || !c || !current()) throw Error("Card, source, settings or editor changed. Review the card, then retry this saved instruction.");
          if (sourceConcernsForCard(c, h).length) throw Error("Resolve this card's source concern before retrying its saved edit.");
          release = beginCardRewrite(c);
          if (!release) throw Error("Another operation is changing this card. Retry this saved edit when it finishes.");
          const source = structuredClone(h);
          source.text = plainText(source.text);
          const drafts = await this.plugin.llm.rewriteCards(source, structuredClone(c), r.instruction, current);
          if (!current()) throw Error("Edit interrupted or inputs changed. The original is unchanged; the instruction is saved for retry.");
          const candidates = rewriteCandidates(c, h, drafts);
          const before = key(h);
          const revision = applyExplicitRewrite(c, h, candidates, r.instruction);
          if (!revision) throw Error("No changes returned. The original is unchanged; the instruction is saved for retry.");
          this.plugin.store.recordRevision(revision);
          // Only this worker's accepted change may advance already-saved sibling requests.
          for (const next of this.items) if (next.state === "queued" && next.highlightId === h.id && next.sourceKey === before) next.sourceKey = key(h);
          r.state = "completed";
          r.message = candidates.length > 1 ? `Rewrote into ${candidates.length} cards.` : "Card rewritten.";
          changed = true;
        } catch (e) {
          if (r.state === "running") {
            r.state = this.stopped ? "interrupted" : "failed";
            r.message = describeError(e);
            new Notice(`Recall Studio: ${r.message}`);
          }
        } finally {
          release?.();
        }
        this.plugin.store.touch();
        await this.persist();
        this.settle(r, changed);
        if (changed) new Notice(`Recall Studio: ${r.message}`);
      }
    } catch { /* persist() reports the failure; retain every request and applied result. */ }
    finally {
      // Resolve UI waiters even when storage or unload stopped the worker.
      if (this.stopped || this.saveError) for (const r of this.items) if (this.waiting.has(r.id)) this.settle(r);
    }
  }

  async retry(id: string, active: () => boolean): Promise<void> {
    const r = this.items.find(item => item.id === id);
    if (!r || !["failed", "interrupted"].includes(r.state) || this.stopped || this.saveError) return;
    const h = this.plugin.store.all().find(item => item.id === r.highlightId), c = h?.cards.find(item => item.id === r.cardId);
    if (!h || !c || !explicitRewriteAuthorization(c, h, active)() || sourceConcernsForCard(c, h).length) throw Error("This card is unavailable or has a source concern. The instruction is still saved.");
    r.sourceKey = key(h); r.settingsKey = key(this.plugin.settings);
    r.state = "queued"; delete r.message;
    this.guards.set(r.id, active);
    this.plugin.store.touch(); this.kick();
    await this.idle();
  }

  async cancel(id: string): Promise<void> {
    const r = this.items.find(item => item.id === id);
    if (!r || finished(r)) return;
    r.state = "cancelled"; r.message = "Cancelled.";
    this.settle(r);
    this.plugin.store.touch();
    await this.persist();
  }

  async save(): Promise<void> {
    await this.persist();
    this.saveError = false;
    // A failed checkpoint has an uncertain outcome, so require explicit retry.
    for (const r of this.items) if (r.state === "queued" || r.state === "running") {
      r.state = "interrupted"; r.message = "Saved. Review the card, then retry this instruction.";
    }
    this.plugin.store.touch(); await this.persist();
  }

  async clearFinished(): Promise<void> {
    const requests = this.items;
    for (let i = requests.length - 1; i >= 0; i--) if (finished(requests[i])) requests.splice(i, 1);
    this.plugin.store.touch(); await this.persist();
  }

  async idle(): Promise<void> { await this.worker; }

  stop(): Promise<void> {
    this.stopped = true;
    for (const r of this.items) if (r.state === "queued" || r.state === "running") {
      r.state = "interrupted"; r.message = "Interrupted. Review the card, then retry this saved instruction.";
      this.plugin.store.touch();
    }
    return this.idle();
  }
}
