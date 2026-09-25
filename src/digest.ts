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
import { decideGate, type GateDecision } from "./digestGate";
import { describeError } from "./llm";
import type { Manifest, ManifestHighlight } from "./manifest";
import { askDigestOptions, askInstruction, previewDigest } from "./modals";
import { collectPdfHighlights, readManifestNote, writeManifest } from "./pdfHighlights";
import { isPdfFile } from "./pdf";
import type { DigestDraft } from "./schemas";
import { suggestPdfHighlights } from "./suggest";
import { applyDigestChoices, mergeTopicHighlights, noteAliases, noteOutline, noteSections, parseTopicNote, planTopicNotes, type ExistingPage, type PreparedNote } from "./topicNote";
import { coveredBy, indexNote, type EvidenceUnit } from "./retrieval";
import type { DigestExistingNote } from "./prompt";

/** Local calendar date, `YYYY-MM-DD`, for the topic note's `created` field. */
function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * "Extract PDF highlights to manifest": collect the PDF's highlights (no paper
 * text — the plain extract command does not need it), write the manifest and
 * open it.
 */
export async function extractPdfHighlights(plugin: WikiLmPlugin, pdf: TFile): Promise<TFile | null> {
  try {
    const { manifest, warnings } = await collectPdfHighlights(plugin, pdf, { paperText: false });
    const file = await writeManifest(plugin, manifest);

    const n = manifest.highlights.length;
    const s = manifest.sources.length;
    const bits = `WikiLM: ${n} highlight${n === 1 ? "" : "s"} from ${s} source note${s === 1 ? "" : "s"}.`;
    if (warnings.length) new Notice(`${bits} ${warnings.join("; ")}`, 8000); // obsidian.d.ts:4613
    else new Notice(bits);

    // obsidian.d.ts:7892 (getLeaf) and :8257 (openFile).
    await plugin.app.workspace.getLeaf("tab").openFile(file);
    return file;
  } catch (e) {
    console.error("WikiLM: extracting PDF highlights failed", e);
    new Notice(`WikiLM: extracting highlights failed. ${describeError(e)}`);
    return null;
  }
}

/** The manifest and the paper text a digest run works from. */
interface Resolved {
  manifest: Manifest;
  paperText: string;
}

/**
 * A PDF gives its manifest by extraction (and the manifest is written, so the
 * run is reproducible by hand); a manifest note gives it by parsing, and the
 * paper text is re-extracted from the PDF it names when that file is still
 * there. A missing PDF is not fatal: the highlights carry the material, the
 * paper text only widens the summary.
 */
async function resolveSource(plugin: WikiLmPlugin, source: TFile): Promise<Resolved | null> {
  if (isPdfFile(source)) {
    const { manifest, paperText } = await collectPdfHighlights(plugin, source, { paperText: true });
    await writeManifest(plugin, manifest);
    return { manifest, paperText };
  }

  const manifest = await readManifestNote(plugin, source);
  if (!manifest) {
    new Notice("WikiLM: this note is not a WikiLM manifest. Run “Extract PDF highlights to manifest” on a PDF first.");
    return null;
  }

  // obsidian.d.ts:7369.
  const pdf = plugin.app.vault.getAbstractFileByPath(manifest.pdfPath);
  if (pdf instanceof TFile) {
    const { paperText } = await collectPdfHighlights(plugin, pdf, { paperText: true });
    return { manifest, paperText };
  }
  new Notice(`WikiLM: ${manifest.pdfPath} is no longer in the vault; summarising from the highlights alone.`, 8000);
  return { manifest, paperText: "" };
}

/** Every page under the topic folder, all classes, minus the hub notes: what the digest may merge into or file under. */
async function existingPages(plugin: WikiLmPlugin, topicFolder: string): Promise<ExistingPage[]> {
  const prefix = `${normalizePath(topicFolder)}/`;
  const out: ExistingPage[] = [];
  for (const file of plugin.app.vault.getMarkdownFiles()) {
    if (!file.path.startsWith(prefix)) continue;
    const md = await plugin.app.vault.cachedRead(file);
    const parsed = parseTopicNote(md);
    const type = /^type:\s*(.+)$/m.exec(/^---\r?\n([\s\S]*?)\r?\n---/.exec(md)?.[1] ?? "")?.[1]?.trim() ?? "";
    // A hub says so in its frontmatter, or says it by name: the class index is
    // the page carrying its own folder's name (classes/HBIO250/HBIO250.md),
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
function remergeNote(current: string, pdfBasename: string, classCode: string, note: PreparedNote): string {
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
}

/**
 * "Digest PDF highlights…": manifest in, topic notes out, gated by a preview.
 * The draft always comes from the configured provider.
 */
export async function digestPdf(plugin: WikiLmPlugin, source: TFile, opts: DigestOptions = {}): Promise<void> {
  try {
    const resolved = await resolveSource(plugin, source);
    if (!resolved) return;
    const { manifest, paperText } = resolved;

    const gate = decideGate(manifest);
    if (gate.action === "offer") {
      if (!opts.gate) {
        new Notice(
          `WikiLM: ${manifest.pdfBasename} has no highlights with text (${gate.total} without). Highlight it in PDF++, or run “AI-highlight this PDF into the wiki…” first.`,
          10000,
        );
        return;
      }
      const choice = await opts.gate(gate);
      if (choice === "highlight" && isPdfFile(source)) await suggestPdfHighlights(plugin, source);
      return;
    }

    let classCode = manifest.classCode;
    if (!classCode) {
      const asked = await askInstruction(plugin.app, "Class code for this PDF", "e.g. HBIO250");
      if (asked === null) return;
      classCode = asked.trim();
      manifest.classCode = classCode;
    }

    const options = await askDigestOptions(plugin.app, { product: "notes", instruction: "" });
    if (options === null) return;
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
      return;
    }

    const topicFolder = plugin.settings.topicFolder;
    const pages = await existingPages(plugin, topicFolder);

    const draft = await draftFromModel(plugin, manifest, classCode, paperText, instruction, pages);
    if (!draft) return;

    const created = today();
    const covered = coverageCheck(pages, classCode);
    const plan = async (d: DigestDraft, keepAsNew: string[] = []) =>
      planTopicNotes(d, manifest, { classCode, topicFolder, created, pages, keepAsNew, coveredBy: covered });

    const planned = await plan(draft);
    if (planned.notes.length === 0) {
      new Notice("WikiLM: the draft named no highlight that exists in this manifest; nothing to write.", 8000);
      return;
    }

    const flashcards = product === "both" ? planned.notes.reduce((sum, n) => sum + n.highlights.length, 0) : 0;
    const chosen = await previewDigest(
      plugin.app,
      planned.notes,
      { flashcards, unknownIds: planned.unknownIds, unassignedIds: planned.unassignedIds },
      manifest.pdfBasename,
    );
    if (chosen === null) return;

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
        await plugin.app.vault.process(file, (data) => remergeNote(data, manifest.pdfBasename, classCode, note));
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
  } catch (e) {
    console.error("WikiLM: digest failed", e);
    new Notice(`WikiLM: digest failed. ${describeError(e)}`, 8000);
  }
}
