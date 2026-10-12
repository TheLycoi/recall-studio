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

function el() {
  return {
    addClass() {}, removeClass() {}, toggleClass() {}, setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {}, setText() {}, empty() {}, remove() {}, appendChild() {},
    createEl() { return el(); }, createDiv() { return el(); }, createSpan() { return el(); },
    querySelector() { return null; }, querySelectorAll() { return []; }, contains() { return false; }, closest() { return null; },
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, children: [], dataset: {},
  };
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
  Menu: Stub, Modal: Stub, Notice, Plugin, PluginSettingTab, Setting: Stub, SuggestModal: Stub,
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
      async create(p, data) { files.set(p, data); return { path: p, stat: {} }; },
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
  plugin.store = { all: () => [], touch() {} };
  plugin.__app = app;
  return plugin;
}

function freshFake() {
  fake = makeAnki();
  return fake;
}

// ------------------------------------------------------------------- tests

test("only approved cards are exported; a draft is bypassed and stays a draft", async () => {
  fake = freshFake();
  const plugin = await loadedPlugin();
  const draft = qa({ id: "c-draft", status: "pending", front: "Draft question?", back: "draft answer" });
  const ok = qa({ id: "c-ok", status: "approved", front: "Approved question?", back: "approved answer" });
  notices.length = 0;
  await plugin.exportHighlights([highlight([draft, ok])]);

  assert.equal(fake.notes.size, 1, "exactly the approved card should reach Anki");
  const note = [...fake.notes.values()][0];
  assert.equal(note.fields.Front, "Approved question?");
  assert.equal(draft.status, "pending", "the draft must not change status");
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
  await plugin.exportHighlights([h]);
  assert.equal(fake.notes.size, 1, "the second send duplicated the note");
  assert.equal(card.ankiNoteId, noteId, "the note id changed");
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

test("exporting with nothing approved is a no-op that reaches no Anki endpoint", async () => {
  fake = freshFake();
  const plugin = await loadedPlugin();
  notices.length = 0;
  await plugin.exportHighlights([highlight([qa({ id: "c1", status: "pending" })])]);
  assert.equal(fake.actions.length, 0, "no request should be made");
  assert.ok(notices.some((n) => /nothing approved/i.test(n)), `expected a nothing-approved notice, got ${JSON.stringify(notices)}`);
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

test("a text export splits a one-field cloze model from Q&A rows by note type", async () => {
  fake = freshFake();
  // The reader's Cloze model has no Extra field, so a cloze row carries one
  // column while a Q&A row carries two. Anki's importer needs one shape per
  // file, so they must not be written to the same one.
  const plugin = await loadedPlugin({ basicExtraField: "", clozeExtraField: "" });
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
  // Approved-only is retained: the draft is written nowhere.
  assert.equal(files.get(qaFile).includes("Draft question?"), false, "a draft must not be exported");
  assert.equal(files.get(clozeFile).includes("Draft question?"), false);
  assert.equal(qaCard.status, "exported");
  assert.equal(clozeCard.status, "exported");
  assert.equal(draft.status, "pending");
});
