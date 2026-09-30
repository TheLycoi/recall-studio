/**
 * Lint on upstream's engine: WikiLM's "lint-wiki-upstream" command, run by
 * obsidian-llm-wiki's own lint (runLintWiki,
 * vendor/llm-wiki/src/wiki/lint/controller.ts) and shown in its own report
 * modal. WikiLM's own "lint-wiki" (the chat panel's vault lint,
 * src/vaultLint.ts) is a different command and is not touched.
 *
 * Upstream's controller does the whole flow itself: the scan, the report
 * written into its log, then LintReportModal, whose buttons (each fix, Smart
 * Fix All, Delete empty stubs, Analyze schema) call fix callbacks the
 * controller built. The scan ends when the modal opens; a fix runs later,
 * when the reader presses its button, and each one opens and closes a lint
 * operation on the engine (startLintOperation / endLintOperation). Only the
 * manual trigger runs here: the host builds no AutoMaintainManager and its
 * settings keep `periodicLint` off and `autoSmartFix` false.
 *
 * What WikiLM adds is around each lint operation, the scan's and each fix's,
 * through the engine's lint callbacks: WikiLM's run token (so the status bar
 * shows it and a cancel reaches the engine's cancelLint), a fresh guard run
 * (src/upstream/guardedVault.ts: one snapshot folder, nothing held), and when
 * the operation ends a Notice with the pages the operation created and
 * overwrote and each write the guard refused, the refusals in the lines the
 * ingest report uses. Upstream's own
 * notices and its log count a refused write as done: a merge whose source
 * page was kept reads "merged", an empty stub that was kept reads "deleted".
 * WikiLM's Notice, which comes after them, is the one that says what happened.
 *
 * Every model call in a lint operation runs on WikiLM's lint role: the
 * controller's client is the host's lint client, and the engine's own client
 * switches to it while a lint operation is open (src/upstream/host.ts).
 */
import { Notice } from "obsidian";
import type WikiLmPlugin from "../main";
import { busy, guardLines, plural, sentence } from "./ingest";
import { runLintWiki, type SchemaManager, type SchemaTask, type WikiEngine } from "./vendor";

/**
 * Run upstream's lint scan and open its report modal. Returns when the scan
 * is done and the modal is open; the fixes run from the modal's buttons.
 */
export async function lintWithUpstream(plugin: WikiLmPlugin): Promise<void> {
  const running = busy(plugin);
  if (running) {
    new Notice(`WikiLM: lint not started: ${sentence(running)}`, 8000);
    return;
  }
  const host = plugin.upstreamHost();
  const engine = host.engine();
  const schema = host.schema();
  const runs = lintRuns(plugin, engine);
  runs.next = "scan";
  // Upstream's own lint command takes the operation the same way
  // (main-commands/query-lint-commands.ts, lintWiki).
  const signal = engine.startLintOperation();
  try {
    await runLintWiki(
      {
        app: host.guard.app,
        settings: engine.settings,
        llmClient: host.clientFor("lint"),
        wikiEngine: engine,
        buildSystemPrompt: (task) => engine.buildSystemPrompt(task as SchemaTask),
        onAnalyzeSchema: (context) => void suggestSchema(engine, schema, context),
      },
      signal,
      "manual",
    );
  } finally {
    // A fix pressed before the scan got here has taken the engine's one
    // operation over; ending it now would end the fix's.
    if (!runs.takenOver) engine.endLintOperation();
    runs.takenOver = false;
  }
}

/**
 * The modal's "Analyze schema" button. Upstream's own plugin opens a diff of
 * its schema note with an Apply button that writes it; WikiLM runs only the
 * suggestion, which SchemaManager appends to upstream's suggestions note
 * (schema/schema-manager.ts, suggestSchemaUpdate), and the reader applies
 * what they want by hand. It runs as a lint operation, so on the lint role
 * and in a guard run of its own.
 */
async function suggestSchema(engine: WikiEngine, schema: SchemaManager, context: string | undefined): Promise<void> {
  const signal = engine.startLintOperation();
  try {
    if (signal.aborted) return;
    const suggestion = await schema.suggestSchemaUpdate(context ?? "Wiki lint analysis");
    // SUGGESTIONS_FILENAME in schema/schema-manager.ts, not exported upstream.
    const note = `${engine.settings.wikiFolder}/schema/suggestions.md`;
    if (suggestion) new Notice(`WikiLM: the schema suggestion is added to ${note}. The schema itself is not changed; apply what you want from it by hand.`, 0);
    else new Notice("WikiLM: the schema suggestion failed; nothing was written.", 8000);
  } catch (e) {
    console.error("WikiLM: upstream's schema suggestion failed", e);
    new Notice(`WikiLM: the schema suggestion failed: ${sentence(e instanceof Error ? e.message : String(e))}`, 8000);
  } finally {
    engine.endLintOperation();
  }
}

// ---------------------------------------------------------------- lint operations

interface OpenRun {
  kind: "scan" | "fix";
  owner: number;
  stop: () => void;
}

/**
 * Watches one engine's lint operations for the plugin's lifetime. Upstream
 * keeps a single lint operation per engine, and so does this: an operation
 * that starts while one is open (a fix pressed in the moment between the
 * modal opening and the scan's end) joins it, and the run ends with it.
 */
class LintRuns {
  /** What the next operation to start is; anything WikiLM did not start itself is a fix. */
  next: OpenRun["kind"] = "fix";
  /** Set when an operation started while the scan's was still open. */
  takenOver = false;
  private open: OpenRun | null = null;

  constructor(
    private readonly plugin: WikiLmPlugin,
    private readonly engine: WikiEngine,
  ) {
    engine.setLintCallbacks(
      () => this.started(),
      () => this.ended(),
    );
  }

  private started(): void {
    const kind = this.next;
    this.next = "fix";
    if (this.open) {
      this.takenOver = true;
      return;
    }
    const p = this.plugin;
    const running = busy(p);
    if (running) {
      // A fix pressed while another of WikiLM's runs holds the token. Every
      // fix runner checks the signal before it writes, except Delete empty
      // stubs and the polluted-page step; the guard still stands between
      // those and any page the other run did not create.
      this.engine.cancelLint();
      new Notice(`WikiLM: the lint fix did not run: ${sentence(running)}`, 8000);
      return;
    }
    const owner = p.cancel.begin(kind === "scan" ? "linting the wiki" : "fixing the wiki");
    // One snapshot folder per operation, and nothing held from the last run.
    p.upstreamHost().guard.begin();
    this.engine.setStatusBarUpdateCallback((text) => p.cancel.progress(text || "linting the wiki", owner));
    // Once per operation: upstream's cancelLint shows a Notice each time.
    let asked = false;
    const off = p.cancel.onChange(() => {
      if (asked || !p.cancel.cancelled || !this.engine.isLintRunning()) return;
      asked = true;
      this.engine.cancelLint();
    });
    this.open = { kind, owner, stop: off };
  }

  private ended(): void {
    const run = this.open;
    if (!run) return;
    this.open = null;
    run.stop();
    this.engine.setStatusBarUpdateCallback(null);
    this.plugin.cancel.end(run.owner);
    const report = renderLintGuardReport(this.plugin, run.kind);
    // Stays until clicked, as the ingest report does: a list of paths to read.
    if (report) new Notice(report, 0);
  }
}

const watched = new WeakMap<WikiEngine, LintRuns>();

function lintRuns(plugin: WikiLmPlugin, engine: WikiEngine): LintRuns {
  let runs = watched.get(engine);
  if (!runs) {
    runs = new LintRuns(plugin, engine);
    watched.set(engine, runs);
  }
  return runs;
}

/**
 * What the guard saw in the lint operation that just ended, or null when it
 * created, overwrote and refused nothing. "Created" lists each file the
 * operation made (a stub for a dead link, a page's copy under a clean name);
 * "Updated" each page it overwrote, the text before saved first. Upstream's
 * index and log, which every operation rewrites, are left out of both. The
 * rest is the ingest report's own ending (guardLines in src/upstream/ingest.ts).
 */
function renderLintGuardReport(plugin: WikiLmPlugin, kind: OpenRun["kind"]): string | null {
  const host = plugin.upstreamHost();
  const guard = host.guard;
  const kept = guard.refusals;
  const refused = new Set(kept.filter((k) => k.action === "rewrite").map((k) => k.path));
  const created = guard.createdPaths().filter((p) => !host.rewrittenEachRun(p));
  const updated = guard.savedPaths().filter((p) => !refused.has(p) && !host.rewrittenEachRun(p));
  if (kept.length === 0 && created.length === 0 && updated.length === 0) return null;
  const lines = [`WikiLM: llm-wiki lint ${kind} finished.`];
  if (created.length > 0) lines.push(`Created ${plural(created.length, "page")}:`, ...created.map((p) => `- ${p}`));
  if (updated.length > 0) lines.push(`Updated ${plural(updated.length, "page")}:`, ...updated.map((p) => `- ${p}`));
  lines.push(...guardLines(kept, guard.runFolder ?? undefined));
  return lines.join("\n");
}
