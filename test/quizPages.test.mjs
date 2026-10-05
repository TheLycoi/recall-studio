// Run with: npm test  (bundles src/quizPages.ts, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let q;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
  const out = path.join(dir, "quizPages.mjs");
  await build({ entryPoints: ["src/quizPages.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  q = await import(pathToFileURL(out).href);
});

test("concept, entity and source pages are quiz pages", () => {
  assert.equal(q.isQuizPage("wiki/concepts/free-recall.md", "wiki"), true);
  assert.equal(q.isQuizPage("wiki/entities/piotr-wozniak.md", "wiki"), true);
  assert.equal(q.isQuizPage("wiki/sources/a-paper_ff54d5.md", "wiki/"), true);
});

test("the wiki plugin's own files are not quiz pages", () => {
  assert.equal(q.isQuizPage("wiki/schema/config.md", "wiki"), false);
  assert.equal(q.isQuizPage("wiki/index.md", "wiki"), false);
  assert.equal(q.isQuizPage("wiki/log.md", "wiki"), false);
  assert.equal(q.isQuizPage("wiki/Welcome to Karpathy LLM Wiki.md", "wiki"), false);
});

test("files outside the wiki folder, and files that are not markdown, are not quiz pages", () => {
  assert.equal(q.isQuizPage("Recall/recall-rules.md", "wiki"), false);
  assert.equal(q.isQuizPage("wikipedia/concepts/x.md", "wiki"), false);
  assert.equal(q.isQuizPage("wiki/sources/paper.pdf", "wiki"), false);
  assert.equal(q.isQuizPage("wiki/concepts/x.md", ""), false);
});
