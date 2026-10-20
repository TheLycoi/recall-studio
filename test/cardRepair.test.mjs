import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';

let actions;
before(async () => {
  const out = await build({ entryPoints: ['src/cardActions.ts'], bundle: true, write: false, format: 'cjs', platform: 'node' });
  const mod = new Module('repair');
  mod._compile(out.outputFiles[0].text, 'repair');
  actions = mod.exports;
});
function fixture() {
  const card = { id: 'c1', highlightId: 'h1', kind: 'qa', front: 'What does the guide describe?', back: 'Dormancy', text: '', extra: 'Keep my annotation.', status: 'pending', edited: false };
  const highlight = { id: 'h1', status: 'ready', text: 'The guide describes seed dormancy as delayed germination.', before: '', after: '', sourcePath: 'seeds.md', sourceTitle: 'Seeds', heading: 'Dormancy', instruction: '', cards: [card] };
  return { card, highlight };
}
const revised = { kind: 'qa', front: 'What does seed dormancy delay?', back: 'Germination', text: '' };
function knownIssue(card, highlight) {
  card.userCheck = { content: actions.cardContent(card, highlight), at: '2026-10-20T19:00:00.000Z', issues: ['Test the distinct process.'] };
}

test('source metadata, siblings and status changes invalidate an in-flight repair', async () => {
  for (const change of [
    (c, h) => { h.instruction = 'Keep the original phrasing.'; },
    (c, h) => { h.heading = 'Another section'; },
    (c, h) => { h.cards.push({ ...c, id: 'sibling', front: 'Where are seeds stored?', back: 'The seed bank', userCheck: undefined }); },
    (c) => { c.status = 'approved'; },
  ]) {
    const { card, highlight } = fixture();
    knownIssue(card, highlight);
    const original = card.front;
    let finish;
    const run = actions.checkAndRepairCard(card, highlight, keep, () => new Promise(resolve => { finish = resolve; }));
    change(card, highlight);
    finish(revised);
    assert.equal((await run).status, 'cancelled');
    assert.equal(card.front, original);
  }
});

test('two clicks share a busy guard rather than spending two rewrite requests', async () => {
  const { card, highlight } = fixture();
  knownIssue(card, highlight);
  const pending = [];
  const rewrite = () => new Promise(resolve => pending.push(resolve));
  const first = actions.checkAndRepairCard(card, highlight, keep, rewrite);
  const second = actions.checkAndRepairCard(card, highlight, keep, rewrite);
  pending.forEach(resolve => resolve(revised));
  const results = await Promise.all([first, second]);
  assert.equal(pending.length, 1);
  assert.equal(results[1].status, 'busy');
});

test('conflicting final verdicts cannot authorize a replacement', async () => {
  const { card, highlight } = fixture();
  knownIssue(card, highlight);
  const original = card.front;
  await assert.rejects(actions.checkAndRepairCard(card, highlight,
    async () => [{ verdict: 'keep' }, { verdict: 'revise', reason: 'Wrong direction.' }],
    async () => revised));
  assert.equal(card.front, original);
});

test('removing a duplicate deletion retains the distinct fact as a one-answer Q&A', async () => {
  const { card, highlight } = fixture();
  highlight.text = 'Seeds enter dormancy and delay germination.';
  Object.assign(card, { kind: 'cloze', front: '', back: '', text: 'Seeds enter {{c1::dormancy}} and delay {{c2::germination}}.' });
  knownIssue(card, highlight);
  card.userCheck.issues = ['The dormancy deletion duplicates another card. Retain only delayed germination.'];
  const result = await actions.checkAndRepairCard(card, highlight, keep, async (_h, _c, instruction) => {
    assert.match(instruction, /duplicates another card/);
    return { kind: 'cloze', front: '', back: '', text: 'Seed dormancy delays {{c1::germination}}.' };
  });
  assert.equal(result.status, 'repaired');
  assert.equal(card.kind, 'qa');
  assert.equal(card.back, 'germination');
  assert.equal(card.text, '');
});

const keep = async () => [{ verdict: 'keep', reason: '' }];

test('a clean card is checked without rewriting or resetting its state', async () => {
  const { card, highlight } = fixture();
  card.status = 'approved';
  const before = { ...card };
  const result = await actions.checkAndRepairCard(card, highlight, keep, async () => assert.fail('No repair needed'));
  assert.equal(result.status, 'checked');
  for (const [key, value] of Object.entries(before)) assert.deepEqual(card[key], value);
  assert.deepEqual(actions.currentCardCheck(card, highlight).issues, []);
});

test('known findings go directly to repair; a failed attempt stays retryable', async () => {
  const { card, highlight } = fixture();
  knownIssue(card, highlight);
  const before = structuredClone(card);
  await assert.rejects(actions.checkAndRepairCard(card, highlight,
    async () => assert.fail('Do not repeat the check of known findings'),
    async () => { throw new Error('offline'); }), /offline/);
  assert.deepEqual(card, before);
  assert.equal((await actions.checkAndRepairCard(card, highlight, keep, async () => revised)).status, 'repaired');
});

test('invalid, unchanged and unsupported replacements preserve the original', async () => {
  for (const response of [
    null, {}, { kind: 'unknown' },
    { kind: 'qa', front: '', back: 'Germination', text: '' },
    { kind: 'cloze', front: '', back: '', text: 'Malformed {{c1::germination' },
    { kind: 'cloze', front: '', back: '', text: 'Dormancy delays {{c1::invented answer}}.' },
    { kind: 'qa', front: 'What does the guide describe?', back: 'Dormancy', text: '' },
  ]) {
    const { card, highlight } = fixture();
    knownIssue(card, highlight);
    const before = structuredClone(card);
    await assert.rejects(actions.checkAndRepairCard(card, highlight, keep, async () => response));
    assert.deepEqual(card, before);
  }
});

test('remaining issues, rejection or failed recheck never replace the old card', async () => {
  for (const critique of [
    async () => [{ verdict: 'revise', reason: 'The claim is unsupported.' }],
    async () => [{ verdict: 'drop', reason: 'It still duplicates another card.' }],
    async () => [],
    async () => { throw new Error('offline'); },
  ]) {
    const { card, highlight } = fixture();
    knownIssue(card, highlight);
    const before = structuredClone(card);
    await assert.rejects(actions.checkAndRepairCard(card, highlight, critique, async () => revised));
    assert.deepEqual(card, before);
  }
});

test('edits, cancellation, deletion, export and archive during final checking discard the repair', async () => {
  for (const change of [
    (c, h) => { c.front = 'My newer wording'; },
    (c, h) => { h.text = 'Changed source'; },
    (c, h) => { h.sourcePath = 'renamed.md'; },
    (c, h) => { c.status = 'deleted'; },
    (c, h) => { c.status = 'exported'; },
    (c, h) => { h.archived = true; },
    (c, h) => { h.status = 'dismissed'; },
    null,
  ]) {
    const { card, highlight } = fixture();
    knownIssue(card, highlight);
    let active = true;
    const result = await actions.checkAndRepairCard(card, highlight, async () => {
      if (change) change(card, highlight); else active = false;
      return [{ verdict: 'keep' }];
    }, async () => revised, () => active);
    assert.equal(result.status, 'cancelled');
    assert.notEqual(card.front, revised.front);
  }
});

test('retired cards and an inactive view make no provider request', async () => {
  for (const status of ['exported', 'duplicate', 'deleted']) {
    const { card, highlight } = fixture();
    card.status = status;
    const fail = async () => assert.fail('No request permitted');
    assert.equal((await actions.checkAndRepairCard(card, highlight, fail, fail)).status, 'cancelled');
  }
  const { card, highlight } = fixture();
  const fail = async () => assert.fail('No request permitted');
  assert.equal((await actions.checkAndRepairCard(card, highlight, fail, fail, () => false)).status, 'cancelled');
});

test('repair returns approved cards to draft and retains identity, receipts and historical evidence', async () => {
  const { card, highlight } = fixture();
  Object.assign(card, { status: 'approved', ankiNoteId: 123, srNote: 'export.md', lintFailures: ['qa-empty'], critiqueReason: 'Old issue', critiqueRan: true,
    generation: { batchId: 'batch', planId: 'P1', factIds: ['F1'], audit: { status: 'verified', reason: 'Old audit', content: JSON.stringify([card.kind, card.front, card.back, card.text]) } } });
  knownIssue(card, highlight);
  const provenance = structuredClone(card.generation);
  await actions.checkAndRepairCard(card, highlight, keep, async () => revised);
  assert.equal(card.status, 'pending');
  assert.equal(card.id, 'c1');
  assert.equal(card.highlightId, 'h1');
  assert.equal(card.ankiNoteId, 123);
  assert.equal(card.srNote, 'export.md');
  assert.deepEqual(card.generation, provenance);
  assert.notEqual(card.generation.audit.content, JSON.stringify([card.kind, card.front, card.back, card.text]));
  assert.equal(card.critiqueReason, undefined);
  assert.equal(card.lintFailures, undefined);
});

test('checking a flawed card rewrites it using the findings and checks the replacement', async () => {
  const { card, highlight } = fixture();
  const seen = [];
  const result = await actions.checkAndRepairCard(card, highlight, async (_h, cards) => {
    seen.push(cards[0].front);
    return [{ verdict: seen.length === 1 ? 'revise' : 'keep', reason: seen.length === 1 ? 'Ask about the specific seed process, not the guide.' : '' }];
  }, async (h, c, instruction) => {
    assert.equal(h.text, highlight.text);
    assert.equal(c.id, card.id);
    assert.match(instruction, /specific seed process/);
    assert.match(instruction, /best practices/i);
    return revised;
  });
  assert.equal(result.status, 'repaired');
  assert.equal(card.front, revised.front);
  assert.equal(card.back, revised.back);
  assert.equal(card.extra, 'Keep my annotation.');
  assert.equal(card.id, 'c1');
  assert.equal(card.edited, true);
  assert.equal(card.status, 'pending');
  assert.deepEqual(seen, ['What does the guide describe?', revised.front]);
  assert.deepEqual(actions.currentCardCheck(card, highlight).issues, []);
});
