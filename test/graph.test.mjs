// Run with: npm test  (bundles src/graph.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let g;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-graph-"));
  const out = path.join(dir, "graph.mjs");
  await build({ entryPoints: ["src/graph.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  g = await import(pathToFileURL(out).href);
});

/** A deterministic PRNG so a walk-based test cannot flake. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test("buildGraph resolves a link by basename, the way Obsidian does", () => {
  const graph = g.buildGraph([
    { path: "wiki/concepts/Pharmacology.md", content: "See [[Pharmacokinetics]] for more." },
    { path: "wiki/concepts/Pharmacokinetics.md", content: "What the body does to drugs." },
  ]);
  assert.deepEqual(graph.edges.get("wiki/concepts/Pharmacology.md"), ["wiki/concepts/Pharmacokinetics.md"]);
  assert.deepEqual(graph.edges.get("wiki/concepts/Pharmacokinetics.md"), []);
});

test("buildGraph ignores embeds, PDFs and self-links", () => {
  const graph = g.buildGraph([
    {
      path: "a.md",
      content: "![[Lecture.pdf#page=2]]\n![[Recording.m4a]]\n![[b]]\n[[a]]\n[[b]]",
    },
    { path: "b.md", content: "" },
  ]);
  // The embed `![[b]]` is a transclusion, not a link; `[[a]]` is a self-link.
  assert.deepEqual(graph.edges.get("a.md"), ["b.md"]);
});

test("buildGraph drops links to notes that do not exist", () => {
  const graph = g.buildGraph([{ path: "a.md", content: "[[Nonexistent Note]]" }]);
  assert.deepEqual(graph.edges.get("a.md"), []);
});

test("buildGraph keeps a link written with display text or a heading", () => {
  const graph = g.buildGraph([
    { path: "a.md", content: "[[b#Dosing|see dosing]]" },
    { path: "b.md", content: "" },
  ]);
  assert.deepEqual(graph.edges.get("a.md"), ["b.md"]);
});

test("personalizedPageRank reaches a neighbour and ranks the seed highest", () => {
  const graph = g.buildGraph([
    { path: "a.md", content: "[[b]]" },
    { path: "b.md", content: "[[c]]" },
    { path: "c.md", content: "" },
  ]);
  const scores = g.personalizedPageRank(graph, "a.md", { numWalks: 200, maxSteps: 8, rng: seeded(7) });
  assert.ok(scores.get("a.md") > 0);
  assert.ok(scores.get("b.md") > 0, "a direct neighbour must be reached");
  // Mass decays with distance: the seed outranks its neighbour, which outranks
  // the note two hops away.
  assert.ok(scores.get("a.md") > scores.get("b.md"));
  assert.ok(scores.get("b.md") > scores.get("c.md"));
});

test("personalizedPageRank on an isolated note keeps all mass on the seed", () => {
  const graph = g.buildGraph([{ path: "a.md", content: "" }, { path: "b.md", content: "" }]);
  const scores = g.personalizedPageRank(graph, "a.md", { numWalks: 50, maxSteps: 5, rng: seeded(3) });
  assert.equal(scores.get("a.md"), 1);
  assert.equal(scores.get("b.md"), undefined);
});

test("personalizedPageRank returns nothing for a seed outside the graph", () => {
  const graph = g.buildGraph([{ path: "a.md", content: "" }]);
  assert.equal(g.personalizedPageRank(graph, "missing.md").size, 0);
});

test("pprFromSeeds keeps each note's best score across seeds", () => {
  const graph = g.buildGraph([
    { path: "a.md", content: "[[shared]]" },
    { path: "b.md", content: "[[shared]]" },
    { path: "shared.md", content: "" },
  ]);
  const one = g.personalizedPageRank(graph, "a.md", { numWalks: 200, maxSteps: 6, rng: seeded(11) });
  const both = g.pprFromSeeds(graph, ["a.md", "b.md"], { numWalks: 200, maxSteps: 6, rng: seeded(11) });
  assert.ok(both.get("shared.md") >= one.get("shared.md"));
});

test("isGraphUsable refuses a wiki with too few links to walk", () => {
  const bare = g.buildGraph([
    { path: "a.md", content: "" },
    { path: "b.md", content: "" },
    { path: "c.md", content: "" },
    { path: "d.md", content: "" },
  ]);
  assert.equal(g.isGraphUsable(bare), false);

  const linked = g.buildGraph(
    ["a", "b", "c", "d", "e"].map((n) => ({ path: `${n}.md`, content: "[[a]] [[b]] [[c]] [[d]] [[e]]" })),
  );
  assert.equal(g.isGraphUsable(linked), true);
});
