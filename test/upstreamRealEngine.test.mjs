// Run with: npm test. Runs upstream's REAL WikiEngine, and its real
// page-factory, through WikiLM's real ingest commands (src/upstream/ingest.ts)
// and real engine host (src/upstream/host.ts), against pages shaped the way
// WikiLM's highlight digest writes them (src/topicNote.ts: frontmatter, an H1,
// PDF++ callouts and embeds in the lead, `## Definition`, subject headings of
// the reader's own, `## Related topics`).
//
// What is fake: the vault is an in-memory map behind Obsidian's Vault,
// DataAdapter and FileManager API (obsidian.d.ts), `obsidian` is a stub with
// real TFile/TFolder classes, and the model is a script keyed on upstream's
// task label, installed in place of the host's client. The host's model
// adapter (src/upstream/llmAdapter.ts) is therefore not exercised here; its
// own tests cover it. Upstream's 300 ms pause between steps is cut to zero.
// No model is called, no real vault is touched.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sharedBuildOptions } from "../scripts/esbuild-shared.mjs";
import { memoryVault } from "./memoryVault.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function obsidianStub() {
  const dts = readFileSync(path.join(ROOT, "node_modules/obsidian/obsidian.d.ts"), "utf8");
  const names = new Set();
  const decl = /^export (?:declare )?(?:abstract )?(?:class|function|const|let|var|enum) (\w+)/gm;
  for (const m of dts.matchAll(decl)) names.add(m[1]);
  const special = new Set(["Notice", "TFile", "TFolder", "TAbstractFile", "normalizePath"]);
  const plain = [...names].filter((n) => !special.has(n)).map((n) => `export function ${n}() {}`);
  return {
    name: "obsidian-stub",
    setup(b) {
      b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: [
          ...plain,
          "export class Notice { constructor(message, duration) { (globalThis.__notices ??= []).push({ message, duration }); } setMessage() {} hide() {} }",
          "export class TAbstractFile {}",
          "export class TFile extends TAbstractFile {}",
          "export class TFolder extends TAbstractFile { isRoot() { return this.path === '/' || this.path === ''; } }",
          "export function normalizePath(p) { return String(p).replace(/\\\\/g, '/').replace(/\\/+/g, '/').replace(/^\\/|\\/$/g, '') || '/'; }",
        ].join("\n"),
        loader: "js",
      }));
    },
  };
}

let m;
let dir;
const realWindow = globalThis.window;
const quiet = ["debug", "log", "info", "warn"];
const realConsole = Object.fromEntries(quiet.map((k) => [k, console[k]]));
before(async () => {
  // Upstream waits on window.setTimeout between steps and between write retries.
  globalThis.window = { setTimeout: (fn) => setTimeout(fn, 0), clearTimeout: (h) => clearTimeout(h) };
  // Upstream narrates every step on the console; errors still show.
  for (const k of quiet) console[k] = () => {};
  dir = mkdtempSync(path.join(tmpdir(), "wikilm-real-engine-"));
  const out = path.join(dir, "real-engine.cjs");
  const shared = sharedBuildOptions();
  await build({
    ...shared,
    stdin: {
      contents: [
        'export * from "./src/upstream/ingest.ts";',
        'export { UpstreamHost } from "./src/upstream/host.ts";',
        'export { CancelToken } from "./src/cancel.ts";',
        'export { TFile, TFolder } from "obsidian";',
      ].join("\n"),
      resolveDir: ROOT,
      sourcefile: "upstream-real-engine-probe.ts",
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
  globalThis.window = realWindow;
  Object.assign(console, realConsole);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  globalThis.__notices = [];
});

const notices = () => globalThis.__notices.map((n) => n.message);

// ---- an in-memory vault (test/memoryVault.mjs) ---------------------------------------

const CONFIG = ".obsidian";
const PLUGIN_DIR = `${CONFIG}/plugins/wikilm`;
const memoryApp = (initial) => memoryVault(initial, m);

// ---- WikiLM around the engine ------------------------------------------------------

function wikilmSettings() {
  return {
    provider: "claudecli",
    model: "claude-api-model",
    geminiModel: "gemini-default",
    codexModel: "codex-default",
    claudeCliModel: "sonnet",
    rolesEnabled: false,
    roles: {
      digest: { provider: "default", model: "" },
      query: { provider: "default", model: "" },
      lint: { provider: "default", model: "" },
    },
    effort: "high",
    topicFolder: "classes",
    schemaFolder: "wiki/schema",
    exportFolder: "wiki/schema/exports",
    transcriptFolder: "wiki/sources/wispr",
    wikiConceptsFolder: "wiki/concepts",
    wikiEntitiesFolder: "wiki/entities",
  };
}

/**
 * The reader's plugin: the real host, with the model replaced by `script`,
 * which is handed upstream's request and answers by its task label.
 */
function setup(initial, script) {
  const { app, files } = memoryApp(initial);
  const calls = [];
  const plugin = {
    app,
    manifest: { id: "wikilm", dir: PLUGIN_DIR },
    settings: wikilmSettings(),
    cancel: new m.CancelToken(),
    llm: {
      backendFor: () => ({
        async completeText() {
          throw new Error("the adapter is replaced in these tests");
        },
      }),
    },
  };
  const host = new m.UpstreamHost(plugin);
  plugin.upstreamHost = () => host;
  host.ingestClient = {
    async createMessage(params) {
      calls.push(params.task);
      const text = script(params, calls.filter((t) => t === params.task).length);
      params.onFinish?.({ finishReason: "stop" });
      return text;
    },
  };
  return { plugin, files, calls };
}

function tfile(p) {
  const name = p.split("/").pop();
  const dot = name.lastIndexOf(".");
  return Object.assign(new m.TFile(), { path: p, name, basename: name.slice(0, dot), extension: name.slice(dot + 1) });
}

function tfolder(p) {
  return Object.assign(new m.TFolder(), { path: p, name: p.split("/").pop() });
}

// ---- the reader's pages ----------------------------------------------------------

const PDF = "BIO 101 Lecture 3";
const QUOTE_LEAD = `> [!PDF|yellow] [[${PDF}.pdf#page=4&selection=2,0,33,19&color=yellow|${PDF}, p.4]]\n> > Receptors bind a ligand and transduce a signal.`;
const EMBED_LEAD = `![[${PDF}.pdf#page=7&rect=10,20,300,400|${PDF}, p.7]]`;
const QUOTE_SECTION = `> [!PDF|yellow] [[${PDF}.pdf#page=5&selection=1,0,12,40&color=yellow|${PDF}, p.5]]\n> > Albumin binds drugs but transduces nothing.`;

/** A concept page as the article digest writes one (topicNote.ts renderArticleBody). */
const DIGEST_PAGE = `---
class: BIO101
tags:
  - concept
sources:
  - "[[${PDF}.pdf]]"
---
# Receptors

${QUOTE_LEAD}

${EMBED_LEAD}

## Definition
Receptors are proteins that bind a ligand and pass a signal on.

## Two Properties
Binding and transduction are separate properties.

${QUOTE_SECTION}

## Related topics
- [[Pharmacology]]
`;

/** A page whose only headings are upstream's own, so a rewrite loses nothing to the section filter. */
const CANONICAL_PAGE = `---
class: BIO101
---
# Receptors

## Definition
Receptors are proteins that bind a ligand and pass a signal on.

${QUOTE_SECTION}
`;

const NOTE_PATH = "notes/Pharmacology Lecture.md";
const NOTE = `# Pharmacology lecture

Receptors bind ligands. Receptors transduce the binding into a response inside the cell.
A drug that binds receptors without transducing is an antagonist of those receptors.
`;

function extraction(concepts) {
  return JSON.stringify({
    source_title: "Pharmacology Lecture",
    summary: "Receptors and how drugs act on them.",
    entities: [],
    concepts,
    related_pages: [],
  });
}

const RECEPTORS = {
  name: "Receptors",
  type: "term",
  summary: "Proteins that bind a ligand and transduce the binding into a response.",
  mentions_in_source: ["Receptors transduce the binding into a response inside the cell."],
  related_concepts: [],
  related_entities: [],
};

/** Upstream's answers for the steps every ingest takes; `over` answers the rest. */
function script(concepts, over = {}) {
  return (params, nth) => {
    if (over[params.task]) return over[params.task](params, nth);
    switch (params.task) {
      case "extract":
        return nth === 1 ? extraction(concepts) : extraction([]);
      case "source-page":
        return "Receptors and drug action.\n\n## Summary\n\nReceptors bind and transduce.";
      case "page-generate":
        return `# ${params.messages[0].content.match(/Receptors|Albumin/)?.[0] ?? "Page"}\n\n## Definition\n\nProteins that bind a ligand and transduce the binding.`;
      default:
        return '{"entities":[],"concepts":[]}';
    }
  };
}

/** Files saved under the plugin's own folder, by the vault path they keep. */
function saved(files, suffix) {
  return [...files.keys()].filter((p) => p.startsWith(`${PLUGIN_DIR}/`) && p.endsWith(suffix));
}

// ---- C2: a rewrite that would lose the reader's text is refused --------------------

test("a body merge that drops a section with the reader's own heading is refused, and the page keeps its text", async () => {
  const merged = `# Receptors

${QUOTE_LEAD}

${EMBED_LEAD}

## Definition
Receptors are proteins that bind a ligand and pass a signal on. Antagonists bind without transducing.

## Two Properties
Binding and transduction are separate properties.

${QUOTE_SECTION}
`;
  const { plugin, files, calls } = setup(
    { [NOTE_PATH]: NOTE, "wiki/concepts/receptors.md": DIGEST_PAGE },
    script([RECEPTORS], {
      "merge-triage": () => JSON.stringify({ strategy: "merge", reason: "the page lacks the standard sections" }),
      "merge-body": () => merged,
    }),
  );
  const r = await m.ingestWithUpstream(plugin, tfile(NOTE_PATH));
  assert.ok(calls.includes("merge-body"), `the engine took the rewrite path: ${calls.join(", ")}`);
  assert.equal(files.get("wiki/concepts/receptors.md"), DIGEST_PAGE, "the page keeps its old text");
  const [snapshot] = saved(files, "/wiki/concepts/receptors.md");
  assert.equal(files.get(snapshot), DIGEST_PAGE, "the old text is saved under the plugin's folder");
  const [proposal] = saved(files, "/wiki/concepts/receptors.proposed.md");
  assert.ok(proposal, "the proposed text is saved beside the snapshot");
  assert.doesNotMatch(files.get(proposal), /## Two Properties/, "the proposal is what upstream would have written");
  assert.ok(!r.updatedPages.includes("wiki/concepts/receptors.md"), "the page is not reported as updated");
  const shown = notices().at(-1);
  assert.match(shown, /Not updated, to keep what was there:\n- wiki\/concepts\/receptors\.md: /);
  assert.ok(shown.includes(proposal), shown);
  assert.doesNotMatch(shown, /Updated \d+ pages?:\n(- .*\n)*- wiki\/concepts\/receptors\.md/);
});

test("a rewrite that drops a quote callout linking into a PDF is refused", async () => {
  const { plugin, files, calls } = setup(
    { [NOTE_PATH]: NOTE, "wiki/concepts/receptors.md": CANONICAL_PAGE },
    script([RECEPTORS], {
      "merge-triage": () => JSON.stringify({ strategy: "merge", reason: "rewrite for clarity" }),
      "merge-body": () => "# Receptors\n\n## Definition\nReceptors are proteins that bind a ligand and pass a signal on; antagonists bind without transducing.\n",
    }),
  );
  await m.ingestWithUpstream(plugin, tfile(NOTE_PATH));
  assert.ok(calls.includes("merge-body"), calls.join(", "));
  assert.equal(files.get("wiki/concepts/receptors.md"), CANONICAL_PAGE);
  assert.equal(saved(files, "/wiki/concepts/receptors.proposed.md").length, 1);
  assert.match(notices().at(-1), /Not updated, to keep what was there:\n- wiki\/concepts\/receptors\.md: the rewrite would have dropped 2 lines/);
});

// ---- what the guard lets through ---------------------------------------------------

/** One new fact for the Definition section, and nothing else. */
const complementaryAppend = () =>
  script([RECEPTORS], {
    "merge-triage": () =>
      JSON.stringify({
        strategy: "complementary",
        reason: "one new fact",
        items: [{ kind: "complementary", content: "An antagonist binds receptors without transducing.", target_section: "Definition", reason: "new" }],
      }),
    complementary: () => "An antagonist binds receptors without transducing.",
  });

test("a complementary append that only adds is written, and the old text is saved first", async () => {
  // WikiLM's digest writes no `sources:` key (topicNote.ts); the next test is a page that has one.
  const digest = DIGEST_PAGE.replace(`sources:\n  - "[[${PDF}.pdf]]"\n`, "");
  const { plugin, files, calls } = setup({ [NOTE_PATH]: NOTE, "wiki/concepts/receptors.md": digest }, complementaryAppend());
  const r = await m.ingestWithUpstream(plugin, tfile(NOTE_PATH));
  assert.ok(calls.includes("complementary"), calls.join(", "));
  const page = files.get("wiki/concepts/receptors.md");
  assert.match(page, /An antagonist binds receptors without transducing\./, "the append was written");
  for (const kept of [QUOTE_LEAD, EMBED_LEAD, QUOTE_SECTION, "## Two Properties", "## Related topics", "class: BIO101"]) {
    assert.ok(page.includes(kept), `the page still holds ${kept}`);
  }
  const [snapshot] = saved(files, "/wiki/concepts/receptors.md");
  assert.equal(files.get(snapshot), digest, "the old text was saved before the write");
  assert.ok(r.updatedPages.includes("wiki/concepts/receptors.md"));
  assert.doesNotMatch(notices().at(-1), /Not updated, to keep what was there/);
});

test("an append to a page whose `sources:` names a PDF is refused: upstream rewrites the entry to a sources/ slug no file has", async () => {
  const { plugin, files } = setup({ [NOTE_PATH]: NOTE, "wiki/concepts/receptors.md": DIGEST_PAGE }, complementaryAppend());
  const r = await m.ingestWithUpstream(plugin, tfile(NOTE_PATH));
  assert.equal(files.get("wiki/concepts/receptors.md"), DIGEST_PAGE, "the page keeps its PDF source");
  const [proposal] = saved(files, "/wiki/concepts/receptors.proposed.md");
  assert.match(files.get(proposal), /sources:\n\s+- "\[\[sources\/bio-101-lecture-3-pdf\]\]"/, "what upstream would have written");
  assert.ok(!r.updatedPages.includes("wiki/concepts/receptors.md"));
  assert.match(notices().at(-1), /- wiki\/concepts\/receptors\.md: the rewrite would have dropped 1 line \(1 PDF link\)\./);
});

test("an ingest run writes only inside the wiki folder: an engine write to the reader's class note is refused and reported", async () => {
  const classNote = "# BIO 101\n\nWeek 3 covers each [[receptors]].\n";
  let plugin;
  const ctx = setup(
    { [NOTE_PATH]: NOTE, "classes/BIO101.md": classNote },
    script([RECEPTORS], {
      "source-page": async () => {
        await plugin.upstreamHost().engine().createOrUpdateFile("classes/BIO101.md", "# BIO 101\n\nRewritten.\n");
        return "Receptors and drug action.\n\n## Summary\n\nReceptors bind and transduce.";
      },
    }),
  );
  plugin = ctx.plugin;
  const r = await m.ingestWithUpstream(plugin, tfile(NOTE_PATH));
  assert.equal(r.success, true, r.errorMessage);
  assert.equal(ctx.files.get("classes/BIO101.md"), classNote);
  assert.ok(ctx.files.has("wiki/concepts/receptors.md"), "the pages inside the wiki are written");
  assert.match(notices().at(-1), /- classes\/BIO101\.md: outside the wiki folder; it was left as it was\./);
});

test("a brand-new page is created normally, with nothing saved for it", async () => {
  const { plugin, files } = setup({ [NOTE_PATH]: NOTE }, script([RECEPTORS]));
  const r = await m.ingestWithUpstream(plugin, tfile(NOTE_PATH));
  assert.equal(r.success, true, r.errorMessage);
  assert.ok(r.createdPages.includes("wiki/concepts/receptors.md"), r.createdPages.join(", "));
  assert.match(files.get("wiki/concepts/receptors.md"), /# Receptors/);
  assert.deepEqual(saved(files, "/wiki/concepts/receptors.md"), []);
  assert.match(notices().at(-1), /Created \d+ pages?:[\s\S]*- wiki\/concepts\/receptors\.md/);
});

// ---- C1: a note inside the wiki folder is refused before the engine -----------------

test("a note under the wiki folder is refused before the engine is called, with the reason and what to do", async () => {
  const transcript = "wiki/sources/wispr/Tuesday.md";
  const { plugin, files, calls } = setup(
    { [transcript]: NOTE, "wiki/concepts/receptors.md": DIGEST_PAGE },
    script([RECEPTORS], { "merge-triage": () => JSON.stringify({ strategy: "skip", reason: "nothing new" }) }),
  );
  const r = await m.ingestWithUpstream(plugin, tfile(transcript));
  assert.deepEqual(calls, [], "no model call was made");
  assert.equal(r.skipped, true);
  assert.equal(files.get("wiki/concepts/receptors.md"), DIGEST_PAGE);
  assert.match(notices().at(-1), /wiki\/sources\/wispr\/Tuesday\.md not ingested: .*inside the wiki folder.*Keep sources outside the wiki folder/s);
});

test("a folder run refuses, counts and names every note inside the wiki folder and WikiLM's own folders", async () => {
  const { plugin, calls } = setup(
    {
      [NOTE_PATH]: NOTE,
      "wiki/sources/wispr/Tuesday.md": NOTE,
      "wiki/concepts/receptors.md": DIGEST_PAGE,
      "classes/BIO101.md": "# BIO 101\n",
    },
    script([]),
  );
  await m.ingestFolderWithUpstream(plugin, Object.assign(tfolder("/"), { isRoot: () => true }));
  assert.ok(!calls.includes("merge-triage"));
  const shown = notices().at(-1);
  assert.match(shown, /1 of 4 files read/);
  assert.match(shown, /- 2 files: it is inside the wiki folder .*\n {2}- wiki\/concepts\/receptors\.md\n {2}- wiki\/sources\/wispr\/Tuesday\.md/);
  assert.match(shown, /- classes\/BIO101\.md: it is in WikiLM's topic notes folder/);
});
