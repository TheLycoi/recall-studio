// Run with: npm test  (bundles src/codex.ts first, then exercises the pure helpers with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

let c;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
  const out = path.join(dir, "codex.mjs");
  await build({ entryPoints: ["src/codex.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  c = await import(pathToFileURL(out).href);
});

const ev = (o) => JSON.stringify(o);

test("parseCodexEvents: last completed agent_message wins, stray lines skipped", () => {
  const stdout = [
    ev({ type: "thread.started", thread_id: "t1" }),
    "Reading prompt from stdin...",
    ev({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "working on it" } }),
    ev({ type: "item.completed", item: { id: "r1", type: "reasoning", text: "thinking" } }),
    ev({ type: "item.started", item: { id: "m2", type: "agent_message", text: '{"cards":' } }),
    ev({ type: "item.completed", item: { id: "m2", type: "agent_message", text: '{"cards":[]}' } }),
    ev({ type: "item.updated", item: { id: "m2", type: "agent_message", text: "stale" } }),
    ev({ type: "turn.completed", usage: {} }),
  ].join("\n");
  assert.deepEqual(c.parseCodexEvents(stdout), { text: '{"cards":[]}', error: null });
});

test("parseCodexEvents: turn.failed and error events surface a message", () => {
  const stdout = [ev({ type: "turn.started" }), ev({ type: "turn.failed", error: { message: "usage limit reached" } })].join("\n");
  assert.deepEqual(c.parseCodexEvents(stdout), { text: null, error: "usage limit reached" });
  assert.deepEqual(c.parseCodexEvents(ev({ type: "error", message: "boom" })), { text: null, error: "boom" });
  assert.deepEqual(c.parseCodexEvents(""), { text: null, error: null });
});

test("extractJson strips fences and surrounding prose", () => {
  assert.equal(c.extractJson('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(c.extractJson('{"a":1}'), '{"a":1}');
  assert.equal(c.extractJson('Here you go:\n{"a":{"b":[1,2]}}\nDone.'), '{"a":{"b":[1,2]}}');
  assert.equal(c.extractJson("  [1,2]  "), "[1,2]");
});

test("clampEffort walks down to the highest supported level", () => {
  const gpt55 = ["low", "medium", "high", "xhigh"];
  assert.equal(c.clampEffort("max", gpt55), "xhigh");
  assert.equal(c.clampEffort("high", gpt55), "high");
  assert.equal(c.clampEffort("max", c.EFFORT_ORDER), "max");
  assert.equal(c.clampEffort("weird", gpt55), "weird");
});

test("readSupportedEfforts reads models_cache.json and falls back to the static table", () => {
  const cache = JSON.stringify({
    models: [{ slug: "gpt-5.6-luna", supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }] }],
  });
  assert.deepEqual(c.readSupportedEfforts("gpt-5.6-luna", cache), ["low", "max"]);
  assert.deepEqual(c.readSupportedEfforts("gpt-5.5", cache), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(c.readSupportedEfforts("gpt-5.5", null), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(c.readSupportedEfforts("unknown-model", "not json"), [...c.EFFORT_ORDER]);
});

test("toStrictSchema drops $schema and keeps strict-mode keywords", () => {
  const schema = z.object({ cards: z.array(z.object({ kind: z.enum(["qa", "cloze"]).describe("card kind"), front: z.string() })) });
  const js = c.toStrictSchema(schema);
  assert.equal(js.$schema, undefined);
  assert.equal(js.additionalProperties, false);
  assert.deepEqual(js.required, ["cards"]);
  const item = js.properties.cards.items;
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(item.required, ["kind", "front"]);
  assert.equal(item.properties.kind.description, "card kind");
});

test("codexCandidates: configured path is authoritative, otherwise PATH then bundled app", () => {
  assert.deepEqual(c.codexCandidates("/x/codex", { PATH: "/a:/b" }, "/home/u"), ["/x/codex"]);
  const list = c.codexCandidates("", { PATH: "/a:/opt/homebrew/bin" }, "/home/u");
  assert.equal(list[0], "/a/codex");
  assert.equal(list[1], "/opt/homebrew/bin/codex");
  assert.equal(list.filter((p) => p === "/opt/homebrew/bin/codex").length, 1);
  assert.ok(list.includes("/home/u/.local/bin/codex"));
  assert.equal(list[list.length - 1], c.BUNDLED_CODEX);
});

test("cleanStderr drops the stdin notice", () => {
  assert.equal(c.cleanStderr("Reading prompt from stdin...\nError: not logged in\n"), "Error: not logged in");
});

/** An executable that stands in for `codex`: reads its stdin and prints `stdout`. */
function fakeCodex(stdout) {
  const dir = mkdtempSync(path.join(tmpdir(), "wikilm-fake-codex-"));
  const bin = path.join(dir, "codex");
  writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\ncat <<'EVENTS'\n${stdout}\nEVENTS\n`);
  chmodSync(bin, 0o755);
  return bin;
}

// `codex exec --json` says nothing about why the model stopped: its events
// carry the agent message and, at the end of a turn, token usage only.
test("completeText reports an unknown stop, since codex's events carry none", async () => {
  const stdout = [
    ev({ type: "thread.started", thread_id: "t" }),
    ev({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "A page body." } }),
    ev({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } }),
  ].join("\n");
  const b = new c.CodexBackend(() => ({ effort: "low", codexPath: fakeCodex(stdout), codexModel: "gpt-5.5" }));
  const stops = [];
  assert.equal(await b.completeText({ system: "", user: "u", maxTokens: 10, onStop: (s) => stops.push(s) }), "A page body.");
  assert.deepEqual(stops, ["unknown"]);
});
