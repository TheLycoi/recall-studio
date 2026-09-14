import { Notice } from "obsidian";
import type RecallPlugin from "./main";
import { makeCard, type Card, type Highlight } from "./model";
import { describeError } from "./llm";
import { lintCard, type LintResult } from "./lint";

/**
 * Background queue: fire a highlight in, come back later to cards in the
 * inbox. Runs `concurrency` highlights at a time and survives reloads because
 * queued state lives in the store.
 */
export class Generator {
  private running = new Set<string>();
  private stopped = false;

  constructor(private plugin: RecallPlugin) {}

  start(): void {
    this.stopped = false;
    this.kick();
  }

  stop(): void {
    this.stopped = true;
  }

  enqueue(h: Highlight): void {
    h.status = "queued";
    h.error = null;
    this.plugin.store.touch();
    this.kick();
  }

  /** Ask for more cards on a highlight that already has some. */
  more(h: Highlight): void {
    this.enqueue(h);
  }

  kick(): void {
    if (this.stopped) return;
    const limit = Math.max(1, this.plugin.settings.concurrency);
    for (const h of this.plugin.store.all()) {
      if (this.running.size >= limit) break;
      if (h.status !== "queued" || this.running.has(h.id)) continue;
      this.running.add(h.id);
      void this.run(h).finally(() => {
        this.running.delete(h.id);
        this.kick();
      });
    }
    this.plugin.refreshStatusBar();
  }

  private async run(h: Highlight): Promise<void> {
    h.status = "generating";
    this.plugin.store.touch();
    try {
      const settings = this.plugin.settings;
      const existing = h.cards.filter((c) => c.status !== "deleted");
      const drafts = await this.plugin.llm.writeCards(h, existing);

      // Build the card objects up front but keep them off `h.cards` until the
      // whole chain has run, so a half-applied critique can never be observed
      // by the inbox view mid-pass.
      const cards = drafts.map((d) =>
        makeCard(h.id, {
          kind: d.kind,
          front: d.kind === "qa" ? d.front.trim() : "",
          back: d.kind === "qa" ? d.back.trim() : "",
          text: d.kind === "cloze" ? d.text.trim() : "",
        }),
      );

      // Siblings are the other cards in THIS batch, never the pre-existing
      // ones: the duplicate/shared-answer warnings are about interference
      // inside a single generation. `existing` reaches the critique instead.
      const siblingsOf = (card: Card): Card[] => cards.filter((c) => c !== card);
      const lint = new Map<Card, LintResult>();
      for (const c of cards) lint.set(c, lintCard(c, h, siblingsOf(c)));

      // Precondition, not a final step: one card that lints clean is not worth
      // a second model call, so the critique is skipped before it is made.
      const trivial = cards.length <= 1 && (cards.length === 0 || lint.get(cards[0])!.failures.length === 0);
      if (settings.critiquePass && !trivial) {
        try {
          const verdicts = await this.plugin.llm.critiqueCards(h, cards, existing);
          for (const v of verdicts) {
            // Indices out of range are already filtered out by critiqueCards.
            const card = cards[v.index];
            if (!card) continue;
            card.bloom = v.bloom;
            // A verdict came back for this card, so the reviewer can trust the
            // absence of a complaint. Cards with no verdict keep critiqueRan unset.
            card.critiqueRan = true;
            if (v.verdict === "revise") {
              card.kind = v.kind;
              card.front = v.kind === "qa" ? v.front.trim() : "";
              card.back = v.kind === "qa" ? v.back.trim() : "";
              card.text = v.kind === "cloze" ? v.text.trim() : "";
              card.critiqueReason = v.reason;
              // The lint result on file describes the text the critique just
              // replaced, so it is re-run against the new fields (invariant 5:
              // grounding is checked mechanically, after the critique, whatever
              // the critique concluded).
              lint.set(card, lintCard(card, h, siblingsOf(card)));
            } else if (v.verdict === "drop") {
              // Never deleted, only flagged: the reviewer decides (invariant 3).
              card.status = "flagged";
              card.critiqueReason = v.reason;
            }
          }
        } catch (e) {
          // The critique is an enhancement, never a new failure mode. The
          // drafted cards survive exactly as written, still get linted below,
          // and critiqueRan stays unset so nothing implies they were checked.
          console.error("Recall: critique pass failed, keeping the drafted cards", e);
        }
      }

      // lintMode applies to the final set, after any revision.
      for (const c of cards) {
        const { failures, warnings } = lint.get(c)!;
        // Stored in every mode, including "badge", so the inbox can render them.
        if (failures.length) c.lintFailures = failures;
        // Warnings never flag a card; they are interference notes for the reviewer.
        if (warnings.length) c.lintWarnings = warnings;
        if (failures.length && settings.lintMode !== "badge") c.status = "flagged";
      }

      for (const c of cards) h.cards.push(c);
      const flagged = cards.filter((c) => c.status === "flagged").length;
      // A re-request that arrived mid-run set the status back to "queued";
      // overwriting it here would silently drop that request, since kick()
      // refuses to start a second run while this id is in `running`. The cast
      // widens the type TS narrowed to "generating" at the top of run() — the
      // await points above are exactly where enqueue() can have intervened.
      if ((h.status as Highlight["status"]) !== "queued") h.status = "ready";
      h.generatedAt = new Date().toISOString();
      h.error = null;
      if (this.plugin.settings.notifyWhenReady) {
        const label = h.title || h.text.slice(0, 40);
        const flaggedNote = flagged ? ` (${flagged} flagged)` : "";
        new Notice(`Recall: ${cards.length} card${cards.length === 1 ? "" : "s"} ready${flaggedNote} for “${label}”.`);
      }
    } catch (e) {
      if (this.stopped) {
        // Unloading: the request was aborted, so put the highlight back in the queue for next time.
        h.status = "queued";
        h.error = null;
      } else {
        h.status = "error";
        h.error = describeError(e);
        console.error("Recall: card writing failed", e);
      }
    }
    this.plugin.store.touch();
  }
}
