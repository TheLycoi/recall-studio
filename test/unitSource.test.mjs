// Run with: npm test  (bundles src/unitSource.ts, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let u;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
  const out = path.join(dir, "unitSource.mjs");
  await build({ entryPoints: ["src/unitSource.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  u = await import(pathToFileURL(out).href);
});

const unit = (over = {}) => ({
  id: "wiki/concepts/free-recall.md#p0",
  notePath: "wiki/concepts/free-recall.md",
  noteTitle: "Free recall",
  pdfBasename: null,
  target: null,
  page: null,
  text: "Free recall asks for everything remembered with no cue.",
  kind: "claim",
  classCodes: [],
  section: "Definition",
  ...over,
});

test("a miss from a wiki page points at the page and names its section", () => {
  assert.deepEqual(u.resolveUnitSource(unit(), () => null), {
    sourcePath: "wiki/concepts/free-recall.md",
    page: null,
    heading: "Free recall › Definition",
    subpath: undefined,
  });
});

test("a miss from the lead of a page is headed by the page title alone", () => {
  assert.equal(u.resolveUnitSource(unit({ section: "" }), () => null).heading, "Free recall");
});

test("a miss backed by a PDF selection points at the PDF page", () => {
  const target = { page: 3, selection: { beginIndex: 4, beginOffset: 0, endIndex: 6, endOffset: 12 } };
  const got = u.resolveUnitSource(unit({ pdfBasename: "Lecture 2", target, page: 3 }), () => ({ path: "sources/Lecture 2.pdf" }));
  assert.equal(got.sourcePath, "sources/Lecture 2.pdf");
  assert.equal(got.page, 3);
  assert.equal(got.heading, "page 3");
  assert.ok(typeof got.subpath === "string" && got.subpath.length > 0);
});
