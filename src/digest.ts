/**
 * Digest orchestration: the Obsidian-side glue between the highlight collector
 * (src/pdfHighlights.ts), the model, the pure planner
 * (src/topicNote.ts), the preview modal (src/modals.ts) and the vault.
 *
 * Nothing here parses, renders or ranks anything itself: every one of those
 * lives in a pure module with its own tests. This file only decides what to
 * read, what to ask, and what to write.
 */
import { Notice, TFile, normalizePath } from "obsidian";
import type WikiLmPlugin from "./main";
import { captureManifestHighlights } from "./capture";
import { decideGate, digestFolderSummary, isDigestTarget, planDigestFolder, type DigestFolderTally, type GateDecision } from "./digestGate";
import { describeError } from "./llm";
import type { Manifest, ManifestHighlight } from "./manifest";
import { askDigestOptions, askInstruction, previewDigest, type DigestProduct } from "./modals";
import { collectPdfHighlights } from "./pdfHighlights";
import { isPdfFile } from "./pdf";
import type { DigestDraft } from "./schemas";
import { suggestPdfHighlights } from "./suggest";
import { applyDigestChoices, mergeTopicHighlights, noteAliases, noteOutline, noteSections, parseTopicNote, planTopicNotes, replayArticles, type ExistingPage, type PreparedNote } from "./topicNote";
import { coveredBy, indexNote, type EvidenceUnit } from "./retrieval";
import type { DigestExistingNote } from "./prompt";

/** Local calendar date, `YYYY-MM-DD`, for the topic note's `created` field. */
function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The manifest and the paper text a digest run works from. */
interface Resolved {
  manifest: Manifest;
  paperText: string;
}

/** The highlights and paper text of a PDF, read fresh; anything else is refused. */
async function resolveSource(plugin: WikiLmPlugin, source: TFile): Promise<Resolved | null> {
  if (!isPdfFile(source)) {
    new Notice("WikiLM: open the PDF itself, or a note that holds PDF++ links to it, then digest.");
    return null;
  }
  // The highlights are read from the PDF and from the notes that link it,
  // every run. Nothing is cached on disk: the links in the reader's own notes
  // are the record, and a folder of manifests beside them was a second copy
  // of what they had already written.
  const { manifest, paperText } = await collectPdfHighlights(plugin, source, { paperText: true });
  return { manifest, paperText };
}

/** Every page under the topic folder, all classes, minus the hub notes: what the digest may merge into or file under. */
async function existingPages(plugin: WikiLmPlugin, topicFolder: string): Promise<ExistingPage[]> {
  const { schemaFolder, transcriptFolder } = plugin.settings;
  const folders = { topicFolder: normalizePath(topicFolder), schemaFolder, transcriptFolder };
  const out: ExistingPage[] = [];
  for (const file of plugin.app.vault.getMarkdownFiles()) {
    if (!isDigestTarget(file.path, folders)) continue;
    const md = await plugin.app.vault.cachedRead(file);
    const parsed = parseTopicNote(md);
    const type = /^type:\s*(.+)$/m.exec(/^---\r?\n([\s\S]*?)\r?\n---/.exec(md)?.[1] ?? "")?.[1]?.trim() ?? "";
    // A hub says so in its frontmatter, or says it by name: the class index is
    // the page carrying its own folder's name (classes/BIO101/BIO101.md),
    // which is how the old title list kept it out. A hub is a table of
    // contents, never somewhere a highlight belongs.
    if (type === "topic-index" || file.basename === file.parent?.name) continue;
    out.push({
      path: file.path,
      title: parsed.title || file.basename,
      kind: type === "entity" ? "entity" : "concept",
      aliases: noteAliases(md),
      classCodes: parsed.classCodes,
      md,
    });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

/** The same pages as the prompt lists them: what each is, what it is also called, and what is already under it. */
function toDigestExisting(pages: ExistingPage[], classCode: string): DigestExistingNote[] {
  return pages.map((p) => ({
    title: p.title,
    kind: p.kind,
    aliases: p.aliases,
    sections: noteSections(p.md).filter((s) => !/^(Summary|Highlights|Related topics|Flashcard Seeds|Key claims)$/i.test(s)),
    summary: (parseTopicNote(p.md).summary.split(/(?<=[.!?])\s/)[0] ?? "").trim(),
    classCodes: p.classCodes,
    // A page of this class is shown with what it already says under each
    // heading, so the model can tell a highlight that adds from one that
    // repeats. Other classes stay a title and a line: routing needs the
    // name, not the contents.
    outline: p.classCodes.includes(classCode) ? noteOutline(p.md) : undefined,
  }));
}

/**
 * The coverage check the planner and the merge use: whether a page — or any
 * page of the class, with `pagePath` null — already states a thing in other
 * words. Built once per run from the pages' evidence units, the same units
 * Ask retrieves over (src/retrieval.ts indexNote, coveredBy).
 */
function coverageCheck(pages: ExistingPage[], classCode: string): (pagePath: string | null, text: string) => boolean {
  const units = new Map<string, EvidenceUnit[]>();
  const unitsOf = (p: ExistingPage) => {
    let u = units.get(p.path);
    if (!u) {
      u = indexNote(p.path, p.md);
      units.set(p.path, u);
    }
    return u;
  };
  const inClass = pages.filter((p) => p.classCodes.includes(classCode));
  return (pagePath, text) => {
    if (!text.trim()) return false;
    if (pagePath) {
      const page = pages.find((p) => p.path === pagePath);
      return page ? coveredBy(text, unitsOf(page)).covered : false;
    }
    return inClass.some((p) => coveredBy(text, unitsOf(p)).covered);
  };
}

/** Ask the model for a draft; null when the call failed (the Notice is raised here). */
async function draftFromModel(
  plugin: WikiLmPlugin,
  manifest: Manifest,
  classCode: string,
  paperText: string,
  instruction: string,
  pages: ExistingPage[],
): Promise<DigestDraft | null> {
  const s = plugin.settings;
  try {
    return await plugin.llm.digest({
      pdfTitle: manifest.pdfBasename,
      classCode,
      paperText,
      highlights: manifest.highlights.map((h) => ({ id: h.id, page: h.page, text: h.text, heading: h.heading, notes: h.notes })),
      existingNotes: toDigestExisting(pages, classCode),
      maxNotes: s.digestMaxNotes,
      standingInstructions: s.digestInstructions,
      instruction,
    });
  } catch (e) {
    console.error("WikiLM: digest failed", e);
    new Notice(
      `WikiLM: digest failed. ${describeError(e)} Check the provider and the Claude Code CLI path in WikiLM's settings, then try again.`,
      10000,
    );
    return null;
  }
}

/**
 * Replay a planned merge against the page as it reads right now.
 *
 * The planner built `note.content` by folding the highlights into the copy of
 * the page it read before the model call; that copy is stale by the time the
 * reader accepts the preview. `mergeTopicHighlights` is pure and keyed by
 * `highlightKey`, so running it again over the current text reproduces exactly
 * the same additions while leaving every edit made in the meantime in place —
 * and a highlight the reader added by hand in that window is now recognised as
 * present and skipped rather than duplicated.
 *
 * `note.sections` records which `##` heading each highlight was filed under
 * (coalescing concatenates one entry per merge the planner ran), so the
 * grouping is rebuilt from it: anything not named there belongs in the page's
 * own `## Highlights` section, which is what the planner's default branch did.
 */
function remergeNote(
  current: string,
  pdfBasename: string,
  classCode: string,
  note: PreparedNote,
  covered?: (pagePath: string | null, text: string) => boolean,
): string {
  // An article row replays the article merge — the sections, the prose, the
  // quotes — against the page as it reads now, with the same coverage check
  // the plan used. Replaying the row merge here instead threw the prose away
  // and appended the quotes a second time under ## Highlights.
  // A row that took several groups replays each group's article in the order
  // the planner merged them; replaying only the first left the rest unwritten.
  const articles = note.articles ?? (note.article ? [{ article: note.article, section: note.articleSection }] : []);
  if (articles.length) {
    return replayArticles(current, pdfBasename, articles, {
      classCode,
      title: note.title,
      covered: covered ? (text) => covered(note.path, text) : undefined,
    });
  }
  const sectionOf = new Map<string, string>();
  for (const s of note.sections ?? []) {
    for (const key of s.keys) sectionOf.set(key, s.heading);
  }

  // Preserve the planner's order: the default section first when it merged
  // first, otherwise the order the section entries were recorded in.
  const bySection = new Map<string, ManifestHighlight[]>();
  for (const h of note.highlights) {
    const heading = sectionOf.get(h.key) ?? "";
    const list = bySection.get(heading);
    if (list) list.push(h);
    else bySection.set(heading, [h]);
  }

  let md = current;
  for (const [heading, highlights] of bySection) {
    md = mergeTopicHighlights(md, pdfBasename, highlights, {
      classCode,
      section: heading || undefined,
    }).md;
  }
  return md;
}

export interface DigestOptions {
  /**
   * What to do when the source has no highlights with text. Absent (the
   * palette): a Notice, and nothing is written. Present (the chat): the
   * callback shows its chips and answers; "highlight" runs the suggester on
   * the PDF first, "cancel" stops.
   */
  gate?: (decision: GateDecision) => Promise<"highlight" | "cancel">;
  /**
   * The product and instruction, already answered. A folder run asks once for
   * the whole folder and passes the answer here, so the form is not shown
   * again for every PDF.
   */
  options?: { product: DigestProduct; instruction: string };
  /**
   * The PDF's highlights and text, already read. A folder run reads every PDF
   * once to decide which ones qualify, and hands that read on rather than
   * parsing the document a second time.
   */
  resolved?: Resolved;
}

/** How one PDF's digest ended, for a folder run's tally. */
export type DigestOutcome = "digested" | "skipped" | "failed";

/**
 * "Digest: PDF highlights into concept and entity notes…": manifest in, topic
 * notes out, gated by a preview.
 * The draft always comes from the configured provider.
 */
export async function digestPdf(plugin: WikiLmPlugin, source: TFile, opts: DigestOptions = {}): Promise<DigestOutcome> {
  try {
    const resolved = opts.resolved ?? (await resolveSource(plugin, source));
    if (!resolved) return "failed";
    const { manifest, paperText } = resolved;

    const gate = decideGate(manifest);
    if (gate.action === "offer") {
      if (!opts.gate) {
        new Notice(
          `WikiLM: ${manifest.pdfBasename} has no highlights with text (${gate.total} without). Highlight it in PDF++, or run “AI highlight…” first.`,
          10000,
        );
        return "skipped";
      }
      const choice = await opts.gate(gate);
      if (choice === "highlight" && isPdfFile(source)) await suggestPdfHighlights(plugin, source);
      return "skipped";
    }

    let classCode = manifest.classCode;
    if (!classCode) {
      const asked = await askInstruction(plugin.app, "Class code for this PDF", "e.g. BIO101");
      if (asked === null) return "skipped";
      classCode = asked.trim();
      manifest.classCode = classCode;
    }

    const options = opts.options ?? (await askDigestOptions(plugin.app, { product: "notes", instruction: "" }));
    if (options === null) return "skipped";
    const { product, instruction } = options;

    // Flashcards only: no model call, no notes, straight into the inbox.
    if (product === "flashcards") {
      captureManifestHighlights(
        plugin,
        manifest,
        manifest.highlights.filter((h) => h.text.trim().length > 0),
        "",
        null,
      );
      return "digested";
    }

    const topicFolder = plugin.settings.topicFolder;
    const pages = await existingPages(plugin, topicFolder);

    const draft = await draftFromModel(plugin, manifest, classCode, paperText, instruction, pages);
    if (!draft) return "failed";

    const created = today();
    const covered = coverageCheck(pages, classCode);
    const plan = async (d: DigestDraft, keepAsNew: string[] = []) =>
      planTopicNotes(d, manifest, { classCode, topicFolder, created, pages, keepAsNew, coveredBy: covered });

    const planned = await plan(draft);
    if (planned.notes.length === 0) {
      new Notice("WikiLM: the draft named no highlight that exists in this manifest; nothing to write.", 8000);
      return "failed";
    }

    const flashcards = product === "both" ? planned.notes.reduce((sum, n) => sum + n.highlights.length, 0) : 0;
    const chosen = await previewDigest(
      plugin.app,
      planned.notes,
      { flashcards, unknownIds: planned.unknownIds, unassignedIds: planned.unassignedIds },
      manifest.pdfBasename,
    );
    if (chosen === null) return "skipped";

    // The preview lets titles be edited inline, which moves the path and can
    // flip a note between "create" and "merge into an existing note" — and the
    // content of a merge is built from the file it merges into. Rather than
    // patch the rendered content, narrow the draft to the groups the reader
    // kept (a row stands for one or more of the model's proposals; coalescing
    // makes `path`, not the title, its key) and re-plan it against the pages
    // read once before the preview. `previewDigest` returns the chosen rows
    // with `title` overwritten by the edit box and `path` still the original,
    // so the row is found by path and the pair is unambiguous. Re-planning
    // always: it is pure and cheap, and one code path has one behaviour.
    const chosenRows = chosen.map((n) => ({ path: n.path, title: n.title }));
    const { draft: narrowed, keepAsNew } = applyDigestChoices(draft, planned.notes, chosenRows);
    // A row ticked as "create this page" stays a creation through the re-plan,
    // even if its new title reads like a part of a page that already exists.
    const finalPlan = await plan(narrowed, keepAsNew);
    const toWrite = finalPlan.notes;

    // Write.
    let written = 0;
    let appended = 0;
    let alreadyPresent = 0;
    let said = 0;
    let queued = 0;
    for (const note of toWrite) {
      const path = normalizePath(note.path);
      const file = plugin.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        // `note.content` was merged against the copy of this page read by
        // `existingPages` before the model was called — a full LLM round trip
        // and a preview the reader ticks at their own pace ago. Writing that
        // string back with `modify` would be last-write-wins over anything
        // they typed into the page in that window. Re-run the same pure merge
        // inside `process` (read-modify-write under a lock,
        // obsidian.d.ts:7510) so the highlights land in the page as it reads
        // at write time, not as it read minutes earlier.
        await plugin.app.vault.process(file, (data) => remergeNote(data, manifest.pdfBasename, classCode, note, covered));
      } else {
        // A merge may land in another class's folder, so each note names its
        // own parent. Same folder-creation pattern as the Anki export in
        // src/main.ts.
        const folder = normalizePath(note.path.split("/").slice(0, -1).join("/"));
        if (folder && !(await plugin.app.vault.adapter.exists(folder))) {
          await plugin.app.vault.createFolder(folder); // obsidian.d.ts:7404
        }
        await plugin.app.vault.create(path, note.content); // obsidian.d.ts:7386
      }
      written++;
      appended += note.added;
      alreadyPresent += note.skipped;
      said += note.said ?? 0;
      if (product === "both") queued += captureManifestHighlights(plugin, manifest, note.highlights, note.title, path).added;
    }

    const bits = [
      `${written} note${written === 1 ? "" : "s"} written`,
      `${appended} highlight${appended === 1 ? "" : "s"} appended`,
      `${alreadyPresent} skipped as present`,
    ];
    if (said > 0) bits.push(`${said} already said`);
    if (queued > 0) bits.push(`${queued} flashcard${queued === 1 ? "" : "s"} queued`);
    const named = finalPlan.namedIds.length;
    if (named > 0) bits.push(`${named} slide title${named === 1 ? "" : "s"} left out`);
    new Notice(`WikiLM: ${bits.join(", ")}.`, 8000);
    return "digested";
  } catch (e) {
    console.error("WikiLM: digest failed", e);
    new Notice(`WikiLM: digest failed. ${describeError(e)}`, 8000);
    return "failed";
  }
}

/**
 * "Digest…" with more than one PDF ticked: every chosen PDF that has
 * highlights with text, digested in turn with one answer to the
 * product-and-instruction form.
 *
 * Each PDF still gets its own preview, because the preview is where the reader
 * decides what is written; closing it skips that PDF, not the run. Stopping
 * from the status bar (or "Cancel the running AI highlight, digest or ingest")
 * lets the PDF in hand finish and stops before the next. No model call is made
 * here beyond the one per PDF that `digestPdf` already makes.
 *
 * The list comes from the picker (src/digestPicker.ts pickDigestFiles), which
 * already turned any ticked folder into its PDFs, so nothing is walked here.
 */
export async function digestFiles(plugin: WikiLmPlugin, files: TFile[]): Promise<void> {
  if (files.length === 0) return;
  const noun = `${files.length} PDF${files.length === 1 ? "" : "s"}`;

  // Same rule as the folder ingest: one run holds the token at a time, and
  // taking it from a run already going would leave that run unstoppable.
  if (plugin.cancel.active) {
    const running = plugin.cancel.label ? ` (${plugin.cancel.label})` : "";
    new Notice(`WikiLM: another run is still going${running}. Digest the ${noun} once it finishes, or stop it from the status bar.`, 8000);
    return;
  }
  const owner = plugin.cancel.begin(`digesting ${noun}`);
  try {
    // Every PDF is read once, here, to apply the same gate `digestPdf` applies
    // (a highlight with text), and the read is handed to `digestPdf` so the
    // document is not parsed twice.
    const reads = new Map<string, Resolved>();
    // Paths whose PDF++ manifest could not even be resolved, kept apart from
    // "bare" (read fine, just no highlights) so the summary names the actual
    // reason instead of implying the reader never highlighted them.
    const unreadable = new Set<string>();
    for (const [i, f] of [...files].sort((a, b) => a.path.localeCompare(b.path)).entries()) {
      if (plugin.cancel.cancelled) {
        new Notice("WikiLM: stopped before anything was digested.");
        return;
      }
      plugin.cancel.progress(`reading ${i + 1}/${files.length} ${f.basename}`, owner);
      try {
        const r = await resolveSource(plugin, f);
        if (r) reads.set(f.path, r);
      } catch (e) {
        // One unreadable PDF is left out of the queue; it does not stop the run.
        console.error(`WikiLM: could not read ${f.path}`, e);
        unreadable.add(f.path);
      }
    }
    const plan = planDigestFolder(files, (f) => {
      const r = reads.get(f.path);
      return !!r && decideGate(r.manifest).action === "digest";
    });
    if (plan.queue.length === 0) {
      // "Has highlights with text" is a claim the read backs up; when every
      // PDF failed to read, or some did, say that instead of implying the
      // reader never highlighted them.
      const msg =
        unreadable.size === files.length
          ? `WikiLM: none of the ${noun} chosen could be read.`
          : `WikiLM: none of the ${noun} chosen has highlights with text${unreadable.size > 0 ? ` (${unreadable.size} could not be read)` : ""}. Highlight them in PDF++, or run “AI highlight…” on each first.`;
      new Notice(msg, 10000);
      return;
    }

    const options = await askDigestOptions(
      plugin.app,
      { product: "notes", instruction: "" },
      `Digest ${plan.queue.length} PDF${plan.queue.length === 1 ? "" : "s"}`,
    );
    if (options === null) return;

    // plan.bare holds every PDF that did not qualify, which includes the
    // unreadable ones (they never got a read to qualify with); subtract them
    // so a PDF is counted once, under the reason that actually applies.
    const tally: DigestFolderTally = {
      queued: plan.queue.length,
      digested: 0,
      skipped: 0,
      failed: 0,
      bare: plan.bare.filter((f) => !unreadable.has(f.path)).length,
      unreadable: unreadable.size,
      stopped: false,
    };
    for (const [i, pdf] of plan.queue.entries()) {
      if (plugin.cancel.cancelled) {
        tally.stopped = true;
        break;
      }
      plugin.cancel.progress(`${i + 1}/${plan.queue.length} ${pdf.basename}`, owner);
      const outcome = await digestPdf(plugin, pdf, { options, resolved: reads.get(pdf.path) });
      tally[outcome]++;
    }
    new Notice(`WikiLM: ${digestFolderSummary(tally)}.`, 10000);
  } finally {
    plugin.cancel.end(owner);
  }
}
