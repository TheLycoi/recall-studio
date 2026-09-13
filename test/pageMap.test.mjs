// Run with: npm test  (bundles src/pageMap.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pm;
let pt;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
  const out = path.join(dir, "pageMap.mjs");
  await build({ entryPoints: ["src/pageMap.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  pm = await import(pathToFileURL(out).href);
  const outPt = path.join(dir, "pdftext.mjs");
  await build({ entryPoints: ["src/pdftext.ts"], bundle: true, format: "esm", platform: "node", outfile: outPt, logLevel: "silent" });
  pt = await import(pathToFileURL(outPt).href);
});

const item = (str, hasEOL = false) => ({ str, hasEOL });
const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

const THREE = [item("Pharmacology is the"), item("study of drugs"), item("in the body")];

test("buildPageMap joins without normalizing and records item starts", () => {
  const map = pm.buildPageMap(THREE);
  assert.equal(map.text, "Pharmacology is the study of drugs in the body");
  assert.deepEqual(map.starts, [0, 20, 35]);
  // Every item's raw text sits exactly at its recorded start.
  for (let i = 0; i < THREE.length; i++) {
    assert.equal(map.text.slice(map.starts[i], map.starts[i] + THREE[i].str.length), THREE[i].str);
  }
});

test("buildPageMap keeps a newline join and internal runs of whitespace", () => {
  const map = pm.buildPageMap([item("a  b", true), item("c")]);
  assert.equal(map.text, "a  b\nc");
  assert.deepEqual(map.starts, [0, 5]);
});

test("quote inside a single item selects that item and round-trips", () => {
  const map = pm.buildPageMap(THREE);
  const sel = pm.selectionFor(map, "study of drugs");
  assert.deepEqual(sel, { beginIndex: 1, beginOffset: 0, endIndex: 1, endOffset: 14 });
  assert.equal(pt.selectionText(THREE, sel), "study of drugs");
});

test("quote spanning three items round-trips", () => {
  const map = pm.buildPageMap(THREE);
  const quote = "is the study of drugs in";
  const sel = pm.selectionFor(map, quote);
  assert.equal(sel.beginIndex, 0);
  assert.equal(sel.endIndex, 2);
  assert.equal(norm(pt.selectionText(THREE, sel)), norm(quote));
});

test("a hasEOL join round-trips: singleLine turns the newline into a space", () => {
  const items = [item("Pharmacology is the"), item("study of drugs", true), item("in the body")];
  const map = pm.buildPageMap(items);
  assert.equal(map.text, "Pharmacology is the study of drugs\nin the body");
  const quote = "Pharmacology is the study of drugs in the body";
  const sel = pm.selectionFor(map, quote);
  assert.deepEqual(sel, { beginIndex: 0, beginOffset: 0, endIndex: 2, endOffset: 11 });
  assert.equal(norm(pt.selectionText(items, sel)), norm(quote));
});

test("internal double/triple spaces are found via the normalized path", () => {
  const items = [item("Receptors  bind   ligands")];
  const map = pm.buildPageMap(items);
  const quote = "Receptors bind ligands";
  // The exact indexOf cannot match: the raw text keeps the wide runs.
  assert.equal(map.text.indexOf(quote), -1);
  const loc = pm.locateInPage(map, quote);
  assert.deepEqual(loc, { start: 0, end: 25 });
  const sel = pm.selectionFor(map, quote);
  assert.deepEqual(sel, { beginIndex: 0, beginOffset: 0, endIndex: 0, endOffset: 25 });
  assert.equal(norm(pt.selectionText(items, sel)), norm(quote));
});

test("an empty item between two items still round-trips", () => {
  const items = [item("alpha"), item(""), item("beta")];
  const map = pm.buildPageMap(items);
  // The raw join keeps both separator spaces around the empty item.
  assert.equal(map.text, "alpha  beta");
  const sel = pm.selectionFor(map, "alpha beta");
  assert.deepEqual(sel, { beginIndex: 0, beginOffset: 0, endIndex: 2, endOffset: 4 });
  // selectionText joins "alpha", "", "beta" with newlines and singleLine
  // collapses "alpha\n\nbeta" to exactly "alpha beta" — no doubled space.
  assert.equal(pt.selectionText(items, sel), "alpha beta");
});

test("a line-end hyphen cannot be located: known limitation, selectionFor returns null", () => {
  const items = [item("pharma-", true), item("cology is")];
  const map = pm.buildPageMap(items);
  assert.equal(map.text, "pharma-\ncology is");
  // KNOWN LIMITATION. singleLine (src/pdftext.ts:198-203) drops a line-end
  // hyphen before a letter, so the selection WOULD render as "pharmacology is":
  assert.equal(
    pt.selectionText(items, { beginIndex: 0, beginOffset: 0, endIndex: 1, endOffset: 9 }),
    "pharmacology is",
  );
  // ...but locateInPage searches the raw page text, where the exact path sees
  // "pharma-\ncology is" and the normalized path sees "pharma- cology is".
  // Neither contains "pharmacology is", so the quote is not found and we
  // return null rather than guess a span. De-hyphenation is not modelled here.
  assert.equal(pm.locateInPage(map, "pharmacology is"), null);
  assert.equal(pm.selectionFor(map, "pharmacology is"), null);
});

test("a quote absent from the page is null", () => {
  const map = pm.buildPageMap(THREE);
  assert.equal(pm.locateInPage(map, "mitochondrial biogenesis"), null);
  assert.equal(pm.selectionFor(map, "mitochondrial biogenesis"), null);
});

test("a fuzzy hit whose text differs from the quote is rejected", () => {
  const items = [item("the receptor never binds ligands")];
  const map = pm.buildPageMap(items);
  // locateQuote's fuzzy path would happily span "receptor never binds";
  // that is not the quote, so locateInPage refuses it.
  assert.equal(pm.locateInPage(map, "receptor binds"), null);
  assert.equal(pm.selectionFor(map, "receptor binds"), null);
});

test("an empty or whitespace-only quote is null", () => {
  const map = pm.buildPageMap(THREE);
  assert.equal(pm.locateInPage(map, ""), null);
  assert.equal(pm.locateInPage(map, "   "), null);
  assert.equal(pm.selectionFor(map, ""), null);
});

test("offsetToPos clamps an end offset off the separator back onto item 0", () => {
  const map = pm.buildPageMap(THREE);
  // offset 19 is the space joining item 0 and item 1.
  assert.equal(map.text[19], " ");
  assert.deepEqual(pm.offsetToPos(map, 19, "end"), { index: 0, offset: THREE[0].str.length });
});

test("offsetToPos advances a begin offset off the separator onto item 1", () => {
  const map = pm.buildPageMap(THREE);
  assert.deepEqual(pm.offsetToPos(map, 19, "begin"), { index: 1, offset: 0 });
});

test("offsetToPos resolves interior offsets and clamps out-of-range ones", () => {
  const map = pm.buildPageMap(THREE);
  assert.deepEqual(pm.offsetToPos(map, 0, "begin"), { index: 0, offset: 0 });
  assert.deepEqual(pm.offsetToPos(map, 26, "begin"), { index: 1, offset: 6 });
  assert.deepEqual(pm.offsetToPos(map, 26, "end"), { index: 1, offset: 6 });
  assert.deepEqual(pm.offsetToPos(map, map.text.length, "end"), { index: 2, offset: THREE[2].str.length });
  assert.deepEqual(pm.offsetToPos(map, 9999, "end"), { index: 2, offset: THREE[2].str.length });
  assert.deepEqual(pm.offsetToPos(map, -5, "begin"), { index: 0, offset: 0 });
});

test("an empty page yields empty text and no selection", () => {
  const map = pm.buildPageMap([]);
  assert.equal(map.text, "");
  assert.deepEqual(map.starts, []);
  assert.equal(pm.selectionFor(map, "anything"), null);
});
