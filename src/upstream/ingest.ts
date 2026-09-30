/**
 * Ingest on upstream's engine: WikiLM's "ingest-source" and "ingest-folder"
 * commands, run by obsidian-llm-wiki's WikiEngine instead of the span
 * pipeline in src/ingestSource.ts (kept, and no longer called by them).
 *
 * The engine writes as it goes: the summary page, then one page per entity and
 * concept, then the index and log. There is no preview. What WikiLM adds is
 * around the run: the reader starts it, can stop it from the status bar or
 * "cancel-ingestion", and is shown every page it created or updated and every
 * other file it wrote, by path, when it ends however it ends. Every write goes
 * through the host's guard (src/upstream/guardedVault.ts), which starts afresh
 * with each run; the report also names each page the guard kept as it was,
 * why, and where the proposed text and the earlier texts were saved.
 *
 * PDFs never reach the engine. They are WikiLM's highlight digest's to read,
 * and the host has already switched upstream's PDF conversion off
 * (src/upstream/host.ts, `forcePdfSupport`); refusing here says why instead
 * of leaving the reader with upstream's "provider does not support PDF".
 *
 * Nor does a note inside the wiki (sourceRefusal). Upstream reads any note
 * under <wiki>/sources/ as a conversation, and every page it merges into
 * loses its whole `## Mentions in Source` block to a one-line citation; a wiki
 * page ingested as its own source is always sent to a body rewrite. Both are
 * refused with the reason, before the engine is built.
 *
 * The folder run follows upstream's own (runBatchIngest in
 * vendor/llm-wiki/src/main-commands/ingest-commands.ts): the same
 * already-ingested check, one batch context shared by every file so a
 * duplicate within the run is caught, a failed file logged and passed over,
 * and a stop after a cancelled file. Where upstream's filter passes over the
 * wiki folder in silence, WikiLM refuses each file there, and each file in
 * one of its own folders, and names it in the report. Upstream's IngestQueue
 * is left out: it feeds only its multi-file picker, which WikiLM does not have.
 */
import { Notice, TFile, type TFolder } from "obsidian";
import type WikiLmPlugin from "../main";
import type { WikiLmSettings } from "../settings";
import { describeLoss, type GuardRefusal } from "./guardedVault";
import { upstreamWikiFolder } from "./host";
import {
  isExcludedFromSourcePicker,
  isInFolderScope,
  pageBelongsToNote,
  slugify,
  UPSTREAM_SOURCE_EXTENSIONS,
  type IngestOptions,
  type IngestReport,
  type WikiEngine,
} from "./vendor";

/** Why a PDF is not ingested, and where the reader takes it instead. */
export const PDF_REFUSAL =
  "PDFs are read by WikiLM's highlight digest, not by ingest. Open the PDF and run “Digest: PDF highlights into concept and entity notes…”";

type UpstreamRejection = NonNullable<IngestReport["rejectedFiles"]>[number];

/**
 * A file turned away, by upstream's requirements gate or by WikiLM before the
 * engine saw it: "wiki-folder" for a note inside the wiki (or the config
 * folder), "wikilm-folder" for one in a folder WikiLM writes itself.
 */
export interface Rejection {
  path: string;
  reason: UpstreamRejection["reason"] | "wiki-folder" | "wikilm-folder";
  detail?: string;
}

/**
 * Upstream's report, plus every other file the engine wrote in the run: its
 * index and log, a page whose links it re-pointed, the schema note it creates
 * the first time. Upstream's report lists only the pages it created or
 * updated, and the reader is told everything that was written.
 */
export interface WikiLmIngestReport extends Omit<IngestReport, "rejectedFiles"> {
  rejectedFiles?: Rejection[];
  alsoWritten?: string[];
  /** Pages the guard kept as they were: a rewrite, a removal or a move it refused. */
  kept?: GuardRefusal[];
  /** The folder holding the text each page had before the run changed it. */
  snapshots?: string;
}

type SourceFolders = Pick<WikiLmSettings, "wikiConceptsFolder" | "wikiEntitiesFolder" | "schemaFolder" | "exportFolder" | "topicFolder">;

/**
 * WikiLM's own folders, named as its settings tab names them. The first two
 * are the wiki's pages; the rest are notes WikiLM writes itself.
 */
const WIKILM_FOLDERS: ReadonlyArray<[keyof SourceFolders, string]> = [
  ["wikiConceptsFolder", "wiki concepts folder"],
  ["wikiEntitiesFolder", "wiki entities folder"],
  ["schemaFolder", "schema folder"],
  ["exportFolder", "text export folder"],
  ["topicFolder", "topic notes folder"],
];

/**
 * Why a note at `path` is not a source, or null when it is one. Pure.
 *
 * Refused for a single note and a folder run alike: anything upstream's own
 * pickers never offer (isExcludedFromSourcePicker: the wiki folder and the
 * config folder), and WikiLM's concepts and entities folders, which are the
 * wiki too. A folder run also passes over WikiLM's schema, export and topic
 * notes folders; opening one of those notes and ingesting it is the reader's
 * own choice.
 */
export function sourceRefusal(
  path: string,
  folders: SourceFolders,
  wikiFolder: string,
  configDir: string,
  scope: "note" | "folder",
): Pick<Rejection, "reason" | "detail"> | null {
  if (isExcludedFromSourcePicker(path, wikiFolder, configDir)) {
    if (within(path, configDir)) return { reason: "wiki-folder", detail: `it is in Obsidian's config folder (${configDir}/), which holds settings, not notes` };
    return {
      reason: "wiki-folder",
      detail:
        `it is inside the wiki folder (${wikiFolder}/), and the engine reads a note there as one of the wiki's own pages, not as a source, ` +
        `which can strip the quotes from the pages it merges into. Keep sources outside the wiki folder: move the note out of ${wikiFolder}/ and ingest it from there.`,
    };
  }
  for (const [key, name] of scope === "note" ? WIKILM_FOLDERS.slice(0, 2) : WIKILM_FOLDERS) {
    const f = folders[key].trim().replace(/\/+$/, "");
    if (f && within(path, f)) {
      return { reason: "wikilm-folder", detail: `it is in WikiLM's ${name} (${f}/), which WikiLM writes itself. Ingest reads your sources, not WikiLM's own notes.` };
    }
  }
  return null;
}

function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/**
 * A folder run's report: upstream's aggregate (the one runBatchIngest builds)
 * plus the two things its shape has no room for, how many files were read and
 * which failed with what error.
 */
export interface FolderIngestReport extends WikiLmIngestReport {
  filesRead: number;
  failedFiles: Array<{ path: string; error: string }>;
}

/**
 * Ingest one note on upstream's engine, then show and return the report.
 *
 * Never throws: a refusal, a failure and a cancel all come back as a report,
 * so the command, the chat and a test read the outcome the same way.
 */
export async function ingestWithUpstream(plugin: WikiLmPlugin, file: TFile): Promise<WikiLmIngestReport> {
  const r = await ingestOne(plugin, file);
  showReport(r);
  return r;
}

async function ingestOne(plugin: WikiLmPlugin, file: TFile): Promise<WikiLmIngestReport> {
  if (isPdf(file)) return refused(file.path, "unsupported-pdf", PDF_REFUSAL);
  const wikiFolder = upstreamWikiFolder(plugin.settings.wikiConceptsFolder);
  const why = sourceRefusal(file.path, plugin.settings, wikiFolder, plugin.app.vault.configDir, "note");
  if (why) return refused(file.path, why.reason, why.detail);
  const running = busy(plugin);
  if (running) return failed(file.path, running);

  const engine = plugin.upstreamHost().engine();
  new Notice(`WikiLM: ingesting ${file.basename}. Click the status bar to stop.`);
  return withEngineRun(plugin, engine, `ingesting ${file.basename}`, (label) => {
    label(file.basename);
    return runOne(plugin, engine, file, {});
  });
}

/**
 * Ingest every source note under a folder on upstream's engine, then show one
 * report for the run. Returns a report per file it decided about: each note
 * the engine ran, each PDF left to the digest, each note refused for where it
 * is. Notes whose sources/ page is already there are counted, not reported,
 * as upstream's batch does.
 */
export async function ingestFolderWithUpstream(plugin: WikiLmPlugin, folder: TFolder): Promise<WikiLmIngestReport[]> {
  const engine = plugin.upstreamHost().engine();
  const { vault } = plugin.app;
  const readable: readonly string[] = UPSTREAM_SOURCE_EXTENSIONS;
  const files = vault
    .getFiles()
    .filter((f) => readable.includes(f.extension.toLowerCase()))
    .filter((f) => isInFolderScope(f.path, folder.path, folder.isRoot()))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (files.length === 0) {
    new Notice(`WikiLM: no notes to ingest under ${folder.path}.`);
    return [];
  }

  const reports: WikiLmIngestReport[] = [];
  const todo: TFile[] = [];
  let skipped = 0;
  for (const f of files) {
    const why = sourceRefusal(f.path, plugin.settings, engine.settings.wikiFolder, vault.configDir, "folder");
    if (why) reports.push(refused(f.path, why.reason, why.detail));
    else if (isPdf(f)) reports.push(refused(f.path, "unsupported-pdf", PDF_REFUSAL));
    else if (await alreadyIngested(plugin, engine, f)) skipped++;
    else todo.push(f);
  }

  // Checked after the reads above, right before the token is taken, so a run
  // that started meanwhile is not taken over (see src/cancel.ts).
  const running = busy(plugin);
  if (running) {
    new Notice(`WikiLM: ${folder.path} not ingested: ${sentence(running)}`, 8000);
    return [];
  }

  let stopped = false;
  if (todo.length > 0) {
    new Notice(`WikiLM: ingesting ${todo.length} note${todo.length === 1 ? "" : "s"} from ${folder.path}. Click the status bar to stop.`);
    await withEngineRun(plugin, engine, `ingesting ${folder.name}`, async (label) => {
      const batchCtx = engine.createBatchContext();
      for (const [i, f] of todo.entries()) {
        if (plugin.cancel.cancelled) {
          stopped = true;
          break;
        }
        label(`${i + 1}/${todo.length} ${f.basename}`);
        const r = await runOne(plugin, engine, f, { batchCtx });
        reports.push(r);
        if (r.cancelled || engine.wasCancelled) {
          stopped = true;
          break;
        }
      }
    });
  }

  showReport(folderIngestReport(folder.path, reports, { total: files.length, skipped, cancelled: stopped }));
  return reports;
}

/**
 * One report for a folder run, from its per-file reports. Pure. Pages are
 * listed once however many notes wrote to them, as upstream's aggregate does.
 */
export function folderIngestReport(
  label: string,
  reports: WikiLmIngestReport[],
  run: { total: number; skipped: number; cancelled: boolean },
): FolderIngestReport {
  const ran = reports.filter((r) => !r.skipped);
  const failures = ran.filter((r) => !r.success && !r.cancelled);
  const cancelled = run.cancelled || ran.some((r) => r.cancelled);
  const sum = (key: "entitiesCreated" | "conceptsCreated" | "contradictionsFound" | "elapsedSeconds") =>
    reports.reduce((n, r) => n + (r[key] ?? 0), 0);
  const createdPages = [...new Set(reports.flatMap((r) => r.createdPages))];
  const updatedPages = [...new Set(reports.flatMap((r) => r.updatedPages))];
  const pages = new Set([...createdPages, ...updatedPages]);
  return {
    sourceFile: label,
    createdPages,
    updatedPages,
    // The index and log are written by every note; listed once. A file one
    // note wrote in passing and another created is listed as created.
    alsoWritten: [...new Set(reports.flatMap((r) => r.alsoWritten ?? []))].filter((p) => !pages.has(p)),
    // One run, one guard: a page is kept once however many notes asked.
    kept: [...new Map(reports.flatMap((r) => r.kept ?? []).map((k) => [`${k.action}\u0000${k.path}`, k])).values()],
    snapshots: reports.map((r) => r.snapshots).find(Boolean),
    entitiesCreated: sum("entitiesCreated"),
    conceptsCreated: sum("conceptsCreated"),
    failedItems: reports.flatMap((r) => r.failedItems),
    contradictionsFound: sum("contradictionsFound"),
    success: failures.length === 0 && !cancelled,
    cancelled,
    errorMessage: failures.length > 0 ? `${failures.length} file${failures.length === 1 ? "" : "s"} failed` : undefined,
    elapsedSeconds: sum("elapsedSeconds"),
    skippedFiles: run.skipped,
    totalFilesInFolder: run.total,
    rejectedFiles: reports.flatMap((r) => r.rejectedFiles ?? []),
    filesRead: ran.filter((r) => r.success).length,
    failedFiles: failures.map((r) => ({ path: r.sourceFile, error: r.errorMessage ?? "no reason given" })),
  };
}

/**
 * The report as the reader reads it. Pure.
 *
 * The first line says how the run ended. Then every page created and every
 * page updated, by path, whatever the ending: a cancelled or failed run keeps
 * the pages it wrote, so they are listed too. Then each page the guard kept
 * as it was, and where the earlier texts are saved. Then what upstream could
 * not write and why, and the files it would not read.
 */
export function renderIngestReport(r: WikiLmIngestReport | FolderIngestReport): string {
  const folder = "filesRead" in r ? r : null;
  const also = r.alsoWritten ?? [];
  const written = r.createdPages.length + r.updatedPages.length + also.length;
  const rejected = r.rejectedFiles ?? [];
  // A single source the gate turned away: its reason is the headline, not a list of one.
  const lone = !folder && rejected.length === 1 && rejected[0].path === r.sourceFile ? rejected[0] : null;

  const lines: string[] = [];
  if (r.cancelled) lines.push(`WikiLM: ingest of ${r.sourceFile} cancelled.`);
  else if (!r.success) {
    const why = sentence(r.errorMessage ?? "no reason given");
    lines.push(written > 0 ? `WikiLM: ingest of ${r.sourceFile} failed partway: ${why}` : `WikiLM: ${r.sourceFile} not ingested: ${why}`);
  } else if (lone) lines.push(`WikiLM: ${r.sourceFile} not ingested: ${sentence(rejectionText(lone))}`);
  else if (r.skipped) lines.push(`WikiLM: ${r.sourceFile} not ingested.`);
  else lines.push(`WikiLM: ingested ${r.sourceFile}${elapsed(r.elapsedSeconds)}.`);

  if (folder) {
    const already = folder.skippedFiles ? `, ${folder.skippedFiles} already in the wiki` : "";
    lines.push(`${folder.filesRead} of ${plural(folder.totalFilesInFolder ?? 0, "file")} read${already}.`);
  }

  if (r.createdPages.length > 0) lines.push(`Created ${plural(r.createdPages.length, "page")}:`, ...r.createdPages.map((p) => `- ${p}`));
  if (r.updatedPages.length > 0) lines.push(`Updated ${plural(r.updatedPages.length, "page")}:`, ...r.updatedPages.map((p) => `- ${p}`));
  if (also.length > 0) lines.push("Also written:", ...also.map((p) => `- ${p}`));
  if (written === 0) lines.push("Nothing was written.");
  else if (r.cancelled) lines.push("The pages above were written before the stop and are kept.");
  lines.push(...guardLines(r.kept ?? [], r.snapshots));

  if (r.failedItems.length > 0) {
    lines.push(`Failed ${plural(r.failedItems.length, "item")}:`, ...r.failedItems.map((f) => `- ${f.type} “${f.name}”: ${f.reason}`));
  }
  if (folder && folder.failedFiles.length > 0) {
    lines.push(`Failed ${plural(folder.failedFiles.length, "file")}:`, ...folder.failedFiles.map((f) => `- ${f.path}: ${f.error}`));
  }
  if (rejected.length > 0 && !lone) lines.push("Not ingested:", ...rejectionLines(rejected));
  if (r.contradictionsFound > 0) lines.push(`${plural(r.contradictionsFound, "contradiction")} found.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- the run

/**
 * Hold WikiLM's cancel token for the length of an engine run, and connect the
 * two: the engine's progress relabels the status bar, and a cancel from the
 * status bar or "cancel-ingestion" (both call `plugin.cancel.cancel()`) calls
 * the engine's `cancelIngestion()`, which aborts the model call in flight.
 *
 * The engine's callbacks are set here and in runOne on every run, and cleared
 * after it: the
 * host may hand back a new engine when the wiki folder moved, and a callback
 * left on the old one would hold this run's closures.
 */
async function withEngineRun<T>(
  plugin: WikiLmPlugin,
  engine: WikiEngine,
  label: string,
  body: (relabel: (prefix: string) => void) => Promise<T>,
): Promise<T> {
  const owner = plugin.cancel.begin(label);
  // One snapshot folder per run, and nothing the engine created or the guard
  // held carries over from the last one.
  plugin.upstreamHost().guard.begin();
  let prefix = "";
  const relabel = (p: string) => {
    prefix = p;
    plugin.cancel.progress(p, owner);
  };
  engine.setProgressCallback((msg) => plugin.cancel.progress(`${prefix}: ${msg}`, owner));
  // Upstream's own plugin drives its status bar from these; WikiLM's status
  // bar reads the token, which `relabel` and the progress callback keep current.
  engine.setIngestionCallbacks(null, null);
  // Once per run: the token emits again on every relabel after a cancel, and
  // upstream's cancelIngestion shows a Notice each time it is called.
  let asked = false;
  const off = plugin.cancel.onChange(() => {
    if (asked || !plugin.cancel.cancelled || !engine.isIngesting()) return;
    asked = true;
    engine.cancelIngestion();
  });
  try {
    return await body(relabel);
  } finally {
    off();
    engine.setProgressCallback(null);
    engine.setIngestionCallbacks(null, null);
    engine.setDoneCallback(null);
    // Upstream's setter takes no null; the host builds the engine with this no-op.
    engine.setFileWriteCallback(() => {});
    plugin.cancel.end(owner);
  }
}

/**
 * One `ingestSource` call and the report it produced. Upstream reports a
 * failure inside its pipeline through the done callback and then rethrows;
 * one before the pipeline starts (the note could not be read) only throws.
 *
 * Every page write the engine makes goes through its createOrUpdateFile,
 * which calls the file-write callback, so the callback sees the index, the
 * log and re-pointed pages that the report leaves out. The schema note is
 * written by upstream's SchemaManager, which calls no callback, so it is
 * checked for before and after.
 *
 * A page the guard held (src/upstream/guardedVault.ts) is still in the
 * engine's report as updated, because the engine's write returned; it is
 * taken out of the updated and written lists and reported as kept.
 */
async function runOne(plugin: WikiLmPlugin, engine: WikiEngine, file: TFile, opts: IngestOptions): Promise<WikiLmIngestReport> {
  const { vault } = plugin.app;
  const guard = plugin.upstreamHost().guard;
  const refusedBefore = guard.refusals.length;
  // SchemaManager's path for it (SCHEMA_FILENAME, schema/schema-manager.ts), not exported upstream.
  const schemaNote = `${engine.settings.wikiFolder}/schema/config.md`;
  const hadSchema = vault.getAbstractFileByPath(schemaNote) !== null;
  const writes = new Set<string>();
  const reports: IngestReport[] = [];
  engine.setFileWriteCallback((path) => writes.add(path));
  engine.setDoneCallback((r) => reports.push(r));
  let report: IngestReport | undefined;
  try {
    await engine.ingestSource(file, opts);
  } catch (e) {
    console.error(`WikiLM: upstream ingest of ${file.path} failed`, e);
    if (reports.length === 0) report = failed(file.path, e instanceof Error ? e.message : String(e));
  } finally {
    engine.setDoneCallback(null);
    engine.setFileWriteCallback(() => {});
  }
  report ??= reports[reports.length - 1] ?? failed(file.path, "the engine finished without a report");

  if (!hadSchema && vault.getAbstractFileByPath(schemaNote) !== null) writes.add(schemaNote);
  const listed = new Set([...report.createdPages, ...report.updatedPages]);
  const written = (p: string) => !guard.isHeld(p);
  // A path no longer in the vault was trashed by the engine: the summary page
  // of a cancelled run, which upstream removes so the note re-ingests cleanly.
  const alsoWritten = [...writes].filter((p) => !listed.has(p) && written(p) && vault.getAbstractFileByPath(p) !== null);
  return {
    ...report,
    createdPages: report.createdPages.filter(written),
    updatedPages: report.updatedPages.filter(written),
    alsoWritten,
    kept: guard.refusals.slice(refusedBefore),
    snapshots: guard.runFolder ?? undefined,
  };
}

/**
 * Whether the note already has its sources/ page, the check upstream's batch
 * makes before it reads anything (isAlreadyIngested in ingest-commands.ts):
 * the page at the note's slug, owned by this note or recording no owner.
 */
async function alreadyIngested(plugin: WikiLmPlugin, engine: WikiEngine, file: TFile): Promise<boolean> {
  const s = engine.settings;
  const path = `${s.wikiFolder}/sources/${slugify(file.basename, s.slugCase === "preserve")}.md`;
  const page = plugin.app.vault.getAbstractFileByPath(path);
  if (!(page instanceof TFile)) return false;
  try {
    return pageBelongsToNote(await plugin.app.vault.read(page), file.path); // obsidian.d.ts:7412
  } catch {
    return true;
  }
}

/** What stops a run from starting: another run holding the token. Null when nothing does. */
export function busy(plugin: WikiLmPlugin): string | null {
  if (!plugin.cancel.active) return null;
  const running = plugin.cancel.label ? ` (${plugin.cancel.label})` : "";
  return `another run is still going${running}. Start this once it finishes, or stop it from the status bar`;
}

function showReport(r: WikiLmIngestReport): void {
  // Stays until clicked: the report is a list of paths to read, not a toast.
  new Notice(renderIngestReport(r), 0);
}

// ---------------------------------------------------------------- report parts

function isPdf(file: TFile): boolean {
  return file.extension.toLowerCase() === "pdf";
}

function emptyReport(path: string): IngestReport {
  return {
    sourceFile: path,
    createdPages: [],
    updatedPages: [],
    entitiesCreated: 0,
    conceptsCreated: 0,
    failedItems: [],
    contradictionsFound: 0,
    success: true,
    elapsedSeconds: 0,
  };
}

/** A source turned away before the engine saw it, in the shape upstream's own gate reports a skip. */
function refused(path: string, reason: Rejection["reason"], detail?: string): WikiLmIngestReport {
  return { ...emptyReport(path), skipped: true, rejectedFiles: [{ path, reason, detail }] };
}

function failed(path: string, message: string): IngestReport {
  return { ...emptyReport(path), success: false, errorMessage: message };
}

/**
 * What the guard did in a run, as the reader reads it: each page it kept as
 * it was and why, then where the earlier texts are saved. Ingest's report and
 * the lint's (src/upstream/lint.ts) end with these lines.
 */
export function guardLines(kept: GuardRefusal[], snapshots: string | undefined): string[] {
  const lines: string[] = [];
  if (kept.length > 0) lines.push("Not updated, to keep what was there:", ...kept.map(keptLine));
  if (snapshots) lines.push(`The text each page had before this run is saved in ${snapshots}.`);
  return lines;
}

/** A page the guard kept, and why, as the reader reads it. */
function keptLine(k: GuardRefusal): string {
  if (k.action === "remove") return `- ${k.path}: the engine asked to remove it; it was left in place.`;
  if (k.action === "rename") return `- ${k.path}: the engine asked to move it to ${k.to}; it was left where it is.`;
  if (k.detail) return `- ${k.path}: ${k.detail}; it was left as it was.`;
  return `- ${k.path}: the rewrite would have dropped ${describeLoss(k.lost)}. The proposed text is saved at ${k.proposal}.`;
}

/**
 * The files not ingested, one line each; files turned away for the same
 * reason share one line and are listed beneath it, so a folder run over the
 * vault root names every wiki page without repeating why a hundred times.
 */
function rejectionLines(rejected: Rejection[]): string[] {
  const byReason = new Map<string, string[]>();
  for (const x of rejected) {
    const why = rejectionText(x);
    byReason.set(why, [...(byReason.get(why) ?? []), x.path]);
  }
  return [...byReason].flatMap(([why, paths]) =>
    paths.length === 1 ? [`- ${paths[0]}: ${closed(why)}`] : [`- ${plural(paths.length, "file")}: ${closed(why)}`, ...paths.map((p) => `  - ${p}`)],
  );
}

/** Upstream's rejection reasons in words; its own detail where it wrote one for a reader. */
function rejectionText(x: Rejection): string {
  switch (x.reason) {
    case "duplicate":
      return x.detail?.includes("batch") ? "its content repeats another file in this run" : "its content is already in the wiki";
    case "empty":
      return "it has no text to read";
    case "incompatible-type":
      return `the engine does not read .${x.detail ?? "this kind of"} files`;
    default:
      return x.detail ?? x.reason;
  }
}

/** A message as a sentence: one full stop at the end, never two. */
export function sentence(s: string): string {
  return `${s.trim().replace(/[.\s]+$/, "")}.`;
}

/** A sentence, unless it already ends in a stop or a closing quote. */
function closed(s: string): string {
  return /[.!?…”"]$/.test(s.trim()) ? s.trim() : sentence(s);
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function elapsed(seconds: number | undefined): string {
  if (!seconds) return "";
  return seconds < 60 ? ` in ${seconds} s` : ` in ${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
