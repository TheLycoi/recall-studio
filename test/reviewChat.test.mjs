// Run with: npm test  (bundles src/reviewChat.ts first, then exercises it)
//
// The selected-source chat contract: evidence is built only from explicitly
// selected sources, every quote is checked character for character against the
// evidence it claims, a claim the cited evidence does not support is removed,
// and an answer with nothing verified behind it is refused rather than
// answered from general knowledge.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let rc;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-chat-test-"));
  const out = path.join(dir, "reviewChat.mjs");
  await build({ entryPoints: ["src/reviewChat.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  rc = await import(pathToFileURL(out).href);
});

const seed = (over = {}) => ({
  path: "notes/a.md",
  title: "A",
  page: null,
  line: 1,
  text: "Receptors bind ligands with high affinity. Albumin binds drugs but does not transduce a signal.",
  kind: "note",
  ...over,
});

const ev = (n, over = {}) => ({ n, title: "A", page: null, path: "notes/a.md", line: 1, text: "", ...over });
const claim = (text, cited) => ({ text, kind: "claim", cited });
const gap = (text) => ({ text, kind: "gap", cited: [] });
const draft = (coverage, quotes, sentences) => ({ coverage, quotes, sentences });

const EVIDENCE = [
  ev(1, { text: "Receptors bind ligands with high affinity." }),
  ev(2, { text: "Albumin binds drugs but does not transduce a signal.", line: 2 }),
];
const ONE_QUOTE = [{ n: 1, quote: "Receptors bind ligands with high affinity." }];

// --- buildChatEvidence -------------------------------------------------------

test("evidence is built only from the seeds it is given", () => {
  const { evidence } = rc.buildChatEvidence([seed()]);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].n, 1);
  assert.equal(evidence[0].path, "notes/a.md");
  assert.equal(evidence[0].title, "A");
});

test("an empty selection yields no evidence", () => {
  const { evidence, truncated, omitted } = rc.buildChatEvidence([]);
  assert.deepEqual(evidence, []);
  assert.equal(truncated, false);
  assert.equal(omitted, 0);
});

test("a source with only whitespace is skipped", () => {
  const { evidence } = rc.buildChatEvidence([seed({ text: "   \n\n  " })]);
  assert.deepEqual(evidence, []);
});

test("a passage longer than the per-passage cap is cut and marked truncated", () => {
  const long = "word ".repeat(400).trim();
  const { evidence, truncated } = rc.buildChatEvidence([seed({ text: long })], { maxCharsPerPassage: 100 });
  assert.equal(truncated, true);
  assert.ok(evidence[0].text.length <= 100);
});

test("total context is bounded and the overflow is counted as omitted", () => {
  const seeds = Array.from({ length: 30 }, (_, i) => seed({ path: `notes/n${i}.md`, title: `N${i}`, text: `Fact number ${i} about receptors and ligands.` }));
  const { evidence, truncated, omitted } = rc.buildChatEvidence(seeds, { maxPassages: 5 });
  assert.equal(evidence.length, 5);
  assert.equal(truncated, true);
  assert.ok(omitted >= 25);
});

// --- checkChatAnswer: quotes -------------------------------------------------

test("a fully supported draft keeps its claims and appends their citations", () => {
  const sentences = EVIDENCE.map(e => claim(e.text, [e.n]));
  const quotes = EVIDENCE.map(e => ({n:e.n, quote:e.text}));
  const { answer, report } = rc.checkChatAnswer(draft("full", quotes, sentences), EVIDENCE);
  assert.equal(answer, "Receptors bind ligands with high affinity. [1] Albumin binds drugs but does not transduce a signal. [2]");
  assert.equal(report.kept, 2);
  assert.equal(report.removed, 0);
  assert.equal(report.quotesVerified, 2);
  assert.equal(report.quotesRejected, 0);
  assert.equal(report.refused, false);
});

test("a quote that is not in its evidence is rejected", () => {
  const quotes = [{ n: 2, quote: "receptors are enzymes" }];
  const { report } = rc.checkChatAnswer(draft("full", quotes, [claim("Albumin does not transduce a signal.", [2])]), EVIDENCE);
  assert.equal(report.quotesVerified, 0);
  assert.equal(report.quotesRejected, 1);
});

test("a nonverbatim quote is rejected even with similar words", () => {
  const quotes = [{ n: 1, quote: "RECEPTORS, bind ligands — with high-affinity" }];
  const { report } = rc.checkChatAnswer(draft("full", quotes, [claim("Receptors bind ligands with high affinity.", [1])]), EVIDENCE);
  assert.equal(report.quotesVerified, 0);
  assert.equal(report.quotesRejected, 1);
  assert.equal(report.refused, true);
});

// --- checkChatAnswer: citations and support ---------------------------------

test("a claim that cites nothing is removed and counted", () => {
  const sentences = [claim("Receptors bind ligands with high affinity.", [1]), claim("Albumin does not transduce a signal.", [])];
  const { answer, report } = rc.checkChatAnswer(draft("full", ONE_QUOTE, sentences), EVIDENCE);
  assert.equal(answer, "Receptors bind ligands with high affinity. [1]");
  assert.equal(report.kept, 1);
  assert.equal(report.removed, 1);
});

test("a claim citing an evidence number that does not exist is removed", () => {
  const sentences = [claim("Receptors bind ligands with high affinity.", [1]), claim("Albumin does not transduce a signal.", [9])];
  const { report } = rc.checkChatAnswer(draft("full", ONE_QUOTE, sentences), EVIDENCE);
  assert.equal(report.kept, 1);
  assert.equal(report.removed, 1);
});

test("a claim the cited evidence does not support is removed, even with a valid number", () => {
  // The number exists and is selected, but states something else: an invented
  // claim dressed in a real citation must not survive.
  const sentences = [claim("Receptors are membrane enzymes that turn ATP into cAMP.", [1])];
  const { answer, report } = rc.checkChatAnswer(draft("full", ONE_QUOTE, sentences), EVIDENCE);
  assert.equal(report.kept, 0);
  assert.equal(report.removed, 1);
  assert.equal(report.refused, true);
  assert.equal(answer, rc.CHAT_REFUSAL);
});

test("content from an excluded source, cited against a selected one, is removed", () => {
  // The excluded sentence is nowhere in the selected evidence, so no citation
  // can make it stand.
  const excluded = "Beta blockers reduce heart rate by blocking adrenergic receptors.";
  const sentences = [claim(excluded, [1]), claim("Receptors bind ligands with high affinity.", [1])];
  const { answer, report } = rc.checkChatAnswer(draft("partial", ONE_QUOTE, sentences), EVIDENCE);
  assert.equal(report.kept, 1);
  assert.equal(report.removed, 1);
  assert.equal(answer, "Receptors bind ligands with high affinity. [1]");
});

// --- checkChatAnswer: refusal ------------------------------------------------

test("coverage none refuses and keeps none of the model's prose", () => {
  const sentences = [gap("Your notes do not cover half-life."), claim("Aspirin's half-life is 20 minutes.", [1])];
  const { answer, report } = rc.checkChatAnswer(draft("none", [], sentences), EVIDENCE);
  assert.equal(answer, rc.CHAT_REFUSAL);
  assert.equal(report.refused, true);
  assert.equal(report.coverage, "none");
  assert.deepEqual(report.cited, []);
  assert.ok(!answer.includes("Aspirin"));
});

test("an answer with claims but no verified support is refused", () => {
  const sentences = [claim("Something entirely unsupported here.", [1])];
  const { answer, report } = rc.checkChatAnswer(draft("full", [], sentences), EVIDENCE);
  assert.equal(report.refused, true);
  assert.equal(answer, rc.CHAT_REFUSAL);
});

test("an empty evidence list refuses without inventing an answer", () => {
  const { answer, report } = rc.checkChatAnswer(draft("full", [], [claim("Anything.", [1])]), []);
  assert.equal(report.refused, true);
  assert.equal(answer, rc.CHAT_REFUSAL);
});

// --- citation target validation ---------------------------------------------

test("a citation target resolves to the path of the selected source", () => {
  assert.equal(rc.resolveCitationPath(1, EVIDENCE, ["notes/a.md"]), "notes/a.md");
});

test("a citation target whose path is not in the selection resolves to null", () => {
  const foreign = [ev(1, { path: "secret/other.md" })];
  assert.equal(rc.resolveCitationPath(1, foreign, ["notes/a.md"]), null);
  assert.equal(rc.validateSelectedPath("../secret/other.md", ["notes/a.md"]), false);
});

test("an answer sentence that names a foreign path is not turned into a citation", () => {
  const sentences = [claim("See secret/other.md for the rest.", [1])];
  const { report } = rc.checkChatAnswer(draft("full", ONE_QUOTE, sentences), EVIDENCE);
  // The sentence's words are not in evidence 1, so it is removed; and the
  // report only ever carries selected evidence numbers.
  assert.equal(report.kept, 0);
  for (const n of report.cited) assert.ok(n >= 1 && n <= EVIDENCE.length);
});

// --- provenance: answer to inbox --------------------------------------------

const ROW_ARGS = {
  question: "What do receptors do?",
  answer: "Receptors bind ligands with high affinity. [1]",
  why: "defines the term",
  unit: ev(1, { text: "Receptors bind ligands with high affinity." }),
  selectedPaths: ["notes/a.md"],
};

test("an answer becomes a row carrying the original passage, not the answer text", () => {
  const row = rc.buildChatRow(ROW_ARGS);
  assert.equal(row.text, "Receptors bind ligands with high affinity.");
  assert.notEqual(row.text, ROW_ARGS.answer);
  assert.equal(row.sourcePath, "notes/a.md");
  assert.equal(row.sourceTitle, "A");
  assert.equal(row.origin, "ask");
  assert.equal(typeof row.line, "number");
});

test("the row instruction carries the question and the answer", () => {
  const row = rc.buildChatRow(ROW_ARGS);
  assert.ok(row.instruction.includes("What do receptors do?"));
  assert.ok(row.instruction.includes("Receptors bind ligands with high affinity."));
  assert.ok(row.title.length > 0);
});

test("a row whose source is not in the selection is refused", () => {
  const row = rc.buildChatRow({ ...ROW_ARGS, selectedPaths: ["notes/b.md"] });
  assert.ok(row.reason);
});

test("the row key is stable for the same passage and differs by source", () => {
  const a = rc.buildChatRow(ROW_ARGS);
  const b = rc.buildChatRow(ROW_ARGS);
  assert.equal(rc.chatRowKey(a), rc.chatRowKey(b));
  const other = rc.buildChatRow({ ...ROW_ARGS, unit: ev(1, { path: "notes/b.md", title: "B" }) });
  assert.notEqual(rc.chatRowKey(a), rc.chatRowKey(other));
});

// --- stale-answer guard ------------------------------------------------------

test("selectionChanged reports a changed source set and ignores order", () => {
  assert.equal(rc.selectionChanged(["a.md", "b.md"], ["b.md", "a.md"]), false);
  assert.equal(rc.selectionChanged(["a.md"], ["a.md", "c.md"]), true);
  assert.equal(rc.selectionChanged(["a.md", "b.md"], ["a.md"]), true);
});

// --- prompt hygiene ----------------------------------------------------------

test("the evidence message never offers the model a tool or a whole-vault read", () => {
  const msg = rc.buildChatAnswerMessage({ question: "Q?", evidence: EVIDENCE, history: [], standingInstructions: "" });
  assert.ok(msg.includes("[1]"));
  assert.equal(/tool|function_call|read the vault|entire vault/i.test(msg), false);
});
