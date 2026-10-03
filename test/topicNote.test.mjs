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
  const dir = mkdtempSync(path.join(tmpdir(), "wikilm-test-"));
  const out = path.join(dir, "topicNote.mjs");
  await build({ entryPoints: ["src/topicNote.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  tn = await import(pathToFileURL(out).href);
});

const PDF_BASENAME = "BIO 101 - Pharmacology, Pharmacodynamics, and Pharmacokinetics";
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
  origins: ["classes/BIO101/Pharmacology.md"],
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
  origins: ["classes/BIO101/Pharmacology.md"],
};

const LITERAL_NOTE = `---
type: concept
class: BIO101
created: 2026-09-10
source_file: "[[BIO 101 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf]]"
tags: [term]
aliases:
  - "Drug Receptors"
---

# Receptors

## Summary
Receptors bind drugs with high affinity and transduce a signal, which is what separates them from inert binding proteins such as albumin; the better the structural fit, the higher the affinity.

## Highlights

> [!PDF|yellow] [[BIO 101 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf#page=4&selection=2,0,33,19&color=yellow|BIO 101 - Pharmacology, Pharmacodynamics, and Pharmacokinetics, p.4]]
> > Receptors have 2 important properties:
> > 1. They bind ligands (or drugs) with relatively high affinity, and after they bind a drug…
> > 2. They transduce a signal to produce a biological effect (this property distinguishes receptors from inert binding sites – e.g., albumin – a blood protein that binds/carries many drugs but does not transduce a signal)

![[BIO 101 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf#page=4&rect=13,55,713,222|BIO 101 - Pharmacology, Pharmacodynamics, and Pharmacokinetics, p.4]]

## Related topics
- [[Pharmacology]]

## Flashcard Seeds
`;

test("renderTopicNote produces the literal two-highlight note", () => {
  const rendered = tn.renderTopicNote({
    title: "Receptors",
    classCode: "BIO101",
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
  assert.equal(parsed.classCode, "BIO101");
  assert.equal(parsed.sourceBasename, PDF_BASENAME);
  assert.equal(parsed.summary, SUMMARY);
  assert.deepEqual(
    parsed.highlights.map((h) => h.key),
    [SELECTION_HIGHLIGHT.key, RECT_HIGHLIGHT.key],
  );
});

test("renderTopicNote lists rows in page order, without page headings", () => {
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
    classCode: "BIO101",
    created: "2026-09-10",
    pdfBasename: PDF_BASENAME,
    summary: SUMMARY,
    highlights: [SELECTION_HIGHLIGHT, p5, p6],
    related: [],
    kind: "concept",
    tag: "term",
    aliases: [],
  });
  assert.ok(!rendered.includes("### Page"), "no per-page headings");
  const idx4 = rendered.indexOf("page=4&");
  const idx5 = rendered.indexOf("page=5&");
  const idx6 = rendered.indexOf("page=6&");
  assert.ok(idx4 !== -1 && idx4 < idx5 && idx5 < idx6, rendered);
  assert.ok(rendered.includes(`> [!PDF|yellow] [[${PDF_BASENAME}.pdf#page=5&selection=10,0,12,8&color=yellow|${PDF_BASENAME}, p.5]]\n> > The better the fit, the higher the affinity`), rendered);
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
    origins: ["classes/BIO101/Pharmacology.md"],
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
class: KIN110
created: 2026-09-07
source_file: "[[Module 3 - CH 3 Video Assignments (2) - A Student.pdf]]"
tags: [kin110]
---

# The five stages of change

## Summary
The five stages of behavior change, what defines each, and what the coach does in each.

## Key claims
- Precontemplation: the client has no intention of changing in the foreseeable future. — [[Module 3 - CH 3 Video Assignments (2) - A Student.pdf#page=1|p.1]]

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
    origins: ["classes/KIN110/Stages of Change.md"],
  };
  const result = tn.mergeTopicHighlights(stagesOfChange, "Module 3 - CH 3 Video Assignments (2) - A Student", [highlight]);
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
    pdfPath: "sources/class notes/BIO101/" + PDF_BASENAME + ".pdf",
    pdfBasename: PDF_BASENAME,
    classCode: "BIO101",
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
    classCode: "BIO101",
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
    classCode: "BIO101",
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
    classCode: "BIO101",
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
    classCode: "BIO101",
    topicFolder: "classes",
    created: "2026-09-10",
    pages: [],
  });
  assert.deepEqual(result.unassignedIds, ["H02"]);
});

test("renderTopicNote writes a class list when a page belongs to two classes, and addClassCode grows it", () => {
  const md = tn.renderTopicNote({ title: "Muscle", classCode: "BIO201", classCodes: ["BIO201", "KIN110"], created: "2026-09-17", pdfBasename: "P", summary: "S", highlights: [], related: [], kind: "concept", tag: "term", aliases: [] });
  assert.ok(md.includes("class: [BIO201, KIN110]"));
  assert.ok(!md.includes("aliases:"), "no aliases, no key");
  const scalar = "---\ntype: concept\nclass: BIO201\ncreated: 2026-09-17\n---\n# Muscle\n";
  assert.ok(tn.addClassCode(scalar, "KIN110").includes("class: [BIO201, KIN110]"));
  assert.equal(tn.addClassCode(scalar, "BIO201"), scalar, "already there: byte-identical");
  const list = "---\nclass: [BIO201, KIN110]\n---\n";
  assert.ok(tn.addClassCode(list, "PSY220").includes("class: [BIO201, KIN110, PSY220]"));
  assert.ok(tn.addClassCode("---\ntype: concept\n---\n# M\n", "KIN110").includes("class: KIN110"), "a page with no class gains one");
});

test("planTopicNotes merges into a page from another class by alias and appends the class", () => {
  const other = {
    path: "classes/BIO201/Skeletal Muscle.md",
    title: "Skeletal Muscle",
    kind: "concept",
    aliases: ["Muscle Fibres"],
    classCodes: ["BIO201"],
    md: "---\ntype: concept\nclass: BIO201\ncreated: 2026-09-10\n---\n\n# Skeletal Muscle\n\n## Summary\nS.\n\n## Highlights\n\n## Related topics\n",
  };
  const manifest = { pdfPath: "sources/class notes/KIN110/Deck.pdf", pdfBasename: "Deck", classCode: "KIN110", extracted: "", sources: [], highlights: [SELECTION_HIGHLIGHT] };
  const draft = {
    notes: [{ title: "Muscle Fibres", kind: "concept", aliases: [], tag: "term", closest_existing: "", why_new: "", summary: "S.", highlight_ids: ["H04"], related: [] }],
    unused_ids: [],
  };
  const out = tn.planTopicNotes(draft, manifest, { classCode: "KIN110", topicFolder: "classes", created: "2026-09-17", pages: [other] });
  assert.equal(out.notes.length, 1);
  assert.equal(out.notes[0].path, other.path, "the alias found the page in the other class");
  assert.equal(out.notes[0].exists, true);
  assert.ok(out.notes[0].content.includes("class: [BIO201, KIN110]"), out.notes[0].content);
});

test("planTopicNotes files a new title that names a home into that page under a heading, and creates one that has none", () => {
  const home = {
    path: "classes/BIO101/Pharmacology.md",
    title: "Pharmacology",
    kind: "concept",
    aliases: [],
    classCodes: ["BIO101"],
    md: "---\ntype: concept\nclass: BIO101\n---\n\n# Pharmacology\n\n## Summary\nS.\n\n## Highlights\n\n## Related topics\n",
  };
  const manifest = { pdfPath: "sources/class notes/BIO101/Deck.pdf", pdfBasename: "Deck", classCode: "BIO101", extracted: "", sources: [], highlights: [SELECTION_HIGHLIGHT, { ...RECT_HIGHLIGHT, text: "Aspirin inhibits COX." }] };
  const draft = {
    notes: [
      { title: "COX Inhibitors", kind: "concept", aliases: ["NSAIDs"], tag: "term", closest_existing: "Pharmacology", why_new: "part of pharmacology", summary: "S.", highlight_ids: ["H05"], related: [] },
      { title: "Self-Efficacy", kind: "concept", aliases: ["Self-efficacy belief"], tag: "term", closest_existing: "", why_new: "nothing listed is about beliefs", summary: "A belief.", highlight_ids: ["H04"], related: [] },
    ],
    unused_ids: [],
  };
  const out = tn.planTopicNotes(draft, manifest, { classCode: "BIO101", topicFolder: "classes", created: "2026-09-17", pages: [home] });
  const filed = out.notes.find((n) => n.path === home.path);
  assert.ok(filed, "COX Inhibitors was filed into Pharmacology");
  assert.ok(tn.noteSections(filed.content).includes("COX Inhibitors"), "under a heading named after the proposal");
  assert.deepEqual(filed.routed.map((r) => [r.from, r.heading]), [["COX Inhibitors", "COX Inhibitors"]]);
  const created = out.notes.find((n) => n.title === "Self-Efficacy");
  assert.equal(created.exists, false);
  assert.equal(created.path, "classes/BIO101/Self-Efficacy.md");
  assert.equal(created.whyNew, "nothing listed is about beliefs");
  assert.ok(created.content.includes("type: concept"));
  assert.ok(created.content.includes('- "Self-efficacy belief"'));
  assert.ok(created.content.includes("tags: [term]"));
});

test("planTopicNotes gives one row per page when two proposals are filed into the same home", () => {
  const home = {
    path: "classes/BIO101/Pharmacology.md",
    title: "Pharmacology",
    kind: "concept",
    aliases: [],
    classCodes: ["BIO101"],
    md: "---\ntype: concept\nclass: BIO101\n---\n\n# Pharmacology\n\n## Summary\nS.\n\n## Highlights\n\n## Related topics\n",
  };
  const manifest = {
    pdfPath: "sources/class notes/BIO101/Deck.pdf",
    pdfBasename: "Deck",
    classCode: "BIO101",
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
  const out = tn.planTopicNotes(draft, manifest, { classCode: "BIO101", topicFolder: "classes", created: "2026-09-17", pages: [home] });
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
  path: "classes/BIO101/Pharmacology.md",
  title: "Pharmacology",
  kind: "concept",
  aliases: [],
  classCodes: ["BIO101"],
  md: "---\ntype: concept\nclass: BIO101\n---\n\n# Pharmacology\n\n## Summary\nS.\n\n## Highlights\n\n## Related topics\n",
};

function twoHighlightManifest() {
  return {
    pdfPath: "sources/class notes/BIO101/Deck.pdf",
    pdfBasename: "Deck",
    classCode: "BIO101",
    extracted: "",
    sources: [],
    highlights: [SELECTION_HIGHLIGHT, { ...RECT_HIGHLIGHT, text: "Aspirin inhibits COX." }],
  };
}

const DIGEST_OPTS = { classCode: "BIO101", topicFolder: "classes", created: "2026-09-17" };

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
  assert.equal(replanned.notes[0].path, "classes/BIO101/Self Efficacy Beliefs.md");
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

test("applyDigestChoices sends an existing row's topic to a new page when the reader types a name no page has", () => {
  const manifest = twoHighlightManifest();
  const draft = {
    notes: [
      { title: "Pharmacology", kind: "concept", aliases: [], tag: "term", closest_existing: "", why_new: "", summary: "S.", highlight_ids: ["H05"], related: [] },
    ],
    unused_ids: [],
  };
  const planned = tn.planTopicNotes(draft, manifest, { ...DIGEST_OPTS, pages: [HOME_PHARM] });
  assert.equal(planned.notes[0].exists, true);
  const { draft: narrowed, keepAsNew } = tn.applyDigestChoices(draft, planned.notes, [{ path: planned.notes[0].path, title: "Drug Basics" }], ["Pharmacology"]);
  assert.equal(narrowed.notes[0].title, "Drug Basics", "the box says where the topic goes");
  assert.deepEqual(keepAsNew, ["Drug Basics"]);
  const replanned = tn.planTopicNotes(narrowed, manifest, { ...DIGEST_OPTS, pages: [HOME_PHARM], keepAsNew });
  assert.equal(replanned.notes[0].exists, false);
  assert.equal(replanned.notes[0].path, "classes/BIO101/Drug Basics.md");
});

test("applyDigestChoices leaves an existing row alone when its box still holds the page's own name", () => {
  const manifest = twoHighlightManifest();
  const draft = { notes: [{ title: "Pharmacology", kind: "concept", aliases: [], tag: "term", closest_existing: "", why_new: "", summary: "S.", highlight_ids: ["H05"], related: [] }], unused_ids: [] };
  const planned = tn.planTopicNotes(draft, manifest, { ...DIGEST_OPTS, pages: [HOME_PHARM] });
  const { draft: narrowed, keepAsNew } = tn.applyDigestChoices(draft, planned.notes, [{ path: planned.notes[0].path, title: "pharmacology " }], ["Pharmacology"]);
  assert.equal(narrowed.notes[0].title, "Pharmacology");
  assert.deepEqual(keepAsNew, []);
});

test("typing an existing page's name into a new row's box files the topic there as a branch", () => {
  const manifest = twoHighlightManifest();
  const draft = {
    notes: [
      { title: "Pharmacology", kind: "concept", aliases: [], tag: "term", closest_existing: "", why_new: "", summary: "S.", highlight_ids: ["H05"], related: [] },
      { title: "Self-Efficacy", kind: "concept", aliases: [], tag: "term", closest_existing: "", why_new: "nothing listed is about beliefs", summary: "A belief.", highlight_ids: ["H04"], related: [] },
    ],
    unused_ids: [],
  };
  const planned = tn.planTopicNotes(draft, manifest, { ...DIGEST_OPTS, pages: [HOME_PHARM] });
  const fresh = planned.notes.find((n) => !n.exists);
  const home = planned.notes.find((n) => n.exists);
  const { draft: narrowed, keepAsNew } = tn.applyDigestChoices(
    draft,
    planned.notes,
    [{ path: home.path, title: home.title }, { path: fresh.path, title: "pharmacology" }],
    ["Pharmacology"],
  );
  const moved = narrowed.notes.find((n) => n.title === "Self-Efficacy");
  assert.ok(moved, "the topic keeps its own name, which becomes the branch heading");
  assert.equal(moved.closest_existing, "Pharmacology");
  assert.deepEqual(keepAsNew, []);
  const replanned = tn.planTopicNotes(narrowed, manifest, { ...DIGEST_OPTS, pages: [HOME_PHARM], keepAsNew });
  assert.equal(replanned.notes.length, 1);
  assert.equal(replanned.notes[0].path, HOME_PHARM.path);
  assert.match(replanned.notes[0].content, /^## .*Self-Efficacy/m);
});

test("a row accepted as new is written as a new page even when the rename specializes an existing title", () => {
  const manifest = twoHighlightManifest();
  const RECEPTORS = {
    path: "classes/BIO101/Receptors.md",
    title: "Receptors",
    kind: "concept",
    aliases: [],
    classCodes: ["BIO101"],
    md: "---\ntype: concept\nclass: BIO101\n---\n\n# Receptors\n\n## Summary\nS.\n\n## Highlights\n\n## Related topics\n",
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
  assert.equal(replanned.notes[0].path, "classes/BIO101/Receptor Subtypes.md");
  assert.equal(replanned.notes[0].path !== RECEPTORS.path, true, "the existing page is untouched");
});

test("without keepAsNew the specialization rule still routes a plain proposal into its home", () => {
  const manifest = twoHighlightManifest();
  const RECEPTORS = {
    path: "classes/BIO101/Receptors.md",
    title: "Receptors",
    kind: "concept",
    aliases: [],
    classCodes: ["BIO101"],
    md: "---\ntype: concept\nclass: BIO101\n---\n\n# Receptors\n\n## Summary\nS.\n\n## Highlights\n\n## Related topics\n",
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
    origins: ["classes/BIO101/Pharmacology.md"],
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
    classCode: "BIO101",
    pdfBasename: PDF_BASENAME,
    summary: "S.",
    highlights: [p4, p2],
  });

  const expected = `---
class: BIO101
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
  // Two callouts are two blocks: a blank line between them, or markdown runs them together.
  assert.ok(rendered.includes("Page two text\n\n> [!PDF"));
});

test("renderWikiNote omits the Summary section when summary is empty", () => {
  const p4 = wikiHighlight();
  const rendered = tn.renderWikiNote({
    classCode: "BIO101",
    pdfBasename: PDF_BASENAME,
    summary: "",
    highlights: [p4],
  });
  assert.ok(!rendered.includes("## Summary"));
  assert.ok(rendered.startsWith("---\nclass: BIO101\n---\n\n## Highlights\n\n"));
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

  const result = tn.mergeWikiHighlights(existing, PDF_BASENAME, "BIO101", [existingHighlight, newHighlight]);
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
  const result = tn.mergeWikiHighlights(existing, PDF_BASENAME, "BIO101", [highlight]);
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
  const result = tn.mergeWikiHighlights("", PDF_BASENAME, "BIO101", [h1, h2]);
  assert.ok(result.md.startsWith("---\nclass: BIO101\n---\n\n## Highlights"));
  assert.equal(result.added, 2);
  assert.equal(result.skipped, 0);
});

test("mergeWikiHighlights inserts the new callout inside an existing Highlights section, before a later section", () => {
  const existing = `---
class: BIO101
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
  const result = tn.mergeWikiHighlights(existing, PDF_BASENAME, "BIO101", [wikiHighlight(), newHighlight]);
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 1);

  const highlightsIdx = result.md.indexOf("## Highlights");
  const notesIdx = result.md.indexOf("## Notes");
  const newLinkIdx = result.md.indexOf("page=6&selection=0,0,3,0");
  assert.ok(highlightsIdx < newLinkIdx && newLinkIdx < notesIdx);
});

test("mergeWikiHighlights inserts a missing ## Highlights section before ## Related topics, ahead of ## Flashcard Seeds", () => {
  const existing = `---
class: KIN110
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
  const result = tn.mergeWikiHighlights(existing, PDF_BASENAME, "KIN110", [highlight]);
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
class: KIN110
---

## Summary
S.

## Flashcard Seeds
`;
  const highlight = wikiHighlight();
  const result = tn.mergeWikiHighlights(existing, PDF_BASENAME, "KIN110", [highlight]);
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 0);

  const highlightsIdx = result.md.indexOf("## Highlights");
  const seedsIdx = result.md.indexOf("## Flashcard Seeds");
  assert.ok(highlightsIdx < seedsIdx);
  assert.ok(result.md.slice(seedsIdx).startsWith(existing.slice(existing.indexOf("## Flashcard Seeds"))));
});

test("mergeWikiHighlights inserts a missing ## Highlights section before ## Related topics when there is no ## Flashcard Seeds", () => {
  const existing = `---
class: KIN110
---

## Summary
S.

## Related topics
- [[X]]
`;
  const highlight = wikiHighlight();
  const result = tn.mergeWikiHighlights(existing, PDF_BASENAME, "KIN110", [highlight]);
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
  const md = tn.renderWikiNote({ classCode: "BIO201", pdfBasename: "P", summary: "s", highlights: [] });
  assert.ok(md.includes("class: BIO201"));
  assert.ok(md.includes("## Highlights"));
  assert.ok(!md.includes("type: concept"));
});

test("renderWikiNote dispatches to the karpathy schema when asked", () => {
  const md = tn.renderWikiNote({
    classCode: "BIO201",
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
  assert.ok(r.md.includes("> [!PDF|yellow] [[Paper.pdf#page=2&selection=0,0,0,4&color=yellow|Paper, p.2]]\n> > span a"), r.md);
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
  const page = "---\nclass: BIO201\n---\n\n## Highlights\n\n";
  const r = tn.mergeWikiHighlights(page, "Paper", "BIO201", [HL(1, "a")]);
  assert.equal(r.added, 1);
  assert.ok(r.md.includes("## Highlights"));
  assert.ok(!r.md.includes("## Mentions in Source"));
  assert.ok(!r.md.includes("updated:"), "the class schema has no dated frontmatter to touch");
});

// ---- sections: filing a span under a note's own subtopic ----------------

test("noteSections lists a note's ## headings as the reader wrote them, marks and links removed", () => {
  const md = [
    "---",
    "class: BIO101",
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
class: BIO101
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
  const r = tn.mergeWikiHighlights(existing, PDF_BASENAME, "BIO101", [wikiHighlight(), HL(6, "b")], { section: "receptors" });
  assert.equal(r.added, 1);
  assert.equal(r.skipped, 1, "the highlight the page already holds is still skipped");
  assert.deepEqual(r.section, { heading: "Receptors", created: false });

  const receptors = r.md.indexOf("## Receptors");
  const newLink = r.md.indexOf("page=6&selection=0,0,0,4");
  const highlights = r.md.indexOf("## Highlights");
  assert.ok(receptors < newLink && newLink < highlights, "the callout sits inside Receptors, ahead of Highlights");
  assert.ok(r.md.includes("Receptor text.\n\n> [!PDF"), "appended after the section's own text");
  assert.ok(r.md.includes("## Dosing\nDose text.\n\n## Receptors"), "the sections before it are untouched");
});

test("a merge with a section the page lacks creates it before the trailing sections", () => {
  const existing = `---
class: BIO101
---

## Receptors
Receptor text.

## Highlights

## Related topics
- [[Pharmacology]]
`;
  const r = tn.mergeWikiHighlights(existing, PDF_BASENAME, "BIO101", [HL(19, "c")], { section: "COX Inhibitors and NSAIDs" });
  assert.equal(r.added, 1);
  assert.deepEqual(r.section, { heading: "COX Inhibitors and NSAIDs", created: true });
  const receptors = r.md.indexOf("## Receptors");
  const cox = r.md.indexOf(`## [[${PDF_BASENAME}.pdf#page=19|COX Inhibitors and NSAIDs]]`);
  const highlights = r.md.indexOf("## Highlights");
  assert.ok(cox >= 0 && receptors < cox && cox < highlights, "a new subtopic sits with the subtopics, ahead of the highlights");
  assert.ok(r.md.includes(`## [[${PDF_BASENAME}.pdf#page=19|COX Inhibitors and NSAIDs]]\n\n> [!PDF`), r.md);
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
class: BIO101
---

## Receptors

> [!PDF|yellow] [[${PDF_BASENAME}.pdf#page=4&selection=2,0,33,19&color=yellow|${PDF_BASENAME}, p.4]]
> > Some highlight text
`;
  const r = tn.mergeWikiHighlights(existing, PDF_BASENAME, "BIO101", [wikiHighlight()], { section: "Receptors" });
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
  const one = tn.parseTopicNote("---\nclass: BIO101\n---\n# T\n");
  assert.equal(one.classCode, "BIO101");
  assert.deepEqual(one.classCodes, ["BIO101"]);
  const many = tn.parseTopicNote("---\nclass:\n  - BIO101\n  - KIN110\n---\n# T\n");
  assert.deepEqual(many.classCodes, ["BIO101", "KIN110"]);
  const inline = tn.parseTopicNote("---\nclass: [BIO101, KIN110]\n---\n# T\n");
  assert.deepEqual(inline.classCodes, ["BIO101", "KIN110"]);
  assert.equal(inline.classCode, "BIO101");
});

// ---- rows: a passage is a bullet whose link text is its label; a verbatim quote is a Title-and-page callout ----

const SEL = `${PDF_BASENAME}.pdf#page=4&selection=2,0,33,19&color=yellow`;

test("a row with a passage renders as a bullet: the label as the link's text, then the passage", () => {
  const md = tn.renderHighlightRow(
    PDF_BASENAME,
    wikiHighlight({ passage: "Receptors bind drugs with high affinity and pass the signal on.", label: "Receptor affinity", verbatim: false }),
  );
  assert.equal(md, `- [[${SEL}|Receptor affinity]]: Receptors bind drugs with high affinity and pass the signal on.`);
  assert.ok(!md.includes("[!PDF"));
});

test("a verbatim row, or one with no passage, is a PDF++ callout whose link text is Title and page", () => {
  assert.equal(tn.renderHighlightRow(PDF_BASENAME, wikiHighlight()), `> [!PDF|yellow] [[${SEL}|${PDF_BASENAME}, p.4]]\n> > Some highlight text`);
  const v = wikiHighlight({ passage: "ignored when verbatim", label: "Momentum", verbatim: true, text: "L = m * v" });
  assert.equal(tn.renderHighlightRow(PDF_BASENAME, v), `> [!PDF|yellow] [[${SEL}|${PDF_BASENAME}, p.4]]\n> > L = m * v`);
  const uncoloured = wikiHighlight({ color: null, target: { page: 4, selection: { beginIndex: 2, beginOffset: 0, endIndex: 33, endOffset: 19 } } });
  assert.equal(tn.renderHighlightRow(PDF_BASENAME, uncoloured), `> [!PDF] [[${PDF_BASENAME}.pdf#page=4&selection=2,0,33,19|${PDF_BASENAME}, p.4]]\n> > Some highlight text`);
});

test("a label falls back to the quote when it is short, to its first clause when it is long, and never holds link syntax", () => {
  assert.equal(tn.renderHighlightRow(PDF_BASENAME, wikiHighlight({ text: "Linear Impulse", passage: "The effect of a force over time.", verbatim: false })), `- [[${SEL}|Linear Impulse]]: The effect of a force over time.`);
  const long = wikiHighlight({ text: "Receptors have 2 important properties: they bind ligands and transduce a signal, which albumin never does.", passage: "Two properties.", verbatim: false });
  assert.equal(tn.renderHighlightRow(PDF_BASENAME, long), `- [[${SEL}|Receptors have 2 important properties]]: Two properties.`);
  const piped = wikiHighlight({ label: "a | b [c]", passage: "P", verbatim: false });
  assert.equal(tn.renderHighlightRow(PDF_BASENAME, piped), `- [[${SEL}|a b c]]: P`);
  const multi = wikiHighlight({ label: "Impulse", passage: "One line.\nTwo lines.", verbatim: false });
  assert.equal(tn.renderHighlightRow(PDF_BASENAME, multi), `- [[${SEL}|Impulse]]: One line. Two lines.`);
});

test("an inline bullet run inside a verbatim quote becomes list lines inside the callout", () => {
  const h = wikiHighlight({
    page: 20,
    key: "page=20&selection=1,0,9,4",
    target: { page: 20, selection: { beginIndex: 1, beginOffset: 0, endIndex: 9, endOffset: 4 }, color: "yellow" },
    text: "Therefore, the pharmacokinetics of a drug involves 4 factors:• Absorption• Distribution• Metabolism• Elimination",
  });
  assert.equal(
    tn.renderHighlightRow(PDF_BASENAME, h),
    [
      `> [!PDF|yellow] [[${PDF_BASENAME}.pdf#page=20&selection=1,0,9,4&color=yellow|${PDF_BASENAME}, p.20]]`,
      "> > Therefore, the pharmacokinetics of a drug involves 4 factors:",
      "> > - Absorption",
      "> > - Distribution",
      "> > - Metabolism",
      "> > - Elimination",
    ].join("\n"),
  );
});

test("a numbered run keeps its numbers inside the callout, and a lone number is not a list", () => {
  const header = `> [!PDF|yellow] [[${SEL}|${PDF_BASENAME}, p.4]]`;
  const h = wikiHighlight({
    text: "1. Enteral = Oral (sublingual, buccal, GI tract) & via other mucous membranes (rectal) 2. “ Parenteral ” (par - outside or beyond intestine)",
  });
  assert.equal(
    tn.renderHighlightRow(PDF_BASENAME, h),
    [header, "> > 1. Enteral = Oral (sublingual, buccal, GI tract) & via other mucous membranes (rectal)", "> > 2. “ Parenteral ” (par - outside or beyond intestine)"].join("\n"),
  );
  const cont = wikiHighlight({ text: "4. Fat solubility of the drug (is it oil-based?) 5. Physio-chemical reaction with the contents of the GI tract" });
  assert.equal(
    tn.renderHighlightRow(PDF_BASENAME, cont),
    [header, "> > 4. Fat solubility of the drug (is it oil-based?)", "> > 5. Physio-chemical reaction with the contents of the GI tract"].join("\n"),
  );
  const gaps = wikiHighlight({ text: "Adopted in 2004. Section 7. applies, and 12. is repealed" });
  assert.equal(tn.renderHighlightRow(PDF_BASENAME, gaps), `${header}\n> > Adopted in 2004. Section 7. applies, and 12. is repealed`);
  const prose = wikiHighlight({ text: "Receptors have 2 important properties: they bind ligands and transduce a signal." });
  assert.equal(tn.renderHighlightRow(PDF_BASENAME, prose), `${header}\n> > Receptors have 2 important properties: they bind ligands and transduce a signal.`);
});

test("newlines in a quote split it the same way as inline bullets", () => {
  const h = wikiHighlight({ text: "involves 4 factors:\n• Absorption\n• Distribution" });
  assert.equal(
    tn.renderHighlightRow(PDF_BASENAME, h),
    [`> [!PDF|yellow] [[${SEL}|${PDF_BASENAME}, p.4]]`, "> > involves 4 factors:", "> > - Absorption", "> > - Distribution"].join("\n"),
  );
});

test("a passage row reads back with the passage as its text, and a callout row with its quote", () => {
  const md = `---\nclass: BIO101\n---\n# T\n\n## Highlights\n\n- [[${SEL}|Receptor affinity]]: Receptors bind drugs with high affinity.\n> [!PDF|yellow] [[${PDF_BASENAME}.pdf#page=5&selection=1,0,1,4&color=yellow|${PDF_BASENAME}, p.5]]\n> > L = m * v\n`;
  const parsed = tn.parseTopicNote(md);
  assert.equal(parsed.highlights.length, 2);
  assert.equal(parsed.highlights[0].text, "Receptors bind drugs with high affinity.");
  assert.equal(parsed.highlights[1].text, "L = m * v");
});

test("planTopicNotes writes an article: resolved prose, quotes as callouts under their section, figures, related", () => {
  const draft = {
    notes: [
      {
        title: "Receptors",
        summary: "Receptors are the proteins drugs bind to [H01]. They are studied within {{Pharmacology}} and mentioned by {{Nobody Home}}.",
        related: ["Pharmacology"],
        kind: "concept",
        aliases: ["Drug receptors"],
        tag: "term",
        closest_existing: "",
        why_new: "no page holds it",
        sections: [
          { heading: "Two Properties", prose: "A receptor binds with high affinity and then transduces a signal [H01]; albumin does neither [H09].", quote_ids: ["H01"] },
          { heading: "Figures Only", prose: "", quote_ids: ["H02"] },
        ],
      },
    ],
    unused_ids: [],
  };
  const manifest = manifestFor([{ ...SELECTION_HIGHLIGHT, id: "H01" }, { ...RECT_HIGHLIGHT, id: "H02" }]);
  const pages = [{ path: "classes/BIO101/Pharmacology.md", title: "Pharmacology", kind: "concept", aliases: [], classCodes: ["BIO101"], md: "---\nclass: BIO101\n---\n# Pharmacology\n" }];
  const result = tn.planTopicNotes(draft, manifest, { classCode: "BIO101", topicFolder: "classes", created: "2026-09-10", pages });
  assert.equal(result.notes.length, 1);
  const md = result.notes[0].content;
  const cite = `[[${PDF_BASENAME}.pdf#page=4&selection=2,0,33,19&color=yellow|${PDF_BASENAME}, p.4]]`;
  assert.ok(md.includes(`## Definition\nReceptors are the proteins drugs bind to ${cite}. They are studied within [[classes/BIO101/Pharmacology|Pharmacology]] and mentioned by Nobody Home.`), md);
  assert.ok(md.includes(`## Two Properties\nA receptor binds with high affinity and then transduces a signal ${cite}; albumin does neither.\n\n> [!PDF|yellow] ${cite}\n> > Receptors have 2 important properties:`), md);
  assert.ok(md.includes(`## Figures\n![[${PDF_BASENAME}.pdf#page=4&rect=13,55,713,222|${PDF_BASENAME}, p.4]]`), md);
  assert.ok(md.includes("## Related topics\n- [[Pharmacology]]"), md);
  assert.ok(!md.includes("## Summary") && !md.includes("## Highlights") && !md.includes("## Flashcard Seeds"), "the article shape replaces the old body");
  assert.ok(!md.includes("{{") && !md.includes("[H0"), "no marker survives to disk");
  assert.deepEqual(result.orphans, ["Nobody Home"]);
  assert.deepEqual(result.droppedIds, ["H09"]);
  assert.deepEqual(result.unknownIds, ["H09"]);
  assert.equal(result.notes[0].highlights.length, 2);
  assert.equal(result.notes[0].highlights[0].verbatim, true);
  assert.equal(result.notes[0].highlights[0].passage, "A receptor binds with high affinity and then transduces a signal Pharmacology, Pharmacodynamics, and Pharmacokinetics, p.4; albumin does neither.".replace("Pharmacology, Pharmacodynamics, and Pharmacokinetics, p.4", `${PDF_BASENAME}, p.4`), "the card writer gets the prose around the quote");
  assert.equal(manifest.highlights[0].passage, undefined, "the manifest's own row is untouched");
});

test("a pre-article draft with passages or highlight_ids still plans: unnamed sections under the opening", () => {
  const manifest = manifestFor([{ ...SELECTION_HIGHLIGHT, id: "H01" }]);
  const opts = { classCode: "BIO101", topicFolder: "classes", created: "2026-09-10", pages: [] };
  const passages = tn.planTopicNotes(
    { notes: [{ title: "Receptors", summary: "S", related: [], passages: [{ highlight_id: "H01", label: "Receptor affinity", text: "Receptors bind drugs with high affinity.", verbatim: false, coverage: "defined" }] }], unused_ids: [] },
    manifest,
    opts,
  );
  const md = passages.notes[0].content;
  assert.ok(md.includes("## Definition\nS\n\nReceptors bind drugs with high affinity.\n\n> [!PDF|yellow]"), md);
  assert.equal(passages.notes[0].highlights[0].verbatim, true);
  const legacy = tn.planTopicNotes({ notes: [{ title: "Receptors", summary: "S", related: [], highlight_ids: ["H01"] }], unused_ids: [] }, manifest, opts);
  assert.equal(legacy.notes.length, 1);
  assert.ok(legacy.notes[0].content.includes("## Definition\nS\n\n> [!PDF|yellow]"), legacy.notes[0].content);
  const named = tn.planTopicNotes(
    { notes: [{ title: "Receptors", summary: "S", related: [], passages: [{ highlight_id: "H01", label: "", text: "", verbatim: false, coverage: "named" }] }], unused_ids: [] },
    manifest,
    opts,
  );
  assert.deepEqual(named.namedIds, ["H01"]);
  assert.equal(named.notes.length, 0);
});

test("mergeArticle appends a section's prose and new quotes under the page's heading, creates a missing one, and never repeats", () => {
  const cite = `[[${PDF_BASENAME}.pdf#page=4&selection=2,0,33,19&color=yellow|${PDF_BASENAME}, p.4]]`;
  const existing = `---\nclass: BIO101\n---\n# Receptors\n\n## Definition\nOld opening.\n\n## Two Properties\nOld prose.\n\n## Related topics\n- [[Pharmacology]]\n`;
  const article = {
    definition: "A new opening the page must not gain.",
    sections: [
      { heading: "Two Properties", prose: `Binding and transduction ${cite}.`, highlights: [wikiHighlight({ verbatim: true })] },
      { heading: "Albumin Contrast", prose: "Albumin binds but never transduces.", highlights: [] },
    ],
    figures: [],
  };
  const r = tn.mergeArticle(existing, PDF_BASENAME, article);
  assert.equal(r.added, 1);
  assert.equal(r.skipped, 0);
  assert.ok(r.md.includes(`## Two Properties\nOld prose.\n\n> [!PDF|yellow] ${cite}\n> > Some highlight text\n\nBinding and transduction ${cite}.`), r.md);
  assert.ok(r.md.includes("## Albumin Contrast\n\nAlbumin binds but never transduces."), r.md);
  assert.ok(r.md.indexOf("## Albumin Contrast") < r.md.indexOf("## Related topics"), "a new section sits with the subtopics");
  assert.ok(r.md.includes("## Definition\nOld opening.\n\n## Two Properties"), "the page's own opening is untouched");
  assert.deepEqual(r.sections.map((x) => [x.heading, x.created]), [["Two Properties", false], ["Albumin Contrast", true]]);

  const again = tn.mergeArticle(r.md, PDF_BASENAME, article);
  assert.equal(again.added, 0);
  assert.equal(again.skipped, 1);
  assert.equal(again.md, r.md, "nothing is written twice");
});

test("mergeArticle with a section files the whole article under that heading, section names as lead lines", () => {
  const existing = `---\nclass: BIO101\n---\n# Pharmacology\n\n## Dosing\nDose text.\n\n## Related topics\n- [[x]]\n`;
  const article = { definition: "Receptors are what drugs bind to.", sections: [{ heading: "Two Properties", prose: "Bind, then transduce.", highlights: [wikiHighlight({ verbatim: true })] }], figures: [] };
  const r = tn.mergeArticle(existing, PDF_BASENAME, article, { section: "Receptors" });
  assert.ok(r.md.includes(`## [[${PDF_BASENAME}.pdf#page=4|Receptors]]\n\nReceptors are what drugs bind to.\n\n### Two Properties\n\nBind, then transduce.\n\n> [!PDF|yellow]`), r.md);
  assert.deepEqual(r.sections, [{ heading: "Receptors", keys: ["page=4&selection=2,0,33,19"], created: true }]);
});

test("parseTopicNote reads the opening from Definition or Description as it did from Summary", () => {
  assert.equal(tn.parseTopicNote("---\nclass: X\n---\n# T\n\n## Definition\nThe opening.\n\n## Next\nmore\n").summary, "The opening.");
  assert.equal(tn.parseTopicNote("---\nclass: X\n---\n# T\n\n## Description\nAn entity.\n").summary, "An entity.");
});

test("a rect row with no text is still the bare embed, and a mention row is still its line", () => {
  const rect = wikiHighlight({ kind: "rect", color: null, key: "page=4&rect=13,55,713,222", target: { page: 4, rect: [13, 55, 713, 222] }, text: "" });
  assert.equal(tn.renderHighlightRow(PDF_BASENAME, rect), `![[${PDF_BASENAME}.pdf#page=4&rect=13,55,713,222|${PDF_BASENAME}, p.4]]`);
  assert.equal(tn.renderHighlightRow("P", MENTION_ROW), MENTION_ROW.mention);
});

test("a section the merge creates carries a link to its first slide in the heading", () => {
  const existing = `---\nclass: BIO101\n---\n\n## Receptors\nReceptor text.\n\n## Highlights\n\n## Related topics\n- [[Pharmacology]]\n`;
  const r = tn.mergeWikiHighlights(existing, PDF_BASENAME, "BIO101", [HL(21, "b"), HL(19, "a")], { section: "COX Inhibitors and NSAIDs" });
  assert.equal(r.added, 2);
  assert.deepEqual(r.section, { heading: "COX Inhibitors and NSAIDs", created: true });
  const heading = `## [[${PDF_BASENAME}.pdf#page=19|COX Inhibitors and NSAIDs]]`;
  assert.ok(r.md.includes(`${heading}\n\n> [!PDF|yellow] [[${PDF_BASENAME}.pdf#page=19&selection=0,0,0,4&color=yellow|${PDF_BASENAME}, p.19]]\n> > span a\n\n> [!PDF`), r.md);
  assert.ok(r.md.indexOf(heading) < r.md.indexOf("## Highlights"), "the new section sits ahead of the highlights");

  // The linked heading is still the section on the next merge: matched by
  // its display text, not rewritten, and the new row goes under it.
  const again = tn.mergeWikiHighlights(r.md, PDF_BASENAME, "BIO101", [HL(21, "b"), HL(23, "c")], { section: "cox inhibitors and nsaids" });
  assert.equal(again.added, 1);
  assert.equal(again.skipped, 1);
  assert.deepEqual(again.section, { heading: "COX Inhibitors and NSAIDs", created: false });
  assert.equal(again.md.split(heading).length, 2, "the heading is written once");
  assert.ok(again.md.includes("> > span b") && again.md.indexOf("> > span c") < again.md.indexOf("## Highlights"));
  assert.deepEqual(tn.noteSections(again.md), ["Receptors", "COX Inhibitors and NSAIDs", "Highlights", "Related topics"]);
});

test("an existing heading the reader wrote is never rewritten with a link", () => {
  const existing = `---\nclass: BIO101\n---\n\n## Receptors\nReceptor text.\n\n## Highlights\n\n`;
  const r = tn.mergeWikiHighlights(existing, PDF_BASENAME, "BIO101", [HL(6, "b")], { section: "Receptors" });
  assert.ok(r.md.includes("## Receptors\nReceptor text.\n\n> [!PDF"), r.md);
  assert.ok(!r.md.includes("## [["));
});

test("parseTopicNote reads a bullet row's text, nested items included, without the link", () => {
  const md = [
    "---",
    "class: BIO101",
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

test("renderWikiNote's class schema writes a quote callout under Highlights", () => {
  const rendered = tn.renderWikiNote({ classCode: "BIO101", pdfBasename: PDF_BASENAME, summary: "S.", highlights: [wikiHighlight()] });
  assert.equal(
    rendered,
    `---\nclass: BIO101\n---\n\n## Summary\nS.\n\n## Highlights\n\n> [!PDF|yellow] [[${PDF_BASENAME}.pdf#page=4&selection=2,0,33,19&color=yellow|${PDF_BASENAME}, p.4]]\n> > Some highlight text\n`,
  );
});

// ---- fenced code blocks are not section boundaries
//
// A page may quote its own format in a fenced block, so a `## ` line inside a
// fence is text the reader wrote, not a heading. Treating one as a boundary
// splits the fence or files highlights under a heading that does not exist.

test("mergeWikiHighlights appends after a fenced ## heading, not inside the fence", () => {
  const existing = [
    "# T",
    "",
    "## Highlights",
    "",
    `- Some highlight text [[${PDF_BASENAME}.pdf#page=4&selection=2,0,33,19&color=yellow|p.4]]`,
    "",
    "```md",
    "## Example",
    "code the user wrote",
    "```",
    "",
    "more section text",
    "",
    "## Related topics",
    "",
  ].join("\n");
  const newHighlight = wikiHighlight({
    id: "H02",
    key: "page=6&selection=0,0,3,0",
    page: 6,
    target: { page: 6, selection: { beginIndex: 0, beginOffset: 0, endIndex: 3, endOffset: 0 }, color: "yellow" },
    text: "New text",
  });
  const result = tn.mergeWikiHighlights(existing, PDF_BASENAME, "BIO101", [newHighlight], { schema: "class" });
  assert.equal(result.added, 1);
  assert.ok(result.md.includes("```md\n## Example\ncode the user wrote\n```"), "the fence survives intact");
  const newLinkIdx = result.md.indexOf("page=6&selection=0,0,3,0");
  assert.ok(newLinkIdx > result.md.indexOf("more section text"), "the new row lands at the section's end");
  assert.ok(newLinkIdx < result.md.indexOf("## Related topics"), "and still inside ## Highlights");
});

test("mergeWikiHighlights ignores a fenced ## Highlights above the real one", () => {
  const existing = [
    "# T",
    "",
    "## Format",
    "",
    "~~~markdown",
    "## Highlights",
    "",
    "- example [[X.pdf#page=1|p.1]]",
    "~~~",
    "",
    "## Highlights",
    "",
    `- Some highlight text [[${PDF_BASENAME}.pdf#page=4&selection=2,0,33,19&color=yellow|p.4]]`,
    "",
    "## Related topics",
    "",
  ].join("\n");
  const newHighlight = wikiHighlight({
    id: "H02",
    key: "page=6&selection=0,0,3,0",
    page: 6,
    target: { page: 6, selection: { beginIndex: 0, beginOffset: 0, endIndex: 3, endOffset: 0 }, color: "yellow" },
    text: "New text",
  });
  const result = tn.mergeWikiHighlights(existing, PDF_BASENAME, "BIO101", [newHighlight], { schema: "class" });
  assert.equal(result.added, 1);
  const newLinkIdx = result.md.indexOf("page=6&selection=0,0,3,0");
  assert.ok(newLinkIdx > result.md.lastIndexOf("## Highlights"), "the row goes under the real heading");
  assert.ok(result.md.includes("~~~markdown\n## Highlights\n\n- example [[X.pdf#page=1|p.1]]\n~~~"), "the fenced example is untouched");
});

test("mergeTopicHighlights ignores a fenced ## Highlights above the real one", () => {
  const existing = [
    "# T",
    "",
    "## Format",
    "",
    "```md",
    "## Highlights",
    "```",
    "",
    "## Highlights",
    "",
    "> [!PDF|yellow] [[Other.pdf#page=1|Other, p.1]]",
    "> > Kept.",
    "",
    "## Related topics",
    "",
  ].join("\n");
  const result = tn.mergeTopicHighlights(existing, PDF_BASENAME, [{ key: "page=6", page: 6, target: { page: 6 }, text: "New text" }]);
  assert.equal(result.added, 1);
  const newIdx = result.md.indexOf("New text");
  assert.ok(newIdx > result.md.indexOf("Kept."), "appended to the real section");
  assert.ok(newIdx < result.md.indexOf("## Related topics"));
  assert.ok(result.md.includes("```md\n## Highlights\n```"), "the fenced example is untouched");
});

test("parseTopicNote reads the real ## Summary, not a fenced one", () => {
  const md = [
    "# T",
    "",
    "## Example",
    "",
    "```md",
    "## Summary",
    "",
    "fenced placeholder",
    "```",
    "",
    "## Summary",
    "",
    "The real summary.",
    "",
    "## Related topics",
    "",
  ].join("\n");
  assert.equal(tn.parseTopicNote(md).summary, "The real summary.");
});

test("parseTopicNote reads highlights past a fenced ## heading inside the section", () => {
  const md = [
    "# T",
    "",
    "## Highlights",
    "",
    "```md",
    "## Not a heading",
    "```",
    "",
    `- Some highlight text [[${PDF_BASENAME}.pdf#page=4&selection=2,0,33,19&color=yellow|p.4]]`,
    "",
    "## Related topics",
    "",
  ].join("\n");
  assert.deepEqual(
    tn.parseTopicNote(md).highlights.map((h) => h.page),
    [4],
  );
});

test("insertBeforeTrailing anchors on the real trailing heading, not a fenced one", () => {
  const body = [
    "# T",
    "",
    "## Format",
    "",
    "```md",
    "## Related topics",
    "```",
    "",
    "## Prose",
    "",
    "Body.",
    "",
    "## Related topics",
    "",
    "- [[A]]",
    "",
  ].join("\n");
  const out = tn.insertBeforeTrailing(body, "## New\n\n- row");
  assert.ok(out.indexOf("## New") > out.indexOf("Body."), "placed after the reader's prose");
  assert.ok(out.indexOf("## New") < out.lastIndexOf("## Related topics"));
  assert.ok(out.includes("```md\n## Related topics\n```"), "the fenced example is untouched");
});

test("spliceIntoSection appends past a fenced ## heading inside the section", () => {
  const body = ["## Notes", "", "```md", "## Fake", "```", "", "tail line", "", "## After", ""].join("\n");
  const found = tn.findSection(body, "Notes");
  const out = tn.spliceIntoSection(body, found.end, "- added");
  assert.ok(out.indexOf("- added") > out.indexOf("tail line"));
  assert.ok(out.indexOf("- added") < out.indexOf("## After"));
  assert.ok(out.includes("```md\n## Fake\n```"));
});

test("an unclosed fence swallows every ## heading after it", () => {
  const md = ["# T", "", "## Summary", "", "The real summary.", "", "```", "## Related topics", ""].join("\n");
  assert.equal(tn.parseTopicNote(md).summary, "The real summary.\n\n```\n## Related topics");
});

// The write path in src/digest.ts and src/suggest.ts re-runs the plan's merge
// inside `vault.process` against the file as it reads at write time, instead
// of writing back the string merged before the model call. That is only a
// correct substitution because the merge is replayable: re-running it over a
// page the reader has since edited must keep their edit and still add exactly
// the highlights that are genuinely missing. These two pin that property.
test("re-running a merge over an edited page keeps the edit and still appends the new highlight", () => {
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
    origins: ["classes/BIO101/Pharmacology.md"],
  };

  // What the planner merged against, minutes ago.
  const planned = tn.mergeTopicHighlights(LITERAL_NOTE, PDF_BASENAME, [SELECTION_HIGHLIGHT, newHighlight]);

  // Meanwhile the reader typed a sentence into ## Summary and added an alias.
  const edited = LITERAL_NOTE.replace(
    "## Summary\n",
    "## Summary\nAffinity is not efficacy: a high-affinity antagonist binds tightly and transduces nothing.\n",
  );

  const replayed = tn.mergeTopicHighlights(edited, PDF_BASENAME, [SELECTION_HIGHLIGHT, newHighlight]);

  // The reader's sentence survives, which the stale `planned.md` would have erased.
  assert.ok(replayed.md.includes("Affinity is not efficacy"));
  assert.ok(!planned.md.includes("Affinity is not efficacy"));

  // And the highlight the run was for still lands, exactly once.
  assert.equal(replayed.added, 1);
  assert.equal(replayed.skipped, 1);
  assert.equal(replayed.md.split("page=5&selection=10,0,12,8").length - 1, 1);
});

test("replaying a merge over its own output adds nothing: the highlights are already there", () => {
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
    origins: ["classes/BIO101/Pharmacology.md"],
  };

  const once = tn.mergeTopicHighlights(LITERAL_NOTE, PDF_BASENAME, [SELECTION_HIGHLIGHT, newHighlight]);
  const twice = tn.mergeTopicHighlights(once.md, PDF_BASENAME, [SELECTION_HIGHLIGHT, newHighlight]);

  // Idempotent: a reader who pasted the same highlight in by hand during the
  // preview gets it recognised, not duplicated.
  assert.equal(twice.added, 0);
  assert.equal(twice.skipped, 2);
  assert.equal(twice.md, once.md);
});

// ---- coverage: the digest reads the page before it writes

test("noteOutline lists each heading with the first sentence of prose beneath it, links reduced to words", () => {
  const md = "---\nclass: BIO201\n---\n# Kinetics\n\n## Definition\nThe study of forces that cause motion [[Deck.pdf#page=1|Deck, p.1]]. A second sentence.\n\n## [[Lab.pdf#page=1&selection=38,0,38,10|Linear Impulse]]\n[[Lab.pdf#page=1&selection=40,0,41,12|The effect of a force on a system]]: the net force acting over time\n\n> [!PDF] [[Lab.pdf#page=1|Lab, p.1]]\n> > quote\n\n## Empty\n\n## Related topics\n- [[x]]\n";
  assert.deepEqual(tn.noteOutline(md), [
    { heading: "Definition", lead: "The study of forces that cause motion Deck, p.1." },
    { heading: "Linear Impulse", lead: "The effect of a force on a system: the net force acting over time" },
    { heading: "Empty", lead: "" },
    { heading: "Related topics", lead: "" },
  ]);
});

test("mergeArticle with a coverage check does not quote or restate what the page already says, and counts it", () => {
  const cite = `[[${PDF_BASENAME}.pdf#page=4&selection=2,0,33,19&color=yellow|${PDF_BASENAME}, p.4]]`;
  const existing = `---\nclass: BIO101\n---\n# Receptors\n\n## Definition\nReceptors bind ligands with high affinity and transduce a signal.\n\n## Related topics\n- [[x]]\n`;
  const covered = (text) => /transduce a signal/i.test(text);
  const article = {
    definition: "",
    sections: [
      { heading: "Two Properties", prose: `Receptors bind with high affinity and transduce a signal ${cite}.`, highlights: [wikiHighlight({ verbatim: true, text: "They bind ligands and transduce a signal" })] },
      { heading: "Albumin", prose: "Albumin binds drugs but transduces nothing.", highlights: [wikiHighlight({ verbatim: true, key: "page=5&selection=1,0,1,4", target: { page: 5, selection: { beginIndex: 1, beginOffset: 0, endIndex: 1, endOffset: 4 }, color: "yellow" }, page: 5, text: "Albumin is inert" })] },
    ],
    figures: [],
  };
  const r = tn.mergeArticle(existing, PDF_BASENAME, article, { covered });
  assert.equal(r.said, 2, "one quote and one prose paragraph the page already states");
  assert.equal(r.added, 1);
  assert.ok(!r.md.includes("## Two Properties"), "a section with nothing new is not created");
  assert.ok(r.md.includes("## [[" + PDF_BASENAME + ".pdf#page=5|Albumin]]\n\nAlbumin binds drugs but transduces nothing."), r.md);
  assert.ok(r.md.includes("> > Albumin is inert"), r.md);
  assert.equal(tn.mergeArticle(existing, PDF_BASENAME, article).said, 0, "no check, nothing counted");
});

test("mergeArticle keeps a bulleted section line by line: indent kept, a covered bullet dropped whole, the lead and the rest untouched", () => {
  const existing = `---\nclass: BIO101\n---\n# Skeletal Muscle Tissue\n\n## Definition\nSkeletal muscle is voluntary striated muscle.\n\n## Related topics\n- [[x]]\n`;
  // A bullet the page already states in other words; the check sees the bullet's own words, marker and bold stripped.
  const covered = (text) => /collagen fibers type I plus elastin/i.test(text);
  const prose = [
    "Three connective tissue layers are continuous with the tendon.",
    "- **Epimysium** — covers the whole muscle and separates it from other tissues, a sheath of collagen fibers type I plus elastin and glycoproteins that wraps the belly",
    "- **Perimysium** — bundles muscle fibers into fascicles and carries the blood vessels and nerves that reach them",
    "\t- composed of collagen fibers of type I and type III, which is what lets the bundle stretch and recoil",
    "- **Endomysium** — reticular collagen type III around each fiber, holding the capillaries and nerve endings that feed it",
  ].join("\n");
  const article = {
    definition: "",
    sections: [{ heading: "Connective Tissue", prose, highlights: [wikiHighlight({ verbatim: true, text: "Muscles have 3 layers of connective tissues" })] }],
    figures: [],
  };
  const r = tn.mergeArticle(existing, PDF_BASENAME, article, { covered });
  const expected = [
    "Three connective tissue layers are continuous with the tendon.",
    "- **Perimysium** — bundles muscle fibers into fascicles and carries the blood vessels and nerves that reach them",
    "\t- composed of collagen fibers of type I and type III, which is what lets the bundle stretch and recoil",
    "- **Endomysium** — reticular collagen type III around each fiber, holding the capillaries and nerve endings that feed it",
  ].join("\n");
  assert.ok(r.md.includes(expected), r.md);
  assert.ok(!r.md.includes("Epimysium"), "the covered bullet is dropped whole, not spliced into its neighbours");
  assert.equal(r.said, 1, "one bullet the page already states");
});

test("planTopicNotes passes the coverage check per target page and flags rows a new page's class already states", () => {
  const manifest = manifestFor([{ ...SELECTION_HIGHLIGHT, id: "H01" }]);
  const home = { path: "classes/BIO101/Receptors.md", title: "Receptors", kind: "concept", aliases: [], classCodes: ["BIO101"], md: "---\nclass: BIO101\n---\n# Receptors\n\n## Definition\nOld.\n" };
  const seen = [];
  const coveredBy = (path, text) => {
    seen.push([path, text.slice(0, 20)]);
    return /Receptors have 2 important properties/.test(text);
  };
  const draft = { notes: [{ title: "Receptors", summary: "S", related: [], sections: [{ heading: "Props", prose: "Two properties [H01].", quote_ids: ["H01"] }] }], unused_ids: [] };
  const merged = tn.planTopicNotes(draft, manifest, { classCode: "BIO101", topicFolder: "classes", created: "2026-09-10", pages: [home], coveredBy });
  assert.equal(merged.notes[0].said, 1, "the quote the page already states is counted, not written");
  assert.ok(seen.some(([p]) => p === home.path), "the check was asked about the target page");
  assert.ok(!merged.notes[0].content.includes("> > Receptors have 2"), merged.notes[0].content);

  const fresh = tn.planTopicNotes({ ...draft, notes: [{ ...draft.notes[0], title: "Brand New" }] }, manifest, { classCode: "BIO101", topicFolder: "classes", created: "2026-09-10", pages: [home], coveredBy });
  assert.equal(fresh.notes[0].exists, false);
  assert.equal(fresh.notes[0].highlights[0].covered, true, "a new page's row is flagged when the class already says it");
  assert.ok(fresh.notes[0].content.includes("> > Receptors have 2"), "but a new page still quotes it: the row belongs there");
  assert.ok(seen.some(([p]) => p === null), "the class-wide check was asked with no page");
});

test("the coverage check sees prose without its citation text, so a file's title cannot dilute the claim", () => {
  const cite = `[[${PDF_BASENAME}.pdf#page=4&selection=2,0,33,19&color=yellow|${PDF_BASENAME}, p.4]]`;
  const seen = [];
  const covered = (text) => {
    seen.push(text);
    return false;
  };
  const existing = "---\nclass: BIO101\n---\n# R\n\n## Definition\nOld.\n";
  tn.mergeArticle(existing, PDF_BASENAME, { definition: "", sections: [{ heading: "S", prose: `Receptors bind ligands ${cite}. They also link to [[classes/BIO101/Pharmacology|Pharmacology]].`, highlights: [] }], figures: [] }, { covered });
  assert.deepEqual(seen, ["Receptors bind ligands.", "They also link to Pharmacology."], "one sentence at a time, citations gone, links reduced to words");
});

test("sentences the page already states are dropped from a paragraph and counted; the rest are kept with their citations", () => {
  const covered = (text) => /impulse is the area|equals the change in momentum/i.test(text);
  const existing = "---\nclass: BIO201\n---\n# K\n\n## Definition\nOld.\n";
  const cite = "[[Lab.pdf#page=1&selection=1,0,1,4|Lab, p.1]]";
  const mostly = `Linear impulse is the area under the force-time curve ${cite}. It equals the change in momentum of the object ${cite}. A dive needs both linear and angular impulse ${cite}.`;
  // Two of three already said is "mostly": the leftover sentence does not earn
  // a heading beside the reader's own, so the section is dropped whole and
  // every sentence in it is counted.
  const r1 = tn.mergeArticle(existing, "Lab", { definition: "", sections: [{ heading: "Impulse", prose: mostly, highlights: [] }], figures: [] }, { covered });
  assert.equal(r1.said, 3, "the section was mostly restatement, so all three are counted");
  assert.ok(!r1.md.includes("## Impulse"), r1.md);

  // One of three is under half: the section is created with the two new sentences.
  const someNew = `Linear impulse is the area under the force-time curve ${cite}. Propulsive impulse above braking impulse raises velocity ${cite}. A dive needs both linear and angular impulse ${cite}.`;
  const r3 = tn.mergeArticle(existing, "Lab", { definition: "", sections: [{ heading: "Impulse", prose: someNew, highlights: [] }], figures: [] }, { covered });
  assert.equal(r3.said, 1);
  assert.ok(r3.md.includes("## Impulse\n\nPropulsive impulse above braking impulse raises velocity"), r3.md);
  assert.ok(!r3.md.includes("Linear impulse is the area"), r3.md);
  const all = `Linear impulse is the area under the force-time curve ${cite}. It equals the change in momentum ${cite}.`;
  const r2 = tn.mergeArticle(existing, "Lab", { definition: "", sections: [{ heading: "Impulse", prose: all, highlights: [] }], figures: [] }, { covered });
  assert.equal(r2.said, 2);
  assert.ok(!r2.md.includes("## Impulse"), "nothing new, no section");
});

test("a planned merge row carries its article and the heading it was filed under, so the write can replay it", () => {
  const manifest = manifestFor([{ ...SELECTION_HIGHLIGHT, id: "H01" }]);
  const home = { path: "classes/BIO101/Receptors.md", title: "Receptors", kind: "concept", aliases: [], classCodes: ["BIO101"], md: "---\nclass: BIO101\n---\n# Receptors\n\n## Definition\nOld.\n" };
  const parent = { path: "classes/BIO101/Pharmacology.md", title: "Pharmacology", kind: "concept", aliases: [], classCodes: ["BIO101"], md: "---\nclass: BIO101\n---\n# Pharmacology\n\n## Definition\nDrugs.\n" };
  const note = (title, extra = {}) => ({ title, summary: "S", related: [], kind: "concept", aliases: [], tag: "term", closest_existing: "", why_new: "", sections: [{ heading: "Props", prose: "Two properties [H01].", quote_ids: ["H01"] }], ...extra });
  const opts = { classCode: "BIO101", topicFolder: "classes", created: "2026-09-10", pages: [home, parent] };
  const merged = tn.planTopicNotes({ notes: [note("Receptors")], unused_ids: [] }, manifest, opts);
  assert.ok(merged.notes[0].article, "home merge carries the article");
  assert.equal(merged.notes[0].articleSection, undefined);
  assert.equal(merged.notes[0].article.sections[0].heading, "Props");
  const routed = tn.planTopicNotes({ notes: [note("Receptor Subtypes", { closest_existing: "Pharmacology", why_new: "part of it" })], unused_ids: [] }, manifest, opts);
  const filed = routed.notes.find((n) => n.path === parent.path);
  assert.ok(filed && filed.article, "a routed merge carries the article");
  assert.equal(filed.articleSection, "Receptor Subtypes");
  // Replaying against the page as written yields the same page: nothing is appended twice.
  const again = tn.mergeArticle(merged.notes[0].content, PDF_BASENAME, merged.notes[0].article, { classCode: "BIO101" });
  assert.equal(again.md, merged.notes[0].content);
});

// ---- folding: a quote lands under the line that already cites it

test("a quote whose slide the page already links sits with that line, not at the end of the section", () => {
  const sel = "page=4&selection=2,0,33,19&color=yellow";
  const existing = [
    "---",
    "class: BIO101",
    "---",
    "# Receptors",
    "",
    "## Binding",
    `**[[${PDF_BASENAME}.pdf#page=4&selection=0,0,0,16&color=yellow|Two properties]]**`,
    "- my own note about affinity",
    "",
    "Some later paragraph of mine.",
    "",
    "## Related topics",
    "- [[x]]",
    "",
  ].join("\n");
  // A different span of the same slide: the page cites page 4 already, so the
  // new quote folds in beside that line rather than at the end.
  const h = wikiHighlight({ verbatim: true });
  const r = tn.mergeArticle(existing, PDF_BASENAME, {
    definition: "",
    sections: [{ heading: "Binding", prose: "Affinity and transduction are the two tests.", highlights: [h] }],
    figures: [],
  });
  assert.equal(r.added, 1, r.md);
  const lines = r.md.split("\n");
  const mine = lines.findIndex((l) => l.includes("my own note about affinity"));
  const quote = lines.findIndex((l) => l.includes("> > Some highlight text"));
  const later = lines.findIndex((l) => l.includes("Some later paragraph"));
  assert.ok(mine > 0 && quote > mine && quote < later, `quote should sit between my bullet and my later paragraph:\n${r.md}`);
  // The prose still goes at the end of the section, where a summary belongs.
  const prose = lines.findIndex((l) => l.startsWith("Affinity and transduction"));
  assert.ok(prose > later, `prose at the end:\n${r.md}`);
});

test("a quote whose slide the page does not mention still lands at the end of the section", () => {
  const existing = "---\nclass: BIO101\n---\n# R\n\n## Binding\n- my own note\n\n## Related topics\n- [[x]]\n";
  const h = wikiHighlight({ verbatim: true });
  const r = tn.mergeArticle(existing, PDF_BASENAME, { definition: "", sections: [{ heading: "Binding", prose: "", highlights: [h] }], figures: [] });
  const lines = r.md.split("\n");
  assert.ok(lines.findIndex((l) => l.includes("> > Some highlight text")) > lines.findIndex((l) => l.includes("my own note")), r.md);
});

test("a section whose sentences are nearly all already said is not created at all", () => {
  // Three of four sentences already on the page: the leftover does not earn a new heading.
  const covered = (t) => /already one|already two|already three/i.test(t);
  const existing = "---\nclass: X\n---\n# P\n\n## Definition\nOld.\n\n## Related topics\n- [[x]]\n";
  const prose = "This sentence is already one of the page's own. This sentence is already two of them. This sentence is already three of them. A fourth sentence that is genuinely new here.";
  const r = tn.mergeArticle(existing, "Deck", { definition: "", sections: [{ heading: "Mostly Said", prose, highlights: [] }], figures: [] }, { covered });
  assert.equal(r.said, 4, "the section is dropped whole, so all four of its sentences are counted");
  assert.ok(!r.md.includes("## Mostly Said"), `a section that is three-quarters restatement is dropped:\n${r.md}`);
});

test("a new section is never created under a heading the page already has, however it is worded", () => {
  const existing = "---\nclass: X\n---\n# P\n\n## Attachment Disorders, Conduct Disorder, and Oppositional Defiant Disorder\nMy own notes.\n\n## Related topics\n- [[x]]\n";
  const r = tn.mergeArticle(existing, "Deck", {
    definition: "",
    sections: [{ heading: "Conduct Disorder and Oppositional Defiant Disorder", prose: "Something new about CD and ODD.", highlights: [] }],
    figures: [],
  });
  assert.ok(!r.md.includes("## Conduct Disorder and Oppositional Defiant Disorder"), `folded into the existing heading:\n${r.md}`);
  assert.ok(r.md.includes("My own notes.\n\nSomething new about CD and ODD."), r.md);
});

// ---- B5: a digest merge into an existing page (release review items 7 and 8)

test("a quote folded beside a slide the reader already quoted lands after the reader's whole callout", () => {
  const cite = "[[Deck.pdf#page=4&selection=1,0,2,5&color=yellow|Deck, p.4]]";
  const readers = `> [!PDF|yellow] ${cite}\n> > Reader quote line one\n> > Reader quote line two\n>\n> My own comment.`;
  const body = `# Receptors\n\n## Properties\n\n${readers}\n\nAfter.\n`;
  const headingEnd = body.indexOf("## Properties") + "## Properties".length;
  const quote = "> [!PDF|yellow] [[Deck.pdf#page=4&selection=3,0,4,5&color=yellow|Deck, p.4]]\n> > A new quote from slide four";
  const out = tn.spliceBesideCitation(body, headingEnd, body.length, "Deck", 4, quote);
  assert.ok(out, "the section cites page 4, so the quote folds");
  assert.ok(out.includes(readers), `the reader's callout stays contiguous:\n${out}`);
  assert.ok(out.indexOf(quote) > out.indexOf("> My own comment."), `the new callout comes after the reader's:\n${out}`);
  assert.ok(out.indexOf(quote) < out.indexOf("After."), `and before the paragraph that followed it:\n${out}`);
});

test("two groups coalesced into one existing page both reach the replay, in order", () => {
  const h1 = { ...SELECTION_HIGHLIGHT, id: "H01" };
  const h2 = {
    ...SELECTION_HIGHLIGHT,
    id: "H02",
    key: "page=5&selection=1,0,9,12",
    page: 5,
    target: { page: 5, selection: { beginIndex: 1, beginOffset: 0, endIndex: 9, endOffset: 12 }, color: "yellow" },
    text: "Affinity is the strength with which a drug binds its receptor, read off as the dissociation constant.",
  };
  const manifest = manifestFor([h1, h2]);
  const home = {
    path: "classes/BIO101/Receptors.md",
    title: "Receptors",
    kind: "concept",
    aliases: ["Drug Receptors"],
    classCodes: ["BIO101"],
    md: "---\nclass: BIO101\naliases:\n  - \"Drug Receptors\"\n---\n# Receptors\n\n## Definition\nOld.\n",
  };
  const note = (title, heading, id, prose) => ({ title, summary: "S", related: [], kind: "concept", aliases: [], tag: "term", closest_existing: "", why_new: "", sections: [{ heading, prose, quote_ids: [id] }] });
  const draft = {
    notes: [note("Receptors", "Properties", "H01", "Receptors have two properties [H01]."), note("Drug Receptors", "Affinity", "H02", "Affinity is binding strength [H02].")],
    unused_ids: [],
  };
  const planned = tn.planTopicNotes(draft, manifest, { classCode: "BIO101", topicFolder: "classes", created: "2026-09-10", pages: [home] });
  assert.equal(planned.notes.length, 1, "both groups coalesce into the one page");
  const row = planned.notes[0];
  assert.deepEqual(row.groups, ["Receptors", "Drug Receptors"]);
  assert.equal(row.article.sections[0].heading, "Properties", "article stays the first group's");
  assert.deepEqual(row.articles.map((a) => a.article.sections[0].heading), ["Properties", "Affinity"], "every group's article is kept, in order");
  const replayed = tn.replayArticles(home.md, PDF_BASENAME, row.articles, { classCode: "BIO101" });
  for (const heading of ["Properties", "Affinity"]) {
    assert.ok(tn.noteSections(replayed).includes(heading), `replay writes the ${heading} section:\n${replayed}`);
  }
  for (const key of ["selection=2,0,33,19", "selection=1,0,9,12"]) {
    assert.ok(replayed.includes(key), `replay writes the ${key} quote:\n${replayed}`);
  }
  // Replaying only the first article, as the write used to, loses the second group.
  const firstOnly = tn.replayArticles(home.md, PDF_BASENAME, [{ article: row.article, section: row.articleSection }], { classCode: "BIO101" });
  assert.ok(!tn.noteSections(firstOnly).includes("Affinity"), "the first article alone does not hold the second group");
  assert.equal(replayed, row.content, "the replay writes what the preview showed");
});

// ---- Mind-map pages: ### branches under the reader's ## ------------------------

const NESTED_PAGE = `---
class: BIO101
---
## Muscle Tension
A fiber is all or none.
### Twitch Frequency
- **Twitch** one stimulus, one small rise in tension
### Tension Production
- **Cross-bridges** more pivoting, more tension

## Transduction
Signal in, force out.
### Sarcolemma
- **Membrane** carries the action potential

## Related topics
- [[Sarcomere]]
`;

test("mergeArticle files a section into the reader's ### branch of the same name, before the next ###", () => {
  const article = {
    definition: "",
    sections: [{ heading: "Twitch Frequency, Summation, and Tetanus", prose: "Summation builds tension.\n- **Summation** stimuli arrive before relaxation ends", highlights: [] }],
    figures: [],
  };
  const r = tn.mergeArticle(NESTED_PAGE, PDF_BASENAME, article, { title: "Muscle Tension" });
  assert.deepEqual(r.sections.map((x) => [x.heading, x.created]), [["Twitch Frequency", false]]);
  const twitch = r.md.indexOf("### Twitch Frequency");
  const tension = r.md.indexOf("### Tension Production");
  const summation = r.md.indexOf("**Summation**");
  assert.ok(twitch < summation && summation < tension, r.md);
  assert.ok(!r.md.includes("\n## Twitch Frequency, Summation"), "no new ## section beside the reader's branch");
});

test("mergeArticle creates a new branch as ### under the page's own ## when the page nests its branches", () => {
  const article = {
    definition: "",
    sections: [{ heading: "Motor Unit Recruitment and Tone", prose: "Units are recruited by size.\n- **Size principle** small units first", highlights: [] }],
    figures: [],
  };
  const r = tn.mergeArticle(NESTED_PAGE, PDF_BASENAME, article, { title: "Muscle Tension" });
  assert.deepEqual(r.sections.map((x) => [x.heading, x.created]), [["Motor Unit Recruitment and Tone", true]]);
  const created = r.md.indexOf("### Motor Unit Recruitment and Tone");
  assert.ok(created > 0, r.md);
  assert.ok(created > r.md.indexOf("### Tension Production") && created < r.md.indexOf("## Transduction"), "the new branch sits inside ## Muscle Tension, before the next ##");
  assert.ok(!r.md.includes("\n## Motor Unit Recruitment"), r.md);
});

test("mergeArticle adds a ## branch named for the page when it nests branches but has none for the title", () => {
  const page = NESTED_PAGE.replace("## Muscle Tension\nA fiber is all or none.\n", "## Contractions\nTypes of contraction.\n");
  const article = { definition: "", sections: [{ heading: "Motor Unit Recruitment", prose: "Lead.\n- **Size principle** small units first", highlights: [] }], figures: [] };
  const r = tn.mergeArticle(page, PDF_BASENAME, article, { title: "Muscle Tension" });
  const branch = r.md.indexOf("## Muscle Tension\n");
  assert.ok(branch > 0 && branch < r.md.indexOf("## Related topics"), r.md);
  assert.ok(r.md.indexOf("### Motor Unit Recruitment") > branch, r.md);
});

test("mergeArticle keeps ## for a new section on a flat digest page", () => {
  const existing = `---\nclass: BIO101\n---\n# Receptors\n\n## Definition\nOld opening.\n\n## Two Properties\nOld prose.\n\n## Related topics\n`;
  const article = { definition: "", sections: [{ heading: "Albumin Contrast", prose: "Lead.\n- **Albumin** binds but never transduces", highlights: [] }], figures: [] };
  const r = tn.mergeArticle(existing, PDF_BASENAME, article, { title: "Receptors" });
  assert.ok(r.md.includes("## Albumin Contrast\n"), r.md);
  assert.ok(!r.md.includes("### Albumin Contrast"), r.md);
});

// ---- Filing a proposed page into an existing one from the preview ------------------

test("applyDigestChoices files a new row into the page the reader picked, and the re-plan writes it there as a branch", () => {
  const manifest = twoHighlightManifest();
  const draft = {
    notes: [
      { title: "Pharmacology", kind: "concept", aliases: [], tag: "term", closest_existing: "", why_new: "", summary: "S.", highlight_ids: ["H05"], related: [] },
      { title: "Self-Efficacy", kind: "concept", aliases: [], tag: "term", closest_existing: "", why_new: "nothing listed is about beliefs", summary: "A belief.", highlight_ids: ["H04"], related: [] },
    ],
    unused_ids: [],
  };
  const planned = tn.planTopicNotes(draft, manifest, { ...DIGEST_OPTS, pages: [HOME_PHARM] });
  assert.equal(planned.notes.length, 2);
  const fresh = planned.notes.find((n) => !n.exists);
  const home = planned.notes.find((n) => n.exists);
  const { draft: narrowed, keepAsNew } = tn.applyDigestChoices(draft, planned.notes, [
    { path: home.path, title: home.title },
    { path: fresh.path, title: fresh.title, fileInto: "Pharmacology" },
  ]);
  assert.equal(narrowed.notes.find((n) => n.title === "Self-Efficacy").closest_existing, "Pharmacology");
  assert.deepEqual(keepAsNew, [], "a row filed into a page is not pinned as new");
  const replanned = tn.planTopicNotes(narrowed, manifest, { ...DIGEST_OPTS, pages: [HOME_PHARM], keepAsNew });
  assert.equal(replanned.notes.length, 1, "both groups land in the one page");
  assert.equal(replanned.notes[0].path, HOME_PHARM.path);
  assert.match(replanned.notes[0].content, /^## .*Self-Efficacy/m);
});

test("a filed article's sub-sections sit one level under the branch they land in", () => {
  const article = {
    definition: "Lead.",
    sections: [{ heading: "Sub Topic", prose: "Line.\n- **Term** claim", highlights: [] }],
    figures: [],
  };
  const flat = tn.mergeArticle("## Existing\nText.\n", PDF_BASENAME, article, { section: "New Branch" });
  assert.ok(flat.md.includes("## New Branch\n\nLead.\n\n### Sub Topic\n\nLine."), flat.md);
  const nested = tn.mergeArticle("## Parent\nText.\n### Twitch Frequency\n- a\n", PDF_BASENAME, article, { section: "Twitch Frequency" });
  assert.ok(nested.md.includes("#### Sub Topic"), nested.md);
});

test("typing another existing page's name into a merging row's box sends the topic to that page", () => {
  const manifest = twoHighlightManifest();
  const OTHER = { ...HOME_PHARM, path: "classes/BIO101/Receptors.md", title: "Receptors", md: HOME_PHARM.md.replace("# Pharmacology", "# Receptors") };
  const draft = { notes: [{ title: "Pharmacology", kind: "concept", aliases: [], tag: "term", closest_existing: "", why_new: "", summary: "S.", highlight_ids: ["H05"], related: [] }], unused_ids: [] };
  const pages = [HOME_PHARM, OTHER];
  const planned = tn.planTopicNotes(draft, manifest, { ...DIGEST_OPTS, pages });
  assert.equal(planned.notes[0].path, HOME_PHARM.path);
  const { draft: narrowed, keepAsNew } = tn.applyDigestChoices(draft, planned.notes, [{ path: HOME_PHARM.path, title: "receptors" }], ["Pharmacology", "Receptors"]);
  assert.equal(narrowed.notes[0].title, "Receptors");
  assert.deepEqual(keepAsNew, []);
  const replanned = tn.planTopicNotes(narrowed, manifest, { ...DIGEST_OPTS, pages, keepAsNew });
  assert.equal(replanned.notes.length, 1);
  assert.equal(replanned.notes[0].path, OTHER.path);
});
