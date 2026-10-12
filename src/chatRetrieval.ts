/**
 * Local retrieval for Chat: it reads eligible Markdown notes and PDFs, ranks a
 * bounded set of passages for the question, and reports what it searched and
 * skipped. Nothing leaves the machine — no OCR, no vector service, no network,
 * no new dependency.
 *
 * The reader is the vault and Obsidian's own PDF viewer (`loadPdfDocument`,
 * src/pdf.ts), which is why PDFs work without adding a parser or touching the
 * captured-highlight store: a PDF page the reader never captured is still
 * searchable. Extraction is cached per file version (`mtime` + `size`) so a
 * repeat question does not re-read the vault, and the cache drops an entry the
 * moment its file changes, disappears, or falls outside the allowed paths —
 * exclusions are enforced before any read or cache use, so an excluded file's
 * text can never reach the model.
 *
 * Ranking reuses `selectChatPassages` (src/reviewChat.ts): local term relevance
 * over 1200-character windows, top 40, each keeping its original Markdown line
 * or PDF page for opening the exact passage.
 */
import type { App, TFile } from "obsidian";
import { loadPdfDocument } from "./pdf";
import { selectChatPassages, type ChatSeed } from "./reviewChat";

/** Markdown longer than this is not searched (characters). */
const MD_MAX_CHARS = 1_000_000;
/** PDFs larger than this, or longer than the page cap, are not searched. */
const PDF_MAX_BYTES = 40_000_000;
const PDF_MAX_PAGES = 500;
/** Upper bound on the characters the extraction cache may hold at once. */
const CACHE_MAX_CHARS = 12_000_000;
/** Most ranked passages returned for one question. */
const RESULT_LIMIT = 40;

export interface ChatSearchOptions {
  /**
   * Exact source scope. `undefined` searches every eligible Markdown note and
   * PDF the allowed-path predicate passes; an empty array searches nothing;
   * a list searches only those paths (still filtered by allowed-path first).
   */
  paths?: readonly string[];
  /**
   * Extra terms the model suggested. They widen ranking only — they are search
   * hints, never evidence: passages always come from the vault.
   */
  terms?: readonly string[];
  /** Polled between sources and between PDF pages; a true return stops early. */
  cancelled?: () => boolean;
}

export interface ChatSearchResult {
  /** The ranked passages, most relevant first (≤ RESULT_LIMIT, each ≤ 1200 chars). */
  seeds: ChatSeed[];
  /** Sources read (or served from cache) into the ranking pool. */
  searched: number;
  /** Human reasons for sources that were not searched: errors, image-only, bounds. */
  skipped: string[];
}

/** Extracted passages of one file, valid only for the version it was read at. */
interface CacheEntry {
  mtime: number;
  size: number;
  chars: number;
  seeds: ChatSeed[];
}

/** Let the event loop run between PDF pages so a long read cannot freeze the UI. */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class ChatRetriever {
  private cache = new Map<string, CacheEntry>();
  private cacheChars = 0;
  private cancelled: () => boolean = () => false;

  constructor(
    private app: App,
    private allowedPath: (path: string) => boolean,
  ) {}

  async search(question: string, options: ChatSearchOptions = {}): Promise<ChatSearchResult> {
    this.cancelled = options.cancelled ?? (() => false);

    const all = this.app.vault.getFiles?.() ?? [];
    this.prune(all);
    const wanted = options.paths === undefined ? all : all.filter((f) => new Set(options.paths).has(f.path));
    const scoped = wanted.filter((f) => this.retrievable(f));

    const skipped: string[] = [];
    const pool: ChatSeed[] = [];
    let searched = 0;
    for (const f of scoped) {
      if (this.cancelled()) break;
      const seeds = await this.source(f, skipped);
      if (seeds) {
        pool.push(...seeds);
        searched++;
      }
    }

    const terms = (options.terms ?? []).filter((t) => typeof t === "string" && t.trim() !== "");
    const query = terms.length ? `${question} ${terms.join(" ")}` : question;
    return { seeds: selectChatPassages(pool, query, RESULT_LIMIT), searched, skipped };
  }

  /** A file the retriever may index: Markdown or PDF, and allowed by the host. */
  private retrievable(f: TFile): boolean {
    const ext = f.extension?.toLowerCase();
    if (ext !== "md" && ext !== "pdf") return false;
    return this.allowedPath(f.path);
  }

  /** Drop cached text for files that no longer exist or are no longer allowed. */
  private prune(all: readonly TFile[]): void {
    const present = new Set(all.map((f) => f.path));
    for (const key of [...this.cache.keys()]) {
      if (!present.has(key) || !this.allowedPath(key)) this.drop(key);
    }
  }

  private drop(path: string): void {
    const entry = this.cache.get(path);
    if (entry) {
      this.cacheChars -= entry.chars;
      this.cache.delete(path);
    }
  }

  /** Cache `entry`, evicting the least recently added text once over the cap. */
  private store(path: string, entry: CacheEntry): void {
    this.cache.set(path, entry);
    this.cacheChars += entry.chars;
    for (let key = this.cache.keys().next().value; this.cacheChars > CACHE_MAX_CHARS; key = this.cache.keys().next().value) {
      if (key === undefined) break;
      this.drop(key);
    }
  }

  /** The extracted passages of `f`, from cache or by reading it; null when skipped. */
  private async source(f: TFile, skipped: string[]): Promise<ChatSeed[] | null> {
    // Scope and exclusions are enforced before any read or cache use.
    if (!this.allowedPath(f.path)) {
      this.drop(f.path);
      return null;
    }

    const size = f.stat?.size ?? 0;
    const mtime = f.stat?.mtime ?? 0;
    const isPdf = f.extension?.toLowerCase() === "pdf";
    if (size > (isPdf ? PDF_MAX_BYTES : MD_MAX_CHARS)) {
      this.drop(f.path);
      skipped.push(`${f.path}: larger than the ${isPdf ? "40 MB" : "1 MB"} search limit`);
      return null;
    }

    const cached = this.cache.get(f.path);
    if (cached && cached.mtime === mtime && cached.size === size) return cached.seeds;
    if (cached) this.drop(f.path);

    let seeds: ChatSeed[] | null;
    try {
      seeds = isPdf ? await this.readPdf(f) : [{ ...(await this.readMarkdown(f)) }];
    } catch (e) {
      this.drop(f.path);
      skipped.push(`${f.path}: ${message(e)}`);
      return null;
    }
    // Cancelled mid-read: report nothing and cache nothing (a partial read must
    // not be stored under the file's real version).
    if (seeds === null) return null;

    const chars = seeds.reduce((n, s) => n + s.text.length, 0);
    if (chars === 0) {
      skipped.push(`${f.path}: no extractable text`);
      return null;
    }
    this.store(f.path, { mtime, size, chars, seeds });
    return seeds;
  }

  /** The file's text and identity, as one candidate seed (`selectChatPassages` splits it). */
  private async readMarkdown(f: TFile): Promise<ChatSeed> {
    const text = await this.app.vault.cachedRead(f);
    return { path: f.path, title: f.basename, page: null, line: 1, kind: "note", text };
  }

  /**
   * One seed per text-bearing page, so a passage keeps its PDF page. Returns
   * null when cancelled mid-loop. `doc.destroy()` always runs — the document
   * holds a worker and page caches, and pdf.ts requires the caller to release
   * it.
   */
  private async readPdf(f: TFile): Promise<ChatSeed[] | null> {
    const doc = await loadPdfDocument(this.app, f);
    try {
      if (doc.numPages > PDF_MAX_PAGES) throw new Error(`more than ${PDF_MAX_PAGES} pages`);
      const seeds: ChatSeed[] = [];
      for (let n = 1; n <= doc.numPages; n++) {
        if (this.cancelled()) return null;
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        const text = content.items
          .map((item: { str?: string }) => item.str ?? "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (text) seeds.push({ path: f.path, title: f.basename, page: n, line: 1, kind: "pdf", text });
        await yieldToUi();
      }
      return seeds;
    } finally {
      await doc.destroy();
    }
  }
}
