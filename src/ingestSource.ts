/**
 * Markdown ingest: the Obsidian-side glue between a markdown source note
 * (src/sourceMap.ts), the model (src/llm.ts) and the vault.
 *
 * The counterpart of src/suggest.ts, which does the same for a PDF, and the
 * same division of labour: nothing here segments, verifies or renders anything
 * itself. This file decides what to read, what to ask, and what to write, and
 * it writes nothing the reader has not seen first.
 *
 * Why it exists: every other ingest entry point is PDF-bound, but the
 * reference material in `sources/clippings/` is markdown with Web Clipper
 * frontmatter. Asking a question about it returned "no coverage" for material
 * the vault plainly held, because nothing had ever read it.
 */
import { Notice, TFile } from "obsidian";
import type WikiLmPlugin from "./main";
import { describeError } from "./llm";
import { askDigestOptions } from "./modals";
import {
  batchSegments,
  buildSourceMap,
  renderBatch,
  verifyMarkdownSpans,
  type Segment,
  type VerifiedMarkdownSpan,
} from "./sourceMap";
import { basenameNoExt } from "./util";

/**
 * How much of a note goes into one request. A clipping is usually one or two
 * batches; the cap exists so a long one does not arrive as a single wall of
 * text the model reads unevenly.
 */
const CHARS_PER_BATCH = 6000;

/** Most spans accepted from any one segment, matching the PDF path's per-page cap. */
const PER_SEGMENT = 2;

/** Most spans accepted from one note in a single run. */
const MAX_PER_NOTE = 24;

/**
 * Ingest a markdown note: propose spans, verify every one against the real
 * text, and report what was found.
 *
 * The verification is the point. `verifyMarkdownSpans` drops anything the
 * model did not copy verbatim, so a quote it reworded never reaches a page
 * with a citation that would not survive being clicked.
 */
export async function ingestSourceNote(plugin: WikiLmPlugin, file: TFile): Promise<void> {
  try {
    const s = plugin.settings;
    const md = await plugin.app.vault.read(file); // obsidian.d.ts:7424
    const map = buildSourceMap(md);

    if (map.segments.length === 0) {
      new Notice("WikiLM: this note has no prose to read.");
      return;
    }

    // Segment numbers are 1-based and stable for the whole run: the model
    // cites them as `[s N]`, and a verified span carries the number back.
    // Numbered over ALL segments, including the ones not sent, so a number
    // always means the same segment however the batches are cut.
    const indexOf = new Map<Segment, number>(map.segments.map((seg, i) => [seg, i + 1]));

    // A segment with no quotable prose is not worth a request. A bare image
    // embed is the common case in a web clipping — a long CDN URL and nothing
    // to quote — and fenced code is not prose either.
    const quotable = map.segments.filter((seg) => !seg.code && hasProse(seg.text));
    if (quotable.length === 0) {
      new Notice("WikiLM: this note is all images or code — there is nothing to quote.");
      return;
    }

    const options = await askDigestOptions(
      plugin.app,
      { product: "notes", instruction: "" },
      `Read ${basenameNoExt(file.path)} into the wiki`,
    );
    if (options === null) return;

    const title = basenameNoExt(file.path);
    const batches = batchSegments(quotable, CHARS_PER_BATCH);
    const existingKeys = new Set<string>();
    const accepted: VerifiedMarkdownSpan[] = [];
    let unlocated = 0;

    for (const [n, batch] of batches.entries()) {
      const remaining = MAX_PER_NOTE - accepted.length;
      if (remaining <= 0) break;

      if (batches.length > 1) {
        new Notice(`WikiLM: reading ${title}, part ${n + 1} of ${batches.length}…`);
      }

      const nums = batch.map((seg) => indexOf.get(seg) as number);
      const draft = await plugin.llm.suggest({
        pdfTitle: title,
        classCode: "",
        // The shared prompt numbers its input `[page N]`; here the number is a
        // segment. Sending one segment per entry keeps the marker meaningful,
        // so a span can name exactly where it came from.
        pages: batch.map((seg) => ({ page: indexOf.get(seg) as number, text: seg.text })),
        transcript: null,
        existingNotes: [],
        alreadySelected: accepted.map((a) => ({ page: a.segment, text: a.quote.slice(0, 80) })),
        perPage: PER_SEGMENT,
        remaining,
        standingInstructions: s.suggestInstructions,
        instruction: options.instruction,
      });

      const r = verifyMarkdownSpans(draft.spans ?? [], map, file.path, {
        perSegment: PER_SEGMENT,
        remaining,
        existingKeys,
        batch: nums,
      });
      accepted.push(...r.spans);
      for (const sp of r.spans) existingKeys.add(sp.key);
      unlocated += r.dropped.unlocated;
    }

    if (accepted.length === 0) {
      new Notice(
        unlocated > 0
          ? `WikiLM: nothing kept — ${unlocated} proposed quote${unlocated === 1 ? "" : "s"} could not be found in the note.`
          : "WikiLM: no passages suggested for this note.",
        8000,
      );
      return;
    }

    const tail = unlocated > 0 ? `, ${unlocated} dropped as unverifiable` : "";
    new Notice(`WikiLM: ${accepted.length} passage${accepted.length === 1 ? "" : "s"} verified in ${title}${tail}.`, 8000);
  } catch (e) {
    new Notice(`WikiLM: ${describeError(e)}`, 8000);
  }
}


/**
 * Does this segment carry text a reader could quote?
 *
 * An image embed and a bare link are not prose: there is nothing to copy
 * verbatim, so a span citing one could never be verified. Strip them and see
 * whether anything is left.
 */
function hasProse(text: string): boolean {
  const stripped = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/!\[\[[^\]]*\]\]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[\s>*_-]+/gm, "");
  return stripped.trim().length >= 40;
}

/** The batch as the model sees it, for logging and tests. */
export function previewBatch(md: string): string {
  const map = buildSourceMap(md);
  const indexOf = new Map(map.segments.map((seg, i) => [seg, i + 1]));
  return renderBatch(map.segments, (seg) => indexOf.get(seg) as number);
}
