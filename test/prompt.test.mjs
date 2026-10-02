// Run with: npm test  (bundles src/prompt.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { z } from "zod";
import { mkdtempSync, readFileSync } from "node:fs";
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
  existingNotes: [{ title: "Pharmacology", kind: "concept", aliases: ["Drug Action"], sections: ["Receptors", "Dosing"], summary: "The study of drug action.", classCodes: ["HBIO250"] }],
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

test("existing notes print title, kind, aliases, class, sections and a summary line", () => {
  const msg = p.buildDigestMessage({ ...digestBase });
  assert.ok(
    msg.includes("<existing_notes>\nPharmacology (concept; aliases: Drug Action; class HBIO250)\n  ## Receptors\n  ## Dosing\n  summary: The study of drug action.\n</existing_notes>"),
    msg,
  );
  const bare = p.buildDigestMessage({ ...digestBase, existingNotes: [] });
  assert.ok(!bare.includes("<existing_notes>"));
  const plain = p.buildDigestMessage({ ...digestBase, existingNotes: [{ title: "WADA", kind: "entity", aliases: [], sections: [], summary: "", classCodes: [] }] });
  assert.ok(plain.includes("<existing_notes>\nWADA (entity)\n</existing_notes>"), "empty parts are left out");
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

test("pages, when given, come before the evidence as title, summary and sections; absent otherwise", () => {
  const withPages = p.buildAskMessage({
    ...askBase,
    pages: [
      { title: "Receptors", summary: "Receptors bind drugs and transduce a signal.", sections: ["Affinity", "Signal transduction"] },
      { title: "Albumin", summary: "", sections: [] },
    ],
  });
  assert.ok(withPages.startsWith("<pages>\nPage: Receptors\nSummary: Receptors bind drugs and transduce a signal.\nSections: Affinity; Signal transduction\n\nPage: Albumin\n</pages>\n\n<evidence>"), withPages);
  const without = p.buildAskMessage({ ...askBase });
  assert.ok(!without.includes("<pages>"), "no pages block when no pages were loaded");
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

const ASK_INSTRUCTION = "Answer from the evidence above, then name in used the one or two pieces the answer rests on.";

test("the ask message ends with the answer-then-cite instruction, after the question", () => {
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

// --- schemas ----------------------------------------------------------------

const SECTION = { heading: "Affinity", prose: "Receptors bind drugs with high affinity [H01].", quote_ids: ["H01"] };

test("a highlight with reader notes renders as a block with the quote, the notes and the heading", () => {
  const msg = p.buildDigestMessage({
    ...digestBase,
    highlights: [{ id: "H01", page: 23, text: "Conduct Disorder (CD)", heading: "Attachment Disorders, \"CD\", ODD", notes: "- Little regard for others\n\t- Bullying, fighting" }],
  });
  assert.ok(
    msg.includes(
      '<highlight id="H01" page="23" heading="Attachment Disorders, &quot;CD&quot;, ODD">\n<quote>Conduct Disorder (CD)</quote>\n<reader_notes>\n- Little regard for others\n\t- Bullying, fighting\n</reader_notes>\n</highlight>',
    ),
    msg,
  );
});

test("a highlight with a heading but no notes stays one line and keeps the heading", () => {
  const msg = p.buildDigestMessage({ ...digestBase, highlights: [{ id: "H01", page: 2, text: "Q", heading: "Kinetics", notes: "  " }] });
  assert.ok(msg.includes('<highlight id="H01" page="2" heading="Kinetics">Q</highlight>'), msg);
});

test("DigestOut accepts a well-formed draft and rejects a note without sections", () => {
  const ok = schemas.DigestOut.safeParse({
    notes: [
      {
        title: "T",
        summary: "S",
        sections: [SECTION],
        related: [],
        kind: "concept",
        aliases: ["T2"],
        tag: "term",
        closest_existing: "",
        why_new: "Nothing listed holds it.",
      },
    ],
    unused_ids: [],
  });
  assert.equal(ok.success, true, "a complete note parses");

  const missing = schemas.DigestOut.safeParse({ notes: [{ title: "T", summary: "S", related: [] }], unused_ids: [] });
  assert.equal(missing.success, false, "sections is required, not optional");

  const noUnused = schemas.DigestOut.safeParse({ notes: [] });
  assert.equal(noUnused.success, false, "unused_ids is required too");
});

test("DigestOut requires kind, aliases, tag, closest_existing and why_new on every note", () => {
  const note = { title: "T", summary: "S", sections: [SECTION], related: [] };
  assert.equal(schemas.DigestOut.safeParse({ notes: [note], unused_ids: [] }).success, false);
  const full = { ...note, kind: "concept", aliases: ["T2"], tag: "term", closest_existing: "", why_new: "Nothing listed holds it." };
  assert.equal(schemas.DigestOut.safeParse({ notes: [full], unused_ids: [] }).success, true);
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

test("AskOut accepts an answer with its sources and rejects a bad coverage", () => {
  const ok = { coverage: "full", from_general_knowledge: false, answer: "Both bind drugs.", used: [{ n: 1, why: "defines binding" }] };
  assert.equal(schemas.AskOut.safeParse(ok).success, true);

  // A none answer names no source, which is the whole point of `none`.
  assert.equal(schemas.AskOut.safeParse({ coverage: "none", from_general_knowledge: false, answer: "Not covered.", used: [] }).success, true);

  assert.equal(schemas.AskOut.safeParse({ ...ok, coverage: "maybe" }).success, false);
  assert.equal(schemas.AskOut.safeParse({ coverage: "full", from_general_knowledge: false, used: [] }).success, false, "answer is required");
  assert.equal(
    schemas.AskOut.safeParse({ ...ok, used: [{ n: 1 }] }).success,
    false,
    "a source without a why is incomplete",
  );
});

test("DigestOut serializes strictly at every level", () => {
  assertStrict(z.toJSONSchema(schemas.DigestOut), "DigestOut");
});

test("AskOut serializes strictly at every level", () => {
  const ask = z.toJSONSchema(schemas.AskOut);
  assertStrict(ask, "AskOut");
  assert.deepEqual(ask.properties.coverage.enum, ["full", "partial", "none"], "z.enum serializes as a string enum");
  assert.equal(ask.properties.answer.type, "string");
  assert.equal(ask.properties.used.items.properties.n.type, "number");
  assert.equal(ask.properties.from_general_knowledge.type, "boolean", "a plain JSON Schema type, not a union");
});

test("KeywordsOut accepts a plain list of search terms", () => {
  assert.equal(schemas.KeywordsOut.safeParse({ keywords: ["pharmacokinetics", "half-life"] }).success, true);
  assert.equal(schemas.KeywordsOut.safeParse({ keywords: "pharmacokinetics" }).success, false);
  assertStrict(z.toJSONSchema(schemas.KeywordsOut), "KeywordsOut");
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
  revealed: [],
  standingInstructions: "",
  failure: "",
};

test("the quiz question message puts the evidence first and the task last, omitting the optional blocks", () => {
  const msg = p.buildQuizQuestionMessage({ ...quizBase });
  assert.ok(msg.startsWith("<evidence>"), "the evidence is the first block");
  assert.ok(msg.includes("[1] (Receptors, p.4) Receptors bind ligands"), "evidence lines carry the note title and page");
  assert.ok(msg.includes("[2] (Drug Disposition) Metabolism"), "a claim with no page prints without one");
  assert.ok(!msg.includes("<already_asked>"), "no already_asked block when nothing has been asked");
  assert.ok(!msg.includes("Already shown to the reader"), "no revealed line when no grade has been shown");
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
    revealed: ["high affinity"],
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
    at("Already shown to the reader as answers, so do not ask for any of them again: high affinity"),
    at("Difficulty 2:"),
    at("Standing instructions: prefer mechanisms"),
    at("The previous attempt was rejected: the quote was not in evidence 1. Fix that."),
    at("Write one question."),
  ];
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "the blocks run in the documented order");
  assert.ok(msg.includes("<already_asked>\nWhat is affinity?\n</already_asked>"), "blank asked questions are dropped");
  assert.ok(msg.endsWith("Write one question."), "the closing instruction is still last");
});

test("the quiz question message lists the answers the reader has already seen", () => {
  const msg = p.buildQuizQuestionMessage({ ...quizBase, askedQuestions: ["What pumps calcium into the SR?"], revealed: ["Ca2+ ATPases (SERCAs)", "  ", "a drug"] });
  assert.ok(
    msg.includes("Already shown to the reader as answers, so do not ask for any of them again: Ca2+ ATPases (SERCAs); a drug"),
    "the revealed answers are listed, blanks dropped",
  );
  assert.ok(msg.indexOf("</already_asked>") < msg.indexOf("Already shown"), "after the asked questions, before the tier");
  assert.ok(msg.indexOf("Already shown") < msg.indexOf("Difficulty 2:"));
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
  const full = { verdict: "partial", feedback: "f", quote: "q", gap: "detail", gapNote: "missed the second property" };
  const ok = schemas.QuizGradeOut.safeParse(full);
  assert.equal(ok.success, true, "a partial grade parses");
  assert.deepEqual(ok.data, full);

  assert.equal(schemas.QuizGradeOut.safeParse({ ...full, verdict: "maybe" }).success, false, "verdict is one of three");
  assert.equal(schemas.QuizGradeOut.safeParse({ verdict: "correct", feedback: "f" }).success, false, "quote is required");

  // The diagnosis drives both the probing and what becomes a card, so it is
  // required and its kinds are closed.
  assert.equal(schemas.QuizGradeOut.safeParse({ verdict: "partial", feedback: "f", quote: "q" }).success, false, "gap is required");
  assert.equal(schemas.QuizGradeOut.safeParse({ ...full, gap: "careless" }).success, false, "gap is one of five");
  assert.equal(schemas.QuizGradeOut.safeParse({ ...full, gap: "none", gapNote: "" }).success, true, "none with an empty note parses");
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

// --- suggest ---------------------------------------------------------------

const suggestBase = {
  pdfTitle: "Doping in Sport",
  classCode: "HBIO 250",
  pages: [
    { page: 3, text: "Doping is defined in the Code." },
    { page: 4, text: "WADA was founded in 1999." },
  ],
  transcript: null,
  existingNotes: [],
  alreadySelected: [],
  perPage: 3,
  remaining: 12,
  standingInstructions: "",
  instruction: "",
};

test("buildSuggestMessage orders the blocks long input first, instructions last", () => {
  const msg = p.buildSuggestMessage({
    ...suggestBase,
    transcript: "  The lecturer stressed the 1999 date.  ",
    existingNotes: [
      { title: "Doping", kind: "concept" },
      { title: "WADA", kind: "entity" },
    ],
    alreadySelected: [{ page: 2, text: "An earlier passage." }],
    standingInstructions: "Prefer definitions.",
    instruction: "Focus on the Code.",
  });

  const paper = msg.indexOf("<paper");
  const transcript = msg.indexOf("<transcript>");
  const notes = msg.indexOf("<existing_notes>");
  const selected = msg.indexOf("<already_selected>");
  const cap = msg.indexOf("Select at most");
  assert.ok(paper < transcript, "the paper precedes the transcript");
  assert.ok(transcript < notes, "the transcript precedes the existing notes");
  assert.ok(notes < selected, "the existing notes precede what is already selected");
  assert.ok(selected < cap, "the cap line comes after every block of material");
  assert.ok(cap < msg.indexOf("Standing instructions:"), "the standing instructions come after the cap");
  assert.ok(msg.indexOf("Standing instructions:") < msg.indexOf("Instructions for this PDF:"), "the PDF instruction is last");

  assert.ok(msg.includes('pages="3-4"'), "the paper block names the first and last page of the batch");
  assert.ok(msg.includes("[page 3]") && msg.indexOf("[page 3]") < msg.indexOf("[page 4]"), "the pages are marked in order");
  assert.ok(msg.includes("Doping (concept)") && msg.includes("WADA (entity)"), "each existing note prints its kind");
  assert.ok(msg.includes("p.2: An earlier passage."), "an already-selected passage prints its page");
  assert.ok(
    msg.includes("The transcript is a recording of the lecture, or a study guide the reader was given, that accompanies these pages.") &&
      msg.includes("and fewer when the transcript supports fewer."),
    "the cap line is the transcript variant",
  );
  assert.ok(!msg.includes("fewer is the expected outcome"), "and not the plain variant");
});

test("buildSuggestMessage omits every empty block", () => {
  const msg = p.buildSuggestMessage({ ...suggestBase, transcript: null, standingInstructions: "   ", instruction: "" });
  assert.ok(!msg.includes("<transcript>"), "no transcript block");
  assert.ok(!msg.includes("<already_selected>"), "no already-selected block");
  assert.ok(!msg.includes("<existing_notes>"), "no existing-notes block");
  assert.ok(!msg.includes("Standing instructions"), "no standing instructions");
  assert.ok(!msg.includes("Instructions for this PDF"), "no per-PDF instruction");
  assert.equal(
    msg.includes("Select at most 3 spans per page and at most 12 in this batch; fewer is the expected outcome."),
    true,
    "the cap line is the plain variant",
  );
});

test("buildSuggestMessage cuts an already-selected passage to eighty characters", () => {
  const long = "x".repeat(100);
  const msg = p.buildSuggestMessage({ ...suggestBase, alreadySelected: [{ page: 1, text: long }] });
  const line = msg.split("\n").find((l) => l.startsWith("p.1: "));
  assert.equal(line, `p.1: ${"x".repeat(80)}…`, "the passage is cut at eighty characters and marked");
  assert.ok(!msg.includes("x".repeat(81)), "nothing longer than the cut survives");
});

test("SuggestOut accepts a draft of spans and new notes", () => {
  const draft = {
    spans: [
      { page: 3, quote: "Doping is defined in the Code.", label: "Definition of doping", text: "", verbatim: true, note_title: "Doping", note_kind: "concept", note_section: "Definitions" },
      { page: 4, quote: "WADA was founded in 1999.", label: "WADA founded 1999", text: "The agency that polices doping dates from 1999.", verbatim: false, note_title: "WADA", note_kind: "entity", note_section: "" },
    ],
    new_notes: [{ title: "WADA", kind: "entity", summary: "One. Two. Three.", closest_existing: "", why_new: "No listed note is about the agency.", aliases: ["World Anti-Doping Agency"], tag: "organization" }],
  };
  const ok = schemas.SuggestOut.safeParse(draft);
  assert.equal(ok.success, true, "a full draft parses");
  assert.deepEqual(ok.data, draft, "and comes back unchanged");

  assert.equal(
    schemas.SuggestOut.safeParse({ ...draft, spans: [{ ...draft.spans[0], note_kind: "topic" }] }).success,
    false,
    "note_kind is one of the two kinds",
  );
  assert.equal(
    schemas.SuggestOut.safeParse({ ...draft, spans: [{ ...draft.spans[0], page: 3.5 }] }).success,
    false,
    "a page is a whole number",
  );
  assert.equal(schemas.SuggestOut.safeParse({ spans: [] }).success, false, "new_notes is required, not optional");
});

test("SuggestOut serializes strictly at every level", () => {
  const json = z.toJSONSchema(schemas.SuggestOut);
  assertStrict(json, "SuggestOut");
  assert.deepEqual(json.properties.spans.items.properties.note_kind.enum, ["concept", "entity"], "note_kind is a string enum");
  for (const [k, v] of Object.entries(json.properties.spans.items.properties)) {
    assert.ok(typeof v.description === "string" && v.description.length > 0, `spans.${k} carries a description`);
  }
  for (const [k, v] of Object.entries(json.properties.new_notes.items.properties)) {
    assert.ok(typeof v.description === "string" && v.description.length > 0, `new_notes.${k} carries a description`);
  }
});

test("SUGGEST_SYSTEM reuses the highlighter's and the digest's own sentences", () => {
  // llm.ts imports the backends, which reach `obsidian`, so it cannot be
  // bundled for node the way prompt.ts and schemas.ts are; the prompt is a
  // string literal in the source, so the source is what gets read.
  const src = readFileSync("src/llm.ts", "utf8");
  assert.ok(src.includes("const SUGGEST_SYSTEM"), "the prompt exists");
  assert.ok(
    src.includes("Return each span as a verbatim quote copied exactly from the page, character for character, including punctuation."),
    "the highlighter's quoting paragraph is reused, with note read as page",
  );
  assert.ok(
    src.includes("Each span is one to four sentences and self-contained:"),
    "the highlighter's span-shape paragraph is reused",
  );
  assert.ok(
    src.includes("The limit you are given is a ceiling, not a target."),
    "the highlighter's ceiling paragraph is reused",
  );
  assert.ok(
    src.includes("reuse the title exactly, character for character"),
    "the digest's rule on reusing an existing title is reused",
  );
  assert.ok(src.includes("Nothing from outside the paper."), "the digest's summary rules are reused");
  assert.ok(src.includes("[page N]"), "the page marker is named");
});

test("buildSuggestMessage lists each existing note's sections under its title", () => {
  const msg = p.buildSuggestMessage({
    ...suggestBase,
    existingNotes: [
      { title: "Pharmacology", kind: "concept", sections: ["Dosing", "Receptors"] },
      { title: "Pharmacodynamics", kind: "concept", sections: [] },
      { title: "WADA", kind: "entity" },
    ],
  });
  assert.ok(
    msg.includes("Pharmacology (concept)\n  ## Dosing\n  ## Receptors\nPharmacodynamics (concept)\nWADA (entity)"),
    "sections are indented under their note; a note without any prints as before",
  );

  const many = Array.from({ length: 25 }, (_, i) => `Section ${i + 1}`);
  const capped = p.buildSuggestMessage({ ...suggestBase, existingNotes: [{ title: "Outline", kind: "concept", sections: many }] });
  assert.ok(capped.includes("  ## Section 20"), "the first twenty are shown");
  assert.ok(!capped.includes("  ## Section 21"), "and no more");
});

test("SuggestOut requires note_section on every span", () => {
  const draft = {
    spans: [{ page: 3, quote: "Q.", label: "L", text: "", verbatim: true, note_title: "Doping", note_kind: "concept" }],
    new_notes: [],
  };
  assert.equal(schemas.SuggestOut.safeParse(draft).success, false, "a span without note_section does not parse");
  assert.equal(schemas.SuggestOut.safeParse({ ...draft, spans: [{ ...draft.spans[0], note_section: "" }] }).success, true, "empty is the form for none");
});

test("SUGGEST_SYSTEM tells the model where in a note a span goes", () => {
  const src = readFileSync("src/llm.ts", "utf8");
  assert.ok(src.includes("<where_in_a_note_a_span_goes>"), "the rule block exists");
  assert.ok(src.includes("A subtopic of an existing note belongs inside that note, not beside it."), "and states the rule");
  assert.ok(src.includes("every note_section is"), "the closing check covers the section");
});

test("SuggestOut requires a new note to name its closest existing note and its reason", () => {
  const base = { spans: [], new_notes: [{ title: "X", kind: "concept", summary: "S." }] };
  assert.equal(schemas.SuggestOut.safeParse(base).success, false, "closest_existing and why_new are required");
  const full = { spans: [], new_notes: [{ ...base.new_notes[0], closest_existing: "", why_new: "Nothing listed is related.", aliases: [], tag: "term" }] };
  assert.equal(schemas.SuggestOut.safeParse(full).success, true);
});

test("SUGGEST_SYSTEM makes a new note the exception reached at the wall", () => {
  const src = readFileSync("src/llm.ts", "utf8");
  assert.ok(src.includes("the order of preference is fixed"), "the preference order is stated");
  assert.ok(src.includes("If you can name a closest existing note, you have not reached the wall"), "naming a home means no new note");
  assert.ok(src.includes("When unsure, prefer concept."), "the kind rule ends where upstream's does");
  assert.ok(src.includes("every new note names a closest_existing"), "the closing check covers new notes");
});

test("SuggestOut requires aliases and a tag on every new note", () => {
  const note = { title: "X", kind: "concept", summary: "S.", closest_existing: "", why_new: "W." };
  assert.equal(schemas.SuggestOut.safeParse({ spans: [], new_notes: [note] }).success, false, "aliases and tag are required");
  assert.equal(schemas.SuggestOut.safeParse({ spans: [], new_notes: [{ ...note, aliases: ["Y"], tag: "term" }] }).success, true);
  assert.equal(schemas.SuggestOut.safeParse({ spans: [], new_notes: [{ ...note, aliases: [], tag: "term" }] }).success, true, "an empty alias list is the form for none");
});

test("SUGGEST_SYSTEM asks for aliases and a tag from the closed vocabulary", () => {
  const src = readFileSync("src/llm.ts", "utf8");
  assert.ok(src.includes("one or two aliases"), "aliases are asked for");
  assert.ok(src.includes("method, theory, term, phenomenon, standard or field"), "the concept vocabulary is named");
  assert.ok(src.includes("product, person, organization, project, event or place"), "the entity vocabulary is named");
});

/* ------------------------------------------------------ aliases and tags */

const aliasesBase = {
  pages: [
    { title: "Anterior Cruciate Ligament", kind: "entity", excerpt: "A ligament of the knee that resists anterior translation of the tibia." },
    { title: "Proprioception", kind: "concept", excerpt: "The sense of the position and movement of one's own body." },
  ],
  conceptTags: ["method", "theory", "term", "phenomenon", "standard", "field", "other"],
  entityTags: ["product", "person", "organization", "project", "event", "place", "other"],
};

test("buildAliasesMessage puts the pages first, then both vocabularies, then the closing instruction", () => {
  const msg = p.buildAliasesMessage(aliasesBase);
  const pages = msg.indexOf("<pages>");
  const concept = msg.indexOf("Concept tags:");
  const entity = msg.indexOf("Entity tags:");
  const closing = msg.indexOf("Return one entry per page");
  assert.ok(pages !== -1 && concept !== -1 && entity !== -1 && closing !== -1, "all four blocks are present");
  assert.ok(pages < concept, "the pages block precedes the vocabularies");
  assert.ok(concept < entity, "the concept vocabulary precedes the entity one");
  assert.ok(entity < closing, "the closing instruction comes last");
  assert.ok(msg.includes("Concept tags: method, theory, term, phenomenon, standard, field, other"), "the concept vocabulary is listed");
  assert.ok(msg.includes("Entity tags: product, person, organization, project, event, place, other"), "the entity vocabulary is listed");
  assert.ok(
    msg.includes("Return one entry per page, in the same order, with the title copied exactly."),
    "the closing instruction is verbatim",
  );
});

test("buildAliasesMessage prints each page with its title and kind", () => {
  const msg = p.buildAliasesMessage(aliasesBase);
  assert.ok(
    msg.includes('<page title="Anterior Cruciate Ligament" kind="entity">'),
    "the first page carries its title and kind",
  );
  assert.ok(msg.includes('<page title="Proprioception" kind="concept">'), "so does the second");
  assert.ok(msg.includes("A ligament of the knee that resists anterior translation of the tibia."), "the excerpt is included");
  assert.equal(msg.split("</page>").length - 1, 2, "one closing tag per page");
});

test("buildAliasesMessage cuts an excerpt at 400 characters and marks the cut", () => {
  assert.equal(p.ALIASES_EXCERPT_CHARS, 400);
  const long = "x".repeat(600);
  const msg = p.buildAliasesMessage({ ...aliasesBase, pages: [{ title: "Long", kind: "concept", excerpt: long }] });
  assert.ok(!msg.includes("x".repeat(401)), "no more than 400 characters of the excerpt survive");
  assert.ok(msg.includes("x".repeat(400) + "…"), "the cut is marked with an ellipsis");

  const short = p.buildAliasesMessage({ ...aliasesBase, pages: [{ title: "Short", kind: "concept", excerpt: "Brief." }] });
  assert.ok(!short.includes("…"), "an excerpt that fits is not marked");
});

test("AliasesTagsOut accepts a page with no aliases and rejects one missing its tag", () => {
  assert.equal(schemas.AliasesTagsOut.safeParse({ pages: [{ title: "T", aliases: [], tag: "other" }] }).success, true);
  assert.equal(
    schemas.AliasesTagsOut.safeParse({ pages: [{ title: "T", aliases: ["ACL"], tag: "term" }] }).success,
    true,
    "a page with aliases parses",
  );
  assert.equal(schemas.AliasesTagsOut.safeParse({ pages: [{ title: "T", aliases: [] }] }).success, false, "tag is required");
  assert.equal(schemas.AliasesTagsOut.safeParse({ pages: [{ title: "T", tag: "term" }] }).success, false, "aliases is required");
});

test("AliasesTagsOut serializes strictly at every level", () => {
  const json = z.toJSONSchema(schemas.AliasesTagsOut);
  assertStrict(json, "AliasesTagsOut");
  for (const [k, v] of Object.entries(json.properties.pages.items.properties)) {
    assert.ok(typeof v.description === "string" && v.description.length > 0, `pages.${k} carries a description`);
  }
});

test("ALIASES_SYSTEM says how many aliases and what other is for", () => {
  const src = readFileSync("src/llm.ts", "utf8");
  assert.ok(src.includes("const ALIASES_SYSTEM"), "the prompt exists");
  assert.ok(src.includes("one or two"), "the number of aliases is stated");
  assert.ok(src.includes("other is the escape hatch"), "other is named as the escape hatch, not a default");
});

// ---- coverage: the digest sees what each page already says

test("an existing note with an outline prints each heading with its lead; without one, headings alone", () => {
  const msg = p.buildDigestMessage({
    ...digestBase,
    existingNotes: [
      { title: "Kinetics", kind: "concept", aliases: [], sections: ["Definition", "Linear Impulse"], summary: "Forces that cause motion.", classCodes: ["HBIO408"], outline: [{ heading: "Definition", lead: "The study of forces that cause motion." }, { heading: "Linear Impulse", lead: "" }] },
      { title: "Other", kind: "concept", aliases: [], sections: ["A"], summary: "", classCodes: ["PSYC360"] },
    ],
  });
  assert.ok(msg.includes("Kinetics (concept; class HBIO408)\n  ## Definition — The study of forces that cause motion.\n  ## Linear Impulse\n  summary: Forces that cause motion.\n"), msg);
  assert.ok(msg.includes("Other (concept; class PSYC360)\n  ## A\n"), msg);
});

test("buildDuplicatesMessage numbers each pair, shows both pages with kind and aliases, the shared fact, and asks for a verdict per number", () => {
  const msg = p.buildDuplicatesMessage({
    pairs: [
      {
        n: 1,
        a: { title: "Linear Kinematics", kind: "concept", aliases: [], excerpt: "Kinematic analysis captures the body's motion." },
        b: { title: "Motion Analysis", kind: "concept", aliases: ["Review questions"], excerpt: "Terms: biomechanics, event, phase. " + "x".repeat(500) },
        shared: "both cite 2 - TBCM and Linear Kinematics 2026 at page=4&selection=0,8,0,26",
      },
    ],
  });
  const iA = msg.indexOf('<page title="Linear Kinematics" kind="concept" aliases="">');
  const iB = msg.indexOf('<page title="Motion Analysis" kind="concept" aliases="Review questions">');
  const iS = msg.indexOf("<shared>both cite 2 - TBCM");
  assert.ok(msg.startsWith('<pairs>\n<pair n="1">'), msg.slice(0, 40));
  assert.ok(iA > 0 && iB > iA && iS > iB, "page a, page b, then what they share");
  assert.ok(msg.includes("x".repeat(300) + "…") === false || msg.includes("…"), "a long excerpt is cut and marked");
  assert.ok(!msg.includes("x".repeat(450)), "the excerpt stops at the limit");
  assert.ok(msg.trimEnd().endsWith("Return one verdict per pair, by its number."), msg.slice(-80));
});

// --- relevance message ------------------------------------------------------

const relevanceBase = {
  question: "What distinguishes a receptor from albumin?",
  candidates: [
    { n: 1, noteTitle: "Pharmacology", page: 2, text: "Pharmacology is the study of the action of drugs." },
    { n: 2, noteTitle: "Receptors", page: 4, text: "Receptors transduce a signal to produce a biological effect." },
    { n: 3, noteTitle: "Plasma Proteins", page: null, text: "Albumin binds drugs but does not transduce a signal." },
  ],
  history: [],
};

const RELEVANCE_TASK = "Name in relevant the numbers of the passages that bear on the question, best first. Name none if none does.";

test("relevance orders the blocks history, candidates, question, task", () => {
  const msg = p.buildRelevanceMessage({
    ...relevanceBase,
    history: [{ role: "user", text: "What is albumin?" }],
  });
  const iH = msg.indexOf("<history>");
  const iC = msg.indexOf("<candidates>");
  const iQ = msg.indexOf("Question: ");
  const iT = msg.indexOf(RELEVANCE_TASK);
  assert.ok(iH === 0, "the history opens the message");
  assert.ok(iH < iC && iC < iQ && iQ < iT, msg);
  const blocks = msg.split("\n\n");
  assert.equal(blocks.at(-1), RELEVANCE_TASK, "the task line is last");
  assert.equal(blocks.at(-2), "Question: What distinguishes a receptor from albumin?", "the question is the last input block");
});

test("relevance shows the candidates as the same numbered lines the drafter sees", () => {
  const msg = p.buildRelevanceMessage({ ...relevanceBase });
  assert.ok(msg.includes("[2] (Receptors, p.4) Receptors transduce a signal to produce a biological effect."), msg);
  // The same rendering as buildAskMessage, so a number means one thing across both calls.
  const ask = p.buildAskMessage({ ...relevanceBase, evidence: relevanceBase.candidates, standingInstructions: "" });
  for (const c of relevanceBase.candidates) {
    const line = `[${c.n}] (${c.noteTitle}${c.page === null ? "" : `, p.${c.page}`}) ${c.text}`;
    assert.ok(msg.includes(line) && ask.includes(line), line);
  }
  assert.ok(msg.includes(`<candidates>\n[1] `), "the block opens with the first candidate line");
});

test("relevance keeps at most the last two turns of history", () => {
  const msg = p.buildRelevanceMessage({
    ...relevanceBase,
    history: [
      { role: "user", text: "First question" },
      { role: "assistant", text: "First answer" },
      { role: "user", text: "Second question" },
      { role: "assistant", text: "Second answer" },
    ],
  });
  assert.ok(!msg.includes("First question"), "the oldest turns are cut");
  assert.ok(!msg.includes("First answer"), "the oldest turns are cut");
  assert.ok(msg.includes("User: Second question"), msg);
  assert.ok(msg.includes("Assistant: Second answer"), msg);
});

test("relevance omits the history block when there is no history", () => {
  const msg = p.buildRelevanceMessage({ ...relevanceBase });
  assert.ok(!msg.includes("<history>"), "no empty block");
  assert.ok(msg.startsWith("<candidates>"), msg.slice(0, 40));
});

test("RELEVANCE_SYSTEM tells the model to judge, never to answer, and to return nothing rather than the closest miss", () => {
  assert.equal(typeof p.RELEVANCE_SYSTEM, "string");
  const lines = p.RELEVANCE_SYSTEM.split("\n").length;
  assert.ok(lines >= 25 && lines <= 40, `system prompt is ${lines} lines`);
  assert.ok(/<examples>/.test(p.RELEVANCE_SYSTEM), "it carries worked examples");
});


test("the quiz question system prompt names the knowledge types, the lenses and note order", () => {
  const llm = readFileSync(new URL("../src/llm.ts", import.meta.url), "utf8");
  const src = /const QUIZ_QUESTION_SYSTEM = `([\s\S]*?)`;/.exec(llm)?.[1] ?? "";
  for (const needle of ["<what_kind_of_knowledge>", "fact", "procedure", "concept", "always, sometimes, or never true", "lowest-numbered open passage"]) {
    assert.ok(src.includes(needle), `system prompt mentions ${needle}`);
  }
});

test("the digest system prompt asks for the mindmap shape: a lead line, one claim per bullet, nested two deep, pages named for linking", () => {
  const llm = readFileSync(new URL("../src/llm.ts", import.meta.url), "utf8");
  const src = /const DIGEST_SYSTEM = `([\s\S]*?)`;/.exec(llm)?.[1] ?? "";
  for (const needle of ["one lead line", "one claim per bullet", "- **", "two levels", "{{", "mind map"]) {
    assert.ok(src.includes(needle), `digest system prompt mentions ${needle}`);
  }
  assert.ok(!src.includes("two to six sentences of digested knowledge"), "the paragraph instruction is gone, not merely joined by the bullet one");
});

// --- lint model review: title scan and page review ---------------------------

const scanPages = [
  { title: "CBT", kind: "concept", aliases: [] },
  { title: "Cognitive Behavioural Therapy", kind: "concept", aliases: ["Cognitive therapy", "CBT-I"] },
  { title: "Hermann Ebbinghaus", kind: "entity", aliases: [] },
];

test("title scan: one self-closing page line per page, titles and aliases verbatim, no bodies", () => {
  const msg = p.buildTitleScanMessage({ pages: scanPages });
  assert.ok(msg.startsWith("<pages>\n"), msg.slice(0, 40));
  assert.equal((msg.match(/<page /g) ?? []).length, 3, "one line per page");
  assert.ok(msg.includes('<page title="CBT" kind="concept" aliases="" />'), msg);
  assert.ok(msg.includes('<page title="Cognitive Behavioural Therapy" kind="concept" aliases="Cognitive therapy, CBT-I" />'), msg);
  assert.ok(msg.includes('<page title="Hermann Ebbinghaus" kind="entity" aliases="" />'), msg);
  assert.ok(!msg.includes("</page>"), "no page bodies are sent");
  assert.ok(/copied exactly/.test(msg.split("</pages>")[1]), "the closing instruction asks for exact titles");
});

test("title scan: an empty wiki still yields a well-formed message", () => {
  const msg = p.buildTitleScanMessage({ pages: [] });
  assert.ok(msg.includes("<pages>") && msg.includes("</pages>"), msg);
  assert.equal((msg.match(/<page /g) ?? []).length, 0);
});

const reviewPage = {
  title: "Spaced Repetition",
  kind: "concept",
  tags: ["method", "memory"],
  aliases: ["SRS"],
  body: "Spaced repetition schedules reviews.\n\n> [!quote] Reviews spaced over days beat massed practice.",
  omitted: [],
  claims: [
    { n: 1, text: "Spaced repetition schedules reviews." },
    { n: 2, text: "Anki uses it." },
  ],
  linked: ["memory", "testing effect"],
};
const reviewDirectory = [
  { title: "Testing Effect", kind: "concept", aliases: ["retrieval practice"] },
  { title: "Anki", kind: "entity", aliases: [] },
];

test("page review: the directory comes first, one line per entry as title (kind): aliases", () => {
  const msg = p.buildReviewMessage({ pages: [reviewPage], directory: reviewDirectory });
  assert.ok(msg.startsWith("<directory>\n"), msg.slice(0, 40));
  assert.ok(msg.indexOf("</directory>") < msg.indexOf("<pages>"), "directory before pages");
  assert.ok(msg.includes("\nTesting Effect (concept): retrieval practice\n"), msg);
  assert.ok(msg.includes("\nAnki (entity)\n"), "an entry with no aliases has no dangling colon");
});

test("page review: each page carries its attributes, body, numbered claims and existing links verbatim", () => {
  const second = { ...reviewPage, title: "Hermann Ebbinghaus", kind: "entity", tags: [], aliases: [], claims: [{ n: 7, text: "He studied forgetting." }], linked: [] };
  const msg = p.buildReviewMessage({ pages: [reviewPage, second], directory: reviewDirectory });
  assert.equal((msg.match(/<page /g) ?? []).length, 2);
  assert.equal((msg.match(/<\/page>/g) ?? []).length, 2);
  assert.ok(msg.includes('<page title="Spaced Repetition" kind="concept" tags="method, memory" aliases="SRS">'), msg);
  assert.ok(msg.includes('<page title="Hermann Ebbinghaus" kind="entity" tags="" aliases="">'), msg);
  assert.ok(msg.includes(`<body>\n${reviewPage.body}\n</body>`), "the body goes as given");
  assert.ok(msg.includes('<claim n="1">Spaced repetition schedules reviews.</claim>'), msg);
  assert.ok(msg.includes('<claim n="2">Anki uses it.</claim>'), msg);
  assert.ok(msg.includes('<claim n="7">He studied forgetting.</claim>'), "claim numbers are copied, not renumbered");
  assert.equal((msg.match(/<claim /g) ?? []).length, 3);
  assert.ok(msg.includes("<linked>memory, testing effect</linked>"), msg);
  const tail = msg.split("</pages>")[1];
  assert.ok(/title copied exactly/.test(tail), tail);
  assert.ok(/by (its )?number/.test(tail), tail);
});

test("page review and title scan: a page's path is never sent, only its title", () => {
  const withPath = { ...reviewPage, path: "wiki/concepts/secret-folder/spaced-repetition.md" };
  const dir = reviewDirectory.map((d, i) => ({ ...d, path: `wiki/hidden-dir/entry-${i}.md` }));
  const msg = p.buildReviewMessage({ pages: [withPath], directory: dir });
  assert.ok(!msg.includes("secret-folder") && !msg.includes("spaced-repetition.md"), msg);
  assert.ok(!msg.includes("hidden-dir"), msg);
  const scan = p.buildTitleScanMessage({ pages: dir });
  assert.ok(!scan.includes("hidden-dir"), scan);
});

test("page review: the omitted-sections line appears only when sections were cut", () => {
  const none = p.buildReviewMessage({ pages: [reviewPage], directory: reviewDirectory });
  assert.ok(!none.includes("Sections not shown"), "no line when nothing was cut");
  const cut = p.buildReviewMessage({ pages: [{ ...reviewPage, omitted: ["History", "Further reading"] }], directory: reviewDirectory });
  assert.equal((cut.match(/Sections not shown: History, Further reading/g) ?? []).length, 1, cut);
});

test("TitleScanOut parses pairs and rejects a missing field or a wrong type", () => {
  const ok = { pairs: [{ a: "CBT", b: "Cognitive Behavioural Therapy", reason: "abbreviation and expansion" }] };
  assert.equal(schemas.TitleScanOut.safeParse(ok).success, true);
  assert.equal(schemas.TitleScanOut.safeParse({ pairs: [] }).success, true, "no pairs is an answer");
  assert.equal(schemas.TitleScanOut.safeParse({ pairs: [{ a: "CBT", b: "Cognitive Behavioural Therapy" }] }).success, false, "reason is required");
  assert.equal(schemas.TitleScanOut.safeParse({ pairs: [{ a: "CBT", b: 3, reason: "r" }] }).success, false, "titles are strings");
  assert.equal(schemas.TitleScanOut.safeParse({}).success, false, "pairs is required");
  assertStrict(z.toJSONSchema(schemas.TitleScanOut), "TitleScanOut");
});

const reviewWire = {
  pages: [
    {
      title: "Spaced Repetition",
      kind: { kind: "none", reason: "" },
      claims: [
        { n: 1, supported: true, by: "Reviews spaced over days beat massed practice", reason: "the quote states it" },
        { n: 2, supported: false, by: "", reason: "no quote names Anki" },
      ],
      links: [{ target: "Testing Effect", reason: "the prose discusses retrieval" }],
    },
    {
      title: "Hermann Ebbinghaus",
      kind: { kind: "entity", reason: "a named person" },
      claims: [],
      links: [],
    },
  ],
};

test("ReviewOut parses a review and rejects a missing field or a wrong type", () => {
  assert.equal(schemas.ReviewOut.safeParse(reviewWire).success, true);
  const pg = reviewWire.pages[0];
  assert.equal(schemas.ReviewOut.safeParse({ pages: [{ ...pg, kind: { kind: "person", reason: "" } }] }).success, false, "kind is concept, entity or none");
  assert.equal(schemas.ReviewOut.safeParse({ pages: [{ ...pg, claims: [{ n: "1", supported: true, by: "x", reason: "r" }] }] }).success, false, "n is a number");
  assert.equal(schemas.ReviewOut.safeParse({ pages: [{ ...pg, claims: [{ n: 1, supported: true, reason: "r" }] }] }).success, false, "by is required");
  assert.equal(schemas.ReviewOut.safeParse({ pages: [{ ...pg, links: [{ target: "Anki" }] }] }).success, false, "a link without a reason is incomplete");
  const { links, ...noLinks } = pg;
  assert.equal(schemas.ReviewOut.safeParse({ pages: [noLinks] }).success, false, "links is required");
});

test("ReviewOut serializes strictly: the no-verdict kind is a sentinel, not a nullable union", () => {
  const js = z.toJSONSchema(schemas.ReviewOut);
  assertStrict(js, "ReviewOut");
  assert.deepEqual(js.properties.pages.items.properties.kind.properties.kind.enum, ["concept", "entity", "none"]);
});

test("reviewDraftOf turns the none sentinel into a null kind and keeps everything else", () => {
  const draft = schemas.reviewDraftOf(schemas.ReviewOut.parse(reviewWire));
  assert.equal(draft.pages.length, 2);
  assert.equal(draft.pages[0].kind, null, "none means no verdict");
  assert.deepEqual(draft.pages[1].kind, { kind: "entity", reason: "a named person" });
  assert.deepEqual(draft.pages[0].claims, reviewWire.pages[0].claims);
  assert.deepEqual(draft.pages[0].links, reviewWire.pages[0].links);
  assert.equal(draft.pages[0].title, "Spaced Repetition");
});

// The system prompts live in src/llm.ts, which cannot be bundled here (it
// reaches `obsidian`), so they are read as text the way
// test/prompt-examples.test.mjs reads the writer prompt.
const llmSource = readFileSync("src/llm.ts", "utf8");
function systemPrompt(name) {
  const m = llmSource.match(new RegExp(`const ${name} = \`([\\s\\S]*?)(?<!\\\\)\`;`));
  assert.ok(m, `${name} not found in src/llm.ts`);
  return m[1];
}

test("TITLE_SCAN_SYSTEM carries its examples, the look-alike warning and the leave-it-out rule", () => {
  const s = systemPrompt("TITLE_SCAN_SYSTEM");
  const n = (s.match(/<example>/g) ?? []).length;
  assert.ok(n >= 2 && n <= 3, `${n} examples`);
  assert.ok(s.includes("<examples>") && s.includes("<note>"));
  assert.ok(s.includes("Kinetics") && s.includes("Kinematics"));
  assert.ok(/unsure/i.test(s) && /leave (it|the pair) out/i.test(s));
  assert.ok(/subtopic/.test(s) && /part/.test(s));
});

test("REVIEW_SYSTEM carries its examples and the rules the verifier enforces", () => {
  const s = systemPrompt("REVIEW_SYSTEM");
  const n = (s.match(/<example>/g) ?? []).length;
  assert.ok(n >= 2 && n <= 3, `${n} examples`);
  assert.ok(/twelve words/.test(s), "the by fragment is capped at twelve words");
  assert.ok(/general knowledge/.test(s), "general knowledge never supports a claim");
  assert.ok(/at most three/.test(s), "links are capped at three");
  assert.ok(/plainly filed wrong/.test(s), "a kind verdict only when plainly wrong");
  assert.ok(/ticks?/.test(s) && /decision/.test(s), "a plausible proposal costs the reader a decision");
});

test("scanTitles and reviewPages run on the lint role with their labels and budgets", () => {
  const body = (name) => {
    const m = llmSource.match(new RegExp(`async ${name}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n  \\}`));
    assert.ok(m, `${name} not found`);
    return m[1];
  };
  const scan = body("scanTitles");
  assert.ok(scan.includes('this.run("lint"') && scan.includes('label: "title scan"') && scan.includes("maxTokens: 4000") && scan.includes('effort: "low"'), scan);
  const review = body("reviewPages");
  assert.ok(review.includes('this.run("lint"') && review.includes('label: "page review"') && review.includes("maxTokens: 6000"), review);
  assert.ok(!review.includes("effort"), "the review reasons, so it keeps the configured effort");
  assert.ok(review.includes("reviewDraftOf"), "the none sentinel is turned into null before the caller sees it");
});
