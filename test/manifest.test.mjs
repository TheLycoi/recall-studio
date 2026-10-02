// Run with: npm test  (bundles src/manifest.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let mf;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wikilm-test-"));
  const out = path.join(dir, "manifest.mjs");
  await build({ entryPoints: ["src/manifest.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  mf = await import(pathToFileURL(out).href);
});

function selectionHighlight(overrides = {}) {
  return {
    id: "H00",
    key: "page=4&selection=2,0,33,19",
    page: 4,
    kind: "selection",
    color: "yellow",
    target: { page: 4, selection: { beginIndex: 2, beginOffset: 0, endIndex: 33, endOffset: 19 }, color: "yellow" },
    text: "Receptors have 2 important properties",
    before: "Drug–Receptor Interactions",
    after: "Agonists activate receptors",
    origins: ["classes/BIO101/Pharmacology.md"],
    ...overrides,
  };
}

test("MANIFEST_CONTEXT_CHARS is 150", () => {
  assert.equal(mf.MANIFEST_CONTEXT_CHARS, 150);
});

test("sortAndAssignIds orders by page then selection position, zero-padded ids", () => {
  const a = selectionHighlight({
    key: "page=5&selection=10,0,12,8",
    page: 5,
    target: { page: 5, selection: { beginIndex: 10, beginOffset: 0, endIndex: 12, endOffset: 8 }, color: "yellow" },
  });
  const b = selectionHighlight({
    key: "page=4&selection=6,0,34,23",
    page: 4,
    target: { page: 4, selection: { beginIndex: 6, beginOffset: 0, endIndex: 34, endOffset: 23 }, color: "yellow" },
  });
  const c = selectionHighlight(); // page 4, beginIndex 2 -> sorts before b on the same page
  const sorted = mf.sortAndAssignIds([a, b, c]);
  assert.deepEqual(
    sorted.map((h) => h.key),
    [c.key, b.key, a.key],
  );
  assert.deepEqual(
    sorted.map((h) => h.id),
    ["H01", "H02", "H03"],
  );
});

test("mergeHighlights collapses two entries with the same key", () => {
  const a = selectionHighlight({ text: "", origins: ["classes/BIO101/Pharmacology.md"] });
  const b = selectionHighlight({ text: "Receptors have 2 important properties", origins: ["classes/BIO101/Pharmacokinetics.md"] });
  const merged = mf.mergeHighlights([a, b]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].key, a.key);
  assert.equal(merged[0].text, "Receptors have 2 important properties");
  assert.deepEqual(
    merged[0].origins.slice().sort(),
    ["classes/BIO101/Pharmacokinetics.md", "classes/BIO101/Pharmacology.md"],
  );
});

test("mergeHighlights collapses a selection and an annotation on the same page with equal text", () => {
  const selection = selectionHighlight({
    key: "page=2&selection=1,0,5,0",
    page: 2,
    kind: "selection",
    color: "255,208,0",
    target: { page: 2, selection: { beginIndex: 1, beginOffset: 0, endIndex: 5, endOffset: 0 }, color: "255,208,0" },
    text: "Pharmacology is the study of drugs",
    origins: ["classes/BIO101/Pharmacology.md"],
  });
  const annotation = selectionHighlight({
    key: "page=2&annotation=846R",
    page: 2,
    kind: "annotation",
    color: "255,208,0",
    // Annotation links never carry &color= (see the plan's manifest example:
    // the H01 link is #page=2&annotation=846R with no color, even though the
    // callout header and the color:: field both say 255,208,0).
    target: { page: 2, annotation: "846R" },
    text: "Pharmacology is the study of drugs",
    origins: ["pdf annotation"],
  });

  const merged = mf.mergeHighlights([selection, annotation]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].key, "page=2&annotation=846R");
  assert.equal(merged[0].kind, "annotation");
  assert.deepEqual(
    merged[0].origins.slice().sort(),
    ["classes/BIO101/Pharmacology.md", "pdf annotation"],
  );
});

test("merging by key keeps the first non-empty notes and heading", () => {
  const target = { page: 3, selection: { beginIndex: 1, beginOffset: 0, endIndex: 1, endOffset: 5 } };
  const base = { key: "page=3&selection=1,0,1,5", page: 3, kind: "selection", color: null, target, text: "Sarcomere", before: "", after: "" };
  const merged = mf.mergeHighlights([
    { ...base, id: "", origins: ["a.md"] },
    { ...base, id: "", origins: ["b.md"], notes: "- the contractile unit", heading: "Muscle" },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].notes, "- the contractile unit");
  assert.equal(merged[0].heading, "Muscle");
  assert.deepEqual(merged[0].origins, ["a.md", "b.md"]);
});

test("withSuggested adds AI-picked spans to the reader's highlights, drops repeats by key, and numbers them in page order", () => {
  const mine = { id: "H01", key: "page=5&selection=1,0,1,9", page: 5, kind: "selection", color: "yellow", target: { page: 5 }, text: "Reader span", before: "", after: "", origins: ["pdf++"] };
  const aiSame = { ...mine, id: "", text: "Reader span", origins: ["ai suggestion"] };
  const aiNew = { id: "", key: "page=2&selection=3,0,3,9", page: 2, kind: "selection", color: "yellow", target: { page: 2 }, text: "AI span", before: "", after: "", origins: ["ai suggestion"], label: "Glycolysis yield" };
  const out = mf.withSuggested([mine], [aiSame, aiNew]);
  assert.deepEqual(out.map((h) => [h.id, h.page, h.text]), [["H01", 2, "AI span"], ["H02", 5, "Reader span"]]);
  assert.deepEqual(out[1].origins.sort(), ["ai suggestion", "pdf++"]);
});
