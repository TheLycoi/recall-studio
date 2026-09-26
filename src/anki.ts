import { requestUrl } from "obsidian";
import type { Card, Highlight } from "./model";
import type { WikiLmSettings } from "./settings";
import { ankiTag, basenameNoExt, escapeHtml, inlineMarkdownToHtml, slugify, plainText } from "./util";

export interface AnkiNote {
  deckName: string;
  modelName: string;
  fields: Record<string, string>;
  tags: string[];
  options: { allowDuplicate: boolean; duplicateScope: "deck" | "collection" };
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
    return this.invoke("addNotes", { notes });
  }
  guiBrowse(query: string): Promise<number[]> {
    return this.invoke("guiBrowse", { query });
  }
}

export interface ExportContext {
  settings: WikiLmSettings;
  vaultName: string;
  deck: string;
}

export function buildExtra(h: Highlight, ctx: ExportContext): string {
  if (!ctx.settings.includeExtra) return "";
  const pathNoExt = h.sourcePath.replace(/\.md$/i, "");
  const target = h.page ? `${pathNoExt}#page=${h.page}` : h.blockId ? `${pathNoExt}#^${h.blockId}` : pathNoExt;
  const uri = `obsidian://open?vault=${encodeURIComponent(ctx.vaultName)}&file=${encodeURIComponent(target)}`;
  const where = h.page ? ` › p. ${h.page}` : h.heading ? ` › ${escapeHtml(h.heading)}` : "";
  // An atomic card with only a source link is disconnected trivia; when the
  // highlight was digested into a topic note, link the card at its concept too.
  let topic = "";
  if (h.topicPath) {
    const topicNoExt = h.topicPath.replace(/\.md$/i, "");
    const topicUri = `obsidian://open?vault=${encodeURIComponent(ctx.vaultName)}&file=${encodeURIComponent(topicNoExt)}`;
    topic = `<div class="wikilm-topic">Topic: <a href="${topicUri}">${escapeHtml(basenameNoExt(h.topicPath))}</a></div>`;
  }
  return (
    `<blockquote class="wikilm-highlight">${escapeHtml(plainText(h.text)).replace(/\n/g, "<br>")}</blockquote>` +
    `<div class="wikilm-source">Source: <a href="${uri}">${escapeHtml(h.sourceTitle)}</a>${where}</div>` +
    topic
  );
}

export function buildTags(h: Highlight, ctx: ExportContext): string[] {
  const tags = ctx.settings.extraTags.split(/\s+/).map(ankiTag).filter(Boolean);
  if (ctx.settings.includeSourceTag) tags.push(`source::${slugify(basenameNoExt(h.sourcePath))}`);
  return Array.from(new Set(tags));
}

export function buildNote(card: Card, h: Highlight, ctx: ExportContext): AnkiNote {
  const s = ctx.settings;
  const fields: Record<string, string> = {};
  let modelName: string;
  const extra = buildExtra(h, ctx);
  if (card.kind === "qa") {
    modelName = s.basicModel;
    fields[s.basicFrontField] = inlineMarkdownToHtml(card.front);
    fields[s.basicBackField] = inlineMarkdownToHtml(card.back);
    if (s.basicExtraField) fields[s.basicExtraField] = [inlineMarkdownToHtml(card.extra), extra].filter(Boolean).join("<br>");
  } else {
    modelName = s.clozeModel;
    fields[s.clozeTextField] = inlineMarkdownToHtml(card.text);
    if (s.clozeExtraField) fields[s.clozeExtraField] = [inlineMarkdownToHtml(card.extra), extra].filter(Boolean).join("<br>");
  }
  return {
    deckName: ctx.deck,
    modelName,
    fields,
    tags: buildTags(h, ctx),
    options: { allowDuplicate: false, duplicateScope: "deck" },
  };
}

export interface ExportResult {
  added: number;
  duplicates: number;
  failed: Array<{ card: Card; error: string }>;
}

/**
 * Push cards to Anki. Marks each card exported/duplicate in place; the caller
 * persists. Highlights whose pending cards are all gone become "exported".
 */
export async function exportToAnki(
  anki: AnkiClient,
  items: Array<{ card: Card; highlight: Highlight }>,
  ctx: ExportContext,
): Promise<ExportResult> {
  const result: ExportResult = { added: 0, duplicates: 0, failed: [] };
  if (items.length === 0) return result;
  await anki.createDeck(ctx.deck);
  const notes = items.map(({ card, highlight }) => buildNote(card, highlight, ctx));
  const checks = await anki.canAddNotesWithErrorDetail(notes);
  const addable: number[] = [];
  checks.forEach((c, i) => {
    if (c.canAdd) {
      addable.push(i);
    } else if ((c.error ?? "").toLowerCase().includes("duplicate")) {
      items[i].card.status = "duplicate";
      result.duplicates++;
    } else {
      result.failed.push({ card: items[i].card, error: c.error ?? "cannot add" });
    }
  });
  if (addable.length) {
    const ids = await anki.addNotes(addable.map((i) => notes[i]));
    ids.forEach((id, k) => {
      const item = items[addable[k]];
      if (id) {
        item.card.status = "exported";
        item.card.ankiNoteId = id;
        result.added++;
      } else {
        result.failed.push({ card: item.card, error: "Anki did not add this note (likely a duplicate)." });
      }
    });
  }
  finalizeHighlights(items.map((i) => i.highlight));
  return result;
}

export function finalizeHighlights(highlights: Highlight[]): void {
  const now = new Date().toISOString();
  for (const h of new Set(highlights)) {
    const pending = h.cards.some((c) => c.status === "pending");
    // A highlight still holding flagged cards is not finished: flipping it to
    // "exported" would drop those cards out of counts() (which only tallies
    // flagged under a ready highlight) and out of the default inbox filter,
    // leaving a decision the reader never made and can no longer see. It
    // stays "ready" until every flagged card is fixed or deleted.
    const flagged = h.cards.some((c) => c.status === "flagged");
    if (!pending && !flagged && h.status === "ready") {
      h.status = "exported";
      h.exportedAt = now;
    }
  }
}
