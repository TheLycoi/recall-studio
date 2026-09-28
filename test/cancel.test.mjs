// Run with: npm test  (bundles src/cancel.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let c;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wikilm-cancel-"));
  const out = path.join(dir, "cancel.mjs");
  await build({ entryPoints: ["src/cancel.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  c = await import(pathToFileURL(out).href);
});

test("a token is idle until a run begins, and cancelling an idle token does nothing", () => {
  const t = new c.CancelToken();
  assert.equal(t.active, false);
  t.cancel();
  assert.equal(t.cancelled, false, "nothing was running, so nothing is cancelled");
});

test("begin, progress, cancel, end", () => {
  const t = new c.CancelToken();
  const seen = [];
  t.onChange(() => seen.push([t.active, t.cancelled, t.label]));
  const owner = t.begin("highlighting Deck");
  t.progress("pages 1–8 of 20", owner);
  assert.equal(t.label, "pages 1–8 of 20");
  t.cancel();
  assert.equal(t.cancelled, true);
  assert.equal(t.active, true, "a cancelled run is still the run until it ends");
  t.end(owner);
  assert.equal(t.active, false);
  assert.equal(t.cancelled, false, "end clears the request so the next run starts clean");
  assert.equal(t.label, "");
  assert.equal(seen.length, 4);
});

test("unsubscribing stops the listener", () => {
  const t = new c.CancelToken();
  let n = 0;
  const off = t.onChange(() => n++);
  const owner = t.begin("x");
  off();
  t.end(owner);
  assert.equal(n, 1);
});

test("an end or a progress from a run that no longer owns the token does nothing", () => {
  const t = new c.CancelToken();
  const lint = t.begin("model review of the wiki");
  // Something took the token over while lint was still running.
  const folder = t.begin("ingesting Notes");
  assert.notEqual(lint, folder);
  t.progress("stale label", lint);
  assert.equal(t.label, "ingesting Notes", "a stale owner cannot relabel the run");
  t.end(lint);
  assert.equal(t.active, true, "lint's finally must not end the folder run");
  assert.equal(t.label, "ingesting Notes");
  t.progress("3/9 Notes", folder);
  assert.equal(t.label, "3/9 Notes");
  t.end(folder);
  assert.equal(t.active, false, "the current owner's end still ends the run");
});

test("an end with no owner at all is a no-op, and cancel still stops whoever owns the token", () => {
  const t = new c.CancelToken();
  const owner = t.begin("reading Deck");
  t.end(undefined);
  assert.equal(t.active, true);
  t.cancel();
  assert.equal(t.cancelled, true, "cancel is the reader's, not an owner's, so it needs no id");
  t.end(owner);
  assert.equal(t.cancelled, false);
  // An owner that has already ended cannot end the next run.
  const next = t.begin("reading Deck 2");
  t.end(owner);
  assert.equal(t.active, true);
  t.end(next);
  assert.equal(t.active, false);
});
