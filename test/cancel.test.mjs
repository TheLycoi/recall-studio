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
  t.begin("highlighting Deck");
  t.progress("pages 1–8 of 20");
  assert.equal(t.label, "pages 1–8 of 20");
  t.cancel();
  assert.equal(t.cancelled, true);
  assert.equal(t.active, true, "a cancelled run is still the run until it ends");
  t.end();
  assert.equal(t.active, false);
  assert.equal(t.cancelled, false, "end clears the request so the next run starts clean");
  assert.equal(t.label, "");
  assert.equal(seen.length, 4);
});

test("unsubscribing stops the listener", () => {
  const t = new c.CancelToken();
  let n = 0;
  const off = t.onChange(() => n++);
  t.begin("x");
  off();
  t.end();
  assert.equal(n, 1);
});
