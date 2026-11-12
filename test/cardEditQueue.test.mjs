import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';

let CardEditQueue, InboxStore, makeHighlight, makeCard, parseInboxJson;
const turn = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(check) { for (let i = 0; i < 200 && !check(); i++) await turn(); assert.ok(check(), 'reached barrier'); }
const answer = { kind: 'qa', front: 'What process does dormancy delay?', back: 'germination', text: '' };
before(async () => {
  globalThis.window = { setTimeout() { return 1; }, clearTimeout() {} };
  const output = await build({ stdin: { contents: `export { CardEditQueue } from './src/cardEditQueue'; export { InboxStore } from './src/store'; export { makeHighlight, makeCard } from './src/model'; export { parseInboxJson } from './src/inboxData';`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'], logLevel: 'silent' });
  const m = new Module('edit-queue');
  m.require = id => id === 'obsidian' ? { Notice: class { hide() {} }, normalizePath: p => p } : Module.createRequire(import.meta.url)(id);
  m._compile(output.outputFiles[0].text, 'edit-queue');
  ({ CardEditQueue, InboxStore, makeHighlight, makeCard, parseInboxJson } = m.exports);
});
async function fixture() {
  const files = new Map(), calls = [];
  let failWrite = false, pausedWrite, hold, busy = 0, maxBusy = 0;
  const adapter = {
    exists: async p => files.has(p), mkdir: async () => {}, read: async p => files.get(p),
    write: async (p, bytes) => { if (pausedWrite) await pausedWrite.promise; if (failWrite) throw Error('Synthetic disk full'); files.set(p, bytes); },
    rename: async (a, b) => { assert.ok(!files.has(b), 'rename never overwrites'); assert.ok(files.has(a)); files.set(b, files.get(a)); files.delete(a); },
    remove: async p => files.delete(p),
  };
  const app = { vault: { adapter } }, store = new InboxStore(app, 'queue-data'); await store.load();
  const h = makeHighlight({ sourcePath: 'seeds.md', sourceTitle: 'Seeds', text: 'Dormancy delays germination.', status: 'ready' });
  const c = makeCard(h.id, { kind: 'qa', front: 'What does dormancy delay?', back: 'germination' }); h.cards.push(c); store.add(h); await store.flush();
  const host = { store, settings: { language: 'English', apiKey: 'priva...ker' }, llm: {
    requestAuthorization: fn => { let revoked = false; return () => !revoked && (fn() || !(revoked = true)); },
    rewriteCards: async (source, card, instruction, current) => {
      assert.ok(current());
      const persisted = JSON.parse(files.get('queue-data/inbox.json'));
      assert.ok(persisted.cardEdits.some(r => r.instruction === instruction && r.state === 'running'), 'durable request before disclosure');
      calls.push({ source, card, instruction }); busy++; maxBusy = Math.max(busy, maxBusy);
      try { if (hold) await hold.promise; assert.ok(current(), 'request still authorized'); return [{ ...answer }]; }
      finally { busy--; }
    },
  } };
  const queue = new CardEditQueue(host);
  return { files, app, store, h, c, host, queue, calls, maxBusy: () => maxBusy,
    hold: () => hold = gate(), failWrite: value => { failWrite = value; }, pauseWrites: () => pausedWrite = gate(),
    persisted: () => JSON.parse(files.get('queue-data/inbox.json')) };
}

test('duplicate clicks share one durable request and one provider call', async () => {
  const f = await fixture(), hold = f.hold();
  const one = f.queue.enqueue(f.h, f.c, 'Clarify the question', () => true);
  await until(() => f.calls.length === 1);
  const two = f.queue.enqueue(f.h, f.c, 'Clarify the question', () => true);
  hold.resolve(); await Promise.all([one, two]); await f.queue.idle();
  assert.equal(f.queue.items.length, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.persisted().cardEdits[0].state, 'completed');
  assert.equal(f.persisted().revisions.length, 1);
  assert.ok(!JSON.stringify(f.persisted()).includes('private-synthetic-marker'));
  f.store.close();
});

test('requests submitted behind a running edit are durable before that edit finishes', async () => {
  const f = await fixture(), hold = f.hold();
  const one = f.queue.enqueue(f.h, f.c, 'First request', () => true);
  await until(() => f.calls.length === 1);
  const two = f.queue.enqueue(f.h, f.c, 'Second request', () => true);
  for (let i = 0; i < 20; i++) await turn();
  const saved = f.persisted().cardEdits.map(r => r.instruction);
  hold.resolve(); await Promise.all([one, two]); await f.queue.idle(); f.store.close();
  assert.deepEqual(saved, ['First request', 'Second request'], 'A long-running model must not delay saving the next instruction');
});

test('restart retains queued and running requests without replaying model calls', async () => {
  const f = await fixture(), hold = f.hold();
  const one = f.queue.enqueue(f.h, f.c, 'Running instruction', () => true); await until(() => f.calls.length === 1);
  const two = f.queue.enqueue(f.h, f.c, 'Waiting instruction', () => true); await until(() => f.persisted().cardEdits.length === 2);
  const crash = new Map(f.files);
  const stopping = f.queue.stop(); hold.resolve(); await Promise.all([one, two, stopping]); await f.store.flush(); f.store.close();
  f.files.clear(); for (const [p, raw] of crash) f.files.set(p, raw);
  const store = new InboxStore(f.app, 'queue-data'); await store.load();
  let calls = 0;
  const queue = new CardEditQueue({ ...f.host, store, llm: { ...f.host.llm, rewriteCards: async () => { calls++; return [answer]; } } });
  await queue.idle(); await store.flush();
  assert.equal(calls, 0);
  assert.deepEqual(queue.items.map(r => [r.instruction, r.state]), [['Running instruction', 'interrupted'], ['Waiting instruction', 'interrupted']]);
  assert.equal(store.revisions().length, 0);
  await queue.retry(queue.items[0].id, () => true); await queue.idle();
  assert.equal(calls, 1); assert.equal(queue.items[0].state, 'completed'); assert.equal(queue.items[1].state, 'interrupted');
  store.close();
});

for (const stage of ['enqueue', 'completion']) test(`failed ${stage} save does not lose requests or repeat completed work`, async () => {
  const f = await fixture(), hold = f.hold();
  if (stage === 'enqueue') f.failWrite(true);
  const run = f.queue.enqueue(f.h, f.c, 'Keep my instruction', () => true);
  if (stage === 'completion') { await until(() => f.calls.length === 1); f.failWrite(true); }
  hold.resolve(); await run; await f.queue.idle();
  assert.equal(f.queue.saveError, true);
  assert.equal(f.queue.items[0].instruction, 'Keep my instruction');
  assert.equal(f.calls.length, stage === 'enqueue' ? 0 : 1);
  f.failWrite(false); await f.queue.save();
  assert.equal(f.queue.saveError, false);
  assert.equal(f.persisted().cardEdits[0].state, stage === 'enqueue' ? 'interrupted' : 'completed');
  assert.equal(f.persisted().revisions?.length ?? 0, stage === 'enqueue' ? 0 : 1);
  assert.equal(f.calls.length, stage === 'enqueue' ? 0 : 1);
  f.store.close();
});

for (const stage of ['queued', 'running']) test(`cancelling a ${stage} edit preserves its instruction and the original`, async () => {
  const f = await fixture(), hold = f.hold(), original = structuredClone(f.c);
  const one = f.queue.enqueue(f.h, f.c, 'First request', () => true); await until(() => f.calls.length === 1);
  const two = f.queue.enqueue(f.h, f.c, 'Second request', () => true); await until(() => f.persisted().cardEdits.length === 2);
  await f.queue.cancel(f.queue.items[stage === 'running' ? 0 : 1].id);
  if (stage === 'running') await f.queue.cancel(f.queue.items[1].id);
  hold.resolve(); await Promise.all([one, two]); await f.queue.idle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.persisted().cardEdits[1].state, 'cancelled');
  assert.equal(f.persisted().cardEdits[1].instruction, 'Second request');
  if (stage === 'running') { assert.deepEqual(f.c, original); assert.equal(f.store.revisions().length, 0); }
  await f.queue.clearFinished(); assert.equal(f.queue.items.length, 0); f.store.close();
});

for (const invalidate of [f => { f.h.text = 'Different source'; }, f => { f.host.settings.language = 'French'; }, f => { f.c.status = 'deleted'; }]) {
  test('a stale queued edit stays visible without reaching the writer', async () => {
    const f = await fixture(), hold = f.hold();
    const one = f.queue.enqueue(f.h, f.c, 'First request', () => true); await until(() => f.calls.length === 1);
    const two = f.queue.enqueue(f.h, f.c, 'Second request', () => true); await until(() => f.persisted().cardEdits.length === 2);
    invalidate(f); const expected = structuredClone(f.h);
    hold.resolve(); await Promise.all([one, two]); await f.queue.idle();
    assert.equal(f.calls.length, 1); assert.deepEqual(f.h, expected);
    assert.deepEqual(f.queue.items.map(r => r.state), ['failed', 'failed']);
    f.store.close();
  });
}

test('queue validation refuses malformed state and duplicate request IDs without dropping legacy fields', async () => {
  const f = await fixture(); await f.queue.enqueue(f.h, f.c, 'Edit', () => true); await f.queue.idle();
  const snapshot = f.persisted(); snapshot.retainedLegacy = { untouched: true };
  assert.deepEqual(parseInboxJson(JSON.stringify(snapshot)).data.retainedLegacy, { untouched: true });
  for (const mutate of [d => { d.cardEdits[0].state = 'unknown'; }, d => { d.cardEdits[0].instruction = null; }, d => { d.cardEdits.push(d.cardEdits[0]); }, d => { d.cardEdits[0].sourceKey = 'guess'; }]) {
    const invalid = structuredClone(snapshot); mutate(invalid); assert.equal(parseInboxJson(JSON.stringify(invalid)).ok, false);
  }
  f.store.close();
});

test('100 unresolved requests are retained and overflow is refused rather than evicting old requests', async () => {
  const f = await fixture(), hold = f.hold(), requests = [];
  requests.push(f.queue.enqueue(f.h, f.c, 'Request 0', () => true)); await until(() => f.calls.length === 1);
  for (let i = 1; i < 100; i++) requests.push(f.queue.enqueue(f.h, f.c, `Request ${i}`, () => true));
  await assert.rejects(f.queue.enqueue(f.h, f.c, 'Overflow', () => true), /full/);
  const count = f.queue.items.length, first = f.queue.items[0].instruction;
  const stop = f.queue.stop(); hold.resolve(); await Promise.all([...requests, stop]); await f.store.flush();
  assert.equal(count, 100); assert.equal(first, 'Request 0');
  assert.equal(f.persisted().cardEdits.length, 100); assert.equal(f.calls.length, 1);
  assert.ok(f.queue.items.every(r => r.state === 'interrupted'));
  f.store.close();
});

test('different cards share one FIFO worker and keep their own instructions', async () => {
  const f = await fixture(), hold = f.hold();
  const other = makeHighlight({ sourcePath: 'another.md', sourceTitle: 'Another seed', text: f.h.text, status: 'ready' });
  const card = makeCard(other.id, { kind: 'qa', front: 'Which process is delayed by dormancy?', back: 'germination' }); other.cards.push(card); f.store.add(other);
  const one = f.queue.enqueue(f.h, f.c, 'First card instruction', () => true); await until(() => f.calls.length === 1);
  const two = f.queue.enqueue(other, card, 'Other card instruction', () => true); await until(() => f.persisted().cardEdits.length === 2);
  assert.equal(f.calls.length, 1); hold.resolve(); await Promise.all([one, two]); await f.queue.idle();
  assert.deepEqual(f.calls.map(c => [c.card.id, c.instruction]), [[f.c.id, 'First card instruction'], [card.id, 'Other card instruction']]);
  assert.equal(f.maxBusy(), 1); assert.deepEqual(f.queue.items.map(r => r.state), ['completed', 'completed']);
  assert.equal(f.persisted().revisions.length, 2); f.store.close();
});
