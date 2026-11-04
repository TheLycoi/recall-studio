import { auditVerdict } from './auditFixture.mjs';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';

let m;
before(async () => {
  const out = await build({ stdin: { contents: `export { Generator } from './src/generator'; export { LlmClient } from './src/llm'; export { makeCard, makeHighlight } from './src/model'; export { parseInboxJson } from './src/inboxData'; export * from './src/generation';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'cjs', platform: 'node', external: ['obsidian'], logLevel: 'silent' });
  const mod = new Module('generation-resume');
  mod.require = id => id === 'obsidian' ? { Notice: class {}, requestUrl() { throw Error('Network forbidden'); } } : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text, 'generation-resume');
  m = mod.exports;
});

function fixture() {
  const h = m.makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Synthetic', text: 'Amber stores heat.' });
  const settings = { provider: 'codex', codexModel: 'synthetic', language: '', critiquePass: true, lintMode: 'badge', concurrency: 1, notifyWhenReady: false };
  const preparation = { facts: [{ id: 'F1', statement: h.text, quote: h.text }], plan: [{ id: 'P1', factIds: ['F1'], entity: 'Amber', aspect: 'storage', value: 'heat', reason: 'Stated property.' }], exclusions: [], omissions: [], conflicts: [] };
  const draft = { planId: 'P1', factIds: ['F1'], kind: 'qa', front: 'What does Amber store?', back: 'heat', text: '' };
  const card = m.makeCard(h.id, draft);
  card.generation = { batchId: 'legacy', planId: 'P1', factIds: ['F1'], audit: { status: 'unverified', reason: 'Not checked.', content: m.cardAuditContent(card), sourceKey: m.generationSourceKey(h) } };
  const audit = { status: 'verified', reason: 'Saved check.', contents: [m.cardAuditContent(card)], verdicts: [auditVerdict(card, { index: 0, cardId: card.id, status: 'verified', reason: 'Supported.', conflicts: [] })] };
  const batch = h.generation = { version: 1, id: 'legacy', instruction: '', inputKey: '', phase: 'preparing', provenance: { build: { release: 'legacy-release' }, sourceKey: m.generationSourceKey(h), inputKey: '' } };
  const calls = [], llm = new m.LlmClient(() => settings);
  llm.codex = { async complete(req) {
    calls.push(req.label);
    const user = JSON.parse(req.user);
    return req.schema.parse(req.label === 'preparation' ? preparation : req.label === 'grounded cards' ? { cards: [draft] } : { verdicts: user.cards.map((c, index) => (auditVerdict(c, { index, cardId: c.id, status: 'verified', reason: 'Supported.', conflicts: [] }))) });
  } };
  const plugin = { settings, llm, store: { all: () => [h], touch() {}, notify() {}, async flush() {}, hasUnsavedChanges: false }, refreshStatusBar() {} };
  return { h, settings, preparation, draft, card, audit, batch, calls, llm, plugin, g: new m.Generator(plugin) };
}

function unknownStage(f, stage) {
  const b = f.batch;
  if (stage === 'preparation') { b.preparationRequested = true; return; }
  b.preparation = structuredClone(f.preparation);
  b.preparation.conflicts = [{ factIds: ['F1'], quote: f.h.text, reason: 'Saved source hold.' }];
  if (stage === 'writer') { b.writingRequested = true; return; }
  b.writerOutput = [f.draft];
  b.drafts = [f.card];
  if (stage === 'audit') { b.auditRequested = true; return; }
  b.audit = structuredClone(f.audit);
  if (stage === 'final audit') { b.finalAuditRequested = true; return; }
  b.repairs = [{ cardId: f.card.id, round: 0, content: m.cardAuditContent(f.card), findings: ['Saved quality finding.'], requested: true }];
}

for (const fingerprint of ['empty', 'absent']) for (const stage of ['preparation', 'writer', 'audit', 'final audit', 'repair']) {
  test(`${fingerprint} key unknown ${stage} holds without dispatch and explicit Retry archives its paid checkpoint`, async () => {
    const f = fixture();
    unknownStage(f, stage);
    if (fingerprint === 'absent') delete f.batch.inputKey;
    const parsed = m.parseInboxJson(JSON.stringify({ version: 1, highlights: [f.h] }));
    assert.equal(parsed.ok, fingerprint === 'empty', 'the parser accepts empty legacy keys but rejects absent keys without migration');
    if (parsed.ok) Object.assign(f.h, parsed.data.highlights[0]);
    const original = structuredClone(f.h.generation);
    await f.g.run(f.h);
    assert.deepEqual(f.calls, []);
    assert.equal(f.h.status, 'error');
    assert.match(f.h.error, /prior paid outcome is unknown/i);
    assert.equal(f.h.generation.inputKey, original.inputKey);
    assert.deepEqual(f.h.generation.provenance, original.provenance);
    assert.deepEqual(f.h.generation.preparation, original.preparation);
    assert.deepEqual(f.h.cards, []);
    const held = structuredClone(f.h.generation);
    const retry = new m.Generator(f.plugin);
    retry.kick = () => {};
    retry.retry(f.h);
    assert.equal(f.h.generation.repairRound, 1, 'explicit Retry still authorizes a new bounded round');
    await retry.run(f.h);
    assert.deepEqual(f.calls, ['preparation', 'grounded cards', 'audit']);
    assert.notEqual(f.h.generation.id, held.id);
    assert.deepEqual(f.h.generationHistory.find(b => b.id === held.id), held, 'Retry must not erase the old unknown-request marker or source findings');
    assert.equal(f.h.cards.length, 1);
    assert.equal(f.h.cards[0].generation.batchId, f.h.generation.id);
  });
}

function completedStage(f, stage) {
  const b = f.batch;
  b.preparation = structuredClone(f.preparation);
  b.preparationRequested = true;
  if (stage === 'preparation') return;
  b.writerOutput = [f.draft];
  b.writingRequested = true;
  if (stage === 'writer output') return;
  b.drafts = [f.card];
  if (stage === 'drafts') return;
  b.audit = structuredClone(f.audit);
  b.auditRequested = true;
  if (stage === 'audit') return;
  b.repairs = [{ cardId: f.card.id, round: 0, content: m.cardAuditContent(f.card), findings: ['Earlier wording issue.'], requested: true, output: [f.draft], candidate: structuredClone(f.card) }];
  if (stage === 'repair') return;
  b.finalAudit = structuredClone(f.audit);
  b.finalAuditRequested = true;
}

for (const stage of ['preparation', 'writer output', 'drafts', 'audit', 'repair', 'final audit']) {
  test(`unkeyed completed ${stage} starts fresh and preserves evidence and existing cards`, async () => {
    const f = fixture();
    completedStage(f, stage);
    f.batch.preparation.conflicts = [{ factIds: ['F1'], quote: f.h.text, reason: 'Legacy source finding.' }];
    f.batch.blocked = [{ cardId: f.card.id, reasons: ['Legacy held target.'] }];
    const existing = m.makeCard(f.h.id, { kind: 'qa', front: 'User question', back: 'User answer', status: 'exported', edited: true, ankiNoteId: 123 });
    f.h.cards.push(existing);
    const old = structuredClone(f.batch), cardBefore = structuredClone(existing);
    await f.g.run(f.h);
    assert.deepEqual(f.calls, ['preparation', 'grounded cards', 'audit']);
    assert.notEqual(f.h.generation.id, old.id);
    assert.deepEqual(f.h.generationHistory[0], old);
    assert.deepEqual(f.h.cards[0], cardBefore);
    assert.notEqual(f.h.cards[1].id, f.card.id, 'a legacy staged identity cannot be certified');
  });

  test(`matching fingerprint reuses completed ${stage} without repeating paid stages`, async () => {
    const f = fixture();
    completedStage(f, stage);
    f.batch.inputKey = m.generationKey(f.h, await f.llm.generationContext(), f.settings, f.batch.id);
    f.batch.provenance.inputKey = f.batch.inputKey;
    await f.g.run(f.h);
    assert.equal(f.h.generation.id, f.batch.id);
    assert.deepEqual(f.calls, stage === 'preparation' ? ['grounded cards', 'audit'] : ['writer output', 'drafts'].includes(stage) ? ['audit'] : stage === 'repair' ? ['final audit'] : []);
    assert.equal(f.h.cards.length, 1);
    if (!['preparation', 'writer output'].includes(stage)) assert.equal(f.h.cards[0].id, f.card.id);
  });
}

for (const inputKey of ['', undefined]) test(`a fresh blank batch with ${inputKey === '' ? 'empty' : 'absent'} key stays valid`, async () => {
  const f = fixture();
  if (inputKey === undefined) delete f.batch.inputKey;
  await f.g.run(f.h);
  assert.equal(f.h.generation.id, f.batch.id);
  assert.deepEqual(f.calls, ['preparation', 'grounded cards', 'audit']);
  assert.equal(f.h.generationHistory, undefined);
});

test('a matching committed batch protects published user edits without any dispatch', async () => {
  const f = fixture();
  completedStage(f, 'audit');
  f.batch.committed = true;
  f.h.cards.push(f.card);
  f.card.back = 'User edit after publication';
  f.card.edited = true;
  f.batch.inputKey = m.generationKey(f.h, await f.llm.generationContext(), f.settings, f.batch.id);
  const before = structuredClone(f.h.cards);
  await f.g.run(f.h);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.h.cards, before);
});

for (const boundary of ['initial context', 'replacement context']) for (const mutation of ['source', 'settings', 'stages']) test(`${mutation} mutation during ${boundary} revokes legacy replacement before dispatch`, async () => {
  const f = fixture();
  completedStage(f, 'drafts');
  const context = f.llm.generationContext.bind(f.llm);
  let reads = 0;
  f.llm.generationContext = async (...args) => {
    const result = await context(...args);
    if (++reads === (boundary === 'initial context' ? 1 : 2)) {
      if (mutation === 'source') f.h.before = 'Changed context';
      else if (mutation === 'settings') f.settings.language = 'French';
      else f.h.generation.preparation = structuredClone(f.preparation);
    }
    return result;
  };
  // The initial mutation must differ from the staged snapshot too.
  if (mutation === 'stages') f.batch.preparation.conflicts.push({ factIds: ['F1'], quote: f.h.text, reason: 'Saved source hold.' });
  await f.g.run(f.h);
  assert.deepEqual(f.calls, []);
  assert.equal(f.h.status, 'error');
  assert.match(f.h.error, /inputs changed/i);
  assert.deepEqual(f.h.cards, []);
});

test('configured agents preserve the three-call clean generation workflow', async () => {
  const f = fixture(), routes = [];
  f.settings.effort = 'high'; f.settings.cheapModels = { codex: 'cheap-writer' }; f.settings.cheapEffort = 'medium';
  const complete = f.llm.codex.complete;
  f.llm.codex.complete = req => { routes.push([req.label, req.model, req.effort]); return complete(req); };
  await f.g.run(f.h);
  assert.deepEqual(routes, [['preparation', 'synthetic', 'high'], ['grounded cards', 'cheap-writer', 'medium'], ['audit', 'synthetic', 'high']]);
  assert.equal(f.h.cards.length, 1);
});
for (const setting of ['cheapModels', 'cheapEffort']) test(`changing ${setting} during writing holds stale output without auditing or publishing`, async () => {
  const f = fixture();
  const complete = f.llm.codex.complete;
  f.llm.codex.complete = async req => {
    const result = await complete(req);
    if (req.label === 'grounded cards') f.settings[setting] = setting === 'cheapModels' ? { codex: 'different' } : 'medium';
    return result;
  };
  await f.g.run(f.h);
  assert.deepEqual(f.calls, ['preparation', 'grounded cards']);
  assert.equal(f.h.cards.length, 0); assert.equal(f.h.status, 'error');
});
