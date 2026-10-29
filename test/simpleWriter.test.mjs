import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadQuiz } from './quizHarness.mjs';

test('v9 keeps one shared contract and bounded stage-specific tasks', async () => {
  const { WRITING_METHOD_ID, CARD_WRITING_METHOD, writingContext } = await loadQuiz('src/writerMethod.ts');
  const { PREPARATION_SYSTEM, AUDIT_SYSTEM } = await loadQuiz('src/generation.ts');
  assert.equal(WRITING_METHOD_ID, 'recall-writing-method-v9');
  assert.equal(writingContext({ language: 'English' }).rules, WRITING_METHOD_ID);
  for (const system of [PREPARATION_SYSTEM, AUDIT_SYSTEM]) {
    assert.equal(system.split(CARD_WRITING_METHOD).length, 2);
    assert.ok(system.split('</writing_method>')[1].length <= 2600, 'stage task stays concise');
  }
  for (const rule of [/source boundaries/i, /retrieval/i, /grouping/i, /self-check/i, /twenty_rule_checklist/]) assert.match(CARD_WRITING_METHOD, rule);
});

// Engineering prose budget, not a learning threshold or token/cost estimate.
test('the shared runtime method is at most 60% of the v8 instructions', async () => {
  const { CARD_WRITING_METHOD, cardSystem } = await loadQuiz('src/writerMethod.ts');
  const v8Characters = 23170;
  assert.ok(CARD_WRITING_METHOD.length <= Math.floor(v8Characters * 0.6), `${CARD_WRITING_METHOD.length} shared characters`);
  const request = cardSystem('Write the supplied plan.');
  assert.equal(request.split(CARD_WRITING_METHOD).length, 2);
  const checklist = request.match(/<twenty_rule_checklist>([\s\S]*?)<\/twenty_rule_checklist>/)?.[1];
  assert.deepEqual([...checklist.matchAll(/^(\d+)\./gm)].map(m => Number(m[1])), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.match(request, /applicability.*not.*every technique.*every card/i);
});
