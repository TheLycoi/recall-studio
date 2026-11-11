// Run with: npm test. Bundles src/store.ts, the inbox store, through the same
// esbuild options the plugin build uses. `obsidian` is replaced by a stub
// whose Notice records its message; the vault is the small in-memory one
// below, with only the adapter calls the store makes. Each test is a way the store could write over the
// reader's inbox: after a read that threw, after the plugin unloaded, and an
// older snapshot landing after a newer one.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sharedBuildOptions } from "../scripts/esbuild-shared.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INBOX = "wiki/_schema/inbox.json";
const REAL = JSON.stringify({ highlights: [{ id: "h1", sourcePath: "a.md", sourceTitle: "A", text: "kept", before: "", after: "", instruction: "", status: "ready", cards: [] }] }, null, 2);

function obsidianStub() {
  return {
    name: "obsidian-stub",
    setup(b) {
      b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: [
          "export class TAbstractFile {}",
          "export class TFile extends TAbstractFile {}",
          "export class TFolder extends TAbstractFile {}",
          "export const notices = [];",
          "export class Notice { constructor(message) { notices.push(message); } }",
          "export const normalizePath = (p) => p;",
        ].join("\n"),
        loader: "js",
      }));
    },
  };
}

let s;
let dir;
before(async () => {
  globalThis.window ??= globalThis;
  dir = mkdtempSync(path.join(tmpdir(), "wikilm-store-"));
  const out = path.join(dir, "store.cjs");
  const shared = sharedBuildOptions();
  await build({
    ...shared,
    stdin: {
      contents: ['export * from "./src/store.ts";', 'export { notices } from "obsidian";'].join("\n"),
      resolveDir: ROOT,
      sourcefile: "store-probe.ts",
      loader: "ts",
    },
    outfile: out,
    logLevel: "error",
    external: shared.external.filter((e) => e !== "obsidian"),
    plugins: [obsidianStub()],
  });
  s = createRequire(import.meta.url)(out);
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("renaming a folder moves active and archived references with path boundary protection", async () => {
  const { app } = memoryVault({});
  const store = new s.InboxStore(app, "wiki/_schema");
  await store.load();
  store.add({ id: "one", sourcePath: "old/a.md", sourceTitle: "a", cards: [], status: "ready" });
  store.add({ id: "two", sourcePath: "old/sub/b.pdf", sourceTitle: "b", cards: [], status: "exported", archived: true, page: 2, subpath: "page=2" });
  store.add({ id: "three", sourcePath: "older/c.md", sourceTitle: "c", cards: [], status: "ready" });
  assert.equal(store.moveSource("old", "new"), 2);
  assert.deepEqual(store.sourceHistory("new/sub/b.pdf").map(h => [h.id, h.sourceTitle, h.subpath]), [["two", "b", "page=2"]]);
  assert.equal(store.get("one").sourcePath, "new/a.md");
  assert.equal(store.get("three").sourcePath, "older/c.md");
  store.close();
});

test("rename rekeys source metadata without dropping active or archived links across reload", async () => {
  const { app } = memoryVault({});
  const store = new s.InboxStore(app, "wiki/_schema");
  await store.load();
  store.add(highlight("a", "exported", [card("c", "exported")], { sourcePath: "old/a.md", sourceTitle: "a", text: "quote", archived: true }));
  store.setTranscript("old/a.md", { text: "transcript", origin: "pasted", sourceFile: null, addedAt: "now", truncated: false });
  store.setHighlightInstruction("old/a.md", "instruction");
  store.markIngested("old/a.md", "hash");
  store.moveSource("old/a.md", "new/b.md");
  await store.flush(); store.close();
  const loaded = new s.InboxStore(app, "wiki/_schema"); await loaded.load();
  assert.equal(loaded.get("a").sourcePath, "new/b.md");
  assert.equal(loaded.findCard("c").highlight.sourcePath, "new/b.md");
  assert.equal(loaded.getTranscript("new/b.md").text, "transcript");
  assert.equal(loaded.getHighlightInstruction("new/b.md"), "instruction");
  assert.equal(loaded.ingestedHash("new/b.md"), "hash");
  assert.equal(loaded.getTranscript("old/a.md"), undefined);
  loaded.close();
});
test("metadata collisions on rename preserve both snapshots rather than overwriting a retained source", async () => {
  const { app } = memoryVault({}); const store = new s.InboxStore(app, "wiki/_schema"); await store.load();
  store.add({ id: "a", sourcePath: "old/a.md", sourceTitle: "a", cards: [], status: "ready" });
  store.setHighlightInstruction("old/a.md", "old instructions");
  store.setHighlightInstruction("new/a.md", "retained instructions");
  assert.equal(store.moveSource("old", "new"), 0);
  assert.equal(store.get("a").sourcePath, "old/a.md");
  assert.equal(store.getHighlightInstruction("old/a.md"), "old instructions");
  assert.equal(store.getHighlightInstruction("new/a.md"), "retained instructions");
  store.close();
});

/**
 * The vault adapter as far as src/store.ts reaches it (obsidian.d.ts
 * DataAdapter): exists, mkdir, read, write, remove and rename, over one map of files.
 */
function memoryVault(initial) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set();
  const parentOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const addDirs = (p) => {
    for (let d = parentOf(p); d; d = parentOf(d)) dirs.add(d);
  };
  for (const p of files.keys()) addDirs(p);
  const adapter = {
    exists: async (p) => files.has(p) || dirs.has(p),
    mkdir: async (p) => {
      dirs.add(p);
      addDirs(p);
    },
    read: async (p) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p);
    },
    write: async (p, data) => {
      files.set(p, data);
      addDirs(p);
    },
    remove: async (p) => {
      if (!files.delete(p)) throw new Error(`ENOENT: ${p}`);
    },
    rename: async (p, to) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      if (files.has(to)) throw new Error("Destination file already exists!");
      files.set(to, files.get(p));
      files.delete(p);
      addDirs(to);
    },
  };
  return { files, app: { vault: { adapter } } };
}

/** A memory vault holding a real inbox, with every adapter write counted. */
function vaultWithInbox() {
  const v = memoryVault({ [INBOX]: REAL });
  const writes = [];
  const write = v.app.vault.adapter.write;
  v.app.vault.adapter.write = async (p, data) => {
    writes.push(p);
    return write(p, data);
  };
  return { ...v, writes };
}

const quiet = async (fn) => {
  const err = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = err;
  }
};

test("transient queue notifications refresh listeners without invalidating a durable checkpoint", async () => {
  const v = vaultWithInbox(), store = new s.InboxStore(v.app, "wiki/_schema");
  await store.load();
  let changes = 0; const unsubscribe = store.onChange(() => { changes++; });
  try {
    store.notify();
    assert.equal(changes, 1);
    assert.equal(store.hasUnsavedChanges, false);
    assert.equal(store.saveTimer, null);
    assert.deepEqual(v.writes, []);
    assert.equal(v.files.get(INBOX), REAL);
    unsubscribe(); store.notify(); assert.equal(changes, 1);
  } finally { store.close(); }
});

test("a read that throws leaves the store read-only, so touch and flush never write over the inbox", async () => {
  const v = vaultWithInbox();
  v.app.vault.adapter.read = async () => {
    throw new Error("EDEADLK: resource deadlock would occur (iCloud eviction)");
  };
  const store = new s.InboxStore(v.app, "wiki/_schema");
  const before = s.notices.length;
  await quiet(() => store.load());
  assert.equal(store.readOnly, true);
  assert.ok(s.notices.slice(before).some((m) => /read-only/.test(m)), "the reader is told the inbox is read-only");
  store.touch();
  await store.flush();
  await new Promise((r) => setTimeout(r, 450));
  assert.deepEqual(v.writes, []);
  assert.equal(v.files.get(INBOX), REAL);
});

test("after close(), touch and flush write nothing", async () => {
  const v = vaultWithInbox();
  const store = new s.InboxStore(v.app, "wiki/_schema");
  await store.load();
  store.touch();
  store.close();
  store.all()[0].text = "changed by a late completion";
  store.touch();
  await store.flush();
  await new Promise((r) => setTimeout(r, 450));
  assert.deepEqual(v.writes, []);
  assert.equal(v.files.get(INBOX), REAL);
});

test("two quick flushes write the later snapshot last", async () => {
  const v = vaultWithInbox();
  const write = v.app.vault.adapter.write;
  let calls = 0;
  // The first write is slow and the second fast, so unchained they finish
  // out of order and the older snapshot lands on top.
  v.app.vault.adapter.write = async (p, data) => {
    const delay = calls++ === 0 ? 40 : 0;
    await new Promise((r) => setTimeout(r, delay));
    return write(p, data);
  };
  const store = new s.InboxStore(v.app, "wiki/_schema");
  await store.load();
  store.all()[0].text = "first";
  const a = store.flush();
  store.all()[0].text = "second";
  const b = store.flush();
  await Promise.all([a, b]);
  assert.equal(JSON.parse(v.files.get(INBOX)).highlights[0].text, "second");
  store.close();
});

test("failed legacy migration cannot create a competing inbox and restart retries the intact history", async () => {
  const legacy = ".obsidian/plugins/recall/inbox.json";
  const history = {
    ...JSON.parse(REAL), futureInbox: { preserved: true },
    revisions: [{
      cardId: "retained-card", at: "2026-10-24", via: "edit", instruction: "",
      before: { kind: "qa", front: "Question?", back: "Original", text: "", extra: "" },
      after: { kind: "qa", front: "Question?", back: "Saved", text: "", extra: "" },
      futureRevision: "retained",
    }],
  };
  const original = JSON.stringify(history, null, 2) + "\n";
  const v = memoryVault({ [legacy]: original });
  const adapter = v.app.vault.adapter, rename = adapter.rename;
  adapter.rename = async (from, to) => {
    if (from === legacy) throw Error("synthetic transient migration failure");
    return rename(from, to);
  };
  const store = new s.InboxStore(v.app, "wiki/_schema", ".obsidian/plugins/recall");
  const before = s.notices.length;
  try {
    await quiet(() => store.load());
    store.add(highlight("must-not-compete", "queued"));
    await store.flush();
    assert.deepEqual([...v.files.entries()], [[legacy, original]], "a new capture must not suppress migration on restart");
    assert.equal(store.readOnly, true);
    assert.ok(s.notices.slice(before).some(message => /migration|move/i.test(message) && /read-only/.test(message)));
    // A transient failure stays closed in this instance; loading again cannot bless its empty state.
    adapter.rename = rename;
    await store.load();
    await store.flush();
    assert.deepEqual([...v.files.entries()], [[legacy, original]]);
  } finally { store.close(); adapter.rename = rename; }
  const restarted = new s.InboxStore(v.app, "wiki/_schema", ".obsidian/plugins/recall");
  try {
    await restarted.load();
    assert.equal(restarted.readOnly, false);
    assert.deepEqual(restarted.allHistory(), history.highlights);
    assert.deepEqual(restarted.revisions(), history.revisions);
    assert.equal(v.files.get(INBOX), original, "migration moves the exact original bytes");
    assert.equal(v.files.has(legacy), false);
    restarted.add(highlight("new-after-recovery", "ready"));
    await restarted.flush();
    const saved = JSON.parse(v.files.get(INBOX));
    assert.deepEqual(saved.highlights.map(h => h.id), ["new-after-recovery", "h1"]);
    assert.deepEqual(saved.revisions, history.revisions);
    assert.deepEqual(saved.futureInbox, history.futureInbox);
  } finally { restarted.close(); }
});

test("migration failures at each adapter boundary preserve legacy bytes until a fresh load retries", async t => {
  const legacy = ".obsidian/plugins/recall/inbox.json";
  for (const boundary of ["folder lookup", "folder creation", "destination lookup", "legacy lookup"]) {
    await t.test(boundary, async () => {
      const v = memoryVault({ [legacy]: REAL });
      const adapter = v.app.vault.adapter, { exists, mkdir } = adapter;
      adapter.exists = async path => {
        if ((boundary === "folder lookup" && path === "wiki/_schema") ||
            (boundary === "destination lookup" && path === INBOX) ||
            (boundary === "legacy lookup" && path === legacy)) throw Error(boundary);
        return exists(path);
      };
      adapter.mkdir = async path => {
        if (boundary === "folder creation") throw Error(boundary);
        return mkdir(path);
      };
      const old = new s.InboxStore(v.app, "wiki/_schema", ".obsidian/plugins/recall");
      try {
        await quiet(() => old.load());
        assert.equal(old.readOnly, true);
        old.add(highlight("not-durable", "queued"));
        await old.flush();
        assert.deepEqual([...v.files.entries()], [[legacy, REAL]]);
      } finally { old.close(); Object.assign(adapter, { exists, mkdir }); }
      const restarted = new s.InboxStore(v.app, "wiki/_schema", ".obsidian/plugins/recall");
      try {
        await restarted.load();
        assert.equal(restarted.get("h1").text, "kept");
        assert.equal(restarted.readOnly, false);
        assert.deepEqual([...v.files.entries()], [[INBOX, REAL]]);
      } finally { restarted.close(); }
    });
  }
});

test("a missing legacy inbox still permits first creation", async () => {
  const v = memoryVault({});
  const store = new s.InboxStore(v.app, "wiki/_schema", ".obsidian/plugins/recall");
  try {
    await store.load();
    store.add(highlight("first", "ready"));
    await store.flush();
    assert.equal(store.readOnly, false);
    assert.equal(JSON.parse(v.files.get(INBOX)).highlights[0].id, "first");
  } finally { store.close(); }
});

test("existing destination and recovered backup take precedence without changing legacy history", async t => {
  const legacy = ".obsidian/plugins/recall/inbox.json";
  for (const recovery of [false, true]) await t.test(recovery ? "backup" : "destination", async () => {
    const original = REAL.replace("kept", "legacy");
    const v = memoryVault({ [legacy]: original, [recovery ? `${INBOX}.backup` : INBOX]: REAL });
    const store = new s.InboxStore(v.app, "wiki/_schema", ".obsidian/plugins/recall");
    try {
      await store.load();
      assert.equal(store.get("h1").text, "kept");
      assert.equal(store.readOnly, false);
      assert.equal(v.files.get(legacy), original);
      assert.equal(v.files.get(INBOX), REAL);
      store.touch();
      await store.flush();
      assert.equal(v.files.get(legacy), original);
      assert.equal(JSON.parse(v.files.get(INBOX)).highlights[0].text, "kept");
    } finally { store.close(); }
  });
});

test("first save creates an inbox under the strict no-overwrite adapter", async () => {
  const v = memoryVault({});
  const store = new s.InboxStore(v.app, "wiki/_schema");
  await store.load();
  store.add(highlight("first", "queued"));
  await store.flush();
  assert.equal(JSON.parse(v.files.get(INBOX)).highlights[0].id, "first");
  assert.equal(store.hasUnsavedChanges, false);
  store.close();
});

test("a second save replaces an existing inbox under the strict no-overwrite adapter", async () => {
  const v = vaultWithInbox();
  const store = new s.InboxStore(v.app, "wiki/_schema");
  await store.load();
  store.all()[0].text = "first edit";
  store.touch();
  await store.flush();
  store.all()[0].text = "second edit";
  store.touch();
  await store.flush();
  assert.equal(JSON.parse(v.files.get(INBOX)).highlights[0].text, "second edit");
  assert.equal(store.hasUnsavedChanges, false);
  store.close();
});

const card = (id, status, extra = {}) => ({ id, highlightId: `h-${id}`, kind: "qa", front: "Q?", back: "A", text: "", extra: "", status, edited: false, createdAt: "2026-01-01T00:00:00.000Z", ...extra });
const highlight = (id, status, cards = [], extra = {}) => ({
  id, status, cards, sourcePath: "notes/Study.md", sourceTitle: "Study", text: `Passage ${id}`,
  before: "before", after: "after", line: 23, page: null, heading: "Mechanism", blockId: "block-1",
  title: "Title", instruction: "Focus on mechanism", origin: "selection", error: null,
  createdAt: "2026-01-01T00:00:00.000Z", generatedAt: "2026-01-02T00:00:00.000Z",
  exportedAt: "2026-01-03T00:00:00.000Z", ...extra,
});

test("clear archives completed passages and preserves exact provenance across reload", async () => {
  const exported = highlight("export", "exported", [card("export-card", "exported", { ankiNoteId: 123 })]);
  const dismissed = highlight("dismissed", "dismissed", [card("dismiss-card", "pending")], { sourcePath: "paper.pdf", page: 7, subpath: "page=7&selection=2,3,4,5", origin: "pdf" });
  const partial = highlight("partial", "ready", [card("partial-sent", "exported", { srNote: "cards/sr.md" }), card("partial-draft", "pending")]);
  const queued = highlight("queued", "queued");
  const v = memoryVault({ [INBOX]: JSON.stringify({ version: 1, highlights: [exported, dismissed, partial, queued], highlightInstructions: { "notes/Study.md": "Old setting" } }) });
  const store = new s.InboxStore(v.app, "wiki/_schema");
  await store.load();
  assert.equal(store.clearExported(), 2);
  assert.equal(store.clearExported(), 0);
  assert.deepEqual(store.all().map(h => h.id), ["partial", "queued"]);
  assert.deepEqual(store.counts(), { queued: 1, generating: 0, toReview: 1, flagged: 0, errors: 0 });
  assert.deepEqual(store.allHistory().map(h => h.id), ["export", "dismissed", "partial", "queued"]);
  assert.deepEqual(store.sourceHistory("paper.pdf").map(h => h.id), ["dismissed"]);
  assert.deepEqual(store.get("export"), { ...exported, archived: true });
  assert.equal(store.findCard("export-card").card.ankiNoteId, 123);
  assert.equal(store.hasDuplicate("notes/Study.md", "Passage export"), true);
  await store.flush();
  store.close();
  const disk = JSON.parse(v.files.get(INBOX));
  assert.equal(disk.highlightInstructions["notes/Study.md"], "Old setting");
  assert.deepEqual(disk.highlights[0], { ...exported, archived: true });
  assert.deepEqual(disk.highlights[1], { ...dismissed, archived: true });
  const reloaded = new s.InboxStore(v.app, "wiki/_schema");
  await reloaded.load();
  assert.deepEqual(reloaded.all().map(h => h.id), ["partial", "queued"]);
  assert.deepEqual(reloaded.sourceHistory("paper.pdf")[0], { ...dismissed, archived: true });
  assert.equal(reloaded.findCard("dismiss-card").highlight.id, "dismissed");
  reloaded.close();
});

test("dismissed passages without live cards can be recaptured; completed cards remain duplicate evidence", async () => {
  const empty = highlight("empty", "dismissed", [], { text: "empty" });
  const deleted = highlight("deleted", "dismissed", [card("deleted-card", "deleted")], { text: "deleted" });
  const generated = highlight("generated", "dismissed", [card("generated-card", "pending")], { text: "generated" });
  const v = memoryVault({ [INBOX]: JSON.stringify({ version: 1, highlights: [empty, deleted, generated] }) });
  const store = new s.InboxStore(v.app, "wiki/_schema");
  await store.load();
  store.clearExported();
  assert.equal(store.hasDuplicate("notes/Study.md", "empty"), false);
  assert.equal(store.hasDuplicate("notes/Study.md", "deleted"), false);
  assert.equal(store.hasDuplicate("notes/Study.md", "generated"), true);
  assert.deepEqual(store.sourceHistory("notes/Study.md").map(h => h.id), ["empty", "deleted", "generated"]);
  store.close();
});

test("failed archive persistence reports failure and retains the full snapshot for a later retry", async () => {
  const exported = highlight("export", "exported", [card("c", "exported")]);
  const v = memoryVault({ [INBOX]: JSON.stringify({ version: 1, highlights: [exported] }) });
  const original = v.files.get(INBOX);
  const write = v.app.vault.adapter.write;
  let fail = true;
  v.app.vault.adapter.write = async (p, data) => {
    if (fail) throw new Error("ENOSPC");
    return write(p, data);
  };
  const store = new s.InboxStore(v.app, "wiki/_schema");
  await store.load();
  store.clearExported();
  await quiet(() => assert.rejects(store.flush(), /ENOSPC/));
  assert.equal(store.hasUnsavedChanges, true);
  assert.equal(v.files.get(INBOX), original);
  assert.deepEqual(store.all(), []);
  assert.equal(store.findCard("c").highlight.id, "export");
  fail = false;
  await store.flush();
  assert.equal(store.hasUnsavedChanges, false);
  assert.deepEqual(JSON.parse(v.files.get(INBOX)).highlights, [{ ...exported, archived: true }]);
  store.close();
});

test("read-only storage refuses archiving instead of claiming a durable clear", async () => {
  const v = memoryVault({ [INBOX]: "unreadable" });
  v.app.vault.adapter.read = async () => { throw new Error("locked"); };
  const store = new s.InboxStore(v.app, "wiki/_schema");
  await quiet(() => store.load());
  assert.throws(() => store.clearExported(), /read-only/);
  store.close();
});

test("explicit remove erases one passage while archive retains all cards", async () => {
  const h = highlight("h", "exported", [card("c", "exported")]);
  const v = memoryVault({ [INBOX]: JSON.stringify({ version: 1, highlights: [h] }) });
  const store = new s.InboxStore(v.app, "wiki/_schema");
  await store.load();
  store.clearExported();
  assert.ok(store.findCard("c"));
  store.remove("h");
  assert.equal(store.get("h"), undefined);
  assert.equal(store.findCard("c"), undefined);
  await store.flush();
  assert.deepEqual(JSON.parse(v.files.get(INBOX)).highlights, []);
  store.close();
});

test("legacy exported records stay active until archive and an archived pending record never counts", async () => {
  const legacy = highlight("legacy", "exported", [card("legacy-card", "exported")]);
  const hidden = highlight("hidden", "ready", [card("hidden-card", "pending")], { archived: true });
  const v = memoryVault({ [INBOX]: JSON.stringify({ version: 1, highlights: [legacy, hidden] }) });
  const store = new s.InboxStore(v.app, "wiki/_schema");
  await store.load();
  assert.deepEqual(store.all().map(h => h.id), ["legacy"]);
  assert.equal(store.counts().toReview, 0);
  assert.equal(store.findCard("hidden-card").highlight.id, "hidden");
  assert.equal(store.clearExported(), 1);
  assert.deepEqual(store.all(), []);
  await store.flush();
  assert.deepEqual(JSON.parse(v.files.get(INBOX)).highlights, [{ ...legacy, archived: true }, hidden]);
  store.close();
});

test("an archived no-card passage is not mistaken for generated material", async () => {
  const v = memoryVault({ [INBOX]: JSON.stringify({ version: 1, highlights: [highlight("empty", "exported", [], { text: "uncarded" })] }) });
  const store = new s.InboxStore(v.app, "wiki/_schema");
  await store.load();
  store.clearExported();
  assert.equal(store.hasDuplicate("notes/Study.md", "uncarded"), false);
  assert.deepEqual(store.sourceHistory("notes/Study.md").map(h => h.id), ["empty"]);
  store.close();
});

test("an interrupted write leaves the last good inbox intact for reload and retry", async () => {
  const h = highlight("h", "exported", [card("c", "exported")]);
  const original = JSON.stringify({ version: 1, highlights: [h] });
  const v = memoryVault({ [INBOX]: original });
  const write = v.app.vault.adapter.write;
  let interrupted = true;
  v.app.vault.adapter.write = async (p, data) => {
    if (interrupted) {
      await write(p, data.slice(0, 10));
      throw Error("interrupted");
    }
    return write(p, data);
  };
  const store = new s.InboxStore(v.app, "wiki/_schema");
  await store.load();
  store.clearExported();
  await quiet(() => assert.rejects(store.flush(), /interrupted/));
  assert.equal(v.files.get(INBOX), original, "a partial write cannot replace the only good copy");
  const restored = new s.InboxStore(v.app, "wiki/_schema");
  await restored.load();
  assert.equal(restored.all().length, 1);
  restored.close();
  interrupted = false;
  await store.flush();
  assert.equal(JSON.parse(v.files.get(INBOX)).highlights[0].archived, true);
  store.close();
});

test("commit rename failure restores the old inbox and a later flush retries", async () => {
  const v = vaultWithInbox();
  const store = new s.InboxStore(v.app, "wiki/_schema");
  await store.load();
  store.all()[0].text = "new";
  store.touch();
  const rename = v.app.vault.adapter.rename;
  let fail = true;
  v.app.vault.adapter.rename = async (from, to) => {
    if (fail && from.includes(".pending-") && to === INBOX) throw Error("commit failed");
    return rename(from, to);
  };
  await quiet(() => assert.rejects(store.flush(), /commit failed/));
  assert.equal(v.files.get(INBOX), REAL);
  assert.equal(store.hasUnsavedChanges, true);
  fail = false;
  await store.flush();
  assert.equal(JSON.parse(v.files.get(INBOX)).highlights[0].text, "new");
  assert.equal(v.files.has(`${INBOX}.backup`), false);
  store.close();
});

test("restart restores the last good backup after a crash between renames", async () => {
  const v = memoryVault({ [`${INBOX}.backup`]: REAL, [`${INBOX}.pending-crashed`]: "partial" });
  const store = new s.InboxStore(v.app, "wiki/_schema");
  await store.load();
  assert.equal(v.files.get(INBOX), REAL);
  assert.equal(store.get("h1").text, "kept");
  store.close();
});

test("restart prefers a completed live commit and clears an old backup", async () => {
  const newer = REAL.replace("kept", "committed");
  const v = memoryVault({ [INBOX]: newer, [`${INBOX}.backup`]: REAL });
  const store = new s.InboxStore(v.app, "wiki/_schema");
  await store.load();
  assert.equal(store.get("h1").text, "committed");
  assert.equal(v.files.has(`${INBOX}.backup`), false);
  store.close();
});

test("usable live records win even when the stale backup has malformed records", async () => {
  const badBackup = '{"version":1,"highlights":[null]}';
  const v = memoryVault({ [INBOX]: REAL, [`${INBOX}.backup`]: badBackup });
  const read = v.app.vault.adapter.read;
  let backupReads = 0;
  v.app.vault.adapter.read = async p => {
    if (p === `${INBOX}.backup`) backupReads++;
    return read(p);
  };
  const store = new s.InboxStore(v.app, "wiki/_schema");
  try {
    await store.load();
    assert.equal(store.get("h1").text, "kept");
    assert.equal(store.readOnly, false);
    assert.deepEqual([...v.files.entries()], [[INBOX, REAL]]);
    assert.equal(backupReads, 1, "inspect the backup version before discarding it");
  } finally { store.close(); }
});

test("restart consumes the validated live snapshot instead of rereading after deleting recovery data", async () => {
  const v = memoryVault({ [INBOX]: REAL, [`${INBOX}.backup`]: REAL });
  const read = v.app.vault.adapter.read;
  let liveReads = 0;
  v.app.vault.adapter.read = async p => {
    if (p === INBOX && ++liveReads > 1) throw Error("live file became unavailable after validation");
    return read(p);
  };
  const store = new s.InboxStore(v.app, "wiki/_schema");
  try {
    await quiet(() => store.load());
    assert.equal(store.get("h1")?.text, "kept");
    assert.equal(store.readOnly, false);
    assert.equal(liveReads, 1);
  } finally { store.close(); }
});

test("restart prefers an intentionally empty live inbox over populated backup", async () => {
  const empty = JSON.stringify({ version: 1, highlights: [] });
  const v = memoryVault({ [INBOX]: empty, [`${INBOX}.backup`]: REAL });
  const store = new s.InboxStore(v.app, "wiki/_schema");
  await store.load();
  assert.deepEqual(store.allHistory(), []);
  assert.equal(v.files.get(INBOX), empty);
  assert.equal(v.files.has(`${INBOX}.backup`), false);
  store.close();
});

test("restart restores a good backup when the live inbox is empty", async () => {
  const v = memoryVault({ [INBOX]: "", [`${INBOX}.backup`]: REAL });
  const store = new s.InboxStore(v.app, "wiki/_schema");
  await store.load();
  assert.equal(v.files.get(INBOX), REAL);
  assert.equal(store.get("h1").text, "kept");
  assert.ok([...v.files.entries()].some(([p, contents]) => p.startsWith(`${INBOX}.corrupt-`) && contents === ""));
  store.close();
});

test("restart restores a good backup when the live inbox is whitespace", async () => {
  const whitespace = " \n\t ";
  const v = memoryVault({ [INBOX]: whitespace, [`${INBOX}.backup`]: REAL });
  const store = new s.InboxStore(v.app, "wiki/_schema");
  await store.load();
  assert.equal(v.files.get(INBOX), REAL);
  assert.equal(store.get("h1").text, "kept");
  assert.ok([...v.files.entries()].some(([p, contents]) => p.startsWith(`${INBOX}.corrupt-`) && contents === whitespace));
  store.close();
});

test("restart recovers usable records before discarding a populated backup", async () => {
  const damaged = '{"version":1,"highlights":[null]}';
  const good = JSON.stringify({ version: 1, highlights: [highlight("recovered", "generating", [card("saved", "pending")])] });
  const v = memoryVault({ [INBOX]: damaged, [`${INBOX}.backup`]: good });
  const store = new s.InboxStore(v.app, "wiki/_schema");
  try {
    await assert.doesNotReject(store.load());
    assert.equal(v.files.get(INBOX), good, "the last usable snapshot becomes the live inbox");
    assert.ok([...v.files.entries()].some(([p, raw]) => p.startsWith(`${INBOX}.corrupt-`) && raw === damaged), "damaged live bytes survive recovery");
    assert.equal(store.get("recovered").status, "queued");
    assert.equal(store.findCard("saved").card.back, "A");
    assert.equal(store.counts().queued, 1);
    store.touch();
    await store.flush();
    assert.equal(JSON.parse(v.files.get(INBOX)).highlights[0].cards[0].id, "saved", "a later save cannot replace recovery data with an empty inbox");
  } finally {
    store.close();
  }
});

test("restart rejects a malformed nested card without consuming the good backup", async () => {
  const damaged = JSON.stringify({ version: 1, highlights: [highlight("broken", "ready", [null])] });
  const good = JSON.stringify({ version: 1, highlights: [highlight("saved", "ready", [card("saved-card", "pending")])] });
  const v = memoryVault({ [INBOX]: damaged, [`${INBOX}.backup`]: good });
  const store = new s.InboxStore(v.app, "wiki/_schema");
  try {
    await store.load();
    assert.equal(v.files.get(INBOX), good);
    assert.ok([...v.files.entries()].some(([p, raw]) => p.startsWith(`${INBOX}.corrupt-`) && raw === damaged));
    assert.equal(store.findCard("saved-card").card.status, "pending");
  } finally { store.close(); }
});

test("restart recovers from a damaged live inbox when a good backup exists", async () => {
  const v = memoryVault({ [INBOX]: "partial", [`${INBOX}.backup`]: REAL });
  const store = new s.InboxStore(v.app, "wiki/_schema");
  await store.load();
  assert.equal(v.files.get(INBOX), REAL);
  assert.equal(store.get("h1").text, "kept");
  assert.ok([...v.files.keys()].some(p => p.startsWith(`${INBOX}.corrupt-`)));
  store.close();
});

test("unusable live records without a usable backup remain read-only and untouched", async () => {
  const damaged = JSON.stringify({ version: 1, highlights: [highlight("broken", "ready", [null])] });
  const v = memoryVault({ [INBOX]: damaged });
  const store = new s.InboxStore(v.app, "wiki/_schema");
  try {
    await quiet(() => store.load());
    assert.equal(store.readOnly, true);
    store.add(highlight("new", "queued"));
    await store.flush();
    assert.deepEqual([...v.files.entries()], [[INBOX, damaged]], "uncertain records cannot become an empty writable store");
  } finally { store.close(); }
});

test("unusable live and backup records preserve both files read-only", async () => {
  const damaged = JSON.stringify({ version: 1, highlights: [highlight("broken", "ready", [null])] });
  const badBackup = '{"version":1,"highlights":[null]}';
  const initial = { [INBOX]: damaged, [`${INBOX}.backup`]: badBackup };
  const v = memoryVault(initial);
  const store = new s.InboxStore(v.app, "wiki/_schema");
  try {
    await quiet(() => store.load());
    assert.equal(store.readOnly, true);
    store.add(highlight("new", "queued"));
    await store.flush();
    assert.deepEqual([...v.files.entries()], Object.entries(initial));
  } finally { store.close(); }
});

test("missing live with unusable backup records cannot create a writable empty inbox", async () => {
  const badBackup = '{"version":1,"highlights":[null]}';
  const v = memoryVault({ [`${INBOX}.backup`]: badBackup });
  const store = new s.InboxStore(v.app, "wiki/_schema");
  try {
    await quiet(() => store.load());
    assert.equal(store.readOnly, true);
    store.add(highlight("new", "queued"));
    await store.flush();
    assert.deepEqual([...v.files.entries()], [[`${INBOX}.backup`, badBackup]]);
  } finally { store.close(); }
});

test("legacy and unknown fields survive backup recovery and a save without invented defaults", async () => {
  const legacyCard = { id: "legacy-card", kind: "cloze", status: "exported", front: "", back: "", text: "{{c1::kept}}", extra: "", futureCard: { kept: true } };
  const legacy = {
    ...JSON.parse(REAL), futureInbox: ["preserved"],
    transcripts: { "a.md": { text: "transcript", origin: "pasted", sourceFile: null, addedAt: "now", truncated: false, futureTranscript: 7 } },
    highlightInstructions: { "a.md": "instructions" }, ingested: { "a.md": "legacy-hash" },
  };
  Object.assign(legacy.highlights[0], {
    cards: [legacyCard], topicPath: "old/topic.md", futureHighlight: { notes: ["kept"] },
    generation: { version: 1, id: "old-batch", instruction: "", inputKey: "", phase: "preparing", futureBatch: "kept" },
  });
  const good = JSON.stringify(legacy);
  const damaged = '{"version":1,"highlights":[null]}';
  const v = memoryVault({ [INBOX]: damaged, [`${INBOX}.backup`]: good });
  const store = new s.InboxStore(v.app, "wiki/_schema");
  try {
    await store.load();
    assert.deepEqual(store.get("h1"), legacy.highlights[0]);
    assert.equal(Object.hasOwn(store.get("h1"), "archived"), false);
    assert.equal(store.getTranscript("a.md").text, "transcript");
    store.touch();
    await store.flush();
    assert.deepEqual(JSON.parse(v.files.get(INBOX)), legacy);
    assert.ok([...v.files.entries()].some(([p, raw]) => p.startsWith(`${INBOX}.corrupt-`) && raw === damaged));
  } finally { store.close(); }
});

test("failed recovery operations retain every original byte and block later writes", async (t) => {
  const damaged = '{"version":1,"highlights":[null]}';
  const backup = `${INBOX}.backup`;
  for (const boundary of ["live read", "backup read", "preserve rename", "restore rename", "missing live rename", "backup remove"]) {
    await t.test(boundary, async () => {
      const live = boundary === "backup remove" ? REAL.replace("kept", "newer") : damaged;
      const initial = { ...(boundary === "missing live rename" ? {} : { [INBOX]: live }), [backup]: REAL };
      const v = memoryVault(initial);
      const adapter = v.app.vault.adapter;
      const { read, rename, remove } = adapter;
      adapter.read = async p => {
        if ((boundary === "live read" && p === INBOX) || (boundary === "backup read" && p === backup)) throw Error(boundary);
        return read(p);
      };
      adapter.rename = async (from, to) => {
        if ((boundary === "preserve rename" && from === INBOX) ||
            (["restore rename", "missing live rename"].includes(boundary) && from === backup)) throw Error(boundary);
        return rename(from, to);
      };
      adapter.remove = async p => {
        if (boundary === "backup remove" && p === backup) throw Error(boundary);
        return remove(p);
      };
      const store = new s.InboxStore(v.app, "wiki/_schema");
      try {
        await quiet(() => store.load());
        assert.equal(store.readOnly, true);
        for (const raw of Object.values(initial)) assert.ok([...v.files.values()].includes(raw), "each original survives at its live, backup, or preserved path");
        assert.equal(v.files.get(backup), REAL);
        const afterLoad = [...v.files.entries()];
        store.add(highlight("must-not-persist", "queued"));
        await store.flush();
        assert.deepEqual([...v.files.entries()], afterLoad);
        // Once the failed operation is available again, restart can recover.
        Object.assign(adapter, { read, rename, remove });
        const restarted = new s.InboxStore(v.app, "wiki/_schema");
        try {
          await restarted.load();
          assert.equal(restarted.get("h1").text, boundary === "backup remove" ? "newer" : "kept");
          assert.equal(restarted.readOnly, false);
        } finally { restarted.close(); }
      } finally { store.close(); }
    });
  }
});

test("unrecoverable backup makes the store read-only instead of overwriting it", async () => {
  const v = memoryVault({ [`${INBOX}.backup`]: "partial" });
  const store = new s.InboxStore(v.app, "wiki/_schema");
  await quiet(() => store.load());
  store.touch();
  await store.flush();
  assert.equal(v.files.has(INBOX), false);
  assert.equal(v.files.get(`${INBOX}.backup`), "partial");
  store.close();
});

test("blank backup without a live inbox stays read-only and untouched", async () => {
  const v = memoryVault({ [`${INBOX}.backup`]: " \n" });
  const store = new s.InboxStore(v.app, "wiki/_schema");
  await quiet(() => store.load());
  assert.equal(store.readOnly, true);
  store.touch();
  await store.flush();
  assert.equal(v.files.has(INBOX), false);
  assert.equal(v.files.get(`${INBOX}.backup`), " \n");
  store.close();
});

test("blank backup with corrupt live inbox preserves both and stays read-only", async () => {
  const v = memoryVault({ [INBOX]: "partial", [`${INBOX}.backup`]: "" });
  const store = new s.InboxStore(v.app, "wiki/_schema");
  await quiet(() => store.load());
  assert.equal(store.readOnly, true);
  store.touch();
  await store.flush();
  assert.equal(v.files.get(INBOX), "partial");
  assert.equal(v.files.get(`${INBOX}.backup`), "");
  store.close();
});

test("both blank inbox and backup stay untouched and read-only", async () => {
  const v = memoryVault({ [INBOX]: "", [`${INBOX}.backup`]: " \t" });
  const store = new s.InboxStore(v.app, "wiki/_schema");
  await quiet(() => store.load());
  assert.equal(store.readOnly, true);
  store.touch();
  await store.flush();
  assert.equal(v.files.get(INBOX), "");
  assert.equal(v.files.get(`${INBOX}.backup`), " \t");
  store.close();
});

test("legacy blank inbox without backup still loads as fresh", async () => {
  const v = memoryVault({ [INBOX]: "" });
  const store = new s.InboxStore(v.app, "wiki/_schema");
  await store.load();
  assert.deepEqual(store.allHistory(), []);
  assert.equal(store.readOnly, false);
  store.add(highlight("first", "queued"));
  await store.flush();
  assert.equal(JSON.parse(v.files.get(INBOX)).highlights[0].id, "first");
  store.close();
});

test("closing with a queued flush prevents its stale snapshot from committing", async () => {
  const v = vaultWithInbox();
  let release;
  const write = v.app.vault.adapter.write;
  v.app.vault.adapter.write = async (p, data) => {
    if (data.includes('"first"')) await new Promise(resolve => { release = resolve; });
    return write(p, data);
  };
  const old = new s.InboxStore(v.app, "wiki/_schema");
  await old.load();
  old.all()[0].text = "first";
  old.touch();
  const first = old.flush();
  await new Promise(resolve => setImmediate(resolve));
  old.all()[0].text = "queued";
  old.touch();
  const second = old.flush();
  old.close();
  const fresh = new s.InboxStore(v.app, "wiki/_schema");
  let loaded = false;
  const loading = fresh.load().then(() => { loaded = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loaded, false, "successor waits for the previous owner’s staging write");
  release();
  await Promise.all([first, second, loading]);
  fresh.all()[0].text = "replacement";
  fresh.touch();
  await fresh.flush();
  assert.equal(JSON.parse(v.files.get(INBOX)).highlights[0].text, "replacement");
  assert.equal(old.hasUnsavedChanges, true);
  assert.equal([...v.files.keys()].some(p => p.includes(".pending-")), false);
  fresh.close();
});

test("failed commit and failed immediate rollback remain recoverable on reload", async () => {
  const v = vaultWithInbox();
  const store = new s.InboxStore(v.app, "wiki/_schema");
  await store.load();
  store.all()[0].text = "new";
  store.touch();
  const rename = v.app.vault.adapter.rename;
  v.app.vault.adapter.rename = async (from, to) => {
    if (to === INBOX) throw Error("rename unavailable");
    return rename(from, to);
  };
  await quiet(() => assert.rejects(store.flush(), /rename unavailable/));
  assert.equal(store.hasUnsavedChanges, true);
  assert.equal(v.files.has(INBOX), false);
  assert.equal(v.files.get(`${INBOX}.backup`), REAL);
  store.close();
  v.app.vault.adapter.rename = rename;
  const reloaded = new s.InboxStore(v.app, "wiki/_schema");
  await reloaded.load();
  assert.equal(reloaded.get("h1").text, "kept");
  reloaded.close();
});

test("close during the backup rename does not commit the old snapshot", async () => {
  const v = vaultWithInbox();
  const rename = v.app.vault.adapter.rename;
  let release;
  let entered;
  const atRename = new Promise(resolve => { entered = resolve; });
  v.app.vault.adapter.rename = async (from, to) => {
    if (from === INBOX && to === `${INBOX}.backup`) {
      entered();
      await new Promise(resolve => { release = resolve; });
    }
    return rename(from, to);
  };
  const old = new s.InboxStore(v.app, "wiki/_schema");
  await old.load();
  old.all()[0].text = "old attempt";
  old.touch();
  const pending = old.flush();
  await atRename;
  old.close();
  release();
  await pending;
  assert.equal(v.files.get(INBOX), REAL);
  assert.equal(old.hasUnsavedChanges, true);
  assert.equal(v.files.has(`${INBOX}.backup`), false);
});
