// Run with: npm test  (bundles src/savedAnswer.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let sa;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
  const out = path.join(dir, "savedAnswer.mjs");
  await build({ entryPoints: ["src/savedAnswer.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  sa = await import(pathToFileURL(out).href);
});

const PDF_UNIT = {
  id: "wiki/concepts/Kinetics.md#p3",
  notePath: "wiki/concepts/Kinetics.md",
  noteTitle: "Kinetics",
  pdfBasename: "Lab 4 - Linear Impulse and Momentum 2026",
  target: { page: 1, selection: { beginIndex: 43, beginOffset: 0, endIndex: 48, endOffset: 31 } },
  page: 1,
  text: "Linear Impulse = ΣFΔt = area under force-time curve",
  kind: "claim",
  classCodes: ["HBIO408"],
};

const NOTE_UNIT = {
  id: "wiki/concepts/TBCM.md#p1",
  notePath: "wiki/concepts/TBCM.md",
  noteTitle: "TBCM",
  pdfBasename: null,
  target: null,
  page: null,
  text: "A theoretical point about which an object's mass is equally distributed",
  kind: "claim",
  classCodes: ["HBIO408"],
};

test("a saved answer is a page: frontmatter, the question as its title, the answer, then the sources as PDF++ callouts", () => {
  const md = sa.renderSavedAnswer({
    question: "What is linear impulse?",
    answer: "Linear impulse is the net force over time, the area under the force-time curve.",
    classCode: "HBIO408",
    created: "2026-09-24",
    route: "notes",
    sources: [
      { unit: PDF_UNIT, why: "gives the formula" },
      { unit: NOTE_UNIT, why: "" },
    ],
  });
  assert.equal(
    md,
    [
      "---",
      "type: answer",
      "class: HBIO408",
      "created: 2026-09-24",
      'question: "What is linear impulse?"',
      "route: notes",
      "---",
      "",
      "# What is linear impulse?",
      "",
      "Linear impulse is the net force over time, the area under the force-time curve.",
      "",
      "## Sources",
      "",
      "> [!PDF] [[Lab 4 - Linear Impulse and Momentum 2026.pdf#page=1&selection=43,0,48,31|Lab 4 - Linear Impulse and Momentum 2026, p.1]]",
      "> > Linear Impulse = ΣFΔt = area under force-time curve",
      "> — [[wiki/concepts/Kinetics|Kinetics]]: gives the formula",
      "",
      '- "A theoretical point about which an object\'s mass is equally distributed" — [[wiki/concepts/TBCM|TBCM]]',
      "",
    ].join("\n"),
  );
});

test("the answer text never carries links, even when the model wrote some", () => {
  const md = sa.renderSavedAnswer({
    question: "Q",
    answer: "See [[Kinetics]] and [[Lab 4.pdf#page=1|the lab]] for ΣFΔt.",
    classCode: "",
    created: "2026-09-24",
    sources: [],
  });
  assert.ok(md.includes("\nSee Kinetics and the lab for ΣFΔt.\n"), md);
  assert.ok(!md.includes("class:"), "no class line when the answer has no class");
  assert.ok(!md.includes("## Sources"), "no Sources section when there are none");
});

test("the page path is under answers/ in the topic folder, named from the question and safe for a filename", () => {
  assert.equal(sa.savedAnswerPath("wiki", "What is linear impulse?"), "wiki/answers/What is linear impulse.md");
  assert.equal(sa.savedAnswerPath("wiki/", 'How does "ΣF = ma" relate to impulse: momentum?'), "wiki/answers/How does ΣF = ma relate to impulse momentum.md");
  const long = "a".repeat(200);
  assert.ok(sa.savedAnswerPath("wiki", long).length <= "wiki/answers/".length + 60 + 3);
});
