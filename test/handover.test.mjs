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
class TFile { constructor(path) { this.path = path; this.stat = { mtime: 1 }; } }
class TFolder { constructor(path) { this.path = path; } }
const notices = [];
before(async () => {
  globalThis.window ??= globalThis;
  globalThis.document ??= { body: element() };
  for (let i = 0; i < 2; i++) {
    const out = await build({
      stdin: { contents: `export {default as RecallPlugin} from './src/main'; export {InboxStore} from './src/store'; export {Generator} from './src/generator'; export {LlmClient} from './src/llm'; export {makeHighlight} from './src/model'; export {renderProposal, parseProposals} from './src/schemaNote';`, resolveDir: root },
      bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian', '@codemirror/view'], logLevel: 'silent',
    });
    const stub = new Proxy({ Plugin: NativeLifecycle, TFile, TFolder, Notice: class { constructor(message) { notices.push(message); } hide() {} }, normalizePath: p => p, addIcon() {}, editorInfoField: {} }, { get: (o, k) => k in o ? o[k] : class {} });
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
  llm.codex = { complete: async req => req.schema.parse(req.label === 'preparation' ? prep : req.label === 'audit' ? { verdicts: JSON.parse(req.user).cards.map((card,index) => ({index,cardId:card.id,status:'verified',reason:'Synthetic lifecycle fixture.'})) } : { cards: [{ planId: 'P1', factIds: ['F1'], kind: 'qa', front: 'What does Amber store?', back: 'heat', text: '' }] }) };
  llm.abort = async () => {};
  const plugin = new RecallPlugin(app);
  Object.assign(plugin, { settings, store, llm, refreshStatusBar() {} });
  const g = plugin.generator = new Generator(plugin);
  return { files, adapter, app, store, h, llm, plugin, g };
}

function withRulesVault(f) {
  f.app.vault.getAbstractFileByPath = path => f.files.has(path) ? new TFile(path) : path === 'study' ? new TFolder(path) : null;
  f.app.vault.create = async (path, text) => {
    assert.equal(f.files.has(path), false);
    f.files.set(path, text);
    return new TFile(path);
  };
  f.app.vault.cachedRead = file => f.adapter.read(file.path);
  f.app.vault.process = async (file, transform) => {
    const text = transform(f.files.get(file.path));
    f.files.set(file.path, text);
    return text;
  };
}

function legacySuggestions(f) {
  const block = bundles[0].renderProposal({ id: 'instruction:use active voice', date: '2026-10-24', summary: 'Synthetic correction', rule: 'Use active voice.', evidence: ['Synthetic edit'], count: 3 });
  const path = 'study/recall-suggestions.md';
  f.files.set(path, block + block);
  f.files.set('study/recall-rules.md', '# Rules\n');
  return path;
}

for (const boundary of ['suggestions', 'rules']) test(`startup schema recovery cannot dispatch after native unload during ${boundary} read`, async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  f.store.close(); withRulesVault(f);
  const path = legacySuggestions(f), original = f.files.get(path);
  const read = f.app.vault.cachedRead;
  let paused = false, writes = 0;
  f.app.vault.cachedRead = async file => {
    if (!paused && file.path === (boundary === 'suggestions' ? path : 'study/recall-rules.md')) {
      paused = true; entered.resolve(); await release.promise;
    }
    return read(file);
  };
  const process = f.app.vault.process;
  f.app.vault.process = async (...args) => { writes++; return process(...args); };
  const old = new bundles[0].RecallPlugin(f.app);
  try {
    await old.onload(); await entered.promise;
    assert.equal(old.unload(), undefined);
    release.resolve();
    await old.onunload();
    await new Promise(r => setImmediate(r));
    assert.equal(writes, 0, 'a revoked read continuation cannot dispatch a bookkeeping write');
    assert.equal(f.files.get(path), original);
  } finally { release.resolve(); await Promise.allSettled([old.onunload()]); old.store?.close(); }
});

test('native schema handover drains an already-dispatched recovery before a fresh-bundle successor loads', async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  f.store.close(); withRulesVault(f);
  const path = legacySuggestions(f), process = f.app.vault.process;
  let calls = 0;
  f.app.vault.process = async (...args) => {
    if (++calls === 1) { entered.resolve(); await release.promise; }
    return process(...args);
  };
  const old = new bundles[0].RecallPlugin(f.app), next = new bundles[1].RecallPlugin(f.app);
  let loading;
  try {
    await old.onload(); await entered.promise;
    old.unload();
    let loaded = false;
    loading = next.onload().then(() => { loaded = true; });
    await new Promise(r => setImmediate(r));
    assert.equal(loaded, false, 'successor must wait for the old schema mutation');
    release.resolve();
    await Promise.all([old.onunload(), loading]);
    await next.schema.refresh();
    assert.equal(calls, 1, 'successor sees the recovered bytes without duplicating recovery');
    assert.deepEqual(bundles[1].parseProposals(f.files.get(path)).map(p => p.status), ['open', 'superseded']);
  } finally { release.resolve(); await Promise.allSettled([loading, old.onunload(), next.onunload()]); old.store?.close(); next.store?.close(); }
});

test('loaded schema recovery preserves every legacy block and supports a later human dismissal', async () => {
  const f = await fixture(); f.store.close(); withRulesVault(f);
  const path = legacySuggestions(f), old = new bundles[0].RecallPlugin(f.app);
  try {
    await old.onload(); await old.schema.refresh();
    const proposals = await old.schema.proposals();
    assert.deepEqual(proposals.map(p => p.status), ['open', 'superseded']);
    await old.schema.dismiss(proposals[0].occurrenceId, '2026-10-24');
    assert.deepEqual(bundles[0].parseProposals(f.files.get(path)).map(p => p.status), ['dismissed', 'superseded']);
    assert.equal(f.files.get('study/recall-rules.md'), '# Rules\n');
  } finally { await old.onunload(); }
});

test('failed dispatched schema recovery keeps native handover closed to a successor', async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  f.store.close(); withRulesVault(f); const path = legacySuggestions(f), original = f.files.get(path);
  const failure = new Error('Synthetic schema disk failure');
  f.app.vault.process = async () => { entered.resolve(); await release.promise; throw failure; };
  const old = new bundles[0].RecallPlugin(f.app), next = new bundles[1].RecallPlugin(f.app);
  const error = console.error; console.error = () => {};
  try {
    await old.onload(); await entered.promise;
    old.unload();
    const settled = assert.rejects(old.onunload(), e => e === failure);
    release.resolve(); await settled;
    assert.equal(old.store.closed, true);
    await assert.rejects(next.onload(), e => e === failure);
    assert.equal(next.schema, undefined, 'uncertain schema writes cannot be ignored by a fresh bundle');
    assert.equal(f.files.get(path), original);
  } finally { release.resolve(); await Promise.allSettled([old.onunload(), next.onunload()]); old.store?.close(); next.store?.close(); console.error = error; }
});

test('native unload revokes a delayed schema dismissal without changing its occurrence', async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  f.store.close(); withRulesVault(f); const path = legacySuggestions(f);
  const old = new bundles[0].RecallPlugin(f.app);
  try {
    await old.onload(); await old.schema.refresh();
    const selected = (await old.schema.proposals())[0], before = f.files.get(path), read = f.app.vault.cachedRead;
    f.app.vault.cachedRead = async file => { if (file.path === path) { entered.resolve(); await release.promise; } return read(file); };
    const action = old.schema.dismiss(selected.occurrenceId, '2026-10-24');
    const rejected = assert.rejects(action, /stopped.*unload/i);
    await entered.promise; old.unload(); release.resolve();
    await Promise.all([rejected, old.onunload()]);
    assert.equal(f.files.get(path), before);
  } finally { release.resolve(); await Promise.allSettled([old.onunload()]); }
});

test('native unload after a dispatched Accept preserves its receipt and successor retry never appends twice', async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  f.store.close(); withRulesVault(f); const path = legacySuggestions(f);
  f.files.delete('study/recall-rules.md');
  const old = new bundles[0].RecallPlugin(f.app), next = new bundles[1].RecallPlugin(f.app);
  let loading;
  try {
    await old.onload(); await old.schema.refresh();
    for (let i = 0; i < 3; i++) old.store.recordRevision({ cardId: `instruction-${i}`, at: '2026-10-24T00:00:00Z', via: 'rewrite', instruction: 'Use active voice', before: { kind: 'qa', front: 'Old question?', back: 'Old answer', text: '', extra: '' }, after: { kind: 'qa', front: 'New question?', back: 'New answer', text: '', extra: '' } });
    const selected = (await old.schema.proposals())[0], process = f.app.vault.process;
    f.app.vault.process = async (file, transform) => {
      if (file.path === 'study/recall-rules.md') { entered.resolve(); await release.promise; }
      return process(file, transform);
    };
    const accepting = old.schema.accept(selected.occurrenceId, 'Keep my deliberate wording.', '2026-10-24');
    const rejected = assert.rejects(accepting, /rule is saved.*retry/i);
    await entered.promise; old.unload();
    loading = next.onload();
    release.resolve(); await Promise.all([old.onunload(), loading, rejected]);
    await next.schema.refresh();
    const saved = f.files.get('study/recall-rules.md');
    await next.schema.accept(selected.occurrenceId, 'Do not replace the accepted wording.', '2026-10-24');
    assert.equal(f.files.get('study/recall-rules.md'), saved);
    assert.equal(saved.split('Keep my deliberate wording.').length - 1, 1);
    assert.deepEqual(bundles[1].parseProposals(f.files.get(path)).map(p => p.status), ['applied', 'superseded']);
  } finally { release.resolve(); await Promise.allSettled([loading, old.onunload(), next.onunload()]); old.store?.close(); next.store?.close(); }
});

test('native unload after folder creation dispatch prevents the later rules-note creation', async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  f.store.close(); withRulesVault(f);
  f.app.vault.getAbstractFileByPath = path => f.files.has(path) ? new TFile(path) : null;
  let folders = 0;
  f.app.vault.createFolder = async () => { folders++; entered.resolve(); await release.promise; };
  const old = new bundles[0].RecallPlugin(f.app);
  try {
    await old.onload();
    const creating = old.schema.ensure();
    const rejected = assert.rejects(creating, /stopped.*unload/i);
    await entered.promise; old.unload();
    let done = false; const cleanup = old.onunload().then(() => { done = true; });
    await new Promise(r => setImmediate(r)); assert.equal(done, false, 'drain the folder mutation too');
    release.resolve(); await Promise.all([rejected, cleanup]);
    assert.equal(folders, 1); assert.equal(f.files.has('study/recall-rules.md'), false);
  } finally { release.resolve(); await Promise.allSettled([old.onunload()]); }
});

test('saved layout-ready callback cannot restart work after native synchronous unload', async () => {
  const f = await fixture(), callbacks = [], migrations = [], dispatches = [];
  f.store.close();
  f.app.workspace.onLayoutReady = callback => callbacks.push(callback);
  f.app.workspace.iterateAllLeaves = visit => visit({
    getViewState: () => ({ type: 'review-inbox-chat' }),
    setViewState: async state => { migrations.push(state); },
  });
  // Use real rules-note creation, with only the vault boundary substituted.
  withRulesVault(f);
  const next = new bundles[1].RecallPlugin(f.app);
  let starts = 0;
  try {
    await next.onload();
    assert.equal(callbacks.length, 1);
    const start = next.generator.start.bind(next.generator);
    next.generator.start = () => { starts++; start(); };
    next.llm.codex.complete = async request => { dispatches.push(request.label); throw Error('unexpected synthetic dispatch'); };
    assert.equal(next.unload(), undefined, 'native unload discards its asynchronous hook');
    const before = new Map(f.files);
    callbacks[0]();
    assert.equal(starts, 0, 'saved callback must not restart a stopped generator');
    await next.onunload();
    await next.generator.stop();
    callbacks[0](); // The callback also stays inert after cleanup has fully settled.
    assert.equal(starts, 0);
    assert.equal(next.generator.stopped, true);
    assert.deepEqual(migrations, []);
    assert.deepEqual(dispatches, []);
    assert.equal(f.files.has('study/recall-rules.md'), false);
    assert.deepEqual(f.files, before);
    assert.equal(next.store.closed, true);
  } finally {
    await next.generator?.stop();
    await Promise.allSettled([next.onunload()]);
    next.store?.close();
  }
});

test('live layout startup migrates only retired leaves and completes the real generation queue', async () => {
  const f = await fixture(), callbacks = [], migrations = [], dispatches = [];
  f.store.close();
  withRulesVault(f);
  f.app.workspace.onLayoutReady = callback => callbacks.push(callback);
  f.app.workspace.iterateAllLeaves = visit => {
    for (const type of ['review-inbox-chat', 'markdown']) visit({
      getViewState: () => ({ type }),
      setViewState: async state => { migrations.push([type, state.type]); },
    });
  };
  const next = new bundles[1].RecallPlugin(f.app);
  try {
    await next.onload();
    Object.assign(next.settings, { provider: 'codex', critiquePass: true, historyExamples: false, notifyWhenReady: false });
    next.llm.codex.complete = async request => {
      dispatches.push(request.label);
      if (request.label !== 'audit') return f.llm.codex.complete(request);
      const { cards } = JSON.parse(request.user);
      return request.schema.parse({ verdicts: cards.map((card, index) => ({ index, cardId: card.id, status: 'verified', reason: 'Synthetic supported card' })) });
    };
    assert.deepEqual(dispatches, []);
    assert.equal(f.files.has('study/recall-rules.md'), false);
    callbacks[0]();
    await until(() => dispatches.length > 0 && next.generator.running.size === 0);
    assert.deepEqual(migrations, [['review-inbox-chat', 'review-inbox']]);
    assert.equal(f.files.has('study/recall-rules.md'), true);
    assert.ok(dispatches.includes('preparation'));
    assert.ok(dispatches.includes('grounded cards'));
    assert.ok(dispatches.includes('audit'));
    assert.equal(next.store.get(f.h.id).status, 'ready');
    assert.equal(next.store.get(f.h.id).cards.length, 1);
    next.unload();
    await next.onunload();
    const disk = JSON.parse(f.files.get('study/inbox.json')).highlights[0];
    assert.equal(disk.id, f.h.id);
    assert.equal(disk.cards.length, 1);
  } finally { await Promise.allSettled([next.onunload()]); next.store?.close(); }
});

test('layout migration stops if unloading begins while visiting saved leaves', async () => {
  const f = await fixture(), callbacks = [], migrations = [];
  f.store.close();
  f.app.workspace.onLayoutReady = callback => callbacks.push(callback);
  const next = new bundles[1].RecallPlugin(f.app);
  f.app.workspace.iterateAllLeaves = visit => {
    for (const id of ['first', 'second']) visit({
      getViewState: () => ({ type: 'review-inbox-chat' }),
      setViewState: async () => { migrations.push(id); next.unload(); },
    });
  };
  try {
    await next.onload();
    let starts = 0;
    next.generator.start = () => { starts++; };
    callbacks[0]();
    await next.onunload();
    assert.deepEqual(migrations, ['first'], 'later leaves must not migrate after unload');
    assert.equal(starts, 0, 'unload during leaf migration cannot start generation');
  } finally { await Promise.allSettled([next.onunload()]); next.store?.close(); }
});

for (const boundary of ['backup-exists', 'folder-exists', 'folder-create', 'destination-exists', 'legacy-exists']) {
  test(`native unload during startup ${boundary} cannot continue legacy migration`, async () => {
    const f = await fixture(), entered = deferred(), release = deferred();
    f.store.close();
    const legacy = '.obsidian/plugins/review-inbox/inbox.json';
    const original = f.files.get('study/inbox.json');
    f.files.delete('study/inbox.json');
    f.files.set(legacy, original);
    const exists = f.adapter.exists, mkdir = f.adapter.mkdir;
    let paused = false, loading;
    const pause = async () => { paused = true; entered.resolve(); await release.promise; };
    f.adapter.exists = async path => {
      if (!paused && ((boundary === 'backup-exists' && path === 'study/inbox.json.backup') ||
          (boundary === 'folder-exists' && path === 'study') ||
          (boundary === 'destination-exists' && path === 'study/inbox.json') ||
          (boundary === 'legacy-exists' && path === legacy))) await pause();
      if (path === 'study') return false;
      return exists(path);
    };
    f.adapter.mkdir = async path => {
      if (boundary === 'folder-create' && !paused) await pause();
      return mkdir(path);
    };
    const next = new bundles[1].RecallPlugin(f.app);
    try {
      loading = next.onload();
      await entered.promise;
      next.unload();
      await until(() => next.store.closed);
      release.resolve();
      await Promise.all([loading, next.onunload()]);
      assert.deepEqual([...f.files], [[legacy, original]], 'unloaded startup cannot move or replace the retained history');
      assert.equal(next.generator, undefined);
      assert.equal(next.store.closed, true);
      Object.assign(f.adapter, { exists, mkdir });
      const restarted = new bundles[0].InboxStore(f.app, 'study', '.obsidian/plugins/review-inbox');
      try {
        await restarted.load();
        assert.equal(restarted.all()[0].id, f.h.id, 'a live successor can still migrate normally');
      } finally { restarted.close(); }
    } finally {
      release.resolve();
      await Promise.allSettled([loading, next.onunload()]);
      next.store?.close();
    }
  });
}

test('a clean native reload retries failed migration on the same adapter', async () => {
  const f = await fixture();
  f.store.close();
  const legacy = '.obsidian/plugins/review-inbox/inbox.json';
  const original = f.files.get('study/inbox.json');
  f.files.delete('study/inbox.json');
  f.files.set(legacy, original);
  const rename = f.adapter.rename, error = console.error;
  f.adapter.rename = async (from, to) => {
    if (from === legacy) throw Error('synthetic migration unavailable');
    return rename(from, to);
  };
  console.error = () => {};
  const old = new bundles[0].RecallPlugin(f.app), next = new bundles[1].RecallPlugin(f.app);
  try {
    await old.onload();
    assert.equal(old.store.readOnly, true);
    assert.equal(old.store.hasUnsavedChanges, false);
    old.unload();
    f.adapter.rename = rename;
    await next.onload();
    await old.onunload();
    assert.equal(next.store.get(f.h.id).text, f.h.text);
    assert.equal(next.store.readOnly, false);
    assert.deepEqual([...f.files], [['study/inbox.json', original]]);
  } finally {
    f.adapter.rename = rename;
    await Promise.allSettled([old.onunload(), next.onunload()]);
    old.store?.close(); next.store?.close(); console.error = error;
  }
});

test('an already-dispatched migration settles before native handover releases its successor', async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  f.store.close();
  const legacy = '.obsidian/plugins/review-inbox/inbox.json';
  const original = f.files.get('study/inbox.json');
  f.files.delete('study/inbox.json'); f.files.set(legacy, original);
  const rename = f.adapter.rename;
  f.adapter.rename = async (from, to) => {
    if (from === legacy) { entered.resolve(); await release.promise; }
    return rename(from, to);
  };
  const old = new bundles[0].RecallPlugin(f.app), next = new bundles[1].RecallPlugin(f.app);
  let loading, successor;
  try {
    loading = old.onload();
    await entered.promise;
    old.unload();
    successor = next.onload();
    await until(() => old.store.closed && next.store);
    assert.equal(next.generator, undefined, 'the successor must wait for the dispatched rename to settle');
    assert.deepEqual([...f.files], [[legacy, original]]);
    release.resolve();
    await Promise.all([loading, successor, old.onunload()]);
    assert.equal(old.generator, undefined);
    assert.equal(next.store.get(f.h.id).text, f.h.text);
    assert.deepEqual([...f.files], [['study/inbox.json', original]]);
  } finally {
    release.resolve();
    await Promise.allSettled([loading, successor, old.onunload(), next.onunload()]);
    old.store?.close(); next.store?.close();
  }
});

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
