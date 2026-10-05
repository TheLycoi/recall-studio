// Run with: npm test  (bundles src/pageIndex.ts and src/recall.ts, then exercises them with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let p, r;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
  for (const name of ["pageIndex", "recall"]) {
    await build({ entryPoints: [`src/${name}.ts`], bundle: true, format: "esm", platform: "node", outfile: path.join(dir, `${name}.mjs`), logLevel: "silent" });
  }
  p = await import(pathToFileURL(path.join(dir, "pageIndex.mjs")).href);
  r = await import(pathToFileURL(path.join(dir, "recall.mjs")).href);
});

// The shape Karpathy LLM Wiki writes: frontmatter, an H1, fixed ## sections.
const KARPATHY = `---
type: concept
created: 2026-09-02
tags: [method]
aliases:
  - "Prompt litmus test"
generation_complete: true
---


# Litmus tests for prompts

## Definition
Litmus tests for prompts are two diagnostic heuristics for checking whether a drafted prompt is well formed. They act as fast mental checks a writer can run before finalizing a prompt.

## Key Characteristics
- **False positive test**: Ask how you might produce a correct answer without knowing the intended information.
- **False negative test**: Ask how you might know the intended information but still fail to produce the expected answer.
- Both tests are lightweight thought experiments applied during prompt authoring.

## Related Concepts
- [[concepts/cloze-deletion|Cloze deletion]]
- [[concepts/pleasure-of-learning|Pleasure of learning]]

## Related Entities
- [[entities/piotr-wozniak|Piotr Wozniak]]

## Mentions in Source

- "**False positives:** How might you produce the correct answer without really knowing the information?"
`;

test("a Karpathy page indexes by section with its H1 as the title", () => {
  const units = p.indexPage("wiki/concepts/litmus-tests-for-prompts.md", KARPATHY);
  assert.ok(units.length >= 4);
  assert.ok(units.every((u) => u.noteTitle === "Litmus tests for prompts"));
  assert.ok(units.every((u) => u.kind === "claim" && u.target === null && u.classCodes.length === 0));
  const sections = [...new Set(units.map((u) => u.section))];
  assert.ok(sections.includes("Definition"));
  assert.ok(sections.includes("Key Characteristics"));
});

test("a line that is only a link is not a unit", () => {
  const units = p.indexPage("wiki/concepts/x.md", KARPATHY);
  const sections = new Set(units.map((u) => u.section));
  assert.equal(sections.has("Related Concepts"), false);
  assert.equal(sections.has("Related Entities"), false);
  assert.equal(units.some((u) => u.text === "Cloze deletion"), false);
});

test("a link inside a sentence stays", () => {
  const md = "# T\n\n## Uses\n- [[concepts/cloze-deletion|Cloze deletion]] hides one fact in a sentence the reader completes.\n";
  const units = p.indexPage("wiki/concepts/t.md", md);
  assert.equal(units.length, 1);
  assert.equal(units[0].text, "Cloze deletion hides one fact in a sentence the reader completes.");
});

test("frontmatter is never indexed and the file name is the title when there is no H1", () => {
  const md = "---\ntype: concept\naliases:\n  - \"A long alias that looks like prose\"\n---\n\n## Definition\nA statement long enough to count as a unit.\n";
  const units = p.indexPage("wiki/concepts/no-heading.md", md);
  assert.equal(units.length, 1);
  assert.equal(units[0].noteTitle, "no-heading");
});

test("the quiz builds questions from a Karpathy page, none from link lists", () => {
  const units = p.indexPage("wiki/concepts/litmus-tests-for-prompts.md", KARPATHY);
  const pool = r.resolveRecallPool("all", "", units, null, () => 1, 20);
  const asked = pool.items.map((i) => i.section);
  assert.ok(asked.includes("Definition"));
  assert.ok(asked.includes("Key Characteristics"));
  assert.equal(asked.includes("Related Concepts"), false);
  assert.equal(asked.includes("Related Entities"), false);
});

test("significantTokens drops stopwords and short words", () => {
  assert.deepEqual(p.significantTokens("The receptors of the cell"), ["receptor", "cell"]);
});
