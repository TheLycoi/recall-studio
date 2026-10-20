import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
let api, dir;
before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sr-recognition-"));
  const out = path.join(dir, "sr.mjs");
  await build({ entryPoints: ["src/srRecognition.ts"], bundle: true, platform: "node", format: "esm", outfile: out });
  api = await import(pathToFileURL(out).href);
});
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
const configured = { srRecognitionEnabled: true, srRecognitionTags: "#cards" };
test("custom inline separators use longest-first precedence before clozes and preserve CRLF ranges", () => {
  const s = { ...configured, srRecognitionNotePaths: "notes/a.md", srSingleLineSeparator: "->", srSingleLineReversedSeparator: "<->" };
  const raw = "nearby prose\r\n\r\nFront <-> ==Back==\r\nOther -> Answer\r\n\r\nnearby prose";
  const cards = api.recognizeSrCards(raw, "notes/a.md", s);
  assert.deepEqual(cards.map(c => c.kind), ["reversed", "basic"]);
  assert.deepEqual(cards.map(c => raw.slice(c.start, c.end)), ["Front <-> ==Back==", "Other -> Answer"]);
  assert.deepEqual(cards.map(c => c.line), [3, 4]);
  assert.equal(api.recognizeSrCards(raw, "other.md", s).length, 0);
  assert.equal(api.recognizeSrCards("Q:::A", "a.md", { ...configured, srRecognitionNotePaths: "a.md" })[0].kind, "reversed");
});
test("exclusions cannot supply card syntax or tag scope, and inline code markers stay inert", () => {
  const raw = "---\nlabel: bad::card\n---\n#cards\n\n```md\nbad::card\n```\n\n  ~~~\nbad::card\n  ~~~\n\n<!-- hidden::card -->\n%% hidden::card %%\n\n`bad::card`\n`#cards`\n\nQ::A";
  const cards = api.recognizeSrCards(raw, "a.md", configured);
  assert.deepEqual(cards.map(c => c.text), ["Q::A"]);
  for (const tag of ["<!-- #cards -->", "%%\n#cards\n%%", "```\n#cards\n```", "`#cards`", "#cardsExtra", "---\ntags: [cards]\n---"]) {
    assert.deepEqual(api.recognizeSrCards(`${tag}\n\nQ::A`, "a.md", configured), [], tag);
  }
  assert.equal(api.recognizeSrCards("#cards/biology\n\nQ::A", "a.md", configured).length, 1);
  assert.deepEqual(api.recognizeSrCards("#cards\n\n<!--\nbad::card\n", "a.md", configured), []);
});
test("multiline and plain highlight cloze paragraphs use blank/end boundaries without adjacent prose", () => {
  const raw = "#cards\n\nNearby prose\n\nFront\n?\nBack\n<!--SR:!2026-10-20,1,250-->\n\nReverse\n??\nAnswer\n\nThe ==answer== is here.\nContinuation\n\nNearby prose";
  const saved = Buffer.from(raw);
  const cards = api.recognizeSrCards(raw, "a.md", configured);
  assert.deepEqual(cards.map(c => c.kind), ["multiline-basic", "multiline-reversed", "cloze"]);
  assert.deepEqual(cards.map(c => raw.slice(c.start, c.end)), ["Front\n?\nBack", "Reverse\n??\nAnswer", "The ==answer== is here.\nContinuation"]);
  assert.deepEqual(Buffer.from(raw), saved);
  const custom = { ...configured, srMultilineSeparator: "ANSWER", srMultilineReversedSeparator: "BOTH", srMultilineEndMarker: "END" };
  assert.deepEqual(api.recognizeSrCards("#cards\n\nFront\nANSWER\nBack\n\nmore back\nEND\nProse", "a.md", custom).map(c => c.text), ["Front\nANSWER\nBack\n\nmore back"]);
  assert.equal(api.recognizeSrCards("#cards\n\nThe ==answer==", "a.md", { ...configured, srHighlightCloze: false }).length, 0);
});
test("unsupported clozes, empty sides, and mixed excluded multiline blocks fail closed", () => {
  for (const body of ["::empty front", "empty back::", "?\nempty front", "Front\n?", "==1;;answer==", "==answer;;hint==", "{{answer}}", "**answer**", "`==answer==`", "Front\n?\n```\nBack\n```", "Front\n?\n<!-- hidden -->\nBack", "Front\n?\nBack <!--SR:!2026-10-20,1,250-->\nMore"]) {
    assert.deepEqual(api.recognizeSrCards(`#cards\n\n${body}`, "a.md", configured), [], body);
  }
  assert.deepEqual(api.recognizeSrCards("#cards\n\nQ::A", "a.md", { ...configured, srRecognitionTags: null }), []);
});
test("multi-backtick code spans and multiline scheduling comments never become cards or scope", () => {
  for (const body of ["``bad::card``", "``bad ==answer==``", "<!--SR:\nbad::card\n-->"]) {
    assert.deepEqual(api.recognizeSrCards(`#cards\n\n${body}`, "a.md", configured), [], body);
  }
});
test("supported fixtures match question kinds/text proven with pinned upstream parser and expansion", () => {
  // Upstream 3d5079f3bcd54531b084040d1c0178f15f681510 src/parser.ts and
  // CardFrontBackUtil.expand were exercised separately with clozecraft 0.4.0.
  // Keep only synthetic expected fixtures here, never the upstream runtime.
  for (const [raw, kinds] of [
    ["Q::A", ["basic"]], ["Q:::A", ["reversed"]],
    ["Front\n?\nBack", ["multiline-basic"]],
    ["Front\n??\nBack", ["multiline-reversed"]],
    ["The ==answer== is here.", ["cloze"]],
    ["Q:::==A==", ["reversed"]],
    ["Front\n?\nQ::A", ["basic"]],
    ["Q::A\n\nQ:::A\n\nFront\n?\nBack\n\nThe ==answer==.", ["basic", "reversed", "multiline-basic", "cloze"]],
  ]) {
    assert.deepEqual(api.recognizeSrCards(raw, "a.md", { srRecognitionEnabled: true, srRecognitionNotePaths: "a.md" }).map(c => c.kind), kinds, raw);
  }
});
test("reopened HTML and Obsidian comments cannot expose hidden cards or body-tag scope", () => {
  for (const comment of ["<!--one--> <!--\nbad::card\n-->", "%%one%% %%\nbad::card\n%%", "<!--SR:!2026-10-20,1,250--> <!--\nbad::card\n-->", "<!--\nclosed--> <!--\nbad::card\n-->"]) {
    assert.deepEqual(api.recognizeSrCards(`#cards\n\n${comment}`, "a.md", configured), [], comment);
  }
});
test("SR metadata callouts never expose scheduling fields as inline cards", () => {
  const raw = "#cards\n\nQ::A\n> [!sr|card-metadata]\n> field::value\n> <!--SR:!2026-10-20,1,250-->\n\nOther::Answer";
  assert.deepEqual(api.recognizeSrCards(raw, "a.md", configured).map(c => c.text), ["Q::A", "Other::Answer"]);
});
test("recognition requires opt-in and explicit note or body-tag scope", () => {
  const raw = "#cards\n\nQ::A";
  assert.deepEqual(api.recognizeSrCards(raw, "a.md", {}), []);
  assert.deepEqual(api.recognizeSrCards(raw, "a.md", { srRecognitionEnabled: true }), []);
  assert.deepEqual(api.recognizeSrCards("Q::A", "a.md", configured), []);
  const cards = api.recognizeSrCards(raw, "a.md", configured);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, "basic");
  assert.equal(raw.slice(cards[0].start, cards[0].end), "Q::A");
  assert.equal(cards[0].text, "Q::A");
  assert.deepEqual(api.recognizeSrCards(raw, ".secret/a.md", configured), []);
  assert.deepEqual(api.recognizeSrCards(raw, "a.pdf", configured), []);
});
