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
