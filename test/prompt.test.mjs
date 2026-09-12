// Run with: npm test  (bundles src/prompt.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { z } from "zod";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let p;
// The digest and Ask schemas live in src/schemas.ts (zod only, no backends and
// so no `obsidian`), which is why they can be bundled here the same way.
let schemas;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
  const out = path.join(dir, "prompt.mjs");
  await build({ entryPoints: ["src/prompt.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  p = await import(pathToFileURL(out).href);
  const schemaOut = path.join(dir, "schemas.mjs");
  await build({ entryPoints: ["src/schemas.ts"], bundle: true, format: "esm", platform: "node", outfile: schemaOut, logLevel: "silent" });
  schemas = await import(pathToFileURL(schemaOut).href);
});

const base = {
  noteTitle: "Lecture 3",
  body: "Insulin lowers blood glucose.",
  transcript: null,
  maxSpans: 12,
  standingInstructions: "",
  instruction: "",
};

const TRANSCRIPT_LIMIT =
  "The transcript is a recording of the lecture that accompanies this note. Select at most 12 spans, and fewer when the transcript supports fewer.";

test("without a transcript the message has no transcript block and the plain limit", () => {
  const msg = p.buildHighlighterMessage({ ...base });
  assert.ok(!msg.includes("<transcript>"), "should not contain a transcript block");
  assert.ok(msg.includes("Select at most 12 spans."), "should carry the plain limit line");
  assert.ok(!msg.includes(TRANSCRIPT_LIMIT), "should not carry the transcript limit line");
});

test("with a transcript the note comes first, then the transcript, then the limit", () => {
  const msg = p.buildHighlighterMessage({ ...base, transcript: "The lecturer said insulin matters." });
  const note = msg.indexOf("<note");
  const transcript = msg.indexOf("<transcript>");
  const limit = msg.indexOf("Select at most");
  assert.ok(note !== -1 && transcript !== -1 && limit !== -1, "all three blocks are present");
  assert.ok(note < transcript, "note precedes transcript");
  assert.ok(transcript < limit, "transcript precedes the limit line");
  assert.ok(msg.includes(TRANSCRIPT_LIMIT), "should carry the transcript limit line");
  assert.ok(msg.includes("The lecturer said insulin matters."), "transcript text is included");
});

test("instruction lines follow the limit, standing before per-note, and vanish when blank", () => {
  const msg = p.buildHighlighterMessage({
    ...base,
    standingInstructions: "prefer definitions",
    instruction: "only section 2",
  });
  const limit = msg.indexOf("Select at most");
  const standing = msg.indexOf("Standing instructions: prefer definitions");
  const perNote = msg.indexOf("Instructions for this note: only section 2");
  assert.ok(standing > limit, "standing instructions follow the limit line");
  assert.ok(perNote > standing, "per-note instructions follow the standing instructions");

  const bare = p.buildHighlighterMessage({ ...base, standingInstructions: "  ", instruction: "" });
  assert.ok(!bare.includes("Standing instructions:"), "blank standing instructions are omitted");
  assert.ok(!bare.includes("Instructions for this note:"), "blank per-note instructions are omitted");
});

test("a whitespace-only transcript counts as absent", () => {
  const msg = p.buildHighlighterMessage({ ...base, transcript: "   \n" });
  assert.ok(!msg.includes("<transcript>"), "whitespace-only transcript adds no block");
  assert.ok(msg.includes("Select at most 12 spans."), "falls back to the plain limit line");
});

test("blocks are separated by a blank line", () => {
  const msg = p.buildHighlighterMessage({ ...base, transcript: "spoken words" });
  assert.ok(msg.includes("</note>\n\n<transcript>"), "note and transcript are joined by a blank line");
  assert.ok(msg.includes("</transcript>\n\nThe transcript is a recording"), "transcript and limit are joined by a blank line");
});

// --- digest message ---------------------------------------------------------

const digestBase = {
  pdfTitle: "HBIO 250 - Pharmacology",
  classCode: "HBIO250",
  paperText: "[page 1]\nPharmacology, Pharmacodynamics and Pharmacokinetics",
  highlights: [
    { id: "H01", page: 2, text: "Pharmacology is the study of the action of drugs." },
    { id: "H02", page: 4, text: "Receptors bind ligands with high affinity." },
  ],
  existingTitles: ["Pharmacology"],
  maxNotes: 6,
  standingInstructions: "",
  instruction: "",
};

test("digest blocks run paper, highlights, existing notes, then the limit", () => {
  const msg = p.buildDigestMessage({ ...digestBase });
  const paper = msg.indexOf("<paper");
  const highlights = msg.indexOf("<highlights>");
  const existing = msg.indexOf("<existing_notes>");
  const limit = msg.indexOf("Write at most 6 topic notes.");
  assert.ok(paper !== -1 && highlights !== -1 && existing !== -1 && limit !== -1, "all four blocks are present");
  assert.ok(paper < highlights, "paper precedes highlights");
  assert.ok(highlights < existing, "highlights precede existing notes");
  assert.ok(existing < limit, "existing notes precede the limit line");
  assert.ok(msg.includes('<paper title="HBIO 250 - Pharmacology" class="HBIO250">'), "paper block carries title and class");
});

test("an empty paper drops the paper block and keeps the rest", () => {
  const msg = p.buildDigestMessage({ ...digestBase, paperText: "   \n" });
  assert.ok(!msg.includes("<paper"), "whitespace-only paper text adds no block");
  assert.ok(msg.startsWith("<highlights>"), "the highlights block leads instead");
  assert.ok(msg.includes("Write at most 6 topic notes."), "the limit line survives");
});

test("every highlight carries its id and page, text-less ones included", () => {
  const msg = p.buildDigestMessage({
    ...digestBase,
    highlights: [...digestBase.highlights, { id: "H03", page: 9, text: "" }],
  });
  assert.ok(msg.includes('<highlight id="H01" page="2">Pharmacology is the study of the action of drugs.</highlight>'));
  assert.ok(msg.includes('<highlight id="H02" page="4">Receptors bind ligands with high affinity.</highlight>'));
  assert.ok(msg.includes('<highlight id="H03" page="9"></highlight>'), "a text-less highlight is still listed");
});

test("existing notes are one title per line and the block vanishes when empty", () => {
  const msg = p.buildDigestMessage({ ...digestBase, existingTitles: ["Pharmacology", "Receptors"] });
  assert.ok(msg.includes("<existing_notes>\nPharmacology\nReceptors\n</existing_notes>"), "one title per line");

  const bare = p.buildDigestMessage({ ...digestBase, existingTitles: [] });
  assert.ok(!bare.includes("<existing_notes>"), "no existing titles adds no block");
});

test("digest instruction lines follow the limit, standing before per-PDF, and vanish when blank", () => {
  const msg = p.buildDigestMessage({
    ...digestBase,
    standingInstructions: "keep summaries tight",
    instruction: "ignore the review slides",
  });
  const limit = msg.indexOf("Write at most 6 topic notes.");
  const standing = msg.indexOf("Standing instructions: keep summaries tight");
  const perPdf = msg.indexOf("Instructions for this PDF: ignore the review slides");
  assert.ok(standing > limit, "standing instructions follow the limit line");
  assert.ok(perPdf > standing, "per-PDF instructions follow the standing instructions");

  const bare = p.buildDigestMessage({ ...digestBase, standingInstructions: "  ", instruction: "" });
  assert.ok(!bare.includes("Standing instructions:"), "blank standing instructions are omitted");
  assert.ok(!bare.includes("Instructions for this PDF:"), "blank per-PDF instructions are omitted");
});

// --- ask message ------------------------------------------------------------

const askBase = {
  question: "What distinguishes a receptor from albumin?",
  evidence: [
    { n: 1, noteTitle: "Pharmacology", page: 2, text: "Pharmacology is the study of the action of drugs." },
    { n: 2, noteTitle: "Receptors", page: 4, text: "Receptors transduce a signal to produce a biological effect." },
  ],
  history: [],
  standingInstructions: "",
};

test("ask puts the evidence first and the question last of the input blocks", () => {
  const msg = p.buildAskMessage({ ...askBase });
  const evidence = msg.indexOf("<evidence>");
  const question = msg.indexOf("Question: ");
  assert.ok(evidence !== -1 && question !== -1, "both blocks are present");
  assert.ok(evidence < question, "evidence precedes the question");
  // The question is the last of the inputs; only the task line follows it.
  const blocks = msg.split("\n\n");
  assert.equal(blocks.at(-2), "Question: What distinguishes a receptor from albumin?", "the question is the last input block");
});

test("an evidence line reads [n] (Note title, p.N) text", () => {
  const msg = p.buildAskMessage({ ...askBase });
  assert.ok(
    msg.includes("[2] (Receptors, p.4) Receptors transduce a signal to produce a biological effect."),
    "numbered, with the note title and page in parentheses",
  );
});

test("a null page drops the page from the evidence line", () => {
  const msg = p.buildAskMessage({
    ...askBase,
    evidence: [{ n: 1, noteTitle: "Stages of Change", page: null, text: "Decisional balance weighs pros against cons." }],
  });
  assert.ok(msg.includes("[1] (Stages of Change) Decisional balance weighs pros against cons."), "no page, no comma");
  assert.ok(!msg.includes("p."), "no page marker is written");
});

test("history sits between the evidence and the question and vanishes when empty", () => {
  const msg = p.buildAskMessage({
    ...askBase,
    history: [
      { role: "user", text: "What is a receptor?" },
      { role: "assistant", text: "Something that binds a ligand [1]." },
    ],
  });
  const evidence = msg.indexOf("<evidence>");
  const history = msg.indexOf("<history>");
  const question = msg.indexOf("Question: ");
  assert.ok(evidence < history, "evidence precedes history");
  assert.ok(history < question, "history precedes the question");
  assert.ok(msg.includes("User: What is a receptor?"), "user turns are labelled");
  assert.ok(msg.includes("Assistant: Something that binds a ligand [1]."), "assistant turns are labelled");

  const bare = p.buildAskMessage({ ...askBase });
  assert.ok(!bare.includes("<history>"), "an empty history adds no block");
});

test("ask puts standing instructions after the transcript blocks and before the question", () => {
  const withHistory = p.buildAskMessage({
    ...askBase,
    history: [{ role: "user", text: "What is a receptor?" }],
    standingInstructions: "Answer in Dutch.",
  });
  const history = withHistory.indexOf("<history>");
  const standing = withHistory.indexOf("Standing instructions: Answer in Dutch.");
  const question = withHistory.indexOf("Question: ");
  assert.ok(standing !== -1, "the standing block is present");
  assert.ok(history < standing, "standing instructions follow the history");
  assert.ok(standing < question, "standing instructions precede the question");

  const noHistory = p.buildAskMessage({ ...askBase, standingInstructions: "Answer in Dutch." });
  assert.ok(!noHistory.includes("<history>"), "no history block when there are no turns");
  assert.ok(
    noHistory.indexOf("<evidence>") < noHistory.indexOf("Standing instructions:"),
    "without a history the standing block follows the evidence",
  );
  assert.ok(
    noHistory.indexOf("Standing instructions:") < noHistory.indexOf("Question: "),
    "and still precedes the question",
  );

  const blank = p.buildAskMessage({ ...askBase, standingInstructions: "   " });
  assert.ok(!blank.includes("Standing instructions:"), "blank standing instructions are omitted");
});

const ASK_INSTRUCTION =
  "Extract the passages you will rely on first, then write the answer one sentence at a time, each claim with the numbers of the evidence that states it.";

test("the ask message ends with the extract-then-write instruction, after the question", () => {
  const msg = p.buildAskMessage({ ...askBase });
  assert.ok(msg.endsWith(ASK_INSTRUCTION), "the instruction is the last thing the model reads");
  assert.ok(msg.indexOf("Question: ") < msg.indexOf(ASK_INSTRUCTION), "and it follows the question");

  const withAll = p.buildAskMessage({
    ...askBase,
    history: [{ role: "user", text: "What is a receptor?" }],
    standingInstructions: "Answer in Dutch.",
  });
  assert.ok(withAll.endsWith(ASK_INSTRUCTION), "still last when every optional block is present");
});

test("the verify message puts the evidence before the draft and prints each sentence with its citations", () => {
  const msg = p.buildVerifyMessage({
    evidence: askBase.evidence,
    sentences: [
      { i: 0, text: "A", cited: [1] },
      { i: 1, text: "B", cited: [1, 2] },
      { i: 2, text: "C", cited: [] },
    ],
  });
  const evidence = msg.indexOf("<evidence>");
  const draft = msg.indexOf("<draft>");
  const judge = msg.indexOf("Judge each sentence:");
  assert.ok(evidence !== -1 && draft !== -1 && judge !== -1, "all three blocks are present");
  assert.ok(evidence < draft, "evidence precedes the draft");
  assert.ok(draft < judge, "the draft precedes the judging line");

  assert.ok(msg.includes("0. A [1]"), "one citation prints as [1]");
  assert.ok(msg.includes("1. B [1][2]"), "two citations print joined, without a separator");
  assert.ok(msg.includes("2. C []"), "a sentence that cited nothing prints an empty bracket");
  assert.ok(
    msg.includes("[2] (Receptors, p.4) Receptors transduce a signal to produce a biological effect."),
    "the evidence lines are the same ones buildAskMessage writes",
  );
  assert.ok(msg.endsWith("Judge each sentence: supported only if the cited evidence states it."), "the task reads last");
});

// --- schemas ----------------------------------------------------------------

test("DigestOut accepts a well-formed draft and rejects a note without highlight_ids", () => {
  const ok = schemas.DigestOut.safeParse({
    notes: [{ title: "T", summary: "S", highlight_ids: ["H01"], related: [] }],
    unused_ids: [],
  });
  assert.equal(ok.success, true, "a complete note parses");

  const missing = schemas.DigestOut.safeParse({ notes: [{ title: "T", summary: "S", related: [] }], unused_ids: [] });
  assert.equal(missing.success, false, "highlight_ids is required, not optional");

  const noUnused = schemas.DigestOut.safeParse({ notes: [] });
  assert.equal(noUnused.success, false, "unused_ids is required too");
});

test("AskOut accepts a structured draft and rejects a bad coverage or a sentence without a kind", () => {
  const draft = { coverage: "full", quotes: [{ n: 1, quote: "x" }], sentences: [{ text: "A", kind: "claim", cited: [1] }] };
  const ok = schemas.AskOut.safeParse(draft);
  assert.equal(ok.success, true, "a full draft parses");
  assert.deepEqual(ok.data, draft, "and comes back unchanged");

  assert.equal(
    schemas.AskOut.safeParse({ ...draft, coverage: "maybe" }).success,
    false,
    "coverage is one of full, partial, none",
  );
  assert.equal(
    schemas.AskOut.safeParse({ ...draft, sentences: [{ text: "A", cited: [1] }] }).success,
    false,
    "kind is required on every sentence, not optional",
  );
  assert.equal(
    schemas.AskOut.safeParse({ coverage: "none", quotes: [], sentences: [] }).success,
    true,
    "a none answer with nothing in it is still well-formed",
  );
  assert.equal(schemas.AskOut.safeParse({ coverage: "full", quotes: [] }).success, false, "sentences is required");
});

test("VerifyOut accepts a verdict per sentence and requires all three fields", () => {
  const ok = schemas.VerifyOut.safeParse({ verdicts: [{ i: 0, supported: true, reason: "r" }] });
  assert.equal(ok.success, true, "one verdict parses");
  assert.deepEqual(ok.data, { verdicts: [{ i: 0, supported: true, reason: "r" }] });

  assert.equal(schemas.VerifyOut.safeParse({ verdicts: [{ i: 0, supported: true }] }).success, false, "reason is required");
  assert.equal(
    schemas.VerifyOut.safeParse({ verdicts: [{ i: 0, supported: "yes", reason: "r" }] }).success,
    false,
    "supported is a boolean, not a string",
  );
  assert.equal(schemas.VerifyOut.safeParse({}).success, false, "verdicts is required");
});

/**
 * Both schemas go to the provider through `z.toJSONSchema` (src/codex.ts:150)
 * and `zodOutputFormat` (src/anthropic.ts:79), which run strict: every
 * property listed in `required` and no extra properties, at every level. A
 * `.optional()` or a `.default()` slipped into schemas.ts would show up here
 * as a property missing from `required`.
 */
function assertStrict(node, path, seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (node.type === "object") {
    const props = Object.keys(node.properties ?? {});
    assert.deepEqual(
      [...(node.required ?? [])].sort(),
      [...props].sort(),
      `${path}: every property must be required (got ${JSON.stringify(node.required)} for ${JSON.stringify(props)})`,
    );
    assert.equal(node.additionalProperties, false, `${path}: additionalProperties must be false`);
    for (const [k, v] of Object.entries(node.properties ?? {})) assertStrict(v, `${path}.${k}`, seen);
  }
  if (node.type === "array") assertStrict(node.items, `${path}[]`, seen);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    assert.equal(node[key], undefined, `${path}: ${key} is a union, which the strict serializer rejects`);
  }
}

test("AskOut and VerifyOut serialize strictly at every level", () => {
  const ask = z.toJSONSchema(schemas.AskOut);
  assertStrict(ask, "AskOut");
  assert.deepEqual(ask.properties.coverage.enum, ["full", "partial", "none"], "z.enum serializes as a string enum");
  assert.equal(ask.properties.sentences.items.properties.kind.type, "string", "the sentence kind enum is a string");
  assert.deepEqual(ask.properties.sentences.items.properties.kind.enum, ["claim", "gap"]);

  const verify = z.toJSONSchema(schemas.VerifyOut);
  assertStrict(verify, "VerifyOut");
  assert.equal(
    verify.properties.verdicts.items.properties.supported.type,
    "boolean",
    "z.boolean is a plain JSON Schema type, not a union",
  );
});

/* ---------------------------------------------------------------- quiz mode */

const quizEvidence = [
  { n: 1, noteTitle: "Receptors", page: 4, text: "Receptors bind ligands with high affinity and transduce a signal." },
  { n: 2, noteTitle: "Drug Disposition", page: null, text: "Metabolism converts drugs into more water-soluble forms." },
];

const quizBase = {
  evidence: quizEvidence,
  difficulty: 2,
  askedQuestions: [],
  retryOfN: null,
  retryAngle: "",
  standingInstructions: "",
  failure: "",
};

test("the quiz question message puts the evidence first and the task last, omitting the optional blocks", () => {
  const msg = p.buildQuizQuestionMessage({ ...quizBase });
  assert.ok(msg.startsWith("<evidence>"), "the evidence is the first block");
  assert.ok(msg.includes("[1] (Receptors, p.4) Receptors bind ligands"), "evidence lines carry the note title and page");
  assert.ok(msg.includes("[2] (Drug Disposition) Metabolism"), "a claim with no page prints without one");
  assert.ok(!msg.includes("<already_asked>"), "no already_asked block when nothing has been asked");
  assert.ok(!msg.includes("Ask again about evidence"), "no retry line when retryOfN is null");
  assert.ok(!msg.includes("Standing instructions:"), "no standing line when blank");
  assert.ok(!msg.includes("was rejected"), "no rejection line when there was no failure");
  assert.ok(
    msg.includes("Difficulty 2: a mechanism or reason: why or how something happens."),
    "the tier is spelled out, not left as a number",
  );
  assert.ok(msg.endsWith("Write one question."), "the closing instruction is last");
});

test("the quiz question blocks appear in the order the prompt expects", () => {
  const msg = p.buildQuizQuestionMessage({
    ...quizBase,
    askedQuestions: ["What is affinity?", "  "],
    retryOfN: 1,
    retryAngle: "What is affinity?",
    standingInstructions: "prefer mechanisms",
    failure: "the quote was not in evidence 1",
  });
  const at = (s) => {
    const i = msg.indexOf(s);
    assert.notEqual(i, -1, `${s} is present`);
    return i;
  };
  const order = [
    at("<evidence>"),
    at("<already_asked>"),
    at("Difficulty 2:"),
    at("Ask again about evidence [1] from a different angle than: What is affinity?"),
    at("Standing instructions: prefer mechanisms"),
    at("The previous attempt was rejected: the quote was not in evidence 1. Fix that."),
    at("Write one question."),
  ];
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "the blocks run in the documented order");
  assert.ok(msg.includes("<already_asked>\nWhat is affinity?\n</already_asked>"), "blank asked questions are dropped");
  assert.ok(msg.endsWith("Write one question."), "the closing instruction is still last");
});

test("each difficulty tier prints its own description", () => {
  assert.ok(
    p.buildQuizQuestionMessage({ ...quizBase, difficulty: 1 }).includes("Difficulty 1: a definition, a number, a name: recall of one fact."),
  );
  assert.ok(
    p
      .buildQuizQuestionMessage({ ...quizBase, difficulty: 3 })
      .includes("Difficulty 3: a distinction or application: what separates two similar things, or which case a rule applies to."),
  );
});

test("the grade message shows one piece of evidence, then the question, expected, and student answer", () => {
  const msg = p.buildQuizGradeMessage({
    evidence: quizEvidence[0],
    question: "  What does a receptor do after binding?  ",
    expected: "It transduces a signal.",
    userAnswer: "it passes the signal on",
  });
  const at = (s) => {
    const i = msg.indexOf(s);
    assert.notEqual(i, -1, `${s} is present`);
    return i;
  };
  const order = [at("<evidence>"), at("<question>"), at("<expected_answer>"), at("<student_answer>"), at("Grade the student's answer")];
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "the four inputs precede the task");
  assert.ok(msg.includes("[1] (Receptors, p.4) Receptors bind ligands"), "the one evidence line is numbered as in Ask");
  assert.ok(!msg.includes("Metabolism"), "the rest of the pool is not sent to the grader");
  assert.ok(msg.includes("<question>\nWhat does a receptor do after binding?\n</question>"), "the question is trimmed");
  assert.ok(msg.endsWith("Grade the student's answer against the evidence."), "the closing instruction is last");
});

test("QuizQuestionOut accepts a grounded draft and rejects an unknown kind or a missing field", () => {
  const draft = {
    question: "What are the two properties of a receptor?",
    answer: "Binding with high affinity and transducing a signal.",
    evidence_n: 1,
    quote: "bind ligands with high affinity",
    hint: "One is about what it attaches to.",
    kind: "recall",
  };
  const ok = schemas.QuizQuestionOut.safeParse(draft);
  assert.equal(ok.success, true, "a full draft parses");
  assert.deepEqual(ok.data, draft, "and comes back unchanged");

  assert.equal(schemas.QuizQuestionOut.safeParse({ ...draft, kind: "trivia" }).success, false, "kind is one of the three");
  assert.equal(schemas.QuizQuestionOut.safeParse({ ...draft, evidence_n: "1" }).success, false, "evidence_n is a number");
  const { hint, ...noHint } = draft;
  assert.equal(schemas.QuizQuestionOut.safeParse(noHint).success, false, "hint is required, not optional");
});

test("QuizGradeOut accepts a verdict with feedback and a quote", () => {
  const ok = schemas.QuizGradeOut.safeParse({ verdict: "partial", feedback: "f", quote: "q" });
  assert.equal(ok.success, true, "a partial grade parses");
  assert.deepEqual(ok.data, { verdict: "partial", feedback: "f", quote: "q" });

  assert.equal(schemas.QuizGradeOut.safeParse({ verdict: "maybe", feedback: "f", quote: "q" }).success, false, "verdict is one of three");
  assert.equal(schemas.QuizGradeOut.safeParse({ verdict: "correct", feedback: "f" }).success, false, "quote is required");
});

test("QuizQuestionOut and QuizGradeOut serialize strictly at every level", () => {
  const question = z.toJSONSchema(schemas.QuizQuestionOut);
  assertStrict(question, "QuizQuestionOut");
  assert.deepEqual(question.properties.kind.enum, ["recall", "why", "distinguish"], "the kind enum is a string enum");
  assert.equal(question.properties.evidence_n.type, "number", "evidence_n is a plain number");
  for (const [k, v] of Object.entries(question.properties)) {
    assert.ok(typeof v.description === "string" && v.description.length > 0, `${k} carries a description`);
  }

  const grade = z.toJSONSchema(schemas.QuizGradeOut);
  assertStrict(grade, "QuizGradeOut");
  assert.deepEqual(grade.properties.verdict.enum, ["correct", "partial", "incorrect"]);
});
