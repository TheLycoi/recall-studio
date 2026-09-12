// Run with: npm test  (bundles src/claudeCli.ts first, then exercises the pure helpers with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let c;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
  const out = path.join(dir, "claudeCli.mjs");
  await build({ entryPoints: ["src/claudeCli.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  c = await import(pathToFileURL(out).href);
});

// Captured verbatim from the installed CLI (2.1.267) on 2026-09-11.
const SUCCESS_ENVELOPE =
  '{"type":"result","subtype":"success","is_error":false,"result":"{\\"ready\\":true,\\"word\\":\\"pong\\"}","structured_output":{"ready":true,"word":"pong"},"stop_reason":"tool_use","terminal_reason":"completed","api_error_status":null,"num_turns":2,"total_cost_usd":0.003705,"duration_ms":1473,"session_id":"s-1","usage":{},"modelUsage":{},"permission_denials":[],"uuid":"u-1"}';

// Captured with --bare, which is why --bare is banned.
const FAILURE_ENVELOPE =
  '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","terminal_reason":"api_error","api_error_status":null,"num_turns":1,"session_id":"s-2","uuid":"u-2"}';

test("parseClaudeResult: success envelope yields structured output", () => {
  const r = c.parseClaudeResult(SUCCESS_ENVELOPE);
  assert.equal(r.isError, false);
  assert.equal(r.structured.word, "pong");
  assert.equal(r.structured.ready, true);
  assert.equal(r.text, '{"ready":true,"word":"pong"}');
  assert.equal(r.message, null);
  assert.equal(r.subtype, "success");
  assert.equal(r.apiErrorStatus, null);
});

test("parseClaudeResult: failure envelope yields the message", () => {
  const r = c.parseClaudeResult(FAILURE_ENVELOPE);
  assert.equal(r.isError, true);
  assert.ok(r.message.startsWith("Not logged in"), `message was ${r.message}`);
  assert.equal(r.structured, null);
});

test("parseClaudeResult: stray non-JSON lines before the envelope are skipped", () => {
  const stdout = ["A new version of Claude Code is available.", "[warning] something", "", SUCCESS_ENVELOPE, ""].join("\n");
  const r = c.parseClaudeResult(stdout);
  assert.equal(r.isError, false);
  assert.equal(r.structured.word, "pong");
});

test("parseClaudeResult: non-result JSON lines are skipped, empty stdout is all null/false", () => {
  const stdout = [SUCCESS_ENVELOPE, JSON.stringify({ type: "system", subtype: "init" })].join("\n");
  assert.equal(c.parseClaudeResult(stdout).structured.word, "pong");
  assert.deepEqual(c.parseClaudeResult(""), {
    structured: null,
    text: null,
    isError: false,
    message: null,
    subtype: null,
    apiErrorStatus: null,
  });
  assert.deepEqual(c.parseClaudeResult("not json at all\n"), {
    structured: null,
    text: null,
    isError: false,
    message: null,
    subtype: null,
    apiErrorStatus: null,
  });
});

test("buildClaudeArgs is the exact argument array and never contains --bare", () => {
  const args = c.buildClaudeArgs({ model: "sonnet", effort: "low", schemaJson: '{"type":"object"}', system: "sys", maxTurns: 2 });
  assert.deepEqual(args, [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    '{"type":"object"}',
    "--system-prompt",
    "sys",
    "--model",
    "sonnet",
    "--effort",
    "low",
    "--max-turns",
    "2",
    "--tools",
    "",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
  ]);
  assert.ok(!args.includes("--bare"));
});

test("classifyClaude: the failure envelope is an auth error", () => {
  const parsed = c.parseClaudeResult(FAILURE_ENVELOPE);
  const e = c.classifyClaude({ parsed, code: 1 });
  assert.equal(e.kind, "auth");
  assert.equal(e.name, "ClaudeCliError");
  assert.ok(e.message.includes("Not logged in"));
});

test("classifyClaude: usage-limit, not-found, timeout, aborted, failed", () => {
  const limit = c.parseClaudeResult(JSON.stringify({ type: "result", is_error: true, result: "You've hit your usage limit. Resets at 4pm." }));
  assert.equal(c.classifyClaude({ parsed: limit, code: 1 }).kind, "usage-limit");

  const enoent = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT", path: "/nope/claude" });
  const nf = c.classifyClaude({ spawnError: enoent });
  assert.equal(nf.kind, "not-found");
  assert.ok(nf.message.includes("/nope/claude"));

  assert.equal(c.classifyClaude({ timedOut: true }).kind, "timeout");
  assert.equal(c.classifyClaude({ aborted: true, timedOut: true }).kind, "aborted");
  assert.equal(c.classifyClaude({ code: 2, stderr: "boom" }).kind, "failed");
  assert.ok(c.classifyClaude({ code: 2, stderr: "boom" }).message.includes("boom"));
});

test("classifyClaude: 429 and overloaded in stderr map to usage-limit, 401 to auth", () => {
  assert.equal(c.classifyClaude({ code: 1, stderr: "HTTP 429 too many requests" }).kind, "usage-limit");
  assert.equal(c.classifyClaude({ code: 1, stderr: "Error: overloaded" }).kind, "usage-limit");
  assert.equal(c.classifyClaude({ code: 1, stderr: "401 Unauthorized" }).kind, "auth");
});

test("childEnv drops ANTHROPIC_API_KEY and keeps the rest", () => {
  const env = c.childEnv({ ANTHROPIC_API_KEY: "x", CLAUDE_CODE_SIMPLE: "1", PATH: "p", HOME: "/h" });
  assert.equal("ANTHROPIC_API_KEY" in env, false);
  assert.equal("CLAUDE_CODE_SIMPLE" in env, false);
  assert.equal(env.PATH, "p");
  assert.equal(env.HOME, "/h");
  const source = { ANTHROPIC_API_KEY: "x", PATH: "p" };
  c.childEnv(source);
  assert.equal(source.ANTHROPIC_API_KEY, "x", "childEnv must not mutate its input");
});

test("claudeCandidates: PATH first, then ~/.local/bin; configured path is authoritative", () => {
  const list = c.claudeCandidates("", { PATH: "/a:/b" }, "/home");
  assert.equal(list[0], "/a/claude");
  assert.equal(list[1], "/b/claude");
  assert.ok(list.includes("/home/.local/bin/claude"));
  assert.ok(list.includes("/opt/homebrew/bin/claude"));
  assert.ok(list.includes("/usr/local/bin/claude"));
  assert.ok(list.includes("/home/.npm-global/bin/claude"));
  assert.deepEqual(c.claudeCandidates("/x/claude", { PATH: "/a:/b" }, "/home"), ["/x/claude"]);
  const deduped = c.claudeCandidates("", { PATH: "/opt/homebrew/bin" }, "/home");
  assert.equal(deduped.filter((p) => p === "/opt/homebrew/bin/claude").length, 1);
});

test("PREAMBLE tells the model to answer with JSON only and use no tools", () => {
  assert.equal(
    c.PREAMBLE,
    "Reply with one message containing only the JSON object described by the output schema. Do not use tools, read files, or search; everything you need is in this message.",
  );
});

test("ClaudeCliBackend is named claudecli and exposes the backend interface", () => {
  const b = new c.ClaudeCliBackend(() => ({ effort: "low", claudeCliPath: "", claudeCliModel: "sonnet" }));
  assert.equal(b.name, "claudecli");
  assert.equal(typeof b.probe, "function");
  assert.equal(typeof b.complete, "function");
  assert.equal(typeof b.abort, "function");
});

test("resolveClaudeBinary reports not-found for a configured path that does not exist", () => {
  assert.throws(
    () => c.resolveClaudeBinary("/definitely/not/here/claude"),
    (e) => e.name === "ClaudeCliError" && e.kind === "not-found" && e.message.includes("/definitely/not/here/claude"),
  );
});
