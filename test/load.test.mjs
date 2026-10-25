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

test('legacy true settings cannot restore schema startup work or rules commands, and files survive', async () => {
  const saved = { provider: 'codex', schemaFolder: 'Recall', schemaLearning: true, historyExamples: true,
    writerInstructions: 'Legacy global instruction', unknownFutureField: { preserve: ['all', 'values'] } };
  const { mod, files } = load(JSON.stringify(saved));
  for (const name of ['recall-rules.md', 'recall-suggestions.md', 'history.json']) files.set(`Recall/${name}`, `Original ${name}`);
  files.set('Recall', ''); // The store may ensure its data directory, not rule files.
  const before = new Map(files), plugin = instance(mod, files), reads = [];
  const read = plugin.app.vault.adapter.read;
  plugin.app.vault.adapter.read = async path => { reads.push(path); return read(path); };
  plugin.app.workspace.onLayoutReady = () => {};
  await plugin.onload();
  try {
    assert.equal(plugin.schema, undefined, 'No rules collaborator is instantiated');
    assert.deepEqual(reads.filter(p => /rules|suggestions|history/.test(p)), []);
    assert.deepEqual(files, before, 'Loading must neither create nor change legacy files');
    assert.ok(!plugin.commands.some(c => /schema/.test(c.id)));
    await plugin.saveSettings();
    const roundtrip = JSON.parse(files.get(`${PLUGIN_DIR}/data.json`));
    for (const [key, value] of Object.entries(saved)) assert.deepEqual(roundtrip[key], value, key);
    for (const [path, value] of before) if (!path.endsWith('/data.json')) assert.equal(files.get(path), value);
  } finally { await plugin.onunload(); }
});

test('fresh startup creates no rule or suggestions files', async () => {
  const { mod, files } = load(null), plugin = instance(mod, files);
  plugin.app.workspace.onLayoutReady = () => {};
  await plugin.onload();
  try { assert.deepEqual([...files.keys()].filter(p => /rules|suggestions/.test(p)), []); }
  finally { await plugin.onunload(); }
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
  for (const field of ["store", "llm", "anki", "generator", "highlighter"]) {
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
