import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { EventEmitter } from 'node:events';
import { build } from 'esbuild';
import { z } from 'zod';

// Synthetic credentials only. All HTTP, child processes and provider file reads
// are intercepted, including keychain lookup and model-cache reads.
const bearer = 'synthetic.bearer_value-123';
const apiKey = 'sk-synthetic-regression-123';
const opaqueKey = 'syntheticOpaqueKey123';
const diagnostic = `SYNTHETIC connection refused; Bearer ${bearer}; api_key=${apiKey}`;
let m, http, cli, calls, notices;
const req = () => ({ system: 'Synthetic', user: 'Synthetic', schema: z.object({ ready: z.boolean() }), label: 'probe', maxTokens: 10 });
const settings = provider => ({ provider, deepseekApiKey: opaqueKey, deepseekModel: 'synthetic', codexPath: '/synthetic/codex', codexModel: 'synthetic', opencodePath: '/synthetic/opencode', opencodeModel: 'synthetic/model', effort: 'low', concurrency: 1 });

before(async () => {
  const out = await build({ stdin: { contents: `export { DeepSeekBackend } from './src/deepseek'; export { CodexBackend } from './src/codex'; export { OpenCodeBackend } from './src/opencode'; export { Generator } from './src/generator'; export { LlmClient, describeError } from './src/llm'; export { makeHighlight } from './src/model';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'cjs', platform: 'node', external: ['obsidian'], logLevel: 'silent' });
  const fakeFs = { constants: { X_OK: 1 }, accessSync() {}, mkdirSync() {}, writeFileSync() {}, mkdtempSync: () => '/synthetic/scratch', rmSync() {}, readFileSync() { throw Error('Synthetic cache absent'); } };
  const fakeCp = {
    execFileSync() { throw Error('External execution forbidden'); },
    execFile() { throw cli.quickThrow ?? Error('External execution forbidden'); },
    spawn(bin, args) {
      calls++;
      if (cli.throw) throw cli.throw;
      const c = new EventEmitter();
      c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter();
      c.stdout.setEncoding = c.stderr.setEncoding = () => {};
      c.kill = () => {}; c.exitCode = null; c.signalCode = null;
      c.stdin.end = () => queueMicrotask(() => {
        if (cli.spawnError) { c.emit('error', cli.spawnError); return; }
        const open = args[0] === 'run';
        if (cli.text != null) c.stdout.emit('data', JSON.stringify(open ? { type: 'text', part: { type: 'text', messageID: 'm', text: cli.text } } : { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: cli.text } }) + '\n');
        if (cli.error) c.stdout.emit('data', JSON.stringify({ type: 'error', error: { message: cli.error } }) + '\n');
        if (cli.stdout) c.stdout.emit('data', cli.stdout);
        if (cli.stderr) c.stderr.emit('data', cli.stderr);
        c.exitCode = cli.code ?? 0; c.emit('close', c.exitCode, null);
      });
      return c;
    },
  };
  const mod = new Module('provider-diagnostics');
  mod.require = id => id === 'obsidian' ? { Notice: class { constructor(message) { notices.push(message); } }, requestUrl: args => { calls++; return http(args); } } : id === 'fs' ? fakeFs : id === 'child_process' ? fakeCp : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text, 'provider-diagnostics');
  m = mod.exports;
});
function reset() {
  calls = 0; notices = []; cli = { code: 0, text: '{"ready":true}' };
  http = async () => ({ status: 200, json: { choices: [{ message: { content: '{"ready":true}' }, finish_reason: 'stop' }] } });
}
function safe(error, kind = 'failed', category = /connection refused/) {
  assert.equal(error.kind, kind);
  const displayed = m.describeError(error);
  for (const secret of [bearer, apiKey, opaqueKey]) {
    assert.equal(displayed.includes(secret), false, 'display must not contain synthetic credentials');
    assert.equal(JSON.stringify({ error: displayed, stack: error.stack }).includes(secret), false, 'serialized error must not contain synthetic credentials');
  }
  assert.match(displayed, category);
  return true;
}

test('DeepSeek transport errors are redacted before display', async () => {
  reset(); http = async () => { throw Error(`${diagnostic}; reflected key ${opaqueKey}`); };
  await assert.rejects(new m.DeepSeekBackend(() => settings('deepseek')).complete(req()), e => safe(e));
  assert.equal(calls, 1);
});

test('DeepSeek model-list transport errors use the same safe boundary', async () => {
  reset(); http = async () => { throw Error(`${diagnostic}; reflected key ${opaqueKey}`); };
  await assert.rejects(new m.DeepSeekBackend(() => settings('deepseek')).listModels(), e => safe(e));
});

test('DeepSeek HTTP status redaction preserves classification and opaque configured keys', async () => {
  reset(); http = async () => ({ status: 429, json: { error: { message: `${diagnostic}; key ${opaqueKey}` } } });
  await assert.rejects(new m.DeepSeekBackend(() => settings('deepseek')).complete(req()), e => safe(e, 'rate-limit'));
});

test('credential labels redact non-prefixed API keys without hiding benign context', async () => {
  reset(); cli = { code: 1, error: `connection refused; API key: ${opaqueKey}; retry later` };
  await assert.rejects(new m.CodexBackend(() => settings('codex')).complete(req()), e => {
    safe(e); assert.match(e.message, /retry later/); return true;
  });
});

for (const label of ['api_key=', 'X-API-Key: ', 'API key: ', '"apiKey":"', 'access_token=', 'refresh-token=']) {
  test(`diagnostic credential field ${label} is redacted`, async () => {
    reset(); cli = { code: 1, error: `connection refused; ${label}${opaqueKey}${label.endsWith('"') ? '"' : ''}; retry later` };
    await assert.rejects(new m.CodexBackend(() => settings('codex')).complete(req()), e => {
      safe(e); assert.match(e.message, /retry later/); return true;
    });
  });
}

for (const provider of ['codex', 'opencode']) {
  const backend = () => new m[provider === 'codex' ? 'CodexBackend' : 'OpenCodeBackend'](() => settings(provider));
  test(`${provider} CLI error events are redacted`, async () => {
    reset(); cli = { code: 1, error: diagnostic };
    await assert.rejects(backend().complete(req()), e => safe(e));
  });
  test(`${provider} stderr and unexpected exit diagnostics are redacted`, async () => {
    reset(); cli = { code: 2, stderr: diagnostic };
    await assert.rejects(backend().completeText(req()), e => safe(e));
  });
  test(`${provider} asynchronous spawn errors are redacted`, async () => {
    reset(); cli = { spawnError: Error(diagnostic) };
    await assert.rejects(backend().complete(req()), e => safe(e));
  });
  test(`${provider} synchronous spawn errors are redacted`, async () => {
    reset(); cli = { throw: Error(diagnostic) };
    await assert.rejects(backend().complete(req()), e => safe(e));
  });
}

for (const [provider, Backend] of [['deepseek', 'DeepSeekBackend'], ['codex', 'CodexBackend'], ['opencode', 'OpenCodeBackend']]) {
  const backend = () => new m[Backend](() => settings(provider));
  const answer = text => {
    cli = { code: 0, text };
    http = async () => ({ status: 200, json: { choices: [{ message: { content: text }, finish_reason: 'stop' }] } });
  };
  test(`${provider} schema failures redact provider-controlled values`, async () => {
    reset(); answer(JSON.stringify({ ready: true, [apiKey]: 'unexpected', [`Bearer ${bearer}`]: 'unexpected' }));
    const request = { ...req(), schema: z.strictObject({ ready: z.boolean() }) };
    await assert.rejects(backend().complete(request), e => safe(e, 'failed', /wrong shape/));
  });
  test(`${provider} invalid JSON diagnostics never echo raw output`, async () => {
    reset(); answer(`not JSON: ${diagnostic}`);
    await assert.rejects(backend().complete(req()), e => safe(e, provider === 'deepseek' ? 'unparseable' : 'failed', /JSON/));
    assert.equal(calls, provider === 'deepseek' ? 2 : 1);
  });
  test(`${provider} benign transport diagnostics survive`, async () => {
    reset(); cli = { code: 1, stderr: 'connection refused at local socket; retry later' };
    http = async () => { throw Error('connection refused at local socket; retry later'); };
    await assert.rejects(backend().complete(req()), e => {
      safe(e); assert.match(e.message, /local socket; retry later/); return true;
    });
  });
  test(`${provider} successful structured and text output is not redacted`, async () => {
    reset(); answer('{"ready":true}');
    assert.deepEqual(await backend().complete(req()), { ready: true });
    answer(diagnostic);
    assert.equal(await backend().completeText(req()), diagnostic);
  });
  test(`${provider} Generator errors stay safe through serialization`, async () => {
    reset(); cli = { code: 1, error: diagnostic };
    http = async () => { throw Error(`${diagnostic}; key ${opaqueKey}`); };
    const h = m.makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Synthetic', text: 'Amber stores heat.' });
    const s = { ...settings(provider), writerInstructions: '', language: '', historyExamples: false, critiquePass: true, lintMode: 'badge', notifyWhenReady: false };
    const llm = new m.LlmClient(() => s);
    const snapshots = [];
    const store = { all: () => [h], touch() {}, hasUnsavedChanges: false, async flush() { snapshots.push(JSON.stringify(h)); } };
    await new m.Generator({ settings: s, llm, store, refreshStatusBar() {} }).run(h);
    assert.equal(h.status, 'error');
    assert.match(h.error, /connection refused/);
    await store.flush();
    assert.equal(JSON.parse(snapshots.at(-1)).error, h.error);
    for (const secret of [bearer, apiKey, opaqueKey]) {
      assert.equal(JSON.stringify({ snapshots, notices }).includes(secret), false, 'Generator state and notices must not contain synthetic credentials');
    }
    assert.equal(calls, 1);
  });
}

for (const [message, kind] of [['rate limit 429', 'usage-limit'], ['reasoning effort unsupported', 'effort'], ['not logged in 401', 'auth']]) {
  test(`Codex retains ${kind} classification without credentials`, async () => {
    reset(); cli = { code: 1, error: `${message}; ${diagnostic}` };
    await assert.rejects(new m.CodexBackend(() => settings('codex')).complete(req()), e => safe(e, kind, /Codex/));
  });
}
for (const [message, kind] of [['model unavailable', 'model'], ['missing api key 401', 'failed']]) {
  test(`OpenCode retains ${message} classification without credentials`, async () => {
    reset(); cli = { code: 1, error: `${message}; ${diagnostic}` };
    await assert.rejects(new m.OpenCodeBackend(() => settings('opencode')).complete(req()), e => safe(e, kind, /OpenCode/));
  });
}

test('OpenCode raw stdout fallback is redacted', async () => {
  reset(); cli = { code: 1, stdout: diagnostic };
  await assert.rejects(new m.OpenCodeBackend(() => settings('opencode')).complete(req()), e => safe(e));
});

test('DeepSeek invalid-response retry redacts its transport failure', async () => {
  reset(); http = async () => {
    if (calls === 1) return { status: 200, json: { choices: [{ message: { content: '' }, finish_reason: 'stop' }] } };
    throw Error(diagnostic);
  };
  await assert.rejects(new m.DeepSeekBackend(() => settings('deepseek')).complete(req()), e => safe(e));
  assert.equal(calls, 2);
});

test('Codex login-status transport throws are redacted', async () => {
  reset(); cli.quickThrow = Error(diagnostic);
  await assert.rejects(new m.CodexBackend(() => settings('codex')).probe(), e => safe(e));
});

test('OpenCode model-list transport throws are redacted', async () => {
  reset(); cli.quickThrow = Error(diagnostic);
  await assert.rejects(new m.OpenCodeBackend(() => settings('opencode')).listModels(), e => safe(e));
});
