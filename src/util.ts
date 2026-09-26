// Pure helpers shared across the plugin. Kept free of Obsidian imports so they
// can be unit-tested with node directly.

export function newId(prefix = ""): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return prefix ? `${prefix}-${t}${r}` : `${t}${r}`;
}

/** Vault naming convention: lowercase-with-hyphens, ASCII only. */
export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Strip YAML frontmatter; returns body and the offset where the body starts. */
export function splitFrontmatter(text: string): { body: string; offset: number } {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  if (m && m.index === 0) return { body: text.slice(m[0].length), offset: m[0].length };
  return { body: text, offset: 0 };
}

export interface Located {
  start: number;
  end: number;
  exact: boolean;
}

/**
 * Find a quoted span inside `text`. Tries exact match first, then a
 * whitespace/markdown-insensitive match, then a match on the first and last
 * few words. Returns character offsets into `text`.
 */
export function locateQuote(text: string, quote: string): Located | null {
  const q = quote.trim();
  if (!q) return null;
  const idx = text.indexOf(q);
  if (idx >= 0) return { start: idx, end: idx + q.length, exact: true };

  // Tokenise to letters/digits so markdown emphasis, quotes and punctuation
  // glued to a word (e.g. "**Church**,") never break the match.
  const words = q.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return null;
  const tryWords = (ws: string[]): Located | null => {
    const pattern = ws.map((w) => escapeRegExp(w)).join("[\\s\\S]{0,12}?");
    const re = new RegExp(pattern, "iu");
    const m = re.exec(text);
    if (!m) return null;
    // Keep closing punctuation and emphasis that follow the last word.
    const tail = /^[*_`)\]"'»”]*/.exec(text.slice(m.index + m[0].length))?.[0] ?? "";
    return { start: m.index, end: m.index + m[0].length + tail.length, exact: false };
  };
  const full = tryWords(words);
  if (full) return full;
  if (words.length > 8) {
    const h = tryWords(words.slice(0, 5));
    const t = tryWords(words.slice(-5));
    if (h && t && t.end > h.start && t.end - h.start < q.length * 3) {
      return { start: h.start, end: t.end, exact: false };
    }
  }
  return null;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Return up to `chars` of context on each side of [start,end), snapped to word boundaries. */
export function contextWindow(
  text: string,
  start: number,
  end: number,
  chars: number,
): { before: string; after: string } {
  let b0 = Math.max(0, start - chars);
  while (b0 > 0 && !/\s/.test(text[b0])) b0--;
  let a1 = Math.min(text.length, end + chars);
  while (a1 < text.length && !/\s/.test(text[a1])) a1++;
  return { before: text.slice(b0, start).trim(), after: text.slice(end, a1).trim() };
}

/** Find `==highlight==` spans in markdown. Spans never cross a blank line. */
export function findMarkdownHighlights(text: string): Array<{ text: string; start: number; end: number }> {
  const out: Array<{ text: string; start: number; end: number }> = [];
  const re = /==([^=\n](?:(?!\n\s*\n)[\s\S])*?)==/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const inner = m[1].trim();
    if (inner.length < 3) continue;
    out.push({ text: inner, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export function lineOf(text: string, offset: number): number {
  let line = 0;
  const n = Math.min(offset, text.length);
  for (let i = 0; i < n; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Nearest markdown heading above `offset`, if any. */
export function headingAbove(text: string, offset: number): string | null {
  const lines = text.slice(0, offset).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (m) return m[1].trim();
  }
  return null;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Minimal markdown -> HTML for Anki fields: bold, italics, inline code,
 * line breaks. Cloze markers `{{c1::...}}` are preserved (their bodies are
 * HTML-escaped but the marker syntax is kept intact).
 */
export function inlineMarkdownToHtml(s: string): string {
  const clozes: string[] = [];
  const stash = s.replace(/\{\{c\d+::[\s\S]*?\}\}/g, (m) => {
    clozes.push(m);
    return `\u0000${clozes.length - 1}\u0000`;
  });
  let html = escapeHtml(stash)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*\n]+?)\*/g, "$1<i>$2</i>")
    .replace(/`([^`]+?)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br>");
  html = html.replace(/\u0000(\d+)\u0000/g, (_m, i) => {
    const c = clozes[Number(i)];
    return c.replace(/\{\{(c\d+)::([\s\S]*?)\}\}/, (_x, n, body) => `{{${n}::${escapeHtml(body)}}}`);
  });
  return html;
}

/** Render `{{c1::text::hint}}` as readable text for the inbox. */
export function clozeToDisplay(text: string): string {
  return text.replace(/\{\{c\d+::([\s\S]*?)(?:::[^}]*)?\}\}/g, "[$1]");
}

export function countClozes(text: string): number {
  const ids = new Set<string>();
  for (const m of text.matchAll(/\{\{(c\d+)::/g)) ids.add(m[1]);
  return ids.size;
}

/** Anki tags cannot contain spaces. */
export function ankiTag(s: string): string {
  return s.trim().replace(/\s+/g, "_");
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function basenameNoExt(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.(md|pdf)$/i, "");
}

/** Lower-case, punctuation-free text for substring comparisons. */
export function normalizePlain(s: string): string {
  return s
    .normalize("NFD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Deterministic check that every cloze deletion is really in the highlight.
 * Returns the deletions that are not. Borrowed from Loopback's linter idea:
 * grounding is a rule you can check by counting, so check it rather than
 * trusting the prompt.
 */
export function ungroundedClozes(clozeText: string, highlight: string): string[] {
  const hay = normalizePlain(highlight);
  const out: string[] = [];
  for (const m of clozeText.matchAll(/\{\{c\d+::([\s\S]*?)(?:::[^}]*)?\}\}/g)) {
    const body = normalizePlain(m[1]);
    if (body && !hay.includes(body)) out.push(m[1].trim());
  }
  return out;
}

/**
 * Whether a selection can safely be wrapped in ==…== without producing
 * nested or broken highlight markup, or breaking the note's formatting.
 *
 * A span that crosses into a heading, list item, quote or table row cannot be
 * wrapped: `==## Heading` stops rendering as a heading and leaks the marker
 * into reading view. Same for a span that starts on a heading line and runs on.
 */
export function canWrapAsHighlight(sel: string): boolean {
  if (/\n\s*\n/.test(sel)) return false;
  const t = sel.trim();
  if (/^==[\s\S]*==$/.test(t)) return false; // already wrapped
  if (t.includes("==")) return false;
  // A later line opens a block-level construct: heading, bullet, ordered item,
  // blockquote/callout, or table row.
  if (/\n[ \t]*(?:#{1,6}[ \t]|[-*+][ \t]|\d+[.)][ \t]|>|\|)/.test(t)) return false;
  // The span starts on a heading line and does not stop at its end.
  if (/^#{1,6}[ \t]/.test(t) && t.includes("\n")) return false;
  return true;
}

/** Build Anki's plain-text import format (tab-separated with header directives). */
export function buildAnkiTextImport(
  rows: Array<{ notetype: string; deck: string; fields: string[]; tags: string[] }>,
): string {
  const esc = (v: string) => (/[\t"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = ["#separator:tab", "#html:true", "#notetype column:1", "#deck column:2", "#tags column:3"];
  for (const r of rows) {
    lines.push([r.notetype, r.deck, r.tags.join(" "), ...r.fields].map(esc).join("\t"));
  }
  return lines.join("\n") + "\n";
}

// ---- transcripts

const VTT_TIMESTAMP = /^(?:\d{2,}:)?\d{2}:\d{2}[.,]\d{3}\s*-->\s*(?:\d{2,}:)?\d{2}:\d{2}[.,]\d{3}(?:\s+.*)?$/;
const CUE_NUMBER = /^\d+$/;
const LEADING_BRACKET_TS = /^[[(](?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d+)?[)\]]\s*/;
const VTT_TAGS = /<\/?v(?:\s[^>]*)?>|<\/?c>|<\/?b>|<\/?i>/g;

/**
 * Strip WebVTT/SRT scaffolding (headers, cue numbers, timestamps, NOTE
 * blocks, `<v>`/`<c>`/`<b>`/`<i>` tags) and leading bracketed timestamps
 * from a pasted or attached lecture transcript, leaving plain lines of
 * speech. Speaker prefixes like `Name:` are preserved.
 */
export function normalizeTranscript(raw: string): string {
  let text = raw.replace(/\r\n/g, "\n");
  // A note exported by a notetaker (Wispr Flow) opens with YAML frontmatter
  // — an id, timestamps, the app's name — that says nothing about the lecture.
  text = text.replace(/^---\n[\s\S]*?\n---\n?/, "");

  const lines = text.split("\n");
  // The same export ends with a bare pointer to its companion transcript
  // file, the note's own name with `-transcript` appended. Not content.
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length > 0 && /^\S.*-transcript$/.test(lines[lines.length - 1].trim())) lines.pop();
  // Drop a leading WEBVTT header line (and anything after it on that line).
  if (lines.length > 0 && /^WEBVTT\b/.test(lines[0])) lines.shift();

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // WebVTT NOTE block: this line and every following line up to the next
    // blank line are dropped.
    if (line === "NOTE" || line.startsWith("NOTE ")) {
      i++;
      while (i < lines.length && lines[i].trim() !== "") i++;
      continue;
    }
    // Cue number / timestamp lines are scaffolding, not content; drop them
    // along with the blank separator line that precedes a cue block so
    // consecutive cues don't turn into paragraph breaks.
    if (CUE_NUMBER.test(line.trim()) || VTT_TIMESTAMP.test(line.trim())) {
      if (out.length > 0 && out[out.length - 1] === "") out.pop();
      continue;
    }

    // An Obsidian callout header (`> [!summary]- Flow Summary`) is a wrapper,
    // dropped; the quoted lines inside it are the summary itself, unwrapped.
    if (/^>\s*\[![^\]]*\][+-]?/.test(line.trim())) continue;
    let cleaned = line.replace(/^\s*>\s?/, "");
    cleaned = cleaned.replace(LEADING_BRACKET_TS, "");
    cleaned = cleaned.replace(VTT_TAGS, "");
    cleaned = cleaned.replace(/[ \t]+/g, " ").trim();
    out.push(cleaned);
  }

  text = out.join("\n");
  text = text.replace(/\n{2,}/g, "\n\n");
  return text.trim();
}

/**
 * Cut `text` to at most `maxChars`, preferring a sentence boundary, then a
 * word boundary, then a hard cut. Used to keep transcripts within the LLM's
 * context budget.
 */
export function truncateTranscript(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };

  const window = text.slice(0, maxChars);

  // Last sentence-ending punctuation followed by whitespace, within the window.
  let cut = -1;
  const sentenceRe = /[.!?]\s/g;
  let m: RegExpExecArray | null;
  while ((m = sentenceRe.exec(window))) cut = m.index + 1; // keep the punctuation, drop the whitespace
  if (cut > 0) return { text: window.slice(0, cut).trim(), truncated: true };

  // Last whitespace within the window.
  const wsIdx = window.search(/\s\S*$/);
  if (wsIdx > 0) return { text: window.slice(0, wsIdx).trim(), truncated: true };

  return { text: window.trim(), truncated: true };
}

/**
 * FNV-1a over the text, 32 bits, as eight hex characters. Enough to tell
 * "this note changed since we read it" from "it did not", which is all the
 * folder ingest needs; not a cryptographic digest and not meant as one.
 */
export function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Is `path` inside `folder` (a real segment boundary, so `wiki/schemas` is not under `wiki/schema`)? An empty folder holds nothing. */
export function isUnderFolder(path: string, folder: string): boolean {
  const f = folder.replace(/^\/+|\/+$/g, "");
  if (!f) return false;
  return path === f || path.startsWith(`${f}/`);
}

/**
 * The order the transcript picker lists files in: the transcript folder's
 * notes first, newest first — the lecture you just exported is the one you
 * want — then everything else by path. An empty folder setting is plain path
 * order.
 */
export function orderTranscriptFiles<T extends { path: string; mtime: number }>(files: T[], folder: string): T[] {
  const byPath = (a: T, b: T) => a.path.localeCompare(b.path);
  const inside = files.filter((f) => isUnderFolder(f.path, folder)).sort((a, b) => b.mtime - a.mtime || byPath(a, b));
  const outside = files.filter((f) => !isUnderFolder(f.path, folder)).sort(byPath);
  return [...inside, ...outside];
}

/**
 * A passage as words: every link reduced to what a reader sees.
 *
 * Notes carry their evidence as PDF++ links — `[[deck.pdf#page=10&selection=…|Non-numerical, description…]]` —
 * and the text between the brackets is the quote; the rest is an address. On
 * the back of a card, in the inbox and in front of the card writer the
 * address is noise, and long enough to hide the words. Embeds (`![[…]]`) have
 * no words at all and are dropped; a bare `[[Note]]` becomes the note's name;
 * a markdown link keeps its text.
 */
export function plainText(s: string): string {
  return s
    .replace(/!\[\[[^\]]*\]\]/g, "")
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/\[\[([^\]]*)\]\]/g, (_m, target: string) => {
      const noSub = target.split("#")[0].split("^")[0];
      const base = noSub.split("/").pop() ?? noSub;
      return base.replace(/\.md$/i, "");
    })
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([.,;:!?])/g, "$1")
    .trim();
}
