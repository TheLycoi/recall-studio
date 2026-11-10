import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadQuiz, element, nodes } from './quizHarness.mjs';

let InboxView, makeHighlight, makeCard;
before(async () => {
  ({ InboxView } = await loadQuiz('src/inboxView.ts', { Notice: class { hide() {} } }));
  ({ makeHighlight, makeCard } = await loadQuiz('src/model.ts'));
});
const converted = { kind: 'cloze', front: '', back: '', text: 'Dormancy delays {{c1::germination}}.' };
const response = value => ({ status: 200, json: { choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(predicate(), 'Expected the pending operation to reach its barrier');
}
async function fixture({ pause = 'before-dispatch', output = converted } = {}) {
  const settings = { provider: 'deepseek', deepseekApiKey: 'synth...ey', deepseekModel: 'synthetic-model', effort: 'low', writerInstructions: '', language: '', historyExamples: false, schemaFolder: 'rules', schemaLearning: false };
  const h = makeHighlight({ sourcePath: 'seeds.md', sourceTitle: 'Seeds', text: 'Dormancy delays germination.', status: 'ready' });
  const c = makeCard(h.id, { kind: 'qa', front: 'What does dormancy delay?', back: 'germination' });
  h.cards = [c];
  const barrier = deferred(), requests = [], revisions = [], highlights = [h];
  let pending = false;
  const { LlmClient } = await loadQuiz('src/llm.ts', { requestUrl: async req => {
    const body = JSON.parse(req.body), payload = JSON.parse(body.messages[1].content);
    requests.push(body);
    if (pause === 'transport') { pending = true; await barrier.promise; }
    if (payload.task.startsWith('Independently check every replacement')) return response({ preservesFacts: true, followsInstruction: true, reason: '',
      verdicts: payload.cards.map((_, index) => ({ index, verdict: 'keep', reason: '' })) });
    const result = typeof output === 'function' ? output(req) : response(output);
    if (payload.task.startsWith('Rewrite the requested card') && result?.json?.choices?.[0]?.message) {
      const message = result.json.choices[0].message;
      try { message.content = JSON.stringify({ cards: [JSON.parse(message.content)] }); } catch { /* Leave malformed JSON for the real parser. */ }
    }
    return result;
  } });
  const llm = new LlmClient(() => settings, () => [], async () => {
    assert.fail('Retired rule callbacks must never be read');
  });
  // Hold the real backend's entry before its production authorization checks.
  const post = llm.deepseek.post.bind(llm.deepseek);
  llm.deepseek.post = async (...args) => {
    if (pause === 'before-dispatch') { pending = true; await barrier.promise; }
    return post(...args);
  };
  const root = element();
  const host = { app: { vault: { getFiles: () => [], configDir: '.obsidian' }, workspace: {}, metadataCache: {} }, settings, llm,
    store: { all: () => highlights, onChange: () => () => {}, touch() {}, recordRevision: r => revisions.push(r) } };
  const view = new InboxView({ contentEl: root }, host);
  const runs = [], rewrite = view.rewrite.bind(view);
  view.rewrite = (...args) => { const run = rewrite(...args); runs.push(run); return run; };
  view.renderCard(root, h, c);
  const convert = nodes(root).find(n => n.title === 'Convert to cloze');
  assert.ok(convert, 'The production card must render its Convert button');
  return { settings, h, c, host, view, root, llm, requests, revisions, highlights, runs,
    click: () => convert.events.click({ stopPropagation() {} }), pending: () => pending, release: () => barrier.resolve() };
}

for (const invalidation of ['settings', 'view-close', 'newer-edit']) test(`rendered Convert cancels ${invalidation} before backend dispatch`, async () => {
  const f = await fixture();
  f.click();
  await until(f.pending);
  if (invalidation === 'settings') f.settings.schemaFolder = 'sources';
  else if (invalidation === 'view-close') await f.view.onClose();
  else f.c.front = 'My newer question';
  const expected = structuredClone(f.c);
  f.release();
  await Promise.all(f.runs);
  assert.deepEqual(f.requests, [], 'Revoked source must not reach transport');
  assert.deepEqual(f.c, expected, 'The current original must survive');
  assert.deepEqual(f.revisions, [], 'Cancelled work must not create a rewrite revision');
});

function openEditor(f) {
  const extend = el => {
    el.show = el.hide = el.toggle = () => {};
    const create = el.createEl;
    el.createEl = function (...args) { return extend(create.apply(this, args)); };
    return el;
  };
  const root = extend(element()), previousWindow = globalThis.window;
  globalThis.window = { setTimeout() {} };
  f.view.editing = f.c.id;
  try { f.view.renderEditor(root, f.h, f.c); }
  finally { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
  const fields = nodes(root).filter(n => n.tagName === 'TEXTAREA');
  return { root, front: fields[0], back: fields[1], text: fields[2], extra: fields[3], instruction: fields[4],
    save: () => nodes(root).find(n => n.text === 'Save').events.click() };
}

test('authorized Convert keeps identity and receipts and records one rewrite without a critique loop', async () => {
  const f = await fixture({ pause: null });
  Object.assign(f.c, { status: 'approved', ankiNoteId: 123, srNote: 'export.md', extra: 'My annotation.' });
  const before = structuredClone(f.c);
  f.click(); await Promise.all(f.runs);
  assert.equal(f.requests.length, 1);
  assert.equal(f.c.text, converted.text);
  assert.equal(f.c.status, 'pending');
  for (const key of ['id', 'highlightId', 'ankiNoteId', 'srNote', 'extra']) assert.equal(f.c[key], before[key]);
  assert.equal(f.revisions.length, 1);
  assert.equal(f.revisions[0].via, 'rewrite');
});

test('Save with instruction saves typed wording then rewrites it once', async () => {
  const f = await fixture({ pause: null });
  const e = openEditor(f);
  e.front.value = 'Which process does dormancy delay?';
  e.instruction.value = 'Convert to cloze';
  e.save(); await Promise.all(f.runs);
  assert.equal(f.requests.length, 2, 'Explicit Save writes, then independently audits the replacement');
  assert.match(f.requests[0].messages[1].content, /Which process does dormancy delay/);
  assert.equal(f.c.text, converted.text);
  assert.equal(f.view.editing, null);
  assert.deepEqual(f.revisions.map(r => r.via), ['edit', 'rewrite']);
  assert.equal(f.revisions[1].before.front, e.front.value);
});

for (const action of ['Convert', 'Save']) for (const pause of ['before-dispatch', 'transport']) {
  test(`${action} preserves unsaved fields typed during ${pause}`, async () => {
    const f = await fixture({ pause });
    const e = openEditor(f);
    f.view.render = () => assert.fail('Cancellation must not redraw away the editor');
    if (action === 'Save') { e.instruction.value = 'Convert to cloze'; e.save(); }
    else f.click();
    await until(f.pending);
    e.front.value = 'New unsaved question';
    e.extra.value = 'New unsaved annotation';
    const expected = structuredClone(f.c);
    f.release(); await Promise.all(f.runs);
    assert.equal(f.requests.length, pause === 'before-dispatch' ? 0 : 1);
    assert.deepEqual(f.c, expected);
    assert.equal(f.view.editing, f.c.id, 'The newer draft must remain open');
    assert.equal(e.front.value, 'New unsaved question');
    assert.equal(e.extra.value, 'New unsaved annotation');
    assert.deepEqual(f.revisions, []);
  });
}

test('Convert does not discard an already unsaved editor draft', async () => {
  const f = await fixture({ pause: null });
  const e = openEditor(f);
  e.front.value = 'Unsubmitted wording';
  f.view.render = () => assert.fail('Do not replace an unsaved draft');
  const expected = structuredClone(f.c);
  f.click(); await Promise.all(f.runs);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.c, expected);
  assert.equal(e.front.value, 'Unsubmitted wording');
});

for (const action of ['Convert', 'Save']) test(`rapid duplicate ${action} actions spend one rewrite and preserve pending drafts`, async () => {
  const f = await fixture();
  const e = action === 'Save' ? openEditor(f) : undefined;
  if (e) { e.instruction.value = 'Convert to cloze'; e.save(); }
  else f.click();
  await until(f.pending);
  if (e) { e.front.value = 'Newer draft, not submitted twice'; e.save(); }
  else f.click();
  f.release(); await Promise.all(f.runs);
  assert.equal(f.requests.length, e ? 0 : 1);
  assert.equal(f.revisions.length, e ? 0 : 1);
  if (e) {
    assert.equal(f.c.front, 'What does dormancy delay?');
    assert.equal(e.front.value, 'Newer draft, not submitted twice');
    assert.equal(f.view.editing, f.c.id);
  }
});

test('two views cannot run explicit rewrites on the same card concurrently', async () => {
  const f = await fixture();
  const root = element(), other = new InboxView({ contentEl: root }, f.host);
  other.renderCard(root, f.h, f.c);
  let run;
  const rewrite = other.rewrite.bind(other);
  other.rewrite = (...args) => (run = rewrite(...args));
  f.click(); await until(f.pending);
  nodes(root).find(n => n.title === 'Convert to cloze').events.click({ stopPropagation() {} });
  f.release(); await Promise.all([...f.runs, run]);
  assert.equal(f.requests.length, 1);
  assert.equal(f.revisions.length, 1);
});

for (const output of [
  { kind: 'qa', front: ' ', back: 'germination', text: '' },
  { kind: 'qa', front: 'What does dormancy delay?', back: '', text: '' },
  { kind: 'cloze', front: '', back: '', text: 'Dormancy delays germination.' },
  { kind: 'cloze', front: '', back: '', text: 'Dormancy delays {{c1::germination' },
  { kind: 'cloze', front: '', back: '', text: 'Dormancy delays {{c1::flowering}}.' },
]) test(`unusable rewrite ${JSON.stringify(output)} preserves the original and history`, async () => {
  const f = await fixture({ pause: null, output });
  f.c.userCheck = { content: 'old check', at: 'synthetic', issues: ['Keep the finding until a valid rewrite.'] };
  const expected = structuredClone(f.c);
  f.click(); await Promise.all(f.runs);
  assert.deepEqual(f.c, expected);
  assert.deepEqual(f.revisions, []);
});

test('plain manual Save still works on a capture that is not ready for model rewriting', async () => {
  const f = await fixture({ pause: null });
  f.h.status = 'error';
  const e = openEditor(f);
  e.front.value = 'A hand-written question';
  e.save(); await Promise.all(f.runs);
  assert.equal(f.c.front, e.front.value);
  assert.equal(f.requests.length, 0);
  assert.equal(f.view.editing, null);
  assert.deepEqual(f.revisions.map(r => r.via), ['edit']);
});

test('plain Save refuses stale wording without losing the mounted draft or learning it', async () => {
  const f = await fixture({ pause: null });
  let learning = 0;
  f.host.settings.schemaLearning = true;
  f.host.schema = { learn: async () => { learning++; return 0; } };
  const e = openEditor(f);
  e.front.value = 'Older unsaved wording';
  f.c.front = 'Newer saved wording from another pane';
  const expected = structuredClone(f.c);
  e.save(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.c, expected);
  assert.deepEqual(f.revisions, []);
  assert.equal(learning, 0);
  assert.equal(e.front.value, 'Older unsaved wording');
  assert.equal(f.view.editing, f.c.id);
  assert.ok(nodes(e.root).includes(e.front), 'Keep the same mounted input on conflict');
});

for (const outcome of ['failed', 'unchanged', 'changed']) test(`a saved manual correction survives an optional ${outcome} rewrite without learning`, async () => {
  const f = await fixture({ pause: null, output: outcome === 'failed'
    ? () => { throw Error('Synthetic failure'); }
    : outcome === 'unchanged'
      ? { kind: 'qa', front: 'Which process does dormancy delay?', back: 'germination', text: '' }
      : converted });
  let learning = 0;
  f.host.settings.schemaLearning = true;
  f.host.schema = { learn: async () => { learning++; return 0; } };
  const e = openEditor(f);
  e.front.value = 'Which process does dormancy delay?';
  e.instruction.value = 'Convert to cloze';
  e.save(); await Promise.all(f.runs);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(learning, 0);
  assert.equal(f.revisions[0].via, 'edit');
  assert.deepEqual(f.revisions.map(r => r.via), outcome === 'changed' ? ['edit', 'rewrite'] : ['edit']);
});

test('Save with instruction refuses a card changed since this editor was opened', async () => {
  const f = await fixture({ pause: null });
  const e = openEditor(f);
  e.front.value = 'My older unsaved draft';
  e.instruction.value = 'Convert to cloze';
  f.c.front = 'Newer saved wording from another view';
  const expected = structuredClone(f.c);
  e.save(); await Promise.all(f.runs);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.c, expected);
  assert.equal(e.front.value, 'My older unsaved draft');
  assert.equal(f.view.editing, f.c.id);
  assert.deepEqual(f.revisions, []);
});

test('Save cannot renew settings authorization after publishing its manual edit', async () => {
  const f = await fixture({ pause: null });
  const e = openEditor(f);
  e.front.value = 'Which process does dormancy delay?';
  e.instruction.value = 'Convert to cloze';
  f.host.store.touch = () => { f.settings.schemaFolder = 'sources'; };
  e.save(); await Promise.all(f.runs);
  assert.equal(f.requests.length, 0);
  assert.equal(f.c.front, e.front.value);
  assert.deepEqual(f.revisions.map(r => r.via), ['edit']);
  assert.equal(f.view.editing, f.c.id);
});

const invalidations = {
  settings: f => { f.settings.schemaFolder = 'sources'; },
  'view-close': f => f.view.onClose(),
  'view-reopen': async f => { await f.view.onClose(); f.view.render = () => {}; await f.view.onOpen(); },
  'client-abort': f => f.llm.abort(),
  'card-edit': f => { f.c.front = 'My newer wording'; },
  'card-extra': f => { f.c.extra = 'My newer annotation'; },
  'source-edit': f => { f.h.text = 'New captured passage.'; },
  'source-rename': f => { f.h.sourcePath = 'renamed.md'; },
  'source-context': f => { f.h.before = 'Changed context.'; },
  'source-instruction': f => { f.h.instruction = 'Changed instruction.'; },
  'sibling-edit': f => { f.h.cards.push(makeCard(f.h.id, { kind: 'qa', front: 'Which process delays germination?', back: 'dormancy' })); },
  archive: f => { f.h.archived = true; },
  delete: f => { f.c.status = 'deleted'; },
  export: f => { f.c.status = 'exported'; },
  dismiss: f => { f.h.status = 'dismissed'; },
  'card-remove': f => { f.h.cards = []; },
  'source-remove': f => { f.highlights.length = 0; },
};
for (const name of ['settings', 'view-close', 'client-abort', 'archive', 'delete', 'export', 'source-remove']) {
  test(`Save with instruction refuses ${name} before the click without discarding its draft`, async () => {
    const f = await fixture({ pause: null });
    const e = openEditor(f);
    e.front.value = 'Unsubmitted wording';
    e.instruction.value = 'Convert to cloze';
    await invalidations[name](f);
    const expected = structuredClone(f.c);
    e.save(); await Promise.all(f.runs);
    assert.deepEqual(f.c, expected);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.revisions, []);
    assert.equal(e.front.value, 'Unsubmitted wording');
    assert.equal(e.instruction.value, 'Convert to cloze');
  });
}

for (const action of ['Convert', 'Save']) for (const pause of ['before-dispatch', 'transport']) {
  for (const [name, revoke] of Object.entries(invalidations)) test(`${action} revokes ${name} at ${pause}`, async () => {
    const f = await fixture({ pause });
    const e = action === 'Save' ? openEditor(f) : undefined;
    if (e) {
      e.front.value = 'Which process does dormancy delay?';
      e.instruction.value = 'Convert to cloze';
      e.save();
    } else f.click();
    await until(f.pending);
    await revoke(f);
    const expected = structuredClone(f.c), history = structuredClone(f.revisions);
    f.release(); await Promise.all(f.runs);
    assert.equal(f.requests.length, pause === 'before-dispatch' ? 0 : 1, 'Revocation must prevent every later dispatch');
    assert.deepEqual(f.c, expected);
    assert.deepEqual(f.revisions, history, 'Already saved manual edits stay in history, never a stale rewrite');
    if (e) {
      assert.equal(e.front.value, 'Which process does dormancy delay?');
      assert.equal(e.instruction.value, 'Convert to cloze');
    }
  });
}

for (const name of ['settings', 'view-close', 'card-edit', 'client-abort']) {
  test(`instruction modal await cannot renew ${name} authorization`, async () => {
    const f = await fixture({ pause: null });
    let modal;
    const { InboxView: ModalView } = await loadQuiz('src/inboxView.ts', {
      Notice: class { hide() {} },
      Modal: class { constructor() { this.contentEl = element(); } open() { modal = this; } close() { this.onClose(); } },
    });
    f.view = new ModalView({ contentEl: element() }, f.host);
    const run = f.view.rewrite(f.h, f.c);
    assert.ok(modal, 'The existing instruction modal must be awaiting input');
    await invalidations[name](f);
    const expected = structuredClone(f.c);
    modal.value = 'Convert to cloze'; modal.submit();
    await run;
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.c, expected);
    assert.deepEqual(f.revisions, []);
  });
}

for (const output of [null, {}, { kind: 'unknown', front: '', back: '', text: '' }, { kind: 'qa', front: 42, back: 'answer', text: '' },
  { kind: 'cloze', front: '', back: '', text: 'Dormancy delays {{c1::   }}.' },
  () => { throw new Error('Synthetic provider failure'); },
]) for (const action of ['Convert', 'Save']) {
  test(`${action} preserves saved work, draft and history on invalid output ${JSON.stringify(output)}`, async () => {
    const f = await fixture({ pause: null, output });
    const e = action === 'Save' ? openEditor(f) : undefined;
    if (e) {
      e.front.value = 'Which process does dormancy delay?';
      e.instruction.value = 'Convert to cloze';
      e.save();
    } else f.click();
    const expected = structuredClone(f.c), history = structuredClone(f.revisions);
    await Promise.all(f.runs);
    assert.deepEqual(f.c, expected);
    assert.deepEqual(f.revisions, history);
    if (e) {
      assert.equal(f.view.editing, f.c.id);
      assert.equal(e.instruction.value, 'Convert to cloze');
      assert.equal(e.front.value, 'Which process does dormancy delay?');
    }
  });
}

test('a failed instruction stays retryable without duplicating the saved manual revision', async () => {
  let failing = true;
  const f = await fixture({ pause: null, output: () => {
    if (failing) throw Error('Synthetic offline');
    return response(converted);
  } });
  const e = openEditor(f);
  e.front.value = 'Which process does dormancy delay?';
  e.instruction.value = 'Convert to cloze';
  e.save(); await Promise.all(f.runs);
  failing = false;
  e.save(); await Promise.all(f.runs);
  assert.equal(f.c.text, converted.text);
  assert.deepEqual(f.revisions.map(r => r.via), ['edit', 'rewrite']);
  assert.equal(f.view.editing, null);
});

test('an authorized cloze with four supported deletions keeps its grouping', async () => {
  const output = { kind: 'cloze', front: '', back: '', text: '{{c1::Dormancy}} delays {{c2::germination}}; {{c3::light}} triggers {{c4::growth}}.' };
  const f = await fixture({ pause: null, output });
  f.h.text = 'Dormancy delays germination; light triggers growth.';
  f.click(); await Promise.all(f.runs);
  assert.equal(f.c.kind, 'cloze');
  assert.equal(f.c.text, output.text);
  assert.equal(f.requests.length, 1);
  assert.equal(f.revisions.length, 1);
});

test('authorized Convert to Q&A uses the same guarded path', async () => {
  const output = { kind: 'qa', front: 'What does dormancy delay?', back: 'germination', text: '' };
  const f = await fixture({ pause: null, output });
  Object.assign(f.c, converted);
  f.root.empty(); f.view.renderCard(f.root, f.h, f.c);
  nodes(f.root).find(n => n.title === 'Convert to Q&A').events.click({ stopPropagation() {} });
  await Promise.all(f.runs);
  assert.equal(f.requests.length, 1);
  assert.equal(f.c.kind, 'qa');
  assert.equal(f.c.front, output.front);
  assert.equal(f.revisions.length, 1);
});

test('a clean open editor can Convert and redraw from the authorized replacement', async () => {
  const f = await fixture({ pause: null });
  openEditor(f);
  let redraws = 0;
  f.view.render = () => { redraws++; };
  f.click(); await Promise.all(f.runs);
  assert.equal(f.requests.length, 1);
  assert.equal(f.c.text, converted.text);
  assert.equal(f.view.editing, f.c.id);
  assert.equal(redraws, 1);
});

test('the caller independently rejects a late client result after the original changes', async () => {
  const f = await fixture({ pause: null });
  const result = deferred();
  f.llm.rewriteCard = () => result.promise;
  f.click();
  f.c.front = 'A newer saved question';
  const expected = structuredClone(f.c);
  result.resolve(converted); await Promise.all(f.runs);
  assert.deepEqual(f.c, expected);
  assert.deepEqual(f.revisions, []);
});

for (const action of ['Convert', 'Save']) test(`${action} carries authorization through backend preparation`, async () => {
  const f = await fixture({ pause: null });
  f.llm.deepseek.key = () => {
    f.h.sourcePath = 'renamed.md';
    return { key: 'synthetic-test-key', source: 'settings' };
  };
  if (action === 'Save') { const e = openEditor(f); e.instruction.value = 'Convert to cloze'; e.save(); }
  else f.click();
  await Promise.all(f.runs);
  assert.equal(f.requests.length, 0);
  assert.equal(f.c.kind, 'qa');
  assert.deepEqual(f.revisions, []);
});

for (const action of ['Convert', 'Save']) test(`${action} revokes provider-internal parsing retry`, async () => {
  let f;
  f = await fixture({ pause: null, output: () => {
    f.settings.writerInstructions = 'Changed while parsing';
    return { status: 200, json: { choices: [{ message: { content: 'not JSON' }, finish_reason: 'stop' }] } };
  } });
  if (action === 'Save') { const e = openEditor(f); e.instruction.value = 'Convert to cloze'; e.save(); }
  else f.click();
  await Promise.all(f.runs);
  assert.equal(f.requests.length, 1);
  assert.equal(f.c.kind, 'qa');
  assert.deepEqual(f.revisions, []);
});
