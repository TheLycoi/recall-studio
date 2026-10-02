// Run with: npm test  (bundles src/askCapture.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let ac;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wikilm-test-"));
  const out = path.join(dir, "askCapture.mjs");
  await build({ entryPoints: ["src/askCapture.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  ac = await import(pathToFileURL(out).href);
});

const GK = "This answer came from the model's general knowledge, not the notes; verify it before learning it.";

const pdfUnit = {
  id: "u1",
  notePath: "classes/PHAR/Receptors.md",
  noteTitle: "Receptors",
  pdfBasename: "Lecture 3",
  target: { page: 3, selection: { beginIndex: 1, beginOffset: 0, endIndex: 1, endOffset: 12 } },
  page: 3,
  text: "Receptors bind ligands with high affinity",
  kind: "highlight",
  classCodes: ["PHAR"],
};

const noteUnit = {
  id: "u2",
  notePath: "classes/PHAR/Plasma Proteins.md",
  noteTitle: "Plasma Proteins",
  pdfBasename: null,
  target: null,
  page: null,
  text: "Albumin binds drugs but does not transduce a signal",
  kind: "claim",
  classCodes: ["PHAR"],
};

const noPdf = () => null;

test("buildAskRow: a cited PDF unit makes the PDF page the source and the note the topic", () => {
  const calls = [];
  const row = ac.buildAskRow({
    question: "What do receptors bind?",
    answer: "Receptors bind **ligands**.",
    cited: [{ unit: pdfUnit, why: "defines the term" }],
    generalKnowledge: false,
    resolvePdf: (base, note) => {
      calls.push([base, note]);
      return { path: "PDFs/Lecture 3.pdf" };
    },
  });
  assert.ok(!("reason" in row), JSON.stringify(row));
  assert.deepEqual(calls, [["Lecture 3", "classes/PHAR/Receptors.md"]]);
  assert.equal(row.sourcePath, "PDFs/Lecture 3.pdf");
  assert.equal(row.page, 3);
  assert.equal(row.heading, "page 3");
  assert.equal(row.subpath, "page=3&selection=1,0,1,12");
  assert.equal(row.topicPath, "classes/PHAR/Receptors.md");
  assert.equal(row.line, 0);
  assert.equal(row.title, "What do receptors bind?");
  assert.match(row.text, /^Receptors bind \*\*ligands\*\*\./);
  assert.match(row.text, /Sources:\nReceptors, p\.3: Receptors bind ligands with high affinity/);
  assert.match(row.instruction, /Question: What do receptors bind\?/);
  assert.match(row.instruction, /Receptors: defines the term/);
  assert.ok(!row.instruction.includes(GK));
});

test("buildAskRow: a cited note unit without a PDF makes the note the source, headed by its title", () => {
  const row = ac.buildAskRow({
    question: "Does albumin signal?",
    answer: "No, albumin binds drugs but does not transduce a signal.",
    cited: [{ unit: noteUnit, why: "states it" }],
    generalKnowledge: false,
    resolvePdf: noPdf,
  });
  assert.ok(!("reason" in row), JSON.stringify(row));
  assert.equal(row.sourcePath, "classes/PHAR/Plasma Proteins.md");
  assert.equal(row.page, null);
  assert.equal(row.heading, "Plasma Proteins");
  assert.equal(row.subpath, undefined);
  assert.equal(row.topicPath, undefined);
  assert.equal(row.line, 0);
});

test("buildAskRow: a PDF unit whose file does not resolve falls back to the note", () => {
  const row = ac.buildAskRow({
    question: "What do receptors bind?",
    answer: "Ligands.",
    cited: [{ unit: pdfUnit, why: "" }],
    generalKnowledge: false,
    resolvePdf: noPdf,
  });
  assert.ok(!("reason" in row));
  assert.equal(row.sourcePath, "classes/PHAR/Receptors.md");
  assert.equal(row.page, null);
  assert.equal(row.heading, "Receptors");
  assert.equal(row.subpath, undefined);
  assert.equal(row.topicPath, undefined);
});

test("buildAskRow: a general-knowledge answer links the fallback note and says it is unverified", () => {
  const row = ac.buildAskRow({
    question: "What is the capital of France?",
    answer: "Paris.",
    cited: [],
    generalKnowledge: true,
    fallbackSourcePath: "classes/GEOG/Europe.md",
    resolvePdf: noPdf,
  });
  assert.ok(!("reason" in row), JSON.stringify(row));
  assert.equal(row.sourcePath, "classes/GEOG/Europe.md");
  assert.equal(row.page, null);
  assert.equal(row.heading, "Europe");
  assert.equal(row.subpath, undefined);
  assert.equal(row.topicPath, undefined);
  assert.equal(row.line, 0);
  assert.equal(row.text, "Paris.");
  assert.equal(row.title, "What is the capital of France?");
  assert.ok(row.instruction.startsWith(GK), row.instruction);
  assert.match(row.instruction, /Question: What is the capital of France\?/);
  // No passages exist, so the writer must not be told to follow them.
  assert.ok(!/passages/.test(row.instruction), row.instruction);
});

test("buildAskRow: a general-knowledge answer with no note to link is not carded", () => {
  for (const fallbackSourcePath of [undefined, "", "   "]) {
    const row = ac.buildAskRow({
      question: "What is the capital of France?",
      answer: "Paris.",
      cited: [],
      generalKnowledge: true,
      fallbackSourcePath,
      resolvePdf: noPdf,
    });
    assert.ok("reason" in row, JSON.stringify(row));
    assert.match(row.reason, /no note to link/);
  }
});

test("buildAskRow: an uncited answer that is not general knowledge is not carded", () => {
  const row = ac.buildAskRow({
    question: "q",
    answer: "Something.",
    cited: [],
    generalKnowledge: false,
    fallbackSourcePath: "classes/GEOG/Europe.md",
    resolvePdf: noPdf,
  });
  assert.ok("reason" in row, JSON.stringify(row));
});

test("buildAskRow: an empty answer is not carded, even with sources", () => {
  for (const answer of ["", "   \n ", "[[]]"]) {
    const row = ac.buildAskRow({
      question: "What do receptors bind?",
      answer,
      cited: [{ unit: pdfUnit, why: "defines the term" }],
      generalKnowledge: false,
      resolvePdf: () => ({ path: "PDFs/Lecture 3.pdf" }),
    });
    assert.ok("reason" in row, JSON.stringify(row));
    assert.match(row.reason, /empty/);
  }
});

test("resolveUnitSource: the shared PDF-or-note lookup", () => {
  assert.deepEqual(ac.resolveUnitSource(noteUnit, () => assert.fail("no pdf to resolve")), {
    sourcePath: "classes/PHAR/Plasma Proteins.md",
    page: null,
    heading: "Plasma Proteins",
    subpath: undefined,
    topicPath: undefined,
  });
  assert.deepEqual(ac.resolveUnitSource(pdfUnit, () => ({ path: "PDFs/Lecture 3.pdf" })), {
    sourcePath: "PDFs/Lecture 3.pdf",
    page: 3,
    heading: "page 3",
    subpath: "page=3&selection=1,0,1,12",
    topicPath: "classes/PHAR/Receptors.md",
  });
  // A unit with a pdfBasename but no target is a note unit: the resolver is not asked.
  assert.equal(ac.resolveUnitSource({ ...pdfUnit, target: null }, () => assert.fail("not asked")).sourcePath, "classes/PHAR/Receptors.md");
});
