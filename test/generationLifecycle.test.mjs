import { auditVerdict } from './auditFixture.mjs';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';

let RecallPlugin, InboxStore, Generator, LlmClient, makeHighlight;
const notices = [];
const root = fileURLToPath(new URL('../', import.meta.url));
before(async () => {
  globalThis.window ??= globalThis;
  const out = await build({
    stdin: { contents: `export {default as RecallPlugin} from './src/main'; export {InboxStore} from './src/store'; export {Generator} from './src/generator'; export {LlmClient} from './src/llm'; export {makeHighlight} from './src/model';`, resolveDir: root },
    bundle: true, write: false, format: 'cjs', platform: 'node',
    external: ['obsidian', '@codemirror/view'], logLevel: 'silent',
  });
  const obsidian = new Proxy({ Notice: class { constructor(message) { notices.push(message); } }, normalizePath: p => p, editorInfoField: {} }, { get: (o, k) => k in o ? o[k] : class {} });
  const cm = { WidgetType: class {}, Decoration: { none: [], widget: () => ({ range: () => ({ from: 0 }) }), set: xs => xs }, ViewPlugin: { fromClass: c => c } };
  const m = new Module('generation-lifecycle');
  m.require = id => id === 'obsidian' ? obsidian : id === '@codemirror/view' ? cm : Module.createRequire(import.meta.url)(id);
  m._compile(out.outputFiles[0].text, 'generation-lifecycle');
  ({ RecallPlugin, InboxStore, Generator, LlmClient, makeHighlight } = m.exports);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const preparation = {
  facts: [{ id: 'F1', statement: 'Amber stores heat.', quote: 'Amber stores heat.' }],
  plan: [{ id: 'P1', factIds: ['F1'], entity: 'Amber', aspect: '', value: 'stores heat', reason: 'Stated property' }],
  exclusions: [], omissions: [], conflicts: [],
};
async function fixture() {
  const files = new Map(), dirs = new Set(['study']);
  const adapter = {
    async exists(p) { return files.has(p) || dirs.has(p); },
    async mkdir(p) { dirs.add(p); },
    async read(p) { assert.ok(files.has(p), `missing ${p}`); return files.get(p); },
    async write(p, text) { files.set(p, text); },
    async rename(from, to) { assert.ok(files.has(from)); assert.equal(files.has(to), false, 'Obsidian refuses overwrite rename'); files.set(to, files.get(from)); files.delete(from); },
    async remove(p) { assert.ok(files.delete(p)); },
  };
  const app = { vault: { adapter } }, store = new InboxStore(app, 'study');
  await store.load();
  const h = makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Synthetic', text: 'Amber stores heat.' });
  store.add(h);
  const settings = { provider: 'codex', codexModel: 'synthetic', writerInstructions: '', language: '', critiquePass: true, historyExamples: false, lintMode: 'badge', concurrency: 1, notifyWhenReady: false };
  const calls = [], llm = new LlmClient(() => settings);
  llm.codex = { async complete(req) {
    calls.push(req.label);
    const user = JSON.parse(req.user);
    return req.schema.parse(req.label === 'preparation' ? preparation : req.label === 'grounded cards' ? { cards: [{ planId: 'P1', factIds: ['F1'], kind: 'qa', front: 'What does Amber store?', back: 'heat', text: '' }] } : { verdicts: [auditVerdict(user.cards[0], { index: 0, cardId: user.cards[0].id, status: 'verified', reason: 'Supported' })] });
  } };
  llm.abort = async () => {};
  const plugin = new RecallPlugin();
  Object.assign(plugin, { store, settings, llm, refreshStatusBar() {} });
  const g = plugin.generator = new Generator(plugin);
  return { files, adapter, app, store, h, calls, llm, plugin, g };
}

test('public queue unload persists rollback at a renamed source before closing and restart', async () => {
  const f = await fixture(), atWrite = deferred(), release = deferred(), atAbort = deferred();
  const write = f.adapter.write;
  let paused = false, running, reloaded;
  f.adapter.write = async (path, text) => {
    if (!paused && JSON.parse(text).highlights[0]?.generation?.committed) {
      paused = true;
      atWrite.resolve();
      await release.promise;
    }
    await write(path, text);
  };
  f.llm.abort = async () => { atAbort.resolve(); };
  const run = f.g.run.bind(f.g);
  f.g.run = (...args) => (running = run(...args));
  try {
    f.g.enqueue(f.h);
    await atWrite.promise;
    assert.equal(f.g.running.size, 1);
    assert.equal(f.store.moveSource('synthetic.md', 'renamed.md'), 1);
    const unloading = f.plugin.onunload();
    assert.equal(f.plugin.onunload(), unloading, 'active unload must share the same drain and final save');
    await atAbort.promise;
    release.resolve();
    await Promise.all([running, unloading]);
    assert.equal(f.h.cards.length, 0);
    assert.equal(f.h.generation.committed, false);
    assert.equal(f.h.status, 'queued');
    const disk = JSON.parse(f.files.get(f.store.filePath)).highlights[0];
    assert.equal(disk.cards.length, 0, 'cancelled cards must not survive the final unload snapshot');
    assert.equal(disk.generation.committed, false);
    assert.equal(disk.status, 'queued');
    assert.equal(disk.sourcePath, 'renamed.md');
    assert.deepEqual(disk, JSON.parse(JSON.stringify(f.h)));
    assert.equal(f.store.hasUnsavedChanges, false);
    assert.equal(f.store.closed, true);
    reloaded = new InboxStore(f.app, 'study');
    await reloaded.load();
    assert.deepEqual(reloaded.all(), [disk]);
    assert.deepEqual(f.calls, ['preparation', 'grounded cards', 'audit']);
  } finally {
    release.resolve();
    if (running) await running;
    f.store.close();
    reloaded?.close();
  }
});

test('idle stop and repeated unload perform cleanup and final persistence only once', async () => {
  const f = await fixture(), calls = [];
  const flush = f.store.flush.bind(f.store), close = f.store.close.bind(f.store);
  f.llm.abort = async () => { calls.push('abort'); };
  f.store.flush = async () => { calls.push('flush'); await flush(); };
  f.store.close = () => { calls.push('close'); close(); };
  try {
    await f.g.stop();
    await f.g.stop();
    await Promise.all([f.plugin.onunload(), f.plugin.onunload()]);
    await f.plugin.onunload();
    assert.deepEqual(calls, ['abort', 'flush', 'close']);
    assert.equal(f.store.hasUnsavedChanges, false);
    assert.deepEqual(f.calls, []);
    assert.equal(f.g.running.size, 0);
  } finally { close(); }
});

test('unexpected queue rejection is observed and does not leave an unhandled cleanup promise', async () => {
  const f = await fixture(), logged = deferred(), errors = [], error = console.error;
  console.error = (...args) => { errors.push(args); logged.resolve(); };
  const unsubscribe = f.store.onChange(() => {
    if (f.h.status === 'generating') throw Error('synthetic listener failure');
  });
  try {
    f.g.enqueue(f.h);
    await logged.promise;
    await f.g.stop();
    assert.ok(errors.some(args => args.length === 1 && args[0] === 'Recall Studio: generation failed'));
    assert.ok(errors.every(args => !JSON.stringify(args).includes('synthetic listener failure')));
    assert.equal(f.g.running.size, 0);
    assert.equal(f.g.pending.size, 0);
    await f.plugin.onunload();
    assert.equal(f.store.closed, true);
  } finally {
    unsubscribe();
    f.store.close();
    console.error = error;
  }
});

for (const abortFails of [false, true]) {
  test(`unload drains every running job before flushing, including when abort ${abortFails ? 'rejects' : 'returns before providers settle'}`, async () => {
    const f = await fixture(), atBoth = deferred(), gates = [deferred(), deferred()], runs = [];
    f.plugin.settings.concurrency = 2;
    const second = makeHighlight({ sourcePath: 'second.md', sourceTitle: 'Second', text: f.h.text });
    f.store.add(second);
    const complete = f.llm.codex.complete;
    let entered = 0, flushes = 0;
    f.llm.codex.complete = async req => {
      if (req.label === 'preparation') {
        const gate = gates[entered++];
        if (entered === 2) atBoth.resolve();
        await gate.promise;
      }
      return complete(req);
    };
    const run = f.g.run.bind(f.g), flush = f.store.flush.bind(f.store);
    f.g.run = (...args) => { const promise = run(...args); runs.push(promise); return promise; };
    f.store.flush = () => { flushes++; return flush(); };
    f.llm.abort = async () => {
      gates[0].reject(Error('provider cancelled'));
      if (abortFails) throw Error('abort failed');
    };
    try {
      f.g.enqueue(f.h);
      await atBoth.promise;
      const third = makeHighlight({ sourcePath: 'third.md', sourceTitle: 'Third', text: f.h.text });
      f.store.add(third);
      f.g.enqueue(third);
      const beforeUnload = flushes;
      const outcome = f.plugin.onunload().then(() => null, e => e);
      let drained = false;
      const stopping = f.g.stop().then(() => { drained = true; });
      await runs[0];
      assert.equal(drained, false, 'the second provider has not settled');
      assert.equal(f.store.closed, false);
      assert.equal(flushes, beforeUnload, 'no final snapshot before all run continuations finish');
      assert.equal(runs.length, 2, 'the third queued capture must not start during unload');
      gates[1].reject(Error('second provider cancelled'));
      await stopping;
      const failure = await outcome;
      if (abortFails) assert.match(failure.message, /abort failed/);
      else assert.equal(failure, null);
      assert.equal(f.store.closed, true);
      assert.equal(f.store.hasUnsavedChanges, false);
      assert.equal(f.g.running.size, 0);
      assert.ok(f.store.all().every(h => h.status === 'queued' && h.cards.length === 0));
      assert.deepEqual(JSON.parse(f.files.get(f.store.filePath)).highlights, JSON.parse(JSON.stringify(f.store.all())));
    } finally {
      for (const gate of gates) gate.resolve();
      await Promise.allSettled(runs);
      f.store.close();
    }
  });
}

test('failed final rollback save closes storage but retains dirty memory, the prior snapshot and error evidence', async () => {
  const f = await fixture(), atWrite = deferred(), release = deferred();
  const write = f.adapter.write, errors = [], error = console.error;
  let paused = false, running;
  console.error = (...args) => errors.push(args);
  f.adapter.write = async (path, text) => {
    const h = JSON.parse(text).highlights[0];
    if (!paused && h?.generation?.committed) {
      paused = true;
      atWrite.resolve();
      await release.promise;
    } else if (f.g.stopped && h?.generation?.committed === false) throw Error('synthetic disk full');
    await write(path, text);
  };
  const run = f.g.run.bind(f.g);
  f.g.run = (...args) => (running = run(...args));
  try {
    f.g.enqueue(f.h);
    await atWrite.promise;
    f.store.moveSource('synthetic.md', 'renamed.md');
    const unloading = f.plugin.onunload();
    const rejected = assert.rejects(unloading, /synthetic disk full/);
    release.resolve();
    await rejected;
    await running;
    assert.equal(f.store.closed, true);
    assert.equal(f.store.hasUnsavedChanges, true);
    assert.equal(f.h.cards.length, 0);
    assert.equal(f.h.generation.committed, false);
    assert.equal(f.h.status, 'queued');
    assert.equal(f.h.sourcePath, 'renamed.md');
    const priorBytes = f.files.get(f.store.filePath);
    assert.equal(JSON.parse(priorBytes).highlights[0].cards.length, 1, 'a failed save must not claim the rollback is durable');
    assert.ok(errors.some(args => args.some(value => /synthetic disk full/.test(String(value)))));
    assert.ok(notices.some(message => /not saved on unload/.test(message)));
    await assert.rejects(f.plugin.onunload(), /synthetic disk full/);
    await f.store.flush();
    assert.equal(f.files.get(f.store.filePath), priorBytes, 'closed instance cannot overwrite its replacement');
    assert.equal(f.store.hasUnsavedChanges, true);
  } finally {
    release.resolve();
    if (running) await running;
    f.store.close();
    console.error = error;
  }
});
