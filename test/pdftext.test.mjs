// Run with: npm test  (bundles src/pdftext.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let p;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wikilm-test-"));
  const out = path.join(dir, "pdftext.mjs");
  await build({ entryPoints: ["src/pdftext.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  p = await import(pathToFileURL(out).href);
});

// ---------------------------------------------------------------------------
// test/fixtures/pdftext-page.json: a synthetic pdf.js page on a 100x100 grid.
//
// PDF user space, so y grows upward and the page reads top to bottom by
// descending y. Every glyph is 4 wide and its line's height; item n's first
// char starts at x=10, so char i of any item spans x = [10+4i, 14+4i] and has
// centre x = 12+4i.
//
//   y
//   95 +----------------------------------------------+
//      |  [ Underline 849R quad: 8,78 - 90,95 ]       |
//   90 |  item 0 "Pharmacology is the"   (centre 85)  |  hasEOL: true
//   80 |                                              |
//      |  +-- Highlight 846R quad 1: 8,58 - 90,72 --+ |
//   70 |  |  item 1 "study of drugs"     (centre 65)| |  hasEOL: false
//   60 |  +------------------------------------------+ |
//      |  +-- Highlight 846R quad 2: 8,38 - 90,52 --+ |
//   50 |  |  item 2 "in the body"        (centre 45)| |  hasEOL: true
//   40 |  +------------------------------------------+ |
//      |                                              |
//   12 |  item 3 "Footer"                (centre 8.5) |  hasEOL: false
//    5 +----------------------------------------------+
//
// Char centres are inclusive-tested against the quad rects, so:
//   - the Underline's y-band 78..95 catches centre 85 only  -> item 0 exactly
//   - the Highlight's two bands 58..72 and 38..52 catch 65 and 45
//     -> items 1 and 2 exactly, and never 85 or 8.5
//   - every band's x-range 8..90 spans the widest item ("Pharmacology is the"
//     ends at centre 84), so no glyph is clipped horizontally
// The Popup annot 900R reuses the Highlight's geometry to prove the subtype
// filter drops it rather than the geometry doing so.
//
// Colours: the Highlight is [255, 208, 0] (already 0..255, kept as is) and the
// Underline [1, 0.816, 0] (0..1 with a fractional component, scaled by 255).
// Both must come out "255,208,0".
// ---------------------------------------------------------------------------
const fixture = JSON.parse(readFileSync("test/fixtures/pdftext-page.json", "utf8"));
const items = fixture.items;
const annots = fixture.annots;

test("quadPointsToRects: a flat run of 8 numbers is one [minx,miny,maxx,maxy] rect", () => {
  // x1 y1 x2 y2 x3 y3 x4 y4, upper-left / upper-right / lower-left / lower-right
  const rects = p.quadPointsToRects([8, 72, 90, 72, 8, 58, 90, 58]);
  assert.deepEqual(rects, [[8, 58, 90, 72]]);
});

test("quadPointsToRects: a typed array of 16 numbers is two rects", () => {
  const rects = p.quadPointsToRects(Float32Array.from([8, 72, 90, 72, 8, 58, 90, 58, 8, 52, 90, 52, 8, 38, 90, 38]));
  assert.deepEqual(rects, [[8, 58, 90, 72], [8, 38, 90, 52]]);
});

test("quadPointsToRects: an array of 4 points is one normalized rect", () => {
  // PDF++ builds the rect from points 2 and 1, then normalizes it.
  const rects = p.quadPointsToRects([[{ x: 8, y: 95 }, { x: 90, y: 95 }, { x: 8, y: 78 }, { x: 90, y: 78 }]]);
  assert.deepEqual(rects, [[8, 78, 90, 95]]);
});

test("quadPointsToRects: a flat run of 7 numbers is not a quad, so no rects", () => {
  assert.deepEqual(p.quadPointsToRects([8, 72, 90, 72, 8, 58, 90]), []);
  assert.deepEqual(p.quadPointsToRects(Float32Array.from([8, 72, 90, 72, 8, 58, 90])), []);
});

test("quadPointsToRects: missing quadPoints is no rects, never a throw", () => {
  assert.deepEqual(p.quadPointsToRects(undefined), []);
  assert.deepEqual(p.quadPointsToRects(null), []);
  assert.deepEqual(p.quadPointsToRects([]), []);
});

test("textInRect: a char is in when its centre is in, and from/to bracket it", () => {
  const r = p.textInRect(items, [8, 58, 90, 72]);
  assert.equal(r.text, "study of drugs");
  assert.deepEqual(r.from, { index: 1, offset: 0 });
  assert.deepEqual(r.to, { index: 1, offset: 14 });
});

test("textInRect: bounds are inclusive on the char centre", () => {
  // Item 1's chars have centres x = 12, 16, ... and y = 65. A rect whose
  // edges sit exactly on the first two centres keeps both chars.
  const r = p.textInRect(items, [12, 65, 16, 65]);
  assert.equal(r.text, "st");
  assert.deepEqual(r.from, { index: 1, offset: 0 });
  assert.deepEqual(r.to, { index: 1, offset: 2 });
});

test("textInRect: a rect covering nothing returns empty text and unset positions", () => {
  const r = p.textInRect(items, [0, 20, 5, 30]);
  assert.equal(r.text, "");
  assert.deepEqual(r.from, { index: -1, offset: -1 });
  assert.deepEqual(r.to, { index: -1, offset: -1 });
});

test("textInRect: items without char geometry contribute nothing", () => {
  const bare = items.map(({ str, hasEOL }) => ({ str, hasEOL }));
  assert.equal(p.textInRect(bare, [0, 0, 100, 100]).text, "");
});

test("annotationHighlights: two markup annots in text order, Popup dropped", () => {
  const out = p.annotationHighlights(items, annots);
  assert.equal(out.length, 2, "the Popup subtype is not a text-markup annotation");
  assert.deepEqual(out.map((h) => h.id), ["849R", "846R"]);
  assert.deepEqual(out.map((h) => h.subtype), ["Underline", "Highlight"]);
  assert.equal(out[0].text, "Pharmacology is the");
  assert.equal(out[1].text, "study of drugs in the body", "two quads join with a newline, then single-line");
});

test("annotationHighlights: both colour ranges normalize to the same 0..255 string", () => {
  const out = p.annotationHighlights(items, annots);
  assert.equal(out[0].color, "255,208,0", "[1, 0.816, 0] is a 0..1 colour and is scaled");
  assert.equal(out[1].color, "255,208,0", "[255, 208, 0] is already 0..255 and is kept");
});

test("annotationHighlights: an absent colour is null, an integer 0..1 colour is kept as is", () => {
  const [black] = p.annotationHighlights(items, [{ ...annots[0], id: "1R", color: null }]);
  assert.equal(black.color, null);
  // [1,0,0] has no fractional component, so it is read as near-black, not red.
  const [amb] = p.annotationHighlights(items, [{ ...annots[0], id: "2R", color: [1, 0, 0] }]);
  assert.equal(amb.color, "1,0,0");
});

test("annotationHighlights: rects, from, top and comment come through", () => {
  const out = p.annotationHighlights(items, annots);
  const hl = out.find((h) => h.id === "846R");
  assert.deepEqual(hl.rects, [[8, 58, 90, 72], [8, 38, 90, 52]]);
  assert.deepEqual(hl.from, { index: 1, offset: 0 });
  assert.equal(hl.top, 72, "the top edge of the first quad");
  assert.equal(hl.comment, "what the drug reaches");
  assert.equal(out.find((h) => h.id === "849R").comment, null);
});

test("annotationHighlights: an annot whose quadPoints yield no rect is dropped", () => {
  const out = p.annotationHighlights(items, [{ id: "3R", subtype: "Highlight", quadPoints: [1, 2, 3] }]);
  assert.deepEqual(out, []);
});

test("selectionText: across items, the tail of the first plus the head of the last", () => {
  assert.equal(
    p.selectionText(items, { beginIndex: 1, beginOffset: 0, endIndex: 2, endOffset: 8 }),
    "study of drugs in the b",
  );
});

test("selectionText: within one item it is a plain slice", () => {
  assert.equal(p.selectionText(items, { beginIndex: 0, beginOffset: 16, endIndex: 0, endOffset: 19 }), "the");
});

test("selectionText: out of range is null, so the caller keeps the callout quote", () => {
  assert.equal(p.selectionText(items, { beginIndex: 0, beginOffset: 0, endIndex: 9, endOffset: 0 }), null);
  assert.equal(p.selectionText(items, { beginIndex: -1, beginOffset: 0, endIndex: 1, endOffset: 2 }), null);
  assert.equal(p.selectionText(items, { beginIndex: 2, beginOffset: 0, endIndex: 1, endOffset: 2 }), null);
});

test("selectionText: spanning three items joins the middle ones whole", () => {
  assert.equal(
    p.selectionText(items, { beginIndex: 0, beginOffset: 13, endIndex: 2, endOffset: 2 }),
    "is the study of drugs in",
  );
});

test("singleLine: a line-end hyphen before a letter is a syllable break", () => {
  assert.equal(p.singleLine("pharma-\ncology of\ndrugs"), "pharmacology of drugs");
});

test("singleLine: other breaks become one space, CRLF and blank lines included", () => {
  assert.equal(p.singleLine("a\r\nb"), "a b");
  assert.equal(p.singleLine("a\n\n\nb"), "a b");
  assert.equal(p.singleLine("no breaks here"), "no breaks here");
});

test("singleLine: a hyphen before a non-letter is kept", () => {
  assert.equal(p.singleLine("dose-\n1 mg"), "dose- 1 mg");
});

test("pageText: hasEOL decides newline or space, then whitespace collapses", () => {
  assert.equal(p.pageText(items), "Pharmacology is the study of drugs in the body Footer");
  assert.equal(p.pageText([]), "");
});

test("hasCharGeometry: true for the fixture, false once chars are stripped", () => {
  assert.equal(p.hasCharGeometry(items), true);
  assert.equal(p.hasCharGeometry(items.map(({ str, hasEOL }) => ({ str, hasEOL }))), false);
  assert.equal(p.hasCharGeometry(items.map((it) => ({ ...it, chars: [] }))), false);
  assert.equal(p.hasCharGeometry([]), false);
});

test("contextFor: the located text keeps its neighbours on both sides", () => {
  const page = p.pageText(items);
  const ctx = p.contextFor(page, "study of drugs", 20);
  assert.equal(ctx.before, "Pharmacology is the");
  assert.equal(ctx.after, "in the body Footer");
});

test("contextFor: text that is not on the page yields empty context", () => {
  const page = p.pageText(items);
  assert.deepEqual(p.contextFor(page, "pharmacokinetics of albumin binding", 20), { before: "", after: "" });
  assert.deepEqual(p.contextFor(page, "   ", 20), { before: "", after: "" });
  assert.deepEqual(p.contextFor("", "study", 20), { before: "", after: "" });
});

test("joinPages: one [page N] marker per page, pages separated by a blank line", () => {
  assert.equal(p.joinPages(["a", "b"]), "[page 1]\na\n\n[page 2]\nb");
  assert.equal(p.joinPages([]), "");
  assert.equal(p.joinPages(["only"]), "[page 1]\nonly");
});
