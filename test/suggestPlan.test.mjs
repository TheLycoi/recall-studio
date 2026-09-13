// Run with: npm test  (bundles src/suggestPlan.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let sp;
let pm;
let mf;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
  const out = path.join(dir, "suggestPlan.mjs");
  await build({ entryPoints: ["src/suggestPlan.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  sp = await import(pathToFileURL(out).href);
  const outPm = path.join(dir, "pageMap.mjs");
  await build({ entryPoints: ["src/pageMap.ts"], bundle: true, format: "esm", platform: "node", outfile: outPm, logLevel: "silent" });
  pm = await import(pathToFileURL(outPm).href);
  const outMf = path.join(dir, "manifest.mjs");
  await build({ entryPoints: ["src/manifest.ts"], bundle: true, format: "esm", platform: "node", outfile: outMf, logLevel: "silent" });
  mf = await import(pathToFileURL(outMf).href);
});

const item = (str, hasEOL = false) => ({ str, hasEOL });

const PDF_BASENAME = "HBIO 250 - Pharmacology";
const CLASS_CODE = "HBIO 250";

// A page whose items give several non-overlapping quotable spans.
const PAGE_ONE = [
  item("Receptors bind drugs with high affinity", true),
  item("and transduce a signal into the cell.", true),
  item("Albumin is an inert binding protein.", true),
  item("Affinity rises with structural fit.", true),
];
const PAGE_TWO = [
  item("Pharmacokinetics is what the body does to the drug.", true),
  item("Pharmacodynamics is what the drug does to the body.", true),
];

function maps() {
  const m = new Map();
  m.set(1, pm.buildPageMap(PAGE_ONE));
  m.set(2, pm.buildPageMap(PAGE_TWO));
  return m;
}

const span = (page, quote, note_title = "Pharmacology", note_kind = "concept", label = "a fact") => ({
  page,
  quote,
  label,
  note_title,
  note_kind,
});

const draftOf = (spans, new_notes = []) => ({ spans, new_notes });

const opts = (over = {}) => ({
  perPage: 10,
  remaining: 100,
  existingKeys: new Set(),
  batch: { from: 1, to: 8 },
  ...over,
});

test("batchPages splits into 1-based inclusive ranges", () => {
  assert.deepEqual(sp.batchPages(17, 8), [
    { from: 1, to: 8 },
    { from: 9, to: 16 },
    { from: 17, to: 17 },
  ]);
  assert.deepEqual(sp.batchPages(0, 8), []);
  assert.deepEqual(sp.batchPages(3, 0), [
    { from: 1, to: 1 },
    { from: 2, to: 2 },
    { from: 3, to: 3 },
  ]);
});

test("verifySpans enforces the per-page cap", () => {
  const draft = draftOf([
    span(1, "Receptors bind drugs with high affinity"),
    span(1, "Albumin is an inert binding protein."),
    span(1, "Affinity rises with structural fit."),
  ]);
  const res = sp.verifySpans(draft, maps(), opts({ perPage: 2 }));
  assert.equal(res.spans.length, 2);
  assert.equal(res.dropped.overCap, 1);
  assert.equal(res.dropped.duplicate, 0);
});

test("verifySpans drops a key the vault already holds", () => {
  const m = maps();
  const first = sp.verifySpans(draftOf([span(1, "Receptors bind drugs with high affinity")]), m, opts());
  assert.equal(first.spans.length, 1);
  const existingKeys = new Set([first.spans[0].key]);

  const res = sp.verifySpans(draftOf([span(1, "Receptors bind drugs with high affinity")]), m, opts({ existingKeys }));
  assert.equal(res.spans.length, 0);
  assert.equal(res.dropped.duplicate, 1);
});

test("verifySpans drops the second of two overlapping spans on a page", () => {
  const draft = draftOf([
    span(1, "Receptors bind drugs with high affinity and transduce a signal into the cell."),
    span(1, "high affinity and transduce a signal"),
  ]);
  const res = sp.verifySpans(draft, maps(), opts());
  assert.equal(res.spans.length, 1);
  assert.equal(res.dropped.duplicate, 1);
  assert.equal(res.spans[0].quote, "Receptors bind drugs with high affinity and transduce a signal into the cell.");
});

test("verifySpans drops a page outside the batch", () => {
  const res = sp.verifySpans(draftOf([span(9, "anything at all")]), maps(), opts());
  assert.equal(res.spans.length, 0);
  assert.equal(res.dropped.outOfBatch, 1);
  assert.equal(res.dropped.unlocated, 0);
});

test("verifySpans drops a quote that is not on the page", () => {
  const res = sp.verifySpans(draftOf([span(1, "Sodium channels open on depolarisation")]), maps(), opts());
  assert.equal(res.spans.length, 0);
  assert.equal(res.dropped.unlocated, 1);
});

test("verifySpans respects the overall remaining budget", () => {
  const draft = draftOf([
    span(1, "Receptors bind drugs with high affinity"),
    span(2, "Pharmacodynamics is what the drug does to the body."),
  ]);
  const res = sp.verifySpans(draft, maps(), opts({ remaining: 1 }));
  assert.equal(res.spans.length, 1);
  assert.equal(res.dropped.overCap, 1);
});

test("toManifestHighlights builds S-prefixed rows in page order", () => {
  const m = maps();
  const draft = draftOf([
    span(2, "Pharmacodynamics is what the drug does to the body."),
    span(1, "Albumin is an inert binding protein."),
  ]);
  const res = sp.verifySpans(draft, m, opts());
  assert.equal(res.spans.length, 2);

  const rows = sp.toManifestHighlights(res.spans, m);
  assert.deepEqual(rows.map((r) => r.id), ["S01", "S02"]);
  assert.deepEqual(rows.map((r) => r.page), [1, 2]);
  for (const r of rows) {
    assert.equal(r.kind, "selection");
    assert.equal(r.color, "yellow");
    assert.deepEqual(r.origins, ["ai suggestion"]);
  }
  assert.equal(rows[0].text, "Albumin is an inert binding protein.");
  // Context exists on both sides of the page-1 row.
  assert.notEqual(rows[0].before, "");
  assert.notEqual(rows[0].after, "");
});

test("toManifestHighlights collapses the double space singleLine can leave at an item join", () => {
  const page = [item("cost of ", false), item("changing", false)];
  const m = new Map([[1, pm.buildPageMap(page)]]);
  const res = sp.verifySpans(draftOf([span(1, "cost of changing")]), m, opts());
  assert.equal(res.spans.length, 1);

  const rows = sp.toManifestHighlights(res.spans, m);
  assert.equal(rows[0].text, "cost of changing");
});

test("toManifestHighlights leaves an existing single-item selection's text unchanged", () => {
  const m = maps();
  const res = sp.verifySpans(draftOf([span(1, "Albumin is an inert binding protein.")]), m, opts());
  const rows = sp.toManifestHighlights(res.spans, m);
  assert.equal(rows[0].text, "Albumin is an inert binding protein.");
});

test("sortAndAssignIds keeps H ids when no prefix is given", () => {
  const m = maps();
  const res = sp.verifySpans(draftOf([span(1, "Albumin is an inert binding protein.")]), m, opts());
  const rows = sp.toManifestHighlights(res.spans, m);
  const renumbered = mf.sortAndAssignIds(rows);
  assert.deepEqual(renumbered.map((r) => r.id), ["H01"]);
});

test("planWikiNotes merges into an existing wiki note", () => {
  const m = maps();
  const shared = sp.verifySpans(draftOf([span(1, "Albumin is an inert binding protein.")]), m, opts());
  const sharedRows = sp.toManifestHighlights(shared.spans, m);
  const existingCallout = `> [!PDF|yellow] [[${PDF_BASENAME}.pdf#${renderSub(sharedRows[0])}|${PDF_BASENAME}, p.1]]\n> > ${sharedRows[0].text}`;

  const md = `---\nclass: ${CLASS_CODE}\n---\n\n## Receptors\n\nA receptor binds and transduces.\n\n## Highlights\n\n${existingCallout}\n`;

  const res = sp.verifySpans(
    draftOf([
      span(1, "Albumin is an inert binding protein."),
      span(1, "Affinity rises with structural fit."),
    ]),
    m,
    opts(),
  );
  const rows = sp.toManifestHighlights(res.spans, m);
  const out = sp.planWikiNotes(res.spans, rows, [], [{ title: "Pharmacology", kind: "concept", path: "wiki/concepts/Pharmacology.md", md }], {
    classCode: CLASS_CODE,
    pdfBasename: PDF_BASENAME,
    conceptsFolder: "wiki/concepts",
    entitiesFolder: "wiki/entities",
  });

  assert.equal(out.notes.length, 1);
  const note = out.notes[0];
  assert.equal(note.exists, true);
  assert.equal(note.path, "wiki/concepts/Pharmacology.md");
  assert.equal(note.skipped, 1);
  assert.equal(note.added, 1);
  // Old prose survives untouched.
  assert.ok(note.content.includes("## Receptors\n\nA receptor binds and transduces."));
  assert.ok(note.content.includes(existingCallout));
  // Ends with the Highlights section and the newly added callout.
  assert.ok(/## Highlights\n\n[\s\S]*\n$/.test(note.content));
  assert.ok(note.content.trimEnd().endsWith("Affinity rises with structural fit."));
});

// Rebuild the subpath the same way pdflink does, so the fixture's existing
// callout carries exactly the key the planner will compute.
function renderSub(row) {
  const s = row.target.selection;
  return `page=${row.page}&selection=${s.beginIndex},${s.beginOffset},${s.endIndex},${s.endOffset}`;
}

test("planWikiNotes takes the first summary when a new title is proposed twice", () => {
  const m = maps();
  const res = sp.verifySpans(
    draftOf([
      span(1, "Albumin is an inert binding protein.", "Albumin", "entity"),
      span(1, "Affinity rises with structural fit.", "Albumin", "entity"),
    ]),
    m,
    opts(),
  );
  const rows = sp.toManifestHighlights(res.spans, m);
  const newNotes = [
    { title: "Albumin", kind: "entity", summary: "First summary." },
    { title: "albumin", kind: "concept", summary: "Second summary." },
  ];
  const out = sp.planWikiNotes(res.spans, rows, newNotes, [], {
    classCode: CLASS_CODE,
    pdfBasename: PDF_BASENAME,
    conceptsFolder: "wiki/concepts",
    entitiesFolder: "wiki/entities",
  });

  assert.equal(out.notes.length, 1);
  const note = out.notes[0];
  assert.equal(note.exists, false);
  assert.equal(note.summary, "First summary.");
  assert.equal(note.path, "wiki/entities/Albumin.md");
  assert.equal(note.added, 2);
  assert.equal(note.skipped, 0);
  assert.ok(note.content.includes("First summary."));
});

test("planWikiNotes keeps an orphan span under its own title, not a per-PDF note", () => {
  const m = maps();
  const res = sp.verifySpans(
    draftOf([span(1, "Albumin is an inert binding protein.", "Motivational Interviewing")]),
    m,
    opts(),
  );
  const rows = sp.toManifestHighlights(res.spans, m);
  const out = sp.planWikiNotes(res.spans, rows, [], [], {
    classCode: CLASS_CODE,
    pdfBasename: PDF_BASENAME,
    conceptsFolder: "wiki/concepts",
    entitiesFolder: "wiki/entities",
  });

  assert.deepEqual(out.orphanTitles, ["Motivational Interviewing"]);
  assert.equal(out.notes.length, 1);
  const note = out.notes[0];
  assert.equal(note.title, "Motivational Interviewing");
  assert.equal(note.exists, false);
  assert.equal(note.summary, "");
  assert.equal(note.path, "wiki/concepts/Motivational Interviewing.md");
  assert.equal(note.highlights.length, 1);
});

test("planWikiNotes puts an entity-kind orphan under the entities folder", () => {
  const m = maps();
  const res = sp.verifySpans(
    draftOf([span(1, "Albumin is an inert binding protein.", "Motivational Interviewing", "entity")]),
    m,
    opts(),
  );
  const rows = sp.toManifestHighlights(res.spans, m);
  const out = sp.planWikiNotes(res.spans, rows, [], [], {
    classCode: CLASS_CODE,
    pdfBasename: PDF_BASENAME,
    conceptsFolder: "wiki/concepts",
    entitiesFolder: "wiki/entities",
  });

  assert.equal(out.notes.length, 1);
  assert.equal(out.notes[0].path, "wiki/entities/Motivational Interviewing.md");
});

test("planWikiNotes never titles a note after the source PDF", () => {
  const m = maps();
  const res = sp.verifySpans(
    draftOf([
      span(1, "Albumin is an inert binding protein.", "Nowhere Land"),
      span(1, "Affinity rises with structural fit.", "Somewhere Else"),
    ]),
    m,
    opts(),
  );
  const rows = sp.toManifestHighlights(res.spans, m);
  const out = sp.planWikiNotes(res.spans, rows, [], [], {
    classCode: CLASS_CODE,
    pdfBasename: PDF_BASENAME,
    conceptsFolder: "wiki/concepts",
    entitiesFolder: "wiki/entities",
  });

  assert.deepEqual(out.orphanTitles, ["Nowhere Land", "Somewhere Else"]);
  assert.equal(out.notes.length, 2);
  for (const note of out.notes) {
    assert.notEqual(note.title, PDF_BASENAME);
  }
});

test("planWikiNotes omits a group whose rows are all already present", () => {
  const m = maps();
  const res = sp.verifySpans(draftOf([span(1, "Albumin is an inert binding protein.")]), m, opts());
  const rows = sp.toManifestHighlights(res.spans, m);
  const callout = `> [!PDF|yellow] [[${PDF_BASENAME}.pdf#${renderSub(rows[0])}|${PDF_BASENAME}, p.1]]\n> > ${rows[0].text}`;
  const md = `---\nclass: ${CLASS_CODE}\n---\n\n## Highlights\n\n${callout}\n`;

  const out = sp.planWikiNotes(res.spans, rows, [], [{ title: "Pharmacology", kind: "concept", path: "wiki/concepts/Pharmacology.md", md }], {
    classCode: CLASS_CODE,
    pdfBasename: PDF_BASENAME,
    conceptsFolder: "wiki/concepts",
    entitiesFolder: "wiki/entities",
  });

  assert.deepEqual(out.notes, []);
  assert.deepEqual(out.orphanTitles, []);
});
