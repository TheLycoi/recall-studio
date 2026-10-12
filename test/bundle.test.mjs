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

test("the bundle talks to no model API but the ones it offers", () => {
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

test("the bundle reaches DeepSeek over its own API", () => {
  assert.ok(js.includes("api.deepseek.com"));
  assert.ok(js.includes("json_object"));
  // The Anthropic-shaped DeepSeek endpoint is deliberately unused: JSON mode on
  // the OpenAI-shaped one is what the backend validates against.
  assert.equal(js.includes("api.deepseek.com/anthropic"), false);
});

test("both backends are in src, and the dead ones stay out", () => {
  const files = readdirSync("src");
  for (const gone of ["anthropic.ts", "gemini.ts", "claudeCli.ts", "keys.ts"]) assert.equal(files.includes(gone), false, gone);
  assert.ok(files.includes("codex.ts"));
  assert.ok(files.includes("deepseek.ts"));
  assert.ok(files.includes("opencode.ts"));
});

test("the bundle runs opencode, and locks it down", () => {
  assert.ok(js.includes("opencode"));
  assert.ok(js.includes("--format"));
  // The two things that make the run safe and parseable: the agent name, and
  // the deny-all permissions in the config the run works beside. A build that
  // lost either would look fine and quietly allow tools.
  assert.ok(js.includes("recall"), "the agent name is missing");
  assert.ok(js.includes("opencode.json"), "the agent config is never written");
  assert.ok(js.includes('"deny"'), "the deny-everything rule is missing");
});

test("opencode owns its credentials, so no key handling rode along", () => {
  // The whole point of this provider: opencode resolves its own auth. A key
  // field, a keychain lookup or an Authorization header here would be a second
  // credential path nobody asked for.
  assert.equal(js.includes("Recall OpenCode"), false);
  assert.equal(js.includes("opencodeApiKey"), false);
  assert.equal(js.includes("OpenCode API key"), false);
});

test("the bundle still posts to no model API itself on the OpenCode path", () => {
  // OpenCode talks to its providers; Recall talks to OpenCode. The one HTTP
  // endpoint in the bundle stays DeepSeek's.
  assert.equal(js.includes("127.0.0.1:4096"), false);
  assert.equal(js.includes("opencode.ai/zen"), false);
});
