// Run with: npm test  (bundles src/anthropic.ts with an `obsidian` stub whose
// requestUrl the test answers itself, so the SDK's requests never leave the
// process)
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const OBSIDIAN_STUB = {
  name: "obsidian-stub",
  setup(b) {
    b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents:
        "export const requestUrl = (req) => { if (globalThis.__fakeRequestUrl) return globalThis.__fakeRequestUrl(req); throw new Error('no network in tests'); };",
    }));
  },
};

let an;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
  const out = path.join(dir, "anthropic.mjs");
  await build({
    entryPoints: ["src/anthropic.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    plugins: [OBSIDIAN_STUB],
    logLevel: "silent",
  });
  an = await import(pathToFileURL(out).href);
});

afterEach(() => {
  delete globalThis.__fakeRequestUrl;
});

const settings = () => ({ apiKey: "test-key", model: "claude-test", effort: "low" });

/** Answers the Messages API call with one text block and the given stop reason. */
function replyWith(text, stop_reason) {
  const body = {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "text", text }],
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 5 },
  };
  globalThis.__fakeRequestUrl = async () => ({
    status: 200,
    headers: { "content-type": "application/json" },
    arrayBuffer: new TextEncoder().encode(JSON.stringify(body)).buffer,
  });
}

// Every value of the installed SDK's StopReason
// (node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts).
test("anthropicStop: max_tokens and a full context window are a length, a finished turn an end", () => {
  assert.equal(an.anthropicStop("end_turn"), "end");
  assert.equal(an.anthropicStop("stop_sequence"), "end");
  assert.equal(an.anthropicStop("max_tokens"), "length");
  assert.equal(an.anthropicStop("model_context_window_exceeded"), "length");
  assert.equal(an.anthropicStop("pause_turn"), "other");
  assert.equal(an.anthropicStop("tool_use"), "other");
  assert.equal(an.anthropicStop("refusal"), "other");
  assert.equal(an.anthropicStop(null), "unknown");
  assert.equal(an.anthropicStop("something_new"), "unknown");
});

test("completeText: an answer cut off at max_tokens comes back with a length stop", async () => {
  replyWith("The first half of a pa", "max_tokens");
  const stops = [];
  const text = await new an.AnthropicBackend(settings).completeText({ system: "", user: "Write.", maxTokens: 10, onStop: (s) => stops.push(s) });
  assert.equal(text, "The first half of a pa");
  assert.deepEqual(stops, ["length"]);
});

test("completeText: a finished turn comes back with an end stop", async () => {
  replyWith("Done.", "end_turn");
  const stops = [];
  const text = await new an.AnthropicBackend(settings).completeText({ system: "s", user: "u", maxTokens: 10, onStop: (s) => stops.push(s) });
  assert.equal(text, "Done.");
  assert.deepEqual(stops, ["end"]);
});

test("completeText: a refusal throws and reports no stop", async () => {
  replyWith("", "refusal");
  const stops = [];
  await assert.rejects(
    new an.AnthropicBackend(settings).completeText({ system: "", user: "u", maxTokens: 10, onStop: (s) => stops.push(s) }),
    /declined/,
  );
  assert.deepEqual(stops, []);
});
