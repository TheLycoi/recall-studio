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

// Upstream's seed selection sends no task label, so the caller says which
// role an unlabelled call belongs to.
test("an unlabelled call runs on the digest role unless the client was made for the query role", async () => {
  const { calls, lookup } = fakeBackends();
  await a.createUpstreamClient(() => settings(), lookup).createMessage({ model: "m", max_tokens: 10, messages: userMessage("x") });
  await a.createUpstreamClient(() => settings(), lookup, { untagged: "query" }).createMessage({ model: "m", max_tokens: 10, messages: userMessage("x") });
  assert.deepEqual(
    calls.map((c) => c.provider),
    ["codex", "gemini"],
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

// Every upstream call site guards the typed and streaming methods with an
// `if (client.method)` check and falls back to createMessage, which is the
// path upstream's own Anthropic client takes. Leaving them off is deliberate.
test("the client offers createMessage and leaves the optional methods to upstream's fallbacks", () => {
  const client = a.createUpstreamClient(() => settings(), fakeBackends().lookup);
  assert.equal(typeof client.createMessage, "function");
  assert.equal(client.createMessageWithOutput, undefined);
  assert.equal(client.createMessageStream, undefined);
});
