import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
import { element, nodes, button } from './quizHarness.mjs';

let InboxView, InboxStore, LlmClient, makeHighlight, makeCard, parseInboxJson, observe, schemaJson;
const notices = [], modals = [], frames = [];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise(r => setImmediate(r));
async function until(check) { for (let i = 0; i < 100 && !check(); i++) await turn(); assert.ok(check(), 'Operation reached its barrier'); }
function dom() {
  const extend = el => {
    const create = el.createEl;
    el.createEl = function (...args) { return extend(create.apply(this, args)); };
    el.show = el.hide = el.toggle = () => {};
    el.querySelector = selector => {
      const match = selector.match(/^\.wikilm-card\[data-id="([^"]+)"\] \.wikilm-editor$/);
      const card = match ? nodes(el).find(n => n.dataset.id === match[1]) : undefined;
      return card ? nodes(card).find(n => n.hasClass('wikilm-editor')) ?? null : null;
    };
    return el;
  };
  return extend(element());
}
before(async () => {
  const out = await build({ stdin: { contents: `export { InboxView } from './src/inboxView'; export { LlmClient } from './src/llm'; export { makeCard, makeHighlight } from './src/model'; export { parseInboxJson } from './src/inboxData'; export { observe } from './src/preferences'; export { schemaJson } from './src/jsonOut'; export { InboxStore } from './src/store';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'cjs', platform: 'node', external: ['obsidian'], logLevel: 'silent' });
  const mod = new Module('explicit-rewrite');
  const obsidian = new Proxy({
    ItemView: class { constructor(leaf) { this.contentEl = leaf.contentEl; } registerDomEvent() {} },
    Notice: class { constructor(message) { notices.push(message); } hide() {} },
    Modal: class { constructor() { this.contentEl = dom(); } open() { modals.push(this); } close() { this.onClose(); } },
    setIcon() {}, normalizePath: path => path, requestUrl() { throw Error('Network forbidden'); },
  }, { get: (o, k) => o[k] ?? class {} });
  mod.require = id => id === 'obsidian' ? obsidian : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text, 'explicit-rewrite');
  ({ InboxView, InboxStore, LlmClient, makeHighlight, makeCard, parseInboxJson, observe, schemaJson } = mod.exports);
});
const fixtureAudit = cards => ({ preservesFacts: true, reason: 'All supported original facts retained.', verdicts: cards.map((_, index) => ({ index, verdict: 'keep', reason: '' })) });
const drafts = [
  { kind: 'cloze', front: '', back: '', text: 'Object A {{c1::contracts}}.' },
  { kind: 'qa', front: 'What happens to Object B?', back: 'stays constant', text: '' },
];
function fixture({ output = { cards: drafts }, audit, pause } = {}) {
  frames.length = 0;
  globalThis.window = { requestAnimationFrame: fn => frames.push(fn), setTimeout() {}, clearTimeout() {} };
  const h = makeHighlight({ sourcePath: 'objects.md', sourceTitle: 'Objects', text: 'Object A contracts. Object B stays constant.', status: 'ready' });
  const c = makeCard(h.id, { kind: 'cloze', text: 'Object A {{c1::contracts}}. Object B {{c2::stays constant}}.', extra: 'My annotation and source link.' });
  const left = makeCard(h.id, { kind: 'qa', front: 'Which object changes?', back: 'Object A' });
  const right = makeCard(h.id, { kind: 'qa', front: 'Which object is stable?', back: 'Object B' });
  h.cards = [left, c, right];
  const highlights = [h], requests = [], revisions = [], root = dom(), barrier = deferred();
  let pending = false, learning = 0, rules = 'Keep the subject visible.';
  const settings = { provider: 'deepseek', deepseekModel: 'synthetic', language: 'English', writerInstructions: '', historyExamples: false, schemaLearning: true };
  const llm = new LlmClient(() => settings, () => [], async () => {
    if (pause === 'rules') { pending = true; await barrier.promise; }
    return { cards: rules };
  });
  llm.deepseek = { async complete(req) {
    assert.equal(req.authorized(), true, 'Check authorization at transport');
    requests.push(req);
    if (pause === req.label) { pending = true; await barrier.promise; }
    const value = req.label === 'rewrite audit'
      ? audit ?? { preservesFacts: true, reason: 'Both original facts retained.', verdicts: drafts.map((_, index) => ({ index, verdict: 'keep', reason: '' })) }
      : typeof output === 'function' ? output(req) : output;
    return req.schema.parse(value);
  }, async abort() {} };
  const host = { app: { vault: { getFiles: () => [], configDir: '.obsidian' }, workspace: {}, metadataCache: {} }, settings, llm,
    schema: { openCount: () => 0, learn: async () => { learning++; return 0; } },
    exportHighlights() { assert.fail('Rewrite must never export'); },
    store: { all: () => highlights, onChange: () => () => {}, counts: () => ({ toReview: 3, queued: 0, generating: 0, errors: 0 }), touch: () => view.scheduleRender(), recordRevision: r => revisions.push(r) } };
  const view = new InboxView({ contentEl: root }, host);
  const runs = [], rewrite = view.rewrite.bind(view);
  view.rewrite = (...args) => { const run = rewrite(...args); runs.push(run); return run; };
  const draw = () => { while (frames.length) frames.shift()(); };
  const card = () => nodes(root).find(n => n.hasClass('wikilm-card') && n.dataset.id === c.id);
  const click = title => nodes(card()).find(n => n.title === title).events.click({ stopPropagation() {} });
  const fields = () => {
    const form = nodes(card()).find(n => n.hasClass('wikilm-editor'));
    return { form, fields: nodes(form).filter(n => n.tagName === 'TEXTAREA') };
  };
  const star = instruction => { click('Rewrite card with AI (asks what to change)'); const modal = modals.at(-1); modal.value = instruction; modal.submit(); };
  const save = instruction => { click('Edit (e)'); const e = fields(); e.fields[4].value = instruction; button(e.form, 'Save').events.click(); return e; };
  return { h, c, left, right, highlights, requests, revisions, host, view, root, llm, settings, draw, click, fields, star, save,
    pending: () => pending, release: () => barrier.resolve(), runs, learning: () => learning, rules: value => { rules = value; } };
}

const procedure = 'disconnect the power, attach the reference cable, and reconnect power only after the indicator turns green';
for (const kind of ['qa', 'cloze']) for (const focused of [true, false]) test(`G3: ${kind} ${focused ? 'meaningful procedure passes' : 'unfocused unit is held'} only after length adjudication`, async () => {
  const answer = focused ? procedure : `${procedure}; record the serial number, identify the cable manufacturer, name the room, and list the tools`;
  const source = `Zeta sensor calibration uses this ordered procedure: ${procedure}. Record the serial number, identify the cable manufacturer, name the room, and list the tools.`;
  const output = { cards: [kind === 'qa'
    ? { kind, front: focused ? 'During Zeta sensor calibration, what ordered actions and reconnection condition apply?' : 'Zeta sensor calibration: what actions, identifying details, surroundings and equipment must be recalled?', back: answer, text: '' }
    : { kind, front: '', back: '', text: focused ? `Zeta sensor calibration requires {{c1::${procedure}}}.` : `Zeta sensor calibration requires {{c1::${procedure}}}; record {{c1::the serial number}}, identify {{c1::the cable manufacturer}}, name {{c1::the room}}, and list {{c1::the tools}}.` }] };
  const audit = { preservesFacts: true, reason: 'Synthetic source comparison', verdicts: [{ index: 0, verdict: focused ? 'keep' : 'revise', reason: focused ? 'One procedural unit with its essential condition' : 'Combines independent retrieval targets' }] };
  const f = fixture({ output, audit });
  f.h.text = source;
  Object.assign(f.c, { kind: 'qa', front: 'Zeta sensor calibration: what is its procedure?', back: procedure, text: '' });
  const before = structuredClone(f.h);
  await f.view.onOpen();
  f.star('Keep the complete procedure and condition; improve its cue.'); await Promise.all(f.runs); f.draw();
  assert.deepEqual(f.requests.map(r => r.label), ['rewrite cards', 'rewrite audit'], 'length is adjudicated, not rejected before the independent check');
  const request = f.requests[1], payload = JSON.parse(request.user);
  const finding = payload.cards[0].checks.find(c => c.id === (kind === 'qa' ? 'qa-answer-long' : 'cloze-framing'));
  assert.match(finding.finding, /adjudicate.*meaningful|adjudicate.*meaning/i);
  assert.match(request.system, /product polic.*independent adjudication/i);
  assert.doesNotMatch(request.system, /linter fails a qa answer over twelve|Each deletion is at most six words|linter rejects longer/);
  if (focused) {
    assert.equal(f.revisions.length, 1);
    assert.equal(kind === 'qa' ? f.c.back : f.c.text, kind === 'qa' ? procedure : output.cards[0].text);
    assert.equal(f.c.extra, before.cards[1].extra);
  } else {
    assert.deepEqual(f.h, before);
    assert.deepEqual(f.revisions, []);
  }
  await f.view.onClose();
});

test('G3: over-sixty-word unfocused card reaches audit with its actual findings and remains unchanged', async () => {
  const back = `${procedure}; ${'record the serial number and list the tools; '.repeat(8)}`;
  const output = { cards: [{ kind: 'qa', front: 'Zeta calibration: what procedure and independent inventory details apply?', back, text: '' }] };
  const f = fixture({ output, audit: { preservesFacts: true, reason: 'Synthetic', verdicts: [{ index: 0, verdict: 'revise', reason: 'Unfocused inventory and procedural targets' }] } });
  f.h.text = back;
  const before = structuredClone(f.h);
  await f.view.onOpen(); f.star('Improve the cue'); await Promise.all(f.runs);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(JSON.parse(f.requests[1].user).cards[0].checks.map(c => c.id), ['qa-answer-long', 'card-long']);
  assert.deepEqual(f.h, before); assert.deepEqual(f.revisions, []);
  await f.view.onClose();
});

test('rendered star atomically inserts all checked split drafts in the original slot', async () => {
  const f = fixture(); await f.view.onOpen();
  const original = structuredClone(f.c);
  f.star('Split into multiple cards'); await Promise.all(f.runs); f.draw();
  const live = f.h.cards.filter(c => c.status !== 'deleted');
  assert.equal(live.length, 4);
  assert.equal(live[0], f.left); assert.equal(live[3], f.right);
  assert.deepEqual(live.slice(1, 3).map(c => c.kind), ['cloze', 'qa']);
  assert.equal(f.c.status, 'deleted', 'Retain the original as history, not an exportable draft');
  assert.equal(f.c.text, original.text);
  assert.equal(new Set(f.h.cards.map(c => c.id)).size, 5);
  for (const c of live.slice(1, 3)) {
    assert.notEqual(c.id, original.id);
    assert.equal(c.status, 'pending'); assert.equal(c.extra, original.extra);
    assert.equal(c.ankiNoteId, undefined); assert.equal(c.srNote, undefined);
    assert.equal(c.rewrite.sourceCardId, original.id);
    assert.equal(c.userCheck.issues.length, 0);
  }
  assert.deepEqual(f.requests.map(r => r.label), ['rewrite cards', 'rewrite audit']);
  const schema = schemaJson(f.requests[0].schema).properties.cards;
  assert.equal(schema.minItems, 1); assert.equal(schema.maxItems, 12);
  for (const field of ['front', 'back', 'text']) {
    assert.match(schema.items.properties[field].description, /Empty string/);
    assert.equal(schema.items.properties[field].maxLength, 4000);
  }
  assert.equal(f.revisions.length, 1, 'A split is one user action, never one preference vote per child');
  assert.equal(f.revisions[0].replacements.length, 2);
  assert.equal(f.learning(), 0);
  await f.view.onClose();
});

for (const action of ['star', 'Save']) test(`${action} split preserves receipts and resolvable generation evidence on the retained original only`, async () => {
  const f = fixture();
  f.h.generation = { version: 1, id: 'batch', instruction: '', inputKey: 'key', phase: 'complete', preparation: {
    facts: [{ id: 'fact-A', statement: 'Object A contracts.', quote: 'Object A contracts.' }, { id: 'fact-B', statement: 'Object B stays constant.', quote: 'Object B stays constant.' }],
    plan: [{ id: 'plan', factIds: ['fact-A', 'fact-B'], entity: 'Objects', aspect: 'change', value: 'contrasting changes', reason: 'Retain both changes.' }], exclusions: [], omissions: [], conflicts: [],
  } };
  f.c.generation = { batchId: 'batch', planId: 'plan', factIds: ['fact-A', 'fact-B'], audit: { status: 'verified', reason: 'Old wording checked.', content: 'old' } };
  Object.assign(f.c, { status: 'approved', ankiNoteId: 91, srNote: 'review.md' });
  await f.view.onOpen();
  const before = structuredClone(f.c);
  if (action === 'star') f.star('Split the two facts'); else f.save('Split the two facts');
  await Promise.all(f.runs); f.draw();
  const children = f.h.cards.filter(c => c.rewrite);
  assert.equal(children.length, 2);
  for (const child of children) {
    assert.equal(child.ankiNoteId, undefined); assert.equal(child.srNote, undefined);
    assert.deepEqual(child.generation.factIds, before.generation.factIds);
    assert.equal(child.generation.audit.status, 'unverified');
  }
  assert.deepEqual(f.c, { ...before, status: 'deleted' });
  const parsed = parseInboxJson(JSON.stringify({ version: 1, highlights: [f.h], revisions: f.revisions }));
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.data.highlights[0].cards, f.h.cards);
  assert.deepEqual(parsed.data.revisions, f.revisions);
  assert.deepEqual(observe(f.revisions), [], 'A split is not a fabricated per-child shortening or format preference');
  assert.equal(f.learning(), 0);
  const request = JSON.parse(f.requests[0].user);
  assert.equal(request.rewriteInstruction, 'Split the two facts');
  assert.equal(request.houseRules, 'Keep the subject visible.');
  assert.equal(request.siblings.length, 2);
  assert.match(JSON.parse(f.requests[1].user).task, /no source-supported fact/);
  await f.view.onClose();
});

const malformed = [null, {}, { cards: [] }, { cards: Array.from({ length: 13 }, () => drafts[0]) },
  { cards: [drafts[0], null] }, { cards: [drafts[0], { ...drafts[1], front: 42 }] },
  { cards: [drafts[0], { ...drafts[1], text: 'unexpected extra variant' }] },
  { cards: [drafts[0], { ...drafts[1], back: ' ' }] },
  { cards: [drafts[0], { ...drafts[1], front: 'x'.repeat(4001) }] },
  { cards: [drafts[0], { kind: 'cloze', front: '', back: '', text: 'Object B {{c1::grows}}.' }] },
  { cards: [drafts[0], { kind: 'cloze', front: '', back: '', text: 'Object B {{c1::stays constant}.' }] },
  { cards: [drafts[0], { kind: 'cloze', front: '', back: '', text: 'Object B {{c1:: }}.' }] },
  { cards: [drafts[0], { kind: 'cloze', front: '', back: '', text: 'Object B {{c2::stays constant}}.' }] },
  { cards: [drafts[0], { kind: 'cloze', front: '', back: '', text: 'Object B stays constant: {{c1::stays constant}}.' }] },
  { cards: [drafts[0], drafts[0]] },
];
for (const [i, output] of malformed.entries()) test(`malformed or unsafe set ${i} preserves every original field and history without partial insertion`, async () => {
  const f = fixture({ output }); await f.view.onOpen();
  const expected = structuredClone(f.h);
  f.star('Split into cards'); await Promise.all(f.runs); f.draw();
  assert.deepEqual(f.h, expected);
  assert.deepEqual(f.revisions, []); assert.equal(f.learning(), 0);
  assert.equal(f.requests.length, 1, 'Reject malformed drafts before the independent model check');
  await f.view.onClose();
});

for (const audit of [
  { ...fixtureAudit(drafts), preservesFacts: false },
  { ...fixtureAudit(drafts), verdicts: [{ index: 0, verdict: 'keep', reason: '' }] },
  { ...fixtureAudit(drafts), verdicts: [{ index: 0, verdict: 'keep', reason: '' }, { index: 0, verdict: 'keep', reason: '' }] },
  { ...fixtureAudit(drafts), verdicts: [{ index: 0, verdict: 'keep', reason: '' }, { index: 2, verdict: 'keep', reason: '' }] },
  { ...fixtureAudit(drafts), verdicts: [{ index: 0, verdict: 'keep', reason: '' }, { index: 1, verdict: 'revise', reason: 'Missing context.' }] },
  {}, null,
]) test(`independent quality or coverage failure preserves the complete original: ${JSON.stringify(audit)}`, async () => {
  const f = fixture({ audit: audit === null ? { preservesFacts: 'wrong type' } : audit }); await f.view.onOpen();
  const expected = structuredClone(f.h);
  f.star('Split into cards'); await Promise.all(f.runs); f.draw();
  assert.deepEqual(f.h, expected); assert.deepEqual(f.revisions, []);
  assert.equal(f.requests.length, 2); assert.equal(f.learning(), 0);
  await f.view.onClose();
});

const invalidations = {
  source: f => { f.h.text = 'Changed captured source'; },
  'source-location': f => { f.h.page = 2; },
  'saved-evidence': f => { f.h.generationHistory = []; },
  settings: f => { f.settings.writerInstructions = 'New instructions'; },
  sibling: f => { f.right.front = 'New sibling wording'; },
  'sibling-export': f => { f.right.status = 'exported'; },
  'editor-open': f => { f.click('Edit (e)'); },
  export: f => { f.c.status = 'exported'; },
  receipts: f => { f.c.ankiNoteId = 17; },
  'view-close': f => f.view.onClose(),
  abort: f => f.llm.abort(),
  remove: f => { f.highlights.length = 0; },
};
for (const action of ['star', 'Save']) for (const pause of ['rules', 'rewrite cards', 'rewrite audit']) {
  for (const [name, invalidate] of Object.entries(invalidations)) test(`${action} cancels ${name} during ${pause} without later disclosure or replacement`, async () => {
    const f = fixture({ pause }); await f.view.onOpen();
    const editor = action === 'Save' ? f.save('Split the facts') : undefined;
    if (action === 'star') f.star('Split the facts');
    await until(f.pending);
    if (action === 'Save' && name === 'editor-open') editor.fields[3].value = 'Newer unsaved annotation';
    else await invalidate(f);
    const expected = structuredClone(f.h), history = structuredClone(f.revisions);
    f.release(); await Promise.all(f.runs); f.draw();
    assert.deepEqual(f.h, expected); assert.deepEqual(f.revisions, history);
    assert.equal(f.requests.length, pause === 'rules' ? 0 : pause === 'rewrite cards' ? 1 : 2);
    if (editor && name !== 'view-close') {
      assert.equal(f.fields().form, editor.form);
      assert.equal(f.fields().fields[4].value, 'Split the facts');
      if (name === 'editor-open') assert.equal(f.fields().fields[3].value, 'Newer unsaved annotation');
    }
    await f.view.onClose();
  });
}

for (const pause of ['rewrite cards', 'rewrite audit']) test(`rules changed during ${pause} prevent acceptance and the next dispatch`, async () => {
  const f = fixture({ pause }); await f.view.onOpen();
  const before = structuredClone(f.h);
  f.star('Split into cards'); await until(f.pending);
  f.rules('Changed rules'); f.release(); await Promise.all(f.runs);
  assert.deepEqual(f.h, before); assert.deepEqual(f.revisions, []);
  assert.equal(f.requests.length, pause === 'rewrite cards' ? 1 : 2);
  await f.view.onClose();
});

test('star cancellation spends nothing and a later submission remains retryable', async () => {
  const f = fixture(); await f.view.onOpen();
  const before = structuredClone(f.h);
  f.click('Rewrite card with AI (asks what to change)'); modals.at(-1).close(); await Promise.all(f.runs);
  assert.deepEqual(f.h, before); assert.equal(f.requests.length, 0);
  f.star('Split the facts'); await Promise.all(f.runs);
  assert.equal(f.h.cards.filter(c => c.rewrite).length, 2);
  await f.view.onClose();
});

for (const changed of [true, false]) test(`one-card explicit response ${changed ? 'changes' : 'leaves'} the existing draft without a false split preference`, async () => {
  const output = { cards: [{ kind: 'cloze', front: '', back: '', text: changed ? 'Object B {{c1::stays constant}}; Object A {{c2::contracts}}.' : 'Object A {{c1::contracts}}. Object B {{c2::stays constant}}.' }] };
  const f = fixture({ output, audit: fixtureAudit(output.cards) }); await f.view.onOpen();
  const id = f.c.id;
  Object.assign(f.c, { lintFailures: ['cloze-framing'], lintWarnings: ['shared-answer'], critiqueReason: 'Old findings', bloom: 'remember', critiqueRan: true });
  f.star('Keep both facts in one card'); await Promise.all(f.runs);
  assert.equal(f.h.cards.length, 3); assert.equal(f.c.id, id);
  if (changed) {
    for (const key of ['lintFailures', 'lintWarnings', 'critiqueReason', 'bloom', 'critiqueRan']) assert.equal(f.c[key], undefined);
  }
  assert.equal(f.revisions.length, changed ? 1 : 0);
  assert.equal(f.learning(), 0);
  await f.view.onClose();
});

for (const stage of ['rewrite cards', 'rewrite audit']) test(`a failed ${stage} remains atomic and retryable`, async () => {
  const f = fixture(); await f.view.onOpen();
  const backend = f.llm.deepseek.complete;
  let fail = true;
  f.llm.deepseek.complete = async req => {
    if (fail && req.label === stage) throw Error('Synthetic offline');
    return backend(req);
  };
  const before = structuredClone(f.h);
  f.star('Split into cards'); await Promise.all(f.runs);
  assert.deepEqual(f.h, before); assert.deepEqual(f.revisions, []);
  fail = false;
  f.star('Split into cards'); await Promise.all(f.runs);
  assert.equal(f.h.cards.filter(c => c.rewrite).length, 2);
  assert.equal(f.revisions.length, 1);
  await f.view.onClose();
});

test('two mounted panes share the rewrite lock through the independent audit', async () => {
  const f = fixture({ pause: 'rewrite audit' }); await f.view.onOpen();
  const otherRoot = dom(), other = new InboxView({ contentEl: otherRoot }, f.host);
  await other.onOpen();
  f.star('Split the facts'); await until(f.pending);
  const count = modals.length;
  const otherCard = nodes(otherRoot).find(n => n.hasClass('wikilm-card') && n.dataset.id === f.c.id);
  nodes(otherCard).find(n => n.title === 'Rewrite card with AI (asks what to change)').events.click({ stopPropagation() {} });
  assert.equal(modals.length, count, 'A second pane cannot start a competing instruction');
  f.release(); await Promise.all(f.runs); f.draw();
  assert.equal(f.requests.length, 2); assert.equal(f.revisions.length, 1);
  await other.onClose(); await f.view.onClose();
});

test('the complete operational maximum is accepted without truncation', async () => {
  const cards = Array.from({ length: 12 }, (_, i) => ({ kind: 'cloze', front: '', back: '', text: `Object ${i} {{c1::contracts${i}}}.` }));
  const f = fixture({ output: { cards }, audit: fixtureAudit(cards) });
  f.h.text = cards.map(c => c.text.replace(/\{\{c1::(.*?)\}\}/g, '$1')).join(' ');
  f.c.text = f.h.text;
  f.h.cards = [f.c];
  await f.view.onOpen(); f.star('Split each fact'); await Promise.all(f.runs); f.draw();
  assert.equal(f.h.cards.length, 13);
  assert.equal(f.h.cards.filter(c => c.rewrite && c.status === 'pending').length, 12);
  assert.equal(f.revisions[0].replacements.length, 12);
  await f.view.onClose();
});

test('rendered split survives real store flush and reload with every ID, receipt and revision intact', async () => {
  const f = fixture(), files = new Map();
  const adapter = { exists: async path => files.has(path), mkdir: async () => {}, read: async path => files.get(path),
    write: async (path, bytes) => { files.set(path, bytes); }, remove: async path => { files.delete(path); },
    rename: async (from, to) => { assert.ok(!files.has(to), 'Desktop rename does not overwrite'); files.set(to, files.get(from)); files.delete(from); } };
  const app = { vault: { adapter } };
  const store = new InboxStore(app, 'synthetic-data'); await store.load();
  Object.assign(f.c, { ankiNoteId: 29, srNote: 'review.md' });
  store.add(f.h); f.host.store = store;
  await f.view.onOpen(); f.star('Split into cards'); await Promise.all(f.runs); f.draw();
  const expected = JSON.parse(JSON.stringify(f.h)), history = structuredClone(store.revisions());
  assert.equal(expected.cards.filter(c => c.rewrite).length, 2);
  await store.flush(); await f.view.onClose(); store.close();
  const loaded = new InboxStore(app, 'synthetic-data'); await loaded.load();
  assert.deepEqual(loaded.allHistory(), [expected]);
  assert.deepEqual(loaded.revisions(), history);
  assert.equal(loaded.findCard(f.c.id).card.ankiNoteId, 29);
  assert.ok(loaded.hasDuplicate(f.h.sourcePath, f.h.text), 'The retained split still blocks accidental recapture');
  loaded.close();
});

test('a changed one-card explicit response forks a receipted record instead of repurposing review history', async () => {
  const cards = [{ kind: 'cloze', front: '', back: '', text: 'Object B {{c1::stays constant}}; Object A {{c2::contracts}}.' }];
  const f = fixture({ output: { cards }, audit: fixtureAudit(cards) });
  Object.assign(f.c, { ankiNoteId: 19, srNote: 'review.md' });
  const before = structuredClone(f.c);
  await f.view.onOpen(); f.star('Keep both facts'); await Promise.all(f.runs);
  const child = f.h.cards.find(c => c.rewrite);
  assert.ok(child); assert.notEqual(child.id, before.id);
  assert.equal(child.ankiNoteId, undefined); assert.equal(child.srNote, undefined);
  assert.deepEqual(f.c, { ...before, status: 'deleted' });
  await f.view.onClose();
});
