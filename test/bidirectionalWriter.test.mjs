import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let m, requests;
const source = 'In Neral notation, velin is defined as a pause between repeated pulses.';
const good = 'In Neral notation, {{c2::velin}} is defined as {{c1::a pause between repeated pulses}}.';
const bad = 'In Neral notation, {{c1::velin}} is defined as {{c1::a pause between repeated pulses}}.';

before(async () => {
  const out = await build({ stdin: { contents: `export { LlmClient } from './src/llm'; export { CodexBackend, toStrictSchema } from './src/codex'; export { makeCard, makeHighlight } from './src/model'; export { renderedCardReviews } from './src/generation'; export { WRITING_METHOD_ID } from './src/writerMethod';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'cjs', platform: 'node', external: ['obsidian'], logLevel: 'silent' });
  const mod = new Module('bidirectional-writer');
  mod.require = id => id === 'obsidian' ? { Notice: class {}, requestUrl() { throw Error('Network forbidden'); } } : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text, 'bidirectional-writer');
  m = mod.exports;
  const settings = { provider: 'codex', codexModel: 'synthetic', language: 'English' };
  const llm = new m.LlmClient(() => settings), backend = new m.CodexBackend(() => settings);
  const h = m.makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Neral notation', text: source });
  const card = m.makeCard(h.id, { kind: 'cloze', text: good });
  const preparation = { facts: [{ id: 'F1', statement: source, quote: source }], plan: [{ id: 'P1', factIds: ['F1'], entity: 'velin', aspect: 'term and definition', value: 'a pause between repeated pulses', reason: 'Two focused retrieval directions.' }], exclusions: [], omissions: [], conflicts: [] };
  const draft = { planId: 'P1', factIds: ['F1'], kind: 'cloze', front: '', back: '', text: good };
  requests = [];
  // Capture production requests; synthetic replies do not test model judgments.
  backend.exec = async req => {
    requests.push(req);
    if (req.label === 'preparation') return JSON.stringify(preparation);
    if (['grounded cards', 'generation repair', 'cards', 'rewrite cards'].includes(req.label)) return JSON.stringify({ cards: [draft] });
    if (req.label === 'card') return JSON.stringify(draft);
    if (['audit', 'final audit'].includes(req.label)) return JSON.stringify({ verdicts: [{ index: 0, cardId: card.id, status: 'verified', reason: 'Synthetic transport fixture, not a semantic judgment.', conflicts: [] }] });
    if (req.label === 'verdicts') return JSON.stringify({ verdicts: [{ index: 0, verdict: 'keep', reason: '', bloom: 'remember', kind: 'cloze', front: '', back: '', text: '' }] });
    if (req.label === 'rewrite audit') return JSON.stringify({ preservesFacts: true, reason: 'Synthetic transport fixture.', verdicts: [{ index: 0, verdict: 'keep', reason: '' }] });
    throw Error(req.label);
  };
  llm.codex = backend;
  const context = await llm.generationContext();
  await llm.prepareGeneration(h, [], context);
  await llm.writeGroundedCards(h, [], preparation, context);
  await llm.repairGeneration(h, [card], [], preparation, context, [{ cardId: card.id, reasons: ['Check each retrieval direction.'] }]);
  await llm.auditGeneration(h, [card], [], preparation, context);
  await llm.auditGeneration(h, [card], [], preparation, context, undefined, true);
  await llm.writeCards(h);
  await llm.critiqueCards(h, [card]);
  await llm.rewriteCard(h, card, 'Keep both focused retrieval directions.');
  await llm.rewriteCards(h, card, 'Keep both focused retrieval directions.');
  assert.deepEqual(requests.map(r => r.label), ['preparation', 'grounded cards', 'generation repair', 'audit', 'final audit', 'cards', 'verdicts', 'card', 'rewrite cards', 'rewrite audit']);
  if (process.env.RECALL_PROMPT_EVIDENCE_DIR) {
    mkdirSync(process.env.RECALL_PROMPT_EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(process.env.RECALL_PROMPT_EVIDENCE_DIR, 'bidirectional-writer-requests.json'), JSON.stringify(requests.map(({ label, system, user, schema }) => ({ label, system, user: JSON.parse(user), schema: m.toStrictSchema(schema) })), null, 2));
  }
});

test('every assembled writing/checking stage prefers a supported reciprocal note with different numbers', () => {
  for (const req of requests) {
    const method = req.system.split('</writing_method>')[0];
    assert.ok(method.includes(`<good>${good}</good>`), `${req.label}: good reciprocal contrast`);
    assert.ok(method.includes(`<bad>${bad}</bad>`), `${req.label}: same-number contrast`);
    assert.match(method, /prefer one.*term-definition.*different cloze numbers/i);
    assert.match(method, /only when both.*visible cues.*distinguish/i);
    assert.match(method, /do not force.*revers/i);
    assert.match(method, /ambiguous.*reverse|reverse.*ambiguous/i);
    assert.match(method, /never invent distinguishing facts/i);
    assert.match(method, /answer leaks/i);
  }
});

test('shared cue checks permit term identification without weakening ordinary subject/relation checks', () => {
  for (const req of requests) {
    const method = req.system.split('</writing_method>')[0];
    assert.match(method, /term-identification.*visible definition.*essential context.*distinguish/i);
    assert.match(method, /ordinary attribute, mechanism and consequence.*subject.*requested relation.*visible/i);
    assert.match(method, /cite exact visible words for.*identifying cue.*requested relation/i);
    assert.doesNotMatch(method, /cite exact visible words for BOTH the system identity AND the requested relation/i);
    assert.doesNotMatch(method, /(?:^|\. )Name the specific system using its identifying visible words, not the hidden target or metadata\./i);
  }
});

test('assembled planner keeps reciprocal targets in one row when independently cued', () => {
  const task = requests.find(r => r.label === 'preparation').system;
  assert.match(task, /term-definition.*different cloze numbers/i);
  assert.match(task, /both.*visible cues.*distinguish/i);
});

for (const label of ['audit', 'final audit']) test(`${label} task accepts identifying definitions instead of demanding the hidden name`, () => {
  const req = requests.find(r => r.label === label);
  const task = req.system;
  assert.match(task, /term-identification.*visible definition.*essential context.*distinguish/i);
  assert.match(task, /hidden name alone is not a defect/i);
  assert.match(task, /ordinary attribute, mechanism and consequence.*name the specific system.*visibleCue/i);
  assert.match(task, /quote.*identifying cue.*requested relation/i);
  assert.doesNotMatch(task, /For each ordinal, name the specific system/i);
  assert.doesNotMatch(task, /for both the system identity and requested relation/i);
  assert.deepEqual(JSON.parse(req.user).cards[0].reviews, [
    { ordinal: 1, visibleCue: 'In Neral notation, velin is defined as [...].', hiddenTargets: ['a pause between repeated pulses'] },
    { ordinal: 2, visibleCue: 'In Neral notation, [...] is defined as a pause between repeated pulses.', hiddenTargets: ['velin'] },
  ]);
});

test('transport field descriptions allow definition-cued terms for QA and cloze', () => {
  for (const req of requests) {
    const schema = m.toStrictSchema(req.schema);
    const fields = schema.properties.cards?.items?.properties ?? (schema.properties.kind ? schema.properties : null);
    if (!fields) continue;
    assert.match(fields.front.description, /identifying definition.*term-identification/i, req.label);
    assert.doesNotMatch(fields.front.description, /question naming its subject/i, req.label);
    assert.match(fields.text.description, /visible definition.*hidden term/i, req.label);
    assert.match(fields.text.description, /each rendered review/i, req.label);
    assert.deepEqual(Object.keys(fields).filter(k => ['kind', 'front', 'back', 'text'].includes(k)).sort(), ['back', 'front', 'kind', 'text']);
  }
});

test('current v9 identity carries the reciprocal contract without inheriting older approval', () => {
  assert.equal(m.WRITING_METHOD_ID, 'recall-writing-method-v9');
  for (const req of requests) {
    assert.equal(req.system.split('<writing_method id="recall-writing-method-v9">').length, 2);
    assert.equal(JSON.parse(req.user).rules, 'recall-writing-method-v9');
  }
});
