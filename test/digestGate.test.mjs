// Run with: npm test  (bundles src/digestGate.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let dg;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wikilm-gate-"));
  const out = path.join(dir, "digestGate.mjs");
  await build({ entryPoints: ["src/digestGate.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  dg = await import(pathToFileURL(out).href);
});

const row = (text, over = {}) => ({
  id: "H01",
  key: "page=1&selection=0,0,0,4",
  page: 1,
  kind: "selection",
  color: "yellow",
  target: { page: 1, selection: { beginIndex: 0, beginOffset: 0, endIndex: 0, endOffset: 4 } },
  text,
  before: "",
  after: "",
  origins: [],
  ...over,
});

test("no highlights at all offers", () => {
  assert.deepEqual(dg.decideGate({ highlights: [] }), { action: "offer", usable: 0, total: 0 });
});

test("highlights with empty text only offer", () => {
  assert.deepEqual(dg.decideGate({ highlights: [row(""), row("   ")] }), { action: "offer", usable: 0, total: 2 });
});

test("one usable highlight digests", () => {
  assert.deepEqual(dg.decideGate({ highlights: [row("Receptors bind ligands.")] }), { action: "digest", usable: 1, total: 1 });
});

test("a rect-only highlight is real for merging but not for the gate", () => {
  const rect = row("", { kind: "rect", key: "page=2&rect=1,2,3,4", target: { page: 2, rect: [1, 2, 3, 4] }, color: null });
  assert.equal(dg.decideGate({ highlights: [rect] }).action, "offer");
});

test("a rect beside a text highlight digests, counting only the text", () => {
  const rect = row("", { kind: "rect", key: "page=2&rect=1,2,3,4", target: { page: 2, rect: [1, 2, 3, 4] }, color: null });
  assert.deepEqual(dg.decideGate({ highlights: [rect, row("A fact.")] }), { action: "digest", usable: 1, total: 2 });
});

// ---- digest folder: which PDFs are digested, and what the run reports ----------

const f = (p) => ({ path: p, extension: p.split(".").pop() });

test("planDigestFolder queues the PDFs with highlights in path order and sets the rest aside", () => {
  const files = [f("lec/b.pdf"), f("lec/notes.md"), f("lec/a.PDF"), f("lec/sub/c.pdf"), f("lec/bare.pdf")];
  const has = new Set(["lec/b.pdf", "lec/a.PDF", "lec/sub/c.pdf"]);
  const plan = dg.planDigestFolder(files, (x) => has.has(x.path));
  assert.deepEqual(plan.queue.map((x) => x.path), ["lec/a.PDF", "lec/b.pdf", "lec/sub/c.pdf"]);
  assert.deepEqual(plan.bare.map((x) => x.path), ["lec/bare.pdf"]);
});

test("planDigestFolder never asks about a file that is not a PDF", () => {
  const asked = [];
  dg.planDigestFolder([f("a.md"), f("b.pdf")], (x) => (asked.push(x.path), true));
  assert.deepEqual(asked, ["b.pdf"]);
});

test("planDigestFolder on a folder with no PDFs queues nothing", () => {
  assert.deepEqual(dg.planDigestFolder([f("a.md")], () => true), { queue: [], bare: [] });
});

test("digestFolderSummary counts digested of queued, then skipped, failed, bare and a stop", () => {
  assert.equal(dg.digestFolderSummary({ queued: 5, digested: 3, skipped: 2, failed: 0, bare: 0, unreadable: 0, stopped: false }), "digested 3 of 5 PDFs, 2 skipped");
  assert.equal(dg.digestFolderSummary({ queued: 1, digested: 1, skipped: 0, failed: 0, bare: 0, unreadable: 0, stopped: false }), "digested 1 of 1 PDF");
  assert.equal(
    dg.digestFolderSummary({ queued: 4, digested: 1, skipped: 0, failed: 1, bare: 2, unreadable: 0, stopped: true }),
    "digested 1 of 4 PDFs, 1 failed, 2 not reached (stopped), 2 with no highlights",
  );
});

test("digestFolderSummary reports unreadable PDFs separately from ones with no highlights", () => {
  assert.equal(
    dg.digestFolderSummary({ queued: 2, digested: 2, skipped: 0, failed: 0, bare: 0, unreadable: 1, stopped: false }),
    "digested 2 of 2 PDFs, 1 could not be read",
  );
  assert.equal(
    dg.digestFolderSummary({ queued: 2, digested: 2, skipped: 0, failed: 0, bare: 0, unreadable: 3, stopped: false }),
    "digested 2 of 2 PDFs, 3 could not be read",
  );
});

test("digestFolderSummary keeps 'with no highlights' for the bare count and 'could not be read' for the unreadable one, together", () => {
  assert.equal(
    dg.digestFolderSummary({ queued: 3, digested: 3, skipped: 0, failed: 0, bare: 2, unreadable: 1, stopped: false }),
    "digested 3 of 3 PDFs, 2 with no highlights, 1 could not be read",
  );
});

// The Digest picker's folder rows: every folder with a PDF somewhere under
// it, so ticking a folder can tick what is below it even when the PDFs sit
// two levels down. Pure, so the modal only draws what this returns.
const pdf = (path) => ({ path, extension: path.toLowerCase().endsWith(".pdf") ? path.slice(-3) : "md" });

test("pickerFolders lists each folder with PDFs under it, with its own and all PDFs in path order", () => {
  const files = [pdf("BIO201/L02.pdf"), pdf("BIO201/L01.pdf"), pdf("BIO201/labs/Lab4.pdf"), pdf("KIN110/notes.md"), pdf("PSY220/week1/reading.pdf")];
  const rows = dg.pickerFolders(files);
  assert.deepEqual(
    rows.map((r) => [r.path, r.depth, r.pdfs.map((f) => f.path), r.all.map((f) => f.path)]),
    [
      ["BIO201", 0, ["BIO201/L01.pdf", "BIO201/L02.pdf"], ["BIO201/L01.pdf", "BIO201/L02.pdf", "BIO201/labs/Lab4.pdf"]],
      ["BIO201/labs", 1, ["BIO201/labs/Lab4.pdf"], ["BIO201/labs/Lab4.pdf"]],
      ["PSY220", 0, [], ["PSY220/week1/reading.pdf"]],
      ["PSY220/week1", 1, ["PSY220/week1/reading.pdf"], ["PSY220/week1/reading.pdf"]],
    ],
  );
});

test("pickerFolders puts a PDF at the vault root under the empty path and ignores notes", () => {
  const rows = dg.pickerFolders([pdf("root.pdf"), pdf("a note.md")]);
  assert.deepEqual(rows.map((r) => [r.path, r.depth, r.all.map((f) => f.path)]), [["", 0, ["root.pdf"]]]);
  assert.deepEqual(dg.pickerFolders([pdf("only.md")]), []);
});

test("pickerFolders matches extensions case-insensitively, as the folder planner does", () => {
  const rows = dg.pickerFolders([pdf("x/Deck.PDF")]);
  assert.deepEqual(rows.map((r) => r.all.map((f) => f.path)), [["x/Deck.PDF"]]);
});

test("digestFilesSummary speaks of the PDFs chosen, not a folder", () => {
  assert.equal(dg.digestFolderSummary({ queued: 2, digested: 1, skipped: 1, failed: 0, bare: 1, unreadable: 0, stopped: false }), "digested 1 of 2 PDFs, 1 skipped, 1 with no highlights");
});

// A digest merges into topic pages only. The plugin's own notes under the
// topic folder (schema, source transcripts, the engine's index and log) are
// never offered as merge targets, the same rule Ask and Lint apply.
const targetOpts = { topicFolder: "wiki", schemaFolder: "wiki/schema", transcriptFolder: "wiki/sources/wispr" };

test("isDigestTarget accepts a normal topic page", () => {
  assert.equal(dg.isDigestTarget("wiki/concepts/Pharmacokinetics.md", targetOpts), true);
  assert.equal(dg.isDigestTarget("wiki/BIO101/Receptors.md", targetOpts), true);
});

test("isDigestTarget refuses a schema note", () => {
  assert.equal(dg.isDigestTarget("wiki/schema/inbox.md", targetOpts), false);
});

test("isDigestTarget refuses a transcript", () => {
  assert.equal(dg.isDigestTarget("wiki/sources/wispr/2026-09-30 lecture.md", targetOpts), false);
});

test("isDigestTarget refuses a source summary under the topic folder's sources", () => {
  assert.equal(dg.isDigestTarget("wiki/sources/some-paper.md", targetOpts), false);
});

test("isDigestTarget refuses the topic folder's index and log", () => {
  assert.equal(dg.isDigestTarget("wiki/index.md", targetOpts), false);
  assert.equal(dg.isDigestTarget("wiki/log.md", targetOpts), false);
  // Only the top-level ones: a page named index deeper down is a page.
  assert.equal(dg.isDigestTarget("wiki/concepts/index.md", targetOpts), true);
});

test("isDigestTarget refuses anything outside the topic folder", () => {
  assert.equal(dg.isDigestTarget("Clippings/article.md", targetOpts), false);
  assert.equal(dg.isDigestTarget("wikis/page.md", targetOpts), false);
  assert.equal(dg.isDigestTarget("wiki.md", targetOpts), false);
});

test("isDigestTarget tolerates slashes around the folder settings", () => {
  const opts = { topicFolder: "/wiki/", schemaFolder: "wiki/schema/", transcriptFolder: "/wiki/sources/wispr" };
  assert.equal(dg.isDigestTarget("wiki/concepts/a.md", opts), true);
  assert.equal(dg.isDigestTarget("wiki/schema/x.md", opts), false);
  assert.equal(dg.isDigestTarget("wiki/sources/wispr/x.md", opts), false);
  assert.equal(dg.isDigestTarget("wiki/index.md", opts), false);
});

test("nothingNewHint explains a preview that would write nothing, naming the highlight count and page span", () => {
  const rows = [{ exists: true, added: 0, sections: [], highlights: [{ page: 2 }, { page: 7 }, { page: 4 }] }];
  const hint = dg.nothingNewHint(rows);
  assert.match(hint, /all 3 highlights/);
  assert.match(hint, /pages 2 to 7/);
  assert.match(hint, /AI highlight/);
});

test("nothingNewHint is empty when any row would write something", () => {
  assert.equal(dg.nothingNewHint([{ exists: true, added: 1, sections: [], highlights: [{ page: 2 }] }]), "");
  assert.equal(dg.nothingNewHint([{ exists: false, added: 0, sections: [], highlights: [{ page: 2 }] }]), "");
  assert.equal(dg.nothingNewHint([{ exists: true, added: 0, sections: [{ heading: "X" }], highlights: [{ page: 2 }] }]), "");
  assert.equal(dg.nothingNewHint([]), "");
});

test("fileTargets lists the plan's own pages first, then the rest by title, once each", () => {
  const rows = [{ exists: true, title: "Psychopathology" }, { exists: false, title: "Biopsychosocial Model" }];
  const pages = [{ title: "Zeta" }, { title: "psychopathology" }, { title: "Alpha" }];
  assert.deepEqual(dg.fileTargets(rows, pages), ["Psychopathology", "Alpha", "Zeta"]);
  assert.deepEqual(dg.fileTargets([], []), []);
});

// ---- what the reader is told: no highlights, and how a topic digest ended ----------

test("noHighlightsMessage says a highlight without text is why, and tells a bare PDF apart", () => {
  const one = dg.noHighlightsMessage({ action: "offer", usable: 0, total: 1 });
  assert.ok(one.includes("1 highlight, and it holds no text"), one);
  assert.ok(one.includes("box drawn around a figure"), one);
  assert.ok(dg.noHighlightsMessage({ action: "offer", usable: 0, total: 3 }).includes("3 highlights, and none holds text"));
  const bare = dg.noHighlightsMessage({ action: "offer", usable: 0, total: 0 });
  assert.ok(bare.startsWith("This PDF has no highlights yet."), bare);
  for (const m of [one, bare]) assert.ok(m.includes("digest <topic> into <note>"), "each names the way to digest without highlighting");
});

test("topic instructions carry the topic, and the digest one names the note it is filed in", () => {
  assert.ok(dg.topicSuggestInstruction("history of doping").includes("“history of doping”"));
  const d = dg.topicDigestInstruction("history of doping", "Pharmacology");
  assert.ok(d.includes("“history of doping”") && d.includes("“Pharmacology”"), d);
});

test("topicOutcomeLine says what a topic digest did, and why when it wrote nothing", () => {
  const base = { topic: "history of doping", pdf: "Deck", note: "Pharmacology", pages: 12, spans: 0 };
  assert.equal(
    dg.topicOutcomeLine({ ...base, status: "digested", spans: 4 }),
    "Filed “history of doping” in [[Pharmacology]]: 4 passages from Deck.",
  );
  assert.equal(dg.topicOutcomeLine({ ...base, status: "digested", spans: 1 }), "Filed “history of doping” in [[Pharmacology]]: 1 passage from Deck.");
  assert.equal(dg.topicOutcomeLine({ ...base, status: "nothing" }), "Nothing about “history of doping” in Deck (12 pages read). Nothing was written.");
  assert.ok(dg.topicOutcomeLine({ ...base, status: "no-text" }).includes("no text layer"));
  assert.ok(dg.topicOutcomeLine({ ...base, status: "not-a-page" }).includes("Pharmacology is not a page"));
  assert.ok(dg.topicOutcomeLine({ ...base, status: "skipped", spans: 4 }).startsWith("Nothing was written"));
  assert.ok(dg.topicOutcomeLine({ ...base, status: "failed" }).includes("failed"));
});
