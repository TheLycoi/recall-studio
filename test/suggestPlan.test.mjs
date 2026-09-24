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
  // Ends with the Highlights section and the newly added row: the quote, then its page link.
  assert.ok(/## Highlights\n\n[\s\S]*\n$/.test(note.content));
  assert.ok(/\n> \[!PDF\|yellow\] \[\[[^\]]+\|HBIO 250[^\]]*, p\.1\]\]\n> > Affinity rises with structural fit\.\n$/.test(note.content), note.content);
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

// ---- sections: a span filed under a note's own subtopic ------------------

const planOpts = {
  classCode: CLASS_CODE,
  pdfBasename: PDF_BASENAME,
  conceptsFolder: "wiki/concepts",
  entitiesFolder: "wiki/entities",
};

test("verifySpans carries the section a span names, trimmed of its marker", () => {
  const m = maps();
  const res = sp.verifySpans(
    draftOf([
      { ...span(1, "Albumin is an inert binding protein."), note_section: "## Receptors " },
      span(1, "Affinity rises with structural fit."),
    ]),
    m,
    opts(),
  );
  assert.equal(res.spans[0].noteSection, "Receptors");
  assert.equal(res.spans[1].noteSection, "", "a span without a section is about the note as a whole");
});

test("planWikiNotes files each span under the section it names and reports the sections", () => {
  const m = maps();
  const md = `---\nclass: ${CLASS_CODE}\n---\n\n## Receptors\n\nA receptor binds and transduces.\n\n## Highlights\n\n`;
  const res = sp.verifySpans(
    draftOf([
      { ...span(1, "Albumin is an inert binding protein."), note_section: "Receptors" },
      { ...span(1, "Affinity rises with structural fit."), note_section: "Affinity" },
      span(2, "Pharmacokinetics is what the body does to the drug."),
    ]),
    m,
    opts(),
  );
  const rows = sp.toManifestHighlights(res.spans, m);
  const out = sp.planWikiNotes(res.spans, rows, [], [{ title: "Pharmacology", kind: "concept", path: "wiki/concepts/Pharmacology.md", md }], planOpts);

  assert.equal(out.notes.length, 1, "one file, however many sections");
  const note = out.notes[0];
  assert.equal(note.exists, true);
  assert.equal(note.added, 3);

  const receptors = note.content.indexOf("## Receptors");
  // A created section's heading is a link to its slide, so it is found by its display text.
  const affinity = note.content.search(/## \[\[[^\]]+\|Affinity\]\]/);
  const highlights = note.content.indexOf("## Highlights");
  const albumin = note.content.indexOf("Albumin is an inert binding protein.");
  const fit = note.content.indexOf("Affinity rises with structural fit.");
  const pk = note.content.indexOf("Pharmacokinetics is what the body does to the drug.");
  assert.ok(affinity >= 0, "the new section exists as a linked heading");
  assert.ok(receptors < albumin && albumin < affinity, "the receptor span sits under Receptors");
  assert.ok(affinity < fit && fit < highlights, "the affinity span sits under its new section, ahead of the highlights");
  assert.ok(highlights < pk, "the sectionless span goes under Highlights");
  assert.deepEqual(
    note.sections.map((s) => [s.heading, s.created, s.keys.length]),
    [
      ["Receptors", false, 1],
      ["Affinity", true, 1],
    ],
  );
});

test("planWikiNotes sets a section aside on a note that does not exist yet", () => {
  const m = maps();
  const proposed = [{ title: "Binding Proteins", kind: "concept", summary: "S." }];
  const res = sp.verifySpans(
    draftOf([{ ...span(1, "Albumin is an inert binding protein.", "Binding Proteins"), note_section: "Albumin" }], proposed),
    m,
    opts(),
  );
  const rows = sp.toManifestHighlights(res.spans, m);
  const out = sp.planWikiNotes(res.spans, rows, proposed, [], planOpts);
  assert.equal(out.notes.length, 1);
  assert.equal(out.notes[0].exists, false);
  assert.ok(!out.notes[0].content.includes("## Albumin"), "a fresh note takes its sections from the schema");
  assert.equal(out.notes[0].sections, undefined);
});

// ---- append-first: a proposed note with a home is filed, not created --------

const PHARMACOLOGY = {
  title: "Pharmacology",
  kind: "concept",
  path: "wiki/concepts/Pharmacology.md",
  md: `---\nclass: ${CLASS_CODE}\naliases:\n  - "Drug Action"\n---\n\n## Receptors\n\nA receptor binds and transduces.\n\n## Highlights\n\n`,
};

const newNote = (title, over = {}) => ({ title, kind: "concept", summary: "S.", closest_existing: "", why_new: "", aliases: [], tag: "other", ...over });

test("a proposed note that names a closest existing note is filed there as a new heading", () => {
  const m = maps();
  const proposed = [newNote("COX Inhibitors", { closest_existing: "Pharmacology", why_new: "NSAIDs are a subtopic of pharmacology" })];
  const res = sp.verifySpans(draftOf([span(1, "Albumin is an inert binding protein.", "COX Inhibitors")], proposed), m, opts());
  const rows = sp.toManifestHighlights(res.spans, m);
  const out = sp.planWikiNotes(res.spans, rows, proposed, [PHARMACOLOGY], planOpts);

  assert.equal(out.notes.length, 1, "no second note");
  const note = out.notes[0];
  assert.equal(note.exists, true);
  assert.equal(note.path, PHARMACOLOGY.path);
  assert.ok(/## \[\[[^\]]+\|COX Inhibitors\]\]\n\n> \[!PDF/.test(note.content), "the proposal became a heading inside the home, linked to its slide");
  assert.deepEqual(out.routed, [{ from: "COX Inhibitors", to: "Pharmacology", heading: "COX Inhibitors", why: "NSAIDs are a subtopic of pharmacology" }]);
  assert.deepEqual(note.routed.map((r) => [r.from, r.heading, r.keys.length]), [["COX Inhibitors", "COX Inhibitors", 1]]);
  assert.deepEqual(out.orphanTitles, [], "a routed title is not an orphan");
});

test("a proposed title that is already a heading of an existing note goes under that heading", () => {
  const m = maps();
  // closest_existing left empty: the model missed the home; the planner does not.
  const proposed = [newNote("receptors")];
  const res = sp.verifySpans(draftOf([span(1, "Albumin is an inert binding protein.", "receptors")], proposed), m, opts());
  const rows = sp.toManifestHighlights(res.spans, m);
  const out = sp.planWikiNotes(res.spans, rows, proposed, [PHARMACOLOGY], planOpts);
  assert.equal(out.notes.length, 1);
  assert.equal(out.notes[0].path, PHARMACOLOGY.path);
  assert.equal(out.routed[0].heading, "Receptors", "the note's own spelling of the heading is used");
  assert.ok(/## Receptors\n\nA receptor binds and transduces\.\n\n> \[!PDF/.test(out.notes[0].content), "appended inside the existing section");
});

test("a proposed title that is an alias of an existing note goes to the note as a whole", () => {
  const m = maps();
  const proposed = [newNote("Drug Action")];
  const res = sp.verifySpans(draftOf([span(1, "Albumin is an inert binding protein.", "Drug Action")], proposed), m, opts());
  const rows = sp.toManifestHighlights(res.spans, m);
  const out = sp.planWikiNotes(res.spans, rows, proposed, [PHARMACOLOGY], planOpts);
  assert.equal(out.notes.length, 1);
  assert.equal(out.notes[0].path, PHARMACOLOGY.path);
  assert.equal(out.routed[0].heading, "", "another name for the note is the note, not a section of it");
  assert.ok(!out.notes[0].content.includes("## Drug Action"));
  assert.ok(/## Highlights\n\n> \[!PDF/.test(out.notes[0].content), "so the span lands under Highlights");
});

test("at the wall — nothing related — a proposed note is created as before", () => {
  const m = maps();
  const proposed = [newNote("Self-Efficacy", { why_new: "a belief construct none of the listed notes would hold" })];
  const res = sp.verifySpans(draftOf([span(1, "Albumin is an inert binding protein.", "Self-Efficacy")], proposed), m, opts());
  const rows = sp.toManifestHighlights(res.spans, m);
  const out = sp.planWikiNotes(res.spans, rows, proposed, [PHARMACOLOGY], planOpts);
  assert.equal(out.notes.length, 1);
  assert.equal(out.notes[0].exists, false);
  assert.equal(out.notes[0].path, "wiki/concepts/Self-Efficacy.md");
  assert.deepEqual(out.routed, []);
});

test("a proposed title that specializes an existing heading goes under that heading", () => {
  const m = maps();
  // The reported case: the model left closest_existing empty and proposed a
  // page for what is a subtopic of the note's own ## Receptors section.
  const proposed = [newNote("Receptor Subtypes and Off-Target Effects")];
  const res = sp.verifySpans(draftOf([span(1, "Albumin is an inert binding protein.", "Receptor Subtypes and Off-Target Effects")], proposed), m, opts());
  const rows = sp.toManifestHighlights(res.spans, m);
  const out = sp.planWikiNotes(res.spans, rows, proposed, [PHARMACOLOGY], planOpts);
  assert.equal(out.notes.length, 1);
  assert.equal(out.notes[0].path, PHARMACOLOGY.path);
  assert.equal(out.routed[0].heading, "Receptors");
  assert.ok(/## Receptors\n\nA receptor binds and transduces\.\n\n> \[!PDF/.test(out.notes[0].content));
});

test("sharing a word with a heading is not specializing it", () => {
  const m = maps();
  const wiki = [{ ...PHARMACOLOGY, md: `---\nclass: ${CLASS_CODE}\n---\n\n## Drug Safety & The Therapeutic Index\n\nText.\n\n## Highlights\n\n` }];
  const proposed = [newNote("Drug Metabolism")];
  const res = sp.verifySpans(draftOf([span(1, "Albumin is an inert binding protein.", "Drug Metabolism")], proposed), m, opts());
  const rows = sp.toManifestHighlights(res.spans, m);
  const out = sp.planWikiNotes(res.spans, rows, proposed, wiki, planOpts);
  assert.equal(out.notes[0].exists, false, "the wall: a new note");
  assert.deepEqual(out.routed, []);
});

test("a proposed title that specializes an existing note's title becomes a heading inside it", () => {
  const m = maps();
  const proposed = [newNote("Clinical Pharmacology")];
  const res = sp.verifySpans(draftOf([span(1, "Albumin is an inert binding protein.", "Clinical Pharmacology")], proposed), m, opts());
  const rows = sp.toManifestHighlights(res.spans, m);
  const out = sp.planWikiNotes(res.spans, rows, proposed, [PHARMACOLOGY], planOpts);
  assert.equal(out.notes.length, 1);
  assert.equal(out.notes[0].path, PHARMACOLOGY.path);
  assert.deepEqual(out.routed, [{ from: "Clinical Pharmacology", to: "Pharmacology", heading: "Clinical Pharmacology", why: "“Clinical Pharmacology” is a kind of Pharmacology" }]);
  assert.ok(/## \[\[[^\]]+\|Clinical Pharmacology\]\]\n\n> \[!PDF/.test(out.notes[0].content));
});

test("a title the reader kept as its own note is not routed, whatever it names", () => {
  const m = maps();
  const proposed = [newNote("COX Inhibitors", { closest_existing: "Pharmacology", why_new: "part of pharmacology" })];
  const res = sp.verifySpans(draftOf([span(1, "Albumin is an inert binding protein.", "COX Inhibitors")], proposed), m, opts());
  const rows = sp.toManifestHighlights(res.spans, m);
  const out = sp.planWikiNotes(res.spans, rows, proposed, [PHARMACOLOGY], { ...planOpts, keepAsNew: ["COX Inhibitors"] });
  assert.equal(out.notes.length, 1);
  assert.equal(out.notes[0].exists, false);
  assert.equal(out.notes[0].title, "COX Inhibitors");
  assert.deepEqual(out.routed, []);
});

test("applyPreviewChoices keeps only chosen spans, renames, and honours a title kept as its own note", () => {
  const spans = [
    { key: "k1", noteTitle: "Pharmacology", noteKind: "concept", noteSection: "" },
    { key: "k2", noteTitle: "COX Inhibitors", noteKind: "concept", noteSection: "" },
    { key: "k3", noteTitle: "Dropped", noteKind: "concept", noteSection: "" },
  ];
  const proposed = [newNote("COX Inhibitors", { closest_existing: "Pharmacology", why_new: "part of pharmacology" })];
  const routed = [{ from: "COX Inhibitors", to: "Pharmacology", heading: "COX Inhibitors", why: "part of pharmacology" }];
  const choices = [
    { title: "Pharmacology", highlights: [{ key: "k1" }] },
    { title: "COX Inhibitors", highlights: [{ key: "k2" }] },
  ];
  const out = sp.applyPreviewChoices(spans, choices, proposed, [PHARMACOLOGY], routed);
  assert.deepEqual(out.spans.map((s) => s.key), ["k1", "k2"], "an unchecked span is gone");
  assert.deepEqual(out.keepAsNew, ["COX Inhibitors"], "choosing a routed title keeps it as its own note");
  assert.equal(out.newNotes.find((n) => n.title === "COX Inhibitors").closest_existing, "", "and it no longer names a home");
});

test("applyPreviewChoices keeps a renamed new row as new so the re-plan cannot merge it", () => {
  // The preview offered to create "Brand New Topic"; the reader renamed it to
  // a title that contains every word of the existing page "Receptors".
  const spans = [{ key: "k1", noteTitle: "Brand New Topic", noteKind: "concept", noteSection: "" }];
  const planned = { title: "Brand New Topic", path: "wiki/concepts/Brand New Topic.md", exists: false };
  const choices = [{ note: planned, title: "Receptors Subtypes", highlights: [{ key: "k1" }] }];
  const out = sp.applyPreviewChoices(spans, choices, [], [PHARMACOLOGY], []);
  assert.deepEqual(out.keepAsNew, ["Receptors Subtypes"], "a row the reader accepted as new stays new");
});

test("applyPreviewChoices does not pin a row the preview showed as an existing page", () => {
  const spans = [{ key: "k1", noteTitle: "Pharmacology", noteKind: "concept", noteSection: "" }];
  const planned = { title: "Pharmacology", path: PHARMACOLOGY.path, exists: true };
  const choices = [{ note: planned, title: "Pharmacology", highlights: [{ key: "k1" }] }];
  const out = sp.applyPreviewChoices(spans, choices, [], [PHARMACOLOGY], []);
  assert.deepEqual(out.keepAsNew, [], "a merge row is not pinned as new");
});

test("applyPreviewChoices announces a title the reader typed over as a new note with the group's kind", () => {
  const spans = [{ key: "k1", noteTitle: "Self-Efficacy", noteKind: "concept", noteSection: "" }];
  const out = sp.applyPreviewChoices(spans, [{ title: "Self Efficacy Beliefs", highlights: [{ key: "k1" }] }], [], [PHARMACOLOGY], []);
  assert.equal(out.spans[0].noteTitle, "Self Efficacy Beliefs");
  const announced = out.newNotes.find((n) => n.title === "Self Efficacy Beliefs");
  assert.ok(announced, "the typed title is announced");
  assert.equal(announced.kind, "concept");
  assert.deepEqual(announced.aliases, []);
  assert.equal(announced.tag, "other");
});

test("a new karpathy page takes its aliases and tag from the proposal", () => {
  const maps = new Map([[3, pm.buildPageMap([item("Self-efficacy is a belief in one's capacity to act.")])]]);
  const spans = sp.verifySpans(
    draftOf([span(3, "Self-efficacy is a belief in one's capacity to act.", "Self-Efficacy", "concept")]),
    maps,
    { perPage: 3, remaining: 10, existingKeys: new Set(), batch: { from: 3, to: 3 } },
  ).spans;
  const rows = sp.toManifestHighlights(spans, maps);
  const proposed = [newNote("Self-Efficacy", { aliases: ["Self-efficacy belief"], tag: "term" })];
  const out = sp.planWikiNotes(spans, rows, proposed, [], {
    classCode: CLASS_CODE,
    pdfBasename: PDF_BASENAME,
    conceptsFolder: "wiki/concepts",
    entitiesFolder: "wiki/entities",
    schema: "karpathy",
  });
  assert.equal(out.notes.length, 1);
  assert.ok(out.notes[0].content.includes("tags: [term]"));
  assert.ok(out.notes[0].content.includes('- "Self-efficacy belief"'));
});

function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const WIKI4 = [
  { title: "pharmacology", kind: "concept", path: "wiki/concepts/pharmacology.md", md: "---\ntype: concept\naliases:\n  - \"Drug Action\"\n---\n\n# Pharmacology\n\nSee [[receptors]], [[dosing]] and [[wada]].\n" },
  { title: "receptors", kind: "concept", path: "wiki/concepts/receptors.md", md: "---\ntype: concept\n---\n\n# Receptors\n\nBack to [[pharmacology]] and [[dosing]].\n" },
  { title: "dosing", kind: "concept", path: "wiki/concepts/dosing.md", md: "---\ntype: concept\n---\n\n# Dosing\n\nSee [[pharmacology]] and [[receptors]].\n" },
  { title: "wada", kind: "entity", path: "wiki/entities/wada.md", md: "---\ntype: entity\n---\n\n# WADA\n\nPolices [[pharmacology]].\n" },
];
const PLAN_OPTS = { classCode: "", pdfBasename: "P", conceptsFolder: "wiki/concepts", entitiesFolder: "wiki/entities", schema: "karpathy", ppr: { rng: seededRng(7) } };

test("relatedLinksFor names the pages the summary mentions, in full-path form with the page's own heading", () => {
  const r = sp.relatedLinksFor("Half-Life", "How long a drug persists; a term from drug action.", WIKI4, PLAN_OPTS);
  assert.deepEqual(r.concepts[0], { path: "concepts/pharmacology", display: "Pharmacology" }, "named by its alias “Drug Action”");
});

test("relatedLinksFor walks the graph from what was named and never links the page itself", () => {
  const r = sp.relatedLinksFor("Pharmacology", "About pharmacology and receptors.", WIKI4, PLAN_OPTS);
  const paths = r.concepts.map((l) => l.path);
  assert.ok(!paths.includes("concepts/pharmacology"), "a page does not relate to itself");
  assert.ok(paths.includes("concepts/receptors"), "the named neighbour is there");
  assert.ok(paths.includes("concepts/dosing"), "and the one reached by walking the links");
  assert.deepEqual(r.entities.map((l) => l.path), ["entities/wada"]);
});

test("relatedLinksFor with nothing named links nothing rather than guessing", () => {
  const r = sp.relatedLinksFor("Something Else", "Unrelated prose.", WIKI4, PLAN_OPTS);
  assert.deepEqual(r, { concepts: [], entities: [] });
});

test("a new karpathy page renders its related sections from the planner, not the model", () => {
  const maps = new Map([[3, pm.buildPageMap([item("Half-life is the time for the concentration to halve.")])]]);
  const spans = sp.verifySpans(
    draftOf([span(3, "Half-life is the time for the concentration to halve.", "Half-Life", "concept")]),
    maps,
    { perPage: 3, remaining: 10, existingKeys: new Set(), batch: { from: 3, to: 3 } },
  ).spans;
  const rows = sp.toManifestHighlights(spans, maps);
  const proposed = [newNote("Half-Life", { summary: "A term from drug action about receptors.", tag: "term" })];
  const out = sp.planWikiNotes(spans, rows, proposed, WIKI4, PLAN_OPTS);
  const md = out.notes[0].content;
  assert.ok(md.includes("## Related Concepts\n- [[concepts/pharmacology|Pharmacology]]"), md);
  assert.ok(md.includes("- [[concepts/receptors|Receptors]]"));
});
