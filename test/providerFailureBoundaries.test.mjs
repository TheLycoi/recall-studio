import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const root = process.cwd();
const require = createRequire(`${root}/package.json`);
const { build } = require('esbuild');
const { z } = require('zod');
let m, cli, http, calls = 0, liveChild;
const secret = 'SyntheticOpaqueCredentialForSchema123';
const settings = provider => ({ provider, effort: 'low', codexPath: '/synthetic/codex', codexModel: 'synthetic', opencodePath: '/synthetic/opencode', opencodeModel: 'synthetic/model', deepseekApiKey: 'SyntheticHttpCredential', deepseekModel: 'synthetic', concurrency: 1, language: '', notifyWhenReady: false });
const req = () => ({ system: 'Synthetic', user: 'Synthetic', schema: z.object({ ready: z.boolean() }), label: 'probe', maxTokens: 10 });
const tick = () => new Promise(r => setImmediate(r));
before(async () => {
  const out = await build({ stdin: { contents: `export { DeepSeekBackend } from './src/deepseek'; export { CodexBackend } from './src/codex'; export { OpenCodeBackend } from './src/opencode'; export { LlmClient } from './src/llm'; export { Generator } from './src/generator'; export { makeHighlight } from './src/model';`, resolveDir: root }, bundle: true, write: false, format: 'cjs', platform: 'node', external: ['obsidian'], logLevel: 'silent' });
  const fs = { constants: { X_OK: 1 }, accessSync() {}, mkdirSync() {}, writeFileSync() {}, mkdtempSync: () => '/synthetic/scratch', rmSync() {}, readFileSync() { throw Error('No synthetic cache'); } };
  const cp = {
    execFileSync() { throw Error('Real external execution forbidden'); },
    execFile(bin, args, options, callback) { callback?.(null, '', ''); return { unref() {} }; },
    spawn(bin, args) {
      calls++;
      const config = { ...cli };
      const child = new EventEmitter(); liveChild = child;
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
      child.stdout.setEncoding = child.stderr.setEncoding = () => {};
      child.exitCode = child.signalCode = null;
      child.kill = sig => { child.signalCode = sig; queueMicrotask(() => child.emit('close', null, sig)); return true; };
      child.stdin.end = () => queueMicrotask(() => {
        const open = args[0] === 'run';
        if (config.text != null) child.stdout.emit('data', JSON.stringify(open ? { type: 'text', sessionID: 'synthetic-session', part: { type: 'text', messageID: 'm', text: config.text } } : { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: config.text } }) + '\n');
        if ('error' in config) child.stdout.emit('data', JSON.stringify({ type: open ? 'error' : 'turn.failed', error: { message: config.error } }) + '\n');
        if (!config.hold) { child.exitCode = config.code ?? 0; child.emit('close', child.exitCode, null); }
      });
      return child;
    },
  };
  const mod = new Module('security-production-probes');
  mod.require = id => id === 'obsidian' ? { Notice: class {}, requestUrl: args => { calls++; return http(args); } } : id === 'fs' ? fs : id === 'child_process' ? cp : require(id);
  mod._compile(out.outputFiles[0].text, 'security-production-probes'); m = mod.exports;
});
function reset() { calls = 0; cli = { text: '{"ready":true}' }; }
for (const [name, Backend] of [['opencode', 'OpenCodeBackend'], ['codex', 'CodexBackend']]) {
  test(`${name}: reject a fatal event even when earlier text parses`, async () => {
    reset(); cli.error = 'Synthetic fatal provider failure';
    await assert.rejects(new m[Backend](() => settings(name)).complete(req()));
  });
  test(`${name}: reject nonzero exit even when earlier text parses`, async () => {
    reset(); cli.code = 1;
    await assert.rejects(new m[Backend](() => settings(name)).complete(req()));
  });
  test(`${name}: text calls reject fatal events and failed exits`, async () => {
    for (const failure of [{ error: 'Synthetic fatal failure' }, { error: '' }, { code: 1 }]) {
      reset(); Object.assign(cli, failure);
      await assert.rejects(new m[Backend](() => settings(name)).completeText(req()));
    }
  });
  test(`${name}: abort rejects already emitted text`, async () => {
    reset(); cli.hold = true;
    const b = new m[Backend](() => settings(name));
    const pending = b.complete(req());
    // Attach rejection observation before abort, to avoid unhandled rejection noise.
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    await tick(); await b.abort();
    const result = await outcome;
    assert.equal(result.error?.kind, 'aborted', `cancelled result: ${JSON.stringify(result)}`);
  });
  test(`${name}: opaque provider-controlled schema keys stay out of errors`, async () => {
    reset(); cli.text = JSON.stringify({ ready: true, [secret]: 'extra' });
    const b = new m[Backend](() => settings(name));
    let error; try { await b.complete({ ...req(), schema: z.strictObject({ ready: z.boolean() }) }); } catch (e) { error = e; }
    assert.ok(error);
    assert.equal(`${error.message}\n${error.stack}`.includes(secret), false, 'opaque synthetic credential reached schema diagnostic');
  });
  test(`${name}: positive control and denied dispatch`, async () => {
    reset(); const b = new m[Backend](() => settings(name));
    assert.deepEqual(await b.complete(req()), { ready: true });
    await assert.rejects(b.complete({ ...req(), authorized: () => false }), /authorization/);
    assert.equal(calls, 1);
  });
}
test('DeepSeek: abort settles a pending completion without waiting for HTTP', async () => {
  reset(); let release;
  http = () => new Promise(r => { release = r; });
  const b = new m.DeepSeekBackend(() => settings('deepseek'));
  let result;
  const pending = b.complete(req()).then(value => { result = { value }; }, error => { result = { error }; });
  await tick(); await b.abort(); await tick();
  const settledAfterAbort = !!result;
  release({ status: 200, json: { choices: [{ message: { content: '{"ready":true}' }, finish_reason: 'stop' }] } });
  await pending;
  assert.equal(settledAfterAbort, true, 'abort resolved while completion remained pending');
  assert.equal(result.error?.kind, 'aborted');
});
test('DeepSeek: LlmClient abort releases generator drain before deferred HTTP resolves', async () => {
  reset(); let release;
  http = () => new Promise(r => { release = r; });
  const s = settings('deepseek');
  const h = m.makeHighlight({ sourcePath: 'Synthetic.md', sourceTitle: 'Synthetic', text: 'Amber stores heat.' });
  const store = { all: () => [h], touch() {}, notify() {}, hasUnsavedChanges: false, async flush() {} };
  const llm = new m.LlmClient(() => s);
  const generator = new m.Generator({ settings: s, llm, store, refreshStatusBar() {} });
  generator.enqueue(h);
  for (let i = 0; i < 20 && !release; i++) await tick();
  assert.ok(release, 'real Generator reached production DeepSeek transport');
  let drained = false;
  const stopped = generator.stop().then(() => { drained = true; });
  await llm.abort(); await tick();
  const drainedAfterAbort = drained;
  release({ status: 200, json: {} }); await stopped;
  assert.equal(h.cards.length, 0, 'late reply must not publish cards');
  assert.equal(drainedAfterAbort, true, 'unload drain waits for deferred HTTP despite abort');
});
test('DeepSeek: per-call AbortSignal cancels locally and never retries', async () => {
  reset(); let release;
  http = () => new Promise(r => { release = r; });
  const controller = new AbortController();
  const pending = new m.DeepSeekBackend(() => settings('deepseek')).completeText({ ...req(), signal: controller.signal });
  const rejected = assert.rejects(pending, e => e.kind === 'aborted');
  controller.abort(); await rejected;
  release({ status: 200, json: {} }); assert.equal(calls, 1);
});
