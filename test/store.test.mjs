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
const REAL = JSON.stringify({ highlights: [{ id: "h1", text: "kept", status: "ready", cards: [] }] }, null, 2);

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

test("restart recovers from a damaged live inbox when a good backup exists", async () => {
  const v = memoryVault({ [INBOX]: "partial", [`${INBOX}.backup`]: REAL });
  const store = new s.InboxStore(v.app, "wiki/_schema");
  await store.load();
  assert.equal(v.files.get(INBOX), REAL);
  assert.equal(store.get("h1").text, "kept");
  assert.ok([...v.files.keys()].some(p => p.startsWith(`${INBOX}.corrupt-`)));
  store.close();
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
  await fresh.load();
  fresh.all()[0].text = "replacement";
  fresh.touch();
  await fresh.flush();
  release();
  await Promise.all([first, second]);
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
