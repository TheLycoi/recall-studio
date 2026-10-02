// Run with: npm test. Bundles src/store.ts, the inbox store, through the same
// esbuild options the plugin build uses. `obsidian` is replaced by a stub
// whose Notice records its message; the vault is the in-memory one in
// test/memoryVault.mjs. Each test is a way the store could write over the
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
import { memoryVault } from "./memoryVault.mjs";

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
      contents: ['export * from "./src/store.ts";', 'export { TFile, TFolder, notices } from "obsidian";'].join("\n"),
      resolveDir: ROOT,
      sourcefile: "store-probe.ts",
      loader: "ts",
    },
    outfile: out,
    logLevel: "error",
    external: shared.external.filter((e) => e !== "obsidian"),
    plugins: [obsidianStub(), ...shared.plugins],
  });
  s = createRequire(import.meta.url)(out);
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A memory vault holding a real inbox, with every adapter write counted. */
function vaultWithInbox() {
  const v = memoryVault({ [INBOX]: REAL }, s);
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
