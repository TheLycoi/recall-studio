import { auditVerdict } from './auditFixture.mjs';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';

let generation;
before(async () => {
  const out = await build({ entryPoints: ['src/generation.ts'], bundle: true, write: false, format: 'cjs', platform: 'node' });
  const mod = new Module('generation-counts');
  mod._compile(out.outputFiles[0].text, 'generation-counts');
  generation = mod.exports;
});
test('preparation explicitly makes card and deletion counts source-driven', () => {
  assert.match(generation.PREPARATION_SYSTEM, /no fixed card quota/i);
  assert.match(generation.PREPARATION_SYSTEM, /no.*deletion.count limit/i);
  assert.doesNotMatch(generation.PREPARATION_SYSTEM, /Plan at most maxCards|because of the batch limit/i);
});

function inventory(count) {
  const facts = Array.from({ length: count }, (_, i) => ({ id: `F${i + 1}`, statement: `Item${i + 1} stores token${i + 1}.`, quote: `Item${i + 1} stores token${i + 1}.` }));
  const plan = facts.map((f, i) => ({ id: `P${i + 1}`, factIds: [f.id], entity: `Item${i + 1}`, aspect: 'property', value: `token${i + 1}`, reason: 'A distinct supported fact.' }));
  const cards = facts.map((f, i) => ({ planId: plan[i].id, factIds: [f.id], kind: 'cloze', front: '', back: '', text: `Item${i + 1} stores {{c1::token${i + 1}}}.` }));
  return { source: facts.map(f => f.quote).join(' '), preparation: { facts, plan, exclusions: [], omissions: [], conflicts: [] }, cards };
}

test('source-backed cloze cards are not capped by legacy batch counts or schema array quotas', () => {
  const { source, preparation, cards } = inventory(101);
  for (const oldLimit of [1, 5, 50]) {
    const p = generation.validatePreparation(preparation, source, oldLimit);
    assert.equal(p.plan.length, 101);
    assert.equal(generation.validateDrafts({ cards }, p, oldLimit).length, 101);
  }
  const committed = cards.map((c, i) => ({ ...c, id: `card-${i}` }));
  const verdicts = committed.map((c, index) => (auditVerdict(c, { index, cardId: c.id, status: 'verified', reason: 'Supported by the captured source.' })));
  assert.equal(generation.validateAudit({ verdicts }, committed).verdicts.length, 101);
});

test('no card quota does not permit fabricated fact links or silently omitted plans', () => {
  const { source, preparation, cards } = inventory(101);
  const p = generation.validatePreparation(preparation, source, 1);
  assert.throws(() => generation.validateDrafts({ cards: cards.slice(1) }, p, 1), /omitted/i);
  cards[100].factIds = ['F999'];
  assert.throws(() => generation.validateDrafts({ cards }, p, 1), /fact links/i);
});
