import { auditVerdict } from './auditFixture.mjs';
// Request-contract checks only: synthetic replies do not establish model grouping judgments.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let m, requests;
const source = 'The fictional Neral relay reports exactly two signal types: optical and acoustic.';
const combined = 'The fictional Neral relay reports exactly two signal types: {{c1::optical}} and {{c2::acoustic}}.';
const split = [
  'The fictional Neral relay reports exactly two signal types: {{c1::optical}} and acoustic.',
  'The fictional Neral relay reports exactly two signal types: optical and {{c1::acoustic}}.',
];

before(async () => {
  const out = await build({ stdin: { contents: `export { LlmClient } from './src/llm'; export { CodexBackend, toStrictSchema } from './src/codex'; export { makeCard, makeHighlight } from './src/model'; export { WRITING_METHOD_ID } from './src/writerMethod';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'cjs', platform: 'node', external: ['obsidian'], logLevel: 'silent' });
  const mod = new Module('cloze-grouping-writer');
  mod.require = id => id === 'obsidian' ? { Notice: class {}, requestUrl() { throw Error('Network forbidden'); } } : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text, 'cloze-grouping-writer');
  m = mod.exports;
  const settings = { provider: 'codex', codexModel: 'synthetic', language: 'English' };
  const llm = new m.LlmClient(() => settings), backend = new m.CodexBackend(() => settings);
  const h = m.makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Neral relay', text: source });
  const card = m.makeCard(h.id, { kind: 'cloze', text: combined });
  const preparation = {
    facts: ['optical', 'acoustic'].map((type, i) => ({ id: `F${i + 1}`, statement: `Neral relay signal type: ${type}.`, quote: source })),
    plan: [{ id: 'P1', factIds: ['F1', 'F2'], entity: 'Neral relay', aspect: 'signal types', value: 'optical and acoustic', reason: 'Two independently cued targets share one sentence.' }],
    exclusions: [], omissions: [], conflicts: [],
  };
  const draft = { planId: 'P1', factIds: ['F1', 'F2'], kind: 'cloze', front: '', back: '', text: combined };
  requests = [];
  // Reuse the real client, request assembly, schemas and parsers; intercept only transport.
  backend.exec = async req => {
    requests.push(req);
    if (req.label === 'preparation') return JSON.stringify(preparation);
    if (['grounded cards', 'generation repair', 'cards', 'rewrite cards'].includes(req.label)) return JSON.stringify({ cards: [draft] });
    if (req.label === 'card') return JSON.stringify(draft);
    if (['audit', 'final audit'].includes(req.label)) return JSON.stringify({ verdicts: [auditVerdict(card, { index: 0, cardId: card.id, status: 'verified', reason: 'Synthetic transport, not a semantic judgment.', conflicts: [] })] });
    if (req.label === 'verdicts') return JSON.stringify({ verdicts: [{ index: 0, verdict: 'keep', reason: '', bloom: 'remember', kind: 'cloze', front: '', back: '', text: '' }] });
    if (req.label === 'rewrite audit') return JSON.stringify({ preservesFacts: true, reason: 'Synthetic transport.', verdicts: [{ index: 0, verdict: 'keep', reason: '' }] });
    throw Error(req.label);
  };
  llm.codex = backend;
  const context = await llm.generationContext();
  await llm.prepareGeneration(h, [], context);
  await llm.writeGroundedCards(h, [], preparation, context);
  await llm.repairGeneration(h, [card], [], preparation, context, [{ cardId: card.id, reasons: ['Preserve grouped targets and fact links.'] }]);
  await llm.auditGeneration(h, [card], [], preparation, context);
  await llm.auditGeneration(h, [card], [], preparation, context, undefined, true);
  await llm.writeCards(h);
  await llm.critiqueCards(h, [card]);
  await llm.rewriteCard(h, card, 'Keep both supported targets in one note.');
  await llm.rewriteCards(h, card, 'Keep both supported targets in one note.');
  assert.deepEqual(requests.map(r => r.label), ['preparation', 'grounded cards', 'generation repair', 'audit', 'final audit', 'cards', 'verdicts', 'card', 'rewrite cards', 'rewrite audit']);
  if (process.env.RECALL_PROMPT_EVIDENCE_DIR) {
    mkdirSync(process.env.RECALL_PROMPT_EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(process.env.RECALL_PROMPT_EVIDENCE_DIR, 'cloze-grouping-writer-requests.json'), JSON.stringify(requests.map(({ label, system, user, schema }) => ({ label, system, user: JSON.parse(user), schema: m.toStrictSchema(schema) })), null, 2));
  }
});

test('every assembled stage carries v10 grouping without weakening focused reviews or reciprocal cues', () => {
  assert.equal(m.WRITING_METHOD_ID, 'recall-writing-method-v10');
  for (const req of requests) {
    assert.equal(req.system.split('<writing_method id="recall-writing-method-v10">').length, 2, req.label);
    assert.equal(JSON.parse(req.user).rules, m.WRITING_METHOD_ID, req.label);
    const method = req.system.split('</writing_method>')[0];
    assert.match(method, /aim for two to three useful distinct cloze numbers per note/i, req.label);
    assert.match(method, /one deletion is valid/i, req.label);
    assert.match(method, /coherent lists and enumerations may exceed three/i, req.label);
    assert.match(method, /never add filler or unsupported targets.*count/i, req.label);
    assert.match(method, /same coherent sentence or context.*one.*note/i, req.label);
    assert.match(method, /do not emit.*near-identical.*notes.*only.*hidden span/i, req.label);
    assert.match(method, /separately justified contexts.*separate notes/i, req.label);
    assert.match(method, /do not merge unrelated claims, cross-source notes or existing cards/i, req.label);
    assert.match(method, /prefer one.*term-definition.*different cloze numbers/i, req.label);
    assert.match(method, /do not force reversals/i, req.label);
    assert.match(method, /ordinary attribute, mechanism and consequence.*subject.*requested relation.*visible/i, req.label);
    assert.match(method, /answer leaks/i, req.label);
    for (const bad of split) assert.ok(method.includes(`<bad>${bad}</bad>`), `${req.label}: split-note contrast`);
    assert.ok(method.includes(`<good>${combined}</good>`), `${req.label}: combined-note contrast`);
    assert.match(method, /independent.*reviews.*not.*separate notes/i, req.label);
    assert.match(method, /checker.*flag avoidable split-note duplication/i, req.label);
    assert.match(method, /unresolved grouping.*held/i, req.label);
    assert.match(method, /never drop a row or fact.*merge/i, req.label);
  }
});

test('planner resolves same-sentence fragmentation before rows lock and retains every fact link', () => {
  const req = requests.find(r => r.label === 'preparation');
  const task = req.system;
  assert.match(task, /same coherent sentence or context.*one planned row/i);
  assert.match(task, /one note with all fact links/i);
  assert.match(task, /do not emit near-identical sentence notes differing only in the hidden span/i);
  assert.match(task, /separately justified contexts.*separate notes/i);
  assert.match(task, /exactly one card per row/i);
  const fields = m.toStrictSchema(req.schema).properties.plan.items.properties;
  assert.match(fields.factIds.description, /all.*fact IDs.*group/i);
  assert.match(fields.value.description, /coherent.*targets.*distinct cloze numbers/i);
});

for (const label of ['audit', 'final audit']) test(`${label} flags avoidable split-note duplication without repairing or dropping rows`, () => {
  const req = requests.find(r => r.label === label);
  const task = req.system;
  assert.match(task, /flag avoidable split-note duplication/i);
  assert.match(task, /separately justified contexts.*not.*duplication/i);
  assert.match(task, /unresolved grouping.*held.*never drop a row or fact/i);
  assert.match(task, /findings only: never repair cards/i);
  assert.deepEqual(JSON.parse(req.user).cards[0].reviews.map(r => r.hiddenTargets), [['optical'], ['acoustic']]);
});

test('serialized card descriptions prefer grouped distinct targets with no quota or new schema fields', () => {
  for (const req of requests) {
    const schema = m.toStrictSchema(req.schema);
    const fields = schema.properties.cards?.items?.properties ?? (schema.properties.kind ? schema.properties : null);
    if (!fields) continue;
    assert.match(fields.text.description, /aim for two to three useful distinct cloze numbers/i, req.label);
    assert.match(fields.text.description, /one deletion.*coherent.*more than three/i, req.label);
    assert.match(fields.text.description, /same coherent sentence or context.*one note/i, req.label);
    assert.match(fields.text.description, /no quota.*filler.*unsupported targets/i, req.label);
    assert.match(fields.text.description, /each rendered review.*identifying cue.*requested relation/i, req.label);
    assert.deepEqual(Object.keys(fields).filter(k => ['kind', 'front', 'back', 'text'].includes(k)).sort(), ['back', 'front', 'kind', 'text']);
  }
  for (const req of requests.filter(r => ['grounded cards', 'generation repair'].includes(r.label))) {
    assert.deepEqual(JSON.parse(req.user).preparation.plan[0].factIds, ['F1', 'F2']);
    assert.deepEqual(Object.keys(m.toStrictSchema(req.schema).properties.cards.items.properties).sort(), ['back', 'factIds', 'front', 'kind', 'planId', 'text']);
  }
  const repair = requests.find(r => r.label === 'generation repair');
  assert.match(repair.system, /exactly one replacement per supplied candidate.*exact factIds.*all planned meaning/i);
});
