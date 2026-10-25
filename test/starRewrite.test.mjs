import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadQuiz, element, nodes } from './quizHarness.mjs';

let InboxView, LlmClient, makeHighlight, makeCard, modal;
const revised = { kind: 'qa', front: 'What does dormancy delay?', back: 'germination', text: '' };
const verdict = { verdicts: [{ index: 0, verdict: 'revise', reason: 'Name the subject.', bloom: 'remember', kind: 'qa', front: '', back: '', text: '' }] };
const response = value => ({ status: 200, json: { choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] } });

before(async () => {
  const Modal = class {
    constructor() { this.contentEl = element(); }
    open() { modal = this; }
    close() { this.onClose(); }
  };
  ({ InboxView } = await loadQuiz('src/inboxView.ts', { Notice: class { hide() {} }, Modal }));
  ({ LlmClient } = await loadQuiz('src/llm.ts'));
  ({ makeHighlight, makeCard } = await loadQuiz('src/model.ts'));
});

async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setImmediate(r)); }
  assert.fail('Pending operation did not settle');
}

function fixture({ output = revised } = {}) {
  modal = undefined;
  const settings = { provider: 'codex', codexPath: '/synthetic/codex', codexModel: 'synthetic-model', effort: 'low', language: '', writerInstructions: '', historyExamples: false, schemaFolder: 'rules', lintMode: 'badge', schemaLearning: false };
  const h = makeHighlight({ sourcePath: 'sources/seeds.md', sourceTitle: 'Seeds', text: 'Dormancy delays germination.', status: 'ready' });
  const c = makeCard(h.id, { kind: 'qa', front: 'What does it delay?', back: 'germination' });
  h.cards = [c];
  const requests = [], revisions = [];
  const llm = new LlmClient(() => settings, () => [], async () => ({ cards: '' }));
  llm.codex = { complete: async req => {
    requests.push(req);
    if (req.label === 'rewrite cards') return req.schema.parse({ cards: [typeof output === 'function' ? output() : output] });
    if (req.label === 'rewrite audit') return req.schema.parse({ preservesFacts: true, reason: '', verdicts: [{ index: 0, verdict: 'keep', reason: '' }] });
    if (req.label === 'verdicts') return req.schema.parse(verdict);
    throw Error(`Unexpected provider request: ${req.label}`);
  } };
  const root = element();
  const host = { app: { vault: { getFiles: () => [], configDir: '.obsidian' }, workspace: {}, metadataCache: {} }, settings, llm,
    store: { all: () => [h], onChange: () => () => {}, touch() {}, recordRevision: r => revisions.push(r) } };
  const view = new InboxView({ contentEl: root }, host);
  view.renderCard(root, h, c);
  const star = () => nodes(root).find(n => n.tagName === 'BUTTON' && /rewrite/i.test(n.title ?? ''));
  return { h, c, root, view, llm, requests, revisions, star };
}

test('the card star asks for the change instead of running a best-practices check', async () => {
  const f = fixture();
  const star = f.star();
  assert.ok(star, 'The card must expose its rewrite star');
  assert.match(star.title, /rewrite/i);
  assert.doesNotMatch(star.title, /check .*best practices/i);
  assert.match(star['aria-label'] ?? star.title, /rewrite/i);
  assert.equal(f.c.front, 'What does it delay?');
});

test('submitting the star instruction rewrites the card and records a rewrite revision', async () => {
  const f = fixture();
  f.star().events.click({ stopPropagation() {} });
  await until(() => modal);
  assert.deepEqual(f.requests, [], 'No provider call before the reader states the change');
  assert.equal(modal.title, 'Rewrite card');
  modal.value = 'ask about the process, not "it"';
  modal.submit();
  await until(() => f.view.checking.size === 0);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests.map(r => r.label), ['rewrite cards', 'rewrite audit']);
  assert.equal(f.c.front, 'What does dormancy delay?');
  assert.equal(f.revisions.length, 1);
  assert.equal(f.revisions[0].via, 'rewrite');
  assert.equal(f.revisions[0].instruction, 'ask about the process, not "it"');
});

test('cancelling the star prompt sends nothing and leaves the card unchanged', async () => {
  const f = fixture();
  const before = structuredClone(f.c);
  f.star().events.click({ stopPropagation() {} });
  await until(() => modal);
  modal.value = '';
  modal.submit();
  await until(() => f.view.checking.size === 0);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.c, before);
  assert.deepEqual(f.revisions, []);
});

test('a failed star rewrite keeps the original card and its history', async () => {
  const f = fixture({ output: () => { throw Error('Synthetic offline'); } });
  const before = structuredClone(f.c);
  f.star().events.click({ stopPropagation() {} });
  await until(() => modal);
  modal.value = 'shorten the answer';
  modal.submit();
  await until(() => f.view.checking.size === 0);
  assert.deepEqual(f.c, before);
  assert.deepEqual(f.revisions, []);
});
