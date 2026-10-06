// Run with: npm test
//
// The example cards inside WRITER_SYSTEM are the strongest signal the card
// writer gets, stronger than any rule paragraph. An example the deterministic
// linter would badge therefore teaches the model to write cards the pipeline
// then flags — which is what had happened: two "why" cards sharing an answer
// (shared-answer) and a critique example keeping a thirteen-word answer
// (qa-answer-long). This test reads src/llm.ts as text, pulls every
// <example> out of the writer prompt, and runs each card through lintCard
// with its siblings, expecting no failures and no warnings.
//
// llm.ts is read as text rather than imported because it pulls in the Codex
// backend, which spawns a child process; lint.ts is bundled standalone the
// same way test/lint.test.mjs does it.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let l;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wikilm-test-"));
  const out = path.join(dir, "lint.mjs");
  await build({ entryPoints: ["src/lint.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  l = await import(pathToFileURL(out).href);
});

const source = readFileSync("src/llm.ts", "utf8");

/** The body of a template-literal system prompt, up to its first unescaped closing backtick. */
function promptBody(name) {
  const m = source.match(new RegExp(`const ${name} = \`([\\s\\S]*?)(?<!\\\\)\`;`));
  assert.ok(m, `${name} not found in src/llm.ts`);
  return m[1];
}

/** Every <example> in a prompt as { highlight, cards[] }, cards parsed from "kind | ..." lines. */
function examples(prompt) {
  const out = [];
  for (const [, block] of prompt.matchAll(/<example>([\s\S]*?)<\/example>/g)) {
    const highlight = block.match(/<highlight>([\s\S]*?)<\/highlight>/)?.[1] ?? "";
    const cardsText = block.match(/<cards>([\s\S]*?)<\/cards>/)?.[1] ?? "";
    const cards = cardsText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^(qa|cloze) \|/.test(line))
      .map((line, i) => {
        const parts = line.split(" | ").map((p) => p.trim());
        const kind = parts[0];
        return {
          id: `c${i}`,
          highlightId: "h1",
          kind,
          front: kind === "qa" ? parts[1] : "",
          back: kind === "qa" ? parts[2] : "",
          text: kind === "cloze" ? parts[1] : "",
          extra: "",
          status: "pending",
          edited: false,
          createdAt: "2026-01-01T00:00:00.000Z",
        };
      });
    out.push({ highlight, cards });
  }
  return out;
}

function highlightFor(text) {
  return {
    id: "h1",
    sourcePath: "note.md",
    sourceTitle: "Example",
    text,
    before: "",
    after: "",
    line: 0,
    page: null,
    heading: null,
    blockId: null,
    title: "",
    instruction: "",
    status: "ready",
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    generatedAt: null,
    exportedAt: null,
    cards: [],
    origin: "selection",
  };
}

test("the writer prompt has examples to check", () => {
  const ex = examples(promptBody("WRITER_SYSTEM"));
  assert.ok(ex.length >= 5, `only ${ex.length} examples parsed`);
  // A parser that silently matched nothing would pass the lint test
  // vacuously, so pin a floor on what it finds: every example but the
  // framing-only one has cards, and the total is roughly what is written.
  const empty = ex.filter((e) => e.cards.length === 0);
  assert.equal(empty.length, 1, "exactly one example (framing with no fact) should parse as zero cards");
  const total = ex.reduce((n, e) => n + e.cards.length, 0);
  assert.ok(total >= 10, `only ${total} cards parsed across all examples; the card-line parser may be broken`);
});

test("every example card in the writer prompt passes the linter with no failures and no warnings", () => {
  for (const { highlight, cards } of examples(promptBody("WRITER_SYSTEM"))) {
    const h = highlightFor(highlight);
    for (const card of cards) {
      const siblings = cards.filter((c) => c !== card);
      const { failures, warnings } = l.lintCard(card, h, siblings);
      const label = card.kind === "qa" ? `${card.front} -> ${card.back}` : card.text;
      assert.deepEqual(failures, [], `failures [${failures}] on example card: ${label}`);
      assert.deepEqual(warnings, [], `warnings [${warnings}] on example card: ${label}`);
    }
  }
});

test("the writer prompt's cloze examples use the density the prompt asks for", () => {
  // The rule says a sentence stating several short facts hides each under its
  // own number. If every cloze example went back to a single c1, the examples
  // would be teaching the opposite of the paragraph above them.
  const clozes = examples(promptBody("WRITER_SYSTEM"))
    .flatMap((e) => e.cards)
    .filter((c) => c.kind === "cloze");
  const multi = clozes.filter((c) => new Set([...c.text.matchAll(/\{\{c(\d+)::/g)].map((m) => m[1])).size >= 2);
  assert.ok(multi.length >= 3, `expected at least three multi-number cloze examples, found ${multi.length}`);
});

/** The critique example whose highlight contains `needle`, taken from the prompt so the test cannot drift from it. */
function criticExample(needle) {
  const ex = examples(promptBody("CRITIC_SYSTEM")).find((e) => e.highlight.includes(needle));
  assert.ok(ex, `no critique example with a highlight containing "${needle}"`);
  return ex;
}

test("the critique example's revision is a card the linter accepts", () => {
  // The critique prompt's second example revises a two-clause qa answer into a
  // two-number cloze. The revision is prose inside a verdict, so its text is
  // pinned by hand here rather than parsed: if lint.ts ever tightens the
  // framing or length rules, this is the line that says the example needs
  // rewriting too. The highlight is read from the prompt.
  const h = highlightFor(criticExample("Deliberate practice").highlight);
  const card = {
    id: "c1",
    highlightId: "h1",
    kind: "cloze",
    front: "",
    back: "",
    text: "Deliberate practice differs from ordinary repetition in that it targets a weakness {{c1::just past current ability}} and requires {{c2::immediate feedback}}.",
    extra: "",
    status: "pending",
    edited: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  assert.ok(promptBody("CRITIC_SYSTEM").includes(card.text), "the critique prompt no longer contains this revision; update the test or the prompt");
  const { failures, warnings } = l.lintCard(card, h, []);
  assert.deepEqual(failures, []);
  assert.deepEqual(warnings, []);
  // Stay clear of the six-word framing ceiling: an example sitting on it is
  // the wording most likely to push the model over it.
  for (const [, body] of card.text.matchAll(/\{\{c\d+::([^}]*)\}\}/g)) {
    assert.ok(body.trim().split(/\s+/).length <= 4, `deletion "${body}" is at or near the linter's six-word ceiling`);
  }
});

test("the qa answer the critique example replaces really does fail the linter", () => {
  // Guards the reason given in the example: thirteen words is over the
  // twelve-word answer limit, so "keep" would have contradicted the pipeline.
  const h = highlightFor(criticExample("Deliberate practice").highlight);
  const card = {
    id: "c1",
    highlightId: "h1",
    kind: "qa",
    front: "What two things distinguish deliberate practice from ordinary repetition?",
    back: "it targets a weakness just past current ability, and it requires immediate feedback",
    text: "",
    extra: "",
    status: "pending",
    edited: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  assert.ok(l.lintCard(card, h, []).failures.includes("qa-answer-long"));
});
