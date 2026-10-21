import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const passage = { id: '1', path: 'notes/lecture.md', title: 'Lecture', text: 'Dormancy delays germination.', line: 3, page: null };
const args = authorized => ({ topic: 'dormancy', guide: 'Cover dormancy.\nCover growth.', passages: [passage], authorized });
const valid = { selections: [{ id: '1', quote: passage.text }], gaps: [2] };
async function fixture(provider, { prepare = () => {}, reply = () => valid } = {}) {
  const dispatches = [];
  const settings = { provider, codexPath: '/synthetic/codex', codexModel: 'synthetic-model', opencodePath: '/synthetic/opencode', opencodeModel: 'synthetic/model', deepseekApiKey: 'synthetic-test-key', deepseekModel: 'synthetic-model', effort: 'low' };
  const out = await build({ entryPoints: ['src/llm.ts'], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['obsidian'], logLevel: 'silent' });
  const mod = new Module('study-llm');
  const fs = { constants: { X_OK: 1 }, accessSync() {}, readFileSync: () => null, mkdtempSync: () => '/synthetic/scratch', mkdirSync() {}, writeFileSync() { prepare(); }, rmSync() {} };
  const childProcess = {
    execFile() { assert.fail('No external utility'); }, execFileSync() { assert.fail('No keychain access'); },
    spawn(_bin, argv) {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new EventEmitter();
      const dispatch = { argv, prompt: '' }; dispatches.push(dispatch);
      child.stdin.end = prompt => {
        dispatch.prompt = prompt;
        const result = reply();
        const text = typeof result === 'string' ? result : JSON.stringify(result);
        const event = provider === 'codex' ? { type: 'item.completed', item: { type: 'agent_message', text } } : { type: 'text', part: { type: 'text', text } };
        setImmediate(() => { child.stdout.write(JSON.stringify(event)); child.emit('close', 0, null); });
      };
      child.kill = () => true;
      return child;
    },
  };
  mod.require = id => id === 'fs' ? fs : id === 'child_process' ? childProcess : id === 'obsidian' ? { requestUrl: async req => {
    dispatches.push(req);
    const value = await reply();
    return { status: 200, json: { choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) }, finish_reason: 'stop' }] } };
  } } : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text, 'study-llm');
  const llm = new mod.exports.LlmClient(() => { if (provider === 'deepseek') prepare(); return settings; });
  return { llm, dispatches };
}
for (const provider of ['codex', 'deepseek', 'opencode']) {
  test(`real LLM ${provider}: revoked study cannot dispatch`, async () => {
    const f = await fixture(provider);
    await assert.rejects(f.llm.selectStudyEvidence(args(() => false)), /authorization/i);
    assert.deepEqual(f.dispatches, []);
  });
  test(`real LLM ${provider}: backend setup cannot renew source authorization`, async () => {
    let allowed = true;
    const f = await fixture(provider, { prepare: () => { allowed = false; } });
    await assert.rejects(f.llm.selectStudyEvidence(args(() => allowed)), /authorization/i);
    assert.deepEqual(f.dispatches, []);
  });
  test(`real LLM ${provider}: positive control validates exact evidence`, async () => {
    const f = await fixture(provider);
    assert.deepEqual(await f.llm.selectStudyEvidence(args(() => true)), valid);
    assert.equal(f.dispatches.length, 1);
    const prompt = f.dispatches[0].prompt || f.dispatches[0].body;
    assert.ok(prompt.includes(passage.text));
    assert.match(prompt, /coverage|Coverage/);
  });
  test(`real LLM ${provider}: revoked malformed response cannot retry`, async () => {
    let allowed = true;
    const f = await fixture(provider, { reply: () => { allowed = false; return 'not JSON'; } });
    await assert.rejects(f.llm.selectStudyEvidence(args(() => allowed)));
    assert.equal(f.dispatches.length, 1);
  });
  test(`real LLM ${provider}: a plausible but fabricated quote is rejected`, async () => {
    const f = await fixture(provider, { reply: () => ({ selections: [{ id: '1', quote: 'Dormancy promotes germination.' }], gaps: [] }) });
    await assert.rejects(f.llm.selectStudyEvidence(args(() => true)), /study.*quote/i);
    assert.equal(f.dispatches.length, 1);
  });
  test(`real LLM ${provider}: revoked valid response is not accepted`, async () => {
    let allowed = true;
    const f = await fixture(provider, { reply: () => { allowed = false; return valid; } });
    await assert.rejects(f.llm.selectStudyEvidence(args(() => allowed)), /authorization/i);
    assert.equal(f.dispatches.length, 1);
  });
}
test('real LLM rejects unbounded inputs before transport', async () => {
  const f = await fixture('deepseek');
  for (const invalid of [
    { ...args(() => true), guide: '' },
    { ...args(() => true), guide: 'x'.repeat(8001) },
    { ...args(() => true), passages: Array.from({ length: 41 }, (_, i) => ({ ...passage, id: String(i + 1) })) },
    { ...args(() => true), passages: [{ ...passage, text: 'x'.repeat(1201) }] },
    { ...args(() => true), passages: [{ ...passage, line: 0 }] },
  ]) await assert.rejects(f.llm.selectStudyEvidence(invalid), /study|guide|evidence/i);
  assert.deepEqual(f.dispatches, []);
});
