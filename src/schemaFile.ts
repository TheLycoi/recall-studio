/**
 * The Obsidian half of the schema note: where `schema/wikilm.md` lives, when it
 * is created, and how a proposal becomes a rule inside it.
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
import type WikiLmPlugin from "./main";
import { observe } from "./preferences";
import {
  appendLearnedRule,
  parseProposals,
  parseSchema,
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
  private cache: { mtime: number; blocks: { cards: string; wiki: string } } | null = null;
  /** The last read of the suggestions file, so the header can ask for a count synchronously. */
  private lastProposals: Proposal[] = [];
  /** Set once the folder has proved uncreatable, so the console gets one line rather than one per call. */
  private folderFailed = false;

  constructor(private plugin: WikiLmPlugin) {}

  schemaPath(): string {
    return normalizePath(`${this.plugin.settings.schemaFolder}/wikilm.md`);
  }

  suggestionsPath(): string {
    return normalizePath(`${this.plugin.settings.schemaFolder}/wikilm-suggestions.md`);
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
    const s = this.plugin.settings;
    const md = renderDefaultSchema({
      topicFolder: s.topicFolder,
      manifestFolder: s.manifestFolder,
      schemaPath: path,
      today: new Date().toISOString().slice(0, 10),
    });
    return await this.plugin.app.vault.create(path, md); // obsidian.d.ts:7386
  }

  /** Same pattern as `writeManifest` (src/pdfHighlights.ts:369): create the folder on first use only. */
  private async ensureFolder(): Promise<void> {
    const folder = normalizePath(this.plugin.settings.schemaFolder);
    if (!folder || folder === "/") return;
    const existing = this.plugin.app.vault.getAbstractFileByPath(folder);
    if (existing instanceof TFolder) return;
    await this.plugin.app.vault.createFolder(folder); // obsidian.d.ts:7404
  }

  /**
   * The two house-rule blocks for the prompts, or null when there is no schema
   * to read. `cachedRead` rather than `read`, because this runs on the path to
   * every model call and the cache is exactly what it is for.
   */
  async blocks(): Promise<{ cards: string; wiki: string } | null> {
    try {
      const file = await this.ensure();
      const mtime = file.stat.mtime;
      if (this.cache && this.cache.mtime === mtime) return this.cache.blocks;
      const md = await this.plugin.app.vault.cachedRead(file); // obsidian.d.ts:7434
      const blocks = schemaBlocks(parseSchema(md));
      this.cache = { mtime, blocks };
      return blocks;
    } catch (e) {
      // A card must be written whether or not the reader has a schema, so this
      // is a log and a null, not a throw. Once, because it will be asked again
      // on the next highlight and the one after that.
      if (!this.folderFailed) {
        this.folderFailed = true;
        console.error("WikiLM: could not read the schema note; house rules are not being applied", e);
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
      console.error("WikiLM: could not read the schema suggestions", e);
      this.lastProposals = [];
    }
    return this.lastProposals;
  }

  /** How many proposals are waiting, from the last read. Synchronous: the inbox header renders without awaiting. */
  openCount(): number {
    return this.lastProposals.filter((p) => p.status === "open").length;
  }

  async refresh(): Promise<void> {
    await this.proposals();
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
    const observations = observe(this.plugin.store.revisions());
    if (observations.length === 0) return 0;
    const existing = await this.proposals();
    const fresh = observations.filter((o) => !this.alreadyAnswered(existing, o.id, today));
    if (fresh.length === 0) return 0;

    const path = this.suggestionsPath();
    let file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      await this.ensureFolder();
      file = await this.plugin.app.vault.create(path, renderEmptySuggestions(this.schemaPath()));
    }
    const blocks = fresh.map((o) => renderProposal({ ...o, date: today })).join("");
    await this.plugin.app.vault.process(file as TFile, (md) => `${md.replace(/\n*$/, "\n")}\n${blocks}`);
    await this.refresh();
    return fresh.length;
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
      const since = daysBetween(p.statusDate ?? p.date, today);
      if (since === null || since < DISMISSED_QUIET_DAYS) return true;
    }
    return false;
  }

  /**
   * Promote one proposal's rule into `## Learned`, in the wording the reader
   * left in the box — they may have rewritten it, and what they typed is the
   * rule, not what was suggested.
   *
   * The schema is written before the proposal is stamped: if the second write
   * fails, the reader has their rule and an entry still marked open, which
   * they can dismiss. The other order would lose the rule and claim it was
   * applied.
   */
  async accept(id: string, rule: string, today: string): Promise<void> {
    const text = rule.trim();
    if (!text) return;
    const proposal = this.lastProposals.find((p) => p.id === id);
    const file = await this.ensure();
    await this.plugin.app.vault.process(file, (md) =>
      appendLearnedRule(md, text, { date: today, count: proposal?.count ?? 0 }),
    ); // obsidian.d.ts:7458
    // The note has changed, so the cached blocks describe the previous version.
    this.cache = null;
    await this.stamp(id, "applied", today);
  }

  async dismiss(id: string, today: string): Promise<void> {
    await this.stamp(id, "dismissed", today);
  }

  private async stamp(id: string, status: "applied" | "dismissed", today: string): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(this.suggestionsPath());
    if (file instanceof TFile) {
      await this.plugin.app.vault.process(file, (md) => setProposalStatus(md, id, status, today));
    }
    await this.refresh();
  }
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`, or null when either is unreadable. */
function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.floor((b - a) / 86_400_000);
}
