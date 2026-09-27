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
  { n: 3, noteTitle: "Receptors", page: 5, text: "Only a receptor transduces a signal" },
];

test("checkAnswer keeps the prose as written", () => {
  const draft = {
    coverage: "full", from_general_knowledge: false,
    answer: "Both bind drugs, but only a receptor transduces a signal.",
    used: [{ n: 1, why: "defines binding" }],
  };
  const { answer, report } = ac.checkAnswer(draft, EVIDENCE);
  // No sentence splitting, no citation markers appended: what the model wrote
  // is what the reader sees.
  assert.equal(answer, "Both bind drugs, but only a receptor transduces a signal.");
  assert.equal(report.coverage, "full");
  assert.deepEqual(report.sources, [{ n: 1, why: "defines binding" }]);
});

test("checkAnswer caps the sources at two, best first", () => {
  const draft = {
    coverage: "full", from_general_knowledge: false,
    answer: "An answer.",
    used: [
      { n: 3, why: "states the distinction" },
      { n: 1, why: "defines binding" },
      { n: 2, why: "the contrast case" },
    ],
  };
  const { report } = ac.checkAnswer(draft, EVIDENCE);
  assert.equal(report.sources.length, ac.MAX_SOURCES);
  assert.deepEqual(report.sources.map((s) => s.n), [3, 1]);
});

test("checkAnswer drops a citation pointing past the evidence and counts it", () => {
  const draft = { coverage: "full", from_general_knowledge: false, answer: "An answer.", used: [{ n: 9, why: "invented" }, { n: 2, why: "real" }] };
  const { report } = ac.checkAnswer(draft, EVIDENCE);
  assert.deepEqual(report.sources, [{ n: 2, why: "real" }]);
  assert.equal(report.dropped, 1);
});

test("checkAnswer drops a non-integer or zero citation", () => {
  const draft = { coverage: "full", from_general_knowledge: false, answer: "An answer.", used: [{ n: 0, why: "" }, { n: 1.5, why: "" }] };
  const { report } = ac.checkAnswer(draft, EVIDENCE);
  assert.deepEqual(report.sources, []);
  assert.equal(report.dropped, 2);
});

test("checkAnswer ignores a repeated citation without counting it as bad", () => {
  const draft = { coverage: "full", from_general_knowledge: false, answer: "An answer.", used: [{ n: 1, why: "first" }, { n: 1, why: "again" }] };
  const { report } = ac.checkAnswer(draft, EVIDENCE);
  assert.deepEqual(report.sources, [{ n: 1, why: "first" }]);
  assert.equal(report.dropped, 0);
});

test("checkAnswer reports no coverage when every citation was dropped", () => {
  const draft = { coverage: "full", from_general_knowledge: false, answer: "An answer.", used: [{ n: 9, why: "invented" }] };
  const { answer, report } = ac.checkAnswer(draft, EVIDENCE);
  assert.equal(report.coverage, "none", "nothing survived verification, so the notes did not answer it");
  assert.deepEqual(report.sources, []);
  assert.equal(report.dropped, 1);
  assert.equal(answer, "An answer.", "the answer text is untouched");
  assert.equal(ac.renderGroundingLine(report), "Not in your notes · 1 bad citation dropped");
});

test("checkAnswer keeps coverage when some citations survive the drop", () => {
  const draft = { coverage: "partial", from_general_knowledge: false, answer: "An answer.", used: [{ n: 9, why: "invented" }, { n: 2, why: "real" }] };
  const { report } = ac.checkAnswer(draft, EVIDENCE);
  assert.equal(report.coverage, "partial");
  assert.deepEqual(report.sources, [{ n: 2, why: "real" }]);
  assert.equal(report.dropped, 1);
});

test("checkAnswer leaves a clean answer's coverage alone", () => {
  const draft = { coverage: "full", from_general_knowledge: false, answer: "An answer.", used: [{ n: 1, why: "real" }] };
  const { report } = ac.checkAnswer(draft, EVIDENCE);
  assert.equal(report.coverage, "full");
  assert.equal(report.dropped, 0);
});

test("checkAnswer keeps a none-coverage answer and its empty source list", () => {
  const draft = { coverage: "none", from_general_knowledge: false, answer: "Your notes do not cover this.", used: [] };
  const { answer, report } = ac.checkAnswer(draft, EVIDENCE);
  assert.equal(answer, "Your notes do not cover this.");
  assert.equal(report.coverage, "none");
  assert.deepEqual(report.sources, []);
});

test("checkAnswer falls back when the model returned nothing", () => {
  const { answer, report } = ac.checkAnswer({ coverage: "full", from_general_knowledge: false, answer: "   ", used: [{ n: 1, why: "x" }] }, EVIDENCE);
  assert.match(answer, /empty answer/);
  // An answer with no text cannot be "full" whatever the model claimed.
  assert.equal(report.coverage, "none");
});

test("noEvidenceAnswer names the question and the fix", () => {
  const { answer, report } = ac.noEvidenceAnswer("half-life");
  assert.match(answer, /half-life/);
  assert.match(answer, /Digest the lecture/);
  assert.equal(report.coverage, "none");
  assert.deepEqual(report.sources, []);
});

test("emptyIndexAnswer blames the setting, not the notes", () => {
  const { answer, report } = ac.emptyIndexAnswer("classes/");
  assert.match(answer, /No notes were searched/);
  assert.match(answer, /classes/);
  assert.doesNotMatch(answer, /Digest the lecture/);
  assert.equal(report.coverage, "none");
});

test("renderGroundingLine states coverage in words the reader can act on", () => {
  assert.equal(ac.renderGroundingLine({ coverage: "full", sources: [], dropped: 0, fromGeneralKnowledge: false }), "Answered from your notes");
  assert.equal(ac.renderGroundingLine({ coverage: "partial", sources: [], dropped: 0, fromGeneralKnowledge: false }), "Partly answered from your notes");
  assert.equal(ac.renderGroundingLine({ coverage: "none", sources: [], dropped: 0, fromGeneralKnowledge: false }), "Not in your notes");
});

test("renderGroundingLine mentions dropped citations only when there are any", () => {
  assert.equal(ac.renderGroundingLine({ coverage: "full", sources: [], dropped: 1, fromGeneralKnowledge: false }), "Answered from your notes · 1 bad citation dropped");
  assert.equal(ac.renderGroundingLine({ coverage: "full", sources: [], dropped: 2, fromGeneralKnowledge: false }), "Answered from your notes · 2 bad citations dropped");
});

test("a general-knowledge answer is flagged and carries no source", () => {
  const draft = { coverage: "none", from_general_knowledge: true, answer: "In general, first-pass metabolism is…", used: [] };
  const { report } = ac.checkAnswer(draft, EVIDENCE);
  assert.equal(report.fromGeneralKnowledge, true);
  assert.deepEqual(report.sources, []);
  assert.match(ac.renderGroundingLine(report), /General knowledge/);
  assert.match(ac.VERIFY_BANNER, /Verify this/);
});

test("the flag is refused when the model also named a source", () => {
  // It cannot both come from their notes and from outside them; the citation
  // is the harder evidence, so the disclaimer is what gives way.
  const draft = { coverage: "full", from_general_knowledge: true, answer: "An answer.", used: [{ n: 1, why: "defines it" }] };
  const { report } = ac.checkAnswer(draft, EVIDENCE);
  assert.equal(report.fromGeneralKnowledge, false);
  assert.deepEqual(report.sources, [{ n: 1, why: "defines it" }]);
});

// ---- the sources an answer rested on, shared by the rows and the inbox button ----

test("pickSources returns the cited units in citation order, with the model's reason", () => {
  const ev = ["u1", "u2", "u3"];
  const report = { coverage: "full", sources: [{ n: 3, why: "defines it" }, { n: 1, why: "" }], dropped: 0 };
  assert.deepEqual(ac.pickSources(ev, report), [{ unit: "u3", why: "defines it" }, { unit: "u1", why: "" }]);
});

test("pickSources stands in the best-ranked unit when nothing was cited, but not for a none answer or when every citation was dropped", () => {
  const ev = ["u1", "u2"];
  assert.deepEqual(ac.pickSources(ev, { coverage: "partial", sources: [], dropped: 0 }), [{ unit: "u1", why: "" }]);
  assert.deepEqual(ac.pickSources(ev, { coverage: "none", sources: [], dropped: 0 }), []);
  assert.deepEqual(ac.pickSources(ev, { coverage: "partial", sources: [], dropped: 2 }), []);
  assert.deepEqual(ac.pickSources([], { coverage: "partial", sources: [], dropped: 0 }), []);
});

test("renderAnswerHighlight is the answer, then each passage it rested on with its note and page", () => {
  const text = ac.renderAnswerHighlight("Kinetics is the study of forces that cause motion.", [
    { noteTitle: "Kinetics", page: 2, text: "Links kinetics (forces) to kinematics (motion) as cause and effect." },
    { noteTitle: "Linear Kinematics", page: null, text: "Kinematic analysis captures a realistic representation of the body." },
  ]);
  assert.equal(
    text,
    [
      "Kinetics is the study of forces that cause motion.",
      "",
      "Sources:",
      "Kinetics, p.2: Links kinetics (forces) to kinematics (motion) as cause and effect.",
      "Linear Kinematics: Kinematic analysis captures a realistic representation of the body.",
    ].join("\n"),
  );
  assert.equal(ac.renderAnswerHighlight("Just the answer.", []), "Just the answer.");
});

test("renderAnswerInstruction names the question and what each source contributed, and tells the writer to ground cards in the passages", () => {
  const s = ac.renderAnswerInstruction("What is linear impulse?", [
    { noteTitle: "Kinetics", why: "gives the definition" },
    { noteTitle: "TBCM", why: "" },
  ]);
  assert.ok(s.startsWith("The reader asked their notes this question"));
  assert.ok(s.includes("Question: What is linear impulse?"));
  assert.ok(s.includes("Kinetics: gives the definition"));
  assert.ok(!s.includes("TBCM:"), "a source with nothing said about it is not listed");
  assert.ok(/grounded in the passages/i.test(s));
});

// ---- the sentence check's mark on the grounding line (src/answerClaims.ts)

test("renderGroundingLine appends the unmatched sentence count when the check ran and found some", () => {
  const base = { coverage: "full", sources: [], dropped: 0, fromGeneralKnowledge: false };
  assert.equal(
    ac.renderGroundingLine({ ...base, claims: { total: 5, unmatched: ["One.", "Two."] } }),
    "Answered from your notes · 2 of 5 sentences matched no passage",
  );
  // Singular when the answer was a single sentence.
  assert.equal(
    ac.renderGroundingLine({ ...base, claims: { total: 1, unmatched: ["One."] } }),
    "Answered from your notes · 1 of 1 sentence matched no passage",
  );
  // It sits after the dropped-citation clause, not instead of it.
  assert.equal(
    ac.renderGroundingLine({ ...base, dropped: 1, claims: { total: 3, unmatched: ["One."] } }),
    "Answered from your notes · 1 bad citation dropped · 1 of 3 sentences matched no passage",
  );
});

test("renderGroundingLine says nothing about sentences when every one matched, or when the check did not run", () => {
  const base = { coverage: "partial", sources: [], dropped: 0, fromGeneralKnowledge: false };
  assert.equal(ac.renderGroundingLine({ ...base, claims: { total: 4, unmatched: [] } }), "Partly answered from your notes");
  assert.equal(ac.renderGroundingLine(base), "Partly answered from your notes");
});

test("renderUnmatchedClaims hands the panel the sentences to list, and nothing when there are none", () => {
  const base = { coverage: "full", sources: [], dropped: 0, fromGeneralKnowledge: false };
  assert.deepEqual(
    ac.renderUnmatchedClaims({ ...base, claims: { total: 3, unmatched: ["Albumin transduces a signal.", "Receptors are enzymes."] } }),
    ["Albumin transduces a signal.", "Receptors are enzymes."],
  );
  assert.deepEqual(ac.renderUnmatchedClaims({ ...base, claims: { total: 3, unmatched: [] } }), []);
  assert.deepEqual(ac.renderUnmatchedClaims(base), []);
});
