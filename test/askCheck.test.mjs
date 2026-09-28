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

test("an empty general-knowledge draft is not flagged: there is nothing to put a banner over", () => {
  const draft = { coverage: "none", from_general_knowledge: true, answer: "   ", used: [] };
  const { answer, report } = ac.checkAnswer(draft, EVIDENCE);
  assert.equal(report.fromGeneralKnowledge, false);
  assert.equal(report.canned, true);
  assert.match(answer, /empty answer/);
  // With general knowledge off it is still the empty-answer notice, not the refusal.
  const off = ac.checkAnswer(draft, EVIDENCE, { allowGeneralKnowledge: false });
  assert.equal(off.report.fromGeneralKnowledge, false);
  assert.match(off.answer, /empty answer/);
});

// ---- the sources an answer rested on, shared by the rows and the inbox button ----

test("pickSources returns the cited units in citation order, with the model's reason", () => {
  const ev = ["u1", "u2", "u3"];
  const report = { coverage: "full", sources: [{ n: 3, why: "defines it" }, { n: 1, why: "" }], dropped: 0 };
  assert.deepEqual(ac.pickSources(ev, report), [{ unit: "u3", why: "defines it" }, { unit: "u1", why: "" }]);
});

test("pickSources stands in the best-ranked unit when nothing was cited, but not for a none answer or when every citation was dropped", () => {
  const ev = ["u1", "u2"];
  assert.deepEqual(ac.pickSources(ev, { coverage: "partial", sources: [], dropped: 0 }), [{ unit: "u1", why: "top match, not cited" }]);
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
  // Singular when the answer was a single sentence (which, unmatched, is every sentence).
  assert.equal(
    ac.renderGroundingLine({ ...base, claims: { total: 1, unmatched: ["One."] } }),
    "Answered, but no sentence matched your notes · 1 of 1 sentence matched no passage",
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

// ---- general knowledge off (A1), canned text, filtered out (A2) ----

const GK_DRAFT = { coverage: "none", from_general_knowledge: true, answer: "In general, first-pass metabolism is…", used: [] };

test("checkAnswer with general knowledge off turns a general-knowledge draft into the canned refusal", () => {
  const { answer, report } = ac.checkAnswer(GK_DRAFT, EVIDENCE, { allowGeneralKnowledge: false });
  assert.equal(answer, ac.generalKnowledgeRefusal());
  assert.match(answer, /general knowledge is off in settings/);
  assert.deepEqual(report, { coverage: "none", sources: [], dropped: 0, fromGeneralKnowledge: false, canned: true });
});

test("checkAnswer with general knowledge off leaves a cited answer alone, flag or not", () => {
  const draft = { coverage: "full", from_general_knowledge: true, answer: "An answer.", used: [{ n: 1, why: "defines it" }] };
  const { answer, report } = ac.checkAnswer(draft, EVIDENCE, { allowGeneralKnowledge: false });
  assert.equal(answer, "An answer.");
  assert.equal(report.fromGeneralKnowledge, false);
  assert.equal(report.canned, undefined);
});

test("checkAnswer keeps a general-knowledge answer when the option is on or absent", () => {
  for (const opts of [undefined, {}, { allowGeneralKnowledge: true }]) {
    const { answer, report } = ac.checkAnswer(GK_DRAFT, EVIDENCE, opts);
    assert.equal(answer, GK_DRAFT.answer);
    assert.deepEqual(report, { coverage: "none", sources: [], dropped: 0, fromGeneralKnowledge: true });
  }
});

test("checkAnswer marks the empty-answer fallback as canned", () => {
  const { report } = ac.checkAnswer({ coverage: "full", from_general_knowledge: false, answer: "", used: [] }, EVIDENCE);
  assert.equal(report.canned, true);
});

test("noEvidenceAnswer and emptyIndexAnswer are canned", () => {
  assert.equal(ac.noEvidenceAnswer("q").report.canned, true);
  assert.equal(ac.emptyIndexAnswer("wiki/").report.canned, true);
});

test("filteredOutAnswer says how many passages shared words and that none answered", () => {
  const { answer, report } = ac.filteredOutAnswer(14, " half-life ");
  assert.equal(answer, "14 passages share words with “half-life”, but none of them answers it. Try other words, or digest the lecture that covers it.");
  assert.deepEqual(report, { coverage: "none", sources: [], dropped: 0, fromGeneralKnowledge: false, canned: true });
  assert.match(ac.filteredOutAnswer(1, "q").answer, /^1 passage shares words with “q”, but it doesn't answer it\./);
});

// ---- sendability (B2) ----

test("canSendAnswer: the model's own answer from the notes or general knowledge, never a canned or empty one", () => {
  const r = (over) => ({ coverage: "full", sources: [], dropped: 0, fromGeneralKnowledge: false, ...over });
  const rows = [
    ["full with sources", r({ sources: [{ n: 1, why: "" }] }), "An answer.", true],
    ["partial", r({ coverage: "partial" }), "An answer.", true],
    ["general knowledge", r({ coverage: "none", fromGeneralKnowledge: true }), "An answer.", true],
    ["model says none", r({ coverage: "none" }), "Your notes do not cover this.", false],
    ["canned refusal", ac.checkAnswer(GK_DRAFT, EVIDENCE, { allowGeneralKnowledge: false }).report, ac.generalKnowledgeRefusal(), false],
    ["canned no-evidence", ac.noEvidenceAnswer("q").report, "x", false],
    ["empty", r({}), "   ", false],
  ];
  for (const [name, report, answer, want] of rows) assert.equal(ac.canSendAnswer(report, answer), want, name);
});

// ---- pickSources for none and general knowledge (B2, B11) ----

test("pickSources returns nothing for a none answer even when it cited a passage", () => {
  const ev = ["u1", "u2"];
  assert.deepEqual(ac.pickSources(ev, { coverage: "none", sources: [{ n: 1, why: "x" }], dropped: 0, fromGeneralKnowledge: false }), []);
});

test("pickSources returns nothing for a general-knowledge answer, whatever its coverage", () => {
  const ev = ["u1", "u2"];
  assert.deepEqual(ac.pickSources(ev, { coverage: "partial", sources: [], dropped: 0, fromGeneralKnowledge: true }), []);
  assert.deepEqual(ac.pickSources(ev, { coverage: "full", sources: [{ n: 2, why: "x" }], dropped: 0, fromGeneralKnowledge: true }), []);
});

test("pickSources labels the stand-in as an uncited top match", () => {
  assert.deepEqual(ac.pickSources(["u1", "u2"], { coverage: "full", sources: [], dropped: 0, fromGeneralKnowledge: false }), [{ unit: "u1", why: "top match, not cited" }]);
});

// ---- the grounding line and route (A13) ----

test("renderGroundingLine for general knowledge is the one phrase, nothing appended", () => {
  const report = { coverage: "none", sources: [], dropped: 2, fromGeneralKnowledge: true, claims: { total: 3, unmatched: ["a", "b", "c"] } };
  assert.equal(ac.renderGroundingLine(report), "General knowledge, not your notes");
});

test("renderGroundingLine says no sentence matched when every checked sentence is unmatched", () => {
  const claims = { total: 3, unmatched: ["a", "b", "c"] };
  assert.equal(
    ac.renderGroundingLine({ coverage: "full", sources: [], dropped: 0, fromGeneralKnowledge: false, claims }),
    "Answered, but no sentence matched your notes · 3 of 3 sentences matched no passage",
  );
  assert.match(ac.renderGroundingLine({ coverage: "partial", sources: [], dropped: 0, fromGeneralKnowledge: false, claims }), /^Answered, but no sentence matched your notes/);
  // Some matched: the model's coverage stands.
  assert.match(ac.renderGroundingLine({ coverage: "full", sources: [], dropped: 0, fromGeneralKnowledge: false, claims: { total: 3, unmatched: ["a"] } }), /^Answered from your notes/);
  // Nothing checked: no claim about sentences at all.
  assert.equal(ac.renderGroundingLine({ coverage: "full", sources: [], dropped: 0, fromGeneralKnowledge: false, claims: { total: 0, unmatched: [] } }), "Answered from your notes");
  // A none answer stays "Not in your notes".
  assert.match(ac.renderGroundingLine({ coverage: "none", sources: [], dropped: 0, fromGeneralKnowledge: false, claims }), /^Not in your notes/);
});

test("routeForReport hides the route for general-knowledge and canned reports", () => {
  const base = { coverage: "full", sources: [], dropped: 0, fromGeneralKnowledge: false };
  assert.equal(ac.routeForReport(base, "30 → 6 kept"), "30 → 6 kept");
  assert.equal(ac.routeForReport({ ...base, coverage: "none", fromGeneralKnowledge: true }, "general knowledge"), "");
  assert.equal(ac.routeForReport(ac.noEvidenceAnswer("q").report, "0 found"), "");
});
