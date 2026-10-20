import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadQuiz, element, nodes, button } from './quizHarness.mjs';

let InboxView, InboxStore, makeHighlight, makeCard, DEFAULT_SETTINGS;
before(async () => {
  ({ InboxView } = await loadQuiz('src/inboxView.ts', { Notice: class { hide() {} } }));
  ({ InboxStore } = await loadQuiz('src/store.ts', { normalizePath: path => path }));
  ({ makeHighlight, makeCard } = await loadQuiz('src/model.ts'));
  ({ DEFAULT_SETTINGS } = await loadQuiz('src/settings.ts'));
});
const rewritten = { kind: 'cloze', front: '', back: '', text: 'Dormancy delays {{c1::germination}}.' };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function until(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(predicate(), 'The rendered action must reach its learning barrier');
}
// Extend the shared DOM double only for the editor-presence query and visibility.
// Render, header, card actions, editor construction and redraws remain production code.
function dom() {
  const extend = el => {
    const create = el.createEl;
    el.createEl = function (...args) { return extend(create.apply(this, args)); };
    el.show = el.hide = el.toggle = () => {};
    el.querySelector = selector => {
      const match = selector.match(/^\.wikilm-card\[data-id="([^"]+)"\] \.wikilm-editor$/);
      assert.ok(match, `Unexpected DOM query: ${selector}`);
      const card = nodes(el).find(n => n.hasClass('wikilm-card') && n.dataset.id === match[1]);
      return card ? nodes(card).find(n => n.hasClass('wikilm-editor')) ?? null : null;
    };
    return el;
  };
  return extend(element());
}
async function fixture(t) {
  const previousWindow = globalThis.window, frames = [];
  globalThis.window = { requestAnimationFrame: fn => frames.push(fn), setTimeout: () => 0, clearTimeout() {} };
  const draw = () => { while (frames.length) frames.shift()(); };
  const files = new Map();
  const app = { vault: { configDir: '.obsidian', getFiles: () => [], adapter: {
    exists: async path => files.has(path), mkdir: async () => {},
    read: async path => files.get(path), write: async (path, value) => files.set(path, value),
    remove: async path => files.delete(path),
    rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
  } }, workspace: {}, metadataCache: {} };
  const settings = { ...DEFAULT_SETTINGS, provider: 'deepseek', deepseekApiKey: 'synthetic-test-key', schemaLearning: true };
  const requests = [];
  const { LlmClient } = await loadQuiz('src/llm.ts', { requestUrl: async req => {
    requests.push(JSON.parse(req.body));
    return { status: 200, json: { choices: [{ message: { content: JSON.stringify(rewritten) }, finish_reason: 'stop' }] } };
  } });
  const llm = new LlmClient(() => settings, () => [], async () => ({ cards: '' }));
  const store = new InboxStore(app, 'synthetic-data');
  await store.load();
  const h = makeHighlight({ sourcePath: 'synthetic/Seeds.md', sourceTitle: 'Seeds', text: 'Dormancy delays germination.', status: 'ready' });
  const c = makeCard(h.id, { kind: 'qa', front: 'What does dormancy delay?', back: 'germination' });
  h.cards = [c]; store.add(h);
  const learning = deferred(), learningCalls = [];
  let proposals = 0;
  const host = { app, settings, store, llm, schema: {
    openCount: () => proposals,
    learn: day => { learningCalls.push(day); return learning.promise; },
  } };
  const root = dom(), view = new InboxView({ contentEl: root }, host);
  await view.onOpen();
  t.after(async () => {
    try { await view.onClose(); store.close(); }
    finally { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
  });
  const runs = [], rewrite = view.rewrite.bind(view);
  view.rewrite = (...args) => { const run = rewrite(...args); runs.push(run); return run; };
  const card = (id = c.id) => nodes(root).find(n => n.hasClass('wikilm-card') && n.dataset.id === id);
  const fields = (id = c.id) => {
    const form = nodes(card(id)).find(n => n.hasClass('wikilm-editor'));
    assert.ok(form, 'Look up the currently mounted editor, not detached fields');
    const [front, back, text, extra, instruction] = nodes(form).filter(n => n.tagName === 'TEXTAREA');
    return { form, front, back, text, extra, instruction };
  };
  const click = (title, id = c.id) => {
    const target = nodes(card(id)).find(n => n.tagName === 'BUTTON' && n.title === title);
    assert.ok(target, `The production card must render ${title}`);
    target.events.click({ stopPropagation() {} });
  };
  const settle = async (n = 1) => {
    proposals = n; learning.resolve(n);
    await Promise.all(runs);
    await new Promise(resolve => setImmediate(resolve));
    draw();
  };
  return { root, view, store, settings, files, h, c, requests, learning, learningCalls, runs, card, fields, click, draw, settle };
}

test('late learning after rendered Convert preserves the current draft and refreshes proposals after Cancel', async t => {
  const f = await fixture(t);
  f.click('Edit (e)');
  const oldForm = f.fields().form;
  f.click('Convert to cloze');
  await until(() => f.learningCalls.length === 1);
  assert.equal(f.requests.length, 1);
  assert.equal(f.c.text, rewritten.text, 'The authorized rewrite must already have succeeded');
  assert.notEqual(f.fields().form, oldForm, 'The authorized replacement must actually redraw its editor');
  const e = f.fields(), editor = f.view.editorDraft;
  e.front.value = 'My newer unsaved question';
  e.text.value = 'My newer {{c1::draft}}';
  e.extra.value = 'My newer annotation';
  e.instruction.value = 'My newer instruction';
  const saved = structuredClone(f.c), history = structuredClone(f.store.revisions());
  await f.settle();
  const current = f.fields();
  assert.equal(current.front.value, 'My newer unsaved question');
  assert.equal(current.text.value, 'My newer {{c1::draft}}');
  assert.equal(current.extra.value, 'My newer annotation');
  assert.equal(current.instruction.value, 'My newer instruction');
  assert.equal(current.form, e.form, 'Learning must not replace the mounted editor');
  assert.equal(f.view.editorDraft, editor);
  assert.equal(f.view.editing, f.c.id);
  assert.deepEqual(f.c, saved);
  assert.deepEqual(f.store.revisions(), history);
  assert.deepEqual(history.map(r => r.via), ['rewrite']);
  assert.equal(button(f.root, '1 card rule suggestion'), undefined, 'Proposal redraw waits for the editor to close');
  button(current.form, 'Cancel').events.click(); f.draw();
  assert.equal(f.view.editing, null);
  assert.ok(button(f.root, '1 card rule suggestion'));
  assert.deepEqual(f.c, saved, 'Cancel discards only the newer draft, not the accepted rewrite');
  await f.store.flush();
  const disk = JSON.parse(f.files.get('synthetic-data/inbox.json'));
  assert.equal(disk.highlights[0].cards[0].text, rewritten.text);
});

for (const target of ['same card', 'another card']) test(`manual Save learning preserves a newly opened editor on ${target}`, async t => {
  const f = await fixture(t);
  const other = makeCard(f.h.id, { kind: 'qa', front: 'What delays germination?', back: 'dormancy' });
  f.h.cards.push(other); f.store.touch(); f.draw();
  f.click('Edit (e)');
  f.fields().front.value = 'Which process does dormancy delay?';
  button(f.fields().form, 'Save').events.click();
  await until(() => f.learningCalls.length === 1);
  f.draw();
  assert.equal(f.view.editing, null, 'The original manual Save must close its editor');
  const id = target === 'same card' ? f.c.id : other.id;
  f.click('Edit (e)', id);
  const e = f.fields(id), editor = f.view.editorDraft;
  e.front.value = 'New question in the next editor';
  e.back.value = 'New answer';
  e.extra.value = 'New annotation';
  const saved = structuredClone(f.h.cards), history = structuredClone(f.store.revisions());
  await f.settle();
  assert.equal(f.view.editing, id);
  assert.equal(f.view.editorDraft, editor);
  assert.equal(f.fields(id).form, e.form);
  assert.equal(f.fields(id).front.value, 'New question in the next editor');
  assert.equal(f.fields(id).back.value, 'New answer');
  assert.equal(f.fields(id).extra.value, 'New annotation');
  assert.deepEqual(f.h.cards, saved);
  assert.deepEqual(f.store.revisions(), history);
  assert.deepEqual(history.map(r => r.via), ['edit']);
  assert.equal(f.requests.length, 0, 'Manual Save does not need a model rewrite');
  assert.equal(button(f.root, '1 card rule suggestion'), undefined);
  button(f.fields(id).form, 'Save').events.click(); await f.settle();
  assert.equal(f.view.editing, null);
  assert.ok(button(f.root, '1 card rule suggestion'), 'Save releases the deferred proposal redraw');
  assert.equal((id === f.c.id ? f.c : other).front, 'New question in the next editor');
  assert.deepEqual(f.store.revisions().map(r => r.via), ['edit', 'edit']);
});

test('learning from an accepted Convert preserves the editor after switching cards', async t => {
  const f = await fixture(t);
  const other = makeCard(f.h.id, { kind: 'qa', front: 'What delays germination?', back: 'dormancy' });
  f.h.cards.push(other); f.store.touch(); f.draw();
  f.click('Edit (e)'); f.click('Convert to cloze');
  await until(() => f.learningCalls.length === 1);
  f.click('Edit (e)', other.id);
  const e = f.fields(other.id), editor = f.view.editorDraft;
  e.front.value = 'New unsaved question on another card';
  const saved = structuredClone(f.h.cards), history = structuredClone(f.store.revisions());
  await f.settle();
  assert.equal(f.view.editing, other.id);
  assert.equal(f.view.editorDraft, editor);
  assert.equal(f.fields(other.id).form, e.form);
  assert.equal(f.fields(other.id).front.value, 'New unsaved question on another card');
  assert.deepEqual(f.h.cards, saved);
  assert.deepEqual(f.store.revisions(), history);
  assert.equal(f.c.text, rewritten.text);
});

test('learning completion after view closure leaves the accepted rewrite and mounted fields alone', async t => {
  const f = await fixture(t);
  f.click('Edit (e)'); f.click('Convert to cloze');
  await until(() => f.learningCalls.length === 1);
  f.fields().extra.value = 'New draft before closing';
  const e = f.fields(), saved = structuredClone(f.c), history = structuredClone(f.store.revisions());
  await f.view.onClose();
  await f.settle();
  assert.equal(f.fields().form, e.form);
  assert.equal(f.fields().extra.value, 'New draft before closing');
  assert.deepEqual(f.c, saved);
  assert.deepEqual(f.store.revisions(), history);
  assert.equal(button(f.root, '1 card rule suggestion'), undefined);
});

for (const outcome of ['no suggestions', 'rejection']) test(`optional learning ${outcome} preserves the successful rewrite and newer draft`, async t => {
  const errors = t.mock.method(console, 'error', () => {});
  const f = await fixture(t);
  f.click('Edit (e)'); f.click('Convert to cloze');
  await until(() => f.learningCalls.length === 1);
  const e = f.fields();
  e.text.value = 'New {{c1::unsaved}} wording';
  const saved = structuredClone(f.c), history = structuredClone(f.store.revisions());
  if (outcome === 'rejection') f.learning.reject(Error('Synthetic learning failure'));
  await f.settle(0);
  assert.equal(f.fields().form, e.form);
  assert.equal(f.fields().text.value, 'New {{c1::unsaved}} wording');
  assert.deepEqual(f.c, saved);
  assert.equal(f.c.text, rewritten.text);
  assert.deepEqual(f.store.revisions(), history);
  assert.deepEqual(history.map(r => r.via), ['rewrite']);
  assert.equal(button(f.root, '1 card rule suggestion'), undefined);
  assert.equal(errors.mock.callCount(), outcome === 'rejection' ? 1 : 0);
});

test('learning updates the proposal header when no editor is open', async t => {
  const f = await fixture(t);
  f.click('Convert to cloze');
  await until(() => f.learningCalls.length === 1);
  await f.settle(2);
  assert.equal(f.view.editing, null);
  assert.equal(f.c.text, rewritten.text);
  assert.deepEqual(f.store.revisions().map(r => r.via), ['rewrite']);
  assert.ok(button(f.root, '2 card rule suggestions'));
});

test('a new editor opened before the scheduled learning frame also keeps its draft', async t => {
  const f = await fixture(t);
  f.click('Convert to cloze');
  await until(() => f.learningCalls.length === 1);
  f.draw();
  f.learning.resolve(1);
  await Promise.all(f.runs);
  f.click('Edit (e)');
  const e = f.fields(); e.extra.value = 'Typed before the queued frame';
  f.draw();
  assert.equal(f.fields().form, e.form);
  assert.equal(f.fields().extra.value, 'Typed before the queued frame');
  assert.equal(f.c.text, rewritten.text);
});
