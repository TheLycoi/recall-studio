/**
 * The Obsidian half of the schema note: where `Recall/recall-rules.md` lives,
 * when it is created, and how a proposal becomes a rule inside it.
 *
 * `src/schemaNote.ts` is pure and does all the rendering and parsing; this file
 * is the part that touches the vault, and it holds one rule above the others:
 * the note belongs to the reader. It is created once, from the template, and
 * afterwards the only write the plugin ever makes to it is an append under
 * `## Learned`, and only when the reader has pressed Accept. Every write goes
 * through `vault.process` (read-modify-write in one step, obsidian.d.ts:7458),
 * so a rule promoted while the note is open in another pane cannot overwrite
 * what the reader typed there a second earlier.
 *
 * The other rule: a missing or unwritable schema must never stop a card being
 * written. Every read path here fails to `null` or `[]` and logs once, because
 * house rules are a refinement of the prompts and their absence is a prompt
 * without a refinement, not an error.
 */

import { TFile, TFolder, normalizePath } from "obsidian";
import { randomUUID } from "crypto";
import type RecallPlugin from "./main";
import { observe } from "./preferences";
import {
  appendLearnedRule,
  hasLearnedReceipt,
  parseProposals,
  parseSchema,
  persistProposalIdentity,
  renderDefaultSchema,
  renderEmptySuggestions,
  renderProposal,
  schemaBlocks,
  setProposalStatus,
  type Proposal,
} from "./schemaNote";

/**
 * How long a dismissed pattern stays quiet, in days.
 *
 * A dismissal is an answer about this evidence, not about this pattern
 * forever: the reader who says no to "keep answers under six words" after
 * four edits may well mean yes after forty. Re-proposing the next morning
 * would be nagging; never re-proposing would make one no permanent.
 */
const DISMISSED_QUIET_DAYS = 30;

export class SchemaFile {
  /**
   * The last parse, keyed by the note's mtime. Every model call asks for the
   * blocks, and re-reading and re-parsing a note nobody has touched for each
   * of them is work with a known answer.
   */
  private cache: { mtime: number; blocks: { cards: string } } | null = null;
  /** The last read of the suggestions file, so the header can ask for a count synchronously. */
  private lastProposals: Proposal[] = [];
  /** Set once the folder has proved uncreatable, so the console gets one line rather than one per call. */
  private folderFailed = false;
  private mutation: Promise<unknown> = Promise.resolve();

  constructor(private plugin: RecallPlugin) {}

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(action);
    this.mutation = result.catch(() => {});
    return result;
  }

  schemaPath(): string {
    return normalizePath(`${this.plugin.settings.schemaFolder}/recall-rules.md`);
  }

  suggestionsPath(): string {
    return normalizePath(`${this.plugin.settings.schemaFolder}/recall-suggestions.md`);
  }

  /**
   * The schema note, created from the template on first use and never
   * overwritten. Throws only when the vault refuses the write; callers that
   * cannot afford that catch it (`blocks`) and callers the reader asked for it
   * (the command) let the error surface.
   */
  async ensure(): Promise<TFile> {
    const path = this.schemaPath();
    const existing = this.plugin.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) return existing;
    await this.ensureFolder();
    const md = renderDefaultSchema({ today: new Date().toISOString().slice(0, 10) });
    return await this.plugin.app.vault.create(path, md); // obsidian.d.ts:7386
  }

  /** Create the folder on first use only. */
  private async ensureFolder(): Promise<void> {
    const folder = normalizePath(this.plugin.settings.schemaFolder);
    if (!folder || folder === "/") return;
    const existing = this.plugin.app.vault.getAbstractFileByPath(folder);
    if (existing instanceof TFolder) return;
    await this.plugin.app.vault.createFolder(folder); // obsidian.d.ts:7404
  }

  /**
   * The card house-rule block for the prompts, or null when there is no
   * schema to read. `cachedRead` rather than `read`, because this runs on the
   * path to every model call and the cache is exactly what it is for.
   */
  async blocks(): Promise<{ cards: string } | null> {
    try {
      const file = await this.ensure();
      const mtime = file.stat.mtime;
      if (this.cache && this.cache.mtime === mtime) return this.cache.blocks;
      const md = await this.plugin.app.vault.cachedRead(file); // obsidian.d.ts:7434
      const blocks = { cards: schemaBlocks(parseSchema(md)).cards };
      this.cache = { mtime, blocks };
      return blocks;
    } catch (e) {
      // A card must be written whether or not the reader has a schema, so this
      // is a log and a null, not a throw. Once, because it will be asked again
      // on the next highlight and the one after that.
      if (!this.folderFailed) {
        this.folderFailed = true;
        console.error("Recall Studio: could not read the schema note; house rules are not being applied", e);
      }
      return null;
    }
  }

  /** Every proposal in the suggestions file, in order. `[]` when the file is not there yet. */
  async proposals(): Promise<Proposal[]> {
    const file = this.plugin.app.vault.getAbstractFileByPath(this.suggestionsPath());
    if (!(file instanceof TFile)) {
      this.lastProposals = [];
      return [];
    }
    try {
      this.lastProposals = parseProposals(await this.plugin.app.vault.cachedRead(file));
    } catch (e) {
      console.error("Recall Studio: could not read the schema suggestions", e);
      this.lastProposals = [];
    }
    return this.lastProposals;
  }

  /** How many proposals are waiting, from the last read. Synchronous: the inbox header renders without awaiting. */
  openCount(): number {
    return this.lastProposals.filter((p) => p.status === "open").length;
  }

  async refresh(): Promise<void> {
    return this.serialize(() => this.refreshNow());
  }

  private async refreshNow(): Promise<void> {
    const proposals = await this.proposals();
    if (duplicateOccurrences(proposals).length === 0) return;
    const file = this.plugin.app.vault.getAbstractFileByPath(this.suggestionsPath());
    if (!(file instanceof TFile)) return;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const rules = this.plugin.app.vault.getAbstractFileByPath(this.schemaPath());
      const receipts = rules instanceof TFile ? await this.plugin.app.vault.cachedRead(rules) : "";
      await this.plugin.app.vault.process(file, md => {
        for (const p of parseProposals(md)) {
          if (p.status === "open" && hasLearnedReceipt(receipts, p.occurrenceId!)) {
            md = setProposalStatus(md, p.occurrenceId!, "applied", today);
          }
        }
        for (const p of duplicateOccurrences(parseProposals(md))) {
          md = setProposalStatus(md, p.occurrenceId!, "superseded", today);
        }
        return md;
      });
      await this.proposals();
    } catch (e) {
      console.error("Recall Studio: could not recover duplicate suggestions; all blocks were retained", e);
    }
  }

  /**
   * Read the reader's own card edits and write down the rules they imply that
   * have not been proposed yet. Returns how many were added, so the caller can
   * say so once rather than on every edit.
   *
   * Nothing here reaches the schema: a proposal is a question, and `## Learned`
   * only ever gains a line through `accept`.
   */
  async learn(today: string): Promise<number> {
    return this.serialize(() => this.learnNow(today));
  }

  private async learnNow(today: string): Promise<number> {
    const path = this.suggestionsPath();
    let file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      if (observe(this.plugin.store.revisions()).length === 0) return 0;
      await this.ensureFolder();
      file = await this.plugin.app.vault.create(path, renderEmptySuggestions(this.schemaPath()));
    }
    const rules = this.plugin.app.vault.getAbstractFileByPath(this.schemaPath());
    const receipts = rules instanceof TFile ? await this.plugin.app.vault.cachedRead(rules) : "";
    let inserted = 0;
    await this.plugin.app.vault.process(file as TFile, (md) => {
      const observations = observe(this.plugin.store.revisions());
      const seen = new Set<string>();
      const answered = parseProposals(md).filter(p => p.status !== "open");
      for (const p of parseProposals(md)) {
        if (p.status !== "open") continue;
        if (hasLearnedReceipt(receipts, p.occurrenceId!)) {
          md = setProposalStatus(md, p.occurrenceId!, "applied", today);
          continue;
        }
        const current = observations.find(o => o.id === p.id);
        if (!current || (this.unchangedSuggestion(p, current.rule) && p.rule !== current.rule)) {
          md = setProposalStatus(md, p.occurrenceId!, "withdrawn", today);
          continue;
        }
        if (this.alreadyAnswered(answered, p.id, today)) {
          md = setProposalStatus(md, p.occurrenceId!, "superseded", today);
          continue;
        }
        if (seen.has(p.id)) md = setProposalStatus(md, p.occurrenceId!, "superseded", today);
        seen.add(p.id);
      }
      const existing = parseProposals(md);
      const fresh = observations.filter(o => !this.alreadyAnswered(existing, o.id, today));
      inserted = fresh.length;
      if (!inserted) return md;
      const blocks = fresh.map(o => renderProposal({ ...o, occurrenceId: randomUUID(), date: today })).join("");
      return `${md.replace(/\n*$/, "\n")}\n${blocks}`;
    });
    await this.proposals();
    return inserted;
  }

  /**
   * Whether this observation has already had its answer: proposed and still
   * open, promoted into the schema, or dismissed recently enough that asking
   * again would be nagging. An unparseable status date counts as recent, so a
   * hand-edited file errs toward silence.
   */
  private alreadyAnswered(existing: Proposal[], id: string, today: string): boolean {
    for (const p of existing) {
      if (p.id !== id) continue;
      if (p.status === "open" || p.status === "applied") return true;
      if (p.status === "dismissed") {
        const since = daysBetween(p.statusDate ?? p.date, today);
        if (since === null || since < DISMISSED_QUIET_DAYS) return true;
      }
    }
    return false;
  }

  /**
   * Promote one proposal's rule into `## Learned`, in the wording the reader
   * left in the box — they may have rewritten it, and what they typed is the
   * rule, not what was suggested.
   *
   * The schema is written before the proposal is stamped: if the second write
   * fails, the occurrence receipt lets a retry finish the stamp without
   * appending the rule again. The other order could claim a rule was applied
   * without ever saving it.
   */
  async accept(id: string, rule: string, today: string): Promise<void> {
    return this.serialize(() => this.acceptNow(id, rule, today));
  }

  private unchangedSuggestion(proposal: Proposal, currentRule: string): boolean {
    if (proposal.suggestedRule !== undefined) return proposal.rule === proposal.suggestedRule;
    // Legacy caps have no original-wording metadata; retain the block even when withdrawing it.
    return proposal.id === "shorter-answers"
      ? /^Keep answers to at most \d+ words\.$/.test(proposal.rule)
      : proposal.rule === currentRule;
  }

  private checkSupport(proposal: Proposal, text: string): void {
    const current = observe(this.plugin.store.revisions()).find(o => o.id === proposal.id);
    if (!current) throw new Error("This suggestion no longer has enough retained evidence. Refresh suggestions before accepting it.");
    if (text === proposal.rule && this.unchangedSuggestion(proposal, current.rule) && text !== current.rule) {
      throw new Error("The evidence has changed since this rule was suggested. Refresh suggestions or review your custom wording.");
    }
  }

  private async acceptNow(id: string, rule: string, today: string): Promise<void> {
    const text = rule.trim();
    if (!text) return;
    const proposals = await this.proposals();
    const proposal = proposals.find(p => p.occurrenceId === id)
      ?? proposals.find(p => p.id === id && p.status === "open");
    if (!proposal) throw new Error("This suggestion is no longer open. Refresh suggestions.");
    const occurrenceId = proposal.occurrenceId!;
    const existing = this.plugin.app.vault.getAbstractFileByPath(this.schemaPath());
    const recorded = existing instanceof TFile
      && hasLearnedReceipt(await this.plugin.app.vault.cachedRead(existing), occurrenceId);
    if (!recorded) {
      if (proposal.status !== "open") throw new Error("This suggestion is no longer open. Refresh suggestions.");
      this.checkSupport(proposal, text);
    }
    if (recorded && proposal.status === "applied") return;
    const suggestions = this.plugin.app.vault.getAbstractFileByPath(this.suggestionsPath());
    if (!(suggestions instanceof TFile)) throw new Error("The suggestions note is missing. Restore it before retrying.");
    if (!recorded && occurrenceId.startsWith("legacy:")) {
      await this.plugin.app.vault.process(suggestions, md => persistProposalIdentity(md, occurrenceId));
    }
    const file = await this.ensure();
    await this.plugin.app.vault.process(file, (md) => {
      if (hasLearnedReceipt(md, occurrenceId)) return md;
      this.checkSupport(proposal, text);
      return appendLearnedRule(md, text, { date: today, count: proposal.count, occurrenceId });
    }); // obsidian.d.ts:7458
    // The note has changed, so the cached blocks describe the previous version.
    this.cache = null;
    try {
      await this.stamp(occurrenceId, "applied", today);
    } catch {
      throw new Error("The rule is saved, but its suggestion could not be marked applied. Retry Accept to finish; it will not add the rule twice.");
    }
  }

  async dismiss(id: string, today: string): Promise<void> {
    return this.serialize(async () => {
      const proposals = await this.proposals();
      const proposal = proposals.find(p => p.occurrenceId === id)
        ?? proposals.find(p => p.id === id && p.status === "open");
      const rules = this.plugin.app.vault.getAbstractFileByPath(this.schemaPath());
      if (proposal && rules instanceof TFile
        && hasLearnedReceipt(await this.plugin.app.vault.cachedRead(rules), proposal.occurrenceId!)) {
        throw new Error("This rule is already saved. Retry Accept to finish its status; delete the rule from the rules note if you want to unlearn it.");
      }
      await this.stamp(id, "dismissed", today);
    });
  }

  private async stamp(id: string, status: "applied" | "dismissed", today: string): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(this.suggestionsPath());
    if (!(file instanceof TFile)) throw new Error("The suggestions note is missing. Restore it before retrying.");
    await this.plugin.app.vault.process(file, (md) => {
      const proposals = parseProposals(md);
      const target = proposals.find(p => p.occurrenceId === id)
        ?? proposals.find(p => p.id === id && p.status === "open");
      if (!target) throw new Error("The selected suggestion is missing. Refresh suggestions.");
      if (target.status === status) return md;
      if (target.status !== "open") throw new Error("The selected suggestion is no longer open. Refresh suggestions.");
      return setProposalStatus(md, target.occurrenceId!, status, today);
    });
    await this.proposals();
  }
}

/** Keep every block, but expose only one unanswered occurrence for each pattern. */
function duplicateOccurrences(proposals: Proposal[]): Proposal[] {
  const seen = new Set(proposals.filter(p => p.status === "applied").map(p => p.id));
  return proposals.filter(p => {
    if (p.status !== "open") return false;
    if (seen.has(p.id)) return true;
    seen.add(p.id);
    return false;
  });
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`, or null when either is unreadable. */
function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.floor((b - a) / 86_400_000);
}
