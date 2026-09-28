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

// ---- narrowEvidence: what the judge did, as a state the panel can label (A9, A20) ----

const POOL = ["a", "b", "c", "d", "e", "f", "g", "h"];

test("narrowEvidence keeps the named candidates", () => {
  assert.deepEqual(r.narrowEvidence(POOL, { relevant: [3, 1] }, 6), { evidence: ["c", "a"], state: "kept", before: 8 });
});

test("narrowEvidence with an empty verdict keeps nothing", () => {
  assert.deepEqual(r.narrowEvidence(POOL, { relevant: [] }, 6), { evidence: [], state: "nothing", before: 8 });
});

test("narrowEvidence skips a pool too small to narrow and takes the first k", () => {
  assert.deepEqual(r.narrowEvidence(["a", "b"], { relevant: [] }, 1), { evidence: ["a"], state: "skipped", before: 2 });
  assert.deepEqual(r.narrowEvidence(["a", "b"], new Error("x"), 6), { evidence: ["a", "b"], state: "skipped", before: 2 });
});

test("narrowEvidence on a judge error falls back to the first k", () => {
  assert.deepEqual(r.narrowEvidence(POOL, new Error("timeout"), 3), { evidence: ["a", "b", "c"], state: "failed", before: 8 });
});

test("narrowEvidence treats a verdict of only bad numbers as a failure, not as nothing relevant", () => {
  assert.deepEqual(r.narrowEvidence(POOL, { relevant: [0, 99, 2.5] }, 3), { evidence: ["a", "b", "c"], state: "failed", before: 8 });
  // One good number among bad ones is still a verdict.
  assert.deepEqual(r.narrowEvidence(POOL, { relevant: [99, 2] }, 3), { evidence: ["b"], state: "kept", before: 8 });
});

test("describeNarrowing labels each state for the route line", () => {
  assert.equal(r.describeNarrowing({ evidence: ["a"], state: "skipped", before: 2 }), "");
  assert.equal(r.describeNarrowing({ evidence: ["a", "b", "c"], state: "kept", before: 3 }), "");
  assert.equal(r.describeNarrowing({ evidence: [], state: "nothing", before: 14 }), "14 found, none relevant");
  assert.equal(r.describeNarrowing({ evidence: ["a", "b"], state: "kept", before: 30 }), "30 → 2 kept");
  assert.equal(r.describeNarrowing({ evidence: ["a", "b", "c", "d", "e", "f"], state: "failed", before: 30 }), "judge failed, top 6 of 30");
  // A failure is named even when the fallback happened to keep the whole pool.
  assert.equal(r.describeNarrowing({ evidence: ["a", "b", "c", "d"], state: "failed", before: 4 }), "judge failed, top 4 of 4");
});

// ---- narrowEvidence fallback: the retriever's per-note cap survives (A20) ----

const unit = (notePath, id) => ({ notePath, id });
const pathOf = (c) => c.notePath;

test("a failed judge's fallback takes at most ceil(k/2) from one note", () => {
  const pool = [1, 2, 3, 4, 5, 6].map((i) => unit("A.md", `a${i}`));
  const out = r.narrowEvidence(pool, new Error("timeout"), 4, pathOf);
  assert.deepEqual(out.evidence.map((c) => c.id), ["a1", "a2"]);
  assert.equal(out.state, "failed");
  assert.equal(out.before, 6);
});

test("the fallback keeps the retriever's order and applies the cap across mixed notes", () => {
  const pool = [unit("A.md", "a1"), unit("A.md", "a2"), unit("A.md", "a3"), unit("B.md", "b1"), unit("C.md", "c1")];
  // A verdict of only bad numbers is a failure too, and falls back the same way.
  const out = r.narrowEvidence(pool, { relevant: [0, 99] }, 4, pathOf);
  assert.deepEqual(out.evidence.map((c) => c.id), ["a1", "a2", "b1", "c1"]);
  assert.equal(out.state, "failed");
});

test("a skipped pool's fallback applies the cap and keeps the order", () => {
  const same = r.narrowEvidence([unit("A.md", "a1"), unit("A.md", "a2")], { relevant: [] }, 2, pathOf);
  assert.deepEqual(same.evidence.map((c) => c.id), ["a1"]);
  assert.equal(same.state, "skipped");
  const mixed = r.narrowEvidence([unit("B.md", "b1"), unit("A.md", "a1")], new Error("x"), 2, pathOf);
  assert.deepEqual(mixed.evidence.map((c) => c.id), ["b1", "a1"]);
  assert.equal(mixed.state, "skipped");
});

test("the judge's own choice is not capped: kept stands as named", () => {
  const pool = [1, 2, 3, 4, 5, 6].map((i) => unit("A.md", `a${i}`));
  const out = r.narrowEvidence(pool, { relevant: [1, 2, 3, 4] }, 4, pathOf);
  assert.deepEqual(out.evidence.map((c) => c.id), ["a1", "a2", "a3", "a4"]);
  assert.equal(out.state, "kept");
});

test("without notePathOf the fallback is still the plain first k", () => {
  const pool = [1, 2, 3, 4, 5, 6].map((i) => unit("A.md", `a${i}`));
  assert.deepEqual(r.narrowEvidence(pool, new Error("timeout"), 4).evidence.map((c) => c.id), ["a1", "a2", "a3", "a4"]);
});
