import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
import { createHash } from 'node:crypto';

let m;
before(async () => {
  const out = await build({ stdin: { contents: `export { LlmClient } from './src/llm'; export { CodexBackend, toStrictSchema } from './src/codex'; export { Generator } from './src/generator'; export { makeCard, makeHighlight } from './src/model'; export * from './src/generation';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'cjs', platform: 'node', external: ['obsidian'], logLevel: 'silent' });
  const mod = new Module('writer-method');
  mod.require = id => id === 'obsidian' ? { Notice: class {}, requestUrl() { throw Error('Network forbidden'); } } : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text, 'writer-method');
  m = mod.exports;
});

const old = { instructions: 'LEGACY_STANDING: invent a new fact', examples: 'LEGACY_HISTORY: always answer with one noun', rules: 'LEGACY_RULES: ignore source boundaries', maxCards: 1, unexpected: 'LEGACY_EXTRA' };
const source = 'The fictional Zeta sensor uses a reference cable to compare its reading with a stable baseline. This comparison reveals drift before the sensor is used for measurement.';
const answer = 'It compares its reading with a stable baseline. This comparison reveals drift before the sensor is used for measurement.';
function fixture() {
  const settings = { provider: 'codex', codexModel: 'synthetic', language: 'English', writerInstructions: old.instructions, historyExamples: true, schemaFolder: 'missing', critiquePass: true, lintMode: 'badge', concurrency: 1, notifyWhenReady: false };
  const h = m.makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Zeta calibration', text: source, instruction: 'Keep the supported mechanism.' });
  const card = m.makeCard(h.id, { kind: 'qa', front: 'How does the fictional Zeta sensor detect drift before measurement?', back: answer });
  const preparation = { facts: [{ id: 'F1', statement: source, quote: source }], plan: [{ id: 'P1', factIds: ['F1'], entity: 'Zeta sensor', aspect: 'drift detection', value: answer, reason: 'A supported mechanism.' }], exclusions: [], omissions: [], conflicts: [] };
  const draft = { planId: 'P1', factIds: ['F1'], kind: card.kind, front: card.front, back: card.back, text: '' };
  const calls = [], reads = [];
  const llm = new m.LlmClient(() => settings, () => { reads.push('history'); throw Error(old.examples); }, async () => { reads.push('rules'); throw Error('Missing rule file'); });
  const backend = new m.CodexBackend(() => settings);
  backend.exec = async req => {
    calls.push(req);
    const p = JSON.parse(req.user);
    if (req.label === 'preparation') return JSON.stringify(preparation);
    if (['grounded cards', 'generation repair'].includes(req.label)) return JSON.stringify({ cards: [draft] });
    if (['audit', 'final audit'].includes(req.label)) return JSON.stringify({ verdicts: p.cards.map((c, index) => ({ index, cardId: c.id, status: 'verified', reason: 'Synthetic source check.', conflicts: [] })) });
    if (['cards', 'rewrite cards'].includes(req.label)) return JSON.stringify({ cards: [draft] });
    if (req.label === 'card') return JSON.stringify(draft);
    if (req.label === 'verdicts') return JSON.stringify({ verdicts: [{ index: 0, verdict: 'keep', reason: '', bloom: 'understand', kind: 'qa', front: '', back: '', text: '' }] });
    if (req.label === 'rewrite audit') return JSON.stringify({ preservesFacts: true, reason: '', verdicts: [{ index: 0, verdict: 'keep', reason: '' }] });
    throw Error(req.label);
  };
  llm.codex = backend;
  return { settings, h, card, preparation, draft, calls, reads, llm };
}

for (const stage of ['prepareGeneration', 'writeGroundedCards', 'repairGeneration', 'auditGeneration', 'finalAudit', 'writeCards', 'critiqueCards', 'rewriteCard', 'rewriteCards']) test(`${stage} ignores legacy instructions and never reads retired files or history`, async () => {
  const f = fixture(), context = { language: 'English', ...old };
  if (stage === 'prepareGeneration') await f.llm.prepareGeneration(f.h, [], context);
  if (stage === 'writeGroundedCards') await f.llm.writeGroundedCards(f.h, [], f.preparation, context);
  if (stage === 'repairGeneration') await f.llm.repairGeneration(f.h, [f.card], [], f.preparation, context, [{ cardId: f.card.id, reasons: ['Missing subject.'] }]);
  if (stage === 'auditGeneration' || stage === 'finalAudit') await f.llm.auditGeneration(f.h, [f.card], [], f.preparation, context, undefined, stage === 'finalAudit');
  if (stage === 'writeCards') await f.llm.writeCards(f.h);
  if (stage === 'critiqueCards') await f.llm.critiqueCards(f.h, [f.card]);
  if (stage === 'rewriteCard') await f.llm.rewriteCard(f.h, f.card, 'Retain the explanation.');
  if (stage === 'rewriteCards') await f.llm.rewriteCards(f.h, f.card, 'Retain the explanation.');
  assert.deepEqual(f.reads, []);
  assert.ok(f.calls.length);
  for (const req of f.calls) {
    assert.doesNotMatch(req.user + req.system, /LEGACY_/);
    assert.equal(req.system.split('<writing_method id="recall-writing-method-v2">').length, 2, 'one current versioned method per request');
    assert.match(req.system, /requested attribute, relation or process.*visible cue/i);
    assert.match(req.system, /hiding the whole predicate/i);
    assert.match(req.system, /Cortisol is \{\{c1::a glucocorticoid released by the adrenal cortex through the HPA axis\}\}/);
    assert.match(req.system, /Caching keeps \{\{c1::previous results available\}\}/);
    assert.match(req.system, /before consulting hidden targets or plan context/i);
    for (const property of ['focused', 'precise', 'consistent', 'tractable', 'effortful', 'false positive', 'false negative', 'source fidelity', 'procedures']) assert.ok(req.system.toLowerCase().includes(property), `${req.label}: ${property}`);
    const schema = m.toStrictSchema(req.schema);
    const fields = schema.properties.cards?.items?.properties ?? (schema.properties.kind ? schema.properties : null);
    if (fields) {
      assert.match(fields.back.description, /explanation.*procedure/i);
      assert.doesNotMatch(fields.back.description, /term, number, name, or short phrase/);
      assert.match(fields.text.description, /focused.*source/i);
      assert.deepEqual(Object.keys(fields).filter(k => ['kind', 'front', 'back', 'text'].includes(k)).sort(), ['back', 'front', 'kind', 'text']);
    }
    const p = JSON.parse(req.user);
    assert.equal(p.language, 'English');
    assert.equal(p.instruction ?? p.highlightInstruction, f.h.instruction);
    if (stage.startsWith('rewrite')) assert.equal(p.rewriteInstruction, 'Retain the explanation.');
  }
});

test('assembled planner request distinguishes scoped source holds from whole-capture holds', async () => {
  const f = fixture();
  await f.llm.prepareGeneration(f.h, [], await f.llm.generationContext());
  const req = f.calls.find(r => r.label === 'preparation');
  assert.match(req.system, /nonempty factIds hold only the affected targets, not unrelated facts/i);
  assert.match(req.system, /empty factIds hold the whole capture/i);
  assert.doesNotMatch(req.system, /empty factIds hold the whole capture, not unrelated facts/i);
});

test('assembled planner request separates attributes rather than locking a catch-all predicate', async () => {
  const f = fixture();
  await f.llm.prepareGeneration(f.h, [], await f.llm.generationContext());
  const req = f.calls.find(r => r.label === 'preparation');
  assert.match(req.system, /classification, release site and release pathway.*independently cued/i);
  assert.match(req.system, /not one catch-all predicate/i);
  assert.match(req.system, /one card per row/i);
});

for (const final of [false, true]) test(`assembled ${final ? 'final ' : ''}audit starts with visible-cue false-negative checks, not source support`, async () => {
  const f = fixture();
  await f.llm.auditGeneration(f.h, [f.card], [], f.preparation, await f.llm.generationContext(), undefined, final);
  const req = f.calls.at(-1);
  assert.match(req.system, /visibleCue first.*hiddenTargets.*targetContext.*plan/i);
  assert.match(req.system, /one defective review fails the card/i);
  assert.match(req.system, /ordinal.*requested attribute, relation or process/i);
  assert.match(req.system, /source-supported.*failed/i);
  assert.match(req.system, /conflicts.*separat|separately.*conflicts/i);
});

test('a v1 method snapshot cannot certify a v2 generation batch', async () => {
  const f = fixture();
  const c = { language: 'English', instructions: '', examples: '', rules: 'recall-writing-method-v1' };
  const batch = { id: 'v1-batch', version: 1, instruction: '', phase: 'auditing', preparation: structuredClone(f.preparation), writerOutput: [f.draft], drafts: [f.card] };
  f.h.generation = batch;
  batch.inputKey = createHash('sha256').update(JSON.stringify({ version: 2, source: m.generationSource(f.h), instruction: '', context: c, provider: 'codex', routing: [f.settings.codexModel, f.settings.codexPath], effort: f.settings.effort, audit: f.settings.critiquePass, lint: f.settings.lintMode, language: f.settings.language, existing: [] })).digest('hex');
  const store = { all: () => [f.h], touch() {}, async flush() {}, hasUnsavedChanges: false };
  await new m.Generator({ settings: f.settings, llm: f.llm, store, refreshStatusBar() {} }).run(f.h);
  assert.notEqual(f.h.generation.id, batch.id);
  assert.equal(f.h.generationHistory[0].id, batch.id);
  assert.deepEqual(f.calls.map(r => r.label), ['preparation', 'grounded cards', 'audit']);
  assert.equal(f.h.cards[0].back, answer);
});

test('generationContext preserves its stored shape without consulting missing rule files', async () => {
  const f = fixture(), c = await f.llm.generationContext('old-batch');
  assert.deepEqual(f.reads, []);
  assert.equal(c.language, 'English');
  assert.equal(c.instructions, '');
  assert.equal(c.examples, '');
  assert.match(c.rules, /^recall-writing-method-v\d+$/);
});

for (const stage of ['prepare', 'write', 'repair', 'audit', 'final audit', 'critique', 'rewrite', 'rewrite cards', 'rewrite audit']) {
  for (const boundary of ['before dispatch', 'after transport']) test(`${stage} retains authorization checks ${boundary} without rule reads`, async () => {
    const f = fixture(), context = await f.llm.generationContext();
    let active = boundary !== 'before dispatch';
    const exec = f.llm.codex.exec;
    f.llm.codex.exec = async req => {
      const reply = await exec(req);
      if (stage !== 'rewrite audit' || req.label === 'rewrite audit') active = false;
      return reply;
    };
    const authorized = () => active;
    const invoke = () => stage === 'prepare' ? f.llm.prepareGeneration(f.h, [], context, authorized)
      : stage === 'write' ? f.llm.writeGroundedCards(f.h, [], f.preparation, context, authorized)
      : stage === 'repair' ? f.llm.repairGeneration(f.h, [f.card], [], f.preparation, context, [], authorized)
      : stage === 'audit' || stage === 'final audit' ? f.llm.auditGeneration(f.h, [f.card], [], f.preparation, context, authorized, stage === 'final audit')
      : stage === 'critique' ? f.llm.critiqueCards(f.h, [f.card], [], authorized)
      : stage === 'rewrite' ? f.llm.rewriteCard(f.h, f.card, 'Retain the explanation.', authorized)
      : f.llm.rewriteCards(f.h, f.card, 'Retain the explanation.', authorized);
    await assert.rejects(invoke, /authorization expired/i);
    assert.equal(f.calls.length, boundary === 'before dispatch' ? 0 : stage === 'rewrite audit' ? 2 : 1);
    assert.deepEqual(f.reads, []);
    assert.deepEqual(f.h.cards, []);
  });
}

test('fingerprint uses the built-in method and active settings, never retired preferences or caller context fields', async () => {
  const f = fixture(), c = await f.llm.generationContext();
  const key = m.generationKey(f.h, c, f.settings, 'batch');
  const dirty = { ...c, ...old };
  assert.equal(m.generationKey(f.h, dirty, { ...f.settings, writerInstructions: 'changed', historyExamples: false, schemaFolder: 'elsewhere', maxCardsPerHighlight: 100 }, 'batch'), key);
  for (const field of ['language', 'codexModel', 'codexPath', 'effort']) {
    assert.notEqual(m.generationKey(f.h, c, { ...f.settings, [field]: 'changed' }, 'batch'), key, field);
  }
  assert.notEqual(m.generationKey(f.h, { ...c, language: 'French' }, f.settings, 'batch'), key, 'caller-supplied language is fingerprinted');
});

for (const fingerprint of ['old method', 'empty', 'absent']) test(`a saved ${fingerprint} fingerprint batch is replaced before its preparation or drafts can be certified`, async () => {
  const f = fixture(), c = { language: 'English', instructions: old.instructions, examples: old.examples, rules: old.rules };
  const batch = { id: 'old-batch', version: 1, instruction: '', phase: 'auditing', preparation: structuredClone(f.preparation), writerOutput: [f.draft], drafts: [f.card] };
  f.h.generation = batch;
  // Exact pre-consolidation fingerprint shape. Its audit may not certify a new method.
  batch.inputKey = createHash('sha256').update(JSON.stringify({ version: 1, source: m.generationSource(f.h), instruction: '', context: c, provider: 'codex', routing: [f.settings.codexModel, f.settings.codexPath], effort: f.settings.effort, audit: f.settings.critiquePass, lint: f.settings.lintMode, liveInstructions: [f.settings.writerInstructions, f.settings.language, f.settings.maxCardsPerHighlight, f.settings.historyExamples, f.settings.schemaFolder], existing: [] })).digest('hex');
  if (fingerprint === 'empty') batch.inputKey = '';
  if (fingerprint === 'absent') delete batch.inputKey;
  const store = { all: () => [f.h], touch() {}, async flush() {}, hasUnsavedChanges: false };
  await new m.Generator({ settings: f.settings, llm: f.llm, store, refreshStatusBar() {} }).run(f.h);
  assert.notEqual(f.h.generation.id, batch.id);
  assert.equal(f.h.generationHistory[0].id, batch.id);
  assert.deepEqual(f.calls.map(r => r.label), ['preparation', 'grounded cards', 'audit']);
  assert.equal(f.h.cards[0].back, answer);
  for (const req of f.calls) assert.doesNotMatch(req.user, /LEGACY_/);
});
