// Run with: npm test  (bundles src/modelRoles.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let mr;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wikilm-roles-"));
  const out = path.join(dir, "modelRoles.mjs");
  await build({ entryPoints: ["src/modelRoles.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  mr = await import(pathToFileURL(out).href);
});

const base = () => ({
  provider: "claudecli",
  model: "claude-opus-5",
  geminiModel: "gemini-3.1-pro-preview",
  codexModel: "gpt-5.5",
  claudeCliModel: "opus",
  rolesEnabled: false,
  roles: { lint: { provider: "default", model: "" }, query: { provider: "anthropic", model: "claude-haiku-4-5-20251001" }, digest: { provider: "gemini", model: "" } },
});

test("resolveRole follows the main provider and its model unless roles are enabled", () => {
  assert.deepEqual(mr.resolveRole(base(), "query"), { provider: "claudecli", model: "opus" });
  assert.deepEqual(mr.resolveRole(base(), undefined), { provider: "claudecli", model: "opus" });
});

test("resolveRole with roles enabled: a role's own provider and model, the provider's model when the role names none, the main choice for 'default'", () => {
  const s = { ...base(), rolesEnabled: true };
  assert.deepEqual(mr.resolveRole(s, "query"), { provider: "anthropic", model: "claude-haiku-4-5-20251001" });
  assert.deepEqual(mr.resolveRole(s, "digest"), { provider: "gemini", model: "gemini-3.1-pro-preview" });
  assert.deepEqual(mr.resolveRole(s, "lint"), { provider: "claudecli", model: "opus" });
  assert.deepEqual(mr.resolveRole(s, undefined), { provider: "claudecli", model: "opus" }, "unlabelled work is the main choice");
});

test("modelOptions lists the found models first, then the value in use and the fallbacks, once each", () => {
  assert.deepEqual(mr.modelOptions(["a", "b"], "b", ["c", "a"]), ["a", "b", "c"]);
  assert.deepEqual(mr.modelOptions(undefined, "opus", mr.CLAUDE_CLI_MODELS), ["opus", "sonnet", "haiku", "fable"]);
  assert.deepEqual(mr.modelOptions([], " ", []), []);
});

test("readCodexModels takes the slugs from the cache and nothing from garbage", () => {
  assert.deepEqual(mr.readCodexModels(JSON.stringify({ models: [{ slug: "gpt-5.5" }, { slug: "gpt-5.6-luna" }, { nope: 1 }] })), ["gpt-5.5", "gpt-5.6-luna"]);
  assert.deepEqual(mr.readCodexModels("not json"), []);
  assert.deepEqual(mr.readCodexModels(null), []);
});

test("readGeminiModels keeps only models that answer generateContent, without the models/ prefix", () => {
  const body = { models: [
    { name: "models/gemini-3.1-pro-preview", supportedGenerationMethods: ["generateContent", "countTokens"] },
    { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
    { name: "models/gemini-3-flash-preview", supportedGenerationMethods: ["generateContent"] },
  ] };
  assert.deepEqual(mr.readGeminiModels(body), ["gemini-3.1-pro-preview", "gemini-3-flash-preview"]);
  assert.deepEqual(mr.readGeminiModels({}), []);
});
