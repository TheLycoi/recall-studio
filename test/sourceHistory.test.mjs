import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sharedBuildOptions } from "../scripts/esbuild-shared.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let api, dir;
before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "source-history-"));
  const out = path.join(dir, "resolver.cjs");
  await build({ ...sharedBuildOptions(), entryPoints: [path.join(root, "src/passageHistory.ts")], outfile: out, logLevel: "silent" });
  api = createRequire(import.meta.url)(out);
});
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
const passage = (over = {}) => ({ id: "h1", sourcePath: "sources/a.md", text: "The signal travels.", before: "Before. ", after: " After.", line: 2, blockId: null, page: null, cards: [], status: "ready", ...over });

test("exact quote resolves only a unique occurrence and does not rely on line hint", () => {
  const raw = "Intro.\nBefore. The signal travels. After.\n";
  assert.deepEqual(api.resolvePassage(raw, passage({ line: 100 })).state, "matched");
  assert.equal(api.resolvePassage(raw, passage({ line: 100 })).start, raw.indexOf("The signal"));
});
test("repeated quote without decisive context stays unresolved", () => {
  const raw = "The signal travels.\nThe signal travels.";
  assert.equal(api.resolvePassage(raw, passage({ before: "", after: "", line: 0 })).state, "unresolved");
});
test("context disambiguates repeated quote but saved line alone cannot", () => {
  const raw = "First. The signal travels.\nSecond. The signal travels. End.";
  assert.equal(api.resolvePassage(raw, passage({ before: "Second. ", after: " End.", line: 0 })).start, raw.lastIndexOf("The signal"));
});
test("unique block ID selects its own quote; edited block reports changed", () => {
  const raw = "The signal travels. ^other\nThe signal travels. ^anchor";
  assert.equal(api.resolvePassage(raw, passage({ blockId: "anchor", before: "", after: "" })).start, raw.lastIndexOf("The signal"));
  assert.equal(api.resolvePassage("A different signal. ^anchor", passage({ blockId: "anchor" })).state, "changed");
});
test("a block at the start of the note retains its first character", () => {
  assert.equal(api.resolvePassage("The signal travels. ^anchor", passage({ blockId: "anchor" })).start, 0);
});
test("a changed anchored block cannot borrow a repeated quote from another block", () => {
  assert.equal(api.resolvePassage("The signal travels. ^other\nChanged text. ^anchor", passage({ blockId: "anchor" })).state, "changed");
});
test("context produced by capture's trimmed contextWindow disambiguates repeated quotes", () => {
  const raw = "First. The signal travels.\nSecond. The signal travels. End.";
  assert.equal(api.resolvePassage(raw, passage({ before: "Second.", after: "End." })).start, raw.lastIndexOf("The signal"));
});
test("CRLF and whitespace-only paragraph boundaries prevent borrowing a quote from another block", () => {
  for (const separator of ["\r\n\r\n", "\n \n"]) {
    assert.equal(api.resolvePassage(`The signal travels.${separator}Changed text. ^anchor`, passage({ blockId: "anchor" })).state, "changed");
  }
});
test("an anchored line cannot borrow an exact quote across a Markdown block boundary", () => {
  for (const boundary of ["# New section\n", "- ", "> "]) {
    const raw = `The signal travels.\n${boundary}Changed text. ^anchor`;
    assert.notEqual(api.resolvePassage(raw, passage({ blockId: "anchor" })).state, "matched");
  }
});
test("highlight markup maps offsets to the actual source without changing the captured quote", () => {
  const raw = "Intro\n==The signal travels.== End";
  const loc = api.resolvePassage(raw, passage());
  assert.equal(raw.slice(loc.start, loc.end), "The signal travels.");
  assert.equal(api.resolvePassage(null, passage()).state, "missing");
});
test("duplicate and deleted cards never inflate awaiting-export counts or confirmed receipts", () => {
  const counts = api.passageSummary(passage({ cards: [
    {status: "duplicate"}, {status: "deleted"}, {status: "exported", ankiNoteId: -1},
  ] })).counts;
  assert.equal(counts.awaiting, 0);
  assert.equal(counts.confirmedAnki, 0);
  assert.equal(counts.full, false, "a duplicate is not a successful export");
});
test("edited quote never matches similar text", () => {
  assert.equal(api.resolvePassage("Before. The signal moved. After.", passage()).state, "changed");
});
test("PDF retains page/subpath as locator but makes no text match claim", () => {
  const h = passage({ sourcePath: "sources/a.pdf", page: 4, subpath: "page=4&selection=abc", cards: [] });
  assert.equal(api.resolvePassage("", h).state, "unresolved");
  assert.equal(api.passageSummary(h).locator, "page 4 · page=4&selection=abc");
});
test("archived cards and distinct export states are counted honestly", () => {
  const h = passage({ archived: true, cards: [
    { status: "pending" }, { status: "exported", ankiNoteId: 41 },
    { status: "exported" }, { status: "flagged" },
  ] });
  assert.deepEqual(api.passageSummary(h).counts, { created: 4, awaiting: 2, confirmedAnki: 1, fileUnconfirmed: 1, partial: true, full: false, noCards: false, dismissed: false });
  assert.equal(api.passageSummary(passage({ status: "dismissed" })).counts.dismissed, true);
  assert.equal(api.passageSummary(passage()).counts.noCards, true);
});
