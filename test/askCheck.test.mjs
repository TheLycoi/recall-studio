// Run with: npm test  (bundles src/askCheck.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let ac;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
  const out = path.join(dir, "askCheck.mjs");
  await build({ entryPoints: ["src/askCheck.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  ac = await import(pathToFileURL(out).href);
});

const EVIDENCE = [
  { n: 1, noteTitle: "Receptors", page: 3, text: "Receptors bind ligands with high affinity" },
  { n: 2, noteTitle: "Plasma Proteins", page: 4, text: "Albumin binds drugs but does not transduce a signal" },
];

const claim = (text, cited) => ({ text, kind: "claim", cited });
const gap = (text) => ({ text, kind: "gap", cited: [] });
const draft = (coverage, quotes, sentences) => ({ coverage, quotes, sentences });

const TWO_CLAIMS = [claim("Receptors bind ligands with high affinity.", [1]), claim("Albumin does not transduce a signal.", [2])];
const ONE_QUOTE = [{ n: 1, quote: "bind ligands with high affinity" }];

test("a fully supported draft keeps both sentences and appends their citations", () => {
  const { answer, report } = ac.checkAnswer(draft("full", ONE_QUOTE, TWO_CLAIMS), EVIDENCE);
  assert.equal(answer, "Receptors bind ligands with high affinity. [1] Albumin does not transduce a signal. [2]");
  assert.equal(report.kept, 2);
  assert.equal(report.removed, 0);
  assert.equal(report.quotesVerified.length, 1);
  assert.equal(report.quotesRejected.length, 0);
  assert.equal(report.verified, true);
});

test("cited is the union of the kept claims' citations, ascending", () => {
  const { report } = ac.checkAnswer(draft("full", ONE_QUOTE, TWO_CLAIMS), EVIDENCE);
  assert.deepEqual(report.cited, [1, 2]);
});

test("a claim that cites nothing is removed and counted", () => {
  const sentences = [TWO_CLAIMS[0], claim("Albumin does not transduce a signal.", [])];
  const { answer, report } = ac.checkAnswer(draft("full", ONE_QUOTE, sentences), EVIDENCE);
  assert.equal(answer, "Receptors bind ligands with high affinity. [1]");
  assert.equal(report.kept, 1);
  assert.equal(report.removed, 1);
  assert.equal(report.verified, false);
});

test("a claim citing evidence that does not exist is removed", () => {
  const sentences = [TWO_CLAIMS[0], claim("Albumin does not transduce a signal.", [9])];
  const { answer, report } = ac.checkAnswer(draft("full", ONE_QUOTE, sentences), EVIDENCE);
  assert.equal(answer, "Receptors bind ligands with high affinity. [1]");
  assert.equal(report.kept, 1);
  assert.equal(report.removed, 1);
  assert.equal(report.verified, false);
});

test("a quote that is not in its evidence is rejected", () => {
  const quotes = [{ n: 2, quote: "transduces a signal strongly" }];
  const { report } = ac.checkAnswer(draft("full", quotes, TWO_CLAIMS), EVIDENCE);
  assert.equal(report.quotesVerified.length, 0);
  assert.deepEqual(report.quotesRejected, quotes);
  assert.equal(report.verified, false);
});

test("a quote is verified through case and punctuation differences", () => {
  const quotes = [{ n: 1, quote: "BIND LIGANDS, with high-affinity" }];
  const { report } = ac.checkAnswer(draft("full", quotes, TWO_CLAIMS), EVIDENCE);
  assert.deepEqual(report.quotesVerified, quotes);
  assert.equal(report.quotesRejected.length, 0);
  assert.equal(report.verified, true);
});

test("a none-coverage answer keeps its gap sentence and drops every claim", () => {
  const sentences = [gap("Your notes do not mention half-life."), claim("Aspirin's half-life is 20 minutes.", [1])];
  const { answer, report } = ac.checkAnswer(draft("none", [], sentences), EVIDENCE);
  assert.equal(answer, "Your notes do not mention half-life.");
  assert.equal(report.kept, 1);
  assert.equal(report.removed, 1);
  assert.equal(report.coverage, "none");
});

test("an [n] marker written inside a sentence is stripped before the citation is appended", () => {
  const sentences = [claim("Receptors bind ligands [1].", [1])];
  const { answer } = ac.checkAnswer(draft("full", [], sentences), EVIDENCE);
  assert.equal(answer, "Receptors bind ligands. [1]");
});

test("consecutive list items each start on their own line", () => {
  const sentences = [claim("- A", [1]), claim("- B", [2])];
  const { answer } = ac.checkAnswer(draft("full", [], sentences), EVIDENCE);
  assert.equal(answer, "- A [1]\n- B [2]");
});

test("a draft whose every sentence is removed falls back and forces coverage none", () => {
  const sentences = [claim("Receptors bind ligands with high affinity.", []), claim("Albumin does not transduce a signal.", [])];
  const { answer, report } = ac.checkAnswer(draft("full", [], sentences), EVIDENCE);
  assert.equal(answer, "Your notes don't say. None of the sentences the model drafted was supported by the evidence.");
  assert.equal(report.coverage, "none");
  assert.equal(report.removed, 2);
  assert.equal(report.verified, false);
});

test("the fallback answer reports nothing kept", () => {
  const sentences = [claim("Receptors bind ligands with high affinity.", [])];
  const { report } = ac.checkAnswer(draft("full", [], sentences), EVIDENCE);
  assert.equal(report.kept, 0);
});

test("applyVerdicts clears the citations of a sentence judged unsupported", () => {
  const d = draft("full", ONE_QUOTE, TWO_CLAIMS);
  const next = ac.applyVerdicts(d, { verdicts: [{ i: 1, supported: false, reason: "not stated" }] });
  assert.deepEqual(next.sentences[1].cited, []);
  assert.deepEqual(next.sentences[0].cited, [1]);
  assert.deepEqual(d.sentences[1].cited, [2], "the original draft is not mutated");
});

test("applyVerdicts ignores a verdict index outside the draft", () => {
  const d = draft("full", ONE_QUOTE, TWO_CLAIMS);
  const next = ac.applyVerdicts(d, { verdicts: [{ i: 7, supported: false, reason: "nowhere" }] });
  assert.deepEqual(next.sentences.map((s) => s.cited), [[1], [2]]);
});

test("applyVerdicts leaves a gap sentence alone", () => {
  const d = draft("partial", [], [gap("Your notes do not mention half-life.")]);
  const next = ac.applyVerdicts(d, { verdicts: [{ i: 0, supported: false, reason: "no citation" }] });
  assert.equal(next.sentences[0].kind, "gap");
  assert.deepEqual(next.sentences[0].cited, []);
});

test("noEvidenceAnswer names the question and the fix", () => {
  const { answer, report } = ac.noEvidenceAnswer("half-life");
  assert.match(answer, /half-life/);
  assert.match(answer, /Digest the lecture/);
  assert.equal(report.coverage, "none");
  assert.equal(report.kept, 1);
  assert.equal(report.removed, 0);
  assert.deepEqual(report.cited, []);
  assert.equal(report.quotesVerified.length, 0);
  assert.equal(report.verified, true);
});

test("renderGroundingLine omits the zero parts", () => {
  const line = ac.renderGroundingLine({
    coverage: "full",
    kept: 2,
    removed: 0,
    quotesVerified: [{ n: 1, quote: "x" }],
    quotesRejected: [],
    cited: [1],
    verified: true,
  });
  assert.equal(line, "Grounding: full coverage · 2 sentences kept · 1 quote verified");
});

test("renderGroundingLine reports removals and rejections when there are any", () => {
  const line = ac.renderGroundingLine({
    coverage: "partial",
    kept: 3,
    removed: 1,
    quotesVerified: [{ n: 1, quote: "x" }, { n: 2, quote: "y" }],
    quotesRejected: [{ n: 2, quote: "z" }],
    cited: [1, 2],
    verified: false,
  });
  assert.equal(line, "Grounding: partial coverage · 3 sentences kept · 1 unsupported removed · 2 quotes verified · 1 quote rejected");
});

test("renderGroundingLine uses the singular for one sentence and says no coverage", () => {
  const line = ac.renderGroundingLine({
    coverage: "none",
    kept: 1,
    removed: 0,
    quotesVerified: [],
    quotesRejected: [],
    cited: [],
    verified: true,
  });
  assert.equal(line, "Grounding: no coverage · 1 sentence kept");
});

test("a plain sentence after list items starts a new paragraph", () => {
  const evidence = [{ n: 1, noteTitle: "T", page: 1, text: "alpha beta" }, { n: 2, noteTitle: "T", page: 1, text: "gamma delta" }];
  const draft = { coverage: "full", quotes: [], sentences: [
    { text: "The stages are:", kind: "claim", cited: [1] },
    { text: "- Alpha", kind: "claim", cited: [1] },
    { text: "- Gamma", kind: "claim", cited: [2] },
    { text: "Alpha comes first.", kind: "claim", cited: [1] },
  ] };
  const { answer } = ac.checkAnswer(draft, evidence);
  assert.equal(answer, "The stages are: [1]\n- Alpha [1]\n- Gamma [2]\n\nAlpha comes first. [1]");
});

test("a gap sentence must state a gap; otherwise it is an uncited claim and removed", () => {
  const evidence = [{ n: 1, noteTitle: "T", page: 1, text: "Pharmacokinetics is what the body does to drugs." }];
  const draft = { coverage: "partial", quotes: [], sentences: [
    { text: "Your notes do not mention half-life.", kind: "gap", cited: [] },
    { text: "Aspirin's half-life is 20 minutes.", kind: "gap", cited: [] },
    { text: "Pharmacokinetics is what the body does to drugs.", kind: "claim", cited: [1] },
  ] };
  const { answer, report } = ac.checkAnswer(draft, evidence);
  assert.equal(report.kept, 2);
  assert.equal(report.removed, 1);
  assert.doesNotMatch(answer, /20 minutes/);
  assert.equal(report.verifyRan, false);
  assert.match(ac.renderGroundingLine({ ...report, verifyRan: true }), / · verify pass$/);
});
