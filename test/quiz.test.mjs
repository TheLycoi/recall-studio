// Run with: npm test  (bundles src/quiz.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let q;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
  const out = path.join(dir, "quiz.mjs");
  await build({ entryPoints: ["src/quiz.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  q = await import(pathToFileURL(out).href);
});

// ---- fixtures ----------------------------------------------------------------

const RECEPTORS = "classes/HBIO250/Receptors.md";
const KINETICS = "classes/HBIO250/Pharmacokinetics.md";

function unit(id, notePath, noteTitle, text, extra = {}) {
  return {
    id,
    notePath,
    noteTitle,
    pdfBasename: null,
    target: null,
    page: null,
    text,
    kind: "highlight",
    ...extra,
  };
}

/** Six units over two notes; three mention "receptor". */
function units() {
  return [
    unit("r0", RECEPTORS, "Receptors", "A receptor is a macromolecule that binds a drug with high affinity."),
    unit("r1", RECEPTORS, "Receptors", "Affinity is the strength with which a drug binds its receptor."),
    unit("r2", RECEPTORS, "Receptors", "An agonist binds a receptor and activates it; an antagonist binds and blocks."),
    unit("k0", KINETICS, "Pharmacokinetics", "First-pass metabolism removes drug in the liver before it reaches circulation."),
    unit("k1", KINETICS, "Pharmacokinetics", "The half-life is the time for the plasma concentration to fall by half."),
    unit("k2", KINETICS, "Pharmacokinetics", "Bioavailability is the fraction of a dose that reaches the systemic circulation."),
  ];
}

/** The scorer the chat injects: shared significant words, or null. */
function wordScorer(query) {
  const stop = new Set(["the", "a", "an", "of", "is", "and", "that", "with", "for", "it"]);
  const toks = [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 3 && !stop.has(w))
        .map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w)),
    ),
  ];
  return (text) => {
    if (toks.length === 0) return null;
    const have = new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
        .map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w)),
    );
    let n = 0;
    for (const w of toks) if (have.has(w)) n++;
    return n > 0 ? n : null;
  };
}

function session(total = 5, pool = units()) {
  return q.startSession({ kind: "all", label: "all topic notes" }, "", pool, total);
}

function draft(over = {}) {
  return {
    question: "What does a receptor bind with high affinity?",
    answer: "a drug",
    evidence_n: 1,
    quote: "binds a drug with high affinity",
    hint: "Think about what the macromolecule attaches to.",
    kind: "recall",
    ...over,
  };
}

/** Check, accept, and grade one question in one go. */
function ask(s, over, verdict, userAnswer = "an answer") {
  const checked = q.checkQuestion(draft(over), s);
  assert.equal(checked.ok, true, checked.ok ? "" : checked.reason);
  const withCurrent = q.acceptQuestion(s, checked.question);
  return q.applyGrade(withCurrent, verdict, "feedback", "", userAnswer);
}

// ---- parseQuizCommand --------------------------------------------------------

test("parseQuizCommand covers the chat-local commands", () => {
  assert.deepEqual(q.parseQuizCommand("/quiz"), { kind: "start", scope: "all", query: "" });
  assert.deepEqual(q.parseQuizCommand("/Quiz this"), { kind: "start", scope: "this", query: "" });
  assert.deepEqual(q.parseQuizCommand("/quiz drug receptors"), {
    kind: "start",
    scope: "query",
    query: "drug receptors",
  });
  assert.deepEqual(q.parseQuizCommand("/stop"), { kind: "stop" });
  assert.deepEqual(q.parseQuizCommand("/end"), { kind: "stop" });
  assert.deepEqual(q.parseQuizCommand("/skip"), { kind: "skip" });
  assert.deepEqual(q.parseQuizCommand("/next"), { kind: "skip" });
  assert.deepEqual(q.parseQuizCommand("/hint"), { kind: "hint" });
  assert.deepEqual(q.parseQuizCommand("/idk"), { kind: "dontknow" });
  assert.equal(q.parseQuizCommand("hello"), null);
});

test("an unrecognised slash command falls through", () => {
  // The panel hands these to matchCommand, so /skpi must not be swallowed.
  assert.equal(q.parseQuizCommand("/skpi"), null);
  assert.equal(q.parseQuizCommand("/help"), null);
});

// ---- isDontKnow --------------------------------------------------------------

test("isDontKnow recognises a pass and nothing else", () => {
  for (const s of ["idk", "IDK", "I don't know.", "i dont know", "dont know", "no idea", "Not sure", "?", "pass"]) {
    assert.equal(q.isDontKnow(s), true, s);
  }
  assert.equal(q.isDontKnow("Receptors bind ligands"), false);
  assert.equal(q.isDontKnow("not sure how receptors bind"), false);
});

test("an empty or whitespace answer is a pass", () => {
  // The grader's prompt promises a blank never reaches it; this is where that holds.
  assert.equal(q.isDontKnow(""), true);
  assert.equal(q.isDontKnow("   "), true);
  assert.equal(q.isDontKnow("\n\t "), true);
});

// ---- resolvePool -------------------------------------------------------------

test("resolvePool: all takes every unit", () => {
  const r = q.resolvePool("all", "", units(), RECEPTORS, wordScorer(""), 20);
  assert.equal(r.pool.length, 6);
  assert.equal(r.label, "all topic notes");
});

test("resolvePool: this takes the active note and names it", () => {
  const r = q.resolvePool("this", "", units(), KINETICS, wordScorer(""), 20);
  assert.deepEqual(
    r.pool.map((u) => u.id),
    ["k0", "k1", "k2"],
  );
  assert.equal(r.label, "Pharmacokinetics");
});

test("resolvePool: this with no active file is empty", () => {
  const r = q.resolvePool("this", "", units(), null, wordScorer(""), 20);
  assert.equal(r.pool.length, 0);
});

test("resolvePool: query ranks the matching units first and caps at poolSize", () => {
  const r = q.resolvePool("query", "receptor", units(), null, wordScorer("receptor"), 20);
  assert.deepEqual(
    r.pool.map((u) => u.id).sort(),
    ["r0", "r1", "r2"],
  );
  assert.equal(r.label, "receptor");
  for (const u of r.pool) assert.match(u.text.toLowerCase(), /receptor/);

  // poolSize is rankEvidence's k, so its per-note cap of ceil(k/2) applies
  // unchanged (src/retrieval.ts:158): at k=4 one note may contribute 2.
  const capped = q.resolvePool("query", "receptor", units(), null, wordScorer("receptor"), 4);
  assert.equal(capped.pool.length, 2);
});

test("resolvePool: query with a mixed query spreads across notes under the cap", () => {
  const r = q.resolvePool("query", "drug receptor plasma", units(), null, wordScorer("drug receptor plasma"), 6);
  const notes = new Set(r.pool.map((u) => u.notePath));
  assert.equal(notes.size, 2, "both notes contribute");
  assert.equal(r.pool.length <= 6, true);
});

// ---- session and usableUnits -------------------------------------------------

test("startSession freezes the numbering", () => {
  const s = session();
  assert.equal(s.numbered.length, 6);
  assert.deepEqual(
    s.numbered.map((e) => e.n),
    [1, 2, 3, 4, 5, 6],
  );
  assert.equal(s.numbered[0].text, s.pool[0].text);
  assert.equal(s.difficulty, 1);
  assert.equal(s.finished, false);
  assert.deepEqual(s.dropped, []);
});

test("usableUnits excludes dropped and asked but keeps the retry unit", () => {
  let s = session();
  s = ask(s, { evidence_n: 1 }, "incorrect"); // r0 asked, and now the retry unit
  s = q.dropUnit(s, "k0");
  const ids = q.usableUnits(s).map((u) => u.id);
  assert.equal(ids.includes("k0"), false, "dropped unit is gone");
  assert.equal(ids.includes("r0"), true, "the retry unit stays usable");
  assert.deepEqual(ids, ["r0", "r1", "r2", "k1", "k2"]);

  // Once the retry is spent, the asked unit drops out.
  const spent = ask(s, { evidence_n: 1 }, "incorrect");
  assert.equal(
    q.usableUnits(spent).map((u) => u.id).includes("r0"),
    false,
  );
});

// ---- checkQuestion -----------------------------------------------------------

test("checkQuestion accepts a grounded draft", () => {
  const r = q.checkQuestion(draft(), session());
  assert.equal(r.ok, true);
  assert.equal(r.question.unitId, "r0");
  assert.equal(r.question.evidenceN, 1);
  assert.equal(r.question.kind, "recall");
  assert.equal(r.question.answer, "a drug");
  assert.equal(r.question.quote, "binds a drug with high affinity");
  assert.equal("n" in r.question, false);
  assert.equal("difficulty" in r.question, false);
});

test("checkQuestion rejects an out-of-range evidence_n", () => {
  const hi = q.checkQuestion(draft({ evidence_n: 9 }), session());
  assert.equal(hi.ok, false);
  assert.match(hi.reason, /evidence_n 9 is not one of 1…6/);
  const lo = q.checkQuestion(draft({ evidence_n: 0 }), session());
  assert.equal(lo.ok, false);
  assert.match(lo.reason, /not one of/);
});

test("checkQuestion rejects an already-asked unit but allows the retry", () => {
  let s = session();
  s = ask(s, { evidence_n: 1 }, "partial"); // asked r0, no retry armed
  const again = q.checkQuestion(draft({ evidence_n: 1 }), s);
  assert.equal(again.ok, false);
  assert.match(again.reason, /already asked/);

  // With a retry armed on r0, the same unit is allowed back.
  let t = session();
  t = ask(t, { evidence_n: 1 }, "incorrect");
  assert.equal(t.retryOf, "r0");
  const retry = q.checkQuestion(draft({ evidence_n: 1, question: "Why does affinity matter?" }), t);
  assert.equal(retry.ok, true);
});

test("checkQuestion rejects an unverified quote", () => {
  const r = q.checkQuestion(draft({ quote: "binds a ligand with low affinity" }), session());
  assert.equal(r.ok, false);
  assert.match(r.reason, /not in evidence \[1\] word for word/);

  const empty = q.checkQuestion(draft({ quote: "   " }), session());
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "empty quote");
});

test("checkQuestion tolerates punctuation and case in the quote", () => {
  // Mirrors checkAnswer's normalised substring check, not a literal one.
  const r = q.checkQuestion(draft({ quote: "Binds a DRUG, with high affinity!" }), session());
  assert.equal(r.ok, true);
});

test("checkQuestion rejects a yes/no answer by the answer, not the question", () => {
  const yes = q.checkQuestion(draft({ answer: "Yes." }), session());
  assert.equal(yes.ok, false);
  assert.equal(yes.reason, "yes/no answer");
  const no = q.checkQuestion(draft({ answer: "no" }), session());
  assert.equal(no.ok, false);
  assert.equal(no.reason, "yes/no answer");

  // A question that starts with "Does" is fine when its answer is a phrase.
  const ok = q.checkQuestion(
    draft({ question: "Does a receptor bind a drug weakly or with high affinity?", answer: "with high affinity" }),
    session(),
  );
  assert.equal(ok.ok, true);
});

test("checkQuestion rejects an empty answer or question", () => {
  const a = q.checkQuestion(draft({ answer: "  " }), session());
  assert.equal(a.ok, false);
  assert.equal(a.reason, "empty answer");
  const qq = q.checkQuestion(draft({ question: "" }), session());
  assert.equal(qq.ok, false);
  assert.equal(qq.reason, "empty question");
});

test("checkQuestion rejects a dropped unit", () => {
  const s = q.dropUnit(session(), "r0");
  const r = q.checkQuestion(draft({ evidence_n: 1 }), s);
  assert.equal(r.ok, false);
  assert.match(r.reason, /already skipped/);
  // The numbering did not move: [2] is still r1.
  const other = q.checkQuestion(
    draft({ evidence_n: 2, quote: "Affinity is the strength", answer: "the strength of binding" }),
    s,
  );
  assert.equal(other.ok, true);
  assert.equal(other.question.unitId, "r1");
});

// ---- verifyGradeQuote --------------------------------------------------------

test("verifyGradeQuote keeps a verified quote and drops the rest", () => {
  const text = units()[0].text;
  assert.equal(q.verifyGradeQuote("binds a drug with high affinity", text), "binds a drug with high affinity");
  assert.equal(q.verifyGradeQuote("binds a hormone", text), "");
  assert.equal(q.verifyGradeQuote("   ", text), "");
});

// ---- acceptQuestion ----------------------------------------------------------

test("acceptQuestion numbers questions from 1 and carries the difficulty", () => {
  let s = session();
  const first = q.checkQuestion(draft(), s);
  s = q.acceptQuestion(s, first.question);
  assert.equal(s.current.n, 1);
  assert.equal(s.current.difficulty, 1);
  assert.equal(s.hintShown, false);

  s = q.applyGrade(s, "correct", "", "", "a drug");
  const second = q.checkQuestion(
    draft({ evidence_n: 2, quote: "Affinity is the strength", answer: "binding strength" }),
    s,
  );
  s = q.acceptQuestion(s, second.question);
  assert.equal(s.current.n, 2);
  assert.equal(s.current.difficulty, 2, "the correct answer raised the tier");
});

// ---- applyGrade --------------------------------------------------------------

test("applyGrade: correct raises the difficulty to a ceiling of 3", () => {
  let s = session();
  s = ask(s, { evidence_n: 1 }, "correct");
  assert.equal(s.difficulty, 2);
  assert.equal(s.correct, 1);
  assert.equal(s.retryOf, null);
  s = ask(s, { evidence_n: 2, quote: "Affinity is the strength", answer: "binding strength" }, "correct");
  assert.equal(s.difficulty, 3);
  s = ask(s, { evidence_n: 3, quote: "an agonist binds a receptor and activates", answer: "it activates" }, "correct");
  assert.equal(s.difficulty, 3, "capped at 3");
});

test("applyGrade: incorrect arms a retry once, then clears it", () => {
  let s = session();
  s = ask(s, { evidence_n: 1 }, "incorrect");
  assert.equal(s.retryOf, "r0");
  assert.equal(s.retryAngle, "What does a receptor bind with high affinity?");
  assert.equal(s.difficulty, 1, "a miss does not change the tier");
  assert.equal(s.wrong, 1);

  // The retry itself misses: the probe is spent, so no second retry.
  s = ask(s, { evidence_n: 1, question: "Why does affinity matter here?" }, "incorrect");
  assert.equal(s.retryOf, null);
  assert.equal(s.wrong, 2);
  assert.equal(s.difficulty, 1);
});

test("applyGrade: partial, dontknow and skipped leave the tier alone and arm no retry", () => {
  let s = session();
  s = ask(s, { evidence_n: 1 }, "partial");
  assert.equal(s.partial, 1);
  assert.equal(s.difficulty, 1);
  assert.equal(s.retryOf, null);

  s = ask(s, { evidence_n: 2, quote: "Affinity is the strength", answer: "binding strength" }, "dontknow");
  assert.equal(s.dontKnow, 1);
  assert.equal(s.difficulty, 1);
  assert.equal(s.retryOf, null);

  s = ask(s, { evidence_n: 3, quote: "an agonist binds a receptor and activates", answer: "it activates" }, "skipped");
  assert.equal(s.skipped, 1);
  assert.equal(s.difficulty, 1);
  assert.equal(s.retryOf, null);
});

test("applyGrade is immutable and records the answer", () => {
  const s = session();
  const checked = q.checkQuestion(draft(), s);
  const withCurrent = q.acceptQuestion(s, checked.question);
  const graded = q.applyGrade(withCurrent, "correct", "Right: it binds a drug.", "binds a drug", "a drug");
  assert.equal(s.asked.length, 0, "the original session is untouched");
  assert.equal(withCurrent.asked.length, 0);
  assert.equal(graded.asked.length, 1);
  assert.equal(graded.current, null);
  const a = graded.asked[0];
  assert.equal(a.userAnswer, "a drug");
  assert.equal(a.verdict, "correct");
  assert.equal(a.feedback, "Right: it binds a drug.");
  assert.equal(a.gradeQuote, "binds a drug");
  assert.equal(a.n, 1);
});

test("a retry counts toward the total", () => {
  // total 3: correct, incorrect, incorrect-on-the-retry → finished.
  let s = session(3);
  s = ask(s, { evidence_n: 1 }, "correct");
  assert.equal(s.finished, false);
  s = ask(s, { evidence_n: 2, quote: "Affinity is the strength", answer: "binding strength" }, "incorrect");
  assert.equal(s.finished, false);
  assert.equal(s.retryOf, "r1");
  s = ask(s, { evidence_n: 2, question: "Why does affinity matter?", quote: "Affinity is the strength", answer: "binding strength" }, "incorrect");
  assert.equal(s.asked.length, 3);
  assert.equal(s.finished, true);
});

// ---- dropUnit and nextRequest ------------------------------------------------

test("dropUnit is idempotent and keeps the pool intact", () => {
  let s = session();
  s = q.dropUnit(s, "r0");
  s = q.dropUnit(s, "r0");
  assert.deepEqual(s.dropped, ["r0"]);
  assert.equal(s.pool.length, 6, "dropped, never removed");
  assert.equal(s.numbered.length, 6);
});

test("nextRequest carries the tier, the asked questions and the retry number", () => {
  let s = session();
  const fresh = q.nextRequest(s);
  assert.deepEqual(fresh, { difficulty: 1, askedQuestions: [], retryOfN: null, retryAngle: "" });

  s = ask(s, { evidence_n: 2, quote: "Affinity is the strength", answer: "binding strength" }, "incorrect");
  const r = q.nextRequest(s);
  assert.equal(r.difficulty, 1);
  assert.equal(r.retryOfN, 2, "the retry unit's frozen number");
  assert.equal(r.retryAngle, "What does a receptor bind with high affinity?");
  assert.deepEqual(r.askedQuestions, ["What does a receptor bind with high affinity?"]);
});

// ---- summary and rendering ---------------------------------------------------

test("summary counts misses and formats the score line", () => {
  let s = session(5);
  s = ask(s, { evidence_n: 1 }, "correct");
  s = ask(s, { evidence_n: 2, quote: "Affinity is the strength", answer: "binding strength" }, "correct");
  s = ask(s, { evidence_n: 3, quote: "an agonist binds a receptor and activates", answer: "it activates" }, "correct");
  s = ask(s, { evidence_n: 4, quote: "First-pass metabolism removes drug", answer: "the liver" }, "partial");
  s = ask(s, { evidence_n: 5, quote: "the time for the plasma concentration to fall by half", answer: "half-life" }, "incorrect");
  const r = q.summary(s);
  assert.equal(r.line, "3 of 5 correct · 1 partial · 1 wrong · 0 passed · 0 skipped");
  assert.deepEqual(
    r.misses.map((m) => m.unitId),
    ["k0", "k1"],
    "partial and incorrect, in the order asked",
  );
});

test("summary counts a dontknow as a miss and a skip as neither", () => {
  let s = session(2);
  s = ask(s, { evidence_n: 1 }, "dontknow");
  s = ask(s, { evidence_n: 2, quote: "Affinity is the strength", answer: "binding strength" }, "skipped");
  const r = q.summary(s);
  assert.equal(r.line, "0 of 2 correct · 0 partial · 0 wrong · 1 passed · 1 skipped");
  assert.deepEqual(
    r.misses.map((m) => m.unitId),
    ["r0"],
  );
});

test("renderQuestionMarkdown's first line is exactly the header", () => {
  const question = {
    n: 2,
    unitId: "r0",
    evidenceN: 1,
    question: "Why does a receptor's affinity matter?",
    answer: "it sets how much drug is needed",
    quote: "high affinity",
    hint: "think about dose",
    difficulty: 2,
    kind: "why",
  };
  const md = q.renderQuestionMarkdown(question, 5);
  const lines = md.split("\n");
  assert.equal(lines[0], "**Question 2/5** *(why)*");
  assert.equal(lines[1], "");
  assert.equal(lines[2], "Why does a receptor's affinity matter?");
  assert.equal(md.includes("difficulty"), false, "the tier is internal");
});

test("renderGradeMarkdown shows the verdict, feedback, answer and passage", () => {
  const u = units()[0];
  const asked = {
    n: 1,
    unitId: "r0",
    evidenceN: 1,
    question: "What does a receptor bind?",
    answer: "a drug, with high affinity",
    quote: "binds a drug with high affinity",
    hint: "h",
    difficulty: 1,
    kind: "recall",
    userAnswer: "a drug",
    verdict: "correct",
    feedback: "You named the binding partner.",
    gradeQuote: "binds a drug with high affinity",
  };
  const md = q.renderGradeMarkdown(asked, u);
  assert.equal(md.split("\n")[0], "✓ Correct");
  assert.match(md, /You named the binding partner\./);
  assert.match(md, /\*\*Answer:\*\* a drug, with high affinity/);
  assert.match(md, /\*\*\[1\]\*\* \[\[classes\/HBIO250\/Receptors\|Receptors\]\]/);
  assert.match(md, /> A receptor is a macromolecule/);

  for (const [verdict, line] of [
    ["partial", "△ Partly"],
    ["incorrect", "✗ Not quite"],
    ["dontknow", "– You passed"],
    ["skipped", "→ Skipped"],
  ]) {
    const out = q.renderGradeMarkdown({ ...asked, verdict }, u);
    assert.equal(out.split("\n")[0], line);
  }
});

test("renderGradeMarkdown omits empty feedback", () => {
  const u = units()[0];
  const asked = {
    n: 1,
    unitId: "r0",
    evidenceN: 1,
    question: "What does a receptor bind?",
    answer: "a drug",
    quote: "",
    hint: "",
    difficulty: 1,
    kind: "recall",
    userAnswer: "",
    verdict: "skipped",
    feedback: "   ",
    gradeQuote: "",
  };
  const md = q.renderGradeMarkdown(asked, u);
  assert.equal(md.split("\n\n")[1], "**Answer:** a drug");
});

test("renderSummaryMarkdown links each miss to its note", () => {
  let s = session(2);
  s = ask(s, { evidence_n: 1 }, "correct");
  s = ask(s, { evidence_n: 4, quote: "First-pass metabolism removes drug", answer: "the liver" }, "incorrect");
  const md = q.renderSummaryMarkdown(s);
  assert.match(md, /^1 of 2 correct · 0 partial · 1 wrong · 0 passed · 0 skipped/);
  assert.match(md, /\*\*Missed:\*\*/);
  assert.match(
    md,
    /- What does a receptor bind with high affinity\? — \[\[classes\/HBIO250\/Pharmacokinetics\|Pharmacokinetics\]\]/,
  );
});

test("renderSummaryMarkdown says so when nothing was missed", () => {
  let s = session(1);
  s = ask(s, { evidence_n: 1 }, "correct");
  const md = q.renderSummaryMarkdown(s);
  assert.match(md, /No misses\./);
  assert.equal(md.includes("**Missed:**"), false);
});

test("summary lists a retried passage once", () => {
  let s = session(3);
  s = ask(s, { evidence_n: 1 }, "incorrect", "wrong");
  // the retry asks the same passage again from another angle
  s = ask(s, { evidence_n: 1, question: "Same passage, other angle?" }, "incorrect", "wrong again");
  s = ask(s, { evidence_n: 2, quote: "the strength with which a drug binds its receptor", answer: "the strength of binding" }, "dontknow", "");
  const { misses } = q.summary(s);
  assert.equal(misses.length, 2);
  assert.equal(new Set(misses.map((m) => m.unitId)).size, 2);
});

test("parseQuizCommand understands plain phrases", () => {
  assert.deepEqual(q.parseQuizCommand("quiz me"), { kind: "start", scope: "all", query: "" });
  assert.deepEqual(q.parseQuizCommand("Quiz me on receptors!"), { kind: "start", scope: "query", query: "receptors" });
  assert.deepEqual(q.parseQuizCommand("test me on this note"), { kind: "start", scope: "this", query: "" });
  assert.deepEqual(q.parseQuizCommand("start a quiz about drug affinity"), { kind: "start", scope: "query", query: "drug affinity" });
  assert.deepEqual(q.parseQuizCommand("let's do a quick quiz"), { kind: "start", scope: "all", query: "" });
  assert.equal(q.parseQuizCommand("what is a quiz?"), null);
  assert.equal(q.parseQuizCommand("next"), null);
  assert.deepEqual(q.parseQuizCommand("next", true), { kind: "skip" });
  assert.deepEqual(q.parseQuizCommand("Stop.", true), { kind: "stop" });
  assert.deepEqual(q.parseQuizCommand("give me a hint", true), { kind: "hint" });
  assert.equal(q.parseQuizCommand("the next step is absorption", true), null);
});
