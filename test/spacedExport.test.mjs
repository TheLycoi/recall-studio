// Run with: npm test
//
// Executes the real `exportToSpacedRepetition` against a stubbed `obsidian`
// vault, and asserts the two things its first live run got wrong.
//
// Why this file exists: the Spaced Repetition export was verified statically —
// the serialization was run through the target plugin's own parser — but the
// export *function* was never executed by any test. So the one thing a live run
// exposed had no test at all: the export wrote its note and never marked the
// cards it had written, leaving them pending and the highlight "ready". Pressing
// the command again therefore wrote a second note holding the same cards, which
// is exactly what happened in the vault.
//
// The method is called directly on a constructed plugin rather than through
// `onload`, so this stays a test of the export and not of the whole startup
// (test/load.test.mjs already covers startup).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Module from "node:module";
import { sharedBuildOptions } from "../scripts/esbuild-shared.mjs";

// --------------------------------------------------------------- the stub

// Every name any bundled module imports from `obsidian`. Module evaluation
// resolves them all, so each must exist even when the export never touches it.
class Stub {}
class Notice {
  constructor(message) {
    notices.push(String(message));
  }
  hide() {}
}
class TFile extends Stub {}
// `Plugin` and `PluginSettingTab` take constructor arguments, so they cannot be
// the bare Stub: the plugin under test reads `this.app` and `this.manifest`.
// Leaving them as Stub made `this.app` undefined and every export throw, which
// looked like a product bug and was not.
class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
  }
}
class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
  }
}

const notices = [];

const obsidian = {
  App: Stub,
  ButtonComponent: Stub,
  Editor: Stub,
  FileView: Stub,
  ItemView: Stub,
  MarkdownRenderer: Stub,
  MarkdownView: Stub,
  Menu: Stub,
  Modal: Stub,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting: Stub,
  SuggestModal: Stub,
  TAbstractFile: Stub,
  TFile,
  TFolder: Stub,
  WorkspaceLeaf: Stub,
  WorkspaceWindow: Stub,
  addIcon: () => {},
  setIcon: () => {},
  loadPdfJs: async () => ({}),
  normalizePath: (p) => p.replace(/\/{2,}/g, "/").replace(/^\.\//, ""),
  parseFrontMatterAliases: () => [],
  requestUrl: async () => ({ status: 200, json: {} }),
};

/** A vault adapter backed by a Map, with the folder handling the export uses. */
function makeVault() {
  const files = new Map();
  const folders = new Set();
  const vault = {
    adapter: {
      async exists(p) {
        return files.has(p) || folders.has(p);
      },
      async read(p) {
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
        return files.get(p);
      },
      async write(p, d) {
        files.set(p, d);
      },
    },
    async create(p, d) {
      if (files.has(p)) throw new Error(`already exists: ${p}`);
      files.set(p, d);
      return { path: p };
    },
    async createFolder(p) {
      folders.add(p);
    },
    getName: () => "test-vault",
    configDir: ".obsidian",
  };
  return { vault, files, folders };
}

// ------------------------------------------------------------- the harness

let PluginClass;

before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-sr-"));
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

/** The settings the export reads. Defaults, except where a test overrides one. */
function settings(over = {}) {
  return {
    srFolder: "Recall/spaced",
    srTag: "flashcards",
    srDeck: "recall",
    srBasicSeparator: "::",
    srReversedSeparator: ":::",
    srMultilineSeparator: "?",
    topicFolder: "wiki",
    defaultDeck: "Default",
    ...over,
  };
}

/** A ready highlight with two pending cards, shaped as src/model.ts defines. */
function highlight(over = {}) {
  const cards = [
    {
      id: "c1",
      highlightId: "h1",
      kind: "qa",
      front: "What is the interval?",
      back: "the gap between reviews",
      text: "",
      extra: "",
      status: "pending",
      edited: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "c2",
      highlightId: "h1",
      kind: "cloze",
      front: "",
      back: "",
      text: "The gap between reviews is the {{c1::interval}}.",
      extra: "",
      status: "pending",
      edited: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  return {
    id: "h1",
    status: "ready",
    title: "Interval",
    heading: "",
    sourceTitle: "Spacing",
    sourcePath: "wiki/Spacing.md",
    page: null,
    text: "The gap between reviews is the interval.",
    before: "",
    after: "",
    instruction: "",
    error: null,
    exportedAt: null,
    cards,
    ...over,
  };
}

/** A plugin instance wired to the given vault and list of highlights. */
function plugin(vault, highlights, over = {}) {
  const p = new PluginClass({ vault, workspace: {}, metadataCache: {} }, { id: "recall", dir: ".obsidian/plugins/recall", version: "0.3.1" });
  p.settings = settings(over);
  p.touches = 0;
  p.flushes = 0;
  p.store = {
    all: () => highlights,
    // The real store's touch() schedules a save and notifies listeners. A stub
    // that ignored it would let a fix that only ever mutates memory pass, which
    // is a failure mode of exactly the kind this file exists to catch.
    touch: () => {
      p.touches++;
    },
    flush: async () => {
      p.flushes++;
    },
    close: () => {},
  };
  return p;
}

const srNotes = (files) => [...files.keys()].filter((k) => k.startsWith("Recall/spaced/") && k.endsWith(".md"));

// ------------------------------------------------------------------- tests

test("the export writes a note for a ready highlight's pending cards", async () => {
  const { vault, files } = makeVault();
  const h = highlight();
  await plugin(vault, [h]).exportToSpacedRepetition([h]);

  const notes = srNotes(files);
  assert.equal(notes.length, 1, `expected one note, got ${JSON.stringify(notes)}`);
  const body = files.get(notes[0]);
  assert.match(body, /#flashcards\/recall/, "the deck tag is missing");
  assert.match(body, /What is the interval\?::the gap between reviews/, "the Q&A card is missing");
  assert.match(body, /==interval==/, "the cloze card is missing");
});

test("the export marks the cards it wrote as exported", async () => {
  // The defect this file exists for. Without the transition the cards stay in
  // the pending allowlist, so the highlight never finishes and the command
  // keeps offering to send the same cards again.
  const { vault } = makeVault();
  const h = highlight();
  await plugin(vault, [h]).exportToSpacedRepetition([h]);
  assert.deepEqual(
    h.cards.map((c) => c.status),
    ["exported", "exported"],
  );
});

test("the export records the note on each card, and finishes the highlight", async () => {
  const { vault, files } = makeVault();
  const h = highlight();
  const p = plugin(vault, [h]);
  await p.exportToSpacedRepetition([h]);

  const note = srNotes(files)[0];
  for (const c of h.cards) assert.equal(c.srNote, note, "srNote was not recorded");
  // finalizeHighlights flips the highlight once nothing is pending or flagged.
  assert.equal(h.status, "exported", "the highlight was left unfinished");
  assert.ok(h.exportedAt, "exportedAt was not stamped");
  // The status change is only real if the store is told to persist it. Mutating
  // memory and never saving would bring the cards back as pending on the next
  // load, which is the same duplicate-note symptom over a longer timescale.
  assert.ok(p.touches > 0, "the export never asked the store to persist the new statuses");
});

test("sending the same highlight twice writes one note, not two", async () => {
  // The user-visible symptom: two presses produced two near-identical notes
  // holding the same cards. This is the assertion that would have caught it.
  const { vault, files } = makeVault();
  const h = highlight();
  const p = plugin(vault, [h]);
  await p.exportToSpacedRepetition([h]);
  await p.exportToSpacedRepetition([h]);

  const notes = srNotes(files);
  assert.equal(notes.length, 1, `a second send wrote another note: ${JSON.stringify(notes)}`);
});

test("the second send reports there is nothing to send", async () => {
  const { vault } = makeVault();
  const h = highlight();
  const p = plugin(vault, [h]);
  await p.exportToSpacedRepetition([h]);
  notices.length = 0;
  await p.exportToSpacedRepetition([h]);
  assert.ok(
    notices.some((n) => /nothing to send/i.test(n)),
    `expected a "nothing to send" notice, got ${JSON.stringify(notices)}`,
  );
});

test("the export refuses a folder inside the wiki", async () => {
  // The wiki is read-only for Recall; the export must not write there.
  const { vault, files } = makeVault();
  const h = highlight();
  notices.length = 0;
  await plugin(vault, [h], { srFolder: "wiki/spaced" }).exportToSpacedRepetition([h]);
  assert.equal(srNotes(files).length, 0, "a note was written into the wiki folder");
  assert.ok(
    notices.some((n) => /inside the wiki folder/i.test(n)),
    `expected a refusal notice, got ${JSON.stringify(notices)}`,
  );
  assert.equal(h.cards[0].status, "pending", "the refusal must leave the cards pending");
});

test("a highlight that is not ready is not sent", async () => {
  const { vault, files } = makeVault();
  const h = highlight({ status: "queued" });
  await plugin(vault, [h]).exportToSpacedRepetition([h]);
  assert.equal(srNotes(files).length, 0, "a queued highlight was exported");
});

test("a flagged card is not written and blocks the highlight from finishing", async () => {
  // Flagged cards are excluded from the pending allowlist on purpose, and a
  // highlight still holding one is not finished.
  const { vault, files } = makeVault();
  const h = highlight();
  h.cards[1].status = "flagged";
  await plugin(vault, [h]).exportToSpacedRepetition([h]);

  const note = srNotes(files)[0];
  assert.doesNotMatch(files.get(note), /==interval==/, "the flagged card was written");
  assert.equal(h.status, "ready", "the highlight finished with a decision still open");
});
