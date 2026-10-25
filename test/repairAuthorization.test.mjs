import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { z } from 'zod';
import { loadQuiz } from './quizHarness.mjs';

const response = value => ({ status: 200, json: { choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] } });

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
