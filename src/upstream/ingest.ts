/**
 * Ingest on upstream's engine: WikiLM's "ingest-source" and "ingest-folder"
 * commands, run by obsidian-llm-wiki's WikiEngine instead of the span
 * pipeline in src/ingestSource.ts (kept, and no longer called by them).
 *
 * The engine writes as it goes: the summary page, then one page per entity and
 * concept, then the index and log. There is no preview. What WikiLM adds is
 * around the run, not inside it: the reader starts it, can stop it from the
 * status bar or "cancel-ingestion", and is shown every page it created or
 * updated, by path, when it ends however it ends.
 *
 * PDFs never reach the engine. They are WikiLM's highlight digest's to read,
 * and the host has already switched upstream's PDF conversion off
 * (src/upstream/host.ts, `forcePdfSupport`); refusing here says why instead
 * of leaving the reader with upstream's "provider does not support PDF".
 *
 * The folder run follows upstream's own (runBatchIngest in
 * vendor/llm-wiki/src/main-commands/ingest-commands.ts): the same source
 * filter, the same already-ingested check, one batch context shared by every
 * file so a duplicate within the run is caught, a failed file logged and
 * passed over, and a stop after a cancelled file. Upstream's IngestQueue is
 * left out: it feeds only its multi-file picker, which WikiLM does not have.
 */
import { Notice, TFile, type TFolder } from "obsidian";
import type WikiLmPlugin from "../main";
import {
  isIngestableSource,
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

/**
 * A folder run's report: upstream's aggregate (the one runBatchIngest builds)
 * plus the two things its shape has no room for, how many files were read and
 * which failed with what error.
 */
export interface FolderIngestReport extends IngestReport {
  filesRead: number;
  failedFiles: Array<{ path: string; error: string }>;
}

/**
 * Ingest one note on upstream's engine, then show and return the report.
 *
 * Never throws: a refusal, a failure and a cancel all come back as a report,
 * so the command, the chat and a test read the outcome the same way.
 */
export async function ingestWithUpstream(plugin: WikiLmPlugin, file: TFile): Promise<IngestReport> {
  const r = await ingestOne(plugin, file);
  showReport(r);
  return r;
}

async function ingestOne(plugin: WikiLmPlugin, file: TFile): Promise<IngestReport> {
  if (isPdf(file)) return refused(file.path, PDF_REFUSAL);
  const running = busy(plugin);
  if (running) return failed(file.path, running);

  const engine = plugin.upstreamHost().engine();
  new Notice(`WikiLM: ingesting ${file.basename}. Click the status bar to stop.`);
  return withEngineRun(plugin, engine, `ingesting ${file.basename}`, (label) => {
    label(file.basename);
    return runOne(engine, file, {});
  });
}

/**
 * Ingest every source note under a folder on upstream's engine, then show one
 * report for the run. Returns a report per file it decided about: each note
 * the engine ran, each PDF left to the digest. Notes whose sources/ page is
 * already there are counted, not reported, as upstream's batch does.
 */
export async function ingestFolderWithUpstream(plugin: WikiLmPlugin, folder: TFolder): Promise<IngestReport[]> {
  const engine = plugin.upstreamHost().engine();
  const { vault } = plugin.app;
  const readable: readonly string[] = UPSTREAM_SOURCE_EXTENSIONS;
  const files = vault
    .getFiles()
    .filter((f) => readable.includes(f.extension.toLowerCase()))
    .filter((f) => isIngestableSource(f.path, folder.path, folder.isRoot(), engine.settings.wikiFolder, vault.configDir))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (files.length === 0) {
    new Notice(`WikiLM: no notes to ingest under ${folder.path}.`);
    return [];
  }

  const reports: IngestReport[] = [];
  const todo: TFile[] = [];
  let skipped = 0;
  for (const f of files) {
    if (isPdf(f)) reports.push(refused(f.path, PDF_REFUSAL));
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
        const r = await runOne(engine, f, { batchCtx });
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
  reports: IngestReport[],
  run: { total: number; skipped: number; cancelled: boolean },
): FolderIngestReport {
  const ran = reports.filter((r) => !r.skipped);
  const failures = ran.filter((r) => !r.success && !r.cancelled);
  const cancelled = run.cancelled || ran.some((r) => r.cancelled);
  const sum = (key: "entitiesCreated" | "conceptsCreated" | "contradictionsFound" | "elapsedSeconds") =>
    reports.reduce((n, r) => n + (r[key] ?? 0), 0);
  return {
    sourceFile: label,
    createdPages: [...new Set(reports.flatMap((r) => r.createdPages))],
    updatedPages: [...new Set(reports.flatMap((r) => r.updatedPages))],
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
 * the pages it wrote, so they are listed too. Then what upstream could not
 * write and why, and the files it would not read.
 */
export function renderIngestReport(r: IngestReport | FolderIngestReport): string {
  const folder = "filesRead" in r ? r : null;
  const written = r.createdPages.length + r.updatedPages.length;
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
  if (written === 0) lines.push("Nothing was written.");
  else if (r.cancelled) lines.push("The pages above were written before the stop and are kept.");

  if (r.failedItems.length > 0) {
    lines.push(`Failed ${plural(r.failedItems.length, "item")}:`, ...r.failedItems.map((f) => `- ${f.type} “${f.name}”: ${f.reason}`));
  }
  if (folder && folder.failedFiles.length > 0) {
    lines.push(`Failed ${plural(folder.failedFiles.length, "file")}:`, ...folder.failedFiles.map((f) => `- ${f.path}: ${f.error}`));
  }
  if (rejected.length > 0 && !lone) lines.push("Not ingested:", ...rejected.map((x) => `- ${x.path}: ${rejectionText(x)}`));
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
 * The engine's callbacks are set here on every run and cleared after it: the
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
    plugin.cancel.end(owner);
  }
}

/**
 * One `ingestSource` call and the report it produced. Upstream reports a
 * failure inside its pipeline through the done callback and then rethrows;
 * one before the pipeline starts (the note could not be read) only throws.
 */
async function runOne(engine: WikiEngine, file: TFile, opts: IngestOptions): Promise<IngestReport> {
  const reports: IngestReport[] = [];
  engine.setDoneCallback((r) => reports.push(r));
  try {
    await engine.ingestSource(file, opts);
  } catch (e) {
    console.error(`WikiLM: upstream ingest of ${file.path} failed`, e);
    if (reports.length === 0) return failed(file.path, e instanceof Error ? e.message : String(e));
  } finally {
    engine.setDoneCallback(null);
  }
  return reports[reports.length - 1] ?? failed(file.path, "the engine finished without a report");
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
function busy(plugin: WikiLmPlugin): string | null {
  if (!plugin.cancel.active) return null;
  const running = plugin.cancel.label ? ` (${plugin.cancel.label})` : "";
  return `another run is still going${running}. Start this once it finishes, or stop it from the status bar`;
}

function showReport(r: IngestReport): void {
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
function refused(path: string, detail: string): IngestReport {
  return { ...emptyReport(path), skipped: true, rejectedFiles: [{ path, reason: "unsupported-pdf", detail }] };
}

function failed(path: string, message: string): IngestReport {
  return { ...emptyReport(path), success: false, errorMessage: message };
}

type Rejection = NonNullable<IngestReport["rejectedFiles"]>[number];

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
function sentence(s: string): string {
  return `${s.trim().replace(/[.\s]+$/, "")}.`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function elapsed(seconds: number | undefined): string {
  if (!seconds) return "";
  return seconds < 60 ? ` in ${seconds} s` : ` in ${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
