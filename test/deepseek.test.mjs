// Run with: npm test
//
// The DeepSeek provider's pure parts: its effort mapping, its model list, the
// reading of a chat-completions response, and the key resolution order. None
// of these touch the network, and none of them import `obsidian` (which is why
// they live in deepseekModels.ts / deepseekWire.ts / deepseekKey.ts rather than
// in deepseek.ts, whose requestUrl import cannot be bundled for node).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

let models, wire, keys, jsonOut, errors;

async function bundle(entry, name) {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-deepseek-"));
  const out = path.join(dir, `${name}.mjs`);
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  return import(pathToFileURL(out).href);
}

before(async () => {
  models = await bundle("src/deepseekModels.ts", "deepseekModels");
  wire = await bundle("src/deepseekWire.ts", "deepseekWire");
  keys = await bundle("src/deepseekKey.ts", "deepseekKey");
  jsonOut = await bundle("src/jsonOut.ts", "jsonOut");
  errors = await bundle("src/deepseekError.ts", "deepseekError");
});

// --------------------------------------------------------------- effort

test("deepSeekEffort maps Recall's five levels onto DeepSeek's four", () => {
  // The API accepts none, low, high, max. Recall never asks for none: every
  // call either writes cards or grades an answer, and both want thinking on.
  assert.equal(models.deepSeekEffort("low"), "low");
  assert.equal(models.deepSeekEffort("high"), "high");
  assert.equal(models.deepSeekEffort("max"), "max");
  // medium and xhigh have no DeepSeek equivalent; the API's own documented
  // mapping sends both to high.
  assert.equal(models.deepSeekEffort("medium"), "high");
  assert.equal(models.deepSeekEffort("xhigh"), "high");
  // An unrecognised value is not passed through: "none" would disable the
  // thinking Recall wants, so anything unknown lands on high.
  assert.equal(models.deepSeekEffort("none"), "high");
  assert.equal(models.deepSeekEffort(""), "high");
});

test("the fallback models exclude the retired legacy names", () => {
  // deepseek-flash is the current canonical cheap name; deepseek-v4-flash is
  // only a legacy alias the API accepts, served by a retired model.
  assert.deepEqual(models.DEEPSEEK_FALLBACK_MODELS, ["deepseek-v4-pro", "deepseek-flash"]);
  for (const gone of ["deepseek-chat", "deepseek-reasoner"]) {
    assert.equal(models.DEEPSEEK_FALLBACK_MODELS.includes(gone), false, gone);
  }
});

test("the DeepSeek base URL is the OpenAI-shaped endpoint", () => {
  assert.equal(models.DEEPSEEK_BASE_URL, "https://api.deepseek.com");
});

// ----------------------------------------------------------- model list

test("readDeepSeekModels takes the ids from a /models body and nothing from garbage", () => {
  assert.deepEqual(models.readDeepSeekModels({ data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-v4-flash" }, { nope: 1 }] }), [
    "deepseek-v4-pro",
    "deepseek-v4-flash",
  ]);
  assert.deepEqual(models.readDeepSeekModels({ data: "not an array" }), []);
  assert.deepEqual(models.readDeepSeekModels({}), []);
  assert.deepEqual(models.readDeepSeekModels(null), []);
  assert.deepEqual(models.readDeepSeekModels("not json"), []);
});

// ------------------------------------------------------ reading a reply

test("readChoice pulls the assistant text and maps finish_reason", () => {
  const body = (finish_reason, content) => ({ choices: [{ message: { content }, finish_reason }] });
  assert.deepEqual(wire.readChoice(body("stop", '{"cards":[]}')), { content: '{"cards":[]}', stop: "end" });
  assert.deepEqual(wire.readChoice(body("length", '{"cards":[')), { content: '{"cards":[', stop: "length" });
  assert.deepEqual(wire.readChoice(body("content_filter", "x")), { content: "x", stop: "other" });
  // A reason the provider never states must read "unknown", never "end": the
  // difference is whether a truncated answer looks finished.
  assert.deepEqual(wire.readChoice(body(undefined, "x")), { content: "x", stop: "unknown" });
});

test("readChoice survives a body that is not a chat completion", () => {
  assert.deepEqual(wire.readChoice({}), { content: "", stop: "unknown" });
  assert.deepEqual(wire.readChoice({ choices: [] }), { content: "", stop: "unknown" });
  assert.deepEqual(wire.readChoice({ choices: [{ message: { content: 42 } }] }), { content: "", stop: "unknown" });
  assert.deepEqual(wire.readChoice(null), { content: "", stop: "unknown" });
});

test("errorMessage reads DeepSeek's error, in either documented shape", () => {
  assert.equal(wire.errorMessage({ error: { message: "Insufficient Balance" } }), "Insufficient Balance");
  assert.equal(wire.errorMessage({ error: "plain string" }), "plain string");
  assert.equal(wire.errorMessage({ error: {} }), null);
  assert.equal(wire.errorMessage({}), null);
  assert.equal(wire.errorMessage(null), null);
});

// --------------------------------------------------------- JSON preamble

test("jsonPreamble says json, and carries the schema", () => {
  const schema = z.object({ cards: z.array(z.object({ front: z.string() })) });
  const preamble = wire.jsonPreamble(schema);
  // JSON mode requires the word "json" in the prompt, or the API refuses.
  assert.match(preamble, /JSON/i);
  assert.match(preamble, /"cards"/);
  assert.match(preamble, /"front"/);
  // The schema is described because the API enforces valid JSON and not its
  // shape; this text plus the local safeParse is what enforces the shape.
  assert.equal(preamble.includes("$schema"), false);
});

test("jsonPreamble embeds a parseable JSON Schema", () => {
  const schema = z.object({ ready: z.boolean() });
  const block = wire.jsonPreamble(schema).split("\n").slice(3).join("\n");
  const parsed = JSON.parse(block);
  assert.equal(parsed.type, "object");
  assert.deepEqual(parsed.required, ["ready"]);
});

// ---------------------------------------------------------- JSON reading

test("extractJson strips fences and prose around the value", () => {
  assert.equal(jsonOut.extractJson('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(jsonOut.extractJson('{"a":1}'), '{"a":1}');
  assert.equal(jsonOut.extractJson("Here you go:\n{\"a\":{\"b\":[1,2]}}\nDone."), '{"a":{"b":[1,2]}}');
  assert.equal(jsonOut.extractJson("  [1,2]  "), "[1,2]");
});

test("schemaJson drops $schema and keeps the rest", () => {
  const js = jsonOut.schemaJson(z.object({ a: z.string() }));
  assert.equal(js.$schema, undefined);
  assert.equal(js.type, "object");
});

// ------------------------------------------------------------ key lookup

test("resolveDeepSeekKey prefers the setting, then the environment, then the keychain", () => {
  keys.forgetCachedKey();
  const none = () => undefined;
  assert.deepEqual(keys.resolveDeepSeekKey("sk-setting", {}, none), { key: "sk-setting", source: "settings" });
  assert.deepEqual(keys.resolveDeepSeekKey("", { DEEPSEEK_API_KEY: "sk-env" }, none), { key: "sk-env", source: "environment" });
  keys.forgetCachedKey();
  assert.deepEqual(
    keys.resolveDeepSeekKey("", {}, (s) => (s === "Recall DeepSeek API key" ? "sk-keychain" : undefined)),
    { key: "sk-keychain", source: "keychain" },
  );
  keys.forgetCachedKey();
  assert.deepEqual(keys.resolveDeepSeekKey("", {}, none), { key: "", source: "none" });
});

test("resolveDeepSeekKey ignores blank values at every level", () => {
  keys.forgetCachedKey();
  const none = () => undefined;
  // A key of spaces in settings is not a key; it must not shadow the env var.
  assert.deepEqual(keys.resolveDeepSeekKey("   ", { DEEPSEEK_API_KEY: "sk-env" }, none), { key: "sk-env", source: "environment" });
  assert.deepEqual(keys.resolveDeepSeekKey("", { DEEPSEEK_API_KEY: "  " }, none), { key: "", source: "none" });
  assert.deepEqual(keys.resolveDeepSeekKey("", {}, () => "  "), { key: "", source: "none" });
});

test("resolveDeepSeekKey tries both keychain service names, in order", () => {
  keys.forgetCachedKey();
  const asked = [];
  keys.resolveDeepSeekKey("", {}, (s) => {
    asked.push(s);
    return s === "DEEPSEEK_API_KEY" ? "sk-second" : undefined;
  });
  assert.deepEqual(asked, ["Recall DeepSeek API key", "DEEPSEEK_API_KEY"]);
});

test("forgetCachedKey drops the cached keychain value", () => {
  // The cache exists so the settings tab does not shell out to `security` on
  // every keystroke. Clearing it is what makes a newly added keychain item
  // take effect without a reload.
  keys.forgetCachedKey();
  const first = keys.resolveDeepSeekKey("", {}, () => "sk-cached", 1000);
  assert.equal(first.source, "keychain");
  assert.deepEqual(keys.resolveDeepSeekKey("", {}, () => "sk-other", 2000), { key: "sk-cached", source: "keychain" });
  keys.forgetCachedKey();
  assert.deepEqual(keys.resolveDeepSeekKey("", {}, () => "sk-other", 3000), { key: "sk-other", source: "keychain" });
});

// ------------------------------------------------------ status to error

test("classifyStatus gives every documented status its own kind", () => {
  const kind = (status) => errors.classifyStatus(status, null).kind;
  assert.equal(kind(401), "auth");
  assert.equal(kind(403), "auth");
  assert.equal(kind(402), "balance");
  assert.equal(kind(429), "rate-limit");
  assert.equal(kind(503), "overloaded");
  assert.equal(kind(400), "bad-request");
  assert.equal(kind(404), "bad-request");
  assert.equal(kind(422), "bad-request");
  // Anything unrecognised is a plain failure rather than a guess at a fix.
  assert.equal(kind(500), "failed");
  assert.equal(kind(418), "failed");
});

test("classifyStatus carries DeepSeek's own message into the error", () => {
  const e = errors.classifyStatus(402, "Insufficient Balance");
  assert.equal(e.kind, "balance");
  assert.match(e.message, /Insufficient Balance/);
  // No detail must still produce a clean sentence, not a dangling ": ".
  assert.equal(errors.classifyStatus(402, null).message.includes(":"), false);
  assert.equal(/\s$/.test(errors.classifyStatus(402, null).message), false);
  assert.match(errors.classifyStatus(500, null).message, /DeepSeek error 500/);
});

test("every classified message says what the reader can do about it", () => {
  // "DeepSeek error 402" is not something a reader can act on; each of these
  // names the fix, which is the whole reason the kinds exist.
  assert.match(errors.classifyStatus(401, null).message, /settings/i);
  assert.match(errors.classifyStatus(402, null).message, /top up/i);
  assert.match(errors.classifyStatus(429, null).message, /again|Parallel requests/i);
  assert.match(errors.classifyStatus(503, null).message, /again/i);
  assert.match(errors.classifyStatus(404, null).message, /model id/i);
});

test("a classified error never echoes key material", () => {
  // The detail comes from the response body, which never carries the key; this
  // pins that nothing in the message-building path introduces one.
  const e = errors.classifyStatus(401, "invalid api key");
  assert.equal(/sk-|Bearer/.test(e.message), false, e.message);
});

test("DeepSeekError is an Error with a name, so describeError can match it", () => {
  const e = new errors.DeepSeekError("timeout", "took too long");
  assert.ok(e instanceof Error);
  assert.equal(e.name, "DeepSeekError");
  assert.equal(e.kind, "timeout");
  assert.equal(e.message, "took too long");
});
