import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';

let g;
before(async () => {
  const out = await build({ entryPoints: ['src/generation.ts'], bundle: true, write: false, format: 'cjs', platform: 'node' });
  const mod = new Module('draft-field-tolerance');
  mod._compile(out.outputFiles[0].text, 'draft-field-tolerance');
  g = mod.exports;
});

const SOURCE = 'Seed dormancy delays germination.';
const preparation = {
  facts: [{ id: 'F1', statement: 'Dormancy delays germination.', quote: SOURCE }],
  plan: [{ id: 'P1', factIds: ['F1'], entity: 'dormancy', aspect: 'effect', value: 'delays germination', reason: 'A supported fact.' }],
  exclusions: [], omissions: [], conflicts: [],
};

const draft = (extra) => ({ planId: 'P1', factIds: ['F1'], ...extra });

test('a cloze draft that also fills the unused qa fields is accepted and normalized', () => {
  const out = g.validateDrafts({ cards: [draft({ kind: 'cloze', front: 'What does dormancy delay?', back: 'Germination', text: 'Seed dormancy delays {{c1::germination}}.' })] }, preparation);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'cloze');
  assert.equal(out[0].text, 'Seed dormancy delays {{c1::germination}}.');
  assert.equal(out[0].front, '');
  assert.equal(out[0].back, '');
});

test('a qa draft that also echoes cloze text is accepted and normalized', () => {
  const out = g.validateDrafts({ cards: [draft({ kind: 'qa', front: 'What does seed dormancy delay?', back: 'Germination', text: 'Seed dormancy delays {{c1::germination}}.' })] }, preparation);
  assert.equal(out.length, 1);
  assert.equal(out[0].front, 'What does seed dormancy delay?');
  assert.equal(out[0].back, 'Germination');
  assert.equal(out[0].text, '');
});

test('a qa draft with no question or answer is still rejected', () => {
  assert.throws(() => g.validateDrafts({ cards: [draft({ kind: 'qa', front: '  ', back: '', text: '' })] }, preparation), /Malformed card fields/);
  assert.throws(() => g.validateDrafts({ cards: [draft({ kind: 'qa', front: 'What does dormancy delay?', back: '', text: '' })] }, preparation), /Malformed card fields/);
});

test('a cloze draft with no deletion text is still rejected', () => {
  assert.throws(() => g.validateDrafts({ cards: [draft({ kind: 'cloze', front: 'What?', back: 'Germination', text: '   ' })] }, preparation), /Malformed card fields/);
  assert.throws(() => g.validateDrafts({ cards: [draft({ kind: 'cloze', front: '', back: '', text: 'Seed dormancy delays germination.' })] }, preparation), /cloze|empty/i);
});

test('the card schema tells the writer which fields belong to which kind', () => {
  const shape = g.GroundedCardsOut.shape.cards.element.shape;
  assert.match(shape.front.description ?? '', /qa/i);
  assert.match(shape.back.description ?? '', /qa/i);
  assert.match(shape.text.description ?? '', /cloze/i);
  assert.match(shape.front.description ?? '', /empty/i);
  assert.match(shape.text.description ?? '', /empty/i);
});
