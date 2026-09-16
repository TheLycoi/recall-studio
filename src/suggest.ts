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
import { batchPages, planWikiNotes, toManifestHighlights, verifySpans, type VerifiedSpan, type WikiNoteIn } from "./suggestPlan";
import { noteSections, safeTitle } from "./topicNote";

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
async function wikiNotes(plugin: WikiLmPlugin, classCode: string, sources: string[]): Promise<WikiNoteIn[]> {
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
function existingNotesFor(wiki: WikiNoteIn[], newNotes: SuggestDraft["new_notes"]): SuggestExistingNote[] {
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

/**
 * "AI-highlight this PDF into the wiki…": the PDF's text layer in, wiki notes
 * out, gated by a per-span preview. Every span the model proposes is verified
 * verbatim against the page it claims to come from before it is ever offered,
 * and a batch that throws aborts the whole run with nothing written.
 */
export async function suggestPdfHighlights(plugin: WikiLmPlugin, pdf: TFile): Promise<void> {
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
    const transcript = plugin.store.getTranscript(pdf.path)?.text ?? null;

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

    for (const batch of batchPages(pages.length, s.suggestPagesPerBatch)) {
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
      { flashcards, unlocated, orphanTitles: plan.orphanTitles, alreadyPresent },
      manifest.pdfBasename,
    );
    if (choices === null) return;

    // (8) Re-plan against the user's edits. The planner is pure, so rather than
    // patch rendered content — which for an existing note is built from the file
    // it merges into — the kept spans are re-pointed at the (possibly renamed)
    // titles and the whole plan is built again.
    const titleByKey = new Map<string, string>();
    for (const choice of choices) {
      const title = safeTitle(choice.title);
      for (const h of choice.highlights) titleByKey.set(h.key, title);
    }

    const wikiTitles = new Set(wiki.map((w) => w.title.toLowerCase()));
    const newNotesEdited = newNotes.slice();
    const keptSpans: VerifiedSpan[] = [];
    for (const sp of accepted) {
      const title = titleByKey.get(sp.key);
      if (title === undefined) continue; // unchecked in the preview
      keptSpans.push(title === sp.noteTitle ? sp : { ...sp, noteTitle: title });

      // A title the user typed over a proposed one is announced as a new note
      // so it keeps the kind and summary the model gave the group it replaced.
      const key = title.toLowerCase();
      if (wikiTitles.has(key)) continue;
      if (newNotesEdited.some((n) => safeTitle(n.title).toLowerCase() === key)) continue;
      const original = newNotes.find((n) => safeTitle(n.title).toLowerCase() === sp.noteTitle.toLowerCase());
      newNotesEdited.push(original ? { ...original, title } : { title, kind: sp.noteKind, summary: "" });
    }

    if (keptSpans.length === 0) {
      new Notice("WikiLM: nothing selected; nothing written.");
      return;
    }

    const final = planWikiNotes(keptSpans, highlights, newNotesEdited, wiki, planOpts);

    // (9) Write. Same vault idiom as the digest (src/digest.ts:278-294).
    let spansWritten = 0;
    let newCount = 0;
    let queued = 0;
    let refused = 0;
    for (const note of final.notes) {
      // The topic note this note's highlights were digested into, so an
      // exported card links to the concept and not only to the source PDF.
      // A flashcards-only run writes no note, so there is no topic to link.
      const topicPath = options.product === "flashcards" ? null : normalizePath(note.path);
      if (topicPath !== null) {
        const path = topicPath;
        // A source is never a note. The planner cannot produce either of these
        // today, but a note named after the PDF, or written into the folder the
        // PDF itself lives in, would put generated prose where the reader keeps
        // their originals — so refuse rather than trust the caller.
        if (path.split("/").includes("sources") || safeTitle(note.title) === safeTitle(manifest.pdfBasename)) {
          refused++;
          continue;
        }
        const file = plugin.app.vault.getAbstractFileByPath(path); // obsidian.d.ts:7369
        if (file instanceof TFile) {
          await plugin.app.vault.modify(file, note.content); // obsidian.d.ts:7467
        } else {
          const folder = path.split("/").slice(0, -1).join("/");
          // Same folder-creation pattern as the Anki export in src/main.ts.
          if (folder && !(await plugin.app.vault.adapter.exists(folder))) {
            await plugin.app.vault.createFolder(folder); // obsidian.d.ts:7404
          }
          await plugin.app.vault.create(path, note.content); // obsidian.d.ts:7386
        }
      }
      spansWritten += note.added;
      if (!note.exists) newCount++;
      if (options.product !== "notes") {
        queued += captureManifestHighlights(plugin, manifest, note.highlights, note.title, topicPath).added;
      }
    }

    if (options.product === "flashcards") {
      new Notice(`WikiLM: ${queued} highlight${queued === 1 ? "" : "s"} queued as flashcards.`, 8000);
      return;
    }
    const written = final.notes.length - refused;
    const tail = queued > 0 ? `, ${queued} queued as flashcards` : "";
    const refusedTail = refused > 0 ? `, ${refused} refused (a source is never a note)` : "";
    new Notice(
      `WikiLM: wrote ${spansWritten} span${spansWritten === 1 ? "" : "s"} into ${written} note${written === 1 ? "" : "s"} (${newCount} new)${tail}${refusedTail}.`,
      8000,
    );
  } catch (e) {
    console.error("WikiLM: suggesting highlights failed", e);
    new Notice(`WikiLM: suggesting highlights failed. ${describeError(e)}`, 8000);
  }
}
