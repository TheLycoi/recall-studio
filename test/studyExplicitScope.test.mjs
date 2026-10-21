import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadQuiz, harness, SOURCE } from './quizHarness.mjs';
const { StudyCoordinator } = await loadQuiz('src/study.ts');
for (const topic of ['affinity', 'Binding sites', '#bio']) test(`resolved source scope supplies candidates for ${topic}`, async () => {
  const h = harness(class {}); const requests = [];
  h.host.store.allHistory = () => h.rows; h.host.store.touch = () => {};
  h.host.llm.requestAuthorization = check => check;
  h.host.llm.selectStudyEvidence = async args => { requests.push(args); return { selections: args.passages.map(p => ({ id:p.id, quote:p.text })), gaps:[] }; };
  const plan = await new StudyCoordinator(h.host).prepare({ mode:'quiz', topic, guide:'Test the definition of affinity.' }, [h.file.path]);
  assert.equal(requests.length, 1, 'a resolved source must reach evidence selection even when its alias/tag is absent from prose');
  assert.equal(requests[0].topic, topic, 'keep the original request topic');
  assert.deepEqual(plan.passages.map(p => p.text), [SOURCE]);
});
