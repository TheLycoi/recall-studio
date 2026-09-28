// Run with: npm test  (bundles src/askHistory.ts first, then exercises it with
// node:test). The module is pure — no `obsidian` import — so esbuild can bundle
// it for plain node here.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let h;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wikilm-askhistory-test-"));
  const out = path.join(dir, "askHistory.mjs");
  await build({ entryPoints: ["src/askHistory.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  h = await import(pathToFileURL(out).href);
});

const u = (text, extra = {}) => ({ role: "user", text, ...extra });
const a = (text, extra = {}) => ({ role: "assistant", text, ...extra });

test("only user and assistant turns with text, and no error, chips or quiz, are conversation", () => {
  const turns = [
    u("what is affinity"),
    { role: "system", text: "Ran Extract PDF highlights to manifest." },
    a("How tightly a ligand binds."),
    a("", {}),
    u("   "),
    a("Model call failed", { error: "timeout" }),
    a("", { chips: [{ label: "Ch3" }] }),
    a("Question 1: define efficacy", { quiz: { n: 1 } }),
    u("the ability to produce an effect", { quiz: { n: 1 } }),
  ];
  assert.deepEqual(h.historyFor(turns, { maxEntries: 10 }), [
    { role: "user", text: "what is affinity" },
    { role: "assistant", text: "How tightly a ligand binds." },
  ]);
});

test("canned refusals the plugin wrote are not replayed as the model's speech, and take their question with them", () => {
  const turns = [u("what is a half-life"), a("Your notes don't cover this.", { canned: true }), u("what is affinity"), a("How tightly a ligand binds.")];
  assert.deepEqual(h.historyFor(turns, { maxEntries: 10 }), [
    { role: "user", text: "what is affinity" },
    { role: "assistant", text: "How tightly a ligand binds." },
  ]);
});

test("excludeLast drops the pending question so it is not in the prompt twice", () => {
  const turns = [u("what is affinity"), a("How tightly a ligand binds."), u("why does it matter")];
  assert.deepEqual(h.historyFor(turns, { maxEntries: 10, excludeLast: true }), [
    { role: "user", text: "what is affinity" },
    { role: "assistant", text: "How tightly a ligand binds." },
  ]);
  // Without the flag the last user turn stays.
  assert.equal(h.historyFor(turns, { maxEntries: 10 }).length, 3);
  // A final assistant turn is not the pending question and stays either way.
  assert.equal(h.historyFor(turns.slice(0, 2), { maxEntries: 10, excludeLast: true }).length, 2);
});

test("citation markers are stripped from assistant text, not from the reader's words", () => {
  const turns = [u("what is [1] in the list"), a("Receptors transduce a signal [1] and bind ligands [2][3].")];
  assert.deepEqual(h.historyFor(turns, { maxEntries: 10 }), [
    { role: "user", text: "what is [1] in the list" },
    { role: "assistant", text: "Receptors transduce a signal and bind ligands." },
  ]);
});

test("the window keeps the last maxEntries and starts on a user turn, so two entries is one exchange", () => {
  const turns = [u("q1"), a("a1"), u("q2"), a("a2"), u("q3")];
  // The pending q3 is excluded; the last two entries are q2 and its answer.
  assert.deepEqual(h.historyFor(turns, { maxEntries: 2, excludeLast: true }), [
    { role: "user", text: "q2" },
    { role: "assistant", text: "a2" },
  ]);
  // Three entries would start on a1, an answer without its question: trimmed to q2, a2.
  assert.deepEqual(h.historyFor(turns, { maxEntries: 3, excludeLast: true }), [
    { role: "user", text: "q2" },
    { role: "assistant", text: "a2" },
  ]);
  // With no user turn in the window at all, the window is kept rather than emptied.
  assert.deepEqual(h.historyFor([a("welcome"), a("hello")], { maxEntries: 2 }), [
    { role: "assistant", text: "welcome" },
    { role: "assistant", text: "hello" },
  ]);
  assert.deepEqual(h.historyFor(turns, { maxEntries: 0 }), []);
});

test("typed studio commands are not conversation", () => {
  const turns = [u("what is affinity"), a("How tightly a ligand binds."), u("send it", { command: true }), u("and avidity?")];
  assert.deepEqual(h.historyFor(turns, { maxEntries: 6, excludeLast: true }), [
    { role: "user", text: "what is affinity" },
    { role: "assistant", text: "How tightly a ligand binds." },
  ]);
});

test("a question whose answer was canned is dropped with it, so a two-entry window is still one exchange", () => {
  const turns = [u("u1"), a("a1"), u("u2"), a("Your notes don't cover this.", { canned: true }), u("u3")];
  assert.deepEqual(h.historyFor(turns, { maxEntries: 2, excludeLast: true }), [
    { role: "user", text: "u1" },
    { role: "assistant", text: "a1" },
  ]);
});

test("a question whose answer was an error is dropped with it", () => {
  const turns = [u("u1"), a("Model call failed", { error: "timeout" })];
  assert.deepEqual(h.historyFor(turns, { maxEntries: 10 }), []);
  assert.deepEqual(h.historyFor(turns, { maxEntries: 10, excludeLast: true }), []);
  // A system line between the question and its failed answer does not save the question.
  const narrated = [u("u1"), { role: "system", text: "Searching notes" }, a("Model call failed", { error: "timeout" })];
  assert.deepEqual(h.historyFor(narrated, { maxEntries: 10 }), []);
});
