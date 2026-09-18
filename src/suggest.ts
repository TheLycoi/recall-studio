/**
 * AI highlight suggestion: the Obsidian-side glue between the PDF's text layer
 * (src/pdfHighlights.ts, src/pageMap.ts), the model (src/llm.ts), the pure
 * planner (src/suggestPlan.ts), the preview modal (src/modals.ts) and the
 * vault.
 *
 * Same division of labour as src/digest.ts, which this mirrors: nothing here
 * locates, verifies, renders or groups anything itself — those live in pure
 * modules with their own tests. This file decides what to read, what to ask,
 * and what to write, and it writes nothing until the preview is accepted.
 */
import { Notice, TFile, normalizePath } from "obsidian";
import type WikiLmPlugin from "./main";
import { captureManifestHighlights } from "./capture";
import { describeError } from "./llm";
import { askDigestOptions, askInstruction, previewSuggestions } from "./modals";
import { buildPageMap, type PageMap } from "./pageMap";
import { collectPdfHighlights, writeManifest } from "./pdfHighlights";
import type { SuggestDraft } from "./schemas";
import type { SuggestExistingNote } from "./prompt";
import { SUGGEST_PER_PAGE } from "./settings";
import { applyPreviewChoices, batchPages, planWikiNotes, toManifestHighlights, verifySpans, type VerifiedSpan, type WikiNoteIn } from "./suggestPlan";
import { noteSections, safeTitle, type PreparedNote } from "./topicNote";

/** How much of an already-selected passage the prompt shows (src/prompt.ts:267). */
const ALREADY_SELECTED_CHARS = 80;

/**
 * The `class` frontmatter of a note, when it has one. Copied from
 * src/pdfHighlights.ts:339-345, which keeps it module-private.
 */
function frontmatterClass(plugin: WikiLmPlugin, path: string): string {
  const file = plugin.app.vault.getAbstractFileByPath(path); // obsidian.d.ts:7369
  if (!(file instanceof TFile)) return "";
  const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter; // obsidian.d.ts:4417, :1446
  const value = fm?.class;
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The wiki notes this PDF is allowed to write into: everything under the
 * concepts and entities folders that either carries this class code in its
 * frontmatter or already links to this PDF (the manifest's sources). The second
 * test catches the hand-written notes that have no frontmatter at all, which
 * secondbrain has plenty of.
 */
export async function wikiNotes(plugin: WikiLmPlugin, classCode: string, sources: string[]): Promise<WikiNoteIn[]> {
  const s = plugin.settings;
  const folders: Array<{ folder: string; kind: "concept" | "entity" }> = [
    { folder: s.wikiConceptsFolder, kind: "concept" },
    { folder: s.wikiEntitiesFolder, kind: "entity" },
  ];
  const sourceSet = new Set(sources);
  const out: WikiNoteIn[] = [];
  const seen = new Set<string>();

  for (const { folder, kind } of folders) {
    const prefix = `${normalizePath(folder)}/`;
    for (const file of plugin.app.vault.getMarkdownFiles()) { // obsidian.d.ts:7331
      if (!file.path.startsWith(prefix)) continue;
      if (seen.has(file.path)) continue;
      if (frontmatterClass(plugin, file.path) !== classCode && !sourceSet.has(file.path)) continue;
      seen.add(file.path);
      out.push({
        title: file.basename,
        kind,
        path: file.path,
        md: await plugin.app.vault.cachedRead(file), // obsidian.d.ts:7440
      });
    }
  }

  return out.sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Titles the model may reuse: the vault's notes plus what earlier batches
 * proposed. A vault note is listed with its `##` headings, so the model can
 * file a span under the subtopic it belongs to rather than found a note
 * beside it; a note proposed earlier in this run has no page yet and so no
 * sections.
 */
export function existingNotesFor(wiki: WikiNoteIn[], newNotes: SuggestDraft["new_notes"]): SuggestExistingNote[] {
  const out: SuggestExistingNote[] = [];
  const seen = new Set<string>();
  for (const n of wiki) {
    const key = n.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: n.title, kind: n.kind, sections: noteSections(n.md) });
  }
  for (const n of newNotes) {
    const key = n.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: n.title, kind: n.kind, sections: [] });
  }
  return out;
}

export interface WriteNotesResult {
  written: number;
  newCount: number;
  spansWritten: number;
  refused: number;
}

/**
 * Write planned pages into the vault, creating folders on first use. Same
 * vault idiom as the digest (src/digest.ts). `refuse` is the caller's last
 * check before a write — a page named after the source PDF, or aimed at the
 * folder the sources live in, is refused rather than trusted.
 */
export async function writeNotes(
  plugin: WikiLmPlugin,
  notes: PreparedNote[],
  refuse: (note: PreparedNote) => boolean,
): Promise<WriteNotesResult> {
  const result: WriteNotesResult = { written: 0, newCount: 0, spansWritten: 0, refused: 0 };
  for (const note of notes) {
    if (refuse(note)) {
      result.refused++;
      continue;
    }
    const path = normalizePath(note.path);
    const file = plugin.app.vault.getAbstractFileByPath(path); // obsidian.d.ts:7369
    if (file instanceof TFile) {
      await plugin.app.vault.modify(file, note.content); // obsidian.d.ts:7467
    } else {
      const folder = path.split("/").slice(0, -1).join("/");
      if (folder && !(await plugin.app.vault.adapter.exists(folder))) {
        await plugin.app.vault.createFolder(folder); // obsidian.d.ts:7404
      }
      await plugin.app.vault.create(path, note.content); // obsidian.d.ts:7386
    }
    result.written++;
    result.spansWritten += note.added;
    if (!note.exists) result.newCount++;
  }
  return result;
}

/**
 * "AI-highlight this PDF into the wiki…": the PDF's text layer in, wiki notes
 * out, gated by a per-span preview. Every span the model proposes is verified
 * verbatim against the page it claims to come from before it is ever offered,
 * and a batch that throws aborts the whole run with nothing written.
 */
export async function suggestPdfHighlights(
  plugin: WikiLmPlugin,
  pdf: TFile,
  opts: { transcriptGate?: () => Promise<"paste" | "skip" | "cancel"> } = {},
): Promise<void> {
  let ownsRun = false;
  try {
    const s = plugin.settings;

    // (1) The text layer and the highlights that are already there.
    const { manifest, pages, warnings } = await collectPdfHighlights(plugin, pdf, { paperText: false, pages: true });
    await writeManifest(plugin, manifest);
    if (warnings.length) new Notice(`WikiLM: ${warnings.join("; ")}`, 8000); // obsidian.d.ts:4613
    // A scanned deck parses fine but every page comes back with no text items,
    // so checking the page count alone would let the run reach the model with
    // empty pages. Say what is actually wrong instead.
    if (pages.length === 0 || pages.every((p) => p.items.length === 0)) {
      new Notice("WikiLM: this PDF has no text layer — it looks like a scan, and needs OCR before highlights can be suggested.", 8000);
      return;
    }
    const maps = new Map<number, PageMap>(pages.map((p, i) => [i + 1, buildPageMap(p.items)]));

    // (2) Class code: the wiki notes are filtered by it and every new note gets it.
    let classCode = manifest.classCode;
    if (!classCode) {
      const asked = await askInstruction(plugin.app, "Class code for this PDF", "e.g. HBIO250");
      if (asked === null) return;
      classCode = asked.trim();
      if (!classCode) {
        new Notice("WikiLM: a class code is needed to find this PDF's wiki notes.");
        return;
      }
      manifest.classCode = classCode;
    }

    // (3) The lecture transcript, when one was attached to this PDF's path.
    let transcript = plugin.store.getTranscript(pdf.path)?.text ?? null;
    // The chat offers to paste one before the model picks anything: a lecture
    // transcript or a study guide is what tells the suggester which spans the
    // class actually cared about. The palette has no gate and runs as before.
    if (transcript === null && opts.transcriptGate) {
      const c = await opts.transcriptGate();
      if (c === "cancel") return;
      transcript = plugin.store.getTranscript(pdf.path)?.text ?? null;
    }

    // (4) Notes, flashcards, or both — the digest's chooser, reused.
    const options = await askDigestOptions(
      plugin.app,
      { product: "notes", instruction: "" },
      "Suggest highlights in this PDF",
    );
    if (options === null) return;

    // (5) The notes the model may assign spans to by name.
    const wiki = await wikiNotes(plugin, classCode, manifest.sources);

    // (6) One request per page batch, each told what the previous ones took.
    const perPage = SUGGEST_PER_PAGE[s.suggestGranularity];
    const cap = s.suggestMaxPerPdf;
    const existingKeys = new Set(manifest.highlights.map((h) => h.key));
    const accepted: VerifiedSpan[] = [];
    const newNotes: SuggestDraft["new_notes"] = [];
    let unlocated = 0;

    ownsRun = !plugin.cancel.active;
    if (ownsRun) plugin.cancel.begin(`highlighting ${manifest.pdfBasename}`);
    let stopped = false;

    for (const batch of batchPages(pages.length, s.suggestPagesPerBatch)) {
      if (plugin.cancel.cancelled) {
        stopped = true;
        break;
      }
      plugin.cancel.progress(`pages ${batch.from}–${batch.to} of ${pages.length}`);
      const remaining = cap - accepted.length;
      if (remaining <= 0) break;

      new Notice(`WikiLM: suggesting highlights, pages ${batch.from}–${batch.to} of ${pages.length}…`);

      const range: number[] = [];
      for (let n = batch.from; n <= batch.to; n++) range.push(n);

      const draft = await plugin.llm.suggest({
        pdfTitle: manifest.pdfBasename,
        classCode,
        pages: range.map((n) => ({ page: n, text: maps.get(n)?.text ?? "" })),
        transcript,
        existingNotes: existingNotesFor(wiki, newNotes),
        alreadySelected: [
          ...manifest.highlights
            .filter((h) => h.page >= batch.from && h.page <= batch.to)
            .map((h) => ({ page: h.page, text: h.text.slice(0, ALREADY_SELECTED_CHARS) })),
          ...accepted
            .filter((a) => a.page >= batch.from && a.page <= batch.to)
            .map((a) => ({ page: a.page, text: a.quote.slice(0, ALREADY_SELECTED_CHARS) })),
        ],
        perPage,
        remaining,
        standingInstructions: s.suggestInstructions,
        instruction: options.instruction,
      });

      const r = verifySpans(draft, maps, { perPage, remaining, existingKeys, batch });
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
    if (ownsRun) plugin.cancel.end();
    if (stopped) new Notice("WikiLM: stopped; keeping what was already verified.");

    if (accepted.length === 0) {
      new Notice("WikiLM: no highlights suggested.");
      return;
    }

    // (7) Plan, then preview.
    const highlights = toManifestHighlights(accepted, maps, s.contextChars);
    const planOpts = {
      classCode,
      pdfBasename: manifest.pdfBasename,
      conceptsFolder: s.wikiConceptsFolder,
      entitiesFolder: s.wikiEntitiesFolder,
      schema: s.wikiSchema,
    };
    const plan = planWikiNotes(accepted, highlights, newNotes, wiki, planOpts);
    const alreadyPresent = plan.notes.reduce((n, x) => n + x.skipped, 0);
    const flashcards = options.product === "notes" ? 0 : highlights.length;

    const choices = await previewSuggestions(
      plugin.app,
      plan.notes,
      { flashcards, unlocated, orphanTitles: plan.orphanTitles, alreadyPresent, routed: plan.routed.length },
      manifest.pdfBasename,
    );
    if (choices === null) return;

    const applied = applyPreviewChoices(accepted, choices, newNotes, wiki, plan.routed);
    if (applied.spans.length === 0) {
      new Notice("WikiLM: nothing selected; nothing written.");
      return;
    }
    const final = planWikiNotes(applied.spans, highlights, applied.newNotes, wiki, { ...planOpts, keepAsNew: applied.keepAsNew });

    // (9) Write, then queue cards. A source is never a note: a page named
    // after the PDF, or written into the folder the PDF lives in, would put
    // generated prose where the reader keeps their originals.
    const refuse = (note: PreparedNote) =>
      note.path.split("/").includes("sources") || safeTitle(note.title) === safeTitle(manifest.pdfBasename);
    const result =
      options.product === "flashcards"
        ? { written: 0, newCount: 0, spansWritten: 0, refused: 0 }
        : await writeNotes(plugin, final.notes, refuse);
    let queued = 0;
    if (options.product !== "notes") {
      for (const note of final.notes) {
        if (refuse(note)) continue;
        const topicPath = options.product === "flashcards" ? null : normalizePath(note.path);
        queued += captureManifestHighlights(plugin, manifest, note.highlights, note.title, topicPath).added;
      }
    }
    const { spansWritten, newCount, refused } = result;

    if (options.product === "flashcards") {
      new Notice(`WikiLM: ${queued} highlight${queued === 1 ? "" : "s"} queued as flashcards.`, 8000);
      return;
    }
    const written = result.written;
    const tail = queued > 0 ? `, ${queued} queued as flashcards` : "";
    const refusedTail = refused > 0 ? `, ${refused} refused (a source is never a note)` : "";
    const filed = final.routed.length;
    const filedTail = filed > 0 ? `, ${filed} proposed note${filed === 1 ? "" : "s"} filed into existing ones` : "";
    new Notice(
      `WikiLM: wrote ${spansWritten} span${spansWritten === 1 ? "" : "s"} into ${written} note${written === 1 ? "" : "s"} (${newCount} new)${filedTail}${tail}${refusedTail}.`,
      8000,
    );
  } catch (e) {
    if (ownsRun) plugin.cancel.end();
    console.error("WikiLM: suggesting highlights failed", e);
    new Notice(`WikiLM: suggesting highlights failed. ${describeError(e)}`, 8000);
  }
}
