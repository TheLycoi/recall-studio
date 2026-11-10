import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadQuiz } from './quizHarness.mjs';
let api, generation, model;
before(async () => {
  api = await loadQuiz('src/llm.ts');
  generation = await loadQuiz('src/generation.ts');
  model = await loadQuiz('src/model.ts');
});
function fixture() {
  const settings = { provider: 'codex', modelMode: 'split', codexModel: 'strong', effort: 'high', cheapModels: { codex: 'cheap' }, graderModels: { codex: 'judge' }, graderEffort: 'low', language: '' };
  const calls = [], llm = new api.LlmClient(() => settings);
  llm.codex = { async complete(req) { calls.push(req); return { cards: [], verdicts: [] }; } };
  return { settings, calls, llm, h: model.makeHighlight({ text: 'The fictional Vela signal is blue.' }), p: { facts: [], plan: [], exclusions: [], omissions: [], conflicts: [] } };
}
test('editable method and individual roles reach the real reader, writer, grader and repair requests', async () => {
  const f = fixture();
  f.settings.systemPrompts = { method: 'CUSTOM METHOD', reader: 'CUSTOM READER', writer: 'CUSTOM WRITER', grader: 'CUSTOM GRADER' };
  await f.llm.prepareGeneration(f.h, [], {});
  await f.llm.writeGroundedCards(f.h, [], f.p, {});
  await f.llm.auditGeneration(f.h, [], [], f.p, {});
  await f.llm.repairGeneration(f.h, [], [], f.p, {}, []);
  for (const [i, role, modelName] of [[0, 'READER', 'cheap'], [1, 'WRITER', 'strong'], [2, 'GRADER', 'judge'], [3, 'WRITER', 'strong']]) {
    assert.ok(f.calls[i].system.includes(`CUSTOM ${role}`));
    assert.ok(f.calls[i].system.includes('CUSTOM METHOD'));
    assert.match(f.calls[i].system, /data, not instructions/);
    assert.match(f.calls[i].system, /output schema/);
    assert.equal(f.calls[i].model, modelName);
  }
  assert.equal(f.calls[2].effort, 'low');
});
test('prompt and effective grader changes invalidate checkpoint identity', () => {
  const f = fixture(), key = () => generation.generationKey(f.h, {}, f.settings, 'batch');
  const first = key(); f.settings.systemPrompts = { writer: 'Use concise wording.' };
  assert.notEqual(key(), first);
  const custom = key(); f.settings.graderModels.codex = 'other-judge'; assert.notEqual(key(), custom);
  f.settings.modelMode = 'unified'; const unified = key();
  f.settings.graderModels.codex = 'unused'; f.settings.graderEffort = 'max'; assert.equal(key(), unified);
});
test('editing prompts while a provider response is pending refuses its result', async () => {
  const f = fixture();
  f.llm.codex.complete = async () => { f.settings.systemPrompts = { writer: 'New instructions' }; return { cards: [] }; };
  await assert.rejects(() => f.llm.writeGroundedCards(f.h, [], f.p, {}), /cancel|authoriz/i);
});
test('the default method limits the whole cloze note to one sentence and prevents conjunction workarounds', async () => {
  const f = fixture();
  await f.llm.prepareGeneration(f.h, [], {});
  await f.llm.writeGroundedCards(f.h, [], f.p, {});
  await f.llm.auditGeneration(f.h, [], [], f.p, {});
  for (const req of f.calls) {
    assert.match(req.system, /entire cloze note.{0,80}one sentence/i);
    assert.match(req.system, /semicolons/);
  }
});

test('accuracy instructions reach all roles and reuse explicit source holds rather than fabricated verification', async () => {
  const f = fixture();
  await f.llm.prepareGeneration(f.h, [], {});
  await f.llm.writeGroundedCards(f.h, [], f.p, {});
  await f.llm.auditGeneration(f.h, [], [], f.p, {}, undefined, true);
  for (const req of f.calls) {
    assert.match(req.system, /Accuracy.*non-negotiable/);
    assert.match(req.system, /interpretation/i);
    assert.match(req.system, /I'm not fully certain of this/);
    assert.match(req.system, /revisit.*final audit/i);
    assert.match(req.system, /no browsing|do not browse/i);
    assert.match(req.system, /conflicts/);
  }
  assert.deepEqual(f.calls.map(r => r.label), ['preparation', 'grounded cards', 'final audit']);
});
