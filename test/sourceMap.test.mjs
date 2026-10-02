// Run with: npm test  (bundles src/sourceMap.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let sm;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wikilm-test-"));
  const out = path.join(dir, "sourceMap.mjs");
  await build({ entryPoints: ["src/sourceMap.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  sm = await import(pathToFileURL(out).href);
});

const NOTE = `---
title: Retrieval
tags: [rag]
---

Intro paragraph before any heading.

## Chunking

Splitting a document into pieces is the first step.
It continues on a second line.

### Overlap

Overlapping windows keep a sentence whole.

## Evaluation

Recall measures how much was found.
`;

/**
 * The invariant the whole module rests on: every segment's recorded offsets
 * address the ORIGINAL file text, frontmatter included.
 */
test("segment offsets address the original file text", () => {
  const map = sm.buildSourceMap(NOTE);
  assert.ok(map.segments.length > 0);
  for (const s of map.segments) {
    assert.equal(NOTE.slice(s.start, s.end), s.text, `segment at ${s.start} does not round-trip`);
  }
});

test("segment line numbers count from the top of the file, past frontmatter", () => {
  const map = sm.buildSourceMap(NOTE);
  const lines = NOTE.split("\n");
  for (const s of map.segments) {
    assert.equal(lines[s.line - 1], s.text.split("\n")[0], `line ${s.line} is not the segment's first line`);
  }
});

test("buildSourceMap splits on blank lines and headings", () => {
  const map = sm.buildSourceMap(NOTE);
  const texts = map.segments.map((s) => s.text);
  assert.deepEqual(texts, [
    "Intro paragraph before any heading.",
    "Splitting a document into pieces is the first step.\nIt continues on a second line.",
    "Overlapping windows keep a sentence whole.",
    "Recall measures how much was found.",
  ]);
});

test("a heading trail nests and then pops at the next same-level heading", () => {
  const map = sm.buildSourceMap(NOTE);
  const byText = (t) => map.segments.find((s) => s.text.startsWith(t));
  assert.deepEqual(byText("Intro").trail, []);
  assert.deepEqual(byText("Splitting").trail, ["Chunking"]);
  assert.deepEqual(byText("Overlapping").trail, ["Chunking", "Overlap"]);
  // `## Evaluation` replaces both the h2 and the h3 below it.
  assert.deepEqual(byText("Recall measures").trail, ["Evaluation"]);
  assert.equal(byText("Recall measures").heading, "Evaluation");
});

test("a fenced block is one segment even when it contains blank lines", () => {
  const md = "Before.\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter.\n";
  const map = sm.buildSourceMap(md);
  assert.deepEqual(
    map.segments.map((s) => s.text),
    ["Before.", "```js\nconst a = 1;\n\nconst b = 2;\n```", "After."],
  );
  assert.equal(map.segments[1].code, true);
  assert.equal(map.segments[0].code, false);
});

test("an unterminated fence still yields its segment", () => {
  const md = "Before.\n\n```js\nconst a = 1;\n";
  const map = sm.buildSourceMap(md);
  assert.equal(map.segments.length, 2);
  assert.equal(map.segments[1].code, true);
  assert.ok(map.segments[1].text.includes("const a = 1;"));
});

test("a note with no frontmatter has bodyOffset 0 and line 1 for its first segment", () => {
  const map = sm.buildSourceMap("First line.\n\nSecond.\n");
  assert.equal(map.bodyOffset, 0);
  assert.equal(map.segments[0].line, 1);
  assert.equal(map.segments[1].line, 3);
});

test("an empty note yields no segments", () => {
  assert.deepEqual(sm.buildSourceMap("").segments, []);
  assert.deepEqual(sm.buildSourceMap("   \n\n  \n").segments, []);
});

test("locateInSource finds an exact quote at a file offset", () => {
  const map = sm.buildSourceMap(NOTE);
  const hit = sm.locateInSource(map, "Overlapping windows keep a sentence whole.");
  assert.ok(hit);
  assert.equal(NOTE.slice(hit.start, hit.end), "Overlapping windows keep a sentence whole.");
});

test("locateInSource tolerates collapsed whitespace across a line break", () => {
  const map = sm.buildSourceMap(NOTE);
  const hit = sm.locateInSource(map, "the first step. It continues on a second line.");
  assert.ok(hit, "a quote spanning a newline should still locate");
  // The fuzzy match may stop before the quote's closing period, so compare
  // with trailing punctuation trimmed — the span still covers the sentence.
  const got = NOTE.slice(hit.start, hit.end).replace(/\s+/g, " ").replace(/[.\s]+$/, "");
  assert.equal(got, "the first step. It continues on a second line".replace(/[.\s]+$/, ""));
  assert.ok(NOTE.slice(hit.start, hit.end).includes("\n"), "the span really does cross the line break");
});

test("locateInSource refuses a quote that is not in the note", () => {
  const map = sm.buildSourceMap(NOTE);
  assert.equal(sm.locateInSource(map, "Vector databases are indispensable."), null);
  assert.equal(sm.locateInSource(map, ""), null);
});

test("segmentAt returns the containing segment and null between segments", () => {
  const map = sm.buildSourceMap(NOTE);
  const seg = map.segments[1];
  assert.equal(sm.segmentAt(map, seg.start).text, seg.text);
  assert.equal(sm.segmentAt(map, seg.end - 1).text, seg.text);
  // The blank line after a segment belongs to no segment.
  assert.equal(sm.segmentAt(map, seg.end), null);
});

test("anchorQuote carries the heading trail and neighbouring text", () => {
  const map = sm.buildSourceMap(NOTE);
  const a = sm.anchorQuote(map, "Overlapping windows keep a sentence whole.");
  assert.ok(a);
  assert.equal(a.quote, "Overlapping windows keep a sentence whole.");
  assert.deepEqual(a.trail, ["Chunking", "Overlap"]);
  assert.equal(a.heading, "Overlap");
  assert.equal(NOTE.slice(a.start, a.end), a.quote);
  assert.ok(a.before.includes("Overlap"), "before should reach back to the heading");
  assert.ok(a.before.length <= sm.ANCHOR_CONTEXT_CHARS);
  assert.ok(a.after.length <= sm.ANCHOR_CONTEXT_CHARS);
});

test("anchorQuote reports the line the quote sits on", () => {
  const map = sm.buildSourceMap(NOTE);
  const a = sm.anchorQuote(map, "Recall measures how much was found.");
  const lines = NOTE.split("\n");
  assert.equal(lines[a.line - 1], "Recall measures how much was found.");
});

test("anchorQuote returns null for a quote the model invented", () => {
  const map = sm.buildSourceMap(NOTE);
  assert.equal(sm.anchorQuote(map, "Chunking was invented in 1997 by Dr. Fake."), null);
});

test("batchSegments keeps a batch under the budget and never cuts a segment", () => {
  const map = sm.buildSourceMap(NOTE);
  const batches = sm.batchSegments(map.segments, 60);
  assert.ok(batches.length > 1, "a 60-char budget should split this note");
  for (const b of batches) {
    assert.ok(b.length > 0);
    const size = b.reduce((n, s) => n + s.text.length, 0);
    // A single oversized segment is allowed to exceed the budget alone.
    if (b.length > 1) assert.ok(size <= 60, `batch of ${b.length} is ${size} chars`);
  }
  // Every segment appears exactly once, in order.
  assert.deepEqual(batches.flat().map((s) => s.start), map.segments.map((s) => s.start));
});

test("batchSegments gives an oversized segment a batch of its own", () => {
  const map = sm.buildSourceMap(NOTE);
  const batches = sm.batchSegments(map.segments, 10);
  for (const b of batches) assert.equal(b.length, 1);
});

test("renderBatch marks each segment and writes the trail once per change", () => {
  const map = sm.buildSourceMap(NOTE);
  const idx = new Map(map.segments.map((s, i) => [s.start, i + 1]));
  const out = sm.renderBatch(map.segments, (s) => idx.get(s.start));
  assert.ok(out.includes("[s 1]"));
  assert.ok(out.includes("[s 4]"));
  assert.ok(out.includes("## Chunking › Overlap"), "a nested trail is rendered joined");
  // "Chunking" heads two segments but is written once.
  assert.equal(out.split("## Chunking\n").length - 1, 1);
});

// ---- span verification
//
// The markdown half of the "model output is never trusted for anchoring"
// invariant. These mirror test/suggestPlan.test.mjs's verifySpans cases.

const span = (segment, quote, extra = {}) => ({
  segment,
  quote,
  label: "a label",
  note_title: "Chunking",
  note_kind: "concept",
  ...extra,
});

const OPTS = (over = {}) => ({
  perSegment: 3,
  remaining: 10,
  existingKeys: new Set(),
  batch: [1, 2, 3, 4],
  ...over,
});

test("verifyMarkdownSpans keeps a span whose quote is really in the note", () => {
  const map = sm.buildSourceMap(NOTE);
  const r = sm.verifyMarkdownSpans([span(3, "Overlapping windows keep a sentence whole.")], map, "wiki/retrieval.md", OPTS());
  assert.equal(r.spans.length, 1);
  assert.equal(r.spans[0].quote, "Overlapping windows keep a sentence whole.");
  assert.deepEqual(r.spans[0].anchor.trail, ["Chunking", "Overlap"]);
  assert.equal(r.dropped.unlocated, 0);
});

test("verifyMarkdownSpans drops a quote the model invented", () => {
  const map = sm.buildSourceMap(NOTE);
  const r = sm.verifyMarkdownSpans([span(1, "Chunking was invented in 1997 by Dr. Fake.")], map, "n.md", OPTS());
  assert.deepEqual(r.spans, []);
  assert.equal(r.dropped.unlocated, 1);
});

test("verifyMarkdownSpans refuses a segment outside the batch", () => {
  const map = sm.buildSourceMap(NOTE);
  const r = sm.verifyMarkdownSpans(
    [span(99, "Overlapping windows keep a sentence whole.")],
    map,
    "n.md",
    OPTS({ batch: [1, 2] }),
  );
  assert.deepEqual(r.spans, []);
  assert.equal(r.dropped.outOfBatch, 1);
});

test("verifyMarkdownSpans accepts the `page` field the shared schema uses", () => {
  const map = sm.buildSourceMap(NOTE);
  const r = sm.verifyMarkdownSpans(
    [{ page: 3, quote: "Overlapping windows keep a sentence whole.", label: "l", note_title: "T", note_kind: "concept" }],
    map,
    "n.md",
    OPTS(),
  );
  assert.equal(r.spans.length, 1, "one schema has to serve both the PDF and markdown paths");
});

test("verifyMarkdownSpans drops a duplicate of a key already held", () => {
  const map = sm.buildSourceMap(NOTE);
  const first = sm.verifyMarkdownSpans([span(3, "Overlapping windows keep a sentence whole.")], map, "n.md", OPTS());
  const again = sm.verifyMarkdownSpans(
    [span(3, "Overlapping windows keep a sentence whole.")],
    map,
    "n.md",
    OPTS({ existingKeys: new Set([first.spans[0].key]) }),
  );
  assert.deepEqual(again.spans, []);
  assert.equal(again.dropped.duplicate, 1);
});

test("verifyMarkdownSpans lets the earlier span win an overlap", () => {
  const map = sm.buildSourceMap(NOTE);
  const r = sm.verifyMarkdownSpans(
    [
      span(2, "Splitting a document into pieces is the first step."),
      span(2, "a document into pieces"),
    ],
    map,
    "n.md",
    OPTS(),
  );
  assert.equal(r.spans.length, 1);
  assert.ok(r.spans[0].quote.startsWith("Splitting"), "response order decides the tie");
  assert.equal(r.dropped.duplicate, 1);
});

test("verifyMarkdownSpans honours the per-segment and overall caps", () => {
  const map = sm.buildSourceMap(NOTE);
  const capped = sm.verifyMarkdownSpans(
    [
      span(2, "Splitting a document into pieces is the first step."),
      span(3, "Overlapping windows keep a sentence whole."),
    ],
    map,
    "n.md",
    OPTS({ remaining: 1 }),
  );
  assert.equal(capped.spans.length, 1);
  assert.equal(capped.dropped.overCap, 1);
});

test("a span key identifies the note and the offsets, so two notes never collide", () => {
  const map = sm.buildSourceMap(NOTE);
  const a = sm.verifyMarkdownSpans([span(3, "Overlapping windows keep a sentence whole.")], map, "a.md", OPTS());
  const b = sm.verifyMarkdownSpans([span(3, "Overlapping windows keep a sentence whole.")], map, "b.md", OPTS());
  assert.notEqual(a.spans[0].key, b.spans[0].key);
  assert.ok(a.spans[0].key.startsWith("a.md#"));
});

test("renderMarkdownMention cites the note and heading, never an offset", () => {
  const map = sm.buildSourceMap(NOTE);
  const r = sm.verifyMarkdownSpans([span(3, "Overlapping windows keep a sentence whole.")], map, "sources/retrieval.md", OPTS());
  const line = sm.renderMarkdownMention(r.spans[0], "sources/retrieval", "Retrieval");
  assert.ok(line.startsWith('- "Overlapping windows keep a sentence whole."'));
  assert.ok(line.includes("[[sources/retrieval#Overlap|Retrieval › Chunking › Overlap]]"));
  assert.ok(!/\d+-\d+/.test(line), "a character offset would not survive an edit");
});

test("renderMarkdownMention falls back to the note when there is no heading", () => {
  const map = sm.buildSourceMap(NOTE);
  const r = sm.verifyMarkdownSpans([span(1, "Intro paragraph before any heading.")], map, "n.md", OPTS());
  const line = sm.renderMarkdownMention(r.spans[0], "sources/n", "Note");
  assert.ok(line.includes("[[sources/n|Note]]"));
});

test("toMarkdownRows turns verified spans into rows that cite the note, not a PDF", () => {
  const md = "# Prompts\n\n## Why it works\n\nRetrieval practice strengthens memory. Spacing beats massing.\n";
  const map = sm.buildSourceMap(md);
  const r = sm.verifyMarkdownSpans(
    [{ page: 1, quote: "Retrieval practice strengthens memory.", label: "RP", note_title: "Retrieval Practice", note_kind: "concept" }],
    map,
    "sources/clippings/prompts.md",
    { perSegment: 2, remaining: 10, existingKeys: new Set(), batch: [1] },
  );
  const rows = sm.toMarkdownRows(r.spans, "sources/clippings/prompts.md", "How to write good prompts");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "M01");
  assert.equal(rows[0].key, r.spans[0].key);
  assert.equal(rows[0].text, "Retrieval practice strengthens memory.");
  assert.equal(rows[0].page, 0);
  assert.deepEqual(rows[0].origins, ["sources/clippings/prompts.md"]);
  assert.equal(
    rows[0].mention,
    '- "Retrieval practice strengthens memory." — [[sources/clippings/prompts.md#Why it works|How to write good prompts › Prompts › Why it works]]',
  );
});
