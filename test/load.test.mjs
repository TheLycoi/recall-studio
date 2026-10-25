// Run with: npm test
//
// Executes the built plugin the way Obsidian does, with a stubbed `obsidian`
// module, and asserts that `onload()` resolves.
//
// Why this file exists: every other bundle test in this repo reads main.js as
// text. Grepping catches a stale build; it cannot catch a build that throws when
// Obsidian loads it, so a plugin could fail to load with a fully green suite.
// One was reported that way, and no test here could have said either way.
//
// Set RECALL_BUNDLE to a path to run an existing artifact instead of building
// from src (e.g. the copy installed in a vault).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Module from "node:module";
import { sharedBuildOptions } from "../scripts/esbuild-shared.mjs";

// --------------------------------------------------------------- the stub

/**
 * An element as Obsidian hands them over: an HTMLElement carrying Obsidian's
 * prototype extensions. `addRibbonIcon` and `addStatusBarItem` both return one,
 * and the plugin calls `toggleClass` on it, so a bare object throws here where
 * real Obsidian does not. A stub that is wrong in this direction invents
 * failures; one that is wrong the other way hides them.
 */
function el() {
  return {
    addClass: () => {},
    removeClass: () => {},
    toggleClass: () => {},
    setAttribute: () => {},
    getAttribute: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    setText: () => {},
    empty: () => {},
    remove: () => {},
    appendChild: () => {},
    createEl: () => el(),
    createDiv: () => el(),
    createSpan: () => el(),
    querySelector: () => null,
    querySelectorAll: () => [],
    contains: () => false,
    closest: () => null,
    style: {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    children: [],
    dataset: {},
  };
}

/** An app whose vault adapter is backed by a Map of path -> contents. */
function makeApp(files) {
  const adapter = {
    async exists(p) {
      return files.has(p);
    },
    async read(p) {
      if (!files.has(p)) throw new Error(`ENOENT: no such file, open '${p}'`);
      return files.get(p);
    },
    async write(p, d) {
      files.set(p, d);
    },
    async mkdir(p) {
      files.set(`${p}/`, "");
    },
    async rename(a, b) {
      const v = files.get(a);
      files.delete(a);
      files.set(b, v);
    },
    async remove(p) {
      files.delete(p);
    },
  };
  return {
    vault: { adapter, configDir: ".obsidian", getAbstractFileByPath: () => null, getMarkdownFiles: () => [], on: () => ({}) },
    workspace: {
      on: () => ({}),
      onLayoutReady: (cb) => cb(),
      iterateAllLeaves: () => {},
      getActiveViewOfType: () => null,
      getLeavesOfType: () => [],
      getRightLeaf: () => null,
      getLeaf: () => el(),
      trigger: () => {},
    },
    metadataCache: { on: () => ({}), getFileCache: () => null },
  };
}

/**
 * `Plugin.loadData()` as Obsidian 1.14.4 actually behaves, read off the running
 * app rather than guessed. It delegates to `vault.readPluginData(dir)` and does
 * NOT throw:
 *
 *   malformed data.json -> undefined
 *   missing   data.json -> null
 *   valid     data.json -> the parsed object
 *
 * Getting this wrong once invented a load failure that does not exist: a stub
 * that threw on a bad read made `loadSettings` look unguarded, and a fix was
 * nearly written for a bug the real app cannot have. The three cases are
 * asserted below, so the stub cannot drift back.
 */
const openedModals = [];
function obsidianStub() {
  class Plugin {
    constructor(app, manifest) {
      this.app = app;
      this.manifest = manifest;
      this.savedDuringLoad = 0;
    }
    async loadData() {
      let raw = null;
      try {
        raw = await this.app.vault.adapter.read(`${this.manifest.dir}/data.json`);
      } catch {
        return null;
      }
      try {
        return JSON.parse(raw);
      } catch {
        return undefined;
      }
    }
    async saveData(d) {
      this.savedDuringLoad++;
      await this.app.vault.adapter.write(`${this.manifest.dir}/data.json`, JSON.stringify(d, null, 2));
    }
    registerView() {}
    addSettingTab() {}
    addRibbonIcon() {
      return el();
    }
    addStatusBarItem() {
      return el();
    }
    addCommand(command) { (this.commands ??= []).push(command); }
    registerEvent() {}
    registerDomEvent() {}
    registerInterval() {}
    registerMarkdownPostProcessor(fn) { this.sourceProcessor = fn; }
    registerEditorExtension(extension) { this.sourceExtension = extension; }
    addChild() {}
  }
  class PluginSettingTab {
    constructor(app, plugin) {
      this.app = app;
      this.plugin = plugin;
      this.containerEl = el();
    }
    display() {}
  }
  class ItemView {
    constructor(leaf) {
      this.leaf = leaf;
      this.containerEl = el();
    }
  }
  class FileView extends ItemView {}
  class Modal {
    constructor(app) { this.app = app; this.contentEl = el(); this.titleEl = el(); }
    open() { openedModals.push(this); this.onOpen(); }
    close() { this.onClose?.(); }
  }
  class MarkdownRenderChild {}
  class SuggestModal extends Modal {}
  class TAbstractFile {}
  class TFile extends TAbstractFile {}
  class TFolder extends TAbstractFile {}
  class MarkdownView extends ItemView {}
  class WorkspaceLeaf {}
  class Editor {}
  class Menu {}
  class ButtonComponent {}
  class Notice {}
  class Setting {}
  class App {}
  return {
    Plugin,
    PluginSettingTab,
    ItemView,
    FileView,
    Modal,
    MarkdownRenderChild,
    editorInfoField: {},
    SuggestModal,
    TAbstractFile,
    TFile,
    TFolder,
    MarkdownView,
    WorkspaceLeaf,
    Editor,
    Menu,
    ButtonComponent,
    Notice,
    Setting,
    App,
    addIcon: () => {},
    setIcon: () => {},
    normalizePath: (p) => p,
    requestUrl: async () => ({ status: 200, json: {} }),
    parseFrontMatterAliases: () => [],
    loadPdfJs: async () => ({}),
    MarkdownRenderer: { render: async () => {} },
    debounce: (fn) => fn,
    Platform: { isDesktopApp: true, isMacOS: true },
  };
}

// ------------------------------------------------------------- the harness

const PLUGIN_DIR = ".obsidian/plugins/recall";
const VALID = JSON.stringify({ provider: "opencode", opencodeModel: "deepseek/deepseek-flash", effort: "high" }, null, 2);

let bundlePath;
let bundleStub;
before(async () => {
  if (process.env.RECALL_BUNDLE) {
    bundlePath = process.env.RECALL_BUNDLE;
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "recall-load-"));
  bundlePath = path.join(dir, "main.js");
  await build({ ...sharedBuildOptions(), entryPoints: ["src/main.ts"], outfile: bundlePath, logLevel: "silent" });
});

/**
 * Evaluate the bundle against a stubbed `obsidian`, and return the module plus
 * the file map the app should be built over.
 *
 * `data` is the contents of data.json; pass null for a vault where the file is
 * absent. The map is returned rather than rebuilt by each test, because
 * discarding it was a real bug in an earlier draft of this file: the tests then
 * ran against an empty vault and quietly asserted the wrong defaults.
 */
function load(data) {
  const files = new Map();
  if (data !== null) files.set(`${PLUGIN_DIR}/data.json`, data);
  files.set("Recall/inbox.json", JSON.stringify({ version: 1, highlights: [] }));

  const stub = bundleStub ??= obsidianStub();
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "obsidian") return stub;
    if (request === "@codemirror/view") return { WidgetType: class {}, Decoration: { none: [], widget: () => ({ range: () => ({ from: 0 }) }), set: xs => xs }, ViewPlugin: { fromClass: c => c } };
    return origLoad.call(this, request, ...rest);
  };

  const doc = el();
  // `reflect()` writes to document.body, and real Obsidian's is an HTMLElement
  // carrying `toggleClass`. Leaving it undefined threw where the app does not,
  // which is the third time in this work that a stub invented a failure.
  doc.body = el();
  for (const name of ["window", "document"]) {
    const value = name === "document" ? doc : global;
    try {
      global[name] = value;
    } catch {
      Object.defineProperty(global, name, { value, configurable: true, writable: true });
    }
  }

  let mod = null;
  let evalError = null;
  try {
    mod = Module.createRequire(import.meta.url)(bundlePath);
  } catch (e) {
    evalError = e;
  } finally {
    Module._load = origLoad;
  }
  return { mod, evalError, files, stub };
}

/** A plugin instance over the given file map. */
function instance(mod, files) {
  const Cls = mod.default || mod;
  return new Cls(makeApp(files), { id: "recall", name: "Recall", dir: PLUGIN_DIR, version: "0.3.0" });
}

// G1: exercise the actual SchemaFile and the callback constructed by main.onload.
async function rulesFixture() {
  const { mod, files, stub } = load(JSON.stringify({ provider: 'codex', schemaFolder: 'Recall', notifyWhenReady: false }));
  const plugin = instance(mod, files);
  plugin.app.workspace.onLayoutReady = () => {};
  await plugin.onload();
  await plugin.schema.refresh();
  const file = Object.assign(new stub.TFile(), { path: 'Recall/recall-rules.md', stat: { mtime: 1 } });
  let unavailable = false;
  plugin.app.vault.getAbstractFileByPath = p => p === file.path ? file : null;
  plugin.app.vault.cachedRead = async () => {
    if (unavailable) throw Error('Synthetic inaccessible rules');
    return '## Card Rules\n'; // Intentionally empty is valid, unlike an unavailable read.
  };
  const failRules = () => { file.stat.mtime++; unavailable = true; };
  const source = 'During Zeta calibration, disconnect power before attaching the reference cable to prevent a false reading.';
  const h = { id: 'h-rules', sourcePath: 'synthetic.md', sourceTitle: 'Zeta calibration', title: '', text: source,
    before: '', after: '', instruction: '', status: 'queued', cards: [] };
  plugin.store.add(h);
  const draft = { kind: 'qa', front: 'During Zeta calibration, why disconnect power before attaching the reference cable?', back: 'to prevent a false reading', text: '' };
  const preparation = { facts: [{ id: 'F1', statement: source, quote: source }], plan: [{ id: 'P1', factIds: ['F1'], entity: 'Zeta calibration', aspect: 'rationale', value: draft.back, reason: 'Causal relationship' }], omissions: [], exclusions: [], conflicts: [] };
  const calls = [];
  plugin.llm.codex = { async complete(req) {
    assert.equal(req.authorized(), true);
    calls.push(req);
    const u = JSON.parse(req.user);
    if (req.label === 'preparation') return req.schema.parse(preparation);
    if (req.label === 'grounded cards') return req.schema.parse({ cards: [{ ...draft, planId: 'P1', factIds: ['F1'] }] });
    if (req.label === 'rewrite cards') return req.schema.parse({ cards: [draft] });
    if (req.label === 'rewrite audit') return req.schema.parse({ preservesFacts: true, reason: 'Synthetic', verdicts: [{ index: 0, verdict: 'keep', reason: 'Synthetic' }] });
    return req.schema.parse({ verdicts: u.cards.map((c, index) => ({ index, cardId: c.id, status: 'verified', reason: 'Synthetic' })) });
  } };
  return { plugin, h, draft, calls, failRules, files };
}

for (const stage of ['initial', 'preparation', 'grounded cards', 'audit', 'publication checkpoint']) test(`G1: main rules callback stops generation on ${stage} read failure`, async () => {
  const f = await rulesFixture();
  const complete = f.plugin.llm.codex.complete;
  f.plugin.llm.codex.complete = async req => { const result = await complete(req); if (req.label === stage) f.failRules(); return result; };
  if (stage === 'initial') f.failRules();
  const flush = f.plugin.store.flush.bind(f.plugin.store);
  f.plugin.store.flush = async () => { await flush(); if (stage === 'publication checkpoint' && f.h.generation?.committed) f.failRules(); };
  const oldError = console.error; console.error = () => {};
  try { await f.plugin.generator.run(f.h); } finally { console.error = oldError; f.plugin.store.close(); }
  assert.equal(f.h.cards.length, 0, 'unavailable rules cannot publish even after the final checkpoint');
  assert.equal(f.h.status, 'error');
  assert.match(f.h.error, /rules|schema/i);
  assert.deepEqual(f.calls.map(r => r.label), stage === 'initial' ? [] : ['preparation', 'grounded cards', 'audit'].slice(0, stage === 'preparation' ? 1 : stage === 'grounded cards' ? 2 : 3));
  if (stage === 'audit' || stage === 'publication checkpoint') assert.equal(f.h.generation.drafts[0].front, f.draft.front);
  if (stage === 'publication checkpoint') {
    const stored = JSON.parse(f.files.get('Recall/inbox.json')).highlights.find(h => h.id === f.h.id);
    assert.equal(stored.cards.length, 0, 'rollback removes newly appended cards from the durable snapshot too');
    assert.equal(stored.generation.drafts[0].front, f.draft.front);
  }
});

for (const stage of ['initial', 'rewrite cards', 'rewrite audit']) test(`G1: main rules callback refuses explicit rewrite on ${stage} failure and preserves original`, async () => {
  const f = await rulesFixture();
  const original = { id: 'c-rules', highlightId: f.h.id, ...f.draft, front: 'Zeta calibration: why disconnect power?', status: 'pending', edited: true, extra: 'Private annotation', ankiNoteId: 42 };
  f.h.status = 'ready'; f.h.cards.push(original);
  const saved = structuredClone(original);
  const complete = f.plugin.llm.codex.complete;
  f.plugin.llm.codex.complete = async req => { const result = await complete(req); if (req.label === stage) f.failRules(); return result; };
  if (stage === 'initial') f.failRules();
  const oldError = console.error; console.error = () => {};
  try { await assert.rejects(() => f.plugin.llm.rewriteCards(f.h, original, 'Improve cue', () => true), /rules|schema/i); }
  finally { console.error = oldError; f.plugin.store.close(); }
  assert.deepEqual(original, saved);
  assert.equal(f.calls.length, stage === 'initial' ? 0 : stage === 'rewrite cards' ? 1 : 2);
});

test('G1: main rules callback accepts an intentionally empty rules section', async () => {
  const f = await rulesFixture();
  try { await f.plugin.generator.run(f.h); }
  finally { f.plugin.store.close(); }
  assert.equal(f.h.cards.length, 1);
  assert.equal(f.calls.every(req => JSON.parse(req.user).rules === ''), true);
});

// ------------------------------------------------------------------- tests

test("the shipped bundle evaluates as a CommonJS module", () => {
  const { mod, evalError } = load(VALID);
  assert.equal(evalError, null, `module evaluation threw: ${evalError && evalError.message}`);
  const exported = mod && mod.default ? mod.default : mod;
  assert.equal(typeof exported, "function", "the plugin class is not exported");
});

test("onload resolves with a valid data.json, and builds every collaborator", async () => {
  const { mod, files } = load(VALID);
  const plugin = instance(mod, files);
  await plugin.onload();

  // A half-run onload leaves the instance present with these missing, which a
  // bare "is recall in app.plugins.plugins" check would call healthy.
  for (const field of ["store", "llm", "schema", "anki", "generator", "highlighter"]) {
    assert.ok(plugin[field], `onload did not build ${field}`);
  }
  assert.equal(plugin.settings.provider, "opencode", "the saved provider was not read");
  assert.equal(plugin.settings.opencodeModel, "deepseek/deepseek-flash", "the saved model was not read");
  assert.ok(plugin.sourceExtension, "editor passage extension was not registered");
  assert.equal(typeof plugin.sourceProcessor, "function", "reading passage processor was not registered");
});

test("onload resolves when data.json is malformed, falling back to defaults", async () => {
  // Obsidian returns undefined for unparseable content rather than throwing,
  // and Object.assign ignores undefined, so the plugin must come up on defaults
  // instead of failing to load. This is the case a bad iCloud sync produces.
  const { mod, files } = load(VALID.slice(0, Math.floor(VALID.length / 2)));
  const plugin = instance(mod, files);
  await plugin.onload();
  assert.equal(plugin.settings.provider, "codex", "defaults did not apply");
  assert.ok(plugin.store, "onload did not finish");
});

test("onload resolves when data.json is missing", async () => {
  // The other shape of the same problem: the file is not there at all.
  const { mod, files } = load(null);
  const plugin = instance(mod, files);
  await plugin.onload();
  assert.equal(plugin.settings.provider, "codex", "defaults did not apply");
  assert.ok(plugin.store, "onload did not finish");
});

test("loading never writes data.json", async () => {
  // A load that saved would rewrite the reader's settings on every startup, and
  // would clobber a file an interrupted sync had left in a bad state.
  const { mod, files } = load(VALID);
  const plugin = instance(mod, files);
  await plugin.onload();
  assert.equal(plugin.savedDuringLoad, 0, "onload wrote settings");
});

test("registered source-history command opens current-source archives without touching source notes", async () => {
  const { mod, files } = load(VALID);
  const plugin = instance(mod, files);
  await plugin.onload();
  const originalFiles = new Map(files);
  const path = "missing.md";
  plugin.store.add({ id: "archive", sourcePath: path, text: "Retained quote", archived: true, status: "exported", cards: [], page: null });
  assert.equal(plugin.store.all().length, 0);
  assert.equal(plugin.store.sourceHistory(path).length, 1);
  plugin.app.workspace.getActiveFile = () => ({ path, extension: "md" });
  plugin.app.workspace.offref = () => {};
  plugin.app.vault.offref = () => {};
  const command = plugin.commands.find(c => c.id === "open-source-history");
  assert.ok(command);
  const before = openedModals.length;
  assert.equal(command.checkCallback(true), true);
  assert.equal(openedModals.length, before);
  assert.equal(command.checkCallback(false), true);
  assert.equal(openedModals.at(-1).path, path);
  openedModals.at(-1).close();
  plugin.store.close();
  assert.deepEqual(files, originalFiles);
});
