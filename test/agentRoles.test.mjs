import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
let m;
before(async () => {
  const out = await build({ stdin: { contents: `export { LlmClient } from './src/llm'; export { makeHighlight, makeCard } from './src/model'; export { generationKey } from './src/generation';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'cjs', platform: 'node', external: ['obsidian'], logLevel: 'silent' });
  const mod = new Module('agent-roles');
  mod.require = id => id === 'obsidian' ? { requestUrl() { throw Error('Network forbidden'); } } : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text, 'agent-roles'); m = mod.exports;
});
function fixture(provider = 'codex', overrides = true) {
  const settings = { provider, modelMode: 'split', codexModel: 'sol', deepseekModel: 'pro', opencodeModel: 'vendor/strong', effort: 'high', ...(overrides ? { cheapModels: { codex: 'terra', deepseek: 'flash', opencode: 'vendor/cheap#low' }, cheapEffort: 'medium' } : {}) };
  const calls = [], llm = new m.LlmClient(() => settings);
  const h = m.makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Vela', text: 'Accepted records must be signed.', before: 'Revision C.', after: 'Rejected records stay quarantined.' });
  const card = m.makeCard(h.id, { kind: 'qa', front: 'What must happen before accepted records are archived?', back: 'They must be signed.' });
  const draft = { kind: 'qa', front: card.front, back: card.back, text: '' };
  llm[provider] = { async complete(req) { calls.push(req); return { cards: [draft], verdicts: [], preservesFacts: true, ...draft }; }, async probe(model) { return { model, via: provider }; } };
  return { settings, calls, llm, h, card, preparation: { facts: [], plan: [], conflicts: [], exclusions: [], omissions: [] } };
}
async function stages(f) {
  await f.llm.prepareGeneration(f.h, [], {});
  await f.llm.writeGroundedCards(f.h, [], f.preparation, {});
  await f.llm.repairGeneration(f.h, [f.card], [], f.preparation, {}, []);
  await f.llm.auditGeneration(f.h, [f.card], [], f.preparation, {});
  await f.llm.auditGeneration(f.h, [f.card], [], f.preparation, {}, undefined, true);
  await f.llm.writeCards(f.h);
  await f.llm.rewriteCard(f.h, f.card, 'Keep the meaning.');
  await f.llm.critiqueCards(f.h, [f.card]);
}
for (const provider of ['codex', 'deepseek', 'opencode']) test(`${provider}: Strong plans and checks; Cheap writes and repairs with original context`, async () => {
  const f = fixture(provider); await stages(f);
  const strong = { codex: 'sol', deepseek: 'pro', opencode: 'vendor/strong' }[provider];
  assert.equal(f.calls.length, 8);
  for (const req of f.calls) {
    const thinking = ['preparation', 'audit', 'final audit', 'verdicts'].includes(req.label);
    assert.equal(req.model, thinking ? strong : f.settings.cheapModels[provider], req.label);
    assert.equal(req.effort, thinking ? 'high' : 'medium', req.label);
    const p = JSON.parse(req.user);
    assert.equal(p.captured ?? p.source.highlight, f.h.text);
    assert.equal(p.contextBefore ?? p.source.contextBefore, f.h.before);
    assert.equal(p.contextAfter ?? p.source.contextAfter, f.h.after);
  }
});
test('Unconfigured Cheap inherits Strong and role selection changes no prompt or source payload', async () => {
  const legacy = fixture('codex', false), routed = fixture();
  routed.h = legacy.h; routed.card = legacy.card;
  await stages(legacy); await stages(routed);
  for (let i = 0; i < legacy.calls.length; i++) {
    assert.equal(legacy.calls[i].model, 'sol'); assert.equal(legacy.calls[i].effort, 'high');
    assert.equal(legacy.calls[i].system, routed.calls[i].system);
    assert.equal(legacy.calls[i].user, routed.calls[i].user);
  }
});

test('Cheap model and effort changes invalidate checkpoints; inheritance preserves legacy identity', () => {
  const f = fixture('codex', false), key = () => m.generationKey(f.h, {}, f.settings, 'batch');
  const legacy = key();
  f.settings.cheapModels = { codex: 'sol', deepseek: 'other-provider' }; f.settings.cheapEffort = 'high';
  assert.equal(key(), legacy);
  f.settings.cheapModels.codex = 'terra'; assert.notEqual(key(), legacy);
  const routed = key(); f.settings.cheapEffort = 'medium'; assert.notEqual(key(), routed);
  delete f.settings.cheapModels.codex; delete f.settings.cheapEffort; assert.equal(key(), legacy);
});

for (const provider of ['codex', 'deepseek', 'opencode']) test(`${provider}: unified mode ignores retained Cheap choices and preserves checkpoint identity`, async () => {
  const f = fixture(provider), main = f.settings[`${provider}Model`];
  const key = () => m.generationKey(f.h, {}, f.settings, 'batch');
  const splitKey = key();
  delete f.settings.modelMode;
  const unifiedKey = key();
  assert.notEqual(unifiedKey, splitKey);
  await stages(f);
  assert.ok(f.calls.every(r => r.model === main && r.effort === 'high'));
  f.settings.modelMode = 'unified'; assert.equal(key(), unifiedKey);
  f.settings.cheapModels[provider] = 'retained-choice'; f.settings.cheapEffort = 'low';
  assert.equal(key(), unifiedKey);
  f.settings.modelMode = 'split'; assert.notEqual(key(), unifiedKey);
  f.calls.length = 0; await stages(f);
  assert.equal(f.calls[1].model, 'retained-choice'); assert.equal(f.calls[1].effort, 'low');
});
