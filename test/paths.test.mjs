// Run with: npm test  (bundles src/paths.ts, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let p;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
  const out = path.join(dir, "paths.mjs");
  await build({ entryPoints: ["src/paths.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  p = await import(pathToFileURL(out).href);
});

test("the quiz reads the wiki folder by default", () => {
  assert.equal(p.DEFAULT_WIKI_FOLDER, "wiki");
});

test("Recall's own files default to a folder outside the wiki", () => {
  assert.equal(p.isUnderFolder(p.DEFAULT_RULES_FOLDER, p.DEFAULT_WIKI_FOLDER), false);
  assert.equal(p.isUnderFolder(p.DEFAULT_EXPORT_FOLDER, p.DEFAULT_WIKI_FOLDER), false);
  assert.equal(p.isUnderFolder(`${p.DEFAULT_RULES_FOLDER}/recall-rules.md`, p.DEFAULT_WIKI_FOLDER), false);
});

test("isUnderFolder matches whole path segments", () => {
  assert.equal(p.isUnderFolder("wiki/schema/config.md", "wiki"), true);
  assert.equal(p.isUnderFolder("wiki", "wiki"), true);
  assert.equal(p.isUnderFolder("wikipedia/x.md", "wiki"), false);
  assert.equal(p.isUnderFolder("Recall/x.md", "wiki/"), false);
});

test("capture never marks a page under the wiki folder", () => {
  assert.equal(p.mayMark("wiki/concepts/free-recall.md", "wiki"), false);
  assert.equal(p.mayMark("wiki/sources/paper.md", "wiki/"), false);
  assert.equal(p.mayMark("Lectures/week 3.md", "wiki"), true);
  assert.equal(p.mayMark("wikipedia/x.md", "wiki"), true);
});
