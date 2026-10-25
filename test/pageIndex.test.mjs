// Run with: npm test (bundles the shared page indexer).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let p;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
  for (const name of ["pageIndex"]) {
    await build({ entryPoints: [`src/${name}.ts`], bundle: true, format: "esm", platform: "node", outfile: path.join(dir, `${name}.mjs`), logLevel: "silent" });
  }
  p = await import(pathToFileURL(path.join(dir, "pageIndex.mjs")).href);
});

// The shape Karpathy LLM Wiki writes: frontmatter, an H1, fixed ## sections.
const KARPATHY = `---
type: concept
created: 2026-09-02
tags: [method]
aliases:
  - "Prompt litmus test"
generation_complete: true
---


# Litmus tests for prompts

## Definition
Litmus tests for prompts are two diagnostic heuristics for checking whether a drafted prompt is well formed. They act as fast mental checks a writer can run before finalizing a prompt.

## Key Characteristics
- **False positive test**: Ask how you might produce a correct answer without knowing the intended information.
- **False negative test**: Ask how you might know the intended information but still fail to produce the expected answer.
- Both tests are lightweight thought experiments applied during prompt authoring.

## Related Concepts
- [[concepts/cloze-deletion|Cloze deletion]]
- [[concepts/pleasure-of-learning|Pleasure of learning]]

## Related Entities
- [[entities/piotr-wozniak|Piotr Wozniak]]

## Mentions in Source

- "**False positives:** How might you produce the correct answer without really knowing the information?"
`;

test("a Karpathy page indexes by section with its H1 as the title", () => {
  const units = p.indexPage("wiki/concepts/litmus-tests-for-prompts.md", KARPATHY);
  assert.ok(units.length >= 4);
  assert.ok(units.every((u) => u.noteTitle === "Litmus tests for prompts"));
  assert.ok(units.every((u) => u.kind === "claim" && u.target === null && u.classCodes.length === 0));
  const sections = [...new Set(units.map((u) => u.section))];
  assert.ok(sections.includes("Definition"));
  assert.ok(sections.includes("Key Characteristics"));
});

test("a line that is only a link is not a unit", () => {
  const units = p.indexPage("wiki/concepts/x.md", KARPATHY);
  const sections = new Set(units.map((u) => u.section));
  assert.equal(sections.has("Related Concepts"), false);
  assert.equal(sections.has("Related Entities"), false);
  assert.equal(units.some((u) => u.text === "Cloze deletion"), false);
});

test("a link inside a sentence stays", () => {
  const md = "# T\n\n## Uses\n- [[concepts/cloze-deletion|Cloze deletion]] hides one fact in a sentence the reader completes.\n";
  const units = p.indexPage("wiki/concepts/t.md", md);
  assert.equal(units.length, 1);
  assert.equal(units[0].text, "Cloze deletion hides one fact in a sentence the reader completes.");
});

test("frontmatter is never indexed and the file name is the title when there is no H1", () => {
  const md = "---\ntype: concept\naliases:\n  - \"A long alias that looks like prose\"\n---\n\n## Definition\nA statement long enough to count as a unit.\n";
  const units = p.indexPage("wiki/concepts/no-heading.md", md);
  assert.equal(units.length, 1);
  assert.equal(units[0].noteTitle, "no-heading");
});

test("significantTokens drops stopwords and short words", () => {
  assert.deepEqual(p.significantTokens("The receptors of the cell"), ["receptor", "cell"]);
});

test("a lone # line does not take the next line as the title", () => {
  const units = p.indexPage("wiki/concepts/lone-hash.md", "#\nSome prose line long enough.\n");
  assert.equal(units.length, 1);
  assert.equal(units[0].noteTitle, "lone-hash");
});

// ---- ported from test/retrieval.test.mjs, where indexNote's prose fallback ----
// held these rules before Recall was cut out of WikiLM.

test("indexPage skips the line that says where a hand-written note came from", () => {
  const md = [
    "## Stages of Change",
    "",
    "Source: *The Professional's Guide to Health and Wellness Coaching* (American Council on Exercise), Chapter 3.",
    "",
    "- **Traits:** Unaware or under-aware of the problem, or believe it cannot be solved.",
    "- Explain and personalize the inherent risks",
  ].join("\n");
  const units = p.indexPage("wiki/concepts/Stages of Change.md", md);

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

test("indexPage keeps a sentence that merely mentions a source", () => {
  // The rule is anchored at the start of the line, so a real statement that
  // happens to discuss sources is still evidence.
  const md = [
    "## Media",
    "",
    "- Utilize general sources, including media, Internet, and brochures to increase awareness",
  ].join("\n");
  const units = p.indexPage("wiki/concepts/Media.md", md);
  assert.equal(units.length, 1);
  assert.match(units[0].text, /Utilize general sources/);
});

test("questionScorer counts significant shared words, ignoring stopwords and plurals", () => {
  const score = p.questionScorer("What are the five stages of change and what does the coach do in the contemplation stage?");
  assert.equal(score("Contemplation: the client intends to change within the next six months and weighs pros and cons."), 2);
  assert.equal(score("The coach listens carefully and shares benefits only with permission."), 1);
  assert.equal(score("Receptors bind ligands with high affinity."), null);
  assert.equal(p.questionScorer("the and of")("anything"), null);
});

test("indexPage reads a hand-written note line by line", () => {
  const md = `---\nclass: BIO201\n---\n**Definition**: A theoretical point about which an object's mass is equally distributed\n- Used to model whole body movements using classical mechanics\n`;
  const units = p.indexPage("wiki/concepts/TBCM.md", md);
  assert.equal(units.length, 2);
  assert.equal(units[0].noteTitle, "TBCM");
  assert.equal(units[0].text, "Definition: A theoretical point about which an object's mass is equally distributed");
  assert.equal(units[1].text, "Used to model whole body movements using classical mechanics");
});

test("indexPage carries the callout header's page down to the quoted text", () => {
  const md = [
    "---", "class: BIO101", "---",
    "> [!PDF|yellow] [[Pharm.pdf#page=2&selection=1,0,1,5&color=yellow|Pharm, p.2]]",
    "> > Pharmacokinetics = “What the body does to drugs”",
  ].join("\n");
  const units = p.indexPage("wiki/concepts/Pharmacology.md", md);
  assert.equal(units.length, 1);
  assert.equal(units[0].text, "Pharmacokinetics = “What the body does to drugs”");
  assert.equal(units[0].page, 2);
  assert.equal(units[0].pdfBasename, "Pharm");
});

test("indexPage skips headings, embeds, code fences and short fragments", () => {
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
  const units = p.indexPage("wiki/concepts/Dosing.md", md);
  assert.equal(units.length, 1);
  assert.equal(units[0].text, "The amount of drug required to produce an effect of given intensity.");
});

test("indexPage reduces wikilinks to their display text", () => {
  const md = `---\nclass: X\n---\nThe drug with the lowest [[Pharm.pdf#page=11&selection=7,25,9,1|EC50]] has the highest potency here\n`;
  const units = p.indexPage("wiki/concepts/Potency.md", md);
  assert.equal(units.length, 1);
  assert.equal(units[0].text, "The drug with the lowest EC50 has the highest potency here");
  assert.equal(units[0].page, 11);
});

test("an empty page indexes to nothing", () => {
  assert.equal(p.indexPage("wiki/entities/WADA.md", "---\nclass: BIO101\n---\n").length, 0);
});

test("significantTokens drops filler verbs that used to score like real terms", () => {
  const tokens = p.significantTokens("how do drugs get absorbed");
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
  const score = p.questionScorer("receptor analysis", units);
  // "receptor" is in 1 of 3 units, "analysis" in all 3: the unit carrying the
  // rare word must outscore one carrying only the common word.
  assert.ok(score(units[0].text) > score(units[1].text));
});

test("questionScorer falls back to plain overlap on an empty corpus", () => {
  const score = p.questionScorer("receptor binding", []);
  assert.equal(score("receptor binding affinity"), 2);
  assert.equal(score("nothing relevant here"), null);
});

test("questionScorer returns null when no question word appears", () => {
  const units = [
    { id: "a#p0", notePath: "a.md", noteTitle: "A", pdfBasename: null, target: null, page: null, text: "receptor binding", kind: "claim" },
  ];
  assert.equal(p.questionScorer("quantum entanglement", units)("receptor binding"), null);
});

const COACHING_MD = [
  "---",
  "class: KIN110",
  "---",
  "**Health coaching** is a client-centered partnership in which a coach helps a person change.",
  "",
  "## Motivational interviewing",
  "**Motivational interviewing (MI)** is a client-centered approach to behavior change.",
  "",
  "### Elicit-provide-elicit",
  "Used when a client asks for information. Advice is given infrequently and only with permission.",
  "1. **Elicit**: ask permission, and find out what the client already knows",
  "\t- \"What does 'eating better' look like to you?\"",
  "2. **Provide**: share the most relevant information in small doses",
  "",
  "#### Types of reflection",
  "| Type | What it does | Example |",
  "| --- | --- | --- |",
  "| **Simple** | Repeats or lightly rephrases, adds little meaning | \"You're very busy at work.\" |",
  "| **Amplified** | Slightly exaggerates sustain talk | \"So there's no time at all.\" |",
  "",
  "## Initial session",
  "- Sit at a **45-degree angle** to the client",
].join("\n");

test("indexPage gives each prose line the heading path it sits under", () => {
  const units = p.indexPage("wiki/concepts/Coaching.md", COACHING_MD);
  const at = (re) => units.find((u) => re.test(u.text));
  assert.equal(at(/client-centered partnership/).section, "", "the lead before any heading has no section");
  assert.equal(at(/approach to behavior change/).section, "Motivational interviewing");
  assert.equal(at(/Used when a client asks/).section, "Motivational interviewing › Elicit-provide-elicit");
  assert.equal(at(/share the most relevant/).section, "Motivational interviewing › Elicit-provide-elicit");
  assert.equal(at(/45-degree angle/).section, "Initial session", "a ## heading resets the deeper levels");
});

test("indexPage reads a table's body rows as statements and skips the header and separator", () => {
  const units = p.indexPage("wiki/concepts/Coaching.md", COACHING_MD);
  const rows = units.filter((u) => u.section === "Motivational interviewing › Elicit-provide-elicit › Types of reflection");
  assert.deepEqual(
    rows.map((u) => u.text),
    [
      "Simple: Repeats or lightly rephrases, adds little meaning — \"You're very busy at work.\"",
      "Amplified: Slightly exaggerates sustain talk — \"So there's no time at all.\"",
    ],
  );
  assert.equal(units.some((u) => /What it does/.test(u.text)), false, "the header row is a label");
  assert.equal(units.some((u) => /---/.test(u.text)), false, "the separator is not text");
});
