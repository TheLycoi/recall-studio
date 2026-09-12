/**
 * Digest orchestration: the Obsidian-side glue between the highlight collector
 * (src/pdfHighlights.ts), the model or a pasted draft, the pure planner
 * (src/topicNote.ts), the preview modal (src/modals.ts) and the vault.
 *
 * Nothing here parses, renders or ranks anything itself: every one of those
 * lives in a pure module with its own tests. This file only decides what to
 * read, what to ask, and what to write.
 */
import { Notice, TFile, normalizePath } from "obsidian";
import type RecallPlugin from "./main";
import { captureManifestHighlights } from "./capture";
import { describeError } from "./llm";
import type { Manifest } from "./manifest";
import { askDigestOptions, askInstruction, askPastedJson, previewDigest } from "./modals";
import { collectPdfHighlights, readManifestNote, writeManifest } from "./pdfHighlights";
import { isPdfFile } from "./pdf";
import { DigestOut, type DigestDraft } from "./schemas";
import { planTopicNotes, safeTitle } from "./topicNote";

/** Local calendar date, `YYYY-MM-DD`, for the topic note's `created` field. */
function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The help text of the paste modal, which mirrors the plan's interim manual
 * procedure: paste DIGEST_SYSTEM and the manifest into a chat session, then
 * bring its JSON back here.
 */
const PASTE_HELP =
  "Paste the JSON object the model returned — " +
  '{"notes":[{"title":"…","summary":"…","highlight_ids":["H01"],"related":["…"]}],"unused_ids":["…"]} — ' +
  "referring to highlights by the `id::` in each manifest callout; Recall renders every link and callout itself.";

/**
 * "Extract PDF highlights to manifest": collect the PDF's highlights (no paper
 * text — the plain extract command does not need it), write the manifest and
 * open it.
 */
export async function extractPdfHighlights(plugin: RecallPlugin, pdf: TFile): Promise<TFile | null> {
  try {
    const { manifest, warnings } = await collectPdfHighlights(plugin, pdf, { paperText: false });
    const file = await writeManifest(plugin, manifest);

    const n = manifest.highlights.length;
    const s = manifest.sources.length;
    const bits = `Recall: ${n} highlight${n === 1 ? "" : "s"} from ${s} source note${s === 1 ? "" : "s"}.`;
    if (warnings.length) new Notice(`${bits} ${warnings.join("; ")}`, 8000); // obsidian.d.ts:4613
    else new Notice(bits);

    // obsidian.d.ts:7892 (getLeaf) and :8257 (openFile).
    await plugin.app.workspace.getLeaf("tab").openFile(file);
    return file;
  } catch (e) {
    console.error("Recall: extracting PDF highlights failed", e);
    new Notice(`Recall: extracting highlights failed. ${describeError(e)}`);
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
async function resolveSource(plugin: RecallPlugin, source: TFile): Promise<Resolved | null> {
  if (isPdfFile(source)) {
    const { manifest, paperText } = await collectPdfHighlights(plugin, source, { paperText: true });
    await writeManifest(plugin, manifest);
    return { manifest, paperText };
  }

  const manifest = await readManifestNote(plugin, source);
  if (!manifest) {
    new Notice("Recall: this note is not a Recall manifest. Run “Extract PDF highlights to manifest” on a PDF first.");
    return null;
  }

  // obsidian.d.ts:7369.
  const pdf = plugin.app.vault.getAbstractFileByPath(manifest.pdfPath);
  if (pdf instanceof TFile) {
    const { paperText } = await collectPdfHighlights(plugin, pdf, { paperText: true });
    return { manifest, paperText };
  }
  new Notice(`Recall: ${manifest.pdfPath} is no longer in the vault; summarising from the highlights alone.`, 8000);
  return { manifest, paperText: "" };
}

/** Titles of the notes already in `<topicFolder>/<classCode>`, minus the class hub note. */
function existingTitles(plugin: RecallPlugin, topicFolder: string, classCode: string): string[] {
  const prefix = `${normalizePath(`${topicFolder}/${classCode}`)}/`;
  const titles: string[] = [];
  for (const file of plugin.app.vault.getMarkdownFiles()) {
    if (!file.path.startsWith(prefix)) continue;
    if (file.path.slice(prefix.length).includes("/")) continue; // directly under the class folder only
    if (file.basename === classCode) continue; // the hub note
    titles.push(file.basename);
  }
  return titles.sort((a, b) => a.localeCompare(b));
}

/** Read every planned path that already exists, for the planner's merge branch. */
async function readExisting(plugin: RecallPlugin, paths: string[]): Promise<Record<string, string>> {
  const existing: Record<string, string> = {};
  for (const path of paths) {
    const file = plugin.app.vault.getAbstractFileByPath(normalizePath(path));
    if (file instanceof TFile) existing[path] = await plugin.app.vault.cachedRead(file);
  }
  return existing;
}

/** The path `planTopicNotes` derives for a title (kept in step with it here). */
function pathFor(topicFolder: string, classCode: string, title: string): string {
  return `${topicFolder}/${classCode}/${safeTitle(title)}.md`;
}

/** Ask the model for a draft; null when the call failed (the Notice is raised here). */
async function draftFromModel(
  plugin: RecallPlugin,
  manifest: Manifest,
  classCode: string,
  paperText: string,
  instruction: string,
): Promise<DigestDraft | null> {
  const s = plugin.settings;
  try {
    return await plugin.llm.digest({
      pdfTitle: manifest.pdfBasename,
      classCode,
      paperText,
      highlights: manifest.highlights.map((h) => ({ id: h.id, page: h.page, text: h.text })),
      existingTitles: existingTitles(plugin, s.topicFolder, classCode),
      maxNotes: s.digestMaxNotes,
      standingInstructions: s.digestInstructions,
      instruction,
    });
  } catch (e) {
    console.error("Recall: digest failed", e);
    new Notice(
      `Recall: digest failed. ${describeError(e)} Run “Extract PDF highlights to manifest” and digest by hand, or paste a model's JSON.`,
      10000,
    );
    return null;
  }
}

/** Ask for the model's JSON and validate it; null when cancelled or unusable. */
async function draftFromPaste(plugin: RecallPlugin): Promise<DigestDraft | null> {
  const raw = await askPastedJson(plugin.app, "Paste the model's JSON", PASTE_HELP);
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    new Notice(`Recall: that is not valid JSON. ${(e as Error).message}`, 8000);
    return null;
  }
  const checked = DigestOut.safeParse(parsed);
  if (!checked.success) {
    const first = checked.error.issues[0];
    new Notice(
      `Recall: the JSON does not match the digest shape${first ? ` (${first.path.join(".")}: ${first.message})` : ""}.`,
      10000,
    );
    return null;
  }
  return checked.data;
}

/**
 * "Digest PDF highlights…": manifest in, topic notes out, gated by a preview.
 * `mode` chooses where the draft comes from — the provider, or a JSON blob
 * pasted from a chat session (the interim path while no provider works).
 */
export async function digestPdf(plugin: RecallPlugin, source: TFile, mode: "model" | "paste"): Promise<void> {
  try {
    const resolved = await resolveSource(plugin, source);
    if (!resolved) return;
    const { manifest, paperText } = resolved;

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

    const draft =
      mode === "model"
        ? await draftFromModel(plugin, manifest, classCode, paperText, instruction)
        : await draftFromPaste(plugin);
    if (!draft) return;

    const topicFolder = plugin.settings.topicFolder;
    const created = today();
    const plan = async (d: DigestDraft) => {
      const paths = d.notes.map((n) => pathFor(topicFolder, classCode, n.title));
      const existing = await readExisting(plugin, paths);
      return planTopicNotes(d, manifest, { classCode, topicFolder, created, existing });
    };

    const planned = await plan(draft);
    if (planned.notes.length === 0) {
      new Notice("Recall: the draft named no highlight that exists in this manifest; nothing to write.", 8000);
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
    // patch the rendered content, substitute the chosen titles back into the
    // draft and re-plan once against a freshly read `existing`.
    // `previewDigest` returns the chosen notes with `title` overwritten by the
    // edit box but `path` still the original, so the original title is the
    // path's basename and the pair is unambiguous.
    const renamed = new Map<string, string>();
    const keptTitles = new Set<string>();
    for (const note of chosen) {
      const original = planned.notes.find((n) => n.path === note.path);
      const from = original ? original.title : safeTitle(note.title);
      const to = safeTitle(note.title);
      if (to !== from) renamed.set(from, to);
      keptTitles.add(to.toLowerCase());
    }
    const substituted: DigestDraft = {
      ...draft,
      notes: draft.notes.map((n) => {
        const t = safeTitle(n.title);
        return renamed.has(t) ? { ...n, title: renamed.get(t)! } : n;
      }),
    };
    const finalPlan = renamed.size > 0 ? await plan(substituted) : planned;
    const toWrite = finalPlan.notes.filter((n) => keptTitles.has(n.title.toLowerCase()));

    // Write.
    const folder = normalizePath(`${topicFolder}/${classCode}`);
    let written = 0;
    let appended = 0;
    let alreadyPresent = 0;
    let queued = 0;
    for (const note of toWrite) {
      const path = normalizePath(note.path);
      const file = plugin.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        await plugin.app.vault.modify(file, note.content); // obsidian.d.ts:7467
      } else {
        // Same folder-creation pattern as the Anki export in src/main.ts.
        if (!(await plugin.app.vault.adapter.exists(folder))) {
          await plugin.app.vault.createFolder(folder); // obsidian.d.ts:7404
        }
        await plugin.app.vault.create(path, note.content); // obsidian.d.ts:7386
      }
      written++;
      appended += note.added;
      alreadyPresent += note.skipped;
      if (product === "both") queued += captureManifestHighlights(plugin, manifest, note.highlights, note.title, path).added;
    }

    const bits = [
      `${written} note${written === 1 ? "" : "s"} written`,
      `${appended} highlight${appended === 1 ? "" : "s"} appended`,
      `${alreadyPresent} skipped as present`,
    ];
    if (queued > 0) bits.push(`${queued} flashcard${queued === 1 ? "" : "s"} queued`);
    new Notice(`Recall: ${bits.join(", ")}.`, 8000);
  } catch (e) {
    console.error("Recall: digest failed", e);
    new Notice(`Recall: digest failed. ${describeError(e)}`, 8000);
  }
}
