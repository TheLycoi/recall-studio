// Run with: npm test
//
// Drives the REAL export path (main.ts exportHighlights -> anki.ts exportToAnki)
// against a fake AnkiConnect reached through the stubbed `obsidian.requestUrl`.
// This is a stubbed integration check, not actual Obsidian or Anki proof: the plugin is loaded the
// way Obsidian loads it (onload against a stubbed obsidian), then the export
// function is executed, and the fake collection is inspected afterwards.
//
// The cases are the export-safety requirements: approval bypass, a retry after
// a lost response, a re-send after the deck changes, a content duplicate of an
// unrelated note, media safety, drafts preserved on a connection failure, and
// no scheduling or destructive AnkiConnect call ever being made.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Module from "node:module";
import { sharedBuildOptions } from "../scripts/esbuild-shared.mjs";

// --------------------------------------------------------------- the fake

const ALLOWED_ACTIONS = new Set(["version", "deckNames", "modelNames", "modelFieldNames", "createDeck", "addNotes", "findNotes", "notesInfo", "storeMediaFile"]);

function unescapeAnki(text) {
  return text.replace(/\\(.)/g, "$1");
}

/**
 * A small Anki collection. Notes are keyed by note id; download/duplicate rules
 * follow Anki's stock behaviour: a note whose first field matches an existing
 * note's first field (same model) is refused as a duplicate of that note.
 */
function makeAnki() {
  const notes = new Map();
  const media = [];
  const actions = [];
  let nextId = 1000;
  // "up" | "writeThenDie" (addNotes writes then the reply is lost and every
  // later call fails) | "unreachable" (every call fails).
  let mode = "up";
  let died = false;

  // Anki's duplicate rule: with allowDuplicate off, a note whose first field
  // matches an existing note's first field (same model) is refused. The scope
  // decides where it looks: "collection" searches every deck, "deck" only the
  // target deck. The default, like Anki's, is collection.
  function isDuplicate(note) {
    const scope = note.options?.duplicateScope ?? "collection";
    const firstKey = Object.keys(note.fields)[0];
    const firstVal = note.fields[firstKey];
    for (const n of notes.values()) {
      if (n.modelName !== note.modelName) continue;
      if (scope === "deck" && n.deck !== note.deckName) continue;
      const nFirst = n.fields[Object.keys(n.fields)[0]];
      if (nFirst === firstVal) return true;
    }
    return false;
  }

  function handle(action, params) {
    if (mode === "unreachable" || (mode === "writeThenDie" && died)) {
      maybeDie(action);
      throw new Error("ECONNREFUSED");
    }
    actions.push(action);
    maybeDie(action);
    switch (action) {
      case "createDeck":
        return null;
      case "addNotes": {
        const ids = [];
        for (const note of params.notes) {
          if (!note.options?.allowDuplicate && isDuplicate(note)) {
            ids.push(null);
            continue;
          }
          const id = nextId++;
          notes.set(id, { modelName: note.modelName, fields: note.fields, tags: note.tags, deck: note.deckName });
          if (mode === "writeThenDie") {
            died = true;
            throw new Error("response lost after write");
          }
          ids.push(id);
        }
        return ids;
      }
      case "findNotes": {
        const q = params.query;
        if (q.startsWith("tag:")) {
          const tag = unescapeAnki(q.slice(4));
          return [...notes.entries()].filter(([, n]) => n.tags.includes(tag)).map(([id]) => id);
        }
        const text = unescapeAnki(q.replace(/^"|"$/g, ""));
        return [...notes.entries()].filter(([, n]) => Object.values(n.fields).some((v) => v.includes(text))).map(([id]) => id);
      }
      case "notesInfo":
        return [...params.notes].filter((id) => notes.has(id)).map((id) => ({
          noteId: id,
          modelName: notes.get(id).modelName,
          tags: notes.get(id).tags,
          fields: Object.fromEntries(Object.entries(notes.get(id).fields).map(([k, v]) => [k, { value: v, order: 0 }])),
        }));
      case "storeMediaFile":
        media.push(params.filename);
        return params.filename;
      default:
        return null;
    }
  }

  function maybeDie() {}

  return {
    handle,
    notes,
    media,
    actions,
    get mode() {
      return mode;
    },
    setMode(m) {
      mode = m;
      died = false;
    },
    addSeedNote(modelName, fields, tags = [], deck = "Seeded") {
      const id = nextId++;
      notes.set(id, { modelName, fields, tags, deck });
      return id;
    },
  };
}

// --------------------------------------------------------------- the stub

class Stub {}
let exportDecision = modal => clickExportButton(modal, 'Export despite warnings');
const exportDialogs = [];
class ExportModalStub {
  constructor(app) { this.app = app; this.contentEl = el(); }
  open() { exportDialogs.push(this); this.onOpen(); exportDecision(this); }
  close() { this.onClose?.(); }
}
class Notice {
  constructor(message) {
    this.message = String(message);
    notices.push(this.message);
  }
  hide() {}
  setText() {}
}
class TFile extends Stub {}
class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
  }
  registerView() {}
  addSettingTab() {}
  addRibbonIcon() {
    return el();
  }
  addStatusBarItem() {
    return el();
  }
  addCommand() {}
  registerEvent() {}
  registerDomEvent() {}
  registerInterval() {}
  registerMarkdownPostProcessor() {}
  registerEditorExtension() {}
  async loadData() {
    return null;
  }
  async saveData() {}
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

function el(tag = 'root', options = {}) {
  return {
    tag, text: options.text ?? '', buttons: [],
    addClass() {}, removeClass() {}, toggleClass() {}, setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {}, setText(text) { this.text = text; }, empty() { this.children = []; }, remove() {}, appendChild(child) { this.children.push(child); },
    createEl(tag, options) { const child = el(tag, options); this.children.push(child); return child; },
    createDiv(options) { return this.createEl('div', options); }, createSpan(options) { return this.createEl('span', options); },
    querySelector() { return null; }, querySelectorAll() { return []; }, contains() { return false; }, closest() { return null; },
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, children: [], dataset: {},
  };
}
class ExportSettingStub {
  constructor(container) { this.container = container; }
  addButton(configure) {
    const button = { text: '', setButtonText(text) { this.text = text; return this; }, onClick(fn) { this.click = fn; return this; } };
    configure(button); this.container.buttons.push(button); return this;
  }
}
function clickExportButton(modal, text) {
  const button = modal.contentEl.buttons.find(button => button.text === text);
  assert.ok(button, `Missing export button: ${text}`);
  button.click();
}
function visibleText(node) { return [node.text, ...node.children.map(visibleText)].filter(Boolean).join('\n'); }
async function decideExport(decision, run) {
  const previous = exportDecision;
  exportDecision = decision;
  try { return await run(); } finally { exportDecision = previous; }
}

const notices = [];
let fake = makeAnki();
let requestUrlImpl = async (opts) => {
  const body = JSON.parse(opts.body);
  const result = fake.handle(body.action, body.params ?? {});
  return { status: 200, json: { result, error: null } };
};

const obsidian = {
  App: Stub, ButtonComponent: Stub, Editor: Stub, FileView: Stub, ItemView, MarkdownRenderer: Stub, MarkdownView: ItemView,
  Menu: Stub, Modal: ExportModalStub, Notice, Plugin, PluginSettingTab, Setting: ExportSettingStub, SuggestModal: Stub,
  MarkdownRenderChild: Stub, editorInfoField: {},
  TAbstractFile: Stub, TFile, TFolder: Stub, WorkspaceLeaf: Stub, WorkspaceWindow: Stub,
  addIcon() {}, setIcon() {}, loadPdfJs: async () => ({}),
  normalizePath: (p) => p.replace(/\/{2,}/g, "/").replace(/^\.\//, ""),
  parseFrontMatterAliases: () => [],
  requestUrl: (opts) => requestUrlImpl(opts),
  debounce: (fn) => fn,
  Platform: { isDesktopApp: true, isMacOS: true },
};

// ---------------------------------------------------------- the app harness

const PLUGIN_DIR = ".obsidian/plugins/review-inbox";

/** The vault/media files the export may read. */
const MEDIA_FILES = {
  "img/pic.png": new Uint8Array([137, 80, 78, 71]).buffer,
};

function makeApp() {
  const files = new Map([["Review Inbox/inbox.json", JSON.stringify({ version: 1, highlights: [] })]]);
  const adapter = {
    async exists(p) { return files.has(p) || p.endsWith("/"); },
    async read(p) { if (!files.has(p)) throw new Error(`ENOENT ${p}`); return files.get(p); },
    async write(p, d) { files.set(p, d); },
    async mkdir(p) { files.set(`${p}/`, ""); },
    async rename(a, b) { files.set(b, files.get(a)); files.delete(a); },
    async remove(p) { files.delete(p); },
  };
  return {
    __files: files,
    vault: {
      adapter,
      configDir: ".obsidian",
      getName: () => "Test Vault",
      getAbstractFileByPath: () => null,
      getMarkdownFiles: () => [],
      on: () => ({}),
      readBinary: async (file) => MEDIA_FILES[file.path] ?? new Uint8Array([]).buffer,
      // Used by exportAsTextFile's fallback path.
      async create(p, data) { if (files.has(p)) throw new Error('File already exists'); files.set(p, data); return { path: p, stat: {} }; },
      async createFolder(p) { files.set(`${p}/`, ""); return { path: p }; },
    },
    metadataCache: {
      on: () => ({}),
      getFileCache: () => null,
      getFirstLinkpathDest: (link) => {
        if (link === "img/pic.png") return { path: "img/pic.png" };
        // A link that resolves outside the vault: the export must refuse it.
        if (link === "secret.png") return { path: "../secret.png" };
        return null;
      },
    },
    workspace: {
      on: () => ({}),
      onLayoutReady: (cb) => cb(),
      iterateAllLeaves: () => {},
      getActiveViewOfType: () => null,
      getLeavesOfType: () => [],
      getRightLeaf: () => null,
      getLeaf: () => el(),
      trigger() {},
    },
  };
}

let PluginClass;
before(async () => {
  // The plugin's onload reaches for the DOM (highlighter mode, the status bar).
  // A minimal document and window, as Obsidian hands them over, let a real
  // onload run — the same shape test/load.test.mjs uses.
  globalThis.window = globalThis;
  const doc = el();
  doc.body = el();
  globalThis.document = doc;
  const dir = mkdtempSync(path.join(tmpdir(), "review-inbox-export-"));
  const out = path.join(dir, "main.js");
  await build({ ...sharedBuildOptions(), entryPoints: ["src/main.ts"], outfile: out, logLevel: "silent" });
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "obsidian") return obsidian;
    if (request === "@codemirror/view") return { WidgetType: class {}, Decoration: { none: [], widget: () => ({ range: () => ({ from: 0 }) }), set: xs => xs }, ViewPlugin: { fromClass: c => c } };
    return origLoad.call(this, request, ...rest);
  };
  try {
    const mod = Module.createRequire(import.meta.url)(out);
    PluginClass = mod.default || mod;
  } finally {
    Module._load = origLoad;
  }
});

const settings = (over = {}) => ({
  provider: "codex", codexPath: "", codexModel: "gpt-5.5", knownModels: [], deepseekApiKey: "", deepseekModel: "deepseek-v4-pro",
  opencodePath: "", opencodeModel: "deepseek/deepseek-flash", effort: "high", maxCardsPerHighlight: 5, contextChars: 700,
  language: "", writerInstructions: "", concurrency: 2, notifyWhenReady: false, schemaFolder: "Review Inbox",
  markMode: "none", openInboxOnCapture: false, highlighterMode: false, highlighterMinChars: 12,
  ankiConnectUrl: "http://127.0.0.1:8765", defaultDeck: "Default", basicModel: "Basic", basicFrontField: "Front",
  basicBackField: "Back", basicExtraField: "Extra", clozeModel: "Cloze", clozeTextField: "Text", clozeExtraField: "Back Extra",
  extraTags: "review-inbox", includeSourceTag: true, includeExtra: true, exportFolder: "Review Inbox/exports",
  topicFolder: "wiki", critiquePass: true, lintMode: "badge", historyExamples: true, schemaLearning: true,
  ...over,
});

const qa = (over = {}) => ({ id: "c1", highlightId: "h1", kind: "qa", front: "What is the interval?", back: "the gap between reviews", text: "", extra: "", status: "approved", edited: false, createdAt: "2026-01-01T00:00:00.000Z", ...over });
const cloze = (over = {}) => ({ id: "c2", highlightId: "h2", kind: "cloze", front: "", back: "", text: "The gap is the {{c1::interval}}.", extra: "", status: "approved", edited: false, createdAt: "2026-01-01T00:00:00.000Z", ...over });
const highlight = (cards, over = {}) => ({ id: "h1", status: "ready", title: "Interval", heading: "Spacing", sourceTitle: "Spacing", sourcePath: "wiki/Spacing.md", page: null, text: "The gap between reviews is the interval.", before: "", after: "", instruction: "", error: null, exportedAt: null, cards, ...over });

/** A loaded plugin with the fake Anki behind requestUrl and the given settings. */
async function loadedPlugin(over = {}) {
  const app = makeApp();
  const plugin = new PluginClass(app, { id: "review-inbox", name: "Review Inbox", dir: PLUGIN_DIR, version: "0.1.0" });
  await plugin.onload();
  plugin.settings = settings(over);
  plugin.__realStore = plugin.store;
  plugin.store = { all: () => [], touch() {}, async flush() {} };
  plugin.__app = app;
  return plugin;
}

function freshFake() {
  fake = makeAnki();
  return fake;
}

// ------------------------------------------------------------------- tests

test("Export accepts drafts and legacy approved cards in the explicit scope", async () => {
  fake = freshFake();
  const plugin = await loadedPlugin();
  const draft = qa({ id: "c-draft", status: "pending", front: "Draft question?", back: "draft answer" });
  const ok = qa({ id: "c-ok", status: "approved", front: "Approved question?", back: "approved answer" });
  notices.length = 0;
  await plugin.exportHighlights([highlight([draft, ok])]);

  assert.equal(fake.notes.size, 2, "both accepted cards should reach Anki");
  assert.deepEqual([...fake.notes.values()].map(n => n.fields.Front).sort(), ["Approved question?", "Draft question?"]);
  assert.equal(draft.status, "exported", "Export accepts the draft");
  assert.equal(ok.status, "exported", "the approved card is now exported");
});

test("an approved card exports once; a second send adds no duplicate", async () => {
  fake = freshFake();
  const plugin = await loadedPlugin();
  const card = qa({ id: "c1" });
  const h = highlight([card]);
  await plugin.exportHighlights([h]);
  const noteId = card.ankiNoteId;
  assert.equal(fake.notes.size, 1);

  // Re-approve so the same card is exportable again, and send it a second time.
  card.status = "approved";
  h.status = "ready";
  await plugin.exportHighlights([h]);
  assert.equal(fake.notes.size, 1, "the second send duplicated the note");
  assert.equal(card.status, "exported");
  assert.equal(card.ankiNoteId, noteId, "the note id changed");
  assert.ok(fake.actions.includes("notesInfo"), "the retry must verify actual Anki content");
});

test("export reports a visible content conflict without overwriting a note or accepting the edited draft", async () => {
  fake = freshFake();
  const plugin = await loadedPlugin();
  const card = qa({ status: "pending", back: "alpha" });
  const h = highlight([card]);
  await plugin.exportHighlights([h]);
  const remote = structuredClone([...fake.notes.values()][0]);
  card.back = "beta";
  card.status = "pending";
  h.status = "ready";
  notices.length = 0;
  await plugin.exportHighlights([h]);
  assert.equal(card.status, "pending");
  assert.equal(h.status, "ready");
  assert.equal(card.back, "beta");
  assert.deepEqual([...fake.notes.values()], [remote]);
  assert.ok(notices.some(notice => /content conflict/i.test(notice)));
  assert.ok(notices.some(notice => /0 added, 1 failed/.test(notice)));
  assert.equal(fake.actions.filter(action => action === "addNotes").length, 1);
});

test("a retry after a lost response does not duplicate the note", async () => {
  fake = freshFake();
  const plugin = await loadedPlugin();
  const card = qa({ id: "c1" });
  const h = highlight([card]);

  // The reply is lost after Anki writes the note, and Anki then goes away.
  fake.setMode("writeThenDie");
  notices.length = 0;
  await plugin.exportHighlights([h]);
  assert.equal(fake.notes.size, 1, "the note was written before the reply was lost");
  assert.equal(card.status, "approved", "a lost response must leave the card approved, not failed");

  // Anki comes back; the retry looks the card up by identity instead of re-adding.
  fake.setMode("up");
  await plugin.exportHighlights([h]);
  assert.equal(fake.notes.size, 1, "the retry duplicated the note");
  assert.equal(card.status, "exported");
});

test("re-sending after the deck changes looks the note up and does not duplicate it", async () => {
  fake = freshFake();
  const plugin = await loadedPlugin({ defaultDeck: "Deck A" });
  const card = qa({ id: "c1" });
  await plugin.exportHighlights([highlight([card])]);
  assert.equal(fake.notes.size, 1);
  assert.equal([...fake.notes.values()][0].deck, "Deck A");

  card.status = "approved";
  plugin.settings.defaultDeck = "Deck B";
  await plugin.exportHighlights([highlight([card])]);
  assert.equal(fake.notes.size, 1, "a deck change must not add a second note");
  assert.equal([...fake.notes.values()][0].deck, "Deck A", "the existing note must not be moved");
});

test("a content duplicate of an unrelated note is reported, not added or overwritten", async () => {
  fake = freshFake();
  const seededId = fake.addSeedNote("Basic", { Front: "What is the interval?", Back: "a different answer already in Anki" });
  const plugin = await loadedPlugin();
  const card = qa({ id: "c1", front: "What is the interval?", back: "the gap between reviews" });
  notices.length = 0;
  await plugin.exportHighlights([highlight([card])]);

  assert.equal(fake.notes.size, 1, "our export must not have added a note");
  assert.equal(card.status, "approved", "an unrelated content match must not remove this card from the export queue");
  assert.equal(fake.notes.get(seededId).fields.Back, "a different answer already in Anki", "the existing note was overwritten");
});

test("a connection failure preserves the approved drafts", async () => {
  fake = freshFake();
  fake.setMode("unreachable");
  const plugin = await loadedPlugin();
  const card = qa({ id: "c1" });
  notices.length = 0;
  await plugin.exportHighlights([highlight([card])]);
  assert.equal(card.status, "approved", "the card must stay approved when Anki is unreachable");
  assert.equal(fake.notes.size, 0);
  assert.ok(notices.some((n) => /export failed/i.test(n)), `expected an export-failed notice, got ${JSON.stringify(notices)}`);
});

test("a local media file is uploaded through storeMediaFile; remote URLs and vault-escape paths are refused", async () => {
  fake = freshFake();
  const plugin = await loadedPlugin();
  const card = qa({ id: "c1", extra: "![[img/pic.png]] ![remote](https://evil.example/x.png) ![[secret.png]]" });
  await plugin.exportHighlights([highlight([card])]);

  assert.equal(fake.media.length, 1);
  assert.match(fake.media[0], /^review-inbox-[a-f0-9]{64}\.png$/);
  assert.equal(fake.notes.size, 0, "unsafe or missing media prevents incomplete export");
  assert.equal(card.status, "approved", "retain the card for correction and retry");
});

test("the export makes no scheduling or destructive AnkiConnect call", async () => {
  fake = freshFake();
  const plugin = await loadedPlugin();
  await plugin.exportHighlights([highlight([qa({ id: "c1" })])]);
  for (const action of fake.actions) {
    assert.ok(ALLOWED_ACTIONS.has(action), `unexpected AnkiConnect action: ${action}`);
    assert.doesNotMatch(action, /sched|due|reschedul|forget|suspend|bury|answer|setSpecific|updateNote|deleteNotes|removeNotes|guiDeck|guiBrowse/i, `scheduling/destructive action: ${action}`);
  }
  assert.ok(fake.actions.includes("addNotes"));
});

test("exporting a dismissed passage is a no-op that reaches no Anki endpoint", async () => {
  fake = freshFake();
  const plugin = await loadedPlugin();
  notices.length = 0;
  await plugin.exportHighlights([highlight([qa({ id: "c1", status: "pending" })], { status: "dismissed" })]);
  assert.equal(fake.actions.length, 0, "no request should be made");
  assert.ok(notices.some((n) => /no visible drafts/i.test(n)), `expected a no-drafts notice, got ${JSON.stringify(notices)}`);
});

test("a content duplicate sitting in a DIFFERENT deck is reported, not added (collection scope)", async () => {
  fake = freshFake();
  // The same question already exists as an unrelated note in another deck. A
  // deck-scoped duplicate check would not see it and would add a second note.
  fake.addSeedNote("Basic", { Front: "What is the interval?", Back: "an unrelated note in another deck" }, [], "Other Deck");
  const plugin = await loadedPlugin({ defaultDeck: "Deck A" });
  const card = qa({ id: "c1", front: "What is the interval?", back: "the gap between reviews" });
  notices.length = 0;
  await plugin.exportHighlights([highlight([card])]);

  assert.equal(fake.notes.size, 1, "a cross-deck content duplicate must not be added");
  assert.equal(card.status, "approved", "the card stays approved for correction");
  assert.equal(fake.notes.get([...fake.notes.keys()][0]).fields.Back, "an unrelated note in another deck", "the existing note was overwritten");
});

test("text exports in the same instant use unique paths without overwriting", async (t) => {
  t.mock.method(Date.prototype, 'toISOString', () => '2026-10-12T22:00:00.000Z');
  fake = freshFake();
  const plugin = await loadedPlugin();
  const first = qa({ id: 'first', status: 'pending', front: 'First question?' });
  const second = qa({ id: 'second', status: 'pending', front: 'Second question?' });
  await plugin.exportAsTextFile([highlight([first])]);
  const files = plugin.__app.__files;
  const original = [...files.entries()].find(([p]) => p.endsWith('.txt'));
  assert.ok(original);
  await plugin.exportAsTextFile([highlight([second])]);
  assert.equal(first.status, 'exported');
  assert.equal(second.status, 'exported');
  assert.equal([...files.keys()].filter(p => p.endsWith('.txt')).length, 2);
  assert.equal(files.get(original[0]), original[1]);
});

for (const clozeExtraField of ["", "Text"]) {
  for (const method of ["exportHighlights", "exportAsTextFile"]) {
    test(`${method} rejects unsafe Cloze Extra mapping ${JSON.stringify(clozeExtraField)} before transport or file writes`, async () => {
      fake = freshFake();
      const plugin = await loadedPlugin({ clozeExtraField });
      const card = cloze({ status: "pending" });
      const h = highlight([card]);
      const original = structuredClone(h);
      notices.length = 0;
      await plugin[method]([h]);
      assert.deepEqual(h, original, "failed configuration must preserve the draft and source");
      assert.equal(fake.actions.length, 0, "unsafe payloads must fail before any Anki endpoint");
      assert.equal(fake.notes.size, 0);
      assert.equal([...plugin.__app.__files.keys()].filter(p => p.endsWith(".txt")).length, 0);
      assert.ok(notices.some(message => /Cloze extra field.*separate.*back.*Cloze text field/i.test(message)));
    });
  }
}

for (const method of ["exportHighlights", "exportAsTextFile"]) {
  test(`${method} keeps mapped Cloze citations separate from the final Text payload`, async () => {
    fake = freshFake();
    const plugin = await loadedPlugin();
    const card = cloze({ status: "pending", extra: "Recall the interval." });
    const h = highlight([card]);
    await plugin[method]([h]);
    if (method === "exportHighlights") {
      const note = [...fake.notes.values()][0];
      assert.equal(note.fields.Text, card.text);
      assert.match(note.fields["Back Extra"], /Recall the interval\..*reviewinbox-highlight.*Source:.*obsidian:\/\/open/);
    } else {
      const file = [...plugin.__app.__files.entries()].find(([p]) => p.endsWith(".txt"));
      assert.ok(file);
      const row = file[1].split("\n").find(line => line.startsWith("Cloze\t"));
      assert.ok(row);
      const fields = row.split("\t");
      assert.ok(fields.includes(card.text), "Text must be its own column, unchanged");
      const extra = fields.find(field => field.includes("reviewinbox-highlight"));
      assert.match(extra, /Recall the interval\..*Source:.*obsidian:\/\/open/);
      assert.notEqual(extra, card.text);
    }
    assert.equal(card.status, "exported");
    assert.equal(h.status, "exported");
  });
}

test("a text export splits a one-field cloze model from Q&A rows by note type", async () => {
  fake = freshFake();
  // The reader's Cloze model has no Extra field, so a cloze row carries one
  // column while a Q&A row carries two. Source inclusion is explicitly off:
  // a one-field Cloze cannot safely carry source quotes. Anki's importer needs
  // one shape per file, so they must not be written to the same one.
  const plugin = await loadedPlugin({ basicExtraField: "", clozeExtraField: "", includeExtra: false });
  const qaCard = qa({ id: "c-qa" });
  const clozeCard = cloze({ id: "c-cloze", highlightId: "h2" });
  const draft = qa({ id: "c-draft", highlightId: "h1", status: "pending", front: "Draft question?" });
  const files = plugin.__app.__files;
  await plugin.exportAsTextFile([highlight([qaCard, draft]), highlight([clozeCard], { id: "h2", sourcePath: "wiki/Spacing2.md" })]);

  const created = [...files.keys()].filter((p) => p.startsWith("Review Inbox/exports/") && p.endsWith(".txt"));
  const qaFile = created.find((p) => p.endsWith("-qa.txt"));
  const clozeFile = created.find((p) => p.endsWith("-cloze.txt"));
  assert.ok(qaFile, `expected a Q&A text file, got ${JSON.stringify(created)}`);
  assert.ok(clozeFile, `expected a cloze text file, got ${JSON.stringify(created)}`);
  assert.match(files.get(qaFile), /^Basic\t/m, "the Q&A file carries the Basic note type");
  assert.match(files.get(clozeFile), /^Cloze\t/m, "the cloze file carries the Cloze note type");
  assert.equal(/\{\{c1::interval\}\}/.test(files.get(qaFile)), false, "the one-field cloze row landed in the Q&A file");
  assert.ok(files.get(clozeFile).includes("{{c1::interval}}"), "the cloze row must be in the cloze file");
  // Text export also accepts drafts, with the correct note type.
  assert.equal(files.get(qaFile).includes("Draft question?"), true, "Export accepts the draft");
  assert.equal(files.get(clozeFile).includes("Draft question?"), false);
  assert.equal(qaCard.status, "exported");
  assert.equal(clozeCard.status, "exported");
  assert.equal(draft.status, "exported");
});


// P2 uses the real plugin entry point; each fixture explicitly decides the modal.
for (const method of ['exportHighlights', 'exportAsTextFile']) {
  test(`P2 ${method}: a clean legacy draft exports without warning consent`, async () => {
    fake = makeAnki();
    const plugin = await loadedPlugin(), card = qa({ status: 'pending' }), source = highlight([card]);
    let decisions = 0;
    await decideExport(modal => { decisions++; modal.close(); }, () => plugin[method]([source]));
    assert.equal(decisions, 0);
    assert.equal(card.status, 'exported');
    assert.equal(card.exportAcceptance, undefined);
    assert.equal(card.userCheck, undefined);
    assert.equal(card.generation, undefined);
    assert.equal(fake.notes.size, method === 'exportHighlights' ? 1 : 0);
    assert.equal([...plugin.__app.__files.keys()].filter(path => path.endsWith('.txt')).length, method === 'exportAsTextFile' ? 1 : 0);
  });
}
test('P2 cancellation sends nothing, changes no cards and does not persist', async () => {
  fake = makeAnki(); const plugin = await loadedPlugin(); const c = qa({status:'pending',critiqueReason:'The cue omits its source condition.'}), h = highlight([c]);
  const before = structuredClone(h); let writes = 0, decisions = 0; plugin.store.touch = () => writes++;
  const prior = exportDecision; exportDecision = modal => { decisions++; modal.close(); };
  try { await plugin.exportHighlights([h]); } finally { exportDecision = prior; }
  assert.equal(decisions, 1);
  assert.equal(fake.actions.length, 0); assert.deepEqual(h,before); assert.equal(writes,0);
});
test('P2 override records exact content separately without changing the model verdict', async () => {
  fake = makeAnki(); const plugin = await loadedPlugin(); const c = qa({status:'flagged',critiqueReason:'Ambiguous cue'}), h = highlight([c]);
  let flushed = false, decisions = 0; plugin.store.flush = async () => { flushed = true; };
  await decideExport(modal => { decisions++; clickExportButton(modal, 'Export despite warnings'); }, () => plugin.exportHighlights([h]));
  assert.equal(decisions, 1);
  assert.equal(fake.notes.size,1); assert.equal(c.status,'exported');
  assert.equal(c.generation,undefined); assert.equal(c.critiqueReason,'Ambiguous cue');
  assert.ok(c.exportAcceptance.issues.some(x=>x.includes('Ambiguous cue')));
  assert.ok(c.exportAcceptance.content.includes(c.front)); assert.ok(flushed);
});
test('P2 card changes while the warning is open invalidate the decision', async () => {
  fake = makeAnki(); const plugin = await loadedPlugin(); const c = qa({status:'pending',critiqueReason:'The cue omits its source condition.'}),h=highlight([c]);
  let decisions = 0;
  const prior = exportDecision; exportDecision = modal => { decisions++; c.back='Changed answer'; modal.resolve(true); modal.close(); };
  try { await plugin.exportHighlights([h]); } finally { exportDecision=prior; }
  assert.equal(decisions, 1);
  assert.equal(fake.actions.length,0); assert.equal(c.status,'pending'); assert.equal(c.exportAcceptance,undefined);
});
test('P2 changed selection or destination while the warning is open cannot broaden export', async () => {
  for (const change of ['selection','settings','archive']) {
    fake=makeAnki(); const plugin=await loadedPlugin(); const c=qa({status:'pending',critiqueReason:'The cue omits its source condition.'}),h=highlight([c]);
    let decisions = 0;
    const prior=exportDecision; exportDecision=modal=>{
      decisions++;
      if(change==='selection')h.cards.push(qa({id:'late',front:'Late card?'}));
      if(change==='settings')plugin.settings.defaultDeck='Other deck';
      if(change==='archive')h.archived=true;
      modal.resolve(true);modal.close();
    };
    try { await plugin.exportHighlights([h]); } finally {exportDecision=prior;}
    assert.equal(decisions, 1, change);
    assert.equal(fake.actions.length,0,change); assert.equal(c.exportAcceptance,undefined,change);
  }
});
test('P2 clean current and stale explicit checks skip warnings; a stale check with a concern needs acceptance', async () => {
  fake=makeAnki(); const plugin=await loadedPlugin(); const c=qa({front:'Spacing practice: what separates reviews?',back:'interval',status:'pending'}),h=highlight([c]);
  // Same serialization as cardContent: exact card, source context and siblings.
  c.userCheck={content:JSON.stringify([c.kind,c.front,c.back,c.text,c.extra,h.text,h.before,h.after,h.sourcePath,h.sourceTitle,h.heading,h.instruction,[]]),at:'fixture',issues:[]};
  const savedCheck = structuredClone(c.userCheck);
  const before=exportDialogs.length;await plugin.exportHighlights([h]);assert.equal(exportDialogs.length,before);
  assert.equal(c.status, 'exported'); assert.equal(c.exportAcceptance, undefined);
  const stale=qa({id:'stale',status:'pending',userCheck:c.userCheck});const hs=highlight([stale]);
  await plugin.exportHighlights([hs]);assert.equal(exportDialogs.length,before);
  assert.equal(stale.status, 'exported'); assert.equal(stale.exportAcceptance, undefined);
  assert.deepEqual(c.userCheck, savedCheck); assert.deepEqual(stale.userCheck, savedCheck);
  const warned = qa({ id: 'stale-warned', status: 'pending', userCheck: c.userCheck, critiqueReason: 'The cue omits its source condition.' }), hw = highlight([warned]);
  fake = makeAnki();
  let decisions = 0;
  await decideExport(modal => {
    decisions++;
    assert.deepEqual(modal.summary.warnings.map(warning => warning.cardId), [warned.id]);
    assert.ok(visibleText(modal.contentEl).includes(warned.critiqueReason));
    clickExportButton(modal, 'Export despite warnings');
  }, () => plugin.exportHighlights([hw]));
  assert.equal(decisions, 1); assert.equal(exportDialogs.length, before + 1);
  assert.equal(warned.status, 'exported'); assert.equal(fake.notes.size, 1);
  assert.deepEqual(warned.exportAcceptance.issues, [warned.critiqueReason]);
  assert.deepEqual(warned.userCheck, savedCheck);
});
test('P2 mixed selection reports only selected warnings and preserves partial receipts', async () => {
  fake=makeAnki();const plugin=await loadedPlugin();const a=qa({id:'one',status:'pending'}),b=qa({id:'two',status:'pending'}),h=highlight([a,b]);
  let d, decisions = 0;
  await decideExport(modal => { decisions++; d = modal; clickExportButton(modal, 'Export despite warnings'); }, () => plugin.exportHighlights([h],new Set(['one'])));
  assert.equal(decisions, 1);
  assert.equal(d.summary.notes,1);assert.deepEqual(d.summary.warnings.map(w=>w.cardId),['one']);
  assert.equal(a.status,'exported');assert.equal(b.status,'pending');assert.equal(b.exportAcceptance,undefined);
  const receipt=a.ankiNoteId;
  await decideExport(modal => { decisions++; clickExportButton(modal, 'Export despite warnings'); }, () => plugin.exportHighlights([h],new Set(['two'])));
  assert.equal(decisions, 2);
  assert.equal(a.ankiNoteId,receipt);assert.equal(b.status,'pending');assert.equal(b.ankiNoteId,undefined);assert.ok(b.exportAcceptance);
});
test('P2 cancelled text export writes no files and records no acceptance', async () => {
  const plugin=await loadedPlugin();const c=qa({status:'pending',critiqueReason:'The cue omits its source condition.'}),h=highlight([c]);const before=[...plugin.__app.__files];
  let decisions = 0;
  const prior=exportDecision;exportDecision=modal=>{ decisions++; modal.close(); };
  try{await plugin.exportAsTextFile([h]);}finally{exportDecision=prior;}
  assert.equal(decisions, 1);
  assert.deepEqual([...plugin.__app.__files],before);assert.equal(c.exportAcceptance,undefined);
});

let production;
before(async () => {
  const output = await build({ stdin: { contents: `export * from './src/cardActions'; export * from './src/generation'; export * from './src/anki';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'cjs', platform: 'node', external: ['obsidian'] });
  const module = new Module('export-helpers');
  module.require = name => name === 'obsidian' ? obsidian : Module.createRequire(import.meta.url)(name);
  module._compile(output.outputFiles[0].text, 'export-helpers.cjs');
  production = module.exports;
});
function verifiedFixture(overrides = {}, sourceOverrides = {}) {
  const card = qa({ status: 'pending', front: 'Spacing practice: what separates reviews?', back: 'interval', ...overrides });
  const source = highlight([card], sourceOverrides);
  card.generation = { batchId: 'batch', planId: 'plan', factIds: ['fact'], audit: { status: 'verified', reason: 'Supported', content: production.cardAuditContent(card), sourceKey: production.generationSourceKey(source) } };
  return { card, source };
}
function crossSourceFixture(plugin) {
  const selected = verifiedFixture();
  const partner = verifiedFixture({ id: 'partner', highlightId: 'h-partner', front: 'Learning practice: which delay divides repetitions?' }, { id: 'h-partner', sourcePath: 'wiki/Other.md', sourceTitle: 'Other' });
  const stored = [selected.source, partner.source];
  plugin.store.all = () => stored;
  return { ...selected, partner, stored };
}

for (const method of ['exportHighlights', 'exportAsTextFile']) {
  for (const decision of ['Cancel', 'Export despite warnings']) {
    test(`B2 ${method}: ${decision} sees cross-source warnings without widening selection`, async () => {
      fake = makeAnki();
      const plugin = await loadedPlugin();
      const { card, source, partner } = crossSourceFixture(plugin);
      const before = structuredClone(partner.source), dialogs = exportDialogs.length;
      let touches = 0, flushes = 0;
      plugin.store.touch = () => touches++;
      plugin.store.flush = async () => { assert.ok(card.exportAcceptance); flushes++; };
      await decideExport(modal => {
        assert.match(visibleText(modal.contentEl), /1 notes \/ 1 reviews selected. 1 notes need your review/);
        assert.ok(visibleText(modal.contentEl).includes('answer used elsewhere'));
        assert.ok(visibleText(modal.contentEl).includes(card.front));
        assert.ok(!visibleText(modal.contentEl).includes(partner.card.front));
        assert.deepEqual(modal.summary.warnings.map(warning => warning.cardId), [card.id]);
        clickExportButton(modal, decision);
      }, () => plugin[method]([source], new Set([card.id])));
      assert.equal(exportDialogs.length, dialogs + 1);
      assert.deepEqual(partner.source, before);
      const files = [...plugin.__app.__files.keys()].filter(path => path.endsWith('.txt'));
      if (decision === 'Cancel') {
        assert.equal(card.exportAcceptance, undefined);
        assert.equal(card.status, 'pending');
        assert.equal(fake.actions.length, 0);
        assert.equal(files.length, 0);
        assert.equal(touches, 0);
        assert.equal(flushes, 0);
      } else {
        assert.equal(card.status, 'exported');
        assert.deepEqual(card.exportAcceptance.issues, ['answer used elsewhere']);
        assert.equal(card.generation.audit.status, 'verified');
        assert.equal(flushes, 1);
        assert.equal(fake.notes.size, method === 'exportHighlights' ? 1 : 0);
        assert.equal(files.length, method === 'exportAsTextFile' ? 1 : 0);
        if (files.length) assert.ok(!plugin.__app.__files.get(files[0]).includes(partner.card.front));
      }
    });
  }

  for (const phase of ['dialog', 'flush']) {
    for (const change of ['new-finding', 'removed-finding', 'changed-partner']) {
      test(`B2 ${method}: ${phase} ${change} invalidates acceptance`, async () => {
        fake = makeAnki();
        const plugin = await loadedPlugin();
        const { card, source, partner, stored } = crossSourceFixture(plugin);
        if (change === 'new-finding') {
          partner.card.back = 'different';
          card.critiqueReason = 'Initial warning to open the dialog';
        }
        const mutate = () => {
          if (change === 'new-finding') partner.card.back = 'interval';
          else if (change === 'removed-finding') partner.source.archived = true;
          else stored.splice(1, 1, { ...partner.source, id: 'replacement-source', cards: [{ ...partner.card, id: 'replacement-card' }] });
        };
        const started = barrier(), release = barrier();
        if (phase === 'flush') plugin.store.flush = async () => { started.resolve(); await release.promise; };
        let touches = 0, decisions = 0;
        plugin.store.touch = () => touches++;
        const exporting = decideExport(modal => {
          decisions++;
          if (phase === 'dialog') mutate();
          clickExportButton(modal, 'Export despite warnings');
        }, () => plugin[method]([source], new Set([card.id])));
        if (phase === 'flush') { await started.promise; mutate(); release.resolve(); }
        await exporting;
        assert.equal(decisions, 1);
        assert.equal(fake.actions.length, 0);
        assert.equal([...plugin.__app.__files.keys()].filter(path => path.endsWith('.txt')).length, 0);
        assert.equal(card.status, 'pending');
        if (phase === 'dialog') { assert.equal(card.exportAcceptance, undefined); assert.equal(touches, 0); }
      });
    }
  }
}

for (const method of ['exportHighlights', 'exportAsTextFile']) {
  for (const phase of ['dialog', 'flush']) {
    for (const change of ['topic-added', 'topic-changed', 'topic-removed', 'vault-name']) {
      test(`B3 ${method}: ${phase} ${change} invalidates changed outgoing provenance`, async () => {
        fake = makeAnki();
        const plugin = await loadedPlugin();
        const card = qa({ status: 'pending' }), source = highlight([card], { topicPath: change === 'topic-added' ? undefined : 'topics/Original.md' });
        if (phase === 'dialog') card.critiqueReason = 'The cue omits its source condition.';
        const payload = () => production.buildNote(card, source, { settings: plugin.settings, vaultName: plugin.__app.vault.getName(), deck: plugin.settings.defaultDeck });
        const initial = payload(), started = barrier(), release = barrier();
        const mutate = () => {
          if (change === 'vault-name') plugin.__app.vault.getName = () => 'Renamed Vault';
          else source.topicPath = change === 'topic-removed' ? undefined : 'topics/Changed.md';
        };
        let touches = 0, decisions = 0;
        plugin.store.touch = () => touches++;
        if (phase === 'flush') plugin.store.flush = async () => { started.resolve(); await release.promise; };
        const exporting = decideExport(modal => {
          decisions++;
          if (phase === 'dialog') mutate();
          clickExportButton(modal, 'Export despite warnings');
        }, () => plugin[method]([source]));
        if (phase === 'flush') { await started.promise; mutate(); release.resolve(); }
        await exporting;
        assert.equal(decisions, phase === 'dialog' ? 1 : 0);
        assert.notDeepEqual(initial, payload(), 'The changed provenance affects the actual final note');
        assert.equal(fake.actions.length, 0);
        assert.equal([...plugin.__app.__files.keys()].filter(path => path.endsWith('.txt')).length, 0);
        assert.equal(card.status, 'pending');
        if (phase === 'dialog') { assert.equal(card.exportAcceptance, undefined); assert.equal(touches, 0); }
      });
    }
  }
}

function barrier() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function realStoreFixture(plugin) {
  plugin.store = plugin.__realStore;
  const card = qa({ status: 'pending', front: 'Spacing practice: what separates reviews?', back: 'interval' });
  const source = highlight([card]);
  plugin.store.data.highlights.push(source);
  const adapter = plugin.__app.vault.adapter;
  const rename = adapter.rename;
  adapter.rename = async (from, to) => {
    assert.ok(!plugin.__app.__files.has(to), 'The real adapter does not overwrite rename destinations');
    return rename(from, to);
  };
  return { card, source };
}

test('B1 unload preserves a partial receipt and restores the failed draft before its final flush', async () => {
  fake = makeAnki();
  const plugin = await loadedPlugin();
  const { card, source } = realStoreFixture(plugin);
  const failed = qa({ id: 'failed-card', status: 'flagged', front: 'Second unsupported cue?', back: 'other answer', critiqueReason: 'Keep this adverse finding' });
  source.cards.push(failed);
  const started = barrier(), release = barrier(), request = requestUrlImpl;
  let adds = 0, unloading;
  requestUrlImpl = async options => {
    if (JSON.parse(options.body).action === 'addNotes' && ++adds === 2) {
      started.resolve(); await release.promise; throw new Error('Second note refused');
    }
    return request(options);
  };
  try {
    const exporting = plugin.exportHighlights([source]);
    await started.promise;
    unloading = plugin.onunload();
    release.resolve();
    await exporting;
    await unloading;
    assert.equal(fake.notes.size, 1);
    assert.equal(card.status, 'exported');
    assert.ok(card.ankiNoteId);
    assert.equal(failed.status, 'flagged');
    assert.equal(failed.ankiNoteId, undefined);
    assert.ok(failed.exportAcceptance.issues.includes(failed.critiqueReason));
    assert.equal(plugin.store.hasUnsavedChanges, false);
    assert.equal(plugin.__app.__files.get('Review Inbox/inbox.json'), JSON.stringify(plugin.store.data, null, 2));
  } finally {
    release.resolve();
    await unloading;
    requestUrlImpl = request;
    plugin.store.close();
  }
});

for (const method of ['exportHighlights', 'exportAsTextFile']) {
  test(`B1 ${method}: unload during acceptance flush leaves the real store durable`, async () => {
    fake = makeAnki();
    const plugin = await loadedPlugin();
    const { card, source } = realStoreFixture(plugin);
    card.critiqueReason = 'The cue omits its source condition.';
    const started = barrier(), release = barrier();
    const adapter = plugin.__app.vault.adapter, write = adapter.write;
    let first = true;
    adapter.write = async (path, data) => {
      if (first) { first = false; started.resolve(); await release.promise; }
      return write(path, data);
    };
    let decisions = 0;
    const exporting = decideExport(modal => {
      decisions++;
      clickExportButton(modal, 'Export despite warnings');
    }, () => plugin[method]([source]));
    await started.promise;
    const unloading = plugin.onunload();
    release.resolve();
    await exporting;
    await unloading;
    assert.equal(decisions, 1);
    assert.equal(fake.actions.length, 0);
    assert.equal([...plugin.__app.__files.keys()].filter(path => path.endsWith('.txt')).length, 0);
    assert.equal(card.status, 'pending');
    assert.ok(card.exportAcceptance);
    assert.deepEqual(card.exportAcceptance.issues, [card.critiqueReason]);
    assert.equal(plugin.store.hasUnsavedChanges, false);
    assert.equal(plugin.store.closed, true);
    assert.equal(plugin.__app.__files.get('Review Inbox/inbox.json'), JSON.stringify(plugin.store.data, null, 2));
  });

  test(`B1 ${method}: unload drains transport and persists receipts and concurrent edits`, async () => {
    fake = makeAnki();
    const plugin = await loadedPlugin();
    const { card, source } = realStoreFixture(plugin);
    const started = barrier(), release = barrier();
    const request = requestUrlImpl, create = plugin.__app.vault.create;
    if (method === 'exportHighlights') {
      requestUrlImpl = async options => {
        if (JSON.parse(options.body).action === 'addNotes') {
          started.resolve(); await release.promise;
        }
        return request(options);
      };
    } else {
      plugin.__app.vault.create = async (...args) => {
        started.resolve(); await release.promise;
        return create(...args);
      };
    }
    let unloading, settled = false, failure;
    try {
      const exporting = plugin[method]([source]);
      await started.promise;
      source.title = 'Edited while transport was running';
      plugin.store.touch();
      unloading = plugin.onunload().then(() => { settled = true; }, error => { settled = true; failure = error; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, 'Unload must not close storage while transport can still mutate cards');
      release.resolve();
      await exporting;
      await unloading;
      assert.equal(failure, undefined);
      assert.equal(card.status, 'exported');
      if (method === 'exportHighlights') assert.ok(card.ankiNoteId);
      assert.equal(plugin.store.hasUnsavedChanges, false);
      assert.equal(plugin.store.closed, true);
      const saved = JSON.parse(plugin.__app.__files.get('Review Inbox/inbox.json'));
      assert.equal(saved.highlights[0].title, source.title);
      assert.deepEqual(saved.highlights[0].cards[0], card);
    } finally {
      release.resolve();
      await unloading;
      requestUrlImpl = request;
      plugin.store.close();
    }
  });
}
