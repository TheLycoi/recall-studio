import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadQuiz, SOURCE } from './quizHarness.mjs';

const methods = ['quizQuestion', 'quizQuestionAudit', 'quizMultipleChoice', 'quizChoiceAudit'];
const frame = guide => `Coverage instructions only, not source evidence:\n${guide}\nUse only the supplied note points for facts.`;
const question = { question: 'What does affinity mean?', shape: 'concept', expects: [1] };
const choice = { question: 'Which statement describes affinity?', point: 1, choices: [{ id: 'A', text: SOURCE }, { id: 'B', text: 'Mass' }], correctId: 'A' };
const grade = { points: [{ n: 1, status: 'recalled', said: SOURCE, note: '', cue: '' }], feedback: '' };
const replies = {
  quizQuestion: question,
  quizQuestionAudit: { supported: true },
  quizMultipleChoice: choice,
  quizChoiceAudit: { choices: [{ id: 'A', supported: true }, { id: 'B', supported: false }] },
  quizRecallGrade: grade,
  quizGradeAudit: { points: [{ n: 1, agrees: true }] },
};
const args = (method, guide) => ({
  noteTitle: 'Receptors', section: '', part: 1, parts: 1, points: [SOURCE], level: 1, asked: [],
  standingInstructions: frame(guide), failure: '', authorized: () => true,
  draft: method === 'quizQuestionAudit' ? question : choice,
  question: question.question, answer: SOURCE, cued: false, grade,
});
async function fixture(method, { prepare = () => {}, reply = () => replies[method] } = {}) {
  const dispatches = [];
  const { LlmClient } = await loadQuiz('src/llm.ts', { requestUrl: async request => {
    dispatches.push(request);
    const value = await reply();
    return { status: 200, json: { choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) }, finish_reason: 'stop' }] } };
  } });
  const llm = new LlmClient(() => {
    prepare();
    return { provider: 'deepseek', deepseekApiKey: 'synthetic-test-key', deepseekModel: 'synthetic-model', effort: 'low' };
  });
  return { llm, dispatches };
}
const sent = dispatch => JSON.parse(JSON.parse(dispatch.body).messages[1].content);

for (const method of methods) {
  test(`${method}: invalid or unframed coverage cannot acquire the guide exemption`, async () => {
    const f = await fixture(method);
    for (const instructions of [frame('g'.repeat(64001)), frame(' '.repeat(64000)), 'g'.repeat(64000)]) {
      await assert.rejects(f.llm[method]({ ...args(method, ''), standingInstructions: instructions }), /coverage|evidence limit/i);
    }
    assert.equal(f.dispatches.length, 0);
  });
  test(`${method}: oversized evidence stays blocked with a legal guide`, async () => {
    const f = await fixture(method);
    await assert.rejects(f.llm[method]({ ...args(method, 'g'.repeat(64000)), points: ['x'.repeat(30000)] }), /evidence limit/i);
    assert.equal(f.dispatches.length, 0);
  });
  for (const stage of ['entry', 'preparation', 'acceptance']) {
    test(`${method}: long coverage preserves authorization at ${stage}`, async () => {
      let allowed = stage !== 'entry';
      const f = await fixture(method, {
        prepare: () => { if (stage === 'preparation') allowed = false; },
        reply: () => { if (stage === 'acceptance') allowed = false; return replies[method]; },
      });
      await assert.rejects(f.llm[method]({ ...args(method, 'g'.repeat(64000)), authorized: () => allowed }), /authorization/i);
      assert.equal(f.dispatches.length, stage === 'acceptance' ? 1 : 0);
    });
  }
}
for (const method of ['quizRecallGrade', 'quizGradeAudit']) {
  test(`${method}: grading does not inherit the larger coverage budget`, async () => {
    const f = await fixture(method);
    await assert.rejects(f.llm[method]({ ...args(method, 'g'.repeat(64000)), answer: 'a'.repeat(30000) }), /evidence limit/i);
    assert.equal(f.dispatches.length, 0);
    await f.llm[method](args(method, 'g'.repeat(64000)));
    const payload = sent(f.dispatches[0]);
    assert.equal(payload.standingInstructions, undefined);
    assert.ok(!JSON.stringify(payload).includes('g'.repeat(64000)));
  });
}

for (const method of methods) {
  for (const [kind, guide] of [['plain', 'g'.repeat(64000)], ['escaped', 'x"\\\u0001\n'.repeat(12800)]]) {
    test(`${method}: complete ${kind} 64000-character guide reaches the real transport`, async () => {
      assert.equal(guide.length, 64000);
      const f = await fixture(method);
      assert.deepEqual(await f.llm[method](args(method, guide)), replies[method]);
      assert.equal(f.dispatches.length, 1);
      const payload = sent(f.dispatches[0]);
      assert.equal(payload.standingInstructions, frame(guide));
      assert.deepEqual(payload.section.points, [{ n: 1, text: SOURCE }]);
    });
  }
}
