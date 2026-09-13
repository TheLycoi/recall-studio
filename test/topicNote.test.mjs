// Run with: npm test  (bundles src/topicNote.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let tn;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
  const out = path.join(dir, "topicNote.mjs");
  await build({ entryPoints: ["src/topicNote.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  tn = await import(pathToFileURL(out).href);
});

const PDF_BASENAME = "HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics";
const SUMMARY =
  "Receptors bind drugs with high affinity and transduce a signal, which is what separates them from inert binding proteins such as albumin; the better the structural fit, the higher the affinity.";

const SELECTION_HIGHLIGHT = {
  id: "H04",
  key: "page=4&selection=2,0,33,19",
  page: 4,
  kind: "selection",
  color: "yellow",
  target: { page: 4, selection: { beginIndex: 2, beginOffset: 0, endIndex: 33, endOffset: 19 }, color: "yellow" },
  text:
    "Receptors have 2 important properties: 1. They bind ligands (or drugs) with relatively high affinity, and after they bind a drug… 2. They transduce a signal to produce a biological effect (this property distinguishes receptors from inert binding sites – e.g., albumin – a blood protein that binds/carries many drugs but does not transduce a signal)",
  before: "",
  after: "",
  origins: ["classes/HBIO250/Pharmacology.md"],
};

const RECT_HIGHLIGHT = {
  id: "H05",
  key: "page=4&rect=13,55,713,222",
  page: 4,
  kind: "rect",
  color: null,
  target: { page: 4, rect: [13, 55, 713, 222] },
  text: "",
  before: "",
  after: "",
  origins: ["classes/HBIO250/Pharmacology.md"],
};

const LITERAL_NOTE = `---
type: topic
class: HBIO250
created: 2026-09-10
source_file: "[[HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf]]"
tags: [hbio250]
---

# Receptors

## Summary
Receptors bind drugs with high affinity and transduce a signal, which is what separates them from inert binding proteins such as albumin; the better the structural fit, the higher the affinity.

## Highlights

> [!PDF|yellow] [[HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf#page=4&selection=2,0,33,19&color=yellow|p.4]]
> > Receptors have 2 important properties: 1. They bind ligands (or drugs) with relatively high affinity, and after they bind a drug… 2. They transduce a signal to produce a biological effect (this property distinguishes receptors from inert binding sites – e.g., albumin – a blood protein that binds/carries many drugs but does not transduce a signal)

![[HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf#page=4&rect=13,55,713,222|p.4]]

## Related topics
- [[Pharmacology]]

## Flashcard Seeds
`;

test("renderTopicNote produces the literal two-highlight note", () => {
  const rendered = tn.renderTopicNote({
    title: "Receptors",
    classCode: "HBIO250",
    created: "2026-09-10",
    pdfBasename: PDF_BASENAME,
    summary: SUMMARY,
    highlights: [SELECTION_HIGHLIGHT, RECT_HIGHLIGHT],
    related: ["Pharmacology"],
  });
  assert.equal(rendered, LITERAL_NOTE);
});

test("parseTopicNote(renderTopicNote(x)) returns the same title, summary, and highlight keys", () => {
  const parsed = tn.parseTopicNote(LITERAL_NOTE);
  assert.equal(parsed.title, "Receptors");
  assert.equal(parsed.classCode, "HBIO250");
  assert.equal(parsed.sourceBasename, PDF_BASENAME);
  assert.equal(parsed.summary, SUMMARY);
  assert.deepEqual(
    parsed.highlights.map((h) => h.key),
    [SELECTION_HIGHLIGHT.key, RECT_HIGHLIGHT.key],
  );
});

test("renderTopicNote groups by ### Page N headings when highlights span more than one page", () => {
  const p5 = {
    ...SELECTION_HIGHLIGHT,
    id: "H06",
    key: "page=5&selection=10,0,12,8",
    page: 5,
    target: { page: 5, selection: { beginIndex: 10, beginOffset: 0, endIndex: 12, endOffset: 8 }, color: "yellow" },
    text: "The better the fit, the higher the affinity",
  };
  const p6 = {
    ...SELECTION_HIGHLIGHT,
    id: "H07",
    key: "page=6&selection=6,0,34,23",
    page: 6,
    target: { page: 6, selection: { beginIndex: 6, beginOffset: 0, endIndex: 34, endOffset: 23 }, color: "yellow" },
    text: "Types of receptors",
  };
  const rendered = tn.renderTopicNote({
    title: "Receptors",
    classCode: "HBIO250",
    created: "2026-09-10",
    pdfBasename: PDF_BASENAME,
    summary: SUMMARY,
    highlights: [SELECTION_HIGHLIGHT, p5, p6],
    related: [],
  });
  assert.ok(rendered.includes("### Page 4\n"));
  assert.ok(rendered.includes("### Page 5\n"));
  assert.ok(rendered.includes("### Page 6\n"));
  const idx4 = rendered.indexOf("### Page 4");
  const idx5 = rendered.indexOf("### Page 5");
  const idx6 = rendered.indexOf("### Page 6");
  assert.ok(idx4 < idx5 && idx5 < idx6);
});

test("mergeTopicHighlights adds only the new highlight, skips the existing one", () => {
  const newHighlight = {
    id: "H06",
    key: "page=5&selection=10,0,12,8",
    page: 5,
    kind: "selection",
    color: "yellow",
    target: { page: 5, selection: { beginIndex: 10, beginOffset: 0, endIndex: 12, endOffset: 8 }, color: "yellow" },
    text: "The better the fit, the higher the affinity",
    before: "",
    after: "",
    origins: ["classes/HBIO250/Pharmacology.md"],
  };
  const result = tn.mergeTopicHighlights(LITERAL_NOTE, PDF_BASENAME, [SELECTION_HIGHLIGHT, newHighlight]);
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 1);

  // The new callout lands at the end of ## Highlights, before ## Related topics.
  const highlightsIdx = result.md.indexOf("## Highlights");
  const relatedIdx = result.md.indexOf("## Related topics");
  const newLinkIdx = result.md.indexOf("page=5&selection=10,0,12,8");
  assert.ok(highlightsIdx < newLinkIdx && newLinkIdx < relatedIdx);

  // Everything outside ## Highlights is unchanged.
  assert.ok(result.md.startsWith(LITERAL_NOTE.slice(0, highlightsIdx)));
  assert.ok(result.md.slice(relatedIdx).startsWith(LITERAL_NOTE.slice(relatedIdx)));
});

test("mergeTopicHighlights inserts ## Highlights before ## Related topics when missing", () => {
  const stagesOfChange = `---
type: topic
class: PHED163
created: 2026-09-07
source_file: "[[Module 3 - CH 3 Video Assignments (2) - Conrad Ragsdale.pdf]]"
tags: [phed163]
---

# The five stages of change

## Summary
The five stages of behavior change, what defines each, and what the coach does in each.

## Key claims
- Precontemplation: the client has no intention of changing in the foreseeable future. — [[Module 3 - CH 3 Video Assignments (2) - Conrad Ragsdale.pdf#page=1|p.1]]

## Related topics
- [[Decisional Balance and Processes of Change]]
- [[Empowering Behavior Change]]

## Flashcard Seeds
`;
  const highlight = {
    id: "H01",
    key: "page=3&selection=0,0,5,0",
    page: 3,
    kind: "selection",
    color: "yellow",
    target: { page: 3, selection: { beginIndex: 0, beginOffset: 0, endIndex: 5, endOffset: 0 }, color: "yellow" },
    text: "New highlight",
    before: "",
    after: "",
    origins: ["classes/PHED163/Stages of Change.md"],
  };
  const result = tn.mergeTopicHighlights(stagesOfChange, "Module 3 - CH 3 Video Assignments (2) - Conrad Ragsdale", [highlight]);
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 0);
  assert.ok(result.md.includes("## Highlights"));
  const highlightsIdx = result.md.indexOf("## Highlights");
  const relatedIdx = result.md.indexOf("## Related topics");
  const keyClaimsIdx = result.md.indexOf("## Key claims");
  assert.ok(keyClaimsIdx < highlightsIdx);
  assert.ok(highlightsIdx < relatedIdx);
  assert.ok(result.md.includes("page=3&selection=0,0,5,0"));
});

function manifestFor(highlights) {
  return {
    pdfPath: "sources/class notes/HBIO250/" + PDF_BASENAME + ".pdf",
    pdfBasename: PDF_BASENAME,
    classCode: "HBIO250",
    extracted: "2026-09-10T15:04:00",
    sources: [],
    highlights,
  };
}

test("planTopicNotes reports unknownIds and keeps the note", () => {
  const draft = {
    notes: [{ title: "Receptors", summary: "S", highlight_ids: ["H01", "H99"], related: [] }],
    unused_ids: [],
  };
  const manifest = manifestFor([{ ...SELECTION_HIGHLIGHT, id: "H01" }]);
  const result = tn.planTopicNotes(draft, manifest, {
    classCode: "HBIO250",
    topicFolder: "classes",
    created: "2026-09-10",
    existing: {},
  });
  assert.deepEqual(result.unknownIds, ["H99"]);
  assert.equal(result.notes.length, 1);
  assert.equal(result.notes[0].title, "Receptors");
});

test("planTopicNotes drops a note whose only id is unknown", () => {
  const draft = {
    notes: [{ title: "Ghost", summary: "S", highlight_ids: ["H99"], related: [] }],
    unused_ids: [],
  };
  const manifest = manifestFor([{ ...SELECTION_HIGHLIGHT, id: "H01" }]);
  const result = tn.planTopicNotes(draft, manifest, {
    classCode: "HBIO250",
    topicFolder: "classes",
    created: "2026-09-10",
    existing: {},
  });
  assert.equal(result.droppedNotes, 1);
  assert.equal(result.notes.length, 0);
});

test("planTopicNotes merges duplicate titles case-insensitively", () => {
  const draft = {
    notes: [
      { title: "Receptors", summary: "S1", highlight_ids: ["H01"], related: [] },
      { title: "receptors", summary: "S2", highlight_ids: ["H02"], related: [] },
    ],
    unused_ids: [],
  };
  const manifest = manifestFor([
    { ...SELECTION_HIGHLIGHT, id: "H01", key: "page=4&selection=2,0,33,19" },
    { ...SELECTION_HIGHLIGHT, id: "H02", key: "page=5&selection=10,0,12,8", page: 5, target: { page: 5, selection: { beginIndex: 10, beginOffset: 0, endIndex: 12, endOffset: 8 }, color: "yellow" } },
  ]);
  const result = tn.planTopicNotes(draft, manifest, {
    classCode: "HBIO250",
    topicFolder: "classes",
    created: "2026-09-10",
    existing: {},
  });
  assert.equal(result.notes.length, 1);
  assert.equal(result.notes[0].highlights.length, 2);
});

test("planTopicNotes reports an id in no note and not in unused_ids as unassignedIds", () => {
  const draft = {
    notes: [{ title: "Receptors", summary: "S", highlight_ids: ["H01"], related: [] }],
    unused_ids: [],
  };
  const manifest = manifestFor([
    { ...SELECTION_HIGHLIGHT, id: "H01" },
    { ...RECT_HIGHLIGHT, id: "H02" },
  ]);
  const result = tn.planTopicNotes(draft, manifest, {
    classCode: "HBIO250",
    topicFolder: "classes",
    created: "2026-09-10",
    existing: {},
  });
  assert.deepEqual(result.unassignedIds, ["H02"]);
});

test("safeTitle strips illegal characters and falls back to Untitled", () => {
  assert.equal(tn.safeTitle('Foo/Bar:Baz*?"<>|#^[]'), "FooBarBaz");
  assert.equal(tn.safeTitle("   "), "Untitled");
  assert.equal(tn.safeTitle(""), "Untitled");
});

// ---- wiki notes

function wikiHighlight(overrides) {
  return {
    id: "H01",
    key: "page=4&selection=2,0,33,19",
    page: 4,
    kind: "selection",
    color: "yellow",
    target: { page: 4, selection: { beginIndex: 2, beginOffset: 0, endIndex: 33, endOffset: 19 }, color: "yellow" },
    text: "Some highlight text",
    before: "",
    after: "",
    origins: ["classes/HBIO250/Pharmacology.md"],
    ...overrides,
  };
}

test("renderWikiNote renders sorted highlights with a summary", () => {
  const p4 = wikiHighlight({
    id: "H04",
    key: "page=4&selection=2,0,33,19",
    page: 4,
    target: { page: 4, selection: { beginIndex: 2, beginOffset: 0, endIndex: 33, endOffset: 19 }, color: "yellow" },
    text: "Page four text",
  });
  const p2 = wikiHighlight({
    id: "H02",
    key: "page=2&selection=1,0,5,0",
    page: 2,
    target: { page: 2, selection: { beginIndex: 1, beginOffset: 0, endIndex: 5, endOffset: 0 }, color: "yellow" },
    text: "Page two text",
  });

  const rendered = tn.renderWikiNote({
    classCode: "HBIO250",
    pdfBasename: PDF_BASENAME,
    summary: "S.",
    highlights: [p4, p2],
  });

  const expected = `---
class: HBIO250
---

## Summary
S.

## Highlights

> [!PDF|yellow] [[${PDF_BASENAME}.pdf#page=2&selection=1,0,5,0&color=yellow|${PDF_BASENAME}, p.2]]
> > Page two text

> [!PDF|yellow] [[${PDF_BASENAME}.pdf#page=4&selection=2,0,33,19&color=yellow|${PDF_BASENAME}, p.4]]
> > Page four text
`;
  assert.equal(rendered, expected);
  const calloutLines = rendered.split("\n").filter((l) => l.startsWith("> [!PDF"));
  assert.ok(calloutLines[0].includes(`|${PDF_BASENAME}, p.2]]`));
});

test("renderWikiNote omits the Summary section when summary is empty", () => {
  const p4 = wikiHighlight();
  const rendered = tn.renderWikiNote({
    classCode: "HBIO250",
    pdfBasename: PDF_BASENAME,
    summary: "",
    highlights: [p4],
  });
  assert.ok(!rendered.includes("## Summary"));
  assert.ok(rendered.startsWith("---\nclass: HBIO250\n---\n\n## Highlights\n\n"));
});

test("mergeWikiHighlights dedupes against a link under an arbitrary heading with no ## Highlights section", () => {
  const existing = `**Potency**

## Receptors
Some prose here. [[${PDF_BASENAME}.pdf#page=4&selection=2,0,33,19&color=yellow|${PDF_BASENAME}, p.4]] continues the sentence.
`;
  const existingHighlight = wikiHighlight();
  const newHighlight = wikiHighlight({
    id: "H02",
    key: "page=6&selection=0,0,3,0",
    page: 6,
    target: { page: 6, selection: { beginIndex: 0, beginOffset: 0, endIndex: 3, endOffset: 0 }, color: "yellow" },
    text: "Brand new text",
  });

  const result = tn.mergeWikiHighlights(existing, PDF_BASENAME, "HBIO250", [existingHighlight, newHighlight]);
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 1);

  const expectedNewCallout = `> [!PDF|yellow] [[${PDF_BASENAME}.pdf#page=6&selection=0,0,3,0&color=yellow|${PDF_BASENAME}, p.6]]\n> > Brand new text`;
  const expectedTail = `\n\n## Highlights\n\n${expectedNewCallout}\n`;
  assert.ok(result.md.endsWith(expectedTail));

  const existingTrimmed = existing.replace(/\n*$/, "");
  assert.ok(result.md.startsWith(existingTrimmed));
  assert.equal(result.md, existingTrimmed + expectedTail);
});

test("mergeWikiHighlights leaves a note with no frontmatter unchanged apart from the append", () => {
  const existing = `**Potency**

Some other content.
`;
  const highlight = wikiHighlight();
  const result = tn.mergeWikiHighlights(existing, PDF_BASENAME, "HBIO250", [highlight]);
  assert.equal(result.md.split("\n")[0], "**Potency**");
  assert.ok(!result.md.startsWith("---"));
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 0);
});

test("mergeWikiHighlights on an empty note renders a fresh wiki note", () => {
  const h1 = wikiHighlight();
  const h2 = wikiHighlight({
    id: "H02",
    key: "page=6&selection=0,0,3,0",
    page: 6,
    target: { page: 6, selection: { beginIndex: 0, beginOffset: 0, endIndex: 3, endOffset: 0 }, color: "yellow" },
    text: "Another one",
  });
  const result = tn.mergeWikiHighlights("", PDF_BASENAME, "HBIO250", [h1, h2]);
  assert.ok(result.md.startsWith("---\nclass: HBIO250\n---\n\n## Highlights"));
  assert.equal(result.added, 2);
  assert.equal(result.skipped, 0);
});

test("mergeWikiHighlights inserts the new callout inside an existing Highlights section, before a later section", () => {
  const existing = `---
class: HBIO250
---

## Highlights

> [!PDF|yellow] [[${PDF_BASENAME}.pdf#page=4&selection=2,0,33,19&color=yellow|${PDF_BASENAME}, p.4]]
> > Some highlight text

## Notes
Some unrelated notes.
`;
  const newHighlight = wikiHighlight({
    id: "H02",
    key: "page=6&selection=0,0,3,0",
    page: 6,
    target: { page: 6, selection: { beginIndex: 0, beginOffset: 0, endIndex: 3, endOffset: 0 }, color: "yellow" },
    text: "New text",
  });
  const result = tn.mergeWikiHighlights(existing, PDF_BASENAME, "HBIO250", [wikiHighlight(), newHighlight]);
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 1);

  const highlightsIdx = result.md.indexOf("## Highlights");
  const notesIdx = result.md.indexOf("## Notes");
  const newLinkIdx = result.md.indexOf("page=6&selection=0,0,3,0");
  assert.ok(highlightsIdx < newLinkIdx && newLinkIdx < notesIdx);
});
