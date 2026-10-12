// Run with: npm test  (reads src/llm.ts as text)
//
// The chat answer goes through the same provider path as every other call, so
// these checks are about wiring: `answerSelected` must use the configured
// backend's `complete` with the chat schema and system prompt, and adding it
// must not have disturbed provider selection or the quiz methods the rest of
// the plugin (and the parallel core branch) still compiles against.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const LLM = () => readFileSync("src/llm.ts", "utf8");

test("answerSelected is a method on LlmClient", () => {
  const s = LLM();
  assert.match(s, /class LlmClient/);
  assert.match(s, /async answerSelected\(args: ChatAnswerArgs\): Promise<ChatAskDraft>/);
});

test("answerSelected routes through the configured backend with the chat schema and prompt", () => {
  const s = LLM();
  const m = /async answerSelected\(args: ChatAnswerArgs\)[\s\S]*?\n  \}/.exec(s);
  assert.ok(m, "answerSelected body not found");
  const body = m[0];
  assert.ok(/this\.backend\(\)\.complete\(/.test(body), "does not use the configured backend");
  assert.ok(/system:\s*CHAT_ANSWER_SYSTEM/.test(body), "does not send the chat system prompt");
  assert.ok(/schema:\s*ChatAskOut/.test(body), "does not send the chat schema");
});

test("provider selection and the quiz/card methods are untouched", () => {
  const s = LLM();
  for (const name of ["writeCards", "critiqueCards", "rewriteCard", "quizQuestion", "quizRecallGrade"]) {
    assert.ok(s.includes(`${name}(`), `missing ${name}`);
  }
  // backend() still reads the setting and returns the three real backends.
  assert.match(s, /private backend\(\): LlmBackend \{/);
  for (const b of ["this.deepseek", "this.opencode", "this.codex"]) assert.ok(s.includes(b), b);
});

test("the chat method exposes no tools and no vault-wide read to the model", () => {
  const s = LLM();
  const m = /async answerSelected\(args: ChatAnswerArgs\)[\s\S]*?\n  \}/.exec(s)[0];
  assert.equal(/tools|function_call|readFile|vault/i.test(m), false);
});
