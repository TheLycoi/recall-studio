import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { z } from 'zod';
import { loadQuiz, element, nodes } from './quizHarness.mjs';

let InboxView, LlmClient, makeHighlight, makeCard, cardContent;
before(async () => {
  ({ InboxView } = await loadQuiz('src/inboxView.ts', { Notice: class { hide() {} } }));
  ({ makeHighlight, makeCard } = await loadQuiz('src/model.ts'));
  ({ cardContent } = await loadQuiz('src/cardActions.ts'));
});
const revised = { kind: 'qa', front: 'What does dormancy delay?', back: 'germination', text: '' };
const verdict = (keep) => ({ verdicts: [{ index: 0, verdict: keep ? 'keep' : 'revise', reason: keep ? '' : 'Name the subject.', bloom: 'remember', kind: 'qa', front: '', back: '', text: '' }] });
const response = value => ({ status: 200, json: { choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] } });
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Expected the pending operation to reach its barrier');
}
async function fixture({ stage = 1, knownIssue = true, onRequest = (_user, value) => response(value) } = {}) {
  const settings = { provider: 'deepseek', deepseekApiKey: 'synthetic-test-key', deepseekModel: 'synthetic-model', effort: 'low', language: '', writerInstructions: '', historyExamples: false, schemaFolder: 'rules', lintMode: 'badge', schemaLearning: false };
  const h = makeHighlight({ sourcePath: 'sources/seeds.md', sourceTitle: 'Seeds', text: 'Dormancy delays germination.', status: 'ready' });
  const c = makeCard(h.id, { kind: 'qa', front: 'What does it delay?', back: 'germination' });
  h.cards = [c];
  if (knownIssue) c.userCheck = { content: cardContent(c, h), at: 'synthetic', issues: ['Name the subject.'] };
  const requests = [], revisions = [], highlights = [h];
  ({ LlmClient } = await loadQuiz('src/llm.ts', { requestUrl: async req => {
    const user = JSON.parse(req.body).messages[1].content;
    requests.push(user);
    return onRequest(user, user.includes('Rewrite this one card.') ? revised : verdict(user.includes(revised.front)));
  } }));
  let release, reads = 0;
  const llm = new LlmClient(() => settings, () => [], async () => {
    if (++reads === stage) return new Promise(resolve => { release = resolve; });
    return { cards: '' };
  });
  const root = element();
  const host = { app: { vault: { getFiles: () => [], configDir: '.obsidian' }, workspace: {}, metadataCache: {} }, settings, llm, store: { all: () => highlights, onChange: () => () => {}, findCard: id => h.cards.find(card => card.id === id) ? { highlight: h, card: h.cards.find(card => card.id === id) } : undefined, touch() {}, recordRevision: revision => revisions.push(revision) } };
  const view = new InboxView({ contentEl: root }, host);
  const click = () => {
    view.renderCard(root, h, c);
    const star = nodes(root).find(n => /Check card against best practices/.test(n.title ?? ''));
    assert.ok(star, 'The rendered card must expose its repair star');
    star.events.click({ stopPropagation() {} });
  };
  return { settings, h, c, root, host, view, llm, requests, revisions, highlights, click, pending: () => !!release, release: () => release({ cards: '' }) };
}

for (const invalidation of ['settings', 'view-close']) test(`rendered star does not disclose source after ${invalidation} during rewrite rules`, async () => {
  const f = await fixture();
  const original = structuredClone(f.c);
  f.click();
  await until(f.pending);
  if (invalidation === 'settings') f.settings.schemaFolder = 'sources';
  else await f.view.onClose();
  f.release();
  await until(() => f.view.checking.size === 0);
  assert.deepEqual(f.requests, [], 'Cancelled repair must not transmit source text');
  assert.deepEqual(f.c, original);
  assert.deepEqual(f.revisions, []);
});

const invalidations = {
  settings: f => { f.settings.schemaFolder = 'sources'; },
  'view-close': f => f.view.onClose(),
  'view-reopen': async f => { await f.view.onClose(); f.view.render = () => {}; await f.view.onOpen(); },
  'client-abort': f => f.llm.abort(),
  'card-edit': f => { f.c.front = 'My newer question'; },
  'source-edit': f => { f.h.text = 'Changed source'; },
  'source-rename': f => { f.h.sourcePath = 'renamed.md'; },
  'sibling-edit': f => { f.h.cards.push(makeCard(f.h.id, { kind: 'qa', front: 'Where are seeds stored?', back: 'seed bank' })); },
  'card-status': f => { f.c.status = 'approved'; },
  archive: f => { f.h.archived = true; },
  delete: f => { f.c.status = 'deleted'; },
  dismiss: f => { f.h.status = 'dismissed'; },
  'card-remove': f => { f.h.cards = []; },
  'source-remove': f => { f.highlights.length = 0; },
};
for (const stage of [1, 2, 3]) for (const [name, revoke] of Object.entries(invalidations)) {
  test(`rendered star revokes stage ${stage} on ${name} before rules resolve`, async () => {
    const f = await fixture({ stage, knownIssue: false });
    f.click();
    await until(f.pending);
    assert.equal(f.requests.length, stage - 1);
    await revoke(f);
    const expected = structuredClone(f.c);
    f.release();
    await until(() => f.view.checking.size === 0);
    assert.equal(f.requests.length, stage - 1, 'No later source-bearing dispatch is authorized');
    assert.deepEqual(f.c, expected, 'Cancellation must preserve the current original');
    assert.deepEqual(f.revisions, []);
  });
}

test('authorized rendered star completes check, rewrite and replacement check with one repair revision', async () => {
  const f = await fixture({ stage: 0, knownIssue: false });
  f.click();
  await until(() => f.view.checking.size === 0);
  assert.equal(f.requests.length, 3);
  assert.equal(f.c.front, revised.front);
  assert.deepEqual(f.c.userCheck.issues, []);
  assert.equal(f.revisions.length, 1);
  assert.equal(f.revisions[0].via, 'repair');
  assert.equal(f.revisions[0].before.front, 'What does it delay?');
});

// Intercept at HTTP and child-process boundaries, never provider credentials or binaries.
async function providerFixture(provider, { prepare = () => {}, reply = () => ({ ready: true }) } = {}) {
  const dispatches = [];
  const settings = { provider, codexPath: '/synthetic/codex', codexModel: 'synthetic-model', opencodePath: '/synthetic/opencode', opencodeModel: 'synthetic/model', deepseekApiKey: 'synthetic-test-key', deepseekModel: 'synthetic-model', effort: 'low' };
  const out = await build({ entryPoints: [`src/${provider}.ts`], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['obsidian'], logLevel: 'silent' });
  const mod = new Module('intercepted-provider');
  const fs = { constants: { X_OK: 1 }, accessSync() {}, readFileSync: () => null, mkdtempSync: () => '/synthetic/scratch', mkdirSync() {}, writeFileSync() { prepare(); }, rmSync() {} };
  const childProcess = {
    execFile() { assert.fail('No external utility is permitted'); },
    execFileSync() { assert.fail('No keychain access is permitted'); },
    spawn(_bin, args) {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new EventEmitter();
      const dispatch = { args, prompt: '' }; dispatches.push(dispatch);
      child.stdin.end = prompt => {
        dispatch.prompt = prompt;
        const value = JSON.stringify(reply());
        const event = provider === 'codex' ? { type: 'item.completed', item: { type: 'agent_message', text: value } } : { type: 'text', part: { type: 'text', text: value } };
        setImmediate(() => { child.stdout.write(JSON.stringify(event)); child.emit('close', 0, null); });
      };
      child.kill = () => true;
      return child;
    },
  };
  mod.require = id => id === 'fs' ? fs : id === 'child_process' ? childProcess : id === 'obsidian' ? { requestUrl: async req => {
    dispatches.push(req); return response(reply());
  } } : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text, 'intercepted-provider');
  const Backend = mod.exports[{ codex: 'CodexBackend', deepseek: 'DeepSeekBackend', opencode: 'OpenCodeBackend' }[provider]];
  const backend = new Backend(() => { if (provider === 'deepseek') prepare(); return settings; });
  return { backend, dispatches };
}
const request = authorized => ({ system: 'Return JSON.', user: 'Private captured source.', schema: z.object({ ready: z.boolean() }), label: 'test', maxTokens: 20, authorized });
for (const provider of ['codex', 'deepseek', 'opencode']) {
  test(`${provider} rejects revoked requests at the real transport boundary`, async () => {
    const f = await providerFixture(provider);
    await assert.rejects(f.backend.complete(request(() => false)), /authorization expired/i);
    assert.deepEqual(f.dispatches, []);
  });
  test(`${provider} rechecks after backend preparation, before HTTP or spawn`, async () => {
    let allowed = true;
    const f = await providerFixture(provider, { prepare: () => { allowed = false; } });
    await assert.rejects(f.backend.complete(request(() => allowed)), /authorization expired/i);
    assert.deepEqual(f.dispatches, []);
  });
  test(`${provider} still sends an authorized structured request`, async () => {
    const f = await providerFixture(provider);
    assert.deepEqual(await f.backend.complete(request(() => true)), { ready: true });
    assert.equal(f.dispatches.length, 1);
  });
  test(`${provider} preserves ordinary callers without an authorization predicate`, async () => {
    const f = await providerFixture(provider);
    assert.deepEqual(await f.backend.complete(request()), { ready: true });
    assert.equal(f.dispatches.length, 1);
  });
}

for (const invalid of ['', 'not JSON']) test(`DeepSeek does not retry ${JSON.stringify(invalid)} after revocation`, async () => {
  let allowed = true, calls = 0;
  const { DeepSeekBackend } = await loadQuiz('src/deepseek.ts', { requestUrl: async () => {
    calls++; allowed = false;
    return { status: 200, json: { choices: [{ message: { content: invalid }, finish_reason: 'stop' }] } };
  } });
  const backend = new DeepSeekBackend(() => ({ deepseekApiKey: 'synthetic-test-key', deepseekModel: 'synthetic-model', effort: 'low' }));
  await assert.rejects(backend.complete(request(() => allowed)));
  assert.equal(calls, 1, 'Revoked source must not be sent in a parsing retry');
});

for (const stage of [1, 2, 3]) {
  test(`rendered star authorization reaches backend preparation at stage ${stage}`, async () => {
    const f = await fixture({ stage: 0, knownIssue: false });
    let preparations = 0;
    f.llm.deepseek.key = () => {
      if (++preparations === stage) f.settings.schemaFolder = 'sources';
      return { key: 'synthetic-test-key', source: 'settings' };
    };
    f.click();
    await until(() => f.view.checking.size === 0);
    assert.equal(f.requests.length, stage - 1);
    assert.equal(f.c.front, 'What does it delay?');
    assert.deepEqual(f.revisions, []);
  });
  for (const invalid of ['', 'not JSON']) test(`rendered star revokes parsing retry at stage ${stage} for ${JSON.stringify(invalid)}`, async () => {
    let f;
    f = await fixture({ stage: 0, knownIssue: false, onRequest: (_user, value) => {
      if (f.requests.length === stage) {
        f.settings.schemaFolder = 'sources';
        return { status: 200, json: { choices: [{ message: { content: invalid }, finish_reason: 'stop' }] } };
      }
      return response(value);
    } });
    f.click();
    await until(() => f.view.checking.size === 0);
    assert.equal(f.requests.length, stage, 'Cancellation must reach provider-internal retries');
    assert.equal(f.c.front, 'What does it delay?');
    assert.deepEqual(f.revisions, []);
  });
}

function clickBatch(f) {
  f.h.cards.push(makeCard(f.h.id, { kind: 'qa', front: 'Which organisms use dormancy?', back: 'seeds' }));
  f.view.renderHighlight(f.root, f.h);
  const star = nodes(f.root).find(n => n.title === 'Check cards against best practices (repair issues)');
  assert.ok(star, 'The rendered passage must expose its batch repair star');
  return star.events.click();
}
for (const stage of [1, 2, 3]) for (const [name, revoke] of Object.entries(invalidations)) {
  test(`batch stops without later disclosure when stage ${stage} is revoked by ${name}`, async () => {
    const f = await fixture({ stage, knownIssue: false });
    const run = clickBatch(f);
    await until(f.pending);
    await revoke(f);
    const expected = structuredClone(f.c);
    f.release();
    await run;
    assert.equal(f.requests.length, stage - 1, 'The next card cannot silently renew a cancelled batch');
    assert.deepEqual(f.c, expected);
    assert.deepEqual(f.revisions, []);
  });
}
test('authorized batch repairs its flawed card and checks the next card', async () => {
  const f = await fixture({ stage: 0, knownIssue: false });
  await clickBatch(f);
  assert.equal(f.requests.length, 4);
  assert.equal(f.c.front, revised.front);
  assert.equal(f.revisions.length, 1);
  assert.deepEqual(f.h.cards[1].userCheck.issues, []);
});

function editorElement() {
  const extend = el => {
    el.show = el.hide = el.toggle = () => {};
    const create = el.createEl;
    el.createEl = function (...args) { return extend(create.apply(this, args)); };
    return el;
  };
  return extend(element());
}
for (const [name, revoke] of Object.entries(invalidations)) {
  test(`rendered editor check does not disclose source after ${name}`, async () => {
    const f = await fixture({ knownIssue: false });
    const root = editorElement();
    const previousWindow = globalThis.window;
    globalThis.window = { setTimeout() {} };
    try { f.view.editing = f.c.id; f.view.renderEditor(root, f.h, f.c); }
    finally { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
    const button = nodes(root).find(n => n.text === 'Check');
    assert.ok(button);
    button.events.click();
    await until(f.pending);
    await revoke(f);
    const expected = structuredClone(f.c);
    f.release();
    await until(() => !button.disabled);
    assert.deepEqual(f.requests, []);
    assert.deepEqual(f.c, expected);
    assert.deepEqual(f.revisions, []);
  });
}

test('a pending batch cannot renew settings authorization between cards', async () => {
  const f = await fixture({ stage: 0, knownIssue: false });
  f.host.store.touch = () => { f.settings.schemaFolder = 'sources'; };
  await clickBatch(f);
  assert.equal(f.requests.length, 3, 'Only the already authorized first repair may be sent');
  assert.equal(f.revisions.length, 1);
});

for (const authorized of [undefined, () => true]) for (const invalid of ['', 'not JSON']) {
  test(`DeepSeek retains its single parsing retry for ${authorized ? 'authorized' : 'ordinary'} callers with ${JSON.stringify(invalid)}`, async () => {
    let calls = 0;
    const { DeepSeekBackend } = await loadQuiz('src/deepseek.ts', { requestUrl: async () => {
      if (++calls > 1) return response({ ready: true });
      return { status: 200, json: { choices: [{ message: { content: invalid }, finish_reason: 'stop' }] } };
    } });
    const backend = new DeepSeekBackend(() => ({ deepseekApiKey: 'synthetic-test-key', deepseekModel: 'synthetic-model', effort: 'low' }));
    assert.deepEqual(await backend.complete(request(authorized)), { ready: true });
    assert.equal(calls, 2);
  });
}
