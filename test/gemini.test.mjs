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
      // A test may answer requests itself through globalThis.__fakeRequestUrl;
      // otherwise any request fails, so nothing reaches the network.
      contents:
        "export const requestUrl = (req) => { if (globalThis.__fakeRequestUrl) return globalThis.__fakeRequestUrl(req); throw new Error('no network in tests'); };",
    }));
  },
};

let g;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wikilm-test-"));
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

// Why the model stopped, which upstream's engine needs through the adapter
// (src/upstream/llmAdapter.ts) to keep a page when a rewrite was cut off.
test("geminiStop: STOP is an end, MAX_TOKENS a length, a missing reason unknown, any other named reason other", () => {
  const withReason = (finishReason) => ({ candidates: [{ finishReason, content: { parts: [{ text: "x" }] } }] });
  assert.equal(g.geminiStop(withReason("STOP")), "end");
  assert.equal(g.geminiStop(withReason("MAX_TOKENS")), "length");
  assert.equal(g.geminiStop(withReason("RECITATION")), "other");
  assert.equal(g.geminiStop(withReason("OTHER")), "other");
  assert.equal(g.geminiStop(withReason("FINISH_REASON_UNSPECIFIED")), "unknown");
  assert.equal(g.geminiStop(withReason(undefined)), "unknown");
  assert.equal(g.geminiStop({ candidates: [] }), "unknown");
  assert.equal(g.geminiStop(null), "unknown");
});

function geminiSettings() {
  return { geminiApiKey: "test-key", geminiModel: "gemini-test", effort: "low" };
}

/** Answers every request with `body`, as requestUrl would. */
function answerWith(body, status = 200) {
  globalThis.__fakeRequestUrl = async () => ({ status, json: body });
}

test("completeText: an answer cut off at the token cap comes back with a length stop", async (t) => {
  t.after(() => delete globalThis.__fakeRequestUrl);
  answerWith({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "The first half of a pa" }] } }] });
  const stops = [];
  const text = await new g.GeminiBackend(geminiSettings).completeText({ system: "", user: "Write.", maxTokens: 10, onStop: (s) => stops.push(s) });
  assert.equal(text, "The first half of a pa");
  assert.deepEqual(stops, ["length"]);
});

test("completeText: a finished answer comes back with an end stop", async (t) => {
  t.after(() => delete globalThis.__fakeRequestUrl);
  answerWith({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Done." }] } }] });
  const stops = [];
  const text = await new g.GeminiBackend(geminiSettings).completeText({ system: "s", user: "u", maxTokens: 10, onStop: (s) => stops.push(s) });
  assert.equal(text, "Done.");
  assert.deepEqual(stops, ["end"]);
});

test("completeText: a failed request reports no stop", async (t) => {
  t.after(() => delete globalThis.__fakeRequestUrl);
  answerWith({ error: { message: "backend exploded" } }, 500);
  const stops = [];
  await assert.rejects(
    new g.GeminiBackend(geminiSettings).completeText({ system: "", user: "u", maxTokens: 10, onStop: (s) => stops.push(s) }),
    /backend exploded/,
  );
  assert.deepEqual(stops, []);
});

// Codex and the Claude CLI throw a cancel as kind "aborted"; Gemini does too.
test("completeText: a cancelled call throws kind aborted, not failed", async (t) => {
  t.after(() => delete globalThis.__fakeRequestUrl);
  const before = new AbortController();
  before.abort();
  await assert.rejects(
    new g.GeminiBackend(geminiSettings).completeText({ system: "", user: "u", maxTokens: 10, signal: before.signal }),
    (e) => e.name === "GeminiError" && e.kind === "aborted",
  );

  // Cancelled while the request was out: requestUrl cannot be stopped, so
  // the answer is thrown away when it arrives.
  const during = new AbortController();
  globalThis.__fakeRequestUrl = async () => {
    during.abort();
    return { status: 200, json: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "late" }] } }] } };
  };
  await assert.rejects(
    new g.GeminiBackend(geminiSettings).completeText({ system: "", user: "u", maxTokens: 10, signal: during.signal }),
    (e) => e.name === "GeminiError" && e.kind === "aborted",
  );
});
