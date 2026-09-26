// Run with: npm test  (bundles src/gemini.ts first, then exercises the pure helpers with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const OBSIDIAN_STUB = {
  name: "obsidian-stub",
  setup(b) {
    b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export const requestUrl = () => { throw new Error('no network in tests'); };",
    }));
  },
};

let g;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
  const out = path.join(dir, "gemini.mjs");
  await build({
    entryPoints: ["src/gemini.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    plugins: [OBSIDIAN_STUB],
    logLevel: "silent",
  });
  g = await import(pathToFileURL(out).href);
});

test("toGeminiSchema: drops $schema and additionalProperties at every depth", () => {
  const schema = z.object({
    cards: z.array(z.object({ front: z.string(), back: z.string() })),
  });
  const js = g.toGeminiSchema(schema);
  assert.equal(js.$schema, undefined);
  assert.equal(js.additionalProperties, undefined);
  assert.equal(js.properties.cards.items.additionalProperties, undefined);
  // The shape the model needs is still intact.
  assert.equal(js.type, "object");
  assert.equal(js.properties.cards.type, "array");
  assert.deepEqual(js.properties.cards.items.required, ["front", "back"]);
});

test("readGeminiText: concatenates text parts and skips thought parts", () => {
  const body = {
    candidates: [{ content: { parts: [{ text: "reasoning", thought: true }, { text: '{"ok":' }, { text: "true}" }] } }],
  };
  assert.deepEqual(g.readGeminiText(body), { text: '{"ok":true}', error: null });
});

test("readGeminiText: surfaces API errors, blocks, refusals and token exhaustion", () => {
  assert.deepEqual(g.readGeminiText({ error: { message: "API key not valid" } }), { text: null, error: "API key not valid" });
  assert.deepEqual(g.readGeminiText({ promptFeedback: { blockReason: "SAFETY" } }), {
    text: null,
    error: "The request was blocked (SAFETY).",
  });
  assert.deepEqual(g.readGeminiText({ candidates: [{ finishReason: "SAFETY" }] }), {
    text: null,
    error: "The model declined this request.",
  });
  assert.deepEqual(g.readGeminiText({ candidates: [{ finishReason: "MAX_TOKENS" }] }), {
    text: null,
    error: "The model ran out of output tokens before answering.",
  });
});

test("readGeminiText: empty and malformed bodies report no text rather than throwing", () => {
  assert.deepEqual(g.readGeminiText(null), { text: null, error: null });
  assert.deepEqual(g.readGeminiText({}), { text: null, error: null });
  assert.deepEqual(g.readGeminiText({ candidates: [{ content: { parts: [] } }] }), { text: null, error: null });
});
