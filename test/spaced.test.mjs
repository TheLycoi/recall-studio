// Run with: npm test  (bundles src/spaced.ts, then exercises it with node:test)
//
// The rules these tests pin were read from the Spaced Repetition plugin's own
// source at tag 1.15.4 (src/parser.ts, src/data/settings.ts). Where a test
// asserts a refusal it is because the plugin would otherwise read the card as
// a different card, or as two cards, rather than as a failure.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let s;
const SEP = { basic: "::", reversed: ":::", multiline: "?" };

before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
  const out = path.join(dir, "spaced.mjs");
  await build({ entryPoints: ["src/spaced.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  s = await import(pathToFileURL(out).href);
});

const qa = (front, back) => ({ id: "c1", highlightId: "h1", kind: "qa", front, back, text: "", extra: "", status: "pending", edited: false, createdAt: "2026-01-01T00:00:00.000Z" });
const cloze = (text) => ({ id: "c2", highlightId: "h1", kind: "cloze", front: "", back: "", text, extra: "", status: "pending", edited: false, createdAt: "2026-01-01T00:00:00.000Z" });
const hl = (over = {}) => ({
  id: "h-abc123",
  sourcePath: "sources/lecture-3.md",
  sourceTitle: "Lecture 3",
  text: "The first female prime minister of Australia was Julia Gillard.",
  before: "", after: "", line: 0, page: null, heading: null, blockId: null,
  title: "First female PM", instruction: "", status: "ready", error: null,
  createdAt: "2026-01-01T00:00:00.000Z", generatedAt: null, exportedAt: null,
  cards: [], origin: "selection",
  ...over,
});

const spaced = (over = {}) => ({ folder: "Recall/spaced", tag: "flashcards", deck: "recall", ...SEP, ...over });

// ---- deck tag ----

test("the deck tag is the flashcard tag plus the deck", () => {
  assert.equal(s.deckTag(spaced()), "#flashcards/recall");
});

test("an empty deck writes the bare tag", () => {
  assert.equal(s.deckTag(spaced({ deck: "" })), "#flashcards");
});

test("a leading # on the configured tag is not doubled", () => {
  assert.equal(s.deckTag(spaced({ tag: "#flashcards" })), "#flashcards/recall");
});

test("a deck name is sanitized into one valid tag segment", () => {
  // The plugin resolves a deck from a tag, so a space or a stray # in the
  // name would produce a tag that is never indexed.
  assert.equal(s.deckTag(spaced({ deck: "Q&A / week 3" })), "#flashcards/q-a/week-3");
  assert.equal(s.deckTag(spaced({ tag: "my cards" })), "#my-cards/recall");
});

test("an empty or unusable tag falls back to the plugin default", () => {
  assert.equal(s.deckTag(spaced({ tag: "###" })), "#flashcards/recall");
});

// ---- single-line Q&A ----

test("a plain Q&A card is one line: front, separator, back", () => {
  assert.deepEqual(s.serializeCard(qa("Who wrote Middlemarch?", "George Eliot"), SEP), {
    ok: true,
    text: "Who wrote Middlemarch?::George Eliot",
  });
});

test("a ? inside the question does not make it a multi-line card", () => {
  // Only a line that is exactly the multi-line separator splits a card, so a
  // question mark in the middle is harmless.
  const r = s.serializeCard(qa("Why is the sky blue? Give the reason.", "Rayleigh scattering"), SEP);
  assert.equal(r.ok && r.text.includes("\n"), false);
});

test("a newline inside a card becomes a break, never a line", () => {
  // A raw newline would end the card, or start a second one.
  const r = s.serializeCard(qa("Name the two\nparts", "A and B"), SEP);
  assert.equal(r.ok, true);
  assert.equal(r.text, "Name the two<br>parts::A and B");
});

// ---- separators inside card text ----

test("a separator in the question falls back to the two-line form, fenced", () => {
  const r = s.serializeCard(qa("What does the :: operator do?", "Reads a key"), SEP);
  assert.equal(r.ok, true);
  assert.equal(r.text, "What does the `::` operator do?\n?\nReads a key");
});

test("a separator in the answer falls back too, so it cannot start a second card", () => {
  const r = s.serializeCard(qa("Which operator reads a key?", "The :: operator"), SEP);
  assert.equal(r.ok, true);
  assert.equal(r.text, "Which operator reads a key?\n?\nThe `::` operator");
});

test("the reversed separator is fenced longest-first, so ::: is not read as ::", () => {
  const r = s.serializeCard(qa("What is ::: for?", "A reversed card"), SEP);
  assert.equal(r.ok, true);
  // A bare `:::` on the line would make the plugin build a reversed card out
  // of a question that is not one.
  assert.equal(r.text.includes("`:::`"), true);
  assert.equal(r.text.includes(" `::` "), false);
});

test("a question that is only the multi-line separator is refused", () => {
  // Refused only when the card needs the multi-line form anyway: a lone `?`
  // line would otherwise be read as the card separator.
  const r = s.serializeCard(qa("?", "The :: operator"), SEP);
  assert.equal(r.ok, false);
});

test("a lone ? in a card that stays on one line is harmless", () => {
  // The plugin tests for an inline separator before anything else, so this is
  // one Q&A card whose question is "?".
  const r = s.serializeCard(qa("?", "Answer"), SEP);
  assert.deepEqual(r, { ok: true, text: "?::Answer" });
});

test("a question containing == is refused rather than written wrong", () => {
  // The plugin tests for a cloze pattern before it looks for the separator, so
  // this would arrive as a cloze card rather than a Q&A card.
  const r = s.serializeCard(qa("Fill in ==this==", "x"), SEP);
  assert.equal(r.ok, false);
  assert.match(r.reason, /==/);
});

test("an empty question or answer is refused", () => {
  assert.equal(s.serializeCard(qa("", "Answer"), SEP).ok, false);
  assert.equal(s.serializeCard(qa("Question", "  "), SEP).ok, false);
});

// ---- cloze cards ----

test("a cloze card converts {{c1::…}} to the plugin's ==…== form", () => {
  const r = s.serializeCard(cloze("The first female prime minister was {{c1::Julia Gillard}}."), SEP);
  assert.equal(r.ok, true);
  assert.equal(r.text, "The first female prime minister was ==Julia Gillard==.");
});

test("a cloze hint becomes the plugin's footnote form", () => {
  const r = s.serializeCard(cloze("Brazilians speak {{c1::Portuguese::language}}"), SEP);
  assert.equal(r.ok, true);
  assert.equal(r.text, "Brazilians speak ==Portuguese==^[language]");
});

test("every marker in a multi-deletion cloze is converted", () => {
  const r = s.serializeCard(cloze("The {{c1::first}} and the {{c2::second}}"), SEP);
  assert.equal(r.ok, true);
  assert.equal(r.text, "The ==first== and the ==second==");
});

test("a stray == already in the cloze text is refused, not doubled", () => {
  const r = s.serializeCard(cloze("The first ==female== prime minister was {{c1::Julia Gillard}}"), SEP);
  assert.equal(r.ok, false);
  assert.match(r.reason, /==/);
});

test("a cloze card with no marker is refused", () => {
  const r = s.serializeCard(cloze("Just a sentence."), SEP);
  assert.equal(r.ok, false);
});

test("an empty deletion is refused", () => {
  const r = s.serializeCard(cloze("The answer is {{c1::}}"), SEP);
  assert.equal(r.ok, false);
});

// ---- the note ----

test("the note carries the deck tag, a heading, and the provenance", () => {
  const body = s.buildNoteBody(hl(), ["Who wrote it?::George Eliot"], spaced());
  assert.match(body, /^---\nrecall-id: h-abc123\nrecall-exported: /);
  assert.equal(body.includes("#flashcards/recall"), true);
  assert.equal(body.includes("## First female PM"), true);
  assert.equal(body.includes("> The first female prime minister of Australia was Julia Gillard."), true);
  assert.equal(body.includes("Source: [[sources/lecture-3]]"), true);
  assert.equal(body.includes("Who wrote it?::George Eliot"), true);
});

test("a quoted ==highlight== cannot be read as a cloze deletion", () => {
  // Recall's own highlights are ==…== spans, so the quote would otherwise
  // become a cloze card the reader never asked for.
  const body = s.buildNoteBody(hl({ text: "the ==key== idea" }), ["Q::A"], spaced());
  const quote = body.split("\n").find((l) => l.startsWith("> "));
  assert.equal(quote.includes("=="), false);
  assert.equal(quote.includes("key"), true);
});

test("a PDF highlight keeps its page and its extension in the provenance", () => {
  // Obsidian resolves a PDF by its full name, so the link keeps `.pdf`.
  const body = s.buildNoteBody(hl({ page: 7, sourcePath: "papers/x.pdf" }), ["Q::A"], spaced());
  assert.equal(body.includes("Source: [[papers/x.pdf]] › p. 7"), true);
});

test("an empty note body is not produced when there is nothing to write", () => {
  // buildNoteBody is only called with at least one card, but the joining must
  // not produce a note whose cards section is a run of blank lines.
  const body = s.buildNoteBody(hl(), ["Q::A"], spaced());
  assert.equal(/\n{3,}/.test(body), false);
  assert.equal(body.endsWith("\n"), true);
});

// ---- npaths ----

test("the note path is the folder, a slug of the title, and .md", () => {
  assert.equal(s.notePath({ folder: "Recall/spaced" }, hl()), "Recall/spaced/first-female-pm.md");
});

test("a second send takes a suffixed name rather than the same one", () => {
  // The first note holds the plugin's review history, so it is never reused.
  assert.equal(s.notePath({ folder: "Recall/spaced" }, hl(), 1), "Recall/spaced/first-female-pm-2.md");
  assert.equal(s.notePath({ folder: "Recall/spaced" }, hl(), 2), "Recall/spaced/first-female-pm-3.md");
});

test("a highlight with no title falls back to the source name, then the id", () => {
  assert.equal(s.notePath({ folder: "Recall/spaced" }, hl({ title: "" })), "Recall/spaced/lecture-3.md");
  assert.equal(s.notePath({ folder: "Recall/spaced" }, hl({ title: "", sourceTitle: "!!!" })), "Recall/spaced/h-abc123.md");
});

test("a folder setting with slashes around it is normalized", () => {
  assert.equal(s.notePath({ folder: "/Recall/spaced/" }, hl()), "Recall/spaced/first-female-pm.md");
});

// ---- settings plumbing ----

test("spacedSettings reads the separators from the settings, not from constants", () => {
  const cfg = s.spacedSettings({
    srFolder: "F",
    srTag: "cards",
    srDeck: "d",
    srBasicSeparator: "||",
    srReversedSeparator: "|||",
    srMultilineSeparator: "??",
  });
  assert.equal(s.deckTag(cfg), "#cards/d");
  // A note written against the wrong separator is a card that asks a different
  // question, so the configured value has to be what is escaped against.
  assert.deepEqual(s.serializeCard(qa("A || B?", "C"), cfg), { ok: true, text: "A `||` B?\n??\nC" });
});
