// Run with: npm test  (bundles src/main.ts the way the plugin build does, then reads the output as text)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sharedBuildOptions } from "../scripts/esbuild-shared.mjs";

let js;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
  const out = path.join(dir, "main.js");
  await build({ ...sharedBuildOptions(), entryPoints: ["src/main.ts"], outfile: out, logLevel: "silent" });
  js = readFileSync(out, "utf8");
});

test("the bundle talks to no model API", () => {
  for (const gone of ["api.anthropic.com", "generativelanguage.googleapis.com", "@anthropic-ai", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"]) {
    assert.equal(js.includes(gone), false, gone);
  }
});

test("the bundle holds nothing of the wiki engine", () => {
  for (const gone of ["llm-wiki", "Smart Fix", "## Key claims", "digest-pdf-highlights"]) {
    assert.equal(js.includes(gone), false, gone);
  }
});

test("the bundle still runs Codex", () => {
  assert.ok(js.includes("codex"));
  assert.ok(js.includes("--output-schema"));
});

test("only the Codex backend is left in src", () => {
  const files = readdirSync("src");
  for (const gone of ["anthropic.ts", "gemini.ts", "claudeCli.ts", "keys.ts"]) assert.equal(files.includes(gone), false, gone);
  assert.ok(files.includes("codex.ts"));
});
