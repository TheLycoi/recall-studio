// Run with: npm test. Bundles src/upstream/ingest.ts, which runs WikiLM's two
// ingest commands on upstream's engine, through the same esbuild options the
// plugin build uses. `obsidian` is replaced by a stub: every value name in
// obsidian.d.ts as a plain function, except `Notice`, which records what the
// reader would be shown, and `TFile`/`TFolder`, which are real classes so an
// `instanceof` test behaves. The engine is a fake that follows the contract of
// upstream's WikiEngine (vendor/llm-wiki/src/wiki/wiki-engine.ts): one done
// report per run, a failure reported before it is rethrown, a cancel that
// reports `cancelled`. No model is called and no vault is touched.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sharedBuildOptions } from "../scripts/esbuild-shared.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function obsidianStub() {
  const dts = readFileSync(path.join(ROOT, "node_modules/obsidian/obsidian.d.ts"), "utf8");
  const names = new Set();
  const decl = /^export (?:declare )?(?:abstract )?(?:class|function|const|let|var|enum) (\w+)/gm;
  for (const m of dts.matchAll(decl)) names.add(m[1]);
  const special = new Set(["Notice", "TFile", "TFolder", "TAbstractFile"]);
  const plain = [...names].filter((n) => !special.has(n)).map((n) => `export function ${n}() {}`);
  return {
    name: "obsidian-stub",
    setup(b) {
      b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: [
          ...plain,
          "export class Notice { constructor(message, duration) { (globalThis.__notices ??= []).push({ message, duration }); } }",
          "export class TAbstractFile {}",
          "export class TFile extends TAbstractFile {}",
          "export class TFolder extends TAbstractFile {}",
        ].join("\n"),
        loader: "js",
      }));
    },
  };
}

let m;
let dir;
before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "wikilm-upstream-ingest-"));
  const out = path.join(dir, "ingest.cjs");
  const shared = sharedBuildOptions();
  await build({
    ...shared,
    stdin: {
      contents: ['export * from "./src/upstream/ingest.ts";', 'export { CancelToken } from "./src/cancel.ts";', 'export { TFile, TFolder } from "obsidian";'].join("\n"),
      resolveDir: ROOT,
      sourcefile: "upstream-ingest-probe.ts",
      loader: "ts",
    },
    outfile: out,
    logLevel: "error",
    external: shared.external.filter((e) => e !== "obsidian"),
    plugins: [obsidianStub(), ...shared.plugins],
  });
  m = createRequire(import.meta.url)(out);
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  globalThis.__notices = [];
});

const notices = () => globalThis.__notices.map((n) => n.message);

/** An upstream-shaped report; the fields a test does not set are an empty successful run. */
function report(over = {}) {
  return {
    sourceFile: "sources/Note.md",
    createdPages: [],
    updatedPages: [],
    entitiesCreated: 0,
    conceptsCreated: 0,
    failedItems: [],
    contradictionsFound: 0,
    success: true,
    elapsedSeconds: 12,
    ...over,
  };
}

function file(p) {
  const f = new m.TFile();
  const name = p.split("/").pop();
  const dot = name.lastIndexOf(".");
  return Object.assign(f, { path: p, name, basename: name.slice(0, dot), extension: name.slice(dot + 1) });
}

function folder(p) {
  return Object.assign(new m.TFolder(), { path: p, name: p.split("/").pop(), isRoot: () => p === "/" || p === "" });
}

/**
 * A fake of upstream's WikiEngine. `script(engine, file, opts)` is the run:
 * it may call `engine.done(report)`, wait, or throw. The fake keeps the
 * controller and the cancel flag the way the real engine does.
 */
function fakeEngine(script) {
  const e = {
    settings: { wikiFolder: "wiki", slugCase: "lower" },
    calls: [],
    cancelCalls: 0,
    wasCancelled: false,
    aborted: false,
    ingesting: false,
    callbacks: { done: null, progress: null, start: null, end: null, write: null },
    /** Paths the fake vault holds because the engine wrote them. */
    written: new Set(),
    setFileWriteCallback(cb) {
      this.callbacks.write = cb;
    },
    /** A write through upstream's createOrUpdateFile, which reports every path it writes. */
    write(path) {
      this.written.add(path);
      this.callbacks.write?.(path);
    },
    setDoneCallback(cb) {
      this.callbacks.done = cb;
    },
    setProgressCallback(cb) {
      this.callbacks.progress = cb;
    },
    setIngestionCallbacks(start, end) {
      this.callbacks.start = start;
      this.callbacks.end = end;
    },
    createBatchContext() {
      return { seen: new Set(), ingested: new Set() };
    },
    isIngesting() {
      return this.ingesting;
    },
    cancelIngestion() {
      this.cancelCalls++;
      this.aborted = true;
    },
    done(r) {
      this.callbacks.done?.(r);
    },
    async ingestSource(f, opts) {
      this.calls.push({ path: f.path, opts });
      this.ingesting = true;
      this.aborted = false;
      this.wasCancelled = false;
      this.callbacks.start?.(f.basename);
      try {
        await script(this, f, opts);
      } finally {
        this.ingesting = false;
        this.callbacks.end?.();
      }
    },
  };
  return e;
}

function fakePlugin(engine, { files = [], pages = {} } = {}) {
  const host = { built: 0, runs: 0 };
  const exists = (p) => p in pages || engine.written.has(p);
  const plugin = {
    host,
    // WikiLM's folders as the reader's vaults set them.
    settings: {
      wikiConceptsFolder: "wiki/concepts",
      wikiEntitiesFolder: "wiki/entities",
      schemaFolder: "wiki/schema",
      exportFolder: "wiki/schema/exports",
      topicFolder: "classes",
    },
    cancel: new m.CancelToken(),
    app: {
      vault: {
        configDir: ".obsidian",
        getFiles: () => files,
        getAbstractFileByPath: (p) => (exists(p) ? file(p) : null),
        read: async (f) => pages[f.path] ?? "",
      },
    },
    upstreamHost: () => ({
      engine: () => {
        host.built++;
        return engine;
      },
      // The fake engine writes nothing through a vault, so its guard never refuses.
      guard: { begin: () => host.runs++, refusals: [], runFolder: null, isHeld: () => false, wasUpdated: () => false },
    }),
  };
  return plugin;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- renderIngestReport ------------------------------------------------------

test("a successful report names every created and every updated page by path", () => {
  const text = m.renderIngestReport(
    report({
      createdPages: ["wiki/concepts/entropy.md", "wiki/entities/boltzmann.md"],
      updatedPages: ["wiki/concepts/heat.md"],
    }),
  );
  assert.match(text, /ingested sources\/Note\.md/);
  assert.match(text, /Created 2 pages:\n- wiki\/concepts\/entropy\.md\n- wiki\/entities\/boltzmann\.md/);
  assert.match(text, /Updated 1 page:\n- wiki\/concepts\/heat\.md/);
  assert.doesNotMatch(text, /cancelled|failed/);
});

test("a report lists the items upstream could not write, each with its reason", () => {
  const text = m.renderIngestReport(
    report({
      createdPages: ["wiki/concepts/a.md"],
      failedItems: [
        { type: "concept", name: "Negentropy", reason: "the model answer was empty" },
        { type: "entity", name: "Maxwell", reason: "rate limited" },
      ],
    }),
  );
  assert.match(text, /Failed 2 items:/);
  assert.match(text, /- concept “Negentropy”: the model answer was empty/);
  assert.match(text, /- entity “Maxwell”: rate limited/);
});

test("a cancelled run says cancelled and still names the pages written before the stop", () => {
  const text = m.renderIngestReport(
    report({ success: false, cancelled: true, errorMessage: "Cancelled by user", createdPages: ["wiki/concepts/a.md"] }),
  );
  assert.match(text, /cancelled/);
  assert.match(text, /- wiki\/concepts\/a\.md/);
  assert.match(text, /kept/);
  const none = m.renderIngestReport(report({ success: false, cancelled: true, errorMessage: "Cancelled by user" }));
  assert.match(none, /cancelled/);
  assert.match(none, /Nothing was written\./);
});

test("a failed run carries the error message, and says partway when pages were already written", () => {
  const before = m.renderIngestReport(report({ success: false, errorMessage: "Source analysis failed for \"Note\"." }));
  assert.match(before, /not ingested: Source analysis failed for "Note"\./);
  assert.match(before, /Nothing was written\./);
  const partway = m.renderIngestReport(report({ success: false, errorMessage: "socket hang up", updatedPages: ["wiki/concepts/b.md"] }));
  assert.match(partway, /failed partway: socket hang up\./);
  assert.match(partway, /Updated 1 page:\n- wiki\/concepts\/b\.md/);
});

test("a source upstream's gate skipped is reported as not ingested, with the reason in words", () => {
  const text = m.renderIngestReport(
    report({ skipped: true, elapsedSeconds: 0, rejectedFiles: [{ path: "sources/Note.md", reason: "duplicate", detail: "content already ingested" }] }),
  );
  assert.match(text, /sources\/Note\.md not ingested: its content is already in the wiki\./);
  assert.match(text, /Nothing was written\./);
});

test("a page written earlier in the run and refused later is listed as updated, and says so", () => {
  const run = ".obsidian/plugins/wikilm/snapshots/2026-09-29T12-00-00-000Z";
  const text = m.renderIngestReport(
    report({
      updatedPages: ["wiki/concepts/receptors.md", "wiki/concepts/other.md"],
      kept: [{ path: "wiki/concepts/receptors.md", action: "rewrite", dropped: 1, lost: [{ kind: "heading", key: "## a", line: "## A" }], proposal: `${run}/wiki/concepts/receptors.proposed.md`, held: 0 }],
      snapshots: run,
    }),
  );
  assert.match(text, /Updated 2 pages:\n- wiki\/concepts\/receptors\.md \(a later rewrite was refused; see the saved proposal\)\n- wiki\/concepts\/other\.md\n/);
  assert.match(text, /Not updated, to keep what was there:\n- wiki\/concepts\/receptors\.md: the rewrite would have dropped 1 line \(1 heading\)\./);
});

test("a report names each page the guard kept, why, and where the texts were saved", () => {
  const run = ".obsidian/plugins/wikilm/snapshots/2026-09-29T12-00-00-000Z";
  const lost = [
    { kind: "heading", key: "## two properties", line: "## Two Properties" },
    { kind: "quote", key: "> > Albumin binds.", line: "> > Albumin binds." },
    { kind: "pdf-link", key: "L.pdf#page=5", line: "> [!PDF] [[L.pdf#page=5|L, p.5]]" },
    { kind: "quote", key: "> [!PDF] [[L.pdf#page=5|L, p.5]]", line: "> [!PDF] [[L.pdf#page=5|L, p.5]]" },
  ];
  const text = m.renderIngestReport(
    report({
      updatedPages: ["wiki/concepts/other.md"],
      kept: [
        { path: "wiki/concepts/receptors.md", action: "rewrite", dropped: 3, lost, proposal: `${run}/wiki/concepts/receptors.proposed.md`, held: 1 },
        { path: "wiki/concepts/albumin.md", action: "rename", dropped: 0, lost: [], proposal: null, to: "wiki/entities/albumin.md", held: 0 },
        { path: "wiki/sources/old.md", action: "remove", dropped: 0, lost: [], proposal: null, held: 0 },
        { path: "wiki/concepts/fm.md", action: "rewrite", dropped: 0, lost: [], proposal: null, detail: "the engine asked for an in-place frontmatter edit, which WikiLM cannot check before it is written", held: 0 },
      ],
      snapshots: run,
    }),
  );
  assert.equal(
    text.slice(text.indexOf("Not updated")),
    [
      "Not updated, to keep what was there:",
      `- wiki/concepts/receptors.md: the rewrite would have dropped 3 lines (1 heading, 2 quote lines). The proposed text is saved at ${run}/wiki/concepts/receptors.proposed.md.`,
      "- wiki/concepts/albumin.md: the engine asked to move it to wiki/entities/albumin.md; it was left where it is.",
      "- wiki/sources/old.md: the engine asked to remove it; it was left in place.",
      "- wiki/concepts/fm.md: the engine asked for an in-place frontmatter edit, which WikiLM cannot check before it is written; it was left as it was.",
      `The text each page had before this run is saved in ${run}.`,
    ].join("\n"),
  );
  const folderRun = m.folderIngestReport("src", [report({ kept: [{ path: "a.md", action: "remove" }], snapshots: run }), report({ kept: [{ path: "a.md", action: "remove" }] })], { total: 2, skipped: 0, cancelled: false });
  assert.equal(folderRun.kept.length, 1, "a page two notes asked about is listed once");
  assert.equal(folderRun.snapshots, run);
});

// ---- ingestWithUpstream --------------------------------------------------------

test("a PDF is refused before the engine is built, with a message naming the highlight digest", async () => {
  const engine = fakeEngine(async () => assert.fail("the engine must not run on a PDF"));
  const plugin = fakePlugin(engine);
  const r = await m.ingestWithUpstream(plugin, file("papers/Lecture.pdf"));
  assert.equal(plugin.host.built, 0);
  assert.equal(engine.calls.length, 0);
  assert.equal(plugin.cancel.active, false);
  assert.equal(r.skipped, true);
  assert.deepEqual(r.createdPages, []);
  assert.match(r.rejectedFiles[0].detail, /highlight digest/);
  assert.match(m.PDF_REFUSAL, /highlight digest/);
  assert.equal(notices().length, 1);
  assert.match(notices()[0], /Lecture\.pdf not ingested: .*highlight digest/);
});

// Upstream reads any note under <wiki>/sources/ as a conversation and
// replaces the quotes on every page it merges into; a wiki page ingested as
// its own source is always rewritten. So nothing inside the wiki is a source.
test("a note inside the wiki folder is refused before the engine is built, with the reason and what to do", async () => {
  for (const p of ["wiki/sources/wispr/Tuesday.md", "wiki/concepts/Receptors.md", "wiki/entities/Albumin.md", "wiki/index.md"]) {
    globalThis.__notices = [];
    const engine = fakeEngine(async () => assert.fail("the engine must not run on a wiki page"));
    const plugin = fakePlugin(engine);
    const r = await m.ingestWithUpstream(plugin, file(p));
    assert.equal(plugin.host.built, 0, p);
    assert.equal(engine.calls.length, 0, p);
    assert.equal(plugin.cancel.active, false);
    assert.equal(r.skipped, true);
    assert.equal(r.rejectedFiles.length, 1);
    assert.equal(notices().length, 1);
    assert.equal(
      notices()[0],
      `WikiLM: ${p} not ingested: it is inside the wiki folder (wiki/), and the engine reads a note there as one of the wiki's own pages, not as a source, which can strip the quotes from the pages it merges into. Keep sources outside the wiki folder: move the note out of wiki/ and ingest it from there.\nNothing was written.`,
    );
  }
  // A folder that merely starts with the wiki folder's name is not inside it.
  const engine = fakeEngine(async (e, f) => e.done(report({ sourceFile: f.path })));
  await m.ingestWithUpstream(fakePlugin(engine), file("wiki-drafts/Note.md"));
  assert.equal(engine.calls.length, 1);
});

test("a folder run refuses every note inside the wiki folder or one of WikiLM's own folders, and counts and names each", async () => {
  const engine = fakeEngine(async (e, f) => e.done(report({ sourceFile: f.path, createdPages: ["wiki/concepts/a.md"] })));
  const files = [
    "notes/Lecture.md",
    "wiki/sources/wispr/Tuesday.md",
    "wiki/concepts/Receptors.md",
    "classes/BIO101.md",
    "exports/Deck.md",
  ].map(file);
  const plugin = fakePlugin(engine, { files });
  plugin.settings.exportFolder = "exports";
  const reports = await m.ingestFolderWithUpstream(plugin, folder("/"));
  assert.deepEqual(engine.calls.map((c) => c.path), ["notes/Lecture.md"]);
  const refused = reports.filter((r) => r.skipped).map((r) => r.sourceFile);
  assert.deepEqual(refused.sort(), ["classes/BIO101.md", "exports/Deck.md", "wiki/concepts/Receptors.md", "wiki/sources/wispr/Tuesday.md"]);
  const shown = notices().at(-1);
  assert.match(shown, /1 of 5 files read\./);
  assert.match(shown, /Not ingested:\n/);
  assert.match(shown, /- 2 files: it is inside the wiki folder \(wiki\/\).*\n {2}- wiki\/concepts\/Receptors\.md\n {2}- wiki\/sources\/wispr\/Tuesday\.md/);
  assert.match(shown, /- classes\/BIO101\.md: it is in WikiLM's topic notes folder \(classes\/\)/);
  assert.match(shown, /- exports\/Deck\.md: it is in WikiLM's text export folder \(exports\/\)/);
});

test("a run sets the engine's callbacks, returns its report, shows it, and leaves nothing behind", async () => {
  const done = report({ sourceFile: "sources/Note.md", createdPages: ["wiki/concepts/a.md"], updatedPages: ["wiki/concepts/b.md"] });
  const labels = [];
  let duringRun;
  const engine = fakeEngine(async (e) => {
    duringRun = e.callbacks.write;
    e.callbacks.progress("Analysing Note…");
    e.done(done);
  });
  const plugin = fakePlugin(engine);
  plugin.cancel.onChange(() => labels.push(plugin.cancel.label));
  const r = await m.ingestWithUpstream(plugin, file("sources/Note.md"));
  assert.deepEqual(r.createdPages, done.createdPages);
  assert.deepEqual(r.updatedPages, done.updatedPages);
  assert.equal(r.success, true);
  assert.equal(engine.calls.length, 1);
  assert.equal(engine.calls[0].path, "sources/Note.md");
  assert.ok(labels.some((l) => /Analysing Note/.test(l)), labels.join(" | "));
  assert.equal(plugin.cancel.active, false);
  const { write, ...rest } = engine.callbacks;
  assert.deepEqual(rest, { done: null, progress: null, start: null, end: null });
  // Upstream's setter takes no null, so the run's callback is replaced, not cleared.
  assert.equal(typeof duringRun, "function");
  assert.equal(typeof write, "function");
  assert.notEqual(write, duringRun, "the run's write callback is let go after the run");
  const shown = notices().at(-1);
  assert.match(shown, /- wiki\/concepts\/a\.md/);
  assert.match(shown, /- wiki\/concepts\/b\.md/);
});

test("a cancel through WikiLM's token reaches the engine's cancelIngestion once", async () => {
  let release;
  const engine = fakeEngine(async (e, f) => {
    await new Promise((r) => (release = r));
    e.wasCancelled = e.aborted;
    e.done(report({ sourceFile: f.path, success: !e.aborted, cancelled: e.aborted || undefined, errorMessage: e.aborted ? "Cancelled by user" : undefined }));
  });
  const plugin = fakePlugin(engine);
  const run = m.ingestWithUpstream(plugin, file("sources/Note.md"));
  await tick();
  assert.equal(plugin.cancel.active, true);
  plugin.cancel.cancel();
  // A relabel after the cancel emits again; the engine is asked only once.
  plugin.cancel.progress("anything", 1);
  release();
  const r = await run;
  assert.equal(engine.cancelCalls, 1);
  assert.equal(r.cancelled, true);
  assert.match(notices().at(-1), /cancelled/);
  assert.equal(plugin.cancel.active, false);
});

test("a failure upstream reports and then rethrows comes back as that report, not as a throw", async () => {
  const engine = fakeEngine(async (e, f) => {
    e.done(report({ sourceFile: f.path, success: false, errorMessage: "rate limited", createdPages: ["wiki/concepts/a.md"] }));
    throw new Error("rate limited");
  });
  const plugin = fakePlugin(engine);
  const r = await m.ingestWithUpstream(plugin, file("sources/Note.md"));
  assert.equal(r.success, false);
  assert.deepEqual(r.createdPages, ["wiki/concepts/a.md"]);
  assert.match(notices().at(-1), /failed partway: rate limited\./);
  assert.equal(plugin.cancel.active, false);
});

test("a throw before upstream has reported becomes a failure report with the error message", async () => {
  const engine = fakeEngine(async () => {
    throw new Error("ENOENT: the note could not be read");
  });
  const plugin = fakePlugin(engine);
  const r = await m.ingestWithUpstream(plugin, file("sources/Note.md"));
  assert.equal(r.success, false);
  assert.match(r.errorMessage, /ENOENT/);
  assert.match(notices().at(-1), /not ingested: ENOENT: the note could not be read\./);
});

test("an ingest does not start while another run holds the token", async () => {
  const engine = fakeEngine(async () => assert.fail("must not run"));
  const plugin = fakePlugin(engine);
  const owner = plugin.cancel.begin("digesting Deck");
  const r = await m.ingestWithUpstream(plugin, file("sources/Note.md"));
  assert.equal(engine.calls.length, 0);
  assert.equal(r.success, false);
  assert.match(r.errorMessage, /another run is still going \(digesting Deck\)/);
  assert.equal(plugin.cancel.active, true, "the other run keeps its token");
  plugin.cancel.end(owner);
});

test("the report also names every other file the engine wrote, but not a page it trashed on cancel", async () => {
  const engine = fakeEngine(async (e, f) => {
    e.write("wiki/sources/note.md");
    e.write("wiki/concepts/a.md");
    e.write("wiki/concepts/b.md");
    e.write("wiki/index.md");
    e.write("wiki/log.md");
    // The schema note is written by upstream's SchemaManager, which does not report writes.
    e.written.add("wiki/schema/config.md");
    e.done(report({ sourceFile: f.path, createdPages: ["wiki/sources/note.md", "wiki/concepts/a.md"], updatedPages: ["wiki/concepts/b.md"] }));
  });
  const plugin = fakePlugin(engine);
  const r = await m.ingestWithUpstream(plugin, file("sources/Note.md"));
  assert.deepEqual(r.alsoWritten, ["wiki/index.md", "wiki/log.md", "wiki/schema/config.md"]);
  assert.match(notices().at(-1), /Also written:\n- wiki\/index\.md\n- wiki\/log\.md\n- wiki\/schema\/config\.md/);

  const cancelling = fakeEngine(async (e, f) => {
    e.write("wiki/sources/other.md");
    e.write("wiki/concepts/c.md");
    // Upstream trashes the summary page of a cancelled run and leaves it out of the report.
    e.written.delete("wiki/sources/other.md");
    e.wasCancelled = true;
    e.done(report({ sourceFile: f.path, success: false, cancelled: true, errorMessage: "Cancelled by user", createdPages: ["wiki/concepts/c.md"] }));
  });
  const r2 = await m.ingestWithUpstream(fakePlugin(cancelling), file("sources/Other.md"));
  assert.deepEqual(r2.alsoWritten, []);
  assert.doesNotMatch(notices().at(-1), /sources\/other\.md/);
});

// ---- ingestFolderWithUpstream -----------------------------------------------------

test("a folder runs every readable note in it through one batch context, leaves PDFs to the digest and skips what is already in", async () => {
  const engine = fakeEngine(async (e, f) => {
    e.done(report({ sourceFile: f.path, createdPages: [`wiki/concepts/${f.basename}.md`], updatedPages: ["wiki/concepts/shared.md"] }));
  });
  const files = [
    "src/b.md",
    "src/a.md",
    "src/c.pdf",
    "src/sub/d.txt",
    "src/img.png",
    "srcother/e.md",
    "other/f.md",
    "wiki/concepts/x.md",
  ].map(file);
  const plugin = fakePlugin(engine, {
    files,
    // src/b.md already has its sources/ page, recorded as built from it.
    pages: { "wiki/sources/b.md": "---\nsource_file: src/b.md\n---\nbody\n" },
  });
  const reports = await m.ingestFolderWithUpstream(plugin, folder("src"));
  assert.deepEqual(
    engine.calls.map((c) => c.path),
    ["src/a.md", "src/sub/d.txt"],
  );
  assert.ok(engine.calls[0].opts.batchCtx, "a folder run passes upstream's batch context");
  assert.equal(engine.calls[0].opts.batchCtx, engine.calls[1].opts.batchCtx);
  const pdf = reports.find((r) => r.sourceFile === "src/c.pdf");
  assert.ok(pdf?.skipped);
  assert.match(pdf.rejectedFiles[0].detail, /highlight digest/);
  assert.equal(plugin.cancel.active, false);
  const shown = notices().at(-1);
  assert.match(shown, /2 of 4 files read, 1 already in the wiki/);
  assert.match(shown, /- wiki\/concepts\/a\.md/);
  assert.match(shown, /- wiki\/concepts\/d\.md/);
  assert.equal(shown.match(/wiki\/concepts\/shared\.md/g).length, 1, "a page updated by two notes is listed once");
  assert.match(shown, /- src\/c\.pdf: .*highlight digest/);
});

test("cancelling a folder run stops the engine and starts no further note", async () => {
  let release;
  const engine = fakeEngine(async (e, f) => {
    if (f.path === "src/a.md") await new Promise((r) => (release = r));
    e.wasCancelled = e.aborted;
    e.done(report({ sourceFile: f.path, success: !e.aborted, cancelled: e.aborted || undefined, createdPages: ["wiki/concepts/a.md"] }));
  });
  const plugin = fakePlugin(engine, { files: ["src/a.md", "src/b.md"].map(file) });
  const run = m.ingestFolderWithUpstream(plugin, folder("src"));
  while (!release) await tick();
  plugin.cancel.cancel();
  release();
  const reports = await run;
  assert.equal(engine.cancelCalls, 1);
  assert.deepEqual(engine.calls.map((c) => c.path), ["src/a.md"]);
  assert.equal(reports.length, 1);
  const shown = notices().at(-1);
  assert.match(shown, /cancelled/);
  assert.match(shown, /0 of 2 files read/);
  assert.match(shown, /- wiki\/concepts\/a\.md/);
  assert.equal(plugin.cancel.active, false);
});

test("one note failing in a folder does not stop the others, and the report names it with its error", async () => {
  const engine = fakeEngine(async (e, f) => {
    if (f.path === "src/a.md") throw new Error("the model timed out");
    e.done(report({ sourceFile: f.path, createdPages: ["wiki/concepts/b.md"] }));
  });
  const plugin = fakePlugin(engine, { files: ["src/a.md", "src/b.md"].map(file) });
  const reports = await m.ingestFolderWithUpstream(plugin, folder("src"));
  assert.deepEqual(engine.calls.map((c) => c.path), ["src/a.md", "src/b.md"]);
  assert.equal(reports.length, 2);
  const shown = notices().at(-1);
  assert.match(shown, /failed partway: 1 file failed\./);
  assert.match(shown, /1 of 2 files read/);
  assert.match(shown, /- src\/a\.md: the model timed out/);
  assert.match(shown, /- wiki\/concepts\/b\.md/);
});

test("a folder run does not start while another run holds the token", async () => {
  const engine = fakeEngine(async () => assert.fail("must not run"));
  const plugin = fakePlugin(engine, { files: [file("src/a.md")] });
  const owner = plugin.cancel.begin("model review of the wiki");
  const reports = await m.ingestFolderWithUpstream(plugin, folder("src"));
  assert.deepEqual(reports, []);
  assert.equal(engine.calls.length, 0);
  assert.match(notices().at(-1), /another run is still going \(model review of the wiki\)/);
  plugin.cancel.end(owner);
});
