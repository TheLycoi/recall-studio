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
async function fixture(t, { rewriteOutput = rewritten } = {}) {
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
    const body = JSON.parse(req.body), payload = JSON.parse(body.messages[1].content);
    requests.push(body);
    const output = payload.task.startsWith('Independently check every replacement')
      ? { preservesFacts: true, followsInstruction: true, reason: '', verdicts: [{ index: 0, verdict: 'keep', reason: '' }] }
      : typeof rewriteOutput === 'function' ? rewriteOutput() : rewriteOutput;
    const result = payload.task.startsWith('Rewrite the requested card') ? { cards: [output] } : output;
    return { status: 200, json: { choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] } };
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
  return { root, view, host, store, settings, files, h, c, requests, learning, learningCalls, runs, card, fields, click, draw, settle };
}

test('Convert keeps revision history and newer unsaved text without learning from legacy true settings', async t => {
  const f = await fixture(t);
  f.click('Edit (e)');
  const oldForm = f.fields().form;
  f.click('Convert to cloze');
  await Promise.all(f.runs); f.draw();
  assert.equal(f.c.text, rewritten.text);
  assert.notEqual(f.fields().form, oldForm);
  assert.deepEqual(f.learningCalls, [], 'Saved schemaLearning true must not call the retired learner');
  const e = f.fields(), editor = f.view.editorDraft;
  e.text.value = 'My newer {{c1::draft}}'; e.extra.value = 'My newer annotation';
  e.instruction.value = 'My newer instruction';
  const saved = structuredClone(f.c), history = structuredClone(f.store.revisions());
  f.store.touch(); await f.settle();
  assert.equal(f.fields().form, e.form); assert.equal(f.view.editorDraft, editor);
  assert.equal(f.fields().text.value, 'My newer {{c1::draft}}');
  assert.equal(f.fields().extra.value, 'My newer annotation');
  assert.equal(f.fields().instruction.value, 'My newer instruction');
  assert.deepEqual(f.c, saved); assert.deepEqual(f.store.revisions(), history);
  assert.deepEqual(history.map(r => r.via), ['rewrite']);
  assert.equal(button(f.root, '1 card rule suggestion'), undefined);
  button(e.form, 'Cancel').events.click(); f.draw();
  assert.deepEqual(f.c, saved, 'Cancel discards only unsaved text');
  await f.store.flush();
  assert.equal(JSON.parse(f.files.get('synthetic-data/inbox.json')).highlights[0].cards[0].text, rewritten.text);
});

for (const target of ['same card', 'another card']) test(`manual Save preserves a newer editor on ${target} without learning`, async t => {
  const f = await fixture(t);
  const other = makeCard(f.h.id, { kind: 'qa', front: 'What delays germination?', back: 'dormancy' });
  f.h.cards.push(other); f.store.touch(); f.draw();
  f.click('Edit (e)'); f.fields().front.value = 'Which process does dormancy delay?';
  button(f.fields().form, 'Save').events.click(); f.draw();
  assert.equal(f.view.editing, null);
  const id = target === 'same card' ? f.c.id : other.id;
  f.click('Edit (e)', id);
  const e = f.fields(id), editor = f.view.editorDraft;
  e.front.value = 'New question'; e.back.value = 'New answer'; e.extra.value = 'New annotation';
  const saved = structuredClone(f.h.cards), history = structuredClone(f.store.revisions());
  f.store.touch(); await f.settle();
  assert.equal(f.view.editing, id); assert.equal(f.view.editorDraft, editor);
  assert.equal(f.fields(id).form, e.form); assert.equal(f.fields(id).front.value, 'New question');
  assert.equal(f.fields(id).back.value, 'New answer'); assert.equal(f.fields(id).extra.value, 'New annotation');
  assert.deepEqual(f.h.cards, saved); assert.deepEqual(f.store.revisions(), history);
  assert.deepEqual(history.map(r => r.via), ['edit']); assert.deepEqual(f.learningCalls, []);
  assert.equal(f.requests.length, 0);
  button(e.form, 'Save').events.click(); await f.settle();
  assert.deepEqual(f.store.revisions().map(r => r.via), ['edit', 'edit']);
});

test('two mounted panes preserve a conflicting manual draft and the newer durable correction', async t => {
  const f = await fixture(t);
  f.click('Edit (e)');
  const old = f.fields(); old.front.value = 'Older unsaved draft';
  const otherRoot = dom(), other = new InboxView({ contentEl: otherRoot }, f.host);
  await other.onOpen();
  t.after(() => other.onClose());
  nodes(otherRoot).find(n => n.title === 'Edit (e)').events.click({ stopPropagation() {} });
  const otherForm = nodes(otherRoot).find(n => n.hasClass('wikilm-editor'));
  nodes(otherForm).find(n => n.tagName === 'TEXTAREA').value = 'Which process does dormancy delay?';
  button(otherForm, 'Save').events.click();
  assert.equal(f.c.front, 'Which process does dormancy delay?');
  assert.equal(f.fields().form, old.form);
  button(old.form, 'Save').events.click();
  assert.equal(f.c.front, 'Which process does dormancy delay?');
  assert.equal(f.fields().front.value, 'Older unsaved draft');
  assert.equal(f.fields().form, old.form);
  assert.equal(f.store.revisions().length, 1);
  assert.equal(f.learningCalls.length, 0);
  await f.settle(); await f.store.flush();
  const disk = JSON.parse(f.files.get('synthetic-data/inbox.json'));
  assert.equal(disk.highlights[0].cards[0].front, 'Which process does dormancy delay?');
  assert.equal(disk.revisions.length, 1);
});

for (const outcome of ['failed', 'unchanged', 'changed']) test(`optional ${outcome} rewrite keeps its saved edit and newer mounted inputs without learning`, async t => {
  const unchanged = { kind: 'qa', front: 'Which process does dormancy delay?', back: 'germination', text: '' };
  const f = await fixture(t, { rewriteOutput: outcome === 'failed' ? () => { throw Error('Synthetic rewrite offline'); } : outcome === 'unchanged' ? unchanged : rewritten });
  f.click('Edit (e)');
  const original = f.fields();
  original.front.value = unchanged.front;
  original.instruction.value = 'Keep the subject clear';
  button(original.form, 'Save').events.click();
  await Promise.all(f.runs);
  f.draw();
  if (!f.view.editing) f.click('Edit (e)');
  const e = f.fields(), identity = f.view.editorDraft;
  e.front.value = 'My newer question'; e.extra.value = 'My newer annotation';
  e.instruction.value = 'My newer request';
  const saved = structuredClone(f.c), revisions = structuredClone(f.store.revisions());
  await f.settle();
  assert.equal(f.fields().form, e.form);
  assert.equal(f.view.editorDraft, identity);
  assert.equal(f.fields().front.value, 'My newer question');
  assert.equal(f.fields().extra.value, 'My newer annotation');
  assert.equal(f.fields().instruction.value, 'My newer request');
  assert.equal(f.learningCalls.length, 0);
  assert.deepEqual(f.store.revisions(), revisions);
  assert.deepEqual(revisions.map(r => r.via), outcome === 'changed' ? ['edit', 'rewrite'] : ['edit']);
  assert.deepEqual(f.c, saved);
  await f.store.flush();
  assert.deepEqual(JSON.parse(f.files.get('synthetic-data/inbox.json')).highlights[0].cards[0], saved);
});
