// Run with: npm test  (bundles src/digestGate.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let dg;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wikilm-gate-"));
  const out = path.join(dir, "digestGate.mjs");
  await build({ entryPoints: ["src/digestGate.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  dg = await import(pathToFileURL(out).href);
});

const row = (text, over = {}) => ({
  id: "H01",
  key: "page=1&selection=0,0,0,4",
  page: 1,
  kind: "selection",
  color: "yellow",
  target: { page: 1, selection: { beginIndex: 0, beginOffset: 0, endIndex: 0, endOffset: 4 } },
  text,
  before: "",
  after: "",
  origins: [],
  ...over,
});

test("no highlights at all offers", () => {
  assert.deepEqual(dg.decideGate({ highlights: [] }), { action: "offer", usable: 0, total: 0 });
});

test("highlights with empty text only offer", () => {
  assert.deepEqual(dg.decideGate({ highlights: [row(""), row("   ")] }), { action: "offer", usable: 0, total: 2 });
});

test("one usable highlight digests", () => {
  assert.deepEqual(dg.decideGate({ highlights: [row("Receptors bind ligands.")] }), { action: "digest", usable: 1, total: 1 });
});

test("a rect-only highlight is real for merging but not for the gate", () => {
  const rect = row("", { kind: "rect", key: "page=2&rect=1,2,3,4", target: { page: 2, rect: [1, 2, 3, 4] }, color: null });
  assert.equal(dg.decideGate({ highlights: [rect] }).action, "offer");
});

test("a rect beside a text highlight digests, counting only the text", () => {
  const rect = row("", { kind: "rect", key: "page=2&rect=1,2,3,4", target: { page: 2, rect: [1, 2, 3, 4] }, color: null });
  assert.deepEqual(dg.decideGate({ highlights: [rect, row("A fact.")] }), { action: "digest", usable: 1, total: 2 });
});
