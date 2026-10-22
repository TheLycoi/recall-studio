import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let api, dir, out;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "sr-flashcard-notes-"));
  out = join(dir, "sr.mjs");
  await build({ entryPoints: ["src/srRecognition.ts"], bundle: true, platform: "node", format: "esm", outfile: out });
  api = await import(pathToFileURL(out).href);
});
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

const configured = { srRecognitionEnabled: true, srRecognitionTags: "#flashcards" };
const kinds = (raw, s = configured) => api.recognizeSrCards(raw, "note.md", s);
const texts = (raw, s = configured) => kinds(raw, s).map(c => c.text);

// Bullets are how outline notes are actually written. A card inside a list item
// must be recognized with the marker stripped from its text.

test("single-line cards inside bullet and numbered list items are recognized", () => {
  assert.deepEqual(texts("#flashcards\n\n- What is OCD?::A disorder\n"), ["What is OCD?::A disorder"]);
  assert.deepEqual(texts("#flashcards\n\n1. What is OCD?::A disorder\n"), ["What is OCD?::A disorder"]);
  assert.deepEqual(texts("#flashcards\n\n* OCD:::A disorder\n"), ["OCD:::A disorder"]);
});

test("nested list items are recognized regardless of indentation", () => {
  const raw = "#flashcards\n\n- Topic\n    - What is OCD?::A disorder\n        - Nested::Deep answer\n";
  assert.deepEqual(texts(raw), ["What is OCD?::A disorder", "Nested::Deep answer"]);
});

test("list card offsets point at the content, not the marker", () => {
  const raw = "#flashcards\n\n- What is OCD?::A disorder\n";
  const [card] = kinds(raw);
  assert.equal(raw.slice(card.start, card.end), "What is OCD?::A disorder");
  assert.equal(card.start, raw.indexOf("What"));
});

test("multiline cards work when the separator is its own list item", () => {
  const raw = "#flashcards\n\n- What is OCD?\n- ?\n- A disorder\n";
  const cards = kinds(raw);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, "multiline-basic");
});

test("curly-brace and highlight clozes are on by default", () => {
  assert.deepEqual(kinds("#flashcards\n\nOCD is {{repetitive}}.\n").map(c => c.kind), ["cloze"]);
  assert.deepEqual(kinds("#flashcards\n\nOCD is ==repetitive==.\n").map(c => c.kind), ["cloze"]);
});

test("bold clozes are opt-in because bold is ordinary emphasis in study notes", () => {
  const bold = "#flashcards\n\nOCD is **repetitive**.\n";
  assert.deepEqual(kinds(bold), []);
  assert.deepEqual(kinds(bold, { ...configured, srBoldCloze: true }).map(c => c.kind), ["cloze"]);
});

test("fenced code inside lists stays excluded even though list items are now scanned", () => {
  for (const block of ["- ```md\n  hidden::answer\n  ```", "- Example:\n  ```\n  hidden::answer\n  ```"]) {
    const raw = `#flashcards\n\n${block}\n\nReal::Answer\n`;
    assert.deepEqual(texts(raw), ["Real::Answer"], block);
  }
});

test("blockquote cards remain excluded so quoted prose is never mistaken for a card", () => {
  const raw = "#flashcards\n\n> Quoted::text\n\nReal::Answer\n";
  assert.deepEqual(texts(raw), ["Real::Answer"]);
});

test("a subdeck tag names the deck for the note and plain tags name none", () => {
  assert.equal(api.srDeckForNote("#flashcards/Neurology\n\nQ::A\n", "note.md", configured), "Neurology");
  assert.equal(api.srDeckForNote("#flashcards\n\nQ::A\n", "note.md", configured), null);
  assert.equal(api.srDeckForNote("Q::A\n", "note.md", configured), null);
  assert.equal(api.srDeckForNote("#flashcards/a/b\n\nQ::A\n", "note.md", configured), "a/b");
});

test("subdeck lookup ignores tags in frontmatter, comments and code fences", () => {
  assert.equal(api.srDeckForNote("---\ntags: [#flashcards/Bio]\n---\n\nQ::A\n", "note.md", configured), null);
  assert.equal(api.srDeckForNote("<!-- #flashcards/Bio -->\n\nQ::A\n", "note.md", configured), null);
  assert.equal(api.srDeckForNote("```\n#flashcards/Bio\n```\n\nQ::A\n", "note.md", configured), null);
});

test("cards outside a tagged or explicitly listed note are still ignored", () => {
  assert.deepEqual(texts("Q::A\n", { srRecognitionEnabled: true, srRecognitionTags: "#flashcards" }), []);
  assert.deepEqual(texts("Q::A\n", { srRecognitionEnabled: false, srRecognitionTags: "#flashcards" }), []);
});
