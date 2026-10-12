import { requestUrl } from "obsidian";
import type { Card, Highlight } from "./model";
import type { RecallSettings } from "./settings";
import { ankiTag, basenameNoExt, escapeHtml, inlineMarkdownToHtml, slugify, plainText } from "./util";

export interface AnkiNote {
  deckName: string;
  modelName: string;
  fields: Record<string, string>;
  tags: string[];
  options: { allowDuplicate: boolean; duplicateScope: "deck" | "collection" };
}

export interface AnkiNoteInfo {
  noteId: number;
  modelName?: string;
  tags?: string[];
  fields?: Record<string, { value: string; order: number }>;
}

/** Thin AnkiConnect client. Uses requestUrl so no CORS origin has to be whitelisted. */
export class AnkiClient {
  constructor(private getUrl: () => string) {}

  private async invoke<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    let res;
    try {
      res = await requestUrl({
        url: this.getUrl(),
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ action, version: 6, params }),
        throw: false,
      });
    } catch (e) {
      throw new Error("Anki is not open, or AnkiConnect is not installed.");
    }
    if (res.status !== 200) throw new Error(`AnkiConnect returned HTTP ${res.status}.`);
    const json = res.json as { result: T; error: string | null };
    if (json.error) throw new Error(json.error);
    return json.result;
  }

  version(): Promise<number> {
    return this.invoke<number>("version");
  }
  deckNames(): Promise<string[]> {
    return this.invoke<string[]>("deckNames");
  }
  modelNames(): Promise<string[]> {
    return this.invoke<string[]>("modelNames");
  }
  modelFieldNames(modelName: string): Promise<string[]> {
    return this.invoke<string[]>("modelFieldNames", { modelName });
  }
  createDeck(deck: string): Promise<number> {
    return this.invoke<number>("createDeck", { deck });
  }
  canAddNotesWithErrorDetail(notes: AnkiNote[]): Promise<Array<{ canAdd: boolean; error?: string }>> {
    return this.invoke("canAddNotesWithErrorDetail", { notes });
  }
  addNotes(notes: AnkiNote[]): Promise<Array<number | null>> {
    return this.invoke<Array<number | null>>("addNotes", { notes });
  }
  /** Note ids matching an Anki search query, across the whole collection. */
  findNotes(query: string): Promise<number[]> {
    return this.invoke<number[]>("findNotes", { query });
  }
  /** Full info for a set of note ids (never card ids). */
  notesInfo(notes: number[]): Promise<AnkiNoteInfo[]> {
    return this.invoke<AnkiNoteInfo[]>("notesInfo", { notes });
  }
  /** Upload one file into Anki's media folder. `data` is base64. Returns the stored filename. */
  storeMediaFile(filename: string, data: string): Promise<string | null> {
    return this.invoke<string | null>("storeMediaFile", { filename, data });
  }
  guiBrowse(query: string): Promise<number[]> {
    return this.invoke<number[]>("guiBrowse", { query });
  }
}

export interface ExportContext {
  settings: RecallSettings;
  vaultName: string;
  deck: string;
  /**
   * Resolve a vault-relative media link (as it appears in a card's text) to the
   * file's path and bytes, for a local upload. Returns null for anything that
   * is not a readable file in the vault — a missing file, a remote URL, a path
   * outside the vault. Export never fetches remotely.
   */
  resolveMedia?: (link: string) => Promise<{ path: string; data: ArrayBuffer } | null>;
}

// ------------------------------------------------------------- identity

/**
 * The tag carrying a card's stable identity. Scoped to the plugin and the
 * vault so two vaults exporting the same card id never collide, and so an
 * unrelated note that merely holds the same text is not mistaken for ours.
 * Written onto every note this plugin adds and searched before adding, so a
 * retry (or a second export after deck selection changes) looks the card up
 * instead of duplicating it.
 */
export const IDENTITY_TAG_PREFIX = "review-inbox";

export function cardIdentityTag(vaultName: string, cardId: string): string {
  return `${IDENTITY_TAG_PREFIX}::${slugify(vaultName) || "vault"}::${slugify(cardId) || cardId}`;
}

/** Escape a string so Anki's search parser treats it as literal text, not syntax. */
export function escapeAnkiSearch(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/"/g, '\\"');
}

/** The search that finds the note this card identity already has, if any. */
export function identityQuery(tag: string): string {
  return `tag:${escapeAnkiSearch(tag)}`;
}

/** A collection-wide search for a card's own stored text, to tell a content duplicate from a failure. */
export function contentQuery(card: Card): string {
  const text = (card.kind === "qa" ? card.front : card.text).trim();
  return `"${escapeAnkiSearch(text)}"`;
}

// ------------------------------------------------------------- note building

export function buildExtra(h: Highlight, ctx: ExportContext): string {
  if (!ctx.settings.includeExtra) return "";
  const pathNoExt = h.sourcePath.replace(/\.md$/i, "");
  // The exact PDF++ subpath (page=…&selection=…|annotation=…|rect=…) when the
  // highlight came from a PDF++ link, so the card opens the precise highlight;
  // otherwise the page, the block id, or the note itself.
  const frag = h.subpath ? h.subpath : h.page ? `page=${h.page}` : h.blockId ? `^${h.blockId}` : "";
  const target = frag ? `${pathNoExt}#${frag}` : pathNoExt;
  const uri = `obsidian://open?vault=${encodeURIComponent(ctx.vaultName)}&file=${encodeURIComponent(target)}`;
  const where = h.page ? ` › p. ${h.page}` : h.heading ? ` › ${escapeHtml(h.heading)}` : "";
  // An atomic card with only a source link is disconnected trivia; when the
  // highlight is linked to a topic note, link the card at its concept too.
  let topic = "";
  if (h.topicPath) {
    const topicNoExt = h.topicPath.replace(/\.md$/i, "");
    const topicUri = `obsidian://open?vault=${encodeURIComponent(ctx.vaultName)}&file=${encodeURIComponent(topicNoExt)}`;
    topic = `<div class="reviewinbox-topic">Topic: <a href="${topicUri}">${escapeHtml(basenameNoExt(h.topicPath))}</a></div>`;
  }
  return (
    `<blockquote class="reviewinbox-highlight">${escapeHtml(plainText(h.text)).replace(/\n/g, "<br>")}</blockquote>` +
    `<div class="reviewinbox-source">Source: <a href="${uri}">${escapeHtml(h.sourceTitle)}</a>${where}</div>` +
    topic
  );
}

export function buildTags(h: Highlight, ctx: ExportContext): string[] {
  const tags = ctx.settings.extraTags.split(/\s+/).map(ankiTag).filter(Boolean);
  if (ctx.settings.includeSourceTag) tags.push(`source::${slugify(basenameNoExt(h.sourcePath))}`);
  return Array.from(new Set(tags));
}

/**
 * Build the note for one card. The source backlink is placed in the model's
 * Extra field when there is one. When the Basic or Cloze model has no Extra
 * field — a real configuration, since the field is optional — the backlink is
 * appended to the answer (Back) or Text field instead, so a card always links
 * home rather than silently dropping the source.
 */
export function buildNote(card: Card, h: Highlight, ctx: ExportContext): AnkiNote {
  const s = ctx.settings;
  const fields: Record<string, string> = {};
  let modelName: string;
  const extra = buildExtra(h, ctx);
  const extraHtml = [inlineMarkdownToHtml(card.extra), extra].filter(Boolean).join("<br>");
  if (card.kind === "qa") {
    modelName = s.basicModel;
    fields[s.basicFrontField] = inlineMarkdownToHtml(card.front);
    if (s.basicExtraField) {
      fields[s.basicBackField] = inlineMarkdownToHtml(card.back);
      fields[s.basicExtraField] = extraHtml;
    } else {
      fields[s.basicBackField] = [inlineMarkdownToHtml(card.back), extraHtml].filter(Boolean).join("<br>");
    }
  } else {
    modelName = s.clozeModel;
    const textHtml = inlineMarkdownToHtml(card.text);
    if (s.clozeExtraField) {
      fields[s.clozeTextField] = textHtml;
      fields[s.clozeExtraField] = extraHtml;
    } else {
      fields[s.clozeTextField] = [textHtml, extraHtml].filter(Boolean).join("<br>");
    }
  }
  return {
    deckName: ctx.deck,
    modelName,
    fields,
    tags: buildTags(h, ctx),
    // Content duplicates stay out of the deck the reader is writing to; an
    // identity hit (our own card, already sent) is handled by the lookup, not
    // by this flag.
    options: { allowDuplicate: false, duplicateScope: "deck" },
  };
}

// ------------------------------------------------------------- media

const MEDIA_EMBED = /!\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]|!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const AUDIO_EXT = /\.(mp3|ogg|oga|wav|flac|m4a|opus|aac)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|mkv)$/i;

/**
 * A vault-relative media path that is safe to upload: not absolute, not a
 * URL, no `..` traversal, and a recognised media extension. Anything else is
 * refused, so a card cannot make the export read an arbitrary file or fetch
 * from the network.
 */
export function isSafeMediaPath(path: string): boolean {
  if (!path) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || /:\/\//.test(path)) return false;
  if (path.startsWith("/") || path.startsWith("~") || path.includes("\\")) return false;
  if (path.split("/").some((seg) => seg === "..")) return false;
  return IMAGE_EXT.test(path) || AUDIO_EXT.test(path) || VIDEO_EXT.test(path);
}

function mediaReference(filename: string): string {
  if (AUDIO_EXT.test(filename)) return `[sound:${filename}]`;
  if (VIDEO_EXT.test(filename)) return `<video src="${filename}"></video>`;
  return `<img src="${filename}">`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Upload every local media embed in the note's fields, replacing each with an Anki media reference. */
async function resolveMediaInFields(anki: AnkiClient, fields: Record<string, string>, ctx: ExportContext): Promise<void> {
  if (!ctx.resolveMedia) return;
  for (const key of Object.keys(fields)) {
    fields[key] = await replaceMediaEmbeds(anki, fields[key], ctx);
  }
}

async function replaceMediaEmbeds(anki: AnkiClient, html: string, ctx: ExportContext): Promise<string> {
  const matches = [...html.matchAll(MEDIA_EMBED)];
  if (matches.length === 0) return html;
  const replacements = new Map<string, string>();
  for (const m of matches) {
    const link = (m[1] ?? m[2] ?? "").trim();
    if (!link || replacements.has(m[0])) continue;
    try {
      const resolved = await ctx.resolveMedia!(link);
      if (!resolved || !isSafeMediaPath(resolved.path)) continue;
      const name = resolved.path.split("/").pop() ?? resolved.path;
      await anki.storeMediaFile(name, arrayBufferToBase64(resolved.data));
      replacements.set(m[0], mediaReference(name));
    } catch (e) {
      // A single unreadable attachment must not fail the whole card; the raw
      // link is left in place and the rest of the note still exports.
      console.warn("Review Inbox: could not upload media", link, e);
    }
  }
  let out = html;
  for (const [embed, ref] of replacements) out = out.split(embed).join(ref);
  return out;
}

// ------------------------------------------------------------- export

export interface ExportResult {
  /** Notes added in this run. */
  added: number;
  /** Cards whose note already existed under our identity — an idempotent re-send, not a new note. */
  alreadyExported: number;
  /** Cards whose content duplicates an unrelated note that is not ours. */
  duplicates: number;
  failed: Array<{ card: Card; error: string }>;
}

// Serialise exports: two runs must never interleave their lookups and adds, or
// the same card could be added twice. Every call chains onto the previous one.
let exportChain: Promise<unknown> = Promise.resolve();

export function exportToAnki(
  anki: AnkiClient,
  items: Array<{ card: Card; highlight: Highlight }>,
  ctx: ExportContext,
): Promise<ExportResult> {
  const run = () => exportToAnkiInner(anki, items, ctx);
  const next = exportChain.then(run, run);
  // The chain must survive a failed run so the next export still runs.
  exportChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function exportToAnkiInner(
  anki: AnkiClient,
  items: Array<{ card: Card; highlight: Highlight }>,
  ctx: ExportContext,
): Promise<ExportResult> {
  const result: ExportResult = { added: 0, alreadyExported: 0, duplicates: 0, failed: [] };
  if (items.length === 0) return result;
  await anki.createDeck(ctx.deck);
  for (const { card, highlight } of items) {
    if (card.status !== "approved") {
      // Defence in depth: the caller filters to approved cards, and the gate
      // is repeated here so no future caller can push a draft or flagged card
      // into Anki through this function.
      result.failed.push({ card, error: "card was not approved" });
      continue;
    }
    const identity = cardIdentityTag(ctx.vaultName, card.id);
    // 1. Already sent by us? A tag hit means the note exists under this card's
    // identity, so a retry (or a re-send after the deck changed) is idempotent.
    const existing = await anki.findNotes(identityQuery(identity));
    if (existing.length > 0) {
      card.status = "exported";
      card.ankiNoteId = existing[0];
      result.alreadyExported++;
      continue;
    }

    let addedId: number | null = null;
    let lastError = "";
    try {
      const note = buildNote(card, highlight, ctx);
      await resolveMediaInFields(anki, note.fields, ctx);
      note.tags = Array.from(new Set([...note.tags, identity]));
      const ids = await anki.addNotes([note]);
      addedId = ids && ids[0] ? ids[0] : null;
    } catch (e) {
      // A connection failure or a lost response lands here. The card keeps its
      // approved status, so the reader can export again once Anki is reachable.
      lastError = (e as Error).message;
    }

    if (addedId) {
      // addNotes returning a note id IS Anki's verified result for this note.
      card.status = "exported";
      card.ankiNoteId = addedId;
      result.added++;
      continue;
    }

    // No id came back. The response may have been lost after Anki wrote the
    // note, so look the identity up again before treating this as a failure:
    // the note is ours and it is already there.
    let recovered = false;
    try {
      const found = await anki.findNotes(identityQuery(identity));
      if (found.length > 0) {
        card.status = "exported";
        card.ankiNoteId = found[0];
        result.alreadyExported++;
        recovered = true;
      }
    } catch {
      recovered = false;
    }
    if (recovered) continue;

    // Still nothing of ours. Distinguish a genuine content duplicate of a note
    // that is NOT ours (marked duplicate, so the reader sees why) from a real
    // failure (stays approved and is reported).
    let contentHit = false;
    try {
      const matches = await anki.findNotes(contentQuery(card));
      contentHit = matches.length > 0;
    } catch {
      contentHit = false;
    }
    if (contentHit) {
      card.status = "duplicate";
      result.duplicates++;
    } else {
      result.failed.push({ card, error: lastError || "Anki did not add this note." });
    }
  }
  finalizeHighlights(items.map((i) => i.highlight));
  return result;
}

export function finalizeHighlights(highlights: Highlight[]): void {
  const now = new Date().toISOString();
  for (const h of new Set(highlights)) {
    // Only approved cards remain to be exported, and flagged cards still need a
    // decision, so the highlight finishes only when neither is left.
    const pending = h.cards.some((c) => c.status === "pending" || c.status === "approved");
    const flagged = h.cards.some((c) => c.status === "flagged");
    if (!pending && !flagged && h.status === "ready") {
      h.status = "exported";
      h.exportedAt = now;
    }
  }
}
