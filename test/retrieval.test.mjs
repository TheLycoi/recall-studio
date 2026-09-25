// Run with: npm test  (bundles src/retrieval.ts and src/topicNote.ts first, then exercises them with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let rt;
let tn;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
  const outRetrieval = path.join(dir, "retrieval.mjs");
  const outTopicNote = path.join(dir, "topicNote.mjs");
  await build({ entryPoints: ["src/retrieval.ts"], bundle: true, format: "esm", platform: "node", outfile: outRetrieval, logLevel: "silent" });
  await build({ entryPoints: ["src/topicNote.ts"], bundle: true, format: "esm", platform: "node", outfile: outTopicNote, logLevel: "silent" });
  rt = await import(pathToFileURL(outRetrieval).href);
  tn = await import(pathToFileURL(outTopicNote).href);

  RECEPTORS_MD = tn.renderTopicNote({
    title: "Receptors",
    classCode: "HBIO250",
    created: "2026-09-10",
    pdfBasename: PHARM_PDF,
    summary: "Receptors bind drugs with high affinity and transduce a signal.",
    highlights: RECEPTORS_HIGHLIGHTS,
    related: [],
    kind: "concept",
    tag: "term",
    aliases: [],
  });
  KINETICS_MD = tn.renderTopicNote({
    title: "Pharmacokinetics",
    classCode: "HBIO250",
    created: "2026-09-10",
    pdfBasename: PHARM_PDF,
    summary: "What the body does to the drug: absorption, distribution, metabolism, excretion.",
    highlights: KINETICS_HIGHLIGHTS,
    related: [],
    kind: "concept",
    tag: "term",
    aliases: [],
  });
});

const PHARM_PDF = "HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics";
const CLAIMS_PDF = "Module 3 - CH 3 Video Assignments (2) - Conrad Ragsdale";

const RECEPTORS_PATH = "classes/HBIO250/Receptors.md";
const KINETICS_PATH = "classes/HBIO250/Pharmacokinetics.md";
const STAGES_PATH = "classes/PHED163/Stages of Change.md";

function selection(page, text, color = "yellow") {
  return {
    id: `H${page}`,
    key: `page=${page}&selection=2,0,33,19`,
    page,
    kind: "selection",
    color,
    target: { page, selection: { beginIndex: 2, beginOffset: 0, endIndex: 33, endOffset: 19 }, color },
    text,
    before: "",
    after: "",
    origins: [],
  };
}

// Two topic notes rendered by renderTopicNote: 3 highlights and 8 highlights.
const RECEPTORS_HIGHLIGHTS = [
  selection(4, "Receptors bind ligands with relatively high affinity and then transduce a signal."),
  selection(5, "The better the structural fit, the higher the receptor affinity for the drug."),
  selection(6, "Albumin binds and carries many drugs but transduces no signal, so it is not a receptor."),
];

const KINETICS_TEXTS = [
  "Absorption is the movement of a drug from its site of administration into the bloodstream.",
  "Distribution carries the drug from the blood to the receptor sites in the tissues.",
  "Metabolism converts the drug into metabolites, usually in the liver.",
  "Excretion removes the drug and its metabolites, mostly through the kidneys.",
  "First-pass metabolism reduces how much of an oral dose reaches the receptor.",
  "The volume of distribution relates the dose given to the plasma concentration measured.",
  "Clearance is the volume of plasma cleared of the drug per unit time.",
  "Half-life sets the dosing interval that keeps a receptor occupied between doses.",
];
const KINETICS_HIGHLIGHTS = KINETICS_TEXTS.map((t, i) => selection(i + 1, t));

let RECEPTORS_MD;
let KINETICS_MD;

// A PHED163-style claims note: the shape of
// projects/classes/PHED163/Stages of Change.md, three bullets, em dash separator.
const STAGES_MD = `---
type: topic
class: PHED163
created: 2026-09-07
source_file: "[[${CLAIMS_PDF}.pdf]]"
tags: [phed163]
---

# The five stages of change

## Summary
The five stages of behavior change, what defines each, and what the coach does in each.

## Key claims
- Precontemplation: the client has no intention of changing in the foreseeable future, and is often uninformed of the consequences of their behavior. — [[${CLAIMS_PDF}.pdf#page=1|p.1]]
- ==Contemplation: the client intends to change within the next six months and weighs pros and cons.== That weighing is ambivalence, the key element of this stage. — [[${CLAIMS_PDF}.pdf#page=1|p.1]]
- ==Maintenance: the client has engaged in the target behavior for at least six months.== The coach revises goals to stay interesting and attainable. — [[${CLAIMS_PDF}.pdf#page=2|p.2]]

## Related topics
- [[Decisional Balance and Processes of Change]]

## Flashcard Seeds
`;

function indexAll() {
  return [
    ...rt.indexNote(RECEPTORS_PATH, RECEPTORS_MD),
    ...rt.indexNote(KINETICS_PATH, KINETICS_MD),
    ...rt.indexNote(STAGES_PATH, STAGES_MD),
  ];
}

// A token-overlap scorer: how many of the question's tokens appear in the
// text, null when none do. Stands in for prepareSimpleSearch, which lives in
// the `obsidian` module this file must not resolve.
function tokenOverlap(question) {
  const tokens = question.toLowerCase().split(/\s+/).filter(Boolean);
  return (text) => {
    const hay = text.toLowerCase();
    let score = 0;
    for (const t of tokens) if (hay.includes(t)) score += 1;
    return score === 0 ? null : score;
  };
}

test("indexNote returns 14 units across the three notes with the right kinds", () => {
  const receptors = rt.indexNote(RECEPTORS_PATH, RECEPTORS_MD);
  const kinetics = rt.indexNote(KINETICS_PATH, KINETICS_MD);
  const stages = rt.indexNote(STAGES_PATH, STAGES_MD);

  assert.equal(receptors.length, 3);
  assert.equal(kinetics.length, 8);
  assert.equal(stages.length, 3);
  assert.equal(indexAll().length, 14);

  assert.ok(receptors.every((u) => u.kind === "highlight"));
  assert.ok(kinetics.every((u) => u.kind === "highlight"));
  assert.ok(stages.every((u) => u.kind === "claim"));
});

test("indexNote skips the line that says where a hand-written note came from", () => {
  // No `## Highlights`, no `## Key claims`: the prose fallback indexes this.
  const md = [
    "## Stages of Change",
    "",
    "Source: *The Professional's Guide to Health and Wellness Coaching* (American Council on Exercise), Chapter 3.",
    "",
    "- **Traits:** Unaware or under-aware of the problem, or believe it cannot be solved.",
    "- Explain and personalize the inherent risks",
  ].join("\n");
  const units = rt.indexNote("wiki/concepts/Stages of Change.md", md);

  // The attribution is metadata about the note, not a claim in it. Left in, the
  // quiz asked which organisation published the table instead of asking about
  // the stages themselves.
  assert.equal(
    units.some((u) => /American Council on Exercise/.test(u.text)),
    false,
    "the citation line is not evidence",
  );
  assert.equal(units.length, 2, "the two real statements survive");
  assert.match(units[0].text, /Unaware or under-aware/);
});

test("indexNote keeps a sentence that merely mentions a source", () => {
  // The rule is anchored at the start of the line, so a real statement that
  // happens to discuss sources is still evidence.
  const md = [
    "## Media",
    "",
    "- Utilize general sources, including media, Internet, and brochures to increase awareness",
  ].join("\n");
  const units = rt.indexNote("wiki/concepts/Media.md", md);
  assert.equal(units.length, 1);
  assert.match(units[0].text, /Utilize general sources/);
});

test("indexNote carries titles, ids, pages and targets", () => {
  const receptors = rt.indexNote(RECEPTORS_PATH, RECEPTORS_MD);
  assert.deepEqual(receptors.map((u) => u.page), [4, 5, 6]);
  assert.deepEqual(receptors.map((u) => u.id), [
    `${RECEPTORS_PATH}#h0`,
    `${RECEPTORS_PATH}#h1`,
    `${RECEPTORS_PATH}#h2`,
  ]);
  assert.ok(receptors.every((u) => u.noteTitle === "Receptors"));
  assert.ok(receptors.every((u) => u.notePath === RECEPTORS_PATH));
  assert.equal(receptors[0].pdfBasename, PHARM_PDF);
  assert.deepEqual(receptors[0].target.selection, { beginIndex: 2, beginOffset: 0, endIndex: 33, endOffset: 19 });

  const stages = rt.indexNote(STAGES_PATH, STAGES_MD);
  assert.deepEqual(stages.map((u) => u.page), [1, 1, 2]);
  assert.deepEqual(stages.map((u) => u.id), [
    `${STAGES_PATH}#c0`,
    `${STAGES_PATH}#c1`,
    `${STAGES_PATH}#c2`,
  ]);
  assert.ok(stages.every((u) => u.noteTitle === "The five stages of change"));
  assert.equal(stages[0].pdfBasename, CLAIMS_PDF);
  assert.deepEqual(stages[2].target, { page: 2 });
});

test("indexNote carries the note's class codes, scalar or list, and none when absent", () => {
  const scalar = rt.indexNote("classes/HBIO250/X.md", "---\nclass: HBIO250\n---\nA sentence of prose here.");
  assert.deepEqual(scalar[0].classCodes, ["HBIO250"]);
  const list = rt.indexNote("classes/HBIO250/Y.md", "---\nclass: [HBIO250, PHED163]\n---\nAnother sentence of prose here.");
  assert.deepEqual(list[0].classCodes, ["HBIO250", "PHED163"]);
  const none = rt.indexNote("notes/Z.md", "A sentence of prose here.");
  assert.deepEqual(none[0].classCodes, []);
});

test("indexNote strips == marks and the source link from claim text", () => {
  const stages = rt.indexNote(STAGES_PATH, STAGES_MD);
  assert.equal(
    stages[1].text,
    "Contemplation: the client intends to change within the next six months and weighs pros and cons. That weighing is ambivalence, the key element of this stage.",
  );
  assert.ok(!stages[1].text.includes("=="));
  assert.ok(!stages[1].text.includes("[["));
});

test("indexNote falls back to the file basename when the note has no H1", () => {
  const md = "## Key claims\n- A claim about clearance. — [[Notes.pdf#page=3|p.3]]\n";
  const units = rt.indexNote("classes/HBIO250/Untitled Note.md", md);
  assert.equal(units.length, 1);
  assert.equal(units[0].noteTitle, "Untitled Note");
  assert.equal(units[0].page, 3);
});

test("indexNote leaves target and page null for a claim linking to a non-PDF note", () => {
  const md = "## Key claims\n- Coaching honors client autonomy. — [[Health Coach|the coach note]]\n";
  const units = rt.indexNote("classes/PHED163/Autonomy.md", md);
  assert.equal(units.length, 1);
  assert.equal(units[0].target, null);
  assert.equal(units[0].pdfBasename, null);
  assert.equal(units[0].page, null);
  assert.equal(units[0].text, "Coaching honors client autonomy.");
});

test("rankEvidence ranks the affinity highlight first and caps one note at ceil(k/2)", () => {
  const units = indexAll();
  const ranked = rt.rankEvidence(units, "receptor affinity", tokenOverlap("receptor affinity"), 4);

  assert.equal(ranked.length, 4);
  assert.ok(ranked[0].text.includes("affinity"));
  assert.equal(ranked[0].notePath, RECEPTORS_PATH);

  const fromKinetics = ranked.filter((u) => u.notePath === KINETICS_PATH).length;
  assert.ok(fromKinetics <= 2, `expected at most 2 units from the 8-highlight note, got ${fromKinetics}`);
});

test("rankEvidence keeps scanning past a note that hit its cap", () => {
  // Every kinetics unit outscores the single receptors unit, but only
  // ceil(4/2) = 2 of them may be taken, so lower-scoring notes still fill k.
  const units = indexAll();
  const scorer = (text) => {
    if (KINETICS_TEXTS.includes(text)) return 10;
    return text.toLowerCase().includes("e") ? 1 : null;
  };
  const ranked = rt.rankEvidence(units, "anything", scorer, 4);
  assert.equal(ranked.length, 4);
  assert.equal(ranked.filter((u) => u.notePath === KINETICS_PATH).length, 2);
  assert.ok(ranked.some((u) => u.notePath !== KINETICS_PATH));
});

test("rankEvidence drops a unit whose text scores null even when its title matches", () => {
  const units = indexAll();
  // "Receptors" is the note title; no receptors highlight text contains
  // "glomerular", so only the title would score.
  const scorer = (text) => {
    const hay = text.toLowerCase();
    if (hay.includes("glomerular")) return 5;
    if (hay === "receptors") return 3;
    return null;
  };
  const ranked = rt.rankEvidence(units, "glomerular", scorer, 4);
  assert.equal(ranked.length, 0);
  assert.ok(!ranked.some((u) => u.notePath === RECEPTORS_PATH));
});

test("rankEvidence adds 0.15 of the note-title score and breaks ties by path, page, text", () => {
  const units = indexAll();
  // Both notes' texts score 1; only "Receptors" matches the title, so its
  // units sort ahead of the kinetics units despite the path order.
  const scorer = (text) => (text.toLowerCase().includes("receptor") ? 1 : null);
  const ranked = rt.rankEvidence(units, "receptor", scorer, 4);
  assert.equal(ranked[0].notePath, RECEPTORS_PATH);
  // Within the same note and score, ascending page.
  const receptorsRanked = ranked.filter((u) => u.notePath === RECEPTORS_PATH);
  const pages = receptorsRanked.map((u) => u.page);
  assert.deepEqual(pages, [...pages].sort((a, b) => a - b));
});

test("numberEvidence numbers from 1 and carries title, page, text", () => {
  const units = indexAll();
  const ranked = rt.rankEvidence(units, "receptor affinity", tokenOverlap("receptor affinity"), 4);
  const numbered = rt.numberEvidence(ranked);
  assert.deepEqual(numbered.map((e) => e.n), [1, 2, 3, 4]);
  assert.equal(numbered[0].noteTitle, ranked[0].noteTitle);
  assert.equal(numbered[0].page, ranked[0].page);
  assert.equal(numbered[0].text, ranked[0].text);
  assert.deepEqual(Object.keys(numbered[0]).sort(), ["n", "noteTitle", "page", "text"]);
});

test("renderEvidenceMarkdown renders a selection highlight as a PDF++ callout", () => {
  const receptors = rt.indexNote(RECEPTORS_PATH, RECEPTORS_MD);
  const md = rt.renderEvidenceMarkdown(receptors[0], 2);
  const lines = md.split("\n");
  assert.equal(lines[0], "**[2]** [[classes/HBIO250/Receptors|Receptors]]");
  assert.ok(lines[1].startsWith("> [!PDF|yellow] [["), lines[1]);
  assert.ok(lines[1].includes("#page=4&selection=2,0,33,19&color=yellow|p.4]]"));
  assert.equal(lines[2], `> > ${receptors[0].text}`);
});

test("renderEvidenceMarkdown renders a claim without a PDF target as a quote block", () => {
  const md0 = "## Key claims\n- Coaching honors client autonomy. — [[Health Coach|the coach note]]\n";
  const unit = rt.indexNote("classes/PHED163/Autonomy.md", md0)[0];
  const md = rt.renderEvidenceMarkdown(unit, 1);
  const lines = md.split("\n");
  assert.equal(lines[0], "**[1]** [[classes/PHED163/Autonomy|Autonomy]]");
  assert.ok(lines[1].startsWith("> "), lines[1]);
  assert.ok(!lines[1].startsWith("> [!PDF"), lines[1]);
  assert.equal(lines[1], "> Coaching honors client autonomy.");
  assert.equal(lines.length, 2);
});

test("renderEvidenceMarkdown renders a PDF-linked claim as a callout at its page", () => {
  const stages = rt.indexNote(STAGES_PATH, STAGES_MD);
  const md = rt.renderEvidenceMarkdown(stages[2], 3);
  const lines = md.split("\n");
  assert.equal(lines[0], "**[3]** [[classes/PHED163/Stages of Change|The five stages of change]]");
  assert.ok(lines[1].startsWith("> [!PDF] [["), lines[1]);
  assert.ok(lines[1].includes("#page=2|p.2]]"));
});

test("questionScorer counts significant shared words, ignoring stopwords and plurals", () => {
  const score = rt.questionScorer("What are the five stages of change and what does the coach do in the contemplation stage?");
  assert.equal(score("Contemplation: the client intends to change within the next six months and weighs pros and cons."), 2);
  assert.equal(score("The coach listens carefully and shares benefits only with permission."), 1);
  assert.equal(score("Receptors bind ligands with high affinity."), null);
  assert.equal(rt.questionScorer("the and of")("anything"), null);
});

// A note written by hand — no `## Highlights`, no `## Key claims` — used to
// index to nothing, so Ask answered "no coverage" for a topic the vault
// covered. These cover the prose fallback that makes such a note answerable.

test("indexNote falls back to prose when a note has neither section", () => {
  const md = `---\nclass: HBIO408\n---\n**Definition**: A theoretical point about which an object's mass is equally distributed\n- Used to model whole body movements using classical mechanics\n`;
  const units = rt.indexNote("wiki/concepts/TBCM.md", md);
  assert.equal(units.length, 2);
  assert.equal(units[0].noteTitle, "TBCM");
  assert.equal(units[0].text, "Definition: A theoretical point about which an object's mass is equally distributed");
  assert.equal(units[1].text, "Used to model whole body movements using classical mechanics");
});

test("indexNote leaves a structured note untouched by the fallback", () => {
  const structured = rt.indexNote("classes/HBIO250/Receptors.md", RECEPTORS_MD);
  assert.ok(structured.length > 0);
  assert.ok(structured.every((u) => u.kind === "highlight" || u.kind === "claim"));
  // Every unit still comes from the parsed sections, not from raw prose.
  assert.ok(structured.every((u) => /#(h|c)\d+$/.test(u.id)));
});

test("prose fallback carries the callout header's page down to the quoted text", () => {
  const md = [
    "---", "class: HBIO250", "---",
    "> [!PDF|yellow] [[Pharm.pdf#page=2&selection=1,0,1,5&color=yellow|Pharm, p.2]]",
    "> > Pharmacokinetics = “What the body does to drugs”",
  ].join("\n");
  const units = rt.indexNote("wiki/concepts/Pharmacology.md", md);
  assert.equal(units.length, 1);
  assert.equal(units[0].text, "Pharmacokinetics = “What the body does to drugs”");
  assert.equal(units[0].page, 2);
  assert.equal(units[0].pdfBasename, "Pharm");
});

test("prose fallback skips headings, embeds, code fences and short fragments", () => {
  const md = [
    "---", "class: X", "---",
    "## Dosing",
    "![[Pharm.pdf#page=10&rect=1,2,3,4&color=yellow]]",
    "ok",
    "```",
    "const skipped = true;",
    "```",
    "The amount of drug required to produce an effect of given intensity.",
  ].join("\n");
  const units = rt.indexNote("wiki/concepts/Dosing.md", md);
  assert.equal(units.length, 1);
  assert.equal(units[0].text, "The amount of drug required to produce an effect of given intensity.");
});

test("prose fallback reduces wikilinks to their display text", () => {
  const md = `---\nclass: X\n---\nThe drug with the lowest [[Pharm.pdf#page=11&selection=7,25,9,1|EC50]] has the highest potency here\n`;
  const units = rt.indexNote("wiki/concepts/Potency.md", md);
  assert.equal(units.length, 1);
  assert.equal(units[0].text, "The drug with the lowest EC50 has the highest potency here");
  assert.equal(units[0].page, 11);
});

test("an empty note still indexes to nothing", () => {
  assert.equal(rt.indexNote("wiki/entities/WADA.md", "---\nclass: HBIO250\n---\n").length, 0);
});

// Adapted from gd4ai/obsidian-llm-wiki's needle scoring, where a hit on a page
// title outweighs a hit on an alias rather than every hit counting once.

test("significantTokens drops filler verbs that used to score like real terms", () => {
  const tokens = rt.significantTokens("how do drugs get absorbed");
  assert.ok(!tokens.includes("get"), "filler verb 'get' must not be a search term");
  assert.ok(tokens.includes("drug"));
  assert.ok(tokens.includes("absorbed"));
});

test("questionScorer weights a rare word above a word every unit uses", () => {
  const units = [
    { id: "a#p0", notePath: "a.md", noteTitle: "A", pdfBasename: null, target: null, page: null, text: "analysis of receptor binding", kind: "claim" },
    { id: "b#p0", notePath: "b.md", noteTitle: "B", pdfBasename: null, target: null, page: null, text: "analysis of motion capture", kind: "claim" },
    { id: "c#p0", notePath: "c.md", noteTitle: "C", pdfBasename: null, target: null, page: null, text: "analysis of gait cycles", kind: "claim" },
  ];
  const score = rt.questionScorer("receptor analysis", units);
  // "receptor" is in 1 of 3 units, "analysis" in all 3: the unit carrying the
  // rare word must outscore one carrying only the common word.
  assert.ok(score(units[0].text) > score(units[1].text));
});

test("questionScorer falls back to plain overlap on an empty corpus", () => {
  const score = rt.questionScorer("receptor binding", []);
  assert.equal(score("receptor binding affinity"), 2);
  assert.equal(score("nothing relevant here"), null);
});

test("questionScorer returns null when no question word appears", () => {
  const units = [
    { id: "a#p0", notePath: "a.md", noteTitle: "A", pdfBasename: null, target: null, page: null, text: "receptor binding", kind: "claim" },
  ];
  assert.equal(rt.questionScorer("quantum entanglement", units)("receptor binding"), null);
});

// Graph expansion and keyword ranking: the two stages that run when the
// reader's own words leave the evidence list short.

const unit = (note, text, id) => ({
  id: id ?? `${note}#p0`, notePath: note, noteTitle: note.replace(/\.md$/, ""),
  pdfBasename: null, target: null, page: null, text, kind: "claim",
});

test("expandWithGraph adds a passage from a linked note when lexical came up short", () => {
  const units = [unit("a.md", "receptor binding affinity"), unit("b.md", "second messenger cascades")];
  // Enough edges that the graph is worth walking (isGraphUsable's gate).
  const graph = {
    nodes: ["a.md", "b.md", "c.md", "d.md"],
    edges: new Map([
      ["a.md", ["b.md", "c.md"]],
      ["b.md", ["a.md", "c.md"]],
      ["c.md", ["a.md", "d.md"]],
      ["d.md", ["a.md", "b.md"]],
    ]),
  };
  const lexical = [units[0]];
  const out = rt.expandWithGraph(lexical, units, graph, 4);
  assert.equal(out[0].id, units[0].id, "the lexical hit keeps its place");
  assert.ok(out.length > 1, "a linked note should be reached");
  assert.equal(out[1].notePath, "b.md");
});

test("expandWithGraph leaves a full evidence list alone", () => {
  const units = [unit("a.md", "one"), unit("b.md", "two")];
  const graph = { nodes: ["a.md", "b.md"], edges: new Map([["a.md", ["b.md"]], ["b.md", ["a.md"]]]) };
  const full = [units[0], units[1]];
  assert.deepEqual(rt.expandWithGraph(full, units, graph, 2), full);
});

test("expandWithGraph does nothing without seeds or a usable graph", () => {
  const units = [unit("a.md", "one"), unit("b.md", "two")];
  const graph = { nodes: ["a.md", "b.md"], edges: new Map([["a.md", ["b.md"]], ["b.md", []]]) };
  // No lexical hits: nothing query-relevant to walk from.
  assert.deepEqual(rt.expandWithGraph([], units, graph, 4), []);
  // A graph with almost no edges is not worth walking.
  const bare = { nodes: ["a.md", "b.md"], edges: new Map([["a.md", []], ["b.md", []]]) };
  assert.deepEqual(rt.expandWithGraph([units[0]], units, bare, 4), [units[0]]);
});

test("rankByKeywords puts a title match above a body match", () => {
  const units = [
    unit("Other.md", "a passing mention of pharmacokinetics in another topic"),
    unit("Pharmacokinetics.md", "what the body does to drugs"),
  ];
  const out = rt.rankByKeywords(units, ["pharmacokinetics"], 4);
  assert.equal(out[0].notePath, "Pharmacokinetics.md", "the note titled for the term comes first");
});

test("rankByKeywords ignores terms too short to be a needle", () => {
  assert.deepEqual(rt.rankByKeywords([unit("a.md", "anything at all")], ["a", ""], 4), []);
});

test("mergeEvidence appends without repeating or exceeding k", () => {
  const a = unit("a.md", "one", "a#1");
  const b = unit("b.md", "two", "b#1");
  const c = unit("c.md", "three", "c#1");
  assert.deepEqual(rt.mergeEvidence([a], [a, b, c], 2).map((u) => u.id), ["a#1", "b#1"]);
});

// A `## ` line inside a fenced block is text the reader wrote, not a heading,
// so it must not close the `## Key claims` section. `proseUnits` already
// tracks fences; the section scan has to agree or a claim below the fence is
// dropped from the index and cannot be cited.
test("indexNote keeps claims below a fenced ## heading inside Key claims", () => {
  const md = [
    "## Key claims",
    "",
    "```md",
    "## Example format",
    "```",
    "",
    "- A claim about clearance. — [[Notes.pdf#page=3|p.3]]",
    "",
    "## Related topics",
    "",
  ].join("\n");
  const units = rt.indexNote("classes/HBIO250/Clearance.md", md);
  assert.deepEqual(
    units.filter((u) => u.kind === "claim").map((u) => u.text),
    ["A claim about clearance."],
  );
});

test("indexNote ignores a fenced ## Key claims above the real one", () => {
  const md = [
    "# Clearance",
    "",
    "## Format",
    "",
    "~~~markdown",
    "## Key claims",
    "",
    "- example — [[X.pdf#page=9|p.9]]",
    "~~~",
    "",
    "## Key claims",
    "",
    "- A claim about clearance. — [[Notes.pdf#page=3|p.3]]",
    "",
  ].join("\n");
  const claims = rt.indexNote("classes/HBIO250/Clearance.md", md).filter((u) => u.kind === "claim");
  assert.deepEqual(
    claims.map((u) => [u.text, u.page]),
    [["A claim about clearance.", 3]],
  );
});

// ---- 2.0: the lexical gate and page context for Ask

test("lexicalIsStrong: two hits whose best covers half the question's words is strong; a thin or missing match is not", () => {
  const unit = (text) => ({ id: text, notePath: "n.md", noteTitle: "N", pdfBasename: null, target: null, page: null, text, kind: "claim", classCodes: [] });
  const strong = [unit("Linear impulse is the area under the force-time curve"), unit("Impulse equals change in momentum")];
  assert.equal(rt.lexicalIsStrong("what is linear impulse", strong), true);
  assert.equal(rt.lexicalIsStrong("what is linear impulse", strong.slice(0, 1)), false, "one hit is not enough to skip widening");
  const thin = [unit("The curve of the road"), unit("Another curve")];
  assert.equal(rt.lexicalIsStrong("how is linear impulse computed from the force curve", thin), false, "the best hit shares one word of four");
  assert.equal(rt.lexicalIsStrong("what is linear impulse", []), false);
  assert.equal(rt.lexicalIsStrong("impulse", [unit("Impulse equals change in momentum")]), true, "a one-word question needs one hit");
});

test("pageContextFor returns the summary and headings of the pages the top evidence came from, in evidence order, capped", () => {
  const units = [...rt.indexNote(KINETICS_PATH, KINETICS_MD), ...rt.indexNote(RECEPTORS_PATH, RECEPTORS_MD)];
  const kinetics = units.find((u) => u.notePath === KINETICS_PATH);
  const receptors = units.find((u) => u.notePath === RECEPTORS_PATH);
  const md = new Map([
    [KINETICS_PATH, KINETICS_MD],
    [RECEPTORS_PATH, RECEPTORS_MD],
  ]);
  const pages = rt.pageContextFor([kinetics, receptors, kinetics], (p) => md.get(p) ?? null, { maxPages: 2, maxChars: 40 });
  assert.equal(pages.length, 2);
  assert.equal(pages[0].title, "Pharmacokinetics");
  assert.equal(pages[1].title, "Receptors");
  assert.ok(pages[0].summary.startsWith("What the body does to the drug"), pages[0].summary);
  assert.ok(pages[0].summary.length <= 41, "capped at a sentence or word boundary near maxChars");
  assert.ok(!pages[0].sections.includes("Highlights") && !pages[0].sections.includes("Related topics") && !pages[0].sections.includes("Flashcard Seeds"), pages[0].sections.join(","));
  assert.deepEqual(rt.pageContextFor([kinetics], () => null), [], "a page that cannot be read contributes nothing");
  const one = rt.pageContextFor([kinetics, receptors], (p) => md.get(p) ?? null, { maxPages: 1 });
  assert.equal(one.length, 1);
});

test("pageContextFor falls back to the first prose paragraph of a page with no Summary section", () => {
  const md = "---\nclass: HBIO408\n---\n## [[Deck.pdf#page=1|Linear Impulse]]\n[[Deck.pdf#page=1&selection=1,0,1,4|The effect of a force]]: over time.\n\n- a bullet\n## Linear Momentum\nMomentum is mass times velocity.\n";
  const unit = { id: "x", notePath: "wiki/concepts/Kinetics.md", noteTitle: "Kinetics", pdfBasename: null, target: null, page: null, text: "t", kind: "claim", classCodes: [] };
  const [page] = rt.pageContextFor([unit], () => md);
  assert.equal(page.title, "Kinetics");
  assert.equal(page.summary, "The effect of a force: over time.");
  assert.deepEqual(page.sections, ["Linear Impulse", "Linear Momentum"]);
});

// ---- 2.0 fix: an inferred class narrows only when the question belongs to it

test("scopeFor: a class the reader named is binding, even when it holds nothing for the question", () => {
  const u = (path, cls, text) => ({ id: `${path}:${text}`, notePath: path, noteTitle: path, pdfBasename: null, target: null, page: null, text, kind: "claim", classCodes: [cls] });
  const all = [
    u("a.md", "PSYC360", "Culture sets the baseline for what counts as normal"),
    u("b.md", "PSYC360", "MRI shows structure while fMRI shows function"),
    u("c.md", "HBIO408", "Linear impulse is the area under the force-time curve"),
    u("d.md", "HBIO408", "Impulse equals the change in momentum"),
  ];
  const named = rt.scopeFor(all, "what is linear impulse", { named: "PSYC360" }, { minNotes: 2 });
  assert.equal(named.scope, "in PSYC360", "a named class is obeyed");
  assert.equal(named.units.length, 2);
});

test("scopeFor: a class inferred from the open note is dropped when the question matches nothing in it", () => {
  const u = (path, cls, text) => ({ id: `${path}:${text}`, notePath: path, noteTitle: path, pdfBasename: null, target: null, page: null, text, kind: "claim", classCodes: [cls] });
  const all = [
    u("a.md", "PSYC360", "Culture sets the baseline for what counts as normal"),
    u("b.md", "PSYC360", "MRI shows structure while fMRI shows function"),
    u("c.md", "HBIO408", "Linear impulse is the area under the force-time curve"),
    u("d.md", "HBIO408", "Impulse equals the change in momentum"),
  ];
  // The reader is looking at a PSYC360 note and asks an HBIO408 question.
  const away = rt.scopeFor(all, "what is linear impulse", { inferred: "PSYC360" }, { minNotes: 2 });
  assert.equal(away.scope, "", "the inferred class is abandoned, so the whole vault answers");
  assert.equal(away.units.length, 4);

  // The same note, a question its own class covers: the scope holds.
  const home = rt.scopeFor(all, "how does culture set what counts as normal", { inferred: "PSYC360" }, { minNotes: 2 });
  assert.equal(home.scope, "in PSYC360");
  assert.equal(home.units.length, 2);

  // No class at all is the whole vault, silently.
  assert.deepEqual(rt.scopeFor(all, "anything", {}, { minNotes: 2 }), { units: all, scope: "" });
});

test("scopeFor: a named class too thin to answer from falls back to the vault and says so", () => {
  const u = (path, cls, text) => ({ id: path, notePath: path, noteTitle: path, pdfBasename: null, target: null, page: null, text, kind: "claim", classCodes: [cls] });
  const all = [u("a.md", "PHED163", "Decisional balance weighs pros against cons"), u("b.md", "HBIO408", "Impulse equals the change in momentum")];
  const thin = rt.scopeFor(all, "what is decisional balance", { named: "PHED163" }, { minNotes: 5 });
  assert.equal(thin.units.length, 2, "the whole vault stands in");
  assert.ok(thin.scope.startsWith("the whole vault (PHED163 has 1 note"), thin.scope);
});

// ---- coverage: does a page already say this?

test("coveredBy: a claim the page restates is covered; one it only touches is not", () => {
  const units = rt.indexNote("wiki/concepts/Linear Kinematics.md", [
    "---",
    "class: HBIO408",
    "---",
    "[[Deck.pdf#page=34&selection=5,0,6,1|Velocity (m/s):]] Change in position in a given change in time (x/t) Speed & Direction (vector)",
    "[[Deck.pdf#page=34&selection=12,0,15,1|Acceleration (m/s2):]] Change in velocity in given change in time (Vx/t)",
    "[[Deck.pdf#page=54&selection=0,0,0,31|First Central Difference Method]]",
    "Numerical method used to approximate derivatives (i.e., slope)",
  ].join("\n"));
  // The same fact in other words, from another deck.
  assert.equal(rt.coveredBy("Velocity is the change in position over a change in time, a vector with speed and direction", units).covered, true);
  // A fact the page names but never states: the heading is there, the explanation is not.
  const cdm = rt.coveredBy("The first central difference method estimates the derivative at frame i from frames i+1 and i-1, halving the noise of consecutive-frame differencing", units);
  assert.equal(cdm.covered, false);
  assert.ok(cdm.score < 0.6, `score ${cdm.score}`);
  // Nothing in common at all.
  assert.equal(rt.coveredBy("Conduct disorder involves little regard for others", units).covered, false);
  // Empty inputs are never covered.
  assert.equal(rt.coveredBy("", units).covered, false);
  assert.equal(rt.coveredBy("Velocity is change in position", []).covered, false);
});

test("coveredBy: a short claim needs all of its words matched; the best unit is reported", () => {
  const units = rt.indexNote("n.md", "---\nclass: X\n---\n- Impulse equals the change in momentum\n- Sarcomeres are the contractile units of muscle\n");
  const hit = rt.coveredBy("Impulse equals change in momentum", units);
  assert.equal(hit.covered, true);
  assert.ok(hit.best && hit.best.text.startsWith("Impulse equals"), hit.best && hit.best.text);
  assert.equal(rt.coveredBy("Impulse equals change in energy", units).covered, false, "one word off a four-word claim is a different claim");
});
