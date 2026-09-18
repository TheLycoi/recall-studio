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
import { makeHighlight } from "./model";
import { askDigestOptions, previewSuggestions } from "./modals";
import type { SuggestDraft } from "./schemas";
import {
  batchSegments,
  buildSourceMap,
  renderBatch,
  toMarkdownRows,
  verifyMarkdownSpans,
  type Segment,
  type VerifiedMarkdownSpan,
} from "./sourceMap";
import { existingNotesFor, wikiNotes, writeNotes } from "./suggest";
import { applyPreviewChoices, planWikiNotes, type PlannedSpan } from "./suggestPlan";
import { safeTitle } from "./topicNote";
import { basenameNoExt, contentHash, normalizeWs } from "./util";

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
export async function ingestSourceNote(plugin: WikiLmPlugin, file: TFile, opts: { quiet?: boolean } = {}): Promise<"written" | "nothing"> {
  try {
    const s = plugin.settings;
    const md = await plugin.app.vault.read(file); // obsidian.d.ts:7424
    const map = buildSourceMap(md);

    if (map.segments.length === 0) {
      new Notice("WikiLM: this note has no prose to read.");
      return "nothing";
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
      return "nothing";
    }

    const options = await askDigestOptions(
      plugin.app,
      { product: "notes", instruction: "" },
      `Read ${basenameNoExt(file.path)} into the wiki`,
    );
    if (options === null) return "nothing";

    const title = basenameNoExt(file.path);
    const batches = batchSegments(quotable, CHARS_PER_BATCH);
    const existingKeys = new Set<string>();
    const accepted: VerifiedMarkdownSpan[] = [];
    let unlocated = 0;

    // (a) The wiki pages the model may file spans into, listed with their
    // sections, so a subtopic lands inside the note it belongs to.
    const wiki = await wikiNotes(plugin, "", []);
    const newNotes: SuggestDraft["new_notes"] = [];

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
        existingNotes: existingNotesFor(wiki, newNotes),
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

      for (const n of draft.new_notes ?? []) {
        const key = safeTitle(n.title ?? "").toLowerCase();
        if (!key) continue;
        if (newNotes.some((p) => safeTitle(p.title).toLowerCase() === key)) continue;
        newNotes.push(n);
      }
    }

    if (accepted.length === 0) {
      new Notice(
        unlocated > 0
          ? `WikiLM: nothing kept — ${unlocated} proposed quote${unlocated === 1 ? "" : "s"} could not be found in the note.`
          : "WikiLM: no passages suggested for this note.",
        8000,
      );
      return "nothing";
    }

    // (b) Plan, preview, write — the same path a PDF takes in src/suggest.ts,
    // with note-sourced rows instead of PDF++ callouts.
    const rows = toMarkdownRows(accepted, file.path, title);
    const planned: PlannedSpan[] = accepted.map((sp) => ({ key: sp.key, noteTitle: sp.noteTitle, noteKind: sp.noteKind, noteSection: "" }));
    const planOpts = {
      classCode: "",
      pdfBasename: title,
      conceptsFolder: s.wikiConceptsFolder,
      entitiesFolder: s.wikiEntitiesFolder,
      schema: s.wikiSchema,
    };
    const plan = planWikiNotes(planned, rows, newNotes, wiki, planOpts);
    const alreadyPresent = plan.notes.reduce((n, x) => n + x.skipped, 0);
    const choices = await previewSuggestions(
      plugin.app,
      plan.notes,
      { flashcards: options.product === "notes" ? 0 : rows.length, unlocated, orphanTitles: plan.orphanTitles, alreadyPresent, routed: plan.routed.length },
      title,
    );
    if (choices === null) return "nothing";

    const applied = applyPreviewChoices(planned, choices, newNotes, wiki, plan.routed);
    if (applied.spans.length === 0) {
      new Notice("WikiLM: nothing selected; nothing written.");
      return "nothing";
    }
    const final = planWikiNotes(applied.spans, rows, applied.newNotes, wiki, { ...planOpts, keepAsNew: applied.keepAsNew });

    const result =
      options.product === "flashcards"
        ? { written: 0, newCount: 0, spansWritten: 0, refused: 0 }
        : await writeNotes(plugin, final.notes, (note) => note.path.split("/").includes("sources"));

    let queued = 0;
    if (options.product !== "notes") {
      const keptKeys = new Set(applied.spans.map((sp) => sp.key));
      queued = queueMarkdownCards(plugin, file, title, accepted.filter((sp) => keptKeys.has(sp.key)));
    }

    if (result.written > 0 || queued > 0) plugin.store.markIngested(file.path, contentHash(md));

    const bits = [`${result.spansWritten} passage${result.spansWritten === 1 ? "" : "s"} into ${result.written} page${result.written === 1 ? "" : "s"} (${result.newCount} new)`];
    if (plan.routed.length) bits.push(`${plan.routed.length} proposed page${plan.routed.length === 1 ? "" : "s"} filed into existing ones`);
    if (queued) bits.push(`${queued} queued as flashcards`);
    if (unlocated) bits.push(`${unlocated} dropped as unverifiable`);
    if (!opts.quiet || result.written > 0) new Notice(`WikiLM: ${title} — ${bits.join(", ")}.`, 8000);
    return result.written > 0 || queued > 0 ? "written" : "nothing";
  } catch (e) {
    new Notice(`WikiLM: ${describeError(e)}`, 8000);
    return "nothing";
  }
}

/**
 * Queue the kept spans as inbox highlights, so the writer, critique and lint
 * chain turns each into a card. The note is the source: the inbox opens it
 * and re-locates the span by its text, the way a markdown capture does.
 */
function queueMarkdownCards(plugin: WikiLmPlugin, file: TFile, title: string, spans: VerifiedMarkdownSpan[]): number {
  let n = 0;
  for (const sp of spans) {
    if (plugin.store.hasDuplicate(file.path, normalizeWs(sp.quote))) continue;
    const h = makeHighlight({
      sourcePath: file.path,
      sourceTitle: title,
      text: sp.quote,
      before: sp.anchor.before,
      after: sp.anchor.after,
      line: Math.max(0, sp.anchor.line - 1),
      heading: sp.anchor.heading || null,
      title: sp.label,
      origin: "ai",
    });
    plugin.store.add(h);
    plugin.generator.enqueue(h);
    n++;
  }
  return n;
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
