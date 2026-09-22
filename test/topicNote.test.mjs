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
type: concept
class: HBIO250
created: 2026-09-10
source_file: "[[HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf]]"
tags: [term]
aliases:
  - "Drug Receptors"
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
    kind: "concept",
    tag: "term",
    aliases: ["Drug Receptors"],
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
    kind: "concept",
    tag: "term",
    aliases: [],
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
    pages: [],
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
    pages: [],
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
    pages: [],
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
    pages: [],
  });
  assert.deepEqual(result.unassignedIds, ["H02"]);
});

test("renderTopicNote writes a class list when a page belongs to two classes, and addClassCode grows it", () => {
  const md = tn.renderTopicNote({ title: "Muscle", classCode: "HBIO408", classCodes: ["HBIO408", "PHED163"], created: "2026-09-17", pdfBasename: "P", summary: "S", highlights: [], related: [], kind: "concept", tag: "term", aliases: [] });
  assert.ok(md.includes("class: [HBIO408, PHED163]"));
  assert.ok(!md.includes("aliases:"), "no aliases, no key");
  const scalar = "---\ntype: concept\nclass: HBIO408\ncreated: 2026-09-17\n---\n# Muscle\n";
  assert.ok(tn.addClassCode(scalar, "PHED163").includes("class: [HBIO408, PHED163]"));
  assert.equal(tn.addClassCode(scalar, "HBIO408"), scalar, "already there: byte-identical");
  const list = "---\nclass: [HBIO408, PHED163]\n---\n";
  assert.ok(tn.addClassCode(list, "PSYC360").includes("class: [HBIO408, PHED163, PSYC360]"));
  assert.ok(tn.addClassCode("---\ntype: concept\n---\n# M\n", "PHED163").includes("class: PHED163"), "a page with no class gains one");
});

test("planTopicNotes merges into a page from another class by alias and appends the class", () => {
  const other = {
    path: "classes/HBIO408/Skeletal Muscle.md",
    title: "Skeletal Muscle",
    kind: "concept",
    aliases: ["Muscle Fibres"],
    classCodes: ["HBIO408"],
    md: "---\ntype: concept\nclass: HBIO408\ncreated: 2026-09-10\n---\n\n# Skeletal Muscle\n\n## Summary\nS.\n\n## Highlights\n\n## Related topics\n",
  };
  const manifest = { pdfPath: "sources/class notes/PHED163/Deck.pdf", pdfBasename: "Deck", classCode: "PHED163", extracted: "", sources: [], highlights: [SELECTION_HIGHLIGHT] };
  const draft = {
    notes: [{ title: "Muscle Fibres", kind: "concept", aliases: [], tag: "term", closest_existing: "", why_new: "", summary: "S.", highlight_ids: ["H04"], related: [] }],
    unused_ids: [],
  };
  const out = tn.planTopicNotes(draft, manifest, { classCode: "PHED163", topicFolder: "classes", created: "2026-09-17", pages: [other] });
  assert.equal(out.notes.length, 1);
  assert.equal(out.notes[0].path, other.path, "the alias found the page in the other class");
  assert.equal(out.notes[0].exists, true);
  assert.ok(out.notes[0].content.includes("class: [HBIO408, PHED163]"), out.notes[0].content);
});

test("planTopicNotes files a new title that names a home into that page under a heading, and creates one that has none", () => {
  const home = {
    path: "classes/HBIO250/Pharmacology.md",
    title: "Pharmacology",
    kind: "concept",
    aliases: [],
    classCodes: ["HBIO250"],
    md: "---\ntype: concept\nclass: HBIO250\n---\n\n# Pharmacology\n\n## Summary\nS.\n\n## Highlights\n\n## Related topics\n",
  };
  const manifest = { pdfPath: "sources/class notes/HBIO250/Deck.pdf", pdfBasename: "Deck", classCode: "HBIO250", extracted: "", sources: [], highlights: [SELECTION_HIGHLIGHT, { ...RECT_HIGHLIGHT, text: "Aspirin inhibits COX." }] };
  const draft = {
    notes: [
      { title: "COX Inhibitors", kind: "concept", aliases: ["NSAIDs"], tag: "term", closest_existing: "Pharmacology", why_new: "part of pharmacology", summary: "S.", highlight_ids: ["H05"], related: [] },
      { title: "Self-Efficacy", kind: "concept", aliases: ["Self-efficacy belief"], tag: "term", closest_existing: "", why_new: "nothing listed is about beliefs", summary: "A belief.", highlight_ids: ["H04"], related: [] },
    ],
    unused_ids: [],
  };
  const out = tn.planTopicNotes(draft, manifest, { classCode: "HBIO250", topicFolder: "classes", created: "2026-09-17", pages: [home] });
  const filed = out.notes.find((n) => n.path === home.path);
  assert.ok(filed, "COX Inhibitors was filed into Pharmacology");
  assert.ok(tn.noteSections(filed.content).includes("COX Inhibitors"), "under a heading named after the proposal");
  assert.deepEqual(filed.routed.map((r) => [r.from, r.heading]), [["COX Inhibitors", "COX Inhibitors"]]);
  const created = out.notes.find((n) => n.title === "Self-Efficacy");
  assert.equal(created.exists, false);
  assert.equal(created.path, "classes/HBIO250/Self-Efficacy.md");
  assert.equal(created.whyNew, "nothing listed is about beliefs");
  assert.ok(created.content.includes("type: concept"));
  assert.ok(created.content.includes('- "Self-efficacy belief"'));
  assert.ok(created.content.includes("tags: [term]"));
});

test("planTopicNotes gives one row per page when two proposals are filed into the same home", () => {
  const home = {
    path: "classes/HBIO250/Pharmacology.md",
    title: "Pharmacology",
    kind: "concept",
    aliases: [],
    classCodes: ["HBIO250"],
    md: "---\ntype: concept\nclass: HBIO250\n---\n\n# Pharmacology\n\n## Summary\nS.\n\n## Highlights\n\n## Related topics\n",
  };
  const manifest = {
    pdfPath: "sources/class notes/HBIO250/Deck.pdf",
    pdfBasename: "Deck",
    classCode: "HBIO250",
    extracted: "",
    sources: [],
    highlights: [SELECTION_HIGHLIGHT, { ...RECT_HIGHLIGHT, text: "Aspirin inhibits COX." }],
  };
  const draft = {
    notes: [
      { title: "COX Inhibitors", kind: "concept", aliases: [], tag: "term", closest_existing: "Pharmacology", why_new: "part of pharmacology", summary: "S.", highlight_ids: ["H05"], related: [] },
      { title: "Beta Blockers", kind: "concept", aliases: [], tag: "term", closest_existing: "Pharmacology", why_new: "part of pharmacology", summary: "B.", highlight_ids: ["H04"], related: [] },
    ],
    unused_ids: [],
  };
  const out = tn.planTopicNotes(draft, manifest, { classCode: "HBIO250", topicFolder: "classes", created: "2026-09-17", pages: [home] });
  const rows = out.notes.filter((n) => n.path === home.path);
  assert.equal(rows.length, 1, "one page, one row");
  assert.equal(rows[0].added, 2, "both proposals' highlights counted");
  assert.deepEqual(rows[0].routed.map((r) => r.from), ["COX Inhibitors", "Beta Blockers"]);
  assert.ok(tn.noteSections(rows[0].content).includes("COX Inhibitors"), rows[0].content);
  assert.ok(tn.noteSections(rows[0].content).includes("Beta Blockers"), rows[0].content);
  assert.equal(rows[0].highlights.length, 2, "the union of both groups' highlights");
});

// ---- applyDigestChoices: the preview's checkboxes and renames, by group
//
// The digest's write filter used to be keyed by title, which stopped matching
// the plan once coalescing made `path` the unique key of a row. These pin the
// group-keyed narrowing the digest now does instead.

const HOME_PHARM = {
  path: "classes/HBIO250/Pharmacology.md",
  title: "Pharmacology",
  kind: "concept",
  aliases: [],
  classCodes: ["HBIO250"],
  md: "---\ntype: concept\nclass: HBIO250\n---\n\n# Pharmacology\n\n## Summary\nS.\n\n## Highlights\n\n## Related topics\n",
};

function twoHighlightManifest() {
  return {
    pdfPath: "sources/class notes/HBIO250/Deck.pdf",
    pdfBasename: "Deck",
    classCode: "HBIO250",
    extracted: "",
    sources: [],
    highlights: [SELECTION_HIGHLIGHT, { ...RECT_HIGHLIGHT, text: "Aspirin inhibits COX." }],
  };
}

const DIGEST_OPTS = { classCode: "HBIO250", topicFolder: "classes", created: "2026-09-17" };

test("applyDigestChoices drops both groups filed into one home when that row is unchecked", () => {
  const manifest = twoHighlightManifest();
  const draft = {
    notes: [
      { title: "COX Inhibitors", kind: "concept", aliases: [], tag: "term", closest_existing: "Pharmacology", why_new: "part of pharmacology", summary: "S.", highlight_ids: ["H05"], related: [] },
      { title: "Beta Blockers", kind: "concept", aliases: [], tag: "term", closest_existing: "Pharmacology", why_new: "part of pharmacology", summary: "B.", highlight_ids: ["H04"], related: [] },
    ],
    unused_ids: [],
  };
  const planned = tn.planTopicNotes(draft, manifest, { ...DIGEST_OPTS, pages: [HOME_PHARM] });
  assert.equal(planned.notes.length, 1, "coalesced into one row");
  const { draft: narrowed, keepAsNew } = tn.applyDigestChoices(draft, planned.notes, []);
  assert.deepEqual(narrowed.notes, [], "neither group survives an unchecked row");
  assert.deepEqual(narrowed.unused_ids, draft.unused_ids);
  assert.deepEqual(keepAsNew, [], "no row was kept, so nothing is pinned as new");
});

test("applyDigestChoices renames a checked new row's one group, and re-planning moves the page", () => {
  const manifest = twoHighlightManifest();
  const draft = {
    notes: [
      { title: "Self-Efficacy", kind: "concept", aliases: [], tag: "term", closest_existing: "", why_new: "nothing listed is about beliefs", summary: "A belief.", highlight_ids: ["H04"], related: [] },
    ],
    unused_ids: [],
  };
  const planned = tn.planTopicNotes(draft, manifest, { ...DIGEST_OPTS, pages: [] });
  assert.equal(planned.notes[0].exists, false);
  const { draft: narrowed, keepAsNew } = tn.applyDigestChoices(draft, planned.notes, [{ path: planned.notes[0].path, title: "Self Efficacy Beliefs" }]);
  assert.equal(narrowed.notes.length, 1);
  assert.equal(narrowed.notes[0].title, "Self Efficacy Beliefs");
  assert.deepEqual(keepAsNew, ["Self Efficacy Beliefs"], "a row accepted as new stays new");
  const replanned = tn.planTopicNotes(narrowed, manifest, { ...DIGEST_OPTS, pages: [], keepAsNew });
  assert.equal(replanned.notes[0].path, "classes/HBIO250/Self Efficacy Beliefs.md");
});

test("applyDigestChoices keeps an unchecked merged group out even when another row is renamed onto its page", () => {
  const manifest = twoHighlightManifest();
  const draft = {
    notes: [
      { title: "Pharmacology", kind: "concept", aliases: [], tag: "term", closest_existing: "", why_new: "", summary: "S.", highlight_ids: ["H05"], related: [] },
      { title: "Self-Efficacy", kind: "concept", aliases: [], tag: "term", closest_existing: "", why_new: "a belief", summary: "A belief.", highlight_ids: ["H04"], related: [] },
    ],
    unused_ids: [],
  };
  const planned = tn.planTopicNotes(draft, manifest, { ...DIGEST_OPTS, pages: [HOME_PHARM] });
  const merged = planned.notes.find((n) => n.path === HOME_PHARM.path);
  const fresh = planned.notes.find((n) => n.exists === false);
  assert.ok(merged && fresh);
  // The merged row is unticked; the new row is renamed to the merged page's title.
  const { draft: narrowed } = tn.applyDigestChoices(draft, planned.notes, [{ path: fresh.path, title: "Pharmacology" }]);
  const titles = narrowed.notes.map((n) => n.title);
  assert.deepEqual(titles, ["Pharmacology"], "only the renamed group survives");
  assert.deepEqual(narrowed.notes[0].highlight_ids, ["H04"], "the unchecked group's highlights are gone");
});

test("applyDigestChoices ignores an edit to an existing row's title", () => {
  const manifest = twoHighlightManifest();
  const draft = {
    notes: [
      { title: "Pharmacology", kind: "concept", aliases: [], tag: "term", closest_existing: "", why_new: "", summary: "S.", highlight_ids: ["H05"], related: [] },
    ],
    unused_ids: [],
  };
  const planned = tn.planTopicNotes(draft, manifest, { ...DIGEST_OPTS, pages: [HOME_PHARM] });
  assert.equal(planned.notes[0].exists, true);
  const { draft: narrowed, keepAsNew } = tn.applyDigestChoices(draft, planned.notes, [{ path: planned.notes[0].path, title: "Pharmacology Renamed" }]);
  assert.equal(narrowed.notes.length, 1);
  assert.equal(narrowed.notes[0].title, "Pharmacology", "the page's name is the page's");
  assert.deepEqual(keepAsNew, [], "a merge row is not pinned as new");
});

test("a row accepted as new is written as a new page even when the rename specializes an existing title", () => {
  const manifest = twoHighlightManifest();
  const RECEPTORS = {
    path: "classes/HBIO250/Receptors.md",
    title: "Receptors",
    kind: "concept",
    aliases: [],
    classCodes: ["HBIO250"],
    md: "---\ntype: concept\nclass: HBIO250\n---\n\n# Receptors\n\n## Summary\nS.\n\n## Highlights\n\n## Related topics\n",
  };
  const draft = {
    notes: [
      { title: "Brand New Topic", kind: "concept", aliases: [], tag: "term", closest_existing: "", why_new: "nothing covers it", summary: "S.", highlight_ids: ["H04"], related: [] },
    ],
    unused_ids: [],
  };
  const planned = tn.planTopicNotes(draft, manifest, { ...DIGEST_OPTS, pages: [RECEPTORS] });
  assert.equal(planned.notes[0].exists, false, "the preview offered to create a new page");

  // The reader accepts the new page and renames it to a title that happens to
  // contain every word of an existing page's title.
  const { draft: narrowed, keepAsNew } = tn.applyDigestChoices(draft, planned.notes, [
    { path: planned.notes[0].path, title: "Receptor Subtypes" },
  ]);
  assert.deepEqual(keepAsNew, ["Receptor Subtypes"]);

  const replanned = tn.planTopicNotes(narrowed, manifest, { ...DIGEST_OPTS, pages: [RECEPTORS], keepAsNew });
  assert.equal(replanned.notes.length, 1);
  assert.equal(replanned.notes[0].exists, false, "what the reader accepted as new must not merge into an existing page");
  assert.equal(replanned.notes[0].path, "classes/HBIO250/Receptor Subtypes.md");
  assert.equal(replanned.notes[0].path !== RECEPTORS.path, true, "the existing page is untouched");
});

test("without keepAsNew the specialization rule still routes a plain proposal into its home", () => {
  const manifest = twoHighlightManifest();
  const RECEPTORS = {
    path: "classes/HBIO250/Receptors.md",
    title: "Receptors",
    kind: "concept",
    aliases: [],
    classCodes: ["HBIO250"],
    md: "---\ntype: concept\nclass: HBIO250\n---\n\n# Receptors\n\n## Summary\nS.\n\n## Highlights\n\n## Related topics\n",
  };
  const draft = {
    notes: [
      { title: "Receptor Subtypes", kind: "concept", aliases: [], tag: "term", closest_existing: "", why_new: "", summary: "S.", highlight_ids: ["H04"], related: [] },
    ],
    unused_ids: [],
  };
  const planned = tn.planTopicNotes(draft, manifest, { ...DIGEST_OPTS, pages: [RECEPTORS] });
  assert.equal(planned.notes[0].exists, true, "routing is unchanged when the reader has not pinned the title");
  assert.equal(planned.notes[0].path, RECEPTORS.path);
});

test("planTopicNotes records the draft groups each row came from", () => {
  const manifest = twoHighlightManifest();
  const draft = {
    notes: [
      { title: "COX Inhibitors", kind: "concept", aliases: [], tag: "term", closest_existing: "Pharmacology", why_new: "part of pharmacology", summary: "S.", highlight_ids: ["H05"], related: [] },
      { title: "Beta Blockers", kind: "concept", aliases: [], tag: "term", closest_existing: "Pharmacology", why_new: "part of pharmacology", summary: "B.", highlight_ids: ["H04"], related: [] },
    ],
    unused_ids: [],
  };
  const coalesced = tn.planTopicNotes(draft, manifest, { ...DIGEST_OPTS, pages: [HOME_PHARM] });
  assert.deepEqual(coalesced.notes[0].groups, ["COX Inhibitors", "Beta Blockers"], "a coalesced row lists both");

  const alone = tn.planTopicNotes(draft, manifest, { ...DIGEST_OPTS, pages: [] });
  assert.deepEqual(alone.notes.map((n) => n.groups), [["COX Inhibitors"], ["Beta Blockers"]]);
});

test("planTopicNotes merges into the same-named page in the run's own class", () => {
  const pageA = {
    path: "classes/AAA/Receptors.md",
    title: "Receptors",
    kind: "concept",
    aliases: [],
    classCodes: ["AAA"],
    md: "---\ntype: concept\nclass: AAA\n---\n\n# Receptors\n\n## Summary\nA.\n\n## Highlights\n\n## Related topics\n",
  };
  const pageB = { ...pageA, path: "classes/BBB/Receptors.md", classCodes: ["BBB"], md: pageA.md.replace("class: AAA", "class: BBB") };
  const manifest = twoHighlightManifest();
  const draft = {
    notes: [{ title: "Receptors", kind: "concept", aliases: [], tag: "term", closest_existing: "", why_new: "", summary: "S.", highlight_ids: ["H04"], related: [] }],
    unused_ids: [],
  };
  const out = tn.planTopicNotes(draft, manifest, { classCode: "BBB", topicFolder: "classes", created: "2026-09-17", pages: [pageA, pageB] });
  assert.equal(out.notes.length, 1);
  assert.equal(out.notes[0].path, pageB.path, "the run's own class wins the merge");
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

- Page two text [[${PDF_BASENAME}.pdf#page=2&selection=1,0,5,0&color=yellow|p.2]]
- Page four text [[${PDF_BASENAME}.pdf#page=4&selection=2,0,33,19&color=yellow|p.4]]
`;
  assert.equal(rendered, expected);
  // Two rows are one list: consecutive lines, no blank line splitting them.
  assert.ok(!rendered.includes("p.2]]\n\n- Page four"));
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

  const expectedNewCallout = `- Brand new text [[${PDF_BASENAME}.pdf#page=6&selection=0,0,3,0&color=yellow|p.6]]`;
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

test("mergeWikiHighlights inserts a missing ## Highlights section before ## Related topics, ahead of ## Flashcard Seeds", () => {
  const existing = `---
class: PHED163
---

## Summary
S.

## Key claims
- a

## Related topics
- [[X]]

## Flashcard Seeds
`;
  const highlight = wikiHighlight();
  const result = tn.mergeWikiHighlights(existing, PDF_BASENAME, "PHED163", [highlight]);
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 0);

  const keyClaimsIdx = existing.indexOf("## Key claims");
  const beforeNewSection = result.md.slice(0, keyClaimsIdx + "## Key claims\n- a\n".length);
  assert.equal(beforeNewSection, existing.slice(0, keyClaimsIdx + "## Key claims\n- a\n".length));

  const highlightsIdx = result.md.indexOf("## Highlights");
  const relatedIdx = result.md.indexOf("## Related topics");
  const seedsIdx = result.md.indexOf("## Flashcard Seeds");
  assert.ok(keyClaimsIdx < highlightsIdx);
  assert.ok(highlightsIdx < relatedIdx);
  assert.ok(relatedIdx < seedsIdx);
  assert.ok(result.md.slice(relatedIdx).startsWith(existing.slice(existing.indexOf("## Related topics"))));
});

test("mergeWikiHighlights inserts a missing ## Highlights section before ## Flashcard Seeds when that is the only trailing heading", () => {
  const existing = `---
class: PHED163
---

## Summary
S.

## Flashcard Seeds
`;
  const highlight = wikiHighlight();
  const result = tn.mergeWikiHighlights(existing, PDF_BASENAME, "PHED163", [highlight]);
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 0);

  const highlightsIdx = result.md.indexOf("## Highlights");
  const seedsIdx = result.md.indexOf("## Flashcard Seeds");
  assert.ok(highlightsIdx < seedsIdx);
  assert.ok(result.md.slice(seedsIdx).startsWith(existing.slice(existing.indexOf("## Flashcard Seeds"))));
});

test("mergeWikiHighlights inserts a missing ## Highlights section before ## Related topics when there is no ## Flashcard Seeds", () => {
  const existing = `---
class: PHED163
---

## Summary
S.

## Related topics
- [[X]]
`;
  const highlight = wikiHighlight();
  const result = tn.mergeWikiHighlights(existing, PDF_BASENAME, "PHED163", [highlight]);
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 0);

  const highlightsIdx = result.md.indexOf("## Highlights");
  const relatedIdx = result.md.indexOf("## Related topics");
  assert.ok(highlightsIdx < relatedIdx);
  assert.ok(result.md.slice(relatedIdx).startsWith(existing.slice(existing.indexOf("## Related topics"))));
});

// ---- the dispatcher, and the karpathy merge rules
//
// The renderer existed before these tests and had no callers, so the suite was
// green while the format collision it exists to end was still live. These
// exercise the path a digest actually takes.

// `key` must be the real `highlightKey(target)` — the merge re-derives it from
// the callouts already on the page, so a made-up key would never match and the
// duplicate check would look broken when it is not.
const HL = (page, n) => ({
  page,
  text: `span ${n}`,
  key: `page=${page}&selection=0,0,0,4`,
  target: { page, selection: { beginIndex: 0, beginOffset: 0, endIndex: 0, endOffset: 4 }, color: "yellow" },
});

test("renderWikiNote defaults to the class schema", () => {
  const md = tn.renderWikiNote({ classCode: "HBIO408", pdfBasename: "P", summary: "s", highlights: [] });
  assert.ok(md.includes("class: HBIO408"));
  assert.ok(md.includes("## Highlights"));
  assert.ok(!md.includes("type: concept"));
});

test("renderWikiNote dispatches to the karpathy schema when asked", () => {
  const md = tn.renderWikiNote({
    classCode: "HBIO408",
    pdfBasename: "P",
    summary: "What it means.",
    highlights: [],
    schema: "karpathy",
    title: "Angular Kinematics",
    kind: "concept",
    today: "2026-09-15",
  });
  assert.ok(md.includes("type: concept"), "the karpathy renderer ran");
  assert.ok(md.includes("# Angular Kinematics"));
  assert.ok(md.includes("## Definition"));
  assert.ok(md.includes("What it means."));
  assert.ok(!md.includes("class:"), "the two schemas never mix in one page");
});

test("an entity dispatches to the entity shape", () => {
  const md = tn.renderWikiNote({
    classCode: "",
    pdfBasename: "P",
    summary: "Who they are.",
    highlights: [],
    schema: "karpathy",
    title: "Piotr Wozniak",
    kind: "entity",
    today: "2026-09-15",
  });
  assert.ok(md.includes("type: entity"));
  assert.ok(md.includes("## Description"));
  assert.ok(!md.includes("## Key Characteristics"));
});

const KARPATHY_PAGE_NO_SOURCES = `---
type: concept
created: 2026-09-01
updated: 2026-09-01
tags: [theory]
aliases:
  - "Kept Alias"
generation_complete: true
---


# Chunking

## Definition
Text.

## Mentions in Source

`;

const KARPATHY_PAGE = `---
type: concept
created: 2026-09-01
updated: 2026-09-01
sources:
  - "[[sources/first]]"
tags: [theory]
aliases:
  - "Kept Alias"
generation_complete: true
---


# Chunking

## Definition
Text.

## Mentions in Source

`;

test("a karpathy merge appends under Mentions in Source, not Highlights", () => {
  const r = tn.mergeWikiHighlights(KARPATHY_PAGE, "Paper", "", [HL(2, "a")], { schema: "karpathy", today: "2026-09-15" });
  assert.equal(r.added, 1);
  assert.ok(r.md.includes("## Mentions in Source"));
  assert.ok(!r.md.includes("## Highlights"), "a second section would not match the page's own schema");
  assert.ok(r.md.includes("- span a [[Paper.pdf#page=2&selection=0,0,0,4&color=yellow|p.2]]"));
});

test("a merge keeps created and moves updated", () => {
  const r = tn.mergeWikiHighlights(KARPATHY_PAGE, "Paper", "", [HL(2, "a")], { schema: "karpathy", today: "2026-09-15" });
  assert.ok(r.md.includes("created: 2026-09-01"), "created is never rewritten");
  assert.ok(r.md.includes("updated: 2026-09-15"), "updated always moves");
});

test("a page's sources are its callouts, not a frontmatter key", () => {
  // A callout links the PDF at the exact span it came from, so it can be
  // clicked and checked. A frontmatter wikilink is a second, weaker copy of
  // the same claim and is the copy that rots.
  const md = tn.renderWikiNote({
    classCode: "",
    pdfBasename: "Paper",
    summary: "Text.",
    highlights: [HL(2, 1)],
    schema: "karpathy",
    title: "Chunking",
    kind: "concept",
    today: "2026-09-15",
  });
  assert.ok(!md.includes("sources:"), "no sources key is written");
  assert.ok(md.includes("[[Paper.pdf#page=2"), "the callout carries the link back to the PDF");
});

test("a merge does not add a sources key to a page that has none", () => {
  const r = tn.mergeWikiHighlights(KARPATHY_PAGE_NO_SOURCES, "Paper", "", [HL(2, 1)], {
    schema: "karpathy",
    today: "2026-09-15",
  });
  assert.equal(r.added, 1);
  assert.ok(!r.md.includes("sources:"));
});

test("a sources key a reader wrote by hand is left alone", () => {
  // Nothing emits one now, but a page that already has one is theirs.
  const r = tn.mergeWikiHighlights(KARPATHY_PAGE, "Paper", "", [HL(2, 1)], { schema: "karpathy", today: "2026-09-15" });
  assert.ok(r.md.includes("[[sources/first]]"), "an existing key survives untouched");
});

test("a source already listed is not added twice", () => {
  const r = tn.mergeWikiHighlights(KARPATHY_PAGE, "Paper", "", [HL(2, "a")], {
    schema: "karpathy",
    sources: ["sources/first"],
    today: "2026-09-15",
  });
  assert.equal(r.md.match(/sources\/first/g).length, 1);
});

test("an alias the reader added by hand survives a merge", () => {
  const r = tn.mergeWikiHighlights(KARPATHY_PAGE, "Paper", "", [HL(2, "a")], { schema: "karpathy", today: "2026-09-15" });
  assert.ok(r.md.includes('- "Kept Alias"'));
});

test("reviewed: true leaves every frontmatter line alone", () => {
  const reviewed = KARPATHY_PAGE.replace("generation_complete: true", "reviewed: true\ngeneration_complete: true");
  const r = tn.mergeWikiHighlights(reviewed, "Paper", "", [HL(2, "a")], {
    schema: "karpathy",
    sources: ["sources/second"],
    today: "2026-09-15",
  });
  // Highlights are still appended — that is additive, and the point of a merge.
  assert.equal(r.added, 1);
  assert.ok(r.md.includes("updated: 2026-09-01"), "updated does not move on a reviewed page");
  assert.ok(!r.md.includes("sources/second"), "no source is added to a reviewed page");
});

test("a highlight already on the page is skipped, not duplicated", () => {
  const once = tn.mergeWikiHighlights(KARPATHY_PAGE, "Paper", "", [HL(2, "a")], { schema: "karpathy", today: "2026-09-15" });
  const twice = tn.mergeWikiHighlights(once.md, "Paper", "", [HL(2, "a")], { schema: "karpathy", today: "2026-09-15" });
  assert.equal(twice.added, 0);
  assert.equal(twice.skipped, 1);
});

test("the class schema still merges under Highlights", () => {
  const page = "---\nclass: HBIO408\n---\n\n## Highlights\n\n";
  const r = tn.mergeWikiHighlights(page, "Paper", "HBIO408", [HL(1, "a")]);
  assert.equal(r.added, 1);
  assert.ok(r.md.includes("## Highlights"));
  assert.ok(!r.md.includes("## Mentions in Source"));
  assert.ok(!r.md.includes("updated:"), "the class schema has no dated frontmatter to touch");
});

// ---- sections: filing a span under a note's own subtopic ----------------

test("noteSections lists a note's ## headings as the reader wrote them, marks and links removed", () => {
  const md = [
    "---",
    "class: HBIO250",
    "---",
    "# Pharmacology",
    "",
    "## Dosing",
    "text",
    "## Drug Safety & The Therapeutic Index",
    "text",
    "## Receptors ",
    "text",
    "## [[WADA]]",
    "## ==Preparation",
    "## **Equations of Motion**:",
    "### A division of one, not a place of its own",
    "```",
    "## not a heading",
    "```",
    "## Dosing",
    "",
  ].join("\n");
  assert.deepEqual(tn.noteSections(md), [
    "Dosing",
    "Drug Safety & The Therapeutic Index",
    "Receptors",
    "WADA",
    "Preparation",
    "Equations of Motion",
  ]);
});

test("noteAliases reads inline and block aliases, unquoted", () => {
  assert.deepEqual(tn.noteAliases(`---\naliases: ["Drug Action", 'PK']\n---\nbody`), ["Drug Action", "PK"]);
  assert.deepEqual(tn.noteAliases(`---\ntags: [x]\naliases:\n  - "Drug Action"\n  - Pharma\ncreated: 2026-09-01\n---\n`), ["Drug Action", "Pharma"]);
  assert.deepEqual(tn.noteAliases(`---\naliases: []\n---\n`), []);
  assert.deepEqual(tn.noteAliases("no frontmatter"), []);
});

test("headingKey and safeHeading fold the forms a heading is typed in", () => {
  assert.equal(tn.headingKey("## Receptors "), "receptors");
  assert.equal(tn.headingKey("**Receptors**:"), "receptors");
  assert.equal(tn.safeHeading("## Receptors\n"), "Receptors");
  assert.equal(tn.safeHeading("   "), "");
});

test("a merge with a section appends inside that section, before the next heading", () => {
  const existing = `---
class: HBIO250
---

## Dosing
Dose text.

## Receptors
Receptor text.

## Highlights

> [!PDF|yellow] [[${PDF_BASENAME}.pdf#page=4&selection=2,0,33,19&color=yellow|${PDF_BASENAME}, p.4]]
> > Some highlight text
`;
  // "receptors" finds "## Receptors " — case and the trailing space are not part of the name.
  const r = tn.mergeWikiHighlights(existing, PDF_BASENAME, "HBIO250", [wikiHighlight(), HL(6, "b")], { section: "receptors" });
  assert.equal(r.added, 1);
  assert.equal(r.skipped, 1, "the highlight the page already holds is still skipped");
  assert.deepEqual(r.section, { heading: "Receptors", created: false });

  const receptors = r.md.indexOf("## Receptors");
  const newLink = r.md.indexOf("page=6&selection=0,0,0,4");
  const highlights = r.md.indexOf("## Highlights");
  assert.ok(receptors < newLink && newLink < highlights, "the callout sits inside Receptors, ahead of Highlights");
  assert.ok(r.md.includes("Receptor text.\n\n- span b [["), "appended after the section's own text");
  assert.ok(r.md.includes("## Dosing\nDose text.\n\n## Receptors"), "the sections before it are untouched");
});

test("a merge with a section the page lacks creates it before the trailing sections", () => {
  const existing = `---
class: HBIO250
---

## Receptors
Receptor text.

## Highlights

## Related topics
- [[Pharmacology]]
`;
  const r = tn.mergeWikiHighlights(existing, PDF_BASENAME, "HBIO250", [HL(19, "c")], { section: "COX Inhibitors and NSAIDs" });
  assert.equal(r.added, 1);
  assert.deepEqual(r.section, { heading: "COX Inhibitors and NSAIDs", created: true });
  const receptors = r.md.indexOf("## Receptors");
  const cox = r.md.indexOf(`## [[${PDF_BASENAME}.pdf#page=19|COX Inhibitors and NSAIDs]]`);
  const highlights = r.md.indexOf("## Highlights");
  assert.ok(cox >= 0 && receptors < cox && cox < highlights, "a new subtopic sits with the subtopics, ahead of the highlights");
  assert.ok(r.md.includes(`## [[${PDF_BASENAME}.pdf#page=19|COX Inhibitors and NSAIDs]]\n\n- span c [[`), r.md);
});

test("a karpathy merge with a new section places it before Related Concepts and still dates the page", () => {
  const page = `---
type: concept
created: 2026-09-01
updated: 2026-09-01
tags: [theory]
aliases:
  - "Kept Alias"
generation_complete: true
---


# Chunking

## Definition
Text.

## Related Concepts
- [[x]]

## Mentions in Source

`;
  const r = tn.mergeWikiHighlights(page, "Paper", "", [HL(2, "a")], { schema: "karpathy", section: "Chunk Size", today: "2026-09-16" });
  assert.equal(r.added, 1);
  const definition = r.md.indexOf("## Definition");
  const section = r.md.indexOf("## [[Paper.pdf#page=2|Chunk Size]]");
  const related = r.md.indexOf("## Related Concepts");
  assert.ok(section >= 0 && definition < section && section < related, r.md);
  assert.ok(r.md.includes("updated: 2026-09-16"));
  assert.ok(r.md.includes("created: 2026-09-01"));
});

test("a section merge with nothing new to add leaves the page byte-identical", () => {
  const existing = `---
class: HBIO250
---

## Receptors

> [!PDF|yellow] [[${PDF_BASENAME}.pdf#page=4&selection=2,0,33,19&color=yellow|${PDF_BASENAME}, p.4]]
> > Some highlight text
`;
  const r = tn.mergeWikiHighlights(existing, PDF_BASENAME, "HBIO250", [wikiHighlight()], { section: "Receptors" });
  assert.equal(r.added, 0);
  assert.equal(r.md, existing);
  assert.equal(r.section, undefined);
});

test("a karpathy page carries the aliases and tag it was given", () => {
  const md = tn.renderWikiNote({
    classCode: "",
    pdfBasename: "P",
    summary: "What it means.",
    highlights: [],
    schema: "karpathy",
    title: "Chunking",
    kind: "concept",
    aliases: ["Chunk Size", " Perceptual Chunking "],
    tag: "theory",
    today: "2026-09-17",
  });
  assert.ok(md.includes("tags: [theory]"), "the tag reaches the page");
  assert.ok(md.includes('aliases:\n  - "Chunk Size"\n  - "Perceptual Chunking"'), "aliases are quoted and trimmed");
});

test("an off-vocabulary tag falls back to other, and the lint will say so", () => {
  const md = tn.renderWikiNote({ classCode: "", pdfBasename: "P", summary: "S.", highlights: [], schema: "karpathy", title: "T", kind: "entity", tag: "theory", today: "2026-09-17" });
  assert.ok(md.includes("tags: [other]"), "theory is a concept tag, not an entity tag");
  assert.equal(tn.validTag("concept", "method"), "method");
  assert.equal(tn.validTag("concept", "nonsense"), "other");
  assert.equal(tn.validTag("entity", undefined), "other");
});

const MENTION_ROW = {
  id: "M01",
  key: "sources/clippings/prompts.md#120-180",
  page: 0,
  kind: "selection",
  color: null,
  target: { page: 0 },
  text: "Retrieval practice strengthens memory.",
  before: "",
  after: "",
  origins: ["sources/clippings/prompts.md"],
  mention: '- "Retrieval practice strengthens memory." — [[sources/clippings/prompts#Why it works|How to write good prompts › Why it works]]',
};

test("a row with a mention renders that line instead of a callout, in both schemas", () => {
  const karpathy = tn.renderWikiNote({ classCode: "", pdfBasename: "P", summary: "S.", highlights: [MENTION_ROW], schema: "karpathy", title: "Retrieval Practice", kind: "concept", today: "2026-09-17" });
  assert.ok(karpathy.includes(MENTION_ROW.mention), "the mention line is printed verbatim");
  assert.ok(!karpathy.includes("[!PDF"), "no callout is rendered for a note-sourced row");
  const klass = tn.renderWikiNote({ classCode: "X", pdfBasename: "P", summary: "", highlights: [MENTION_ROW] });
  assert.ok(klass.includes(MENTION_ROW.mention));
});

test("a merge skips a mention whose quote the page already holds and adds one it does not", () => {
  const page = `---\ntype: concept\ncreated: 2026-09-01\nupdated: 2026-09-01\ntags: [theory]\naliases:\n  - "RP"\ngeneration_complete: true\n---\n\n\n# Retrieval Practice\n\n## Definition\nText.\n\n## Mentions in Source\n\n- "Retrieval  practice strengthens memory." — [[sources/clippings/prompts|How to write good prompts]]\n`;
  const same = tn.mergeWikiHighlights(page, "P", "", [MENTION_ROW], { schema: "karpathy", today: "2026-09-17" });
  assert.equal(same.added, 0, "whitespace differences do not make a new quote");
  assert.equal(same.skipped, 1);
  const other = { ...MENTION_ROW, key: "sources/clippings/prompts.md#300-340", text: "Spacing beats massing.", mention: '- "Spacing beats massing." — [[sources/clippings/prompts|How to write good prompts]]' };
  const added = tn.mergeWikiHighlights(page, "P", "", [other], { schema: "karpathy", today: "2026-09-17" });
  assert.equal(added.added, 1);
  assert.ok(added.md.includes(other.mention));
  assert.ok(added.md.indexOf(other.mention) > added.md.indexOf("## Mentions in Source"));
});

test("parseTopicNote reads a class list and keeps classCode as the first", () => {
  const one = tn.parseTopicNote("---\nclass: HBIO250\n---\n# T\n");
  assert.equal(one.classCode, "HBIO250");
  assert.deepEqual(one.classCodes, ["HBIO250"]);
  const many = tn.parseTopicNote("---\nclass:\n  - HBIO250\n  - PHED163\n---\n# T\n");
  assert.deepEqual(many.classCodes, ["HBIO250", "PHED163"]);
  const inline = tn.parseTopicNote("---\nclass: [HBIO250, PHED163]\n---\n# T\n");
  assert.deepEqual(inline.classCodes, ["HBIO250", "PHED163"]);
  assert.equal(inline.classCode, "HBIO250");
});

// ---- rows as bullets: the slide link on the heading, the quote as a list ----

test("a selection row renders as a bullet with a short page link, not a callout", () => {
  const md = tn.renderHighlightRow(PDF_BASENAME, wikiHighlight());
  assert.equal(md, `- Some highlight text [[${PDF_BASENAME}.pdf#page=4&selection=2,0,33,19&color=yellow|p.4]]`);
  assert.ok(!md.includes("[!PDF"));
  assert.ok(!md.includes(`${PDF_BASENAME}, p.4`), "the sixty-character filename never appears as display text");
});

test("an inline bullet run inside a quote becomes a nested list under the lead", () => {
  const h = wikiHighlight({
    page: 20,
    key: "page=20&selection=1,0,9,4",
    target: { page: 20, selection: { beginIndex: 1, beginOffset: 0, endIndex: 9, endOffset: 4 }, color: "yellow" },
    text: "Therefore, the pharmacokinetics of a drug involves 4 factors:• Absorption• Distribution• Metabolism• Elimination",
  });
  assert.equal(
    tn.renderHighlightRow(PDF_BASENAME, h),
    [
      `- Therefore, the pharmacokinetics of a drug involves 4 factors: [[${PDF_BASENAME}.pdf#page=20&selection=1,0,9,4&color=yellow|p.20]]`,
      "  - Absorption",
      "  - Distribution",
      "  - Metabolism",
      "  - Elimination",
    ].join("\n"),
  );
});

test("a numbered run keeps its numbers as an ordered nested list, and a lone number is not a list", () => {
  const h = wikiHighlight({
    text: "1. Enteral = Oral (sublingual, buccal, GI tract) & via other mucous membranes (rectal) 2. “ Parenteral ” (par - outside or beyond intestine)",
  });
  assert.equal(
    tn.renderHighlightRow(PDF_BASENAME, h),
    [
      `- [[${PDF_BASENAME}.pdf#page=4&selection=2,0,33,19&color=yellow|p.4]]`,
      "  1. Enteral = Oral (sublingual, buccal, GI tract) & via other mucous membranes (rectal)",
      "  2. “ Parenteral ” (par - outside or beyond intestine)",
    ].join("\n"),
  );
  // "2 important properties: 1. They bind…" has one numbered item after a
  // lead and a "2." glued to the prose — it is a sentence, not a list.
  // A run that continues from the previous slide keeps its own numbers.
  const cont = wikiHighlight({ text: "4. Fat solubility of the drug (is it oil-based?) 5. Physio-chemical reaction with the contents of the GI tract" });
  assert.equal(
    tn.renderHighlightRow(PDF_BASENAME, cont),
    [`- [[${PDF_BASENAME}.pdf#page=4&selection=2,0,33,19&color=yellow|p.4]]`, "  4. Fat solubility of the drug (is it oil-based?)", "  5. Physio-chemical reaction with the contents of the GI tract"].join("\n"),
  );
  // Numbers that do not run in sequence are prose: a date and a section number are not a list.
  const gaps = wikiHighlight({ text: "Adopted in 2004. Section 7. applies, and 12. is repealed" });
  assert.equal(tn.renderHighlightRow(PDF_BASENAME, gaps), `- Adopted in 2004. Section 7. applies, and 12. is repealed [[${PDF_BASENAME}.pdf#page=4&selection=2,0,33,19&color=yellow|p.4]]`);
  const prose = wikiHighlight({ text: "Receptors have 2 important properties: they bind ligands and transduce a signal." });
  assert.equal(tn.renderHighlightRow(PDF_BASENAME, prose), `- Receptors have 2 important properties: they bind ligands and transduce a signal. [[${PDF_BASENAME}.pdf#page=4&selection=2,0,33,19&color=yellow|p.4]]`);
});

test("newlines in a quote split it the same way as inline bullets", () => {
  const h = wikiHighlight({ text: "involves 4 factors:\n• Absorption\n• Distribution" });
  assert.equal(
    tn.renderHighlightRow(PDF_BASENAME, h),
    [`- involves 4 factors: [[${PDF_BASENAME}.pdf#page=4&selection=2,0,33,19&color=yellow|p.4]]`, "  - Absorption", "  - Distribution"].join("\n"),
  );
});

test("a rect row with no text is still the bare embed, and a mention row is still its line", () => {
  const rect = wikiHighlight({ kind: "rect", color: null, key: "page=4&rect=13,55,713,222", target: { page: 4, rect: [13, 55, 713, 222] }, text: "" });
  assert.equal(tn.renderHighlightRow(PDF_BASENAME, rect), `![[${PDF_BASENAME}.pdf#page=4&rect=13,55,713,222|${PDF_BASENAME}, p.4]]`);
  assert.equal(tn.renderHighlightRow("P", MENTION_ROW), MENTION_ROW.mention);
});

test("a section the merge creates carries a link to its first slide in the heading", () => {
  const existing = `---\nclass: HBIO250\n---\n\n## Receptors\nReceptor text.\n\n## Highlights\n\n## Related topics\n- [[Pharmacology]]\n`;
  const r = tn.mergeWikiHighlights(existing, PDF_BASENAME, "HBIO250", [HL(21, "b"), HL(19, "a")], { section: "COX Inhibitors and NSAIDs" });
  assert.equal(r.added, 2);
  assert.deepEqual(r.section, { heading: "COX Inhibitors and NSAIDs", created: true });
  const heading = `## [[${PDF_BASENAME}.pdf#page=19|COX Inhibitors and NSAIDs]]`;
  assert.ok(r.md.includes(`${heading}\n\n- span a [[${PDF_BASENAME}.pdf#page=19&selection=0,0,0,4&color=yellow|p.19]]\n- span b [[`), r.md);
  assert.ok(r.md.indexOf(heading) < r.md.indexOf("## Highlights"), "the new section sits ahead of the highlights");

  // The linked heading is still the section on the next merge: matched by
  // its display text, not rewritten, and the new row goes under it.
  const again = tn.mergeWikiHighlights(r.md, PDF_BASENAME, "HBIO250", [HL(21, "b"), HL(23, "c")], { section: "cox inhibitors and nsaids" });
  assert.equal(again.added, 1);
  assert.equal(again.skipped, 1);
  assert.deepEqual(again.section, { heading: "COX Inhibitors and NSAIDs", created: false });
  assert.equal(again.md.split(heading).length, 2, "the heading is written once");
  assert.ok(again.md.includes("- span b [[") && again.md.indexOf("- span c [[") < again.md.indexOf("## Highlights"));
  assert.deepEqual(tn.noteSections(again.md), ["Receptors", "COX Inhibitors and NSAIDs", "Highlights", "Related topics"]);
});

test("an existing heading the reader wrote is never rewritten with a link", () => {
  const existing = `---\nclass: HBIO250\n---\n\n## Receptors\nReceptor text.\n\n## Highlights\n\n`;
  const r = tn.mergeWikiHighlights(existing, PDF_BASENAME, "HBIO250", [HL(6, "b")], { section: "Receptors" });
  assert.ok(r.md.includes("## Receptors\nReceptor text.\n\n- span b [["), r.md);
  assert.ok(!r.md.includes("## [["));
});

test("parseTopicNote reads a bullet row's text, nested items included, without the link", () => {
  const md = [
    "---",
    "class: HBIO250",
    "---",
    "",
    "## Highlights",
    "",
    `- Therefore, the pharmacokinetics of a drug involves 4 factors: [[${PDF_BASENAME}.pdf#page=20&selection=1,0,9,4&color=yellow|p.20]]`,
    "  - Absorption",
    "  - Distribution",
    `- Some highlight text [[${PDF_BASENAME}.pdf#page=4&selection=2,0,33,19&color=yellow|p.4]]`,
    "",
    "## Related topics",
    "",
  ].join("\n");
  const parsed = tn.parseTopicNote(md);
  assert.deepEqual(
    parsed.highlights.map((h) => [h.page, h.key, h.text]),
    [
      [20, "page=20&selection=1,0,9,4", "Therefore, the pharmacokinetics of a drug involves 4 factors: Absorption; Distribution"],
      [4, "page=4&selection=2,0,33,19", "Some highlight text"],
    ],
  );
});

test("renderWikiNote's class schema writes bullets under Highlights", () => {
  const rendered = tn.renderWikiNote({ classCode: "HBIO250", pdfBasename: PDF_BASENAME, summary: "S.", highlights: [wikiHighlight()] });
  assert.equal(
    rendered,
    `---\nclass: HBIO250\n---\n\n## Summary\nS.\n\n## Highlights\n\n- Some highlight text [[${PDF_BASENAME}.pdf#page=4&selection=2,0,33,19&color=yellow|p.4]]\n`,
  );
});
