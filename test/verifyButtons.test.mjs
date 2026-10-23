import { before, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadQuiz, element, nodes } from './quizHarness.mjs';

let InboxView, LlmClient, makeHighlight, makeCard, DEFAULT_SETTINGS, transport, previousWindow;
const notices = [];
before(async () => {
  ({ InboxView } = await loadQuiz('src/inboxView.ts', { Notice: class { constructor(message) { notices.push(message); } hide() {} } }));
  ({ LlmClient } = await loadQuiz('src/llm.ts', { requestUrl: request => transport(request) }));
  ({ makeHighlight, makeCard } = await loadQuiz('src/model.ts'));
  ({ DEFAULT_SETTINGS } = await loadQuiz('src/settings.ts'));
});
beforeEach(() => {
  notices.length = 0;
  previousWindow = globalThis.window;
  globalThis.window = { requestAnimationFrame: callback => setImmediate(callback), setTimeout() {} };
});
afterEach(() => {
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
});

function matches(el, selector) {
  const tag = selector.match(/^[a-z]+/i)?.[0];
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  if ([...selector.matchAll(/\.([\w-]+)/g)].some(([, cls]) => !el.classes.includes(cls))) return false;
  const id = selector.match(/\[data-id="([^"]+)"\]/)?.[1];
  return !id || el.dataset.id === id;
}
function dom() {
  const extend = el => {
    Object.assign(el, el.options.attr);
    const create = el.createEl;
    el.createEl = function (...args) { const child = extend(create.apply(this, args)); child.parentElement = this; return child; };
    el.closest = function (selector) { for (let n = this; n; n = n.parentElement) if (matches(n, selector)) return n; return null; };
    el.querySelectorAll = function (selector) {
      const parts = selector.split(' '), last = parts.pop();
      return nodes(this).slice(1).filter(n => matches(n, last) && (!parts.length || n.parentElement?.closest(parts.join(' '))));
    };
    el.querySelector = function (selector) { return this.querySelectorAll(selector)[0] ?? null; };
    el.show = el.hide = el.toggle = () => {};
    return el;
  };
  return extend(element());
}
const buttons = root => nodes(root).filter(n => n.tagName === 'BUTTON');
const byClass = (root, cls) => nodes(root).find(n => n.classes.includes(cls));
const reply = value => ({ status: 200, json: { choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] } });
const keep = { index: 0, verdict: 'keep', reason: '', bloom: 'remember', kind: 'qa', front: '', back: '', text: '' };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); }
  assert.fail('Pending operation did not reach its barrier');
}
function barrier() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}
async function fixture(t, { rules = async () => ({ cards: '' }), onRequest } = {}) {
  const highlights = [], requests = [], revisions = [], exports = [];
  const settings = { ...DEFAULT_SETTINGS, provider: 'deepseek', deepseekApiKey: 'synthetic-test-key', deepseekModel: 'synthetic', historyExamples: false, schemaLearning: false, lintMode: 'badge' };
  const add = (path, text, front, back) => {
    const h = makeHighlight({ sourcePath: path, sourceTitle: path, text, status: 'ready', line: highlights.length });
    h.cards = [makeCard(h.id, { kind: 'qa', front, back })]; highlights.push(h); return h;
  };
  const first = add('seeds.md', 'Dormancy delays germination.', 'What does dormancy delay?', 'germination');
  const second = add('seeds.md', 'Heat increases evaporation.', 'What does heat increase?', 'evaporation');
  const other = add('roots.md', 'Roots absorb water.', 'What do roots absorb?', 'water');
  transport = async request => { const user = JSON.parse(request.body).messages[1].content; requests.push(user); return onRequest ? onRequest(user) : reply({ verdicts: [keep] }); };
  const llm = new LlmClient(() => settings, () => [], rules);
  const root = dom();
  let changed = () => {};
  const host = { app: { vault: { getFiles: () => [], configDir: '.obsidian' }, workspace: {}, metadataCache: {} }, settings, llm,
    schema: { openCount: () => 0 }, exportHighlights: async (hs, ids) => exports.push({ hs, ids }),
    store: { all: () => highlights.filter(h => !h.archived), counts: () => ({ toReview: 3, queued: 0, generating: 0, errors: 0 }), onChange: fn => { changed = fn; return () => { changed = () => {}; }; }, touch() { changed(); }, recordRevision: r => revisions.push(r) } };
  const view = new InboxView({ contentEl: root }, host);
  await view.onOpen();
  t.after(() => view.onClose());
  const group = scope => scope === 'inbox' ? byClass(root, 'wikilm-header-right') : scope === 'source' ? byClass(root, 'wikilm-source-actions') : byClass(root, 'wikilm-hl-actions');
  const verify = scope => {
    const row = group(scope), index = row.children.findIndex(n => n.text === 'Export');
    const button = row.children[index + 1];
    assert.equal(button?.text, 'Verify', `${scope} must put Verify immediately after Export`);
    assert.equal(button.tagName, 'BUTTON');
    assert.ok(button['aria-label'], 'Verify needs an accessible label');
    return button;
  };
  return { root, view, host, settings, highlights, first, second, other, add, requests, revisions, exports, verify, group };
}

for (const [scope, count] of [['source', 2], ['passage', 1]]) test(`${scope} Verify checks only its visible scope without a duplicate batch star`, async t => {
  const f = await fixture(t);
  await f.verify(scope).events.click();
  assert.equal(f.requests.length, count);
  assert.equal(f.other.cards[0].userCheck, undefined);
  assert.ok(!buttons(f.group('passage')).some(b => b.title === 'Check cards against best practices (repair issues)'));
  assert.ok(buttons(f.root).some(b => b.title === 'Check card against best practices (repair issues)'), 'Individual stars stay');
  assert.deepEqual(f.exports, []);
});

test('Verify exposes a shared busy state, rejects overlapping clicks and snapshots targets', async t => {
  const gate = barrier();
  let reads = 0;
  const f = await fixture(t, { rules: async () => { if (++reads === 1) await gate.promise; return { cards: '' }; } });
  const inbox = f.verify('inbox'), source = f.verify('source'), passage = f.verify('passage');
  const run = inbox.events.click();
  await until(() => reads === 1);
  const during = [inbox, source, passage].map(b => [b.disabled, b['aria-busy']]);
  await source.events.click();
  await passage.events.click();
  await inbox.events.click();
  const added = f.add('later.md', 'Rain wets soil.', 'What wets soil?', 'rain');
  gate.release();
  await run;
  assert.deepEqual(during, [[true, 'true'], [true, 'true'], [true, 'true']]);
  assert.equal(f.requests.length, 3, 'Only the click-time targets may run, sequentially');
  assert.equal(added.cards[0].userCheck, undefined);
  await tick();
  assert.equal(f.verify('inbox').disabled, false);
  assert.equal(f.verify('inbox')['aria-busy'], 'false');
});

for (const [name, revoke] of Object.entries({
  settings: f => { f.settings.writerInstructions = 'New rules'; },
  'client-abort': f => f.host.llm.abort(),
  close: f => f.view.onClose(),
})) test(`Verify retains click-time ${name} authorization between cards`, async t => {
  const f = await fixture(t);
  const touch = f.host.store.touch;
  f.host.store.touch = () => { revoke(f); touch(); };
  await f.verify('inbox').events.click();
  assert.equal(f.requests.length, 1, 'A revoked batch cannot renew authorization for its next card');
  assert.equal(f.second.cards[0].userCheck, undefined);
});

for (const phase of ['rules', 'transport']) for (const hidden of ['source', 'flagged', 'filter', 'close']) {
  test(`Verify stops when its current target becomes hidden by ${hidden} during ${phase}`, async t => {
    const gate = barrier();
    let reached = false;
    const pause = async () => { reached = true; await gate.promise; };
    const f = await fixture(t, phase === 'rules'
      ? { rules: async () => { await pause(); return { cards: '' }; } }
      : { onRequest: async () => { await pause(); return reply({ verdicts: [keep] }); } });
    if (hidden === 'flagged') {
      f.settings.lintMode = 'hide'; f.first.cards[0].status = 'flagged';
      f.view.expandedFlagged.add(f.first.id); f.view.render();
    }
    const run = f.verify('inbox').events.click();
    await until(() => reached);
    if (hidden === 'source') byClass(f.root, 'wikilm-collapse').events.click();
    else if (hidden === 'flagged') byClass(f.root, 'wikilm-flagged-toggle').events.click();
    else if (hidden === 'filter') { const filter = byClass(f.root, 'wikilm-filter'); filter.value = 'exported'; filter.events.change(); }
    else await f.view.onClose();
    gate.release();
    await run;
    assert.equal(f.requests.length, phase === 'rules' ? 0 : 1, 'Hidden targets cannot authorize more disclosure');
    assert.equal(f.first.cards[0].userCheck, undefined, 'Hidden targets cannot accept a late verdict');
    assert.equal(f.second.cards[0].userCheck, undefined);
    assert.deepEqual(f.revisions, []);
  });
}

for (const scope of ['inbox', 'source', 'passage']) test(`${scope} Verify gives an empty visible scope a clear no-op`, async t => {
  const f = await fixture(t);
  f.first.cards[0].status = 'flagged'; f.second.cards[0].status = 'flagged'; f.other.cards[0].status = 'flagged';
  f.settings.lintMode = 'hide'; f.view.render();
  // All scopes keep their paired Export/Verify affordance, but hidden flagged cards are not targets.
  const button = f.verify(scope);
  await button.events.click();
  assert.deepEqual(f.requests, []);
  assert.ok(notices.some(m => /no visible.*(draft|card).*verif/i.test(m)), 'Explain why nothing ran');
  assert.equal(button.disabled, false);
});

for (const scope of ['inbox', 'source', 'passage']) test(`${scope} Verify excludes hidden, inactive and non-draft cards`, async t => {
  const f = await fixture(t);
  f.first.cards[0].status = 'approved';
  f.second.cards[0].status = 'flagged';
  f.settings.lintMode = 'hide';
  f.view.collapsed.add('roots.md');
  for (const status of ['exported', 'deleted', 'duplicate']) {
    const card = makeCard(f.first.id, { kind: 'qa', front: `Question for ${status}?`, back: status });
    card.status = status; f.first.cards.push(card);
  }
  for (const status of ['queued', 'generating', 'error', 'dismissed', 'exported']) {
    const h = f.add('seeds.md', 'Ineligible source.', `Question for ${status}?`, status); h.status = status;
  }
  f.view.render();
  await f.verify(scope).events.click();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.first.cards[0].userCheck.issues, []);
  assert.equal(f.first.cards[0].status, 'approved', 'Checking a clean legacy-approved card does not export or change it');
  assert.equal(f.second.cards[0].userCheck, undefined);
  assert.equal(f.other.cards[0].userCheck, undefined);
  assert.equal(buttons(nodes(f.root).find(n => n.classes.includes('wikilm-source') && nodes(n).some(x => x.text === 'roots.md'))).filter(b => b.text === 'Verify').length, 0);
  assert.deepEqual(f.exports, []);
});

for (const filter of ['all', 'exported']) test(`Verify respects the ${filter} filter and eligible passage statuses`, async t => {
  const f = await fixture(t);
  f.other.status = 'exported'; f.other.cards[0].status = 'exported';
  const dismissed = f.add('old.md', 'Dismissed source.', 'What was dismissed?', 'capture'); dismissed.status = 'dismissed';
  const select = byClass(f.root, 'wikilm-filter'); select.value = filter; select.events.change();
  await f.verify('inbox').events.click();
  assert.equal(f.requests.length, filter === 'all' ? 2 : 0);
  assert.equal(dismissed.cards[0].userCheck, undefined);
  assert.equal(f.other.cards[0].userCheck, undefined);
});

for (const scope of ['inbox', 'source', 'passage']) test(`${scope} Verify repairs and rechecks through the real client with one saved revision`, async t => {
  let calls = 0;
  const replacement = { kind: 'qa', front: 'What does dormancy delay?', back: 'germination', text: '' };
  const f = await fixture(t, { onRequest: user => {
    calls++;
    if (user.includes('Rewrite this one card.')) return reply(replacement);
    return reply({ verdicts: [calls === 1 ? { ...keep, verdict: 'revise', reason: 'Name the subject.' } : keep] });
  } });
  const card = f.first.cards[0]; card.front = 'What does it delay?';
  const original = structuredClone(card);
  f.view.render();
  await f.verify(scope).events.click();
  assert.equal(f.requests.length, scope === 'inbox' ? 5 : scope === 'source' ? 4 : 3);
  assert.equal(card.front, replacement.front);
  assert.equal(card.status, 'pending'); assert.deepEqual(card.userCheck.issues, []);
  assert.equal(f.revisions.length, 1);
  assert.equal(f.revisions[0].via, 'repair');
  assert.equal(f.revisions[0].cardId, original.id);
  assert.equal(f.revisions[0].before.front, original.front);
  assert.equal(f.revisions[0].after.front, replacement.front);
  assert.deepEqual(f.exports, []);
});

for (const failure of ['transport', 'same-replacement', 'failed-recheck']) test(`Verify stops on ${failure} and preserves the original and history`, async t => {
  const f = await fixture(t, { onRequest: user => {
    if (failure === 'transport') throw Error('Synthetic provider failure');
    if (user.includes('Rewrite this one card.')) return reply({ kind: 'qa', front: failure === 'same-replacement' ? 'What does it delay?' : 'What does dormancy delay?', back: 'germination', text: '' });
    return reply({ verdicts: [{ ...keep, verdict: 'revise', reason: 'Name the subject.' }] });
  } });
  const card = f.first.cards[0]; card.front = 'What does it delay?';
  f.view.render();
  await f.verify('inbox').events.click();
  assert.equal(card.front, 'What does it delay?'); assert.equal(card.status, 'pending');
  assert.equal(f.second.cards[0].userCheck, undefined);
  assert.equal(f.other.cards[0].userCheck, undefined);
  assert.ok(f.requests.every(request => !request.includes('Heat increases evaporation.') && !request.includes('Roots absorb water.')));
  assert.deepEqual(f.revisions, []); assert.deepEqual(f.exports, []);
  assert.ok(notices.some(m => /check or repair failed/.test(m)));
  await tick(); assert.equal(f.verify('inbox').disabled, false);
});

test('Verify stops if the completed current target becomes hidden before the next source', async t => {
  const f = await fixture(t);
  f.second.sourcePath = 'roots.md'; f.view.render();
  const touch = f.host.store.touch;
  f.host.store.touch = () => { f.view.collapsed.add('seeds.md'); touch(); };
  await f.verify('inbox').events.click();
  assert.equal(f.requests.length, 1, 'Finishing a card must not renew the batch after its target was hidden');
});

for (const outcome of ['clean', 'repair', 'failure', 'editing-target']) test(`Verify preserves mounted unsaved editors on ${outcome}`, async t => {
  let calls = 0;
  const f = await fixture(t, outcome === 'failure' ? { onRequest: () => { throw Error('Synthetic failure'); } }
    : outcome === 'repair' ? { onRequest: user => {
      calls++;
      if (user.includes('Rewrite this one card.')) return reply({ kind: 'qa', front: 'Which process does dormancy delay?', back: 'germination', text: '' });
      return reply({ verdicts: [calls === 1 ? { ...keep, verdict: 'revise', reason: 'Clarify the question.' } : keep] });
    } } : {});
  const h = outcome === 'editing-target' ? f.first : f.other;
  const cardEl = f.root.querySelector(`.wikilm-card[data-id="${h.cards[0].id}"]`);
  buttons(cardEl).find(b => b.title === 'Edit (e)').events.click({ stopPropagation() {} });
  const editor = byClass(f.root, 'wikilm-editor');
  const question = nodes(editor).find(n => n['aria-label'] === 'Question');
  const instruction = nodes(editor).find(n => n['aria-label'] === 'Rewrite instruction');
  question.value = 'My unfinished wording'; instruction.value = 'My unfinished instruction';
  assert.ok(buttons(editor).some(b => b.text === 'Check'), 'Diagnostic editor Check stays');
  await f.verify('source').events.click();
  await tick();
  assert.equal(byClass(f.root, 'wikilm-editor'), editor);
  assert.equal(question.value, 'My unfinished wording'); assert.equal(instruction.value, 'My unfinished instruction');
  assert.notEqual(h.cards[0].front, question.value, 'The unsaved draft must not reach storage');
  assert.equal(f.requests.length, outcome === 'clean' ? 2 : outcome === 'repair' ? 4 : outcome === 'failure' ? 1 : 0);
  assert.equal(f.revisions.length, outcome === 'repair' ? 1 : 0); assert.deepEqual(f.exports, []);
});

for (const scope of ['inbox', 'source', 'passage']) for (const stage of [1, 2, 3]) for (const phase of ['rules', 'transport']) {
  for (const invalidation of ['settings', 'source', 'client', 'close']) test(`${scope} Verify revokes ${invalidation} at ${phase} stage ${stage}`, async t => {
    const gate = barrier();
    let reads = 0, dispatches = 0, reached = false;
    const pause = async () => { reached = true; await gate.promise; };
    const f = await fixture(t, {
      rules: async () => { if (++reads === stage && phase === 'rules') await pause(); return { cards: '' }; },
      onRequest: async user => {
        if (++dispatches === stage && phase === 'transport') await pause();
        if (user.includes('Rewrite this one card.')) return reply({ kind: 'qa', front: 'What does dormancy delay?', back: 'germination', text: '' });
        return reply({ verdicts: [dispatches === 1 ? { ...keep, verdict: 'revise', reason: 'Name the subject.' } : keep] });
      },
    });
    const card = f.first.cards[0]; card.front = 'What does it delay?'; f.view.render();
    const run = f.verify(scope).events.click();
    await until(() => reached);
    if (invalidation === 'settings') f.settings.writerInstructions = 'Changed instructions';
    else if (invalidation === 'source') f.first.text = 'Changed captured source';
    else if (invalidation === 'client') await f.host.llm.abort();
    else await f.view.onClose();
    const expected = structuredClone(card);
    gate.release(); await run;
    assert.equal(f.requests.length, phase === 'rules' ? stage - 1 : stage, 'No dispatch or retry may renew a revoked request');
    assert.deepEqual(card, expected, 'A revoked result must not replace the current original');
    assert.equal(f.second.cards[0].userCheck, undefined);
    assert.deepEqual(f.revisions, []); assert.deepEqual(f.exports, []);
  });
}

test('Verify keeps the shared per-card lock while an individual star is clicked', async t => {
  const gate = barrier(); let reached = false;
  const f = await fixture(t, { rules: async () => { reached = true; await gate.promise; return { cards: '' }; } });
  const run = f.verify('passage').events.click(); await until(() => reached);
  const card = f.root.querySelector(`.wikilm-card[data-id="${f.first.cards[0].id}"]`);
  buttons(card).find(b => b.title === 'Check card against best practices (repair issues)').events.click({ stopPropagation() {} });
  await tick(); gate.release(); await run;
  assert.equal(f.requests.length, 1); assert.deepEqual(f.revisions, []);
});

test('Verify action rows can wrap in narrow panes', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  for (const selector of ['wikilm-source-actions', 'wikilm-hl-actions']) {
    const rule = css.match(new RegExp(`\\.${selector}\\s*\\{([^}]+)\\}`))[1];
    assert.match(rule, /display:\s*flex/);
    assert.match(rule, /flex-wrap:\s*wrap/);
  }
});

test('Inbox Verify checks visible drafts through the real client without exporting', async t => {
  const f = await fixture(t);
  const originals = f.highlights.map(h => h.cards[0].front);
  await f.verify('inbox').events.click();
  assert.equal(f.requests.length, 3);
  assert.deepEqual(f.highlights.map(h => h.cards[0].userCheck?.issues), [[], [], []]);
  assert.deepEqual(f.highlights.map(h => h.cards[0].front), originals);
  assert.deepEqual(f.revisions, []);
  assert.deepEqual(f.exports, []);
});
