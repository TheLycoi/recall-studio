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
// The quiz schemas live in src/schemas.ts (zod only, no backends and so no
// `obsidian`), which is why they can be bundled here the same way.
let schemas;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wikilm-test-"));
  const out = path.join(dir, "prompt.mjs");
  await build({ entryPoints: ["src/prompt.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  p = await import(pathToFileURL(out).href);
  const schemaOut = path.join(dir, "schemas.mjs");
  await build({ entryPoints: ["src/schemas.ts"], bundle: true, format: "esm", platform: "node", outfile: schemaOut, logLevel: "silent" });
  schemas = await import(pathToFileURL(schemaOut).href);
});

/**
 * The quiz schema goes to Codex through `z.toJSONSchema` (src/codex.ts:150),
 * which runs strict: every property listed in `required` and no extra
 * properties, at every level. A `.optional()` or a `.default()` slipped into
 * schemas.ts would show up here as a property missing from `required`.
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

/* ---------------------------------------------------------------- quiz mode */

const recallSection = {
  noteTitle: "Coaching",
  section: "Motivational interviewing › Elicit-provide-elicit",
  part: 1,
  parts: 1,
  points: [
    "Used when a client asks for information, and only with permission.",
    "Elicit: ask permission, and find out what the client already knows",
    "Provide: share the most relevant information in small doses",
  ],
};

test("the question message puts the section first, numbered, then the level, and the task last, omitting the optional lines", () => {
  const msg = p.buildQuizQuestionMessage({ ...recallSection, level: 1, asked: [], standingInstructions: "", failure: "" });
  assert.ok(msg.includes("Level: 1 (state it)."), msg);
  assert.ok(!msg.includes("<already_asked>"), "no empty asked block");
  assert.ok(msg.startsWith('<section note="Coaching" path="Motivational interviewing › Elicit-provide-elicit" points="3">\n'), msg.slice(0, 120));
  assert.ok(msg.includes("[2] Elicit: ask permission"), "points are numbered");
  assert.ok(msg.trimEnd().endsWith("Write the question."), "the task is last");
  assert.ok(!msg.includes("Standing instructions"), "no empty standing line");
  assert.ok(!msg.includes("rejected"), "no empty failure line");
});

test("the question message carries the part of a split section, the questions already asked, the level, the standing instructions and the failure", () => {
  const msg = p.buildQuizQuestionMessage({ ...recallSection, part: 2, parts: 3, level: 3, asked: ["What is motivational interviewing?"], standingInstructions: "Keep cues short.", failure: "the cue states point 2" });
  assert.ok(msg.includes("<already_asked>\n- What is motivational interviewing?\n</already_asked>"), msg);
  assert.ok(msg.includes("Level: 3 (connect it)."), msg);
  assert.ok(msg.includes('part="2 of 3"'), msg.slice(0, 160));
  assert.ok(msg.includes("Standing instructions: Keep cues short."));
  assert.ok(msg.includes("The previous question was rejected: the cue states point 2. Fix that."));
});

test("the grade message has the section, the question, then the answer directly above the task", () => {
  const msg = p.buildQuizRecallGradeMessage({ ...recallSection, question: "What does a coach do, in order, when using elicit-provide-elicit?", answer: "ask permission first", cued: false });
  const order = ["<section", "<question>", "<student_answer>", "Mark every point."].map((k) => msg.indexOf(k));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "blocks in order");
  assert.ok(order.every((i) => i >= 0), msg);
  assert.ok(!msg.includes("second attempt"));
  const second = p.buildQuizRecallGradeMessage({ ...recallSection, question: "q", answer: "a", cued: true });
  assert.ok(second.includes("second attempt"), "the cued attempt says so");
});

test("QuizQuestionOut and QuizRecallGradeOut parse good drafts and serialize strictly", () => {
  assert.equal(schemas.QuizQuestionOut.safeParse({ question: "What are its steps?", shape: "procedure", expects: [2, 3] }).success, true);
  assert.equal(schemas.QuizQuestionOut.safeParse({ question: "x", shape: "trivia", expects: [1] }).success, false, "shape is one of four");
  assert.equal(schemas.QuizQuestionOut.safeParse({ question: "x", shape: "concept" }).success, false, "the answer key is required");
  const point = { n: 1, status: "recalled", said: "ask permission", note: "", cue: "" };
  assert.equal(schemas.QuizRecallGradeOut.safeParse({ points: [point], feedback: "" }).success, true);
  assert.equal(schemas.QuizRecallGradeOut.safeParse({ points: [{ ...point, status: "correct" }], feedback: "" }).success, false);
  assert.equal(schemas.QuizRecallGradeOut.safeParse({ points: [{ n: 1, status: "missed" }], feedback: "" }).success, false, "every field is required");
  const cue = z.toJSONSchema(schemas.QuizQuestionOut);
  assertStrict(cue, "QuizQuestionOut");
  assert.deepEqual(cue.properties.shape.enum, ["concept", "procedure", "classification", "mechanism"]);
  assertStrict(z.toJSONSchema(schemas.QuizRecallGradeOut), "QuizRecallGradeOut");
});

test("the quiz prompts ask free-response questions with an answer key and a level, never multiple choice or a dump", () => {
  const llm = readFileSync(new URL("../src/llm.ts", import.meta.url), "utf8");
  const body = (name) => new RegExp("const " + name + " = `([\\s\\S]*?)`;").exec(llm)?.[1] ?? "";
  const question = body("QUIZ_QUESTION_SYSTEM");
  for (const needle of ["<what_the_question_is>", "<level>", "<shape>", "<the_question_gives_nothing_away>", "<already_asked>", "two to four sentences", "Never multiple choice", "expects", "at most four"]) {
    assert.ok(question.includes(needle), `question prompt mentions ${needle}`);
  }
  assert.ok(!/write down everything they remember of the section/.test(question), "the write-everything cue is gone");
  assert.ok(!/one detail, not three/.test(question), "the flashcard 'focused' rule is not a question rule");
  const grade = body("QUIZ_RECALL_GRADE_SYSTEM");
  for (const needle of ["<marks>", "<said>", "<hints>", "<feedback>", "character for character", "<question>"]) {
    assert.ok(grade.includes(needle), `grade prompt mentions ${needle}`);
  }
  assert.equal(body("QUIZ_CUE_SYSTEM"), "", "the free-recall cue prompt is gone");
  assert.equal(body("QUIZ_GRADE_SYSTEM"), "", "the passage grade prompt is gone");
});
