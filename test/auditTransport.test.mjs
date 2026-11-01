// Production transport parsing with synthetic replies; no provider or user-store calls.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';

let m;
before(async () => {
  const out = await build({ stdin: { contents: `export * from './src/generation'; export * from './src/model'; export {Generator} from './src/generator'; export {LlmClient} from './src/llm'; export {parseInboxJson} from './src/inboxData'; export {toStrictSchema} from './src/codex';`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'], logLevel: 'silent' });
  const mod = new Module('audit-transport');
  mod.require = id => id === 'obsidian' ? { Notice: class {}, requestUrl() { throw Error('Network forbidden'); } } : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text, 'audit-transport'); m = mod.exports;
});

function fixture(mutate, { conflict = true } = {}) {
  const source = conflict ? 'Amber stores heat. Amber does not store heat.' : 'Amber stores heat.';
  const h = m.makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Synthetic Amber', text: source });
  const preparation = { facts: [{ id: 'F1', statement: 'Amber stores heat.', quote: 'Amber stores heat.' }], plan: [{ id: 'P1', factIds: ['F1'], entity: 'Amber', aspect: 'stored energy', value: 'heat', reason: 'Test the stated storage.' }], exclusions: [], omissions: [], conflicts: [] };
  const draft = { kind: 'qa', front: 'What does Amber store?', back: 'heat', text: '', planId: 'P1', factIds: ['F1'] };
  const settings = { provider: 'codex', codexModel: 'synthetic', language: '', concurrency: 1, notifyWhenReady: false };
  const llm = new m.LlmClient(() => settings), calls = [];
  let retry = false, auditSchema;
  // Replace execution only: CodexBackend.complete still parses JSON and the real request schema.
  llm.codex.exec = async req => {
    const u = JSON.parse(req.user); calls.push({ label: req.label, input: u });
    if (req.label === 'preparation') return JSON.stringify(preparation);
    if (req.label === 'grounded cards') return JSON.stringify({ cards: [draft] });
    assert.equal(req.label, 'audit', 'A source-held candidate must not reach wording repair');
    auditSchema = req.schema;
    return JSON.stringify({ verdicts: u.cards.map(c => {
      const v = { index: c.index, cardId: c.id, contractVersion: 1, status: retry || !conflict ? 'verified' : 'failed', reason: 'Synthetic assessment.',
        conflicts: retry || !conflict ? [] : [{ kind: 'contradiction', quote: source, reason: 'Captured source both affirms and denies storage.' }], reassessments: [],
        reviews: c.reviews.map(r => ({ ordinal: r.ordinal, status: 'verified', reason: 'Synthetic review.', identifyingCue: 'Amber', relationCue: 'store', answerable: true, effortful: true })),
        checks: c.checks.map(x => ({ id: x.id, resolution: 'accepted', reason: 'Synthetic decision.' })) };
      if (!retry) mutate?.(v);
      return v;
    }) });
  };
  const plugin = { settings, llm, store: { all: () => [h], touch() {}, notify() {}, async flush() {}, hasUnsavedChanges: false }, refreshStatusBar() {} };
  const g = new m.Generator(plugin); g.kick = () => {};
  return { h, g, calls, schema: () => auditSchema, retry: async () => { retry = true; g.retry(h); await g.run(h); } };
}

const malformed = {
  boolean: v => { v.reviews[0].answerable = 'not a boolean'; },
  reviews: v => { v.reviews = null; },
  check: v => { v.checks = [{ id: 'x', resolution: 'invented', reason: 'Invalid quality decision.' }]; },
  version: v => { v.contractVersion = '1'; },
  status: v => { v.status = 'invented'; },
  reassessment: v => { v.reassessments = [{ findingId: 'invented' }]; },
};
for (const [name, mutate] of Object.entries(malformed)) test(`real transport retains source hold across malformed ${name}, reload and retry`, async () => {
  const f = fixture(mutate); await f.g.run(f.h);
  assert.equal(f.h.cards.length, 0);
  assert.equal(f.h.generation.audit.sourceFindings?.length, 1, 'Valid source concern survives transport parsing');
  const saved = m.parseInboxJson(JSON.stringify({ version: 1, highlights: [f.h] }));
  assert.equal(saved.ok, true); Object.assign(f.h, saved.data.highlights[0]);
  await f.retry();
  assert.equal(f.h.cards.length, 0, 'Generic approval cannot clear the retained source concern');
  assert.equal(f.calls.at(-1).input.sourceFindings.length, 1);
  assert.deepEqual(f.calls.map(c => c.label), ['preparation', 'grounded cards', 'audit', 'audit']);
});

test('valid complete transport audit still publishes and keeps the exact strict wire schema', async () => {
  const f = fixture(undefined, { conflict: false }); await f.g.run(f.h);
  assert.equal(f.h.cards.length, 1, f.h.error);
  assert.deepEqual(m.toStrictSchema(f.schema()), m.toStrictSchema(m.AuditOut));
});

test('malformed quality without a source finding stays held until explicit valid retry', async () => {
  const f = fixture(malformed.boolean, { conflict: false }); await f.g.run(f.h);
  assert.equal(f.h.cards.length, 0);
  assert.equal(f.h.generation.audit.sourceFindings?.length ?? 0, 0);
  await f.g.run(f.h);
  assert.equal(f.calls.length, 3, 'Automatic resume cannot spend another request');
  await f.retry(); assert.equal(f.h.cards.length, 1);
});

for (const defect of ['foreign-card', 'fake-quote']) test(`transport recovery does not retain a ${defect} source finding`, async () => {
  const f = fixture(v => {
    malformed.boolean(v);
    if (defect === 'foreign-card') v.cardId = 'another-card';
    else v.conflicts[0].quote = 'Absent from captured evidence.';
  });
  await f.g.run(f.h); assert.equal(f.h.cards.length, 0);
  assert.equal(f.h.generation.audit.sourceFindings?.length ?? 0, 0);
});
