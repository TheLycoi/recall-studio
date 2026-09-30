// Run with: npm test. Bundles src/upstream/llmAdapter.ts, the client that
// upstream's engine calls in place of its own SDK clients, with the plugin's
// shared esbuild options, then drives it with fake WikiLM backends. No model
// is called.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sharedBuildOptions } from "../scripts/esbuild-shared.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let a;
let dir;
before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "wikilm-upstream-adapter-"));
  const out = path.join(dir, "llmAdapter.cjs");
  await build({
    ...sharedBuildOptions(),
    entryPoints: [path.join(ROOT, "src/upstream/llmAdapter.ts")],
    outfile: out,
    logLevel: "error",
  });
  a = createRequire(import.meta.url)(out);
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Settings with roles on: digest on Codex, query on Gemini, lint following the main Claude CLI choice. */
function settings(over = {}) {
  return {
    provider: "claudecli",
    model: "claude-api-model",
    geminiModel: "gemini-default",
    codexModel: "codex-default",
    claudeCliModel: "sonnet",
    rolesEnabled: true,
    roles: {
      digest: { provider: "codex", model: "gpt-5.5" },
      query: { provider: "gemini", model: "gemini-3-pro" },
      lint: { provider: "default", model: "" },
    },
    effort: "high",
    ...over,
  };
}

/** One fake backend per provider; each records its calls and answers with `reply`. */
function fakeBackends(reply = (req) => `answer from ${req.model}`) {
  const calls = [];
  const make = (name) => ({
    name,
    async completeText(req) {
      calls.push({ provider: name, ...req });
      return reply(req, name);
    },
  });
  const map = { anthropic: make("anthropic"), gemini: make("gemini"), codex: make("codex"), claudecli: make("claudecli") };
  return { calls, lookup: (p) => map[p] };
}

function userMessage(content) {
  return [{ role: "user", content }];
}

test("a text call returns the backend's string unchanged and passes system and max_tokens through", async () => {
  const text = "---\ntitle: X\n---\n\n```json\n{\"a\": 1}\n```\n  trailing space  \n";
  const { calls, lookup } = fakeBackends(() => text);
  const client = a.createUpstreamClient(() => settings(), lookup);
  const out = await client.createMessage({
    task: "page-generate",
    model: "whatever-upstream-says",
    max_tokens: 4321,
    system: "You write wiki pages.",
    messages: userMessage("Write the page."),
  });
  assert.equal(out, text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].system, "You write wiki pages.");
  assert.equal(calls[0].user, "Write the page.");
  assert.equal(calls[0].maxTokens, 4321);
});

test("a multi-message conversation is flattened in order with role labels", async () => {
  const { calls, lookup } = fakeBackends();
  const client = a.createUpstreamClient(() => settings(), lookup);
  await client.createMessage({
    task: "extract",
    model: "m",
    max_tokens: 100,
    messages: [
      { role: "user", content: "first question" },
      { role: "assistant", content: [{ type: "text", text: "first answer" }] },
      { role: "user", content: "second question" },
    ],
  });
  const user = calls[0].user;
  const order = ["User:", "first question", "Assistant:", "first answer", "User:", "second question"];
  let at = -1;
  for (const piece of order) {
    const next = user.indexOf(piece, at + 1);
    assert.ok(next > at, `"${piece}" appears after position ${at} in:\n${user}`);
    at = next;
  }
  assert.equal(calls[0].system, "", "no system prompt becomes an empty one");
});

test("an ingest task runs on the digest role and a query task on the query role", async () => {
  const { calls, lookup } = fakeBackends();
  const client = a.createUpstreamClient(() => settings(), lookup);
  for (const task of ["extract", "page-generate", "merge-triage", "source-page", "dedup"]) {
    await client.createMessage({ task, model: "ignored", max_tokens: 10, messages: userMessage("x") });
  }
  for (const c of calls) {
    assert.equal(c.provider, "codex");
    assert.equal(c.model, "gpt-5.5");
  }
  calls.length = 0;
  for (const task of ["query-wiki", "query-view-evaluate"]) {
    await client.createMessage({ task, model: "ignored", max_tokens: 10, messages: userMessage("x") });
  }
  for (const c of calls) {
    assert.equal(c.provider, "gemini");
    assert.equal(c.model, "gemini-3-pro");
  }
});

test("lint tasks follow the lint role, which here is the main choice", async () => {
  const { calls, lookup } = fakeBackends();
  const client = a.createUpstreamClient(() => settings(), lookup);
  for (const task of ["lint-dedup", "fix-dead-link", "link-orphan"]) {
    await client.createMessage({ task, model: "ignored", max_tokens: 10, messages: userMessage("x") });
  }
  for (const c of calls) {
    assert.equal(c.provider, "claudecli");
    assert.equal(c.model, "sonnet");
  }
});

// Every call the ingest engine makes is labelled; one that is not is ingest
// work too. The option that sent unlabelled calls to the query role served
// only the parked retrieval task, and is gone.
test("an unlabelled call runs on the digest role, and no option sends it elsewhere", async () => {
  const { calls, lookup } = fakeBackends();
  await a.createUpstreamClient(() => settings(), lookup).createMessage({ model: "m", max_tokens: 10, messages: userMessage("x") });
  await a.createUpstreamClient(() => settings(), lookup, { untagged: "query" }).createMessage({ model: "m", max_tokens: 10, messages: userMessage("x") });
  assert.deepEqual(
    calls.map((c) => c.provider),
    ["codex", "codex"],
  );
});

// Upstream's lint leaves its duplicate merge and empty-page fill unlabelled;
// the lint hands upstream a client fixed on the lint role instead.
test("a role client runs every call on its role, labelled or not", async () => {
  const { calls, lookup } = fakeBackends();
  const client = a.createRoleClient(() => settings({ roles: { ...settings().roles, lint: { provider: "gemini", model: "gemini-lint" } } }), lookup, "lint");
  for (const task of [undefined, "extract", "query-wiki", "lint-alias"]) await client.createMessage({ model: "m", max_tokens: 10, messages: userMessage("x"), task });
  assert.deepEqual(
    calls.map((c) => [c.provider, c.model]),
    Array(4).fill(["gemini", "gemini-lint"]),
  );
});

test("the settings are read at call time, so a role change reaches the next call", async () => {
  const { calls, lookup } = fakeBackends();
  let s = settings();
  const client = a.createUpstreamClient(() => s, lookup);
  await client.createMessage({ task: "extract", model: "m", max_tokens: 10, messages: userMessage("x") });
  s = settings({ rolesEnabled: false });
  await client.createMessage({ task: "extract", model: "m", max_tokens: 10, messages: userMessage("x") });
  assert.deepEqual(
    calls.map((c) => `${c.provider}/${c.model}`),
    ["codex/gpt-5.5", "claudecli/sonnet"],
  );
});

test("a thinking request maps onto WikiLM's effort; without one the backend keeps its default", async () => {
  const { calls, lookup } = fakeBackends();
  const client = a.createUpstreamClient(() => settings(), lookup);
  await client.createMessage({ task: "extract", model: "m", max_tokens: 10, messages: userMessage("x") });
  await client.createMessage({ task: "extract", model: "m", max_tokens: 10, messages: userMessage("x"), enableThinking: false });
  await client.createMessage({ task: "extract", model: "m", max_tokens: 10, messages: userMessage("x"), reasoningEffort: "medium" });
  assert.deepEqual(
    calls.map((c) => c.effort),
    [undefined, "low", "medium"],
  );
});

test("an already aborted signal rejects with an AbortError and never reaches the backend", async () => {
  const { calls, lookup } = fakeBackends();
  const client = a.createUpstreamClient(() => settings(), lookup);
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(
    client.createMessage({ task: "extract", model: "m", max_tokens: 10, messages: userMessage("x"), abortSignal: ctl.signal }),
    (e) => e.name === "AbortError",
  );
  assert.equal(calls.length, 0);
});

test("aborting during a call rejects at once with an AbortError, and the backend is handed the signal", async () => {
  let seen;
  const lookup = () => ({
    name: "codex",
    completeText(req) {
      seen = req.signal;
      return new Promise(() => {});
    },
  });
  const client = a.createUpstreamClient(() => settings(), lookup);
  const ctl = new AbortController();
  const pending = client.createMessage({ task: "extract", model: "m", max_tokens: 10, messages: userMessage("x"), abortSignal: ctl.signal });
  ctl.abort();
  await assert.rejects(pending, (e) => e.name === "AbortError");
  assert.equal(seen, ctl.signal);
});

test("a backend error reaches the caller with its message", async () => {
  const lookup = () => ({
    name: "claudecli",
    async completeText() {
      throw new Error("Claude Code usage limit reached: try again at 5pm");
    },
  });
  const client = a.createUpstreamClient(() => settings({ rolesEnabled: false }), lookup);
  await assert.rejects(
    client.createMessage({ task: "extract", model: "m", max_tokens: 10, messages: userMessage("x") }),
    /Claude Code usage limit reached: try again at 5pm/,
  );
});

test("a file part is refused with a message, since WikiLM's backends take text only", async () => {
  const { calls, lookup } = fakeBackends();
  const client = a.createUpstreamClient(() => settings(), lookup);
  await assert.rejects(
    client.createMessage({
      task: "pdf-convert",
      model: "m",
      max_tokens: 10,
      messages: [{ role: "user", content: [{ type: "text", text: "convert" }, { type: "file", data: "JVBERi0=", mediaType: "application/pdf" }] }],
    }),
    /text only/,
  );
  assert.equal(calls.length, 0);
});

/** A backend that reports `stop` (or nothing, when it is undefined) before answering. */
function stoppingBackend(stop, text = "the page body") {
  return () => ({
    name: "anthropic",
    async completeText(req) {
      if (stop !== undefined) req.onStop?.(stop);
      return text;
    },
  });
}

async function finishesOf(lookup) {
  const seen = [];
  const client = a.createUpstreamClient(() => settings(), lookup);
  const text = await client.createMessage({ task: "merge-body", model: "m", max_tokens: 8000, messages: userMessage("x"), onFinish: (meta) => seen.push(meta) });
  return { text, seen };
}

// Upstream keeps the existing page body when a rewrite stopped at the token
// cap (merge-page.ts, related-page.ts) and halves an extract batch
// (source-analyzer.ts). It learns why the model stopped only through onFinish.
test("a length stop from the backend reaches onFinish as upstream's length reason", async () => {
  const { text, seen } = await finishesOf(stoppingBackend("length"));
  assert.equal(text, "the page body");
  assert.deepEqual(seen, [{ finishReason: "length" }]);
});

test("a normal stop from the backend reaches onFinish as upstream's stop reason", async () => {
  const { seen } = await finishesOf(stoppingBackend("end"));
  assert.deepEqual(seen, [{ finishReason: "stop" }]);
});

test("a stop the provider named that is neither an end nor a length is upstream's other", async () => {
  const { seen } = await finishesOf(stoppingBackend("other"));
  assert.deepEqual(seen, [{ finishReason: "other" }]);
});

test("a backend that cannot tell leaves the reason unknown, never a clean stop", async () => {
  assert.deepEqual((await finishesOf(stoppingBackend("unknown"))).seen, [{ finishReason: "unknown" }]);
  assert.deepEqual((await finishesOf(stoppingBackend(undefined))).seen, [{ finishReason: "unknown" }]);
});

test("onFinish is called once, with the last reason, even when the backend reports twice", async () => {
  const lookup = () => ({
    name: "gemini",
    async completeText(req) {
      req.onStop?.("end");
      req.onStop?.("length");
      return "x";
    },
  });
  const { seen } = await finishesOf(lookup);
  assert.deepEqual(seen, [{ finishReason: "length" }]);
});

test("a call without onFinish still works when the backend reports a stop", async () => {
  const client = a.createUpstreamClient(() => settings(), stoppingBackend("length"));
  assert.equal(await client.createMessage({ task: "extract", model: "m", max_tokens: 10, messages: userMessage("x") }), "the page body");
});

// Upstream's own SDK clients call onFinish just before they return the text
// (llm-sdk/anthropic-sdk-client.ts), so a call that throws never reports.
test("onFinish is not called when the backend throws", async () => {
  const lookup = () => ({
    name: "claudecli",
    async completeText(req) {
      req.onStop?.("end");
      throw new Error("Claude Code failed: boom");
    },
  });
  const seen = [];
  const client = a.createUpstreamClient(() => settings(), lookup);
  await assert.rejects(
    client.createMessage({ task: "extract", model: "m", max_tokens: 10, messages: userMessage("x"), onFinish: (m) => seen.push(m) }),
    /boom/,
  );
  assert.deepEqual(seen, []);
});

test("onFinish is not called when the call is aborted, before or during it", async () => {
  const seen = [];
  const onFinish = (m) => seen.push(m);
  const client = a.createUpstreamClient(() => settings(), stoppingBackend("end"));
  const early = new AbortController();
  early.abort();
  await assert.rejects(
    client.createMessage({ task: "extract", model: "m", max_tokens: 10, messages: userMessage("x"), abortSignal: early.signal, onFinish }),
    (e) => e.name === "AbortError",
  );

  // The backend answers after the cancel, as an HTTP backend that cannot
  // stop its request does.
  let answer;
  const slow = a.createUpstreamClient(() => settings(), () => ({
    name: "gemini",
    completeText(req) {
      return new Promise((resolve) => {
        answer = () => {
          req.onStop?.("end");
          resolve("late");
        };
      });
    },
  }));
  const during = new AbortController();
  const pending = slow.createMessage({ task: "extract", model: "m", max_tokens: 10, messages: userMessage("x"), abortSignal: during.signal, onFinish });
  during.abort();
  await assert.rejects(pending, (e) => e.name === "AbortError");
  answer();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, []);
});

// Every upstream call site guards the typed and streaming methods with an
// `if (client.method)` check and falls back to createMessage, which is the
// path upstream's own Anthropic client takes. Leaving them off is deliberate.
test("the client offers createMessage and leaves the optional methods to upstream's fallbacks", () => {
  const client = a.createUpstreamClient(() => settings(), fakeBackends().lookup);
  assert.equal(typeof client.createMessage, "function");
  assert.equal(client.createMessageWithOutput, undefined);
  assert.equal(client.createMessageStream, undefined);
});
