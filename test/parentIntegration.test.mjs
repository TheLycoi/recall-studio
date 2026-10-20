import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadQuiz, element, nodes } from './quizHarness.mjs';
let LlmClient, InboxView, model;
before(async () => {
  ({ LlmClient } = await loadQuiz('src/llm.ts'));
  ({ InboxView } = await loadQuiz('src/inboxView.ts', { Notice: class { hide() {} } }));
  model = await loadQuiz('src/model.ts');
});
const keep = { index: 0, verdict: 'keep', reason: '', bloom: 'remember', kind: 'qa', front: '', back: '', text: '' };
function fixture() {
  const h = model.makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Synthetic', text: 'Dormancy delays germination.', status: 'ready' });
  const c = model.makeCard(h.id, { kind: 'qa', front: 'What does it delay?', back: 'germination' });
  h.cards = [c];
  const root = element(), revisions = [], calls = [];
  const settings = { lintMode: 'badge', schemaLearning: false };
  const host = { app: {}, settings, store: { all: () => [h], findCard: id => h.cards.includes(c) && id === c.id ? { highlight: h, card: c } : undefined, touch() {}, recordRevision: r => revisions.push(r) }, llm: {
    critiqueCards: async (_h, cards) => { calls.push('check'); return [{ ...keep, verdict: cards[0].front.includes('it delay') ? 'revise' : 'keep', reason: 'Name the subject.' }]; },
    rewriteCard: async () => { calls.push('rewrite'); return { kind: 'qa', front: 'What does dormancy delay?', back: 'germination', text: '' }; },
  } };
  const view = new InboxView({ contentEl: root }, host);
  return { h, c, root, host, view, calls, revisions };
}
async function click(f, batch = false) {
  f.view[batch ? 'renderHighlight' : 'renderCard'](f.root, f.h, f.c);
  const b = nodes(f.root).find(n => /Check (?:card|cards) against best practices/.test(n.title ?? ''));
  assert.ok(b);
  b.events.click({ stopPropagation() {} });
  for (let n = 0; n < 30 && f.view.checking.size; n++) await new Promise(r => setImmediate(r));
  assert.equal(f.view.checking.size, 0);
}
for (const batch of [false, true]) test(`real ${batch ? 'passage' : 'card'} star repairs and records an accepted revision`, async () => {
  const f = fixture(); await click(f, batch);
  assert.equal(f.c.front, 'What does dormancy delay?');
  assert.deepEqual(f.calls, ['check', 'rewrite', 'check']);
  assert.equal(f.revisions.length, 1);
  assert.equal(f.revisions[0].via, 'repair');
  assert.equal(f.revisions[0].before.front, 'What does it delay?');
  assert.equal(f.revisions[0].after.front, f.c.front);
  assert.equal(f.c.status, 'pending');
  assert.deepEqual(f.c.userCheck.issues, []);
});
for (const change of ['editor', 'settings', 'membership', 'unload']) test(`pending repair preserves original after ${change} changes`, async () => {
  const f = fixture();
  f.host.llm.rewriteCard = async () => {
    if (change === 'editor') f.view.editing = f.c.id;
    if (change === 'settings') f.host.settings.writerInstructions = 'New preference';
    if (change === 'membership') f.h.cards = [];
    if (change === 'unload') f.view.closed = true;
    return { kind: 'qa', front: 'What does dormancy delay?', back: 'germination', text: '' };
  };
  await f.view.checkAgainstPractices(f.h, f.c);
  assert.equal(f.c.front, 'What does it delay?'); assert.equal(f.revisions.length, 0);
});
test('an open unsaved editor prevents a competing star repair', async () => {
  const f = fixture(); f.view.editing = f.c.id;
  await f.view.checkAgainstPractices(f.h, f.c);
  assert.deepEqual(f.calls, []); assert.equal(f.c.front, 'What does it delay?');
});
test('valid clozes suppress obsolete saved count-only warnings without mutating records', () => {
  const f = fixture(); Object.assign(f.c, { kind: 'cloze', text: '{{c1::Dormancy}} delays germination.', front: '', back: '', lintFailures: ['cloze-count'] });
  f.view.renderCard(f.root, f.h, f.c);
  assert.equal(nodes(f.root).some(n => n.title === 'Lint check failed: cloze-count'), false);
  assert.deepEqual(f.c.lintFailures, ['cloze-count']);
});
test('legacy card quota is neither sent to the writer nor exposed as a setting', async () => {
  const client = new LlmClient(() => ({ provider: 'codex', maxCardsPerHighlight: 1, language: '', writerInstructions: '' }));
  const calls = [];
  client.codex = { complete: async req => { calls.push(req); return { cards: [] }; } };
  const context = await client.generationContext();
  assert.equal(Object.hasOwn(context, 'maxCards'), false);
  const h = fixture().h;
  await client.writeCards(h);
  await client.prepareGeneration(h, [], { ...context, maxCards: 1 });
  await client.writeGroundedCards(h, [], { facts: [], plan: [], exclusions: [], omissions: [], conflicts: [] }, { ...context, maxCards: 1 });
  await client.critiqueCards(h, h.cards).catch(() => {});
  for (const req of calls) {
    assert.doesNotMatch(req.user, /Write at most|maxCards/);
    assert.doesNotMatch(req.system, /at least two deletion|at most three|At most three|two or three short/i);
  }
  assert.doesNotMatch(readFileSync('src/settings.ts', 'utf8'), /setName\("Max cards per highlight"\)/);
});
