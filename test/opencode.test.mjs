// Run with: npm test
//
// The OpenCode provider's pure parts: the argv it runs, the agent definition
// that makes "no tools" true, the reading of `opencode run --format json`
// output, the model list, and the binary search order. None of these spawn a
// process, and none of them import `obsidian` (which is why they live in
// opencode.ts beside the spawn calls rather than in a wire-only module; the
// spawn helpers are excluded from this bundle by not being reached).
//
// The argv and the agent definition are the two members worth guarding: one
// carries the tool lockdown, the other is the lockdown.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let oc;

before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-opencode-"));
  const out = path.join(dir, "opencode.mjs");
  await build({ entryPoints: ["src/opencode.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  oc = await import(pathToFileURL(out).href);
});

const ev = (o) => JSON.stringify(o);

/** One text event, shaped the way `opencode run --format json` writes them. */
function textEvent(messageID, text, id = "ses_1") {
  return { type: "text", sessionID: id, part: { id: `prt_${messageID}`, messageID, type: "text", text } };
}

// ------------------------------------------------------------------- argv

test("opencodeArgs carries the model, and the flags the parser needs", () => {
  const args = oc.opencodeArgs("deepseek/deepseek-flash");
  assert.deepEqual(args, ["run", "--format", "json", "--agent", "recall", "--model", "deepseek/deepseek-flash"]);
});

test("opencodeArgs names the no-tools agent on every run", () => {
  // The single most important flag: without it `run` uses the allow-everything
  // `build` agent, and a prompt that asks to read a file reads one.
  const args = oc.opencodeArgs("ollama/qwen2.5:7b");
  const i = args.indexOf("--agent");
  assert.ok(i >= 0, "no --agent in argv");
  assert.equal(args[i + 1], oc.OPENCODE_AGENT);
});

test("a model id is passed through untouched, colons and all", () => {
  // Model ids are opaque `provider/model` strings; an ollama tag carries its own
  // colon, and a variant suffix is opencode's own syntax. Recall must not split
  // or normalise either.
  for (const id of ["ollama/gemma4:e2b-mlx", "deepseek/deepseek-flash#high", "opencode/ling-3.1-flash-free"]) {
    const args = oc.opencodeArgs(id);
    assert.equal(args[args.indexOf("--model") + 1], id);
  }
});

// ------------------------------------------------- the spawn environment

test("opencodeEnv points PWD at the run's directory", () => {
  // The bug this exists for: opencode resolves its project opencode.json (which
  // defines the no-tools agent) from PWD, not from the process's cwd. Node's
  // spawn `cwd` option leaves PWD holding the parent's, so without this every
  // call fails with `Agent not found` — and only from a spawn, never from a
  // shell, which sets PWD on `cd`. It shipped once; this pins it.
  const env = oc.opencodeEnv({ PWD: "/somewhere/else", PATH: "/usr/bin", HOME: "/home/x" }, "/scratch/dir");
  assert.equal(env.PWD, "/scratch/dir");
});

test("opencodeEnv keeps the parent's other variables", () => {
  // opencode needs the parent environment to reach its own credentials and the
  // background service; PWD is the one member that is overridden.
  const env = oc.opencodeEnv({ PATH: "/usr/bin", HOME: "/home/x", DEEPSEEK_API_KEY: "k" }, "/scratch");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/x");
  assert.equal(env.DEEPSEEK_API_KEY, "k");
});

test("opencodeEnv does not mutate the environment it was given", () => {
  const parent = { PWD: "/original" };
  oc.opencodeEnv(parent, "/scratch");
  assert.equal(parent.PWD, "/original");
});

// ----------------------------------------------------------- the lockdown

test("the agent config denies every action", () => {
  // The whole security story: a model told to read a file must be unable to.
  const cfg = JSON.parse(oc.opencodeAgentConfig());
  const agent = cfg.agents[oc.OPENCODE_AGENT];
  assert.ok(agent, "the agent is not defined");
  assert.equal(agent.mode, "primary");
  assert.deepEqual(agent.permissions, [{ action: "*", resource: "*", effect: "deny" }]);
});

test("the agent config is valid JSON with the schema opencode expects", () => {
  const cfg = JSON.parse(oc.opencodeAgentConfig());
  assert.equal(cfg.$schema, "https://opencode.ai/config.json");
  assert.equal(Object.keys(cfg.agents).length, 1);
});

// ------------------------------------------------------- reading a run

test("parseOpencodeEvents: the last message wins", () => {
  const stdout = [
    ev({ type: "step_start", sessionID: "ses_1", part: { type: "step-start" } }),
    ev(textEvent("msg_1", '{"cards":')),
    ev({ type: "step_finish", sessionID: "ses_1", part: { type: "step-finish", reason: "stop" } }),
    ev(textEvent("msg_2", '{"cards":[]}')),
  ].join("\n");
  assert.deepEqual(oc.parseOpencodeEvents(stdout).text, '{"cards":[]}');
});

test("parseOpencodeEvents: parts of one message are joined, not treated as separate answers", () => {
  // opencode may stream one message as several text parts; taking only the last
  // part would hand back half an answer.
  const stdout = [ev(textEvent("msg_1", '{"cards":')), ev(textEvent("msg_1", "[]}"))].join("\n");
  assert.equal(oc.parseOpencodeEvents(stdout).text, '{"cards":[]}');
});

test("parseOpencodeEvents: the session id comes back so the caller can delete it", () => {
  const stdout = [ev(textEvent("msg_1", "hi", "ses_abc123"))].join("\n");
  assert.equal(oc.parseOpencodeEvents(stdout).sessionId, "ses_abc123");
});

test("parseOpencodeEvents: an error event surfaces its message", () => {
  // The shape a bad model id produces:
  // {"type":"error","error":{"type":"provider.no-route","message":"Model unavailable: nope/nope"}}
  const stdout = ev({ type: "error", sessionID: "ses_1", error: { type: "provider.no-route", message: "Model unavailable: nope/nope" } });
  assert.deepEqual(oc.parseOpencodeEvents(stdout), { text: null, error: "Model unavailable: nope/nope", sessionId: "ses_1" });
});

test("parseOpencodeEvents: banner text and stray lines are skipped, not fatal", () => {
  // A plain `run` prints `> build · deepseek-flash`; on some paths a warning
  // shares the stream. Neither is JSON, and neither should end the read.
  const stdout = ["> build · deepseek-flash", "some warning", "", ev(textEvent("msg_1", "OK"))].join("\n");
  assert.deepEqual(oc.parseOpencodeEvents(stdout).text, "OK");
});

test("parseOpencodeEvents: whitespace-only text is not an answer", () => {
  const stdout = [ev(textEvent("msg_1", "   \n  "))].join("\n");
  assert.equal(oc.parseOpencodeEvents(stdout).text, null);
});

test("parseOpencodeEvents: empty input yields nothing", () => {
  assert.deepEqual(oc.parseOpencodeEvents(""), { text: null, error: null, sessionId: null });
});

// ------------------------------------------------------- the model list

test("readOpencodeModels keeps provider/model lines and drops noise", () => {
  const stdout = [
    "deepseek/deepseek-flash",
    "deepseek/deepseek-v4-pro",
    "ollama/gemma4:e2b-mlx",
    "opencode/ling-3.1-flash-free",
    "",
    "warning: something",
    "  ",
  ].join("\n");
  assert.deepEqual(oc.readOpencodeModels(stdout), [
    "deepseek/deepseek-flash",
    "deepseek/deepseek-v4-pro",
    "ollama/gemma4:e2b-mlx",
    "opencode/ling-3.1-flash-free",
  ]);
});

test("readOpencodeModels drops an entry with no provider", () => {
  // A bare word is not a model the CLI would accept, so it must not reach the
  // dropdown and then fail on use.
  assert.deepEqual(oc.readOpencodeModels("deepseek-flash\n/nope\nok/model"), ["ok/model"]);
});

test("readOpencodeModels keeps a model id that carries its own colon", () => {
  assert.deepEqual(oc.readOpencodeModels("ollama/gemma4:e2b-mlx"), ["ollama/gemma4:e2b-mlx"]);
});

// --------------------------------------------------- binary resolution

test("a configured path is authoritative, and the only candidate", () => {
  const found = oc.opencodeCandidates("/custom/bin/opencode", { PATH: "/usr/bin" }, "/home/x");
  assert.deepEqual(found, ["/custom/bin/opencode"]);
});

test("auto-detection falls back to ~/.opencode/bin, where the installer puts it", () => {
  // Obsidian launches from a launchd context whose PATH rarely has it, so this
  // fallback is the difference between working and "not found".
  const found = oc.opencodeCandidates("", { PATH: "" }, "/home/x");
  assert.ok(found.includes(path.join("/home/x", ".opencode", "bin", "opencode")));
});

test("auto-detection puts the PATH first", () => {
  const found = oc.opencodeCandidates("", { PATH: "/first:/second" }, "/home/x");
  assert.equal(found[0], path.join("/first", "opencode"));
  assert.equal(found[1], path.join("/second", "opencode"));
});

test("auto-detection never lists the same candidate twice", () => {
  const found = oc.opencodeCandidates("", { PATH: "/opt/homebrew/bin" }, "/home/x");
  assert.equal(new Set(found).size, found.length);
});

// ------------------------------------------------------------ fallbacks

test("the fallback models are the verified pair, in provider/model form", () => {
  assert.deepEqual(oc.OPENCODE_FALLBACK_MODELS, ["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"]);
  for (const m of oc.OPENCODE_FALLBACK_MODELS) assert.match(m, /^[A-Za-z0-9._-]+\/.+$/);
});
