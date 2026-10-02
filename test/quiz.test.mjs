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
  assert.deepEqual(q.parseQuizCommand("/quiz"), { kind: "start", scope: "this", query: "" });
  assert.deepEqual(q.parseQuizCommand("/quiz all"), { kind: "start", scope: "all", query: "" });
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
  // The panel hands these to matchIntent, so /skpi must not be swallowed.
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











const GROUNDED = [
  { question: "What kind of molecule is a receptor?", quote: "A receptor is a macromolecule", answer: "a macromolecule" },
  { question: "What does affinity measure?", quote: "Affinity is the strength", answer: "binding strength" },
  { question: "What does an agonist do to a receptor?", quote: "an agonist binds a receptor and activates", answer: "it activates" },
  { question: "Where does first-pass metabolism happen?", quote: "First-pass metabolism removes drug", answer: "the liver" },
  { question: "What is the plasma halving time called?", quote: "the time for the plasma concentration to fall by half", answer: "half-life" },
  { question: "What fraction of a dose reaches circulation?", quote: "the fraction of a dose that reaches", answer: "bioavailability" },
];









// ---- checkQuestion -----------------------------------------------------------



















// ---- verifyGradeQuote --------------------------------------------------------





// ---- acceptQuestion ----------------------------------------------------------



// ---- applyGrade --------------------------------------------------------------















// ---- dropUnit and nextRequest ------------------------------------------------





// ---- summary and rendering ---------------------------------------------------















test("parseQuizCommand understands plain phrases", () => {
  assert.deepEqual(q.parseQuizCommand("quiz me"), { kind: "start", scope: "this", query: "" });
  assert.deepEqual(q.parseQuizCommand("Quiz me on receptors!"), { kind: "start", scope: "query", query: "receptors" });
  assert.deepEqual(q.parseQuizCommand("test me on this note"), { kind: "start", scope: "this", query: "" });
  assert.deepEqual(q.parseQuizCommand("start a quiz about drug affinity"), { kind: "start", scope: "query", query: "drug affinity" });
  assert.deepEqual(q.parseQuizCommand("let's do a quick quiz"), { kind: "start", scope: "this", query: "" });
  assert.equal(q.parseQuizCommand("what is a quiz?"), null);
  assert.equal(q.parseQuizCommand("next"), null);
  assert.deepEqual(q.parseQuizCommand("next", true), { kind: "skip" });
  assert.deepEqual(q.parseQuizCommand("Stop.", true), { kind: "stop" });
  assert.deepEqual(q.parseQuizCommand("give me a hint", true), { kind: "hint" });
  assert.equal(q.parseQuizCommand("the next step is absorption", true), null);
});

// ---- lint rules (2026-09-12) ------------------------------------------------









test("wordCoverage sees through a doubled consonant: plotted is plot", () => {
  // The screenshot case: the grade quoted "Plot one angle as a function of
  // another" and the next answer was "One angle plotted as a function of
  // another angle". Every word of it had been shown.
  const cov = q.wordCoverage("One angle plotted as a function of another angle", "Plot one angle as a function of another to show relationship/coordination");
  assert.equal(cov.fraction, 1);
});





test("feedbackGrounded sets aside the student's words and grading vocabulary", () => {
  const ev = "MRI shows structure only, while fMRI shows function, because active regions pull more blood.";
  assert.equal(q.feedbackGrounded("The evidence does not mention mitochondria; it says active regions pull more blood.", ev, "the mitochondria"), true);
  assert.equal(q.feedbackGrounded("Correct: fMRI depends on the BOLD contrast discovered by Ogawa in 1990.", ev, "blood flow"), false);
  assert.equal(q.feedbackGrounded("Matches the evidence exactly.", ev, "active regions pull more blood"), true);
});





test("resolvePool caps the all scope evenly across the ordered pool", () => {
  const many = [];
  for (let n = 0; n < 4; n++) for (let i = 0; i < 10; i++) many.push(unit(`n${n}-${i}`, `notes/n${n}.md`, `Note ${n}`, `Fact ${n}-${i} states one thing about the subject of this note.`));
  const { pool } = q.resolvePool("all", "", many, null, () => null, 10);
  assert.equal(pool.length, 10);
  const notes = new Set(pool.map((u) => u.notePath));
  assert.equal(notes.size, 4);
});



// ---- misses as cards ---------------------------------------------------------









test("missTitle is the question, shortened to a label", () => {
  const short = { question: "What does affinity measure?" };
  assert.equal(q.missTitle(short), "What does affinity measure?");
  const long = { question: "In the passage on receptor pharmacology, what is the one property that separates a receptor from an inert binding site such as albumin?" };
  const title = q.missTitle(long);
  assert.ok(title.length <= 80, `title is ${title.length} chars`);
  assert.ok(title.endsWith("…"), "a cut title says it was cut");
  assert.ok(!/\s…$/.test(title), "no trailing space before the ellipsis");
});

// ---- second chance -----------------------------------------------------------









// ---- the next question's evidence and a failed draft ---------------------------








// ---- quizzable: only statements go into a quiz pool ---------------------------

test("quizzable keeps statements and drops labels, table rows and provenance lines", () => {
  const ok = (t) => q.quizzable(unit("x", RECEPTORS, "Receptors", t));
  assert.equal(ok("A receptor is a macromolecule that binds a drug with high affinity."), true);
  assert.equal(ok("All points on the body have different linear displacements"), true);
  assert.equal(ok("relative angle (y) vs. absolute angle (x) – segment contribution"), true);
  // The live pool that stalled: headings, a table header row, a provenance line.
  assert.equal(ok("Segment Angles"), false, "a heading is a label, not a fact");
  assert.equal(ok("Angle-Angle Diagram"), false);
  assert.equal(ok("Length –Tension Curve"), false);
  assert.equal(ok('"Relative" angle'), false);
  assert.equal(ok("| | Segment angle | Joint angle |"), false, "a table row");
  assert.equal(ok("Digested from Angular Kinematics – Review Questions and its answer key. Angle values are the key's own."), false, "provenance");
  assert.equal(ok(""), false);
});

test("resolvePool offers only quizzable passages, in every scope", () => {
  const pool = [
    unit("h0", RECEPTORS, "Receptors", "Segment Angles"),
    unit("r0", RECEPTORS, "Receptors", "A receptor is a macromolecule that binds a drug with high affinity."),
    unit("t0", RECEPTORS, "Receptors", "| term | meaning |"),
    unit("r1", RECEPTORS, "Receptors", "Affinity is the strength with which a drug binds its receptor."),
  ];
  const ids = (r) => r.pool.map((u) => u.id);
  assert.deepEqual(ids(q.resolvePool("this", "", pool, RECEPTORS, () => null, 20)), ["r0", "r1"]);
  assert.deepEqual(ids(q.resolvePool("all", "", pool, null, () => null, 20)), ["r0", "r1"]);
  assert.deepEqual(ids(q.resolvePool("query", "affinity", pool, null, wordScorer("affinity"), 20)), ["r0", "r1"]);
});





// ---- the card instruction for a missed point ------------------------------------

function miss(extra = {}) {
  return {
    unit: unit("r0", RECEPTORS, "Receptors", "Elicit: ask permission, and find out what the client already knows"),
    question: "Walk through elicit-provide-elicit, each step in order.",
    answer: "Elicit: ask permission, and find out what the client already knows",
    verdict: "skipped",
    gap: "detail",
    gapNote: "could not recall it at all",
    shape: "procedure",
    ...extra,
  };
}

test("renderMissInstruction names the cue, the point and the diagnosis, and ends on the card rules", () => {
  const text = q.renderMissInstruction(miss());
  assert.match(text, /did not produce it/);
  assert.match(text, /They were asked: Walk through elicit-provide-elicit/);
  assert.match(text, /The point: Elicit: ask permission/);
  assert.match(text, /What went wrong — detail: could not recall it at all/);
  assert.match(text, /focused on one thing/);
});

test("renderMissInstruction picks the lens from the gap first, then the section's shape", () => {
  assert.match(q.renderMissInstruction(miss({ verdict: "incorrect", gap: "misconception", gapNote: "thinks it comes last" })), /wrong belief/);
  assert.match(q.renderMissInstruction(miss({ verdict: "partial" })), /only the part they left out/);
  assert.match(q.renderMissInstruction(miss()), /step in a procedure/);
  assert.match(q.renderMissInstruction(miss({ shape: "classification" })), /one member of a set/);
  assert.match(q.renderMissInstruction(miss({ shape: "mechanism" })), /cause on the front/);
  assert.match(q.renderMissInstruction(miss({ shape: "concept" })), /Card the fact itself/);
});

test("missTitle prefers the point over the cue", () => {
  assert.equal(q.missTitle({ question: "Walk through it.", title: "Provide: share information" }), "Provide: share information");
  assert.equal(q.missTitle({ question: "Walk through it." }), "Walk through it.");
});
