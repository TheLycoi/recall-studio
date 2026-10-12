// Run with: npm test  (bundles src/chatRetrieval.ts first, then exercises it)
//
// The retrieval contract for Chat: read eligible Markdown notes and PDFs
// locally, rank bounded passages for the question, and report what was
// searched and skipped. PDFs are read with the mocked vault bytes and the
// mocked pdf.js only — no network, no OCR, no vector service. Everything else
// under test is the real module.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Module from "node:module";

let ChatRetriever;
let currentPdfjs;

// The `obsidian` stub the bundle resolves. Only `loadPdfJs` is used at run
// time; the rest keep the module import from throwing.
const obsidian = {
  loadPdfJs: async () => currentPdfjs,
  TFile: class {},
  TAbstractFile: class {},
  Notice: class {},
  App: class {},
};

before(async () => {
  const out = await build({
    entryPoints: ["src/chatRetrieval.ts"],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    external: ["obsidian"],
    logLevel: "silent",
  });
  const filename = path.join(mkdtempSync(path.join(tmpdir(), "recall-rag-")), "chatRetrieval.cjs");
  const mod = new Module(filename);
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "obsidian") return obsidian;
    return origLoad.call(this, request, ...rest);
  };
  try {
    mod._compile(out.outputFiles[0].text, filename);
  } finally {
    Module._load = origLoad;
  }
  ChatRetriever = mod.exports.ChatRetriever;
});

/** A fake pdf.js whose document bytes are JSON `{ pages: [pageText, ...] }`. */
function pdfController() {
  const state = { opened: 0, destroyed: 0, pagesRead: 0, failPage: 0 };
  const pdfjs = {
    // Real pdf.js: getDocument() is synchronous and returns a loading task
    // whose `.promise` resolves to the document. loadPdfDocument reads
    // `.promise` synchronously, so an async getDocument here would not match.
    getDocument: ({ data }) => {
      const spec = JSON.parse(Buffer.from(data).toString("utf8"));
      state.opened++;
      const doc = {
        numPages: spec.pages.length,
        async getPage(n) {
          state.pagesRead++;
          if (state.failPage === n) throw new Error("page read failed");
          return {
            async getTextContent() {
              return { items: spec.pages[n - 1].split(/\s+/).filter(Boolean).map((str) => ({ str })) };
            },
          };
        },
        async destroy() {
          state.destroyed++;
        },
      };
      return { promise: Promise.resolve(doc) };
    },
  };
  return { pdfjs, state };
}

function defSize(e) {
  if (e.path.toLowerCase().endsWith(".pdf")) return e.size ?? JSON.stringify({ pages: e.pdf }).length;
  return e.size ?? (e.content ?? "").length;
}

/** An app whose vault is backed by a mutable list of entries. */
function makeApp(entries) {
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const reads = [];
  const filesNow = () =>
    entries.map((e) => ({
      path: e.path,
      basename: path.basename(e.path).replace(/\.[^.]+$/, ""),
      extension: (path.basename(e.path).split(".").pop() || "").toLowerCase(),
      stat: { size: defSize(e), mtime: e.mtime ?? 1 },
    }));
  return {
    app: {
      vault: {
        getFiles: () => filesNow(),
        cachedRead: async (f) => {
          reads.push(f.path);
          const e = byPath.get(f.path);
          if (e.readError) throw new Error(e.readError);
          return e.content;
        },
        readBinary: async (f) => {
          reads.push(f.path);
          return Buffer.from(JSON.stringify({ pages: byPath.get(f.path).pdf }), "utf8");
        },
      },
      metadataCache: {},
    },
    reads,
    entries,
  };
}

// --- PDF retrieval -----------------------------------------------------------

test("an uncaptured PDF page ranks for the question and keeps its page number", async () => {
  const pdf = pdfController();
  currentPdfjs = pdf.pdfjs;
  const { app } = makeApp([
    { path: "notes/unrelated.md", content: "Bananas are yellow fruit." },
    {
      path: "sources/nutrition.pdf",
      pdf: [
        "Cover and contents.",
        "A calorie is a unit of energy equal to 4.184 joules. It measures the energy food provides.",
        "Appendix and index.",
      ],
    },
  ]);
  const out = await new ChatRetriever(app, () => true).search("what is a calorie");
  assert.ok(out.seeds.length > 0);
  assert.equal(out.seeds[0].path, "sources/nutrition.pdf");
  assert.equal(out.seeds[0].page, 2);
  assert.equal(out.seeds[0].kind, "pdf");
  assert.match(out.seeds[0].text, /unit of energy/);
  assert.equal(out.searched, 2);
  assert.deepEqual(out.skipped, []);
});

test("a PDF page error is reported and the document is destroyed", async () => {
  const pdf = pdfController();
  currentPdfjs = pdf.pdfjs;
  pdf.state.failPage = 1;
  const { app } = makeApp([{ path: "bad.pdf", pdf: ["lunacat page one", "lunacat page two"] }]);
  const out = await new ChatRetriever(app, () => true).search("lunacat");
  assert.equal(pdf.state.destroyed, 1);
  assert.equal(out.searched, 0);
  assert.match(out.skipped.join("\n"), /bad\.pdf/);
});

test("cancelling mid-PDF stops the page loop and still destroys the document", async () => {
  const pdf = pdfController();
  currentPdfjs = pdf.pdfjs;
  const { app } = makeApp([{ path: "big.pdf", pdf: Array.from({ length: 10 }, (_, i) => `page ${i} about lunacat`) }]);
  let calls = 0;
  const out = await new ChatRetriever(app, () => true).search("lunacat", { cancelled: () => ++calls > 1 });
  assert.equal(pdf.state.destroyed, 1, "document destroyed on cancel");
  assert.ok(pdf.state.pagesRead <= 1, "did not keep reading pages after cancel");
  assert.deepEqual(out.seeds, []);
});

// --- Markdown retrieval ------------------------------------------------------

test("a Markdown passage keeps its original line number", async () => {
  const { app } = makeApp([{ path: "notes/a.md", content: "Alpha.\n\n".repeat(50) + "Lunacat means lunar navigation." }]);
  const out = await new ChatRetriever(app, () => true).search("what does lunacat mean");
  assert.equal(out.seeds.length, 1);
  assert.equal(out.seeds[0].text, "Lunacat means lunar navigation.");
  assert.equal(out.seeds[0].line, 101);
  assert.equal(out.seeds[0].page, null);
  assert.equal(out.seeds[0].kind, "note");
});

test("the ranked result is bounded to 40 chunks of at most 1200 characters each", async () => {
  const entries = Array.from({ length: 100 }, (_, i) => ({ path: `n${i}.md`, content: "Lunacat " + "description ".repeat(200) }));
  const { app } = makeApp(entries);
  const out = await new ChatRetriever(app, () => true).search("lunacat");
  assert.ok(out.seeds.length <= 40);
  assert.ok(out.seeds.every((s) => s.text.length <= 1200));
});

// --- cache -------------------------------------------------------------------

test("an unchanged source is not re-read, and a changed source is", async () => {
  const entries = [{ path: "a.md", content: "Lunacat alpha.", mtime: 1 }];
  const { app, reads } = makeApp(entries);
  const r = new ChatRetriever(app, () => true);
  await r.search("lunacat");
  await r.search("lunacat");
  assert.deepEqual(reads, ["a.md"], "unchanged file read once");
  entries[0].content = "Lunacat beta gamma.";
  entries[0].mtime = 2;
  const out = await r.search("lunacat");
  assert.equal(reads.length, 2, "changed file re-read");
  assert.match(out.seeds[0].text, /beta gamma/);
});

test("a deleted source leaves the cache and is not searched", async () => {
  const entries = [{ path: "a.md", content: "Lunacat." }];
  const { app } = makeApp(entries);
  const r = new ChatRetriever(app, () => true);
  await r.search("lunacat");
  entries.length = 0;
  const out = await r.search("lunacat");
  assert.deepEqual(out.seeds, []);
  assert.equal(out.searched, 0);
});

test("an excluded path is never read, and exclusion drops its cached text", async () => {
  const entries = [{ path: "secret.md", content: "Lunacat secret." }];
  let allowed = true;
  const { app, reads } = makeApp(entries);
  const r = new ChatRetriever(app, () => allowed);
  await r.search("lunacat");
  assert.deepEqual(reads, ["secret.md"]);
  allowed = false;
  const out = await r.search("lunacat");
  assert.deepEqual(out.seeds, []);
  assert.equal(out.searched, 0);
  allowed = true;
  await r.search("lunacat");
  assert.equal(reads.length, 2, "the excluded source's cache entry was dropped");
});

test("the source cache is bounded and drops the least recently added text", async () => {
  const entries = Array.from({ length: 13 }, (_, i) => ({
    path: `f${String(i).padStart(2, "0")}.md`,
    content: "lunacat ".repeat(124_000),
    mtime: 1,
  }));
  const { app, reads } = makeApp(entries);
  const r = new ChatRetriever(app, () => true);
  const first = await r.search("lunacat");
  assert.equal(first.searched, 13);
  const before = reads.filter((p) => p === "f00.md").length;
  await r.search("lunacat", { paths: ["f00.md"] });
  assert.equal(reads.filter((p) => p === "f00.md").length, before + 1, "the evicted entry was read again");
});

// --- scope -------------------------------------------------------------------

test("an explicit empty scope searches nothing and reads nothing", async () => {
  const { app, reads } = makeApp([{ path: "a.md", content: "Lunacat." }]);
  const out = await new ChatRetriever(app, () => true).search("lunacat", { paths: [] });
  assert.deepEqual(out.seeds, []);
  assert.equal(out.searched, 0);
  assert.deepEqual(reads, []);
});

test("an explicit scope reads only allowed paths", async () => {
  const { app, reads } = makeApp([
    { path: "a.md", content: "Lunacat a." },
    { path: "b.md", content: "Lunacat b." },
    { path: "private/secret.md", content: "Lunacat secret." },
  ]);
  const r = new ChatRetriever(app, (p) => !p.startsWith("private/"));
  const out = await r.search("lunacat", { paths: ["b.md", "private/secret.md"] });
  assert.deepEqual(reads, ["b.md"]);
  assert.deepEqual(out.seeds.map((s) => s.path), ["b.md"]);
  assert.equal(out.searched, 1);
});

// --- skipped reporting -------------------------------------------------------

test("oversized, unreadable, image-only and over-limit sources are reported as skipped", async () => {
  const pdf = pdfController();
  currentPdfjs = pdf.pdfjs;
  const { app } = makeApp([
    { path: "huge.md", content: "lunacat huge", size: 2_000_000 },
    { path: "broken.md", content: "lunacat broken", readError: "ENOENT" },
    { path: "scan.pdf", pdf: ["", ""] },
    { path: "big.pdf", pdf: ["x"], size: 41_000_000 },
    { path: "long.pdf", pdf: Array.from({ length: 501 }, () => "page") },
    { path: "ok.md", content: "Lunacat is a fixture." },
  ]);
  const out = await new ChatRetriever(app, () => true).search("lunacat");
  assert.deepEqual(out.seeds.map((s) => s.path), ["ok.md"]);
  assert.equal(out.searched, 1);
  const joined = out.skipped.join("\n");
  for (const name of ["huge.md", "broken.md", "scan.pdf", "big.pdf", "long.pdf"]) {
    assert.match(joined, new RegExp(name.replace(".", "\\.")));
  }
});

// --- model-supplied search terms ---------------------------------------------

test("model-supplied terms widen the search but are not themselves evidence", async () => {
  const { app } = makeApp([{ path: "a.md", content: "Lunacat means lunar navigation." }]);
  const out = await new ChatRetriever(app, () => true).search("what does this mean", { terms: ["lunacat"] });
  assert.deepEqual(out.seeds.map((s) => s.path), ["a.md"]);
  assert.ok(out.seeds.every((s) => s.text !== "lunacat"));
  const none = await new ChatRetriever(app, () => true).search("what does this mean", { terms: ["zebra"] });
  assert.deepEqual(none.seeds, []);
});
