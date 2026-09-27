// Run with: npm test  (bundles src/relevance.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let r;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
  const out = path.join(dir, "relevance.mjs");
  await build({ entryPoints: ["src/relevance.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  r = await import(pathToFileURL(out).href);
});

// The candidates are opaque to applyRelevance: it moves them by position, so a
// bare string is enough to show which one came back and in what order.
const ABC = ["a", "b", "c"];

test("the kept candidates come back in the model's order, not the retriever's", () => {
  const got = r.applyRelevance(ABC, { relevant: [2, 1] }, 6);
  assert.deepEqual(got.kept, ["b", "a"]);
  assert.equal(got.dropped, 1);
  assert.equal(got.invalid, 0);
});

test("an empty verdict drops everything and is not an error", () => {
  const got = r.applyRelevance(ABC, { relevant: [] }, 6);
  assert.deepEqual(got.kept, []);
  assert.equal(got.dropped, 3, "all three candidates were dropped");
  assert.equal(got.invalid, 0, "naming nothing is a verdict, not a malformed number");
});

test("a repeated number is kept once and is not counted invalid", () => {
  const got = r.applyRelevance(["a", "b"], { relevant: [1, 1, 2] }, 6);
  assert.deepEqual(got.kept, ["a", "b"]);
  assert.equal(got.dropped, 0);
  assert.equal(got.invalid, 0);
});

test("zero, out of range and fractional numbers are counted invalid and skipped", () => {
  const got = r.applyRelevance(ABC, { relevant: [0, 4, 2.5, 1] }, 6);
  assert.deepEqual(got.kept, ["a"]);
  assert.equal(got.dropped, 2, "dropped counts the candidates no kept slot took");
  assert.equal(got.invalid, 3);
});

test("k caps the kept list, and the candidates past the cap count as dropped", () => {
  const got = r.applyRelevance(ABC, { relevant: [3, 2, 1] }, 2);
  assert.deepEqual(got.kept, ["c", "b"]);
  assert.equal(got.dropped, 1);
  assert.equal(got.invalid, 0);
});

test("a number against an empty candidate list is invalid, with nothing to drop", () => {
  const got = r.applyRelevance([], { relevant: [1] }, 6);
  assert.deepEqual(got.kept, []);
  assert.equal(got.dropped, 0);
  assert.equal(got.invalid, 1);
});

test("the input array is not mutated", () => {
  const candidates = ["a", "b", "c"];
  r.applyRelevance(candidates, { relevant: [3, 1] }, 6);
  assert.deepEqual(candidates, ["a", "b", "c"], "the caller's pool survives the filter");
});

test("RELEVANCE_MIN_CANDIDATES is the gate below which the caller skips the call", () => {
  assert.equal(r.RELEVANCE_MIN_CANDIDATES, 3);
});
