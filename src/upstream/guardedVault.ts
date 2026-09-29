/**
 * The vault upstream's engine is handed: Obsidian's own, behind a guard that
 * keeps what the reader wrote.
 *
 * Upstream's body merge deletes every `##` section whose heading is not one
 * of its own labels, keeps the text before the first `##` only if the model
 * copies it, and makes no backup; `reviewed: true` does not stop it. The
 * vendored code is not edited, so the guard sits where every one of its
 * writes lands: the `App` the host builds the engine with. Its vault,
 * adapter and file manager are wrapped (the list, with file and line, is in
 * the final-fix report); everything else passes through.
 *
 * Code decides what reaches a page, in three rules:
 *
 * - Before an existing file is overwritten, its text is saved under the
 *   plugin's own folder, in one folder per run named by its start time,
 *   keeping the file's vault path. The last 20 runs are kept.
 * - A rewrite that would drop a heading, a quote or callout line, a PDF link,
 *   an embed or a frontmatter key (lostContent) is refused: the page keeps
 *   its text, the proposed text is saved beside the snapshot as
 *   `<name>.proposed.md`, and the page is held for the rest of the run. The
 *   engine's write returns as if it had landed, so it neither fails the
 *   source nor retries; WikiLM's report lists the page under "Not updated,
 *   to keep what was there" and not among the updated pages.
 * - A file that existed before the run is never removed or moved. A file the
 *   engine created in this run is its own: it may rewrite, move or remove it
 *   unchecked (the summary page of a cancelled run is trashed so the note
 *   re-ingests).
 *
 * New files are written normally. The wiki's index.md and log.md, which
 * upstream regenerates on every run, skip the loss check (the host says which
 * paths through `exempt`) but are still saved first.
 */
import type { App, DataAdapter, DataWriteOptions, FileManager, TAbstractFile, TFile, Vault } from "obsidian";

// ---------------------------------------------------------------- the loss check

export type LossKind = "heading" | "frontmatter-key" | "quote" | "embed" | "pdf-link";

/** One thing the old text had and the new text lacks, and the old line that held it. */
export interface Loss {
  kind: LossKind;
  /** What is compared: a heading case-folded, a quote line, a link or embed target, a key. */
  key: string;
  line: string;
}

const HEADING = /^\s{0,3}#{1,6}(?:\s|$)/;
const QUOTE = /^\s*>/;
// A wikilink or embed to a PDF: the file, then its subpath (#page=…&selection=… or &rect=…).
const WIKI_PDF = /!?\[\[([^\]|#]*\.pdf)(#[^\]|]*)?(?:\|[^\]]*)?\]\]/gi;
// A Markdown link to a PDF, with or without angle brackets and a title.
const MD_PDF = /\[[^\]]*\]\(<?([^)\s>]*\.pdf)(#[^)\s>]*)?>?(?:\s+"[^"]*")?\)/gi;
const EMBED = /!\[\[([^\]]+)\]\]/g;
// A top-level frontmatter key; an indented line or a list item is part of a value.
const KEY = /^([^\s\-#:][^:]*?)\s*:(?:\s|$)/;

/** The frontmatter's key lines and the body's lines. Frontmatter values are not protected. */
function splitFrontmatter(text: string): { keys: Array<{ key: string; line: string }>; body: string[] } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && (l.trim() === "---" || l.trim() === "..."));
    if (end > 0) {
      const keys = lines.slice(1, end).flatMap((raw) => {
        const k = KEY.exec(raw);
        return k ? [{ key: k[1].trim(), line: raw.trimEnd() }] : [];
      });
      return { keys, body: lines.slice(end + 1) };
    }
  }
  return { keys: [], body: lines };
}

/** Everything in a text the loss check protects, in the order it appears. */
function protectedItems(text: string): Loss[] {
  const { keys, body } = splitFrontmatter(text);
  const out: Loss[] = keys.map((k) => ({ kind: "frontmatter-key", key: k.key, line: k.line }));
  for (const raw of body) {
    const line = raw.trimEnd();
    if (HEADING.test(line)) out.push({ kind: "heading", key: line.trim().toLowerCase(), line });
    if (QUOTE.test(line)) out.push({ kind: "quote", key: line, line });
    for (const e of line.matchAll(EMBED)) out.push({ kind: "embed", key: e[1].split("|")[0].trim(), line });
    for (const p of [...line.matchAll(WIKI_PDF), ...line.matchAll(MD_PDF)]) out.push({ kind: "pdf-link", key: p[1] + (p[2] ?? ""), line });
  }
  return out;
}

/**
 * What a rewrite from `oldText` to `newText` would lose. Pure.
 *
 * Protected, and compared this way:
 * - a heading line of any level, trimmed and case-folded;
 * - a blockquote or callout line (one starting with `>`), with trailing
 *   whitespace trimmed;
 * - a link or embed to a PDF, wiki or Markdown, by its target including the
 *   `#page=` and selection or rect parameters (the display text may change);
 * - an embed of any kind, by its target;
 * - a frontmatter key; its value may change (`updated`, `sources`).
 *
 * Prose may change and lines may move. Each thing lost is listed once. A
 * heading, quote or link inside a code block counts too: the check errs
 * towards refusing.
 */
export function lostContent(oldText: string, newText: string): Loss[] {
  const id = (x: Loss) => `${x.kind}\u0000${x.key}`;
  const kept = new Set(protectedItems(newText).map(id));
  const seen = new Set<string>();
  return protectedItems(oldText).filter((x) => {
    const k = id(x);
    if (kept.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** How many lines of the old text the losses take with them: a callout header that is also a PDF link is one line. */
export function droppedLines(lost: Loss[]): number {
  return new Set(lost.map((x) => x.line)).size;
}

const KIND_ORDER: LossKind[] = ["heading", "frontmatter-key", "quote", "embed", "pdf-link"];
const KIND_WORD: Record<LossKind, [string, string]> = {
  heading: ["heading", "headings"],
  "frontmatter-key": ["frontmatter key", "frontmatter keys"],
  quote: ["quote line", "quote lines"],
  embed: ["embed", "embeds"],
  "pdf-link": ["PDF link", "PDF links"],
};

/** The losses in words, each line counted once under its first kind: "3 lines (1 heading, 2 quote lines)". */
export function describeLoss(lost: Loss[]): string {
  const kindOf = new Map<string, LossKind>();
  for (const x of lost) {
    const had = kindOf.get(x.line);
    if (!had || KIND_ORDER.indexOf(x.kind) < KIND_ORDER.indexOf(had)) kindOf.set(x.line, x.kind);
  }
  const counts = KIND_ORDER.map((k) => [k, [...kindOf.values()].filter((v) => v === k).length] as const).filter(([, n]) => n > 0);
  const n = kindOf.size;
  return `${n} line${n === 1 ? "" : "s"} (${counts.map(([k, c]) => `${c} ${KIND_WORD[k][c === 1 ? 0 : 1]}`).join(", ")})`;
}

// ---------------------------------------------------------------- the guard

/** A change the guard would not let through. */
export interface GuardRefusal {
  path: string;
  action: "rewrite" | "remove" | "rename";
  /** Lines of the old text the rewrite would have dropped (droppedLines). */
  dropped: number;
  lost: Loss[];
  /** Where the proposed text was saved; null when there is none to save. */
  proposal: string | null;
  /** A rename's target. */
  to?: string;
  /** Why, in words, when the loss check could not be run. */
  detail?: string;
  /** Later writes to the page in the same run, refused with it. */
  held: number;
}

/** Runs of snapshots kept under the plugin folder; older ones are removed when a run saves its first. */
export const SNAPSHOT_RUNS_KEPT = 20;

/**
 * Wraps an `App` so that every call that can change or remove a file goes
 * through the rules in the header. `app` is the wrapped view; hand it to the
 * engine. `begin()` starts a run: a new snapshot folder, and nothing created
 * or held yet.
 */
export class WriteGuard {
  readonly app: App;
  /** What this run refused, in order. */
  refusals: GuardRefusal[] = [];
  /** This run's snapshot folder, once something has been saved into it. */
  runFolder: string | null = null;

  private created = new Set<string>();
  private saved = new Set<string>();
  private held = new Map<string, GuardRefusal>();
  private folder: Promise<string> | null = null;
  private chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly real: App,
    private readonly pluginDir: string,
    private readonly exempt: (path: string) => boolean,
    private readonly now: () => Date = () => new Date(),
  ) {
    const vault = real.vault;
    const adapter = vault.adapter;
    const readFile = (file: TFile) => () => vault.read(file);
    // Compare-and-set through process(): the new text lands only if the file
    // still holds the text the check was run on.
    const setFile = (file: TFile, options?: DataWriteOptions) => async (expect: string, next: string) => {
      let landed = false;
      await vault.process(file, (data) => (data === expect ? ((landed = true), next) : data), options);
      return landed;
    };
    const setPath = (path: string, options?: DataWriteOptions) => async (expect: string, next: string) => {
      let landed = false;
      await adapter.process(path, (data) => (data === expect ? ((landed = true), next) : data), options);
      return landed;
    };
    const binary = "a binary overwrite of an existing file, which WikiLM cannot check";

    const guardedAdapter = overlay<DataAdapter>(adapter, {
      write: async (path, data, options) => {
        if (!(await adapter.exists(path))) return this.creating(path, () => adapter.write(path, data, options));
        await this.rewrite(path, () => adapter.read(path), () => data, setPath(path, options));
      },
      writeBinary: async (path, data, options) => {
        if (!(await adapter.exists(path))) return this.creating(path, () => adapter.writeBinary(path, data, options));
        await this.unchecked(path, binary, () => adapter.writeBinary(path, data, options));
      },
      append: async (path, data, options) => {
        if (!(await adapter.exists(path))) return this.creating(path, () => adapter.append(path, data, options));
        await this.rewrite(path, () => adapter.read(path), (old) => old + data, setPath(path, options));
      },
      appendBinary: async (path, data, options) => {
        if (!(await adapter.exists(path))) return this.creating(path, () => adapter.appendBinary(path, data, options));
        await this.unchecked(path, binary, () => adapter.appendBinary(path, data, options));
      },
      process: (path, fn, options) => this.rewrite(path, () => adapter.read(path), fn, setPath(path, options)),
      copy: async (path, to) => {
        if (!(await adapter.exists(to))) return this.creating(to, () => adapter.copy(path, to));
        const text = await adapter.read(path);
        await this.rewrite(to, () => adapter.read(to), () => text, setPath(to));
      },
      remove: async (path) => void (await this.removing(path, () => adapter.remove(path))),
      rmdir: async (path, recursive) => void (await this.removing(path, () => adapter.rmdir(path, recursive))),
      trashSystem: async (path) => {
        let trashed = false;
        await this.removing(path, async () => void (trashed = await adapter.trashSystem(path)));
        return trashed;
      },
      trashLocal: async (path) => void (await this.removing(path, () => adapter.trashLocal(path))),
      rename: async (path, to) => void (await this.moving(path, to, () => adapter.rename(path, to))),
    });

    const guardedVault = overlay<Vault>(vault, {
      adapter: guardedAdapter,
      create: async (path, data, options) => this.creating(path, () => vault.create(path, data, options)),
      createBinary: async (path, data, options) => this.creating(path, () => vault.createBinary(path, data, options)),
      modify: async (file, data, options) => void (await this.rewrite(file.path, readFile(file), () => data, setFile(file, options))),
      append: async (file, data, options) => void (await this.rewrite(file.path, readFile(file), (old) => old + data, setFile(file, options))),
      process: (file, fn, options) => this.rewrite(file.path, readFile(file), fn, setFile(file, options)),
      modifyBinary: (file, data, options) => this.unchecked(file.path, binary, () => vault.modifyBinary(file, data, options)),
      appendBinary: (file, data, options) => this.unchecked(file.path, binary, () => vault.appendBinary(file, data, options)),
      copy: async <T extends TAbstractFile>(file: T, to: string): Promise<T> => this.creating(to, () => vault.copy(file, to)),
      delete: async (file, force) => void (await this.removing(file.path, () => vault.delete(file, force))),
      trash: async (file, system) => void (await this.removing(file.path, () => vault.trash(file, system))),
      rename: async (file, to) => void (await this.moving(file.path, to, () => vault.rename(file, to))),
    });

    const files = real.fileManager;
    const guardedFiles = overlay<FileManager>(files, {
      renameFile: async (file, to) => void (await this.moving(file.path, to, () => files.renameFile(file, to))),
      trashFile: async (file) => void (await this.removing(file.path, () => files.trashFile(file))),
      processFrontMatter: (file, fn, options) =>
        this.unchecked(file.path, "an in-place frontmatter edit, which WikiLM cannot check before it is written", () => files.processFrontMatter(file, fn, options)),
    });

    this.app = overlay<App>(real, { vault: guardedVault, fileManager: guardedFiles });
  }

  /** Start a run: a fresh snapshot folder on first use, nothing created, held or refused yet. */
  begin(): void {
    this.refusals = [];
    this.runFolder = null;
    this.folder = null;
    this.created.clear();
    this.saved.clear();
    this.held.clear();
  }

  /** Whether a write to the page was refused in this run, which holds it until the run ends. */
  isHeld(path: string): boolean {
    return this.held.has(path);
  }

  // ---- the three rules

  private async creating<T>(path: string, write: () => Promise<T>): Promise<T> {
    const out = await write();
    const made = (out as { path?: unknown } | undefined)?.path;
    this.created.add(typeof made === "string" ? made : path);
    return out;
  }

  /**
   * One rewrite of an existing file: the new text is `compute(old)`. Returns
   * the text the file holds afterwards, which is the old text when refused.
   */
  private rewrite(path: string, read: () => Promise<string>, compute: (old: string) => string, set: (expect: string, next: string) => Promise<boolean>): Promise<string> {
    return this.serial(path, async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const old = await read();
        const hold = this.held.get(path);
        if (hold) {
          hold.held++;
          return old;
        }
        const next = compute(old);
        if (next === old) return old;
        if (!this.created.has(path)) {
          const lost = this.exempt(path) ? [] : lostContent(old, next);
          if (lost.length > 0) {
            await this.refuse(path, old, next, lost);
            return old;
          }
          await this.snapshot(path, old);
        }
        if (await set(old, next)) return next;
        // Changed between the read and the write (the reader typing into it):
        // check again against what it holds now.
      }
      throw new Error(`WikiLM left ${path} as it was: it kept changing while the engine was writing to it.`);
    });
  }

  private async refuse(path: string, old: string, next: string, lost: Loss[]): Promise<void> {
    await this.snapshot(path, old);
    const proposal = `${await this.runDir()}/${path.replace(/\.md$/i, "")}.proposed.md`;
    await this.save(proposal, next);
    const entry: GuardRefusal = { path, action: "rewrite", dropped: droppedLines(lost), lost, proposal, held: 0 };
    this.refusals.push(entry);
    this.held.set(path, entry);
  }

  /** A change the loss check cannot read: allowed on the engine's own files, refused on any other. */
  private unchecked(path: string, what: string, write: () => Promise<void>): Promise<void> {
    return this.serial(path, async () => {
      if (this.created.has(path)) return write();
      const entry: GuardRefusal = { path, action: "rewrite", dropped: 0, lost: [], proposal: null, detail: `the engine asked for ${what}`, held: 0 };
      this.refusals.push(entry);
      this.held.set(path, entry);
    });
  }

  private removing(path: string, remove: () => Promise<void>): Promise<void> {
    return this.serial(path, async () => {
      if (!this.created.has(path)) {
        this.refusals.push({ path, action: "remove", dropped: 0, lost: [], proposal: null, held: 0 });
        return;
      }
      await remove();
      this.created.delete(path);
    });
  }

  private moving(path: string, to: string, move: () => Promise<void>): Promise<void> {
    return this.serial(path, async () => {
      if (!this.created.has(path)) {
        this.refusals.push({ path, action: "rename", dropped: 0, lost: [], proposal: null, to, held: 0 });
        return;
      }
      await move();
      this.created.delete(path);
      this.created.add(to);
    });
  }

  // ---- snapshots, under the plugin folder through the real adapter

  /** The file's text before this run first changed it; later texts in the run are the engine's own. */
  private async snapshot(path: string, text: string): Promise<void> {
    if (this.saved.has(path)) return;
    await this.save(`${await this.runDir()}/${path}`, text);
    this.saved.add(path);
  }

  private runDir(): Promise<string> {
    this.folder ??= (async () => {
      const adapter = this.real.vault.adapter;
      const root = `${this.pluginDir}/snapshots`;
      const stamp = this.now().toISOString().replace(/[:.]/g, "-");
      let dir = `${root}/${stamp}`;
      for (let n = 2; await adapter.exists(dir); n++) dir = `${root}/${stamp}-${n}`;
      await this.mkdirs(dir);
      this.runFolder = dir;
      // Timestamped names sort as the runs happened.
      const runs = (await adapter.list(root)).folders.sort();
      for (const old of runs.slice(0, Math.max(0, runs.length - SNAPSHOT_RUNS_KEPT))) await adapter.rmdir(old, true);
      return dir;
    })();
    return this.folder;
  }

  private async save(path: string, text: string): Promise<void> {
    await this.mkdirs(path.slice(0, path.lastIndexOf("/")));
    await this.real.vault.adapter.write(path, text);
  }

  private async mkdirs(dir: string): Promise<void> {
    const adapter = this.real.vault.adapter;
    const parts = dir.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const at = parts.slice(0, i).join("/");
      if (!(await adapter.exists(at))) await adapter.mkdir(at);
    }
  }

  /** Calls on one path, one at a time, so a check and its write are not interleaved with another's. */
  private serial<T>(path: string, run: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(path) ?? Promise.resolve()).then(run, run);
    const tail = next.catch(() => undefined);
    this.chains.set(path, tail);
    void tail.then(() => {
      if (this.chains.get(path) === tail) this.chains.delete(path);
    });
    return next;
  }
}

/**
 * `target` with some members replaced. Everything else is read from the
 * target itself, and methods are bound to it, so Obsidian's own objects run
 * as they always do.
 */
function overlay<T extends object>(target: T, replace: Partial<T>): T {
  return new Proxy(target, {
    get(t, key) {
      if (Object.prototype.hasOwnProperty.call(replace, key)) return (replace as Record<PropertyKey, unknown>)[key];
      const value: unknown = Reflect.get(t, key, t);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(t) : value;
    },
  });
}
