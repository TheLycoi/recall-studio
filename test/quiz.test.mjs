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

function session(cap = 30, pool = units()) {
  return q.startSession({ kind: "all", label: "all topic notes" }, "", pool, cap);
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
function ask(s, over, verdict, userAnswer = "an answer", extras = {}) {
  const checked = q.checkQuestion(draft(over), s);
  assert.equal(checked.ok, true, checked.ok ? "" : checked.reason);
  const withCurrent = q.acceptQuestion(s, checked.question);
  return q.applyGrade(withCurrent, verdict, "feedback", "", userAnswer, extras);
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
  assert.deepEqual(q.parseQuizCommand("/idk"), { kind: "skip" });
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

test("resolvePool: query takes whole notes, including passages that never say the word", () => {
  const r = q.resolvePool("query", "receptor", units(), null, wordScorer("receptor"), 20);
  assert.equal(r.label, "receptor");
  // The Receptors note wins, so all three of its passages come, not only the
  // ones containing "receptor". A passage's neighbours are evidence for it: the
  // best material on a subject often never restates the subject's name.
  assert.deepEqual(
    r.pool.map((u) => u.id).sort(),
    ["r0", "r1", "r2"],
  );

  // k still bounds the pool, and the winning note fills it first.
  const capped = q.resolvePool("query", "receptor", units(), null, wordScorer("receptor"), 2);
  assert.equal(capped.pool.length, 2);
  assert.deepEqual(capped.pool.map((u) => u.notePath).sort(), [RECEPTORS, RECEPTORS]);
});

test("resolvePool: query does not pad the pool with a note about something else", () => {
  // "plasma" appears once, in the kinetics note; "receptor" runs through the
  // whole receptors note. The weaker note must not fill the empty slots — that
  // is the bug where a quiz on one subject asked about another.
  const r = q.resolvePool("query", "receptor", units(), null, wordScorer("receptor"), 20);
  assert.equal(
    r.pool.some((u) => u.notePath === KINETICS),
    false,
    "the unrelated note contributes nothing",
  );
});

test("resolvePool: a query spanning two notes draws on both", () => {
  const r = q.resolvePool("query", "drug receptor plasma", units(), null, wordScorer("drug receptor plasma"), 6);
  const notes = new Set(r.pool.map((u) => u.notePath));
  assert.equal(notes.size, 2, "both notes are genuinely relevant here");
  assert.equal(r.pool.length <= 6, true);
});

test("resolvePool: query returns nothing when no note matches", () => {
  const r = q.resolvePool("query", "photosynthesis", units(), null, wordScorer("photosynthesis"), 20);
  assert.deepEqual(r.pool, []);
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

test("a misconception is probed further than an ordinary miss", () => {
  // The reference system's rule: a confidently-held wrong model keeps producing
  // wrong answers until it is replaced, so it earns more than one follow-up.
  let s = session();
  s = ask(s, { evidence_n: 1 }, "incorrect", "an answer", {
    gap: "misconception",
    gapNote: "thinks affinity means efficacy",
  });
  assert.equal(s.retryOf, "r0");
  assert.equal(s.retryAngle, "thinks affinity means efficacy", "the probe aims at the belief, not the old question");

  s = ask(s, { evidence_n: 1, question: "Why does affinity matter here?" }, "incorrect", "an answer", {
    gap: "misconception",
    gapNote: "still conflating the two",
  });
  assert.equal(s.retryOf, "r0", "a misconception gets a second probe");

  s = ask(s, { evidence_n: 1, question: "What else does affinity govern?" }, "incorrect", "an answer", {
    gap: "misconception",
  });
  assert.equal(s.retryOf, null, "but not a third");
});

test("a slip is not probed at all", () => {
  // They know it; a follow-up would spend a question on a typo.
  let s = session();
  s = ask(s, { evidence_n: 1 }, "incorrect", "an answer", { gap: "slip" });
  assert.equal(s.retryOf, null);
});

test("summary keeps real gaps out of the inbox but drops slips", () => {
  let s = session();
  s = ask(s, { evidence_n: 1 }, "incorrect", "an answer", { gap: "slip" });
  s = ask(s, { evidence_n: 2, quote: "Affinity is the strength", answer: "binding strength" }, "incorrect", "x", {
    gap: "misconception",
  });
  const { misses } = q.summary(s);
  assert.deepEqual(
    misses.map((m) => m.unitId),
    ["r1"],
    "the misconception is card-worthy; the slip is not",
  );
});

test("the quiz stops once the edge is bracketed, before the question count", () => {
  // Right at tier 1 (a floor), then two misses at tier 2 (a confirmed ceiling):
  // the edge sits between, so there is nothing left to learn from question 4.
  let s = session();
  s = ask(s, { evidence_n: 1 }, "correct");
  assert.equal(s.finished, false, "a floor alone brackets nothing");
  s = ask(s, { evidence_n: 2, quote: "Affinity is the strength", answer: "binding strength" }, "incorrect");
  assert.equal(s.finished, false, "one miss is a single coordinate, not a ceiling");
  s = ask(s, { evidence_n: 3, quote: "an agonist binds a receptor and activates", answer: "it activates" }, "incorrect");
  assert.equal(s.finished, true, "the second miss confirms the ceiling");
  assert.equal(s.asked.length, 3, "it stopped at three of five");
});

test("an all-correct run never counts as bracketed", () => {
  // The rule that matters most: no misses means the questions were too easy,
  // so the quiz must keep going rather than declare success.
  let s = session();
  s = ask(s, { evidence_n: 1 }, "correct");
  s = ask(s, { evidence_n: 2, quote: "Affinity is the strength", answer: "binding strength" }, "correct");
  s = ask(s, { evidence_n: 3, quote: "an agonist binds a receptor and activates", answer: "it activates" }, "correct");
  assert.equal(s.finished, false, "a floor with no ceiling is not an edge");
  assert.equal(s.difficulty, 3, "it escalated instead");
});

test("a skip serves as a ceiling", () => {
  let s = session();
  s = ask(s, { evidence_n: 1 }, "correct");
  s = ask(s, { evidence_n: 2, quote: "Affinity is the strength", answer: "binding strength" }, "skipped");
  s = ask(s, { evidence_n: 3, quote: "an agonist binds a receptor and activates", answer: "it activates" }, "skipped");
  assert.equal(s.finished, true, "an honest gap bounds the edge like a wrong answer");
});

// One grounded question/quote/answer triple per fixture unit, in pool order.
// Each answer is stated in its passage and absent from its own question, which
// is what `checkQuestion` enforces.
const GROUNDED = [
  { question: "What kind of molecule is a receptor?", quote: "A receptor is a macromolecule", answer: "a macromolecule" },
  { question: "What does affinity measure?", quote: "Affinity is the strength", answer: "binding strength" },
  { question: "What does an agonist do to a receptor?", quote: "an agonist binds a receptor and activates", answer: "it activates" },
  { question: "Where does first-pass metabolism happen?", quote: "First-pass metabolism removes drug", answer: "the liver" },
  { question: "What is the plasma halving time called?", quote: "the time for the plasma concentration to fall by half", answer: "half-life" },
  { question: "What fraction of a dose reaches circulation?", quote: "the fraction of a dose that reaches", answer: "bioavailability" },
];

test("an all-correct run is not stopped at five: the edge is not found yet", () => {
  let s = session();
  // Six straight correct answers. Under the old fixed length this quiz was over
  // after five; the rule is that a run of right answers proves only that the
  // questions were too easy, so it has to keep escalating.
  for (let i = 0; i < 6; i++) {
    s = ask(s, { evidence_n: i + 1, ...GROUNDED[i] }, "correct");
    assert.equal(s.finished, false, `stopped after ${i + 1} correct without a ceiling`);
  }
  assert.equal(s.asked.length, 6, "the quiz ran past the old five-question limit");
  assert.equal(s.difficulty, 3, "and escalated to the hardest tier");
});

test("the cap ends a quiz that never brackets", () => {
  let s = session(3);
  for (let i = 0; i < 3; i++) {
    s = ask(s, { evidence_n: i + 1, ...GROUNDED[i] }, "correct");
  }
  assert.equal(s.finished, true, "the guard fires so a session cannot run away");
  const r = q.summary(s);
  assert.match(r.line, /stopped at the question cap without finding your edge/);
});

test("misses alone do not bracket an edge: there is no floor", () => {
  let s = session();
  s = ask(s, { evidence_n: 1 }, "incorrect");
  s = ask(s, { evidence_n: 2, quote: "Affinity is the strength", answer: "binding strength" }, "incorrect");
  s = ask(s, { evidence_n: 3, quote: "an agonist binds a receptor and activates", answer: "it activates" }, "incorrect");
  assert.equal(s.finished, false, "nothing they got right means no floor to bracket against");
  assert.equal(s.asked.length, 3, "so it keeps going toward the full count");
});

test("summary scores against what was asked, and says why it stopped early", () => {
  let s = session();
  s = ask(s, { evidence_n: 1 }, "correct");
  s = ask(s, { evidence_n: 2, quote: "Affinity is the strength", answer: "binding strength" }, "incorrect");
  s = ask(s, { evidence_n: 3, quote: "an agonist binds a receptor and activates", answer: "it activates" }, "incorrect");
  const { line } = q.summary(s);
  assert.match(line, /1 of 3 correct/, "scored out of what was actually asked");
  assert.match(line, /found your edge/);
});

test("usableUnits excludes dropped and asked but keeps the retry unit", () => {
  let s = session();
  s = ask(s, { evidence_n: 1 }, "incorrect"); // r0 asked, and now the retry unit
  s = q.dropUnit(s, "k0");
  const ids = q.usableUnits(s).map((u) => u.id);
  assert.equal(ids.includes("k0"), false, "dropped unit is gone");
  assert.equal(ids.includes("r0"), true, "the retry unit stays usable");
  assert.deepEqual(ids, ["r0", "r1", "r2", "k1", "k2"]);

  // Once the probes on that unit are spent, the asked unit drops out. An
  // undiagnosed miss gets one follow-up, so the second one ends it.
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

  // A question that starts with "Does" is fine when its answer is a phrase the
  // question does not contain (an either/or that names the answer is rejected
  // separately, as answer leakage).
  const ok = q.checkQuestion(
    draft({ question: "Does a receptor hold on to a drug loosely, or how tightly does it bind?", answer: "with high affinity" }),
    session(),
  );
  assert.equal(ok.ok, true, ok.ok ? "" : ok.reason);
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

test("applyGrade: correct escalates, jumping to the top tier on a streak", () => {
  let s = session();
  s = ask(s, { evidence_n: 1 }, "correct");
  assert.equal(s.difficulty, 2, "one right answer steps up");
  assert.equal(s.correct, 1);
  assert.equal(s.retryOf, null);
  // Two in a row: a floor with no ceiling in sight, so jump rather than inch.
  s = ask(s, { evidence_n: 2, quote: "Affinity is the strength", answer: "binding strength" }, "correct");
  assert.equal(s.difficulty, 3);
  s = ask(s, { evidence_n: 3, quote: "an agonist binds a receptor and activates", answer: "it activates" }, "correct");
  assert.equal(s.difficulty, 3, "capped at 3");
});

test("applyGrade: a miss brackets the edge from above and narrows back down", () => {
  let s = session();
  s = ask(s, { evidence_n: 1 }, "correct");
  s = ask(s, { evidence_n: 2, quote: "Affinity is the strength", answer: "binding strength" }, "correct");
  assert.equal(s.difficulty, 3);
  s = ask(s, { evidence_n: 3, quote: "an agonist binds a receptor and activates", answer: "it activates" }, "incorrect");
  assert.equal(s.difficulty, 2, "the ceiling is found, so narrow back in");
});

test("applyGrade: a broken streak does not count as one", () => {
  let s = session();
  s = ask(s, { evidence_n: 1 }, "correct");
  s = ask(s, { evidence_n: 2, quote: "Affinity is the strength", answer: "binding strength" }, "incorrect");
  assert.equal(s.difficulty, 1, "back to the floor");
  // One correct answer after a miss is a streak of one, not two: step, not jump.
  s = ask(s, { evidence_n: 3, quote: "an agonist binds a receptor and activates", answer: "it activates" }, "correct");
  assert.equal(s.difficulty, 2);
});

test("applyGrade: incorrect arms a retry once, then clears it", () => {
  let s = session();
  s = ask(s, { evidence_n: 1 }, "incorrect");
  assert.equal(s.retryOf, "r0");
  assert.equal(s.retryAngle, "What does a receptor bind with high affinity?");
  assert.equal(s.difficulty, 1, "already at the floor, so it stays there");
  assert.equal(s.wrong, 1);

  // The retry itself misses: the probe is spent, so no second retry.
  s = ask(s, { evidence_n: 1, question: "Why does affinity matter here?" }, "incorrect");
  assert.equal(s.retryOf, null);
  assert.equal(s.wrong, 2);
  assert.equal(s.difficulty, 1);
});

test("applyGrade: a skip lowers the tier but arms no retry", () => {
  let s = session();
  s = ask(s, { evidence_n: 1 }, "correct");
  assert.equal(s.difficulty, 2);
  s = ask(s, { evidence_n: 2, quote: "Affinity is the strength", answer: "binding strength" }, "skipped");
  assert.equal(s.skipped, 1);
  assert.equal(s.difficulty, 1, "a declined answer is a ceiling too");
  assert.equal(s.retryOf, null, "nothing to dislodge, so no retry");
});

test("applyGrade: a partial leaves the tier alone and arms no retry", () => {
  let s = session();
  s = ask(s, { evidence_n: 1 }, "partial");
  assert.equal(s.partial, 1);
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

test("a retry counts toward the cap", () => {
  // Cap 3, and no correct answer anywhere, so nothing can bracket: the only
  // way this quiz ends is the cap, and the retry has to count toward it.
  let s = session(3);
  s = ask(s, { evidence_n: 1 }, "incorrect");
  assert.equal(s.finished, false);
  assert.equal(s.retryOf, "r0");
  s = ask(s, { evidence_n: 1, question: "Same passage, other angle?" }, "incorrect");
  assert.equal(s.finished, false);
  s = ask(s, { evidence_n: 2, quote: "Affinity is the strength", answer: "binding strength" }, "incorrect");
  assert.equal(s.asked.length, 3);
  assert.equal(s.finished, true, "the retry was the second of three graded questions");
  assert.match(q.summary(s).line, /stopped at the question cap/, "ended by the cap, not by bracketing");
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
  let s = session();
  s = ask(s, { evidence_n: 1 }, "correct");
  s = ask(s, { evidence_n: 2, quote: "Affinity is the strength", answer: "binding strength" }, "correct");
  s = ask(s, { evidence_n: 3, quote: "an agonist binds a receptor and activates", answer: "it activates" }, "correct");
  s = ask(s, { evidence_n: 4, quote: "First-pass metabolism removes drug", answer: "the liver" }, "partial");
  s = ask(s, { evidence_n: 5, quote: "the time for the plasma concentration to fall by half", answer: "half-life" }, "incorrect");
  const r = q.summary(s);
  assert.equal(r.line, "3 of 5 correct · 1 partial · 1 wrong · 0 skipped");
  assert.deepEqual(
    r.misses.map((m) => m.unitId),
    ["k0", "k1"],
    "partial and incorrect, in the order asked",
  );
});

test("summary counts every skip as a miss", () => {
  let s = session();
  s = ask(s, { evidence_n: 1 }, "skipped");
  s = ask(s, { evidence_n: 2, quote: "Affinity is the strength", answer: "binding strength" }, "skipped");
  const r = q.summary(s);
  assert.equal(r.line, "0 of 2 correct · 0 partial · 0 wrong · 2 skipped");
  assert.deepEqual(
    r.misses.map((m) => m.unitId),
    ["r0", "r1"],
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
  const md = q.renderQuestionMarkdown(question);
  const lines = md.split("\n");
  assert.equal(lines[0], "**Question 2** *(why)*", "no denominator: the quiz has no target length");
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
  let s = session();
  s = ask(s, { evidence_n: 1 }, "correct");
  s = ask(s, { evidence_n: 4, quote: "First-pass metabolism removes drug", answer: "the liver" }, "incorrect");
  const md = q.renderSummaryMarkdown(s);
  assert.match(md, /^1 of 2 correct · 0 partial · 1 wrong · 0 skipped/);
  assert.match(md, /\*\*Missed:\*\*/);
  assert.match(
    md,
    /- What does a receptor bind with high affinity\? — \[\[classes\/HBIO250\/Pharmacokinetics\|Pharmacokinetics\]\]/,
  );
});

test("renderSummaryMarkdown says so when nothing was missed", () => {
  let s = session();
  s = ask(s, { evidence_n: 1 }, "correct");
  const md = q.renderSummaryMarkdown(s);
  assert.match(md, /No misses\./);
  assert.equal(md.includes("**Missed:**"), false);
});

test("summary lists a retried passage once", () => {
  let s = session();
  s = ask(s, { evidence_n: 1 }, "incorrect", "wrong");
  // the retry asks the same passage again from another angle
  s = ask(s, { evidence_n: 1, question: "Same passage, other angle?" }, "incorrect", "wrong again");
  s = ask(s, { evidence_n: 2, quote: "the strength with which a drug binds its receptor", answer: "the strength of binding" }, "skipped", "");
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

// ---- lint rules (2026-09-12) ------------------------------------------------

test("checkQuestion rejects an expected answer the passage does not state", () => {
  const s = session();
  const r = q.checkQuestion(draft({ answer: "the mitochondria produce the signal" }), s);
  assert.equal(r.ok, false);
  assert.match(r.reason, /not stated in evidence \[1\]/);
});

test("checkQuestion rejects a question that contains its own answer, including an either/or", () => {
  const s = session();
  const r1 = q.checkQuestion(draft({ question: "Does a receptor bind a drug with high affinity?", answer: "a drug" }), s);
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, "the question contains its own answer");
  const r2 = q.checkQuestion(draft({ question: "Does a receptor bind a drug or a hormone?", answer: "a drug" }), s);
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, "the question contains its own answer");
});

test("checkQuestion rejects a question that asks for a set", () => {
  const s = session();
  const r1 = q.checkQuestion(draft({ question: "What are the two things a receptor does?", answer: "a drug" }), s);
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, "asks for a set; ask about one member of it");
  const r2 = q.checkQuestion(draft({ evidence_n: 3, question: "How do agonists and antagonists act?", answer: "binds and activates, and binds and blocks", quote: "An agonist binds a receptor and activates it" }), s);
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, "asks for a set; ask about one member of it");
});

test("checkQuestion blanks a hint that shares no word with the passage", () => {
  const s = session();
  const r = q.checkQuestion(draft({ hint: "Think about mitochondria." }), s);
  assert.equal(r.ok, true);
  assert.equal(r.question.hint, "");
  const kept = q.checkQuestion(draft({ hint: "Think about what the macromolecule attaches to." }), s);
  assert.equal(kept.question.hint, "Think about what the macromolecule attaches to.");
});

test("feedbackGrounded sets aside the student's words and grading vocabulary", () => {
  const ev = "MRI shows structure only, while fMRI shows function, because active regions pull more blood.";
  assert.equal(q.feedbackGrounded("The evidence does not mention mitochondria; it says active regions pull more blood.", ev, "the mitochondria"), true);
  assert.equal(q.feedbackGrounded("Correct: fMRI depends on the BOLD contrast discovered by Ogawa in 1990.", ev, "blood flow"), false);
  assert.equal(q.feedbackGrounded("Matches the evidence exactly.", ev, "active regions pull more blood"), true);
});

test("disputeGrade flags a strict incorrect and an unbacked correct", () => {
  assert.equal(q.disputeGrade("active regions pull more blood", "Active brain regions pull more blood.", "incorrect", true), "Your answer contains the expected wording; the grade may be too strict.");
  assert.equal(q.disputeGrade("the mitochondria", "Active brain regions pull more blood.", "correct", false), "The grade is not backed by a verified quote.");
  assert.equal(q.disputeGrade("the mitochondria", "Active brain regions pull more blood.", "incorrect", true), "");
  assert.equal(q.disputeGrade("active regions pull more blood", "Active brain regions pull more blood.", "correct", true), "");
});

test("resolvePool caps the all scope evenly across the ordered pool", () => {
  const many = [];
  for (let n = 0; n < 4; n++) for (let i = 0; i < 10; i++) many.push(unit(`n${n}-${i}`, `notes/n${n}.md`, `Note ${n}`, `Fact ${n}-${i} about something.`));
  const { pool } = q.resolvePool("all", "", many, null, () => null, 10);
  assert.equal(pool.length, 10);
  const notes = new Set(pool.map((u) => u.notePath));
  assert.equal(notes.size, 4);
});

test("renderGradeMarkdown shows the dispute note and the verified grade quote", () => {
  let s = session();
  const checked = q.checkQuestion(draft(), s);
  s = q.acceptQuestion(s, checked.question);
  s = q.applyGrade(s, "incorrect", "Not what the passage says.", "binds a drug with high affinity", "a drug", { dispute: "Your answer contains the expected wording; the grade may be too strict.", gradeQuoteRejected: false, feedbackGrounded: true });
  const md = q.renderGradeMarkdown(s.asked[0], s.pool[0]);
  assert.match(md, /^✗ Not quite\n\n\*Your answer contains the expected wording; the grade may be too strict\.\*\n\nNot what the passage says\.\n\n\*\*Answer:\*\* a drug\n\n> “binds a drug with high affinity”\n\n/);
  assert.equal(s.asked[0].gradeQuoteRejected, false);
  assert.equal(s.asked[0].feedbackGrounded, true);
});

// ---- misses as cards ---------------------------------------------------------

test("missesForInbox carries the missed question, its answer and the diagnosis with each passage", () => {
  let s = session();
  s = ask(s, { evidence_n: 1 }, "incorrect", "a ligand", { gap: "vocabulary", gapNote: "said ligand for drug" });
  s = ask(s, { evidence_n: 2, quote: "Affinity is the strength", answer: "binding strength" }, "skipped", "", {
    gap: "detail",
    gapNote: "could not recall it at all",
  });
  s = ask(s, { evidence_n: 5, quote: "fall by half", answer: "half" }, "correct");
  const misses = q.missesForInbox(s);
  assert.deepEqual(
    misses.map((m) => [m.unit.id, m.question, m.answer, m.verdict, m.gap, m.gapNote]),
    [
      ["r0", "What does a receptor bind with high affinity?", "a drug", "incorrect", "vocabulary", "said ligand for drug"],
      ["r1", "What does a receptor bind with high affinity?", "binding strength", "skipped", "detail", "could not recall it at all"],
    ],
    "one entry per missed passage, in the order they were asked; the correct one is not there",
  );
});

test("missesForInbox agrees with summary: slips are left out and a retried passage appears once", () => {
  let s = session();
  s = ask(s, { evidence_n: 1 }, "incorrect", "an answer", { gap: "slip" });
  s = ask(s, { evidence_n: 2, quote: "Affinity is the strength", answer: "binding strength" }, "incorrect", "x", {
    gap: "misconception",
    gapNote: "thinks affinity is speed",
  });
  // The retry on the same passage, from another angle.
  s = ask(
    s,
    { evidence_n: 2, question: "Affinity measures what about a drug and its receptor?", quote: "Affinity is the strength", answer: "binding strength" },
    "incorrect",
    "y",
    { gap: "misconception", gapNote: "still speed" },
  );
  const misses = q.missesForInbox(s);
  assert.deepEqual(misses.map((m) => m.unit.id), ["r1"]);
  // The first miss is the one recorded: it is the question the reader failed,
  // and the retry only confirmed it.
  assert.equal(misses[0].question, "What does a receptor bind with high affinity?");
  assert.equal(misses[0].gapNote, "thinks affinity is speed");
});

test("renderMissInstruction tells the writer which question was missed and why", () => {
  const text = q.renderMissInstruction({
    unit: unit("r0", RECEPTORS, "Receptors", "A receptor is a macromolecule that binds a drug with high affinity."),
    question: "What does a receptor bind with high affinity?",
    answer: "a drug",
    verdict: "incorrect",
    gap: "vocabulary",
    gapNote: "said ligand for drug",
  });
  assert.match(text, /missed this question in a quiz/i);
  assert.match(text, /Question: What does a receptor bind with high affinity\?/);
  assert.match(text, /Expected answer: a drug/);
  assert.match(text, /vocabulary: said ligand for drug/);
  assert.match(text, /tests exactly this/i, "the card must test the fact that was missed, not another in the passage");
});

test("renderMissInstruction says when the reader declined rather than answered wrong", () => {
  const skipped = q.renderMissInstruction({
    unit: unit("r1", RECEPTORS, "Receptors", "Affinity is the strength with which a drug binds its receptor."),
    question: "What does affinity measure?",
    answer: "binding strength",
    verdict: "skipped",
    gap: "detail",
    gapNote: "could not recall it at all",
  });
  assert.match(skipped, /could not answer it/i);
  assert.doesNotMatch(skipped, /answered wrong/i);

  // A partial with nothing diagnosed carries no gap line at all.
  const partial = q.renderMissInstruction({
    unit: unit("r1", RECEPTORS, "Receptors", "Affinity is the strength with which a drug binds its receptor."),
    question: "What does affinity measure?",
    answer: "binding strength",
    verdict: "partial",
    gap: "none",
    gapNote: "",
  });
  assert.match(partial, /answered it only partly/i);
  assert.doesNotMatch(partial, /none/);
});

test("missTitle is the question, shortened to a label", () => {
  const short = { question: "What does affinity measure?" };
  assert.equal(q.missTitle(short), "What does affinity measure?");
  const long = { question: "In the passage on receptor pharmacology, what is the one property that separates a receptor from an inert binding site such as albumin?" };
  const title = q.missTitle(long);
  assert.ok(title.length <= 80, `title is ${title.length} chars`);
  assert.ok(title.endsWith("…"), "a cut title says it was cut");
  assert.ok(!/\s…$/.test(title), "no trailing space before the ellipsis");
});
