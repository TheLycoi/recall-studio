import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundles = [];
const element = () => ({ addClass() {}, toggleClass() {}, setText() {}, setAttribute() {}, addEventListener() {} });
// Native Component.unload discards onunload's promise, as does the plugin manager.
class NativeLifecycle {
  constructor(app, manifest = {}) { Object.assign(this, { app, manifest, _loaded: true, _children: [], _events: [] }); }
  async loadData() { return { schemaFolder: 'study' }; }
  registerView() {}
  addSettingTab() {}
  addRibbonIcon() { return element(); }
  addStatusBarItem() { return element(); }
  addCommand() {}
  registerEvent() {}
  registerDomEvent() {}
  registerMarkdownPostProcessor() {}
  registerEditorExtension() {}
  unload() {
    if (this._loaded) {
      this._loaded = false;
      for (const e = this._children, t = this._events; e.length > 0;) e.pop().unload();
      for (; this._events.length > 0;) this._events.pop()();
      this.onunload();
    }
  }
}
const notices = [];
before(async () => {
  globalThis.window ??= globalThis;
  globalThis.document ??= { body: element() };
  for (let i = 0; i < 2; i++) {
    const out = await build({
      stdin: { contents: `export {default as RecallPlugin} from './src/main'; export {InboxStore} from './src/store'; export {Generator} from './src/generator'; export {LlmClient} from './src/llm'; export {makeHighlight} from './src/model';`, resolveDir: root },
      bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian', '@codemirror/view'], logLevel: 'silent',
    });
    const stub = new Proxy({ Plugin: NativeLifecycle, Notice: class { constructor(message) { notices.push(message); } hide() {} }, normalizePath: p => p, addIcon() {}, editorInfoField: {} }, { get: (o, k) => k in o ? o[k] : class {} });
    const cm = { WidgetType: class {}, Decoration: { none: [], widget: () => ({ range: () => ({ from: 0 }) }), set: xs => xs }, ViewPlugin: { fromClass: c => c } };
    const m = new Module(`handover-${i}`);
    m.require = id => id === 'obsidian' ? stub : id === '@codemirror/view' ? cm : Module.createRequire(import.meta.url)(id);
    m._compile(out.outputFiles[0].text, `handover-${i}`);
    bundles.push(m.exports);
  }
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(r => setImmediate(r));
  assert.ok(predicate(), 'barrier reached');
}
async function fixture() {
  const { RecallPlugin, InboxStore, Generator, LlmClient, makeHighlight } = bundles[0];
  const files = new Map(), dirs = new Set(['study']);
  const adapter = {
    async exists(p) { return files.has(p) || dirs.has(p); },
    async mkdir(p) { dirs.add(p); },
    async read(p) { assert.ok(files.has(p), `missing ${p}`); return files.get(p); },
    async write(p, s) { files.set(p, s); },
    async rename(a, b) { assert.ok(files.has(a)); assert.equal(files.has(b), false, 'native rename refuses overwrite'); files.set(b, files.get(a)); files.delete(a); },
    async remove(p) { assert.ok(files.delete(p)); },
  };
  const app = {
    vault: { adapter, configDir: '.obsidian', getAbstractFileByPath: () => null, on: () => ({}) },
    workspace: { on: () => ({}), onLayoutReady() {}, iterateAllLeaves() {}, getActiveViewOfType: () => null },
  }, store = new InboxStore(app, 'study');
  await store.load();
  const h = makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Synthetic', text: 'Amber stores heat.' });
  store.add(h);
  await store.flush();
  const settings = { provider: 'codex', codexModel: 'synthetic', writerInstructions: '', language: '', critiquePass: false, historyExamples: false, lintMode: 'badge', concurrency: 1, notifyWhenReady: false };
  const prep = { facts: [{ id: 'F1', statement: h.text, quote: h.text }], plan: [{ id: 'P1', factIds: ['F1'], entity: 'Amber', aspect: '', value: 'heat', reason: 'Stated' }], exclusions: [], omissions: [], conflicts: [] };
  const llm = new LlmClient(() => settings);
  llm.codex = { complete: async req => req.schema.parse(req.label === 'preparation' ? prep : { cards: [{ planId: 'P1', factIds: ['F1'], kind: 'qa', front: 'What does Amber store?', back: 'heat', text: '' }] }) };
  llm.abort = async () => {};
  const plugin = new RecallPlugin(app);
  Object.assign(plugin, { settings, store, llm, refreshStatusBar() {} });
  const g = plugin.generator = new Generator(plugin);
  return { files, adapter, app, store, h, llm, plugin, g };
}

for (const boundary of ['write', 'backup-rename', 'commit-rename']) {
  test(`native unload hands over rollback before a fresh bundle loads at ${boundary}`, async () => {
    const f = await fixture(), entered = deferred(), release = deferred();
    let paused = false, next, loading;
    const write = f.adapter.write, rename = f.adapter.rename;
    f.adapter.write = async (p, s) => {
      if (boundary === 'write' && !paused && JSON.parse(s).highlights[0]?.generation?.committed) {
        paused = true; entered.resolve(); await release.promise;
      }
      await write(p, s);
    };
    f.adapter.rename = async (a, b) => {
      const committed = JSON.parse(f.files.get(a)).highlights[0]?.generation?.committed;
      const finalStaged = [...f.files].some(([p, s]) => p.includes('.pending-') && JSON.parse(s).highlights[0]?.generation?.committed);
      if (!paused && ((boundary === 'backup-rename' && b.endsWith('.backup') && finalStaged) || (boundary === 'commit-rename' && b === f.store.filePath && committed))) {
        paused = true; entered.resolve(); await release.promise;
      }
      await rename(a, b);
    };
    try {
      f.g.enqueue(f.h);
      await entered.promise;
      f.store.moveSource('synthetic.md', 'renamed.md');
      assert.equal(f.plugin.unload(), undefined, 'host does not await onunload');
      const unloading = f.plugin.onunload();
      assert.equal(f.plugin.onunload(), unloading, 'repeated unload shares handover');
      assert.notEqual(bundles[0].InboxStore, bundles[1].InboxStore, 'separately evaluated plugin bundles');
      next = new bundles[1].RecallPlugin(f.app);
      const added = bundles[1].makeHighlight({ sourcePath: 'new.md', sourceTitle: 'New', text: 'New user capture after reload.', status: 'ready' });
      loading = next.onload().then(async () => { next.store.add(added); await next.store.flush(); });
      // Start the successor now. Only storage handover, not the caller, can order it.
      await new Promise(r => setImmediate(r));
      release.resolve();
      await Promise.all([loading, unloading]);
      const disk = JSON.parse(f.files.get(f.store.filePath)).highlights;
      assert.ok(disk.some(h => h.id === added.id), 'old final save must not erase successor capture');
      const old = disk.find(h => h.id === f.h.id);
      assert.equal(old.sourcePath, 'renamed.md');
      assert.equal(old.cards.length, 0);
      assert.equal(old.generation.committed, false);
      assert.equal(old.status, 'queued');
      assert.equal(f.store.closed, true);
      assert.equal(f.store.hasUnsavedChanges, false);
    } finally {
      release.resolve();
      await Promise.allSettled([loading, f.plugin.onunload()]);
      f.store.close(); next?.store?.close();
    }
  });
}

for (const boundary of ['write', 'backup-rename', 'commit-rename']) {
  test(`successor waits while the old rollback final save is paused at ${boundary}`, async () => {
    const f = await fixture(), committed = deferred(), commitRelease = deferred(), rollback = deferred(), release = deferred();
    const write = f.adapter.write, rename = f.adapter.rename;
    let commitPaused = false, rollbackPaused = false, loading;
    const next = new bundles[1].RecallPlugin(f.app);
    const pause = async () => { rollbackPaused = true; rollback.resolve(); await release.promise; };
    f.adapter.write = async (p, s) => {
      const h = JSON.parse(s).highlights[0];
      if (!commitPaused && h?.generation?.committed) {
        commitPaused = true; committed.resolve(); await commitRelease.promise;
      } else if (boundary === 'write' && !rollbackPaused && f.g.stopped && h?.generation?.committed === false) await pause();
      await write(p, s);
    };
    f.adapter.rename = async (a, b) => {
      const pendingRollback = [...f.files].some(([p, s]) => p.includes('.pending-') && JSON.parse(s).highlights[0]?.generation?.committed === false);
      const stagedRollback = a.includes('.pending-') && JSON.parse(f.files.get(a)).highlights[0]?.generation?.committed === false;
      if (!rollbackPaused && f.g.stopped && ((boundary === 'backup-rename' && b.endsWith('.backup') && pendingRollback) || (boundary === 'commit-rename' && b === f.store.filePath && stagedRollback))) await pause();
      await rename(a, b);
    };
    try {
      f.g.enqueue(f.h); await committed.promise;
      f.store.moveSource('synthetic.md', 'renamed.md');
      f.plugin.unload();
      loading = next.onload();
      commitRelease.resolve(); await rollback.promise;
      await new Promise(r => setImmediate(r));
      assert.equal(next.generator, undefined, 'successor services cannot start before durable rollback');
      assert.equal(f.store.closed, false);
      release.resolve(); await loading;
      const added = bundles[1].makeHighlight({ sourcePath: 'after-rollback.md', text: 'Successor capture.', status: 'ready' });
      next.store.add(added); await next.store.flush();
      await f.plugin.onunload();
      const disk = JSON.parse(f.files.get(f.store.filePath)).highlights;
      assert.ok(disk.some(h => h.id === added.id));
      const old = disk.find(h => h.id === f.h.id);
      assert.equal(old.sourcePath, 'renamed.md');
      assert.equal(old.cards.length, 0);
      assert.equal(old.generation.committed, false);
    } finally {
      commitRelease.resolve(); release.resolve();
      await Promise.allSettled([loading, f.plugin.onunload()]);
      f.store.close(); next.store?.close();
    }
  });
}

for (const failure of ['abort', 'final-save']) {
  test(`ignored native unload rejection from ${failure} keeps successor storage closed to writes`, async () => {
    const f = await fixture(), entered = deferred(), release = deferred(), errors = [];
    const write = f.adapter.write, error = console.error;
    let paused = false, loading, next, third;
    console.error = (...args) => errors.push(args);
    f.adapter.write = async (p, s) => {
      const h = JSON.parse(s).highlights[0];
      if (!paused && h?.generation?.committed) {
        paused = true; entered.resolve(); await release.promise;
      } else if (failure === 'final-save' && f.g.stopped && h?.generation?.committed === false) throw Error('synthetic disk full');
      await write(p, s);
    };
    if (failure === 'abort') f.llm.abort = async () => { throw Error('synthetic abort failed'); };
    try {
      f.g.enqueue(f.h);
      await entered.promise;
      f.store.moveSource('synthetic.md', 'renamed.md');
      f.plugin.unload();
      next = new bundles[1].RecallPlugin(f.app);
      loading = next.onload().then(() => null, e => e);
      await until(() => next.store);
      release.resolve();
      await until(() => f.store.closed);
      // Deliberately leave the host's returned promise ignored through a turn.
      await new Promise(r => setImmediate(r));
      const expected = failure === 'abort' ? /synthetic abort failed/ : /synthetic disk full/;
      const rejectedLoad = await loading;
      assert.match(rejectedLoad.message, expected);
      await assert.rejects(f.plugin.onunload(), expected);
      assert.equal(f.store.hasUnsavedChanges, failure === 'final-save');
      assert.equal(f.h.cards.length, 0);
      assert.equal(f.h.generation.committed, false);
      assert.equal(next.generator, undefined, 'failed load never starts services');
      const preserved = new Map(f.files);
      const prior = JSON.parse(f.files.get(f.store.filePath)).highlights[0];
      assert.equal(prior.cards.length, failure === 'final-save' ? 1 : 0, 'last-good bytes stay truthful after failure');
      next.store.add(bundles[1].makeHighlight({ sourcePath: 'blocked.md', text: 'Must not overwrite recovery data.' }));
      await next.store.flush();
      assert.deepEqual(f.files, preserved);
      next.unload();
      await assert.rejects(next.onunload());
      third = new bundles[0].InboxStore(f.app, 'study');
      await assert.rejects(third.load(), expected, 'unloading a failed successor cannot erase the failed barrier');
      assert.deepEqual(f.files, preserved);
      assert.ok(errors.some(args => args.some(v => expected.test(String(v)))));
      if (failure === 'final-save') assert.ok(notices.some(message => /not saved on unload/.test(message)));
    } finally {
      release.resolve();
      await Promise.allSettled([loading, f.plugin.onunload(), next?.onunload()]);
      f.store.close(); next?.store?.close(); third?.close(); console.error = error;
    }
  });
}

test('handover keys share an adapter identity but keep other adapters and store paths independent', async () => {
  const f = await fixture(), other = await fixture(), release = deferred();
  f.llm.abort = () => release.promise;
  const sameAdapterApp = { vault: { adapter: f.adapter } };
  const waiting = new bundles[1].InboxStore(sameAdapterApp, 'study');
  const otherPath = new bundles[1].InboxStore(f.app, 'other-study');
  const otherVault = new bundles[1].InboxStore(other.app, 'study');
  let loading, loaded = false;
  try {
    f.store.moveSource('synthetic.md', 'renamed.md');
    f.plugin.unload();
    loading = waiting.load().then(() => { loaded = true; });
    await Promise.all([otherPath.load(), otherVault.load()]);
    assert.equal(loaded, false);
    const capture = bundles[1].makeHighlight({ sourcePath: 'new.md', text: 'Independent capture.', status: 'ready' });
    otherPath.add(capture); await otherPath.flush();
    assert.equal(JSON.parse(f.files.get('other-study/inbox.json')).highlights[0].id, capture.id);
    assert.equal(otherVault.all()[0].id, other.h.id);
    release.resolve();
    await Promise.all([loading, f.plugin.onunload()]);
    assert.equal(waiting.all()[0].sourcePath, 'renamed.md');
  } finally {
    release.resolve(); await Promise.allSettled([loading, f.plugin.onunload()]);
    f.store.close(); other.store.close(); waiting.close(); otherPath.close(); otherVault.close();
  }
});

for (const boundary of ['initial-read', 'backup-recovery']) {
  test(`native unload during ${boundary} cannot save an empty inbox or release early`, async () => {
    const f = await fixture(), entered = deferred(), release = deferred();
    f.store.close();
    if (boundary === 'backup-recovery') {
      f.files.set('study/inbox.json.backup', f.files.get('study/inbox.json'));
      f.files.delete('study/inbox.json');
    }
    const prior = new Map(f.files), read = f.adapter.read, rename = f.adapter.rename;
    let paused = false, loading, thirdLoad, thirdLoaded = false;
    f.adapter.read = async p => {
      if (boundary === 'initial-read' && !paused && p === 'study/inbox.json') { paused = true; entered.resolve(); await release.promise; }
      return read(p);
    };
    f.adapter.rename = async (a, b) => {
      if (boundary === 'backup-recovery' && !paused && a.endsWith('.backup')) { paused = true; entered.resolve(); await release.promise; }
      return rename(a, b);
    };
    const next = new bundles[1].RecallPlugin(f.app), third = new bundles[0].InboxStore(f.app, 'study');
    try {
      loading = next.onload();
      await entered.promise;
      next.unload();
      thirdLoad = third.load().then(() => { thirdLoaded = true; });
      await new Promise(r => setImmediate(r));
      assert.deepEqual(f.files, prior, 'an incompletely loaded store must not flush empty default state');
      assert.equal(thirdLoaded, false, 'load recovery must settle before handing storage to a third instance');
      release.resolve();
      await Promise.all([loading, thirdLoad, next.onunload()]);
      assert.equal(next.generator, undefined);
      assert.equal(next.store.closed, true);
      assert.equal(third.all()[0].id, f.h.id);
    } finally {
      release.resolve(); await Promise.allSettled([loading, thirdLoad, next.onunload()]);
      next.store?.close(); third.close();
    }
  });
}

for (const settingsFail of [false, true]) {
  test(`unload before settings ${settingsFail ? 'reject' : 'resolve'} leaves no half-loaded store`, async () => {
    const f = await fixture(), settings = deferred();
    const next = new bundles[1].RecallPlugin(f.app), prior = new Map(f.files);
    next.loadData = () => settings.promise;
    const loading = next.onload().then(() => null, e => e);
    next.unload();
    await next.onunload();
    if (settingsFail) settings.reject(Error('synthetic settings failure'));
    else settings.resolve({ schemaFolder: 'study' });
    const failure = await loading;
    if (settingsFail) assert.match(failure.message, /synthetic settings failure/);
    else assert.equal(failure, null);
    assert.equal(next.store, undefined);
    assert.equal(next.generator, undefined);
    assert.deepEqual(f.files, prior);
    f.store.close();
  });
}

test('an unsaved no-op final flush fails handover closed', async () => {
  const f = await fixture();
  f.store.moveSource('synthetic.md', 'renamed.md');
  f.store.readOnly = true;
  const prior = new Map(f.files), next = new bundles[1].InboxStore(f.app, 'study');
  try {
    f.plugin.unload();
    await assert.rejects(f.plugin.onunload(), /not saved|not durable/i);
    await assert.rejects(next.load(), /not saved|not durable/i);
    assert.equal(f.store.closed, true);
    assert.equal(f.store.hasUnsavedChanges, true);
    assert.deepEqual(f.files, prior);
  } finally { f.store.close(); next.close(); }
});

test('unloading a successor still waiting to load cannot bypass the original handover', async () => {
  const f = await fixture(), release = deferred();
  f.llm.abort = () => release.promise;
  const next = new bundles[1].RecallPlugin(f.app), third = new bundles[0].InboxStore(f.app, 'study');
  let loading, thirdLoad, thirdLoaded = false;
  try {
    f.store.moveSource('synthetic.md', 'renamed.md');
    f.plugin.unload();
    loading = next.onload();
    await until(() => next.store);
    next.unload();
    thirdLoad = third.load().then(() => { thirdLoaded = true; });
    await new Promise(r => setImmediate(r));
    assert.equal(thirdLoaded, false, 'a cancelled successor must retain the original pending barrier');
    release.resolve();
    await Promise.all([loading, thirdLoad, f.plugin.onunload(), next.onunload()]);
    assert.equal(next.generator, undefined, 'unloaded onload must not resume and register a new generator');
    assert.equal(next.store.closed, true);
    assert.equal(third.all()[0].sourcePath, 'renamed.md');
  } finally {
    release.resolve();
    await Promise.allSettled([loading, thirdLoad, f.plugin.onunload(), next.onunload()]);
    f.store.close(); next.store?.close(); third.close();
  }
});
