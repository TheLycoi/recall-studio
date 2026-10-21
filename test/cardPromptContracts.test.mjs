import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';

let m;
before(async () => {
  const out = await build({ stdin: { contents: `export { Generator } from './src/generator'; export { LlmClient } from './src/llm'; export { makeCard, makeHighlight } from './src/model'; export { cardReplacement, exportCandidates } from './src/cardActions'; export { ungroundedClozes } from './src/util'; export { validateDrafts } from './src/generation';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'cjs', platform: 'node', external: ['obsidian'], logLevel: 'silent' });
  const mod = new Module('card-prompt-contracts');
  mod.require = id => id === 'obsidian' ? { Notice: class {}, requestUrl() { throw Error('Network forbidden'); } } : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text, 'card-prompt-contracts');
  m = mod.exports;
});

function fixture(source, text) {
  const h = m.makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Synthetic', text: source });
  const old = m.makeCard(h.id, { kind: 'qa', front: 'User question', back: 'User answer', extra: 'Manual annotation', status: 'exported', ankiNoteId: 123, edited: true });
  h.cards.push(old);
  const settings = { provider: 'codex', codexModel: 'synthetic', effort: 'low', writerInstructions: '', language: '', historyExamples: false, critiquePass: true, lintMode: 'badge', notifyWhenReady: false, concurrency: 1 };
  const calls = [];
  const preparation = { facts: [{ id: 'F1', statement: source, quote: source }], plan: [{ id: 'P1', factIds: ['F1'], entity: 'Synthetic', aspect: '', value: source, reason: 'Source-backed retrieval' }], exclusions: [], omissions: [], conflicts: [] };
  const llm = new m.LlmClient(() => settings);
  llm.codex = { complete: async req => {
    calls.push(req.label);
    if (req.label === 'preparation') return req.schema.parse(preparation);
    if (req.label === 'grounded cards') return req.schema.parse({ cards: [{ planId: 'P1', factIds: ['F1'], kind: 'cloze', front: '', back: '', text }] });
    return req.schema.parse({ verdicts: JSON.parse(req.user).cards.map((card, index) => ({ index, cardId: card.id, status: 'verified', reason: 'Synthetic positive audit, not a model judgment.' })) });
  } };
  const plugin = { settings, llm, store: { all: () => [h], touch() {}, async flush() {}, hasUnsavedChanges: false }, refreshStatusBar() {} };
  return { h, old, calls, preparation, plugin, g: new m.Generator(plugin) };
}

test('grounding rejects a token fragment before replacing an existing card', () => {
  const h = m.makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Synthetic', text: 'Heat cannot leave the vessel.', status: 'ready' });
  const original = m.makeCard(h.id, { kind: 'qa', front: 'What cannot leave?', back: 'Heat', extra: 'Keep this annotation' });
  h.cards = [original];
  const saved = structuredClone(original);
  const draft = { kind: 'cloze', front: '', back: '', text: 'Heat {{c1::can}} leave the vessel.' };
  assert.deepEqual(m.ungroundedClozes(draft.text, h.text), ['can']);
  assert.throws(() => m.cardReplacement(original, h, draft), /absent from the captured source/);
  assert.deepEqual(original, saved);
});

test('a synthetic positive audit cannot verify a cloze token fragment', async () => {
  const f = fixture('Heat cannot leave the vessel.', 'Heat {{c1::can}} leave the vessel.');
  await f.g.run(f.h);
  assert.equal(f.h.status, 'ready');
  assert.ok(f.h.cards[1].lintFailures?.includes('cloze-not-grounded'));
  assert.equal(f.h.cards[1].generation.audit.status, 'unverified');
  assert.equal(f.h.generation.audit.status, 'unverified');
});

for (const [body, source, missing] of [
  ['can', 'cannot', true], ['heat', 'reheat', true], ['12', '123', true],
  ['reaction time', 'reaction timer', true], ['reaction time', 'prereaction time', true],
  ['reaction time', 'Reaction—time.', false], ['1.3 billion', '1.3 billion members', false],
  ['replication', 'RÉPLICATION', false], ['réplication', 're\u0301plication', false],
  ['κόσμος', 'Ο κόσμος υπάρχει.', false], ['тепло', 'Тепло остаётся.', false],
  ['東京', '東京、大阪', false], ['東京', '東京都', true],
  ['reaction time', 'reaction and time', true],
]) test(`normalized phrase membership: ${JSON.stringify(body)} in ${JSON.stringify(source)}`, () => {
  assert.deepEqual(m.ungroundedClozes(`{{c1::${body}::hint}}`, source), missing ? [body] : []);
});

test('lexical presence alone does not establish the authored claim', () => {
  assert.deepEqual(m.ungroundedClozes('Heat cannot {{c1::leave}}.', 'Heat can leave.'), []);
});

const malformedClozes = [
  ['no deletion', 'Dormancy delays germination.'],
  ['zero ID', 'Dormancy delays {{c0::germination}}.'],
  ['blank body', 'Dormancy delays {{c1::   }}.'],
  ['empty body', 'Dormancy delays {{c1::}}.'],
  ['blank hinted body', 'Dormancy delays {{c1:: ::process}}.'],
  ['unclosed marker', 'Dormancy delays {{c1::germination}.'],
  ['extra broken marker', '{{c1::Dormancy}} delays {{c2::germination}.'],
  ['unmatched close', 'Dormancy delays {{c1::germination}}. }}'],
  ['nested marker', 'Dormancy delays {{c1::{{c2::germination}}}}.'],
  ['triple braces', 'Dormancy delays {{{c1::germination}}}.'],
];

for (const [name, text] of malformedClozes) {
  test(`writer rejects ${name} before audit and preserves existing cards`, async () => {
    const f = fixture('Dormancy delays germination.', text);
    const saved = structuredClone(f.old);
    const draft = { planId: 'P1', factIds: ['F1'], kind: 'cloze', front: '', back: '', text };
    assert.throws(() => m.validateDrafts({ cards: [draft] }, f.preparation), /cloze|empty/i);
    await f.g.run(f.h);
    assert.equal(f.h.status, 'error');
    assert.deepEqual(f.calls, ['preparation', 'grounded cards']);
    assert.equal(f.h.generation.drafts, undefined);
    assert.equal(f.h.generation.audit, undefined);
    assert.deepEqual(f.h.cards, [saved]);
    assert.equal(f.h.cards[0], f.old);
  });

  test(`resumed drafts reject ${name} before audit without changing stored drafts`, async () => {
    const f = fixture('Dormancy delays germination.', 'Dormancy delays {{c1::germination}}.');
    f.plugin.store.flush = async () => { if (f.h.generation?.drafts) throw Error('Synthetic checkpoint failure'); };
    await f.g.run(f.h);
    assert.deepEqual(f.calls, ['preparation', 'grounded cards']);
    const reloaded = JSON.parse(JSON.stringify(f.h));
    reloaded.generation.drafts[0].text = text;
    const savedDrafts = structuredClone(reloaded.generation.drafts);
    const savedCards = structuredClone(reloaded.cards);
    Object.assign(f.h, reloaded);
    f.plugin.store.flush = async () => {};
    await new m.Generator(f.plugin).run(f.h);
    assert.equal(f.h.status, 'error');
    assert.deepEqual(f.calls, ['preparation', 'grounded cards']);
    assert.equal(f.h.generation.audit, undefined);
    assert.deepEqual(f.h.generation.drafts, savedDrafts);
    assert.deepEqual(f.h.cards, savedCards);
  });
}

for (const text of [
  'Dormancy delays {{c1::germination}}.',
  '{{c1::Dormancy}} delays {{c1::germination}}.',
  '{{c1::Dormancy}} {{c2::delays}} {{c3::germination}}.',
  'Dormancy delays {{c1::germination::process}}.',
]) test(`valid cloze reaches audit and remains exportable: ${text}`, async () => {
  const f = fixture('Dormancy delays germination.', text);
  await f.g.run(f.h);
  assert.equal(f.h.status, 'ready');
  assert.deepEqual(f.calls, ['preparation', 'grounded cards', 'audit']);
  assert.equal(f.h.cards[1].text, text);
  assert.equal(f.h.cards[1].generation.audit.status, 'verified');
  assert.equal(m.exportCandidates([f.h]).length, 1);
});
