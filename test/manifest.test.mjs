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
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
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
    origins: ["classes/HBIO250/Pharmacology.md"],
    ...overrides,
  };
}

test("MANIFEST_CONTEXT_CHARS is 150", () => {
  assert.equal(mf.MANIFEST_CONTEXT_CHARS, 150);
});

test("manifestPath joins folder and basename", () => {
  assert.equal(mf.manifestPath("recall-manifests", "Foo Bar"), "recall-manifests/Foo Bar.md");
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
  const a = selectionHighlight({ text: "", origins: ["classes/HBIO250/Pharmacology.md"] });
  const b = selectionHighlight({ text: "Receptors have 2 important properties", origins: ["classes/HBIO250/Pharmacokinetics.md"] });
  const merged = mf.mergeHighlights([a, b]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].key, a.key);
  assert.equal(merged[0].text, "Receptors have 2 important properties");
  assert.deepEqual(
    merged[0].origins.slice().sort(),
    ["classes/HBIO250/Pharmacokinetics.md", "classes/HBIO250/Pharmacology.md"],
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
    origins: ["classes/HBIO250/Pharmacology.md"],
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
    ["classes/HBIO250/Pharmacology.md", "pdf annotation"],
  );
});

test("renderManifest -> parseManifest round trips a 3-highlight manifest with a before containing \" and :", () => {
  const manifest = {
    pdfPath: "sources/class notes/HBIO250/HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf",
    pdfBasename: "HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics",
    classCode: "HBIO250",
    extracted: "2026-09-10T15:04:00",
    sources: ["classes/HBIO250/Pharmacology.md", "classes/HBIO250/Pharmacokinetics.md"],
    highlights: [
      {
        id: "H01",
        key: "page=2&annotation=846R",
        page: 2,
        kind: "annotation",
        color: "255,208,0",
        // Annotation links never carry &color= (see the plan's manifest
        // example: the link is #page=2&annotation=846R with no color).
        target: { page: 2, annotation: "846R" },
        text: "Pharmacology Pharmacology is the study of the action of drugs in the human body (from Greek pharmakia = drugs)",
        before: 'Section 1: "Intro" — HBIO 250 Fall 2026',
        after: "Pharmacodynamics = “What drugs do in the body”",
        origins: ["classes/HBIO250/Pharmacology.md", "pdf annotation"],
      },
      {
        id: "H02",
        key: "page=4&selection=2,0,33,19",
        page: 4,
        kind: "selection",
        color: "yellow",
        target: { page: 4, selection: { beginIndex: 2, beginOffset: 0, endIndex: 33, endOffset: 19 }, color: "yellow" },
        text: "Receptors have 2 important properties: …",
        before: "Drug–Receptor Interactions Most drugs act by binding to receptors",
        after: "Agonists activate receptors; antagonists block them",
        origins: ["classes/HBIO250/Pharmacology.md"],
      },
      {
        id: "H03",
        key: "page=4&rect=13,55,713,222",
        page: 4,
        kind: "rect",
        color: null,
        target: { page: 4, rect: [13, 55, 713, 222] },
        text: "",
        before: "",
        after: "",
        origins: ["classes/HBIO250/Pharmacology.md"],
      },
    ],
  };

  const rendered = mf.renderManifest(manifest);
  assert.ok(rendered.includes('pdf: "sources/class notes/HBIO250/HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf"'));
  assert.ok(rendered.includes('pdf_link: "[[HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf]]"'));
  assert.ok(rendered.includes("# Highlights: HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics"));
  assert.ok(rendered.includes('> before:: Section 1: "Intro" — HBIO 250 Fall 2026'));

  const parsed = mf.parseManifest(rendered);
  assert.equal(parsed.pdfPath, manifest.pdfPath);
  assert.equal(parsed.pdfBasename, manifest.pdfBasename);
  assert.equal(parsed.classCode, manifest.classCode);
  assert.equal(parsed.extracted, manifest.extracted);
  assert.deepEqual(parsed.sources, manifest.sources);
  assert.equal(parsed.highlights.length, 3);

  for (let i = 0; i < 3; i++) {
    const orig = manifest.highlights[i];
    const got = parsed.highlights[i];
    assert.equal(got.id, orig.id, `id[${i}]`);
    assert.equal(got.key, orig.key, `key[${i}]`);
    assert.equal(got.page, orig.page, `page[${i}]`);
    assert.equal(got.kind, orig.kind, `kind[${i}]`);
    assert.equal(got.color, orig.color, `color[${i}]`);
    assert.equal(got.text, orig.text, `text[${i}]`);
    assert.equal(got.before, orig.before, `before[${i}]`);
    assert.equal(got.after, orig.after, `after[${i}]`);
    assert.deepEqual(got.origins, orig.origins, `origins[${i}]`);
    assert.deepEqual(got.target, orig.target, `target[${i}]`);
  }
});

test("renderManifest: rect highlight with empty text renders as an embed line, not a callout", () => {
  const manifest = {
    pdfPath: "p.pdf",
    pdfBasename: "p",
    classCode: "X",
    extracted: "2026-09-10T00:00:00",
    sources: [],
    highlights: [
      {
        id: "H01",
        key: "page=9&rect=42,48,675,410",
        page: 9,
        kind: "rect",
        color: null,
        target: { page: 9, rect: [42, 48, 675, 410] },
        text: "",
        before: "",
        after: "",
        origins: ["classes/HBIO250/Pharmacology.md"],
      },
    ],
  };
  const rendered = mf.renderManifest(manifest);
  // Even with no text, the manifest keeps the full field block (id/page/kind/etc),
  // so a rect highlight's title line is still the "> [!PDF...] [[link]]" callout
  // form (the bare-embed shorthand is for topic notes, not manifest entries).
  assert.ok(rendered.includes("> [!PDF] [[p.pdf#page=9&rect=42,48,675,410|p.9]]"));
  assert.ok(rendered.includes("> > \n"));
});

// ---- 2.0: reader notes and heading ride on the manifest

test("notes and heading render as fields and parse back, newlines folded to ' / '", () => {
  const manifest = {
    pdfPath: "wiki/sources/classes/PSYC360/Chapter 5 -1.pdf",
    pdfBasename: "Chapter 5 -1",
    classCode: "PSYC360",
    extracted: "2026-09-24T08:34:20",
    sources: ["wiki/concepts/Childhood and Adolescent-Onset Disorders.md"],
    highlights: [
      {
        id: "H01",
        key: "page=23&selection=0,0,2,33",
        page: 23,
        kind: "selection",
        color: "note",
        target: { page: 23, selection: { beginIndex: 0, beginOffset: 0, endIndex: 2, endOffset: 33 }, color: "note" },
        text: "Attachment Disorders, Conduct Disorder, and Oppositional Defiant Disorder",
        before: "",
        after: "",
        origins: ["wiki/concepts/Childhood and Adolescent-Onset Disorders.md"],
        notes: "- **Oppositional Defiant Disorder**\n\t- A pattern of angry/irritable mood lasting 6 months",
        heading: "Attachment Disorders, Conduct Disorder, and Oppositional Defiant Disorder",
      },
      {
        id: "H02",
        key: "page=30&selection=0,0,0,30",
        page: 30,
        kind: "selection",
        color: null,
        target: { page: 30, selection: { beginIndex: 0, beginOffset: 0, endIndex: 0, endOffset: 30 } },
        text: "Conduct Disorder (CD)",
        before: "",
        after: "",
        origins: ["pdf annotation"],
      },
    ],
  };
  const md = mf.renderManifest(manifest);
  assert.match(md, /^> heading:: Attachment Disorders, Conduct Disorder, and Oppositional Defiant Disorder$/m);
  assert.match(md, /^> notes:: - \*\*Oppositional Defiant Disorder\*\* \/ \t- A pattern of angry\/irritable mood lasting 6 months$/m);
  const back = mf.parseManifest(md);
  assert.equal(back.highlights[0].notes, manifest.highlights[0].notes, "notes round-trip with their line breaks");
  assert.equal(back.highlights[0].heading, manifest.highlights[0].heading);
  assert.equal(back.highlights[1].notes, undefined, "a row without notes carries none");
  assert.equal(back.highlights[1].heading, undefined);
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
