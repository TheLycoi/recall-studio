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

test("modelOptions lists the found models first, then the value in use and the fallbacks, once each", () => {
  assert.deepEqual(mr.modelOptions(["a", "b"], "b", ["c", "a"]), ["a", "b", "c"]);
  assert.deepEqual(mr.modelOptions(undefined, "gpt-5.5", mr.CODEX_FALLBACK_MODELS), ["gpt-5.5", "gpt-5.6-luna", "gpt-5.6-terra"]);
  assert.deepEqual(mr.modelOptions([], " ", []), []);
});

test("readCodexModels takes the slugs from the cache and nothing from garbage", () => {
  assert.deepEqual(mr.readCodexModels(JSON.stringify({ models: [{ slug: "gpt-5.5" }, { slug: "gpt-5.6-luna" }, { nope: 1 }] })), ["gpt-5.5", "gpt-5.6-luna"]);
  assert.deepEqual(mr.readCodexModels("not json"), []);
  assert.deepEqual(mr.readCodexModels(null), []);
});
