// Production boundary regressions: synthetic transport, in-memory vault, no model or vault access.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import Module, { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const require = createRequire(root + '/package.json');
const { build } = require('esbuild');
const { element } = await import(pathToFileURL(root + '/test/quizHarness.mjs'));
const { auditVerdict } = await import(pathToFileURL(root + '/test/auditFixture.mjs'));
const evidence = [];
let m;
const source = 'The Neral relay stores heat. Its indicator color is blue.';
const concern = { kind: 'insufficient', quote: 'The Neral relay stores heat.', reason: 'Synthetic unresolved qualification of the storage claim.' };
const notices = [];
before(async () => {
  globalThis.window = { setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame() {} };
  const out = await build({ stdin: { contents: `
export { Generator } from './src/generator';
export { LlmClient, describeError } from './src/llm';
export { CodexBackend } from './src/codex';
export { InboxStore } from './src/store';
export { InboxView } from './src/inboxView';
export { makeHighlight, makeCard } from './src/model';
export { parseInboxJson } from './src/inboxData';
export { resolveCardEvidence } from './src/cardEvidence';
export { sourceConcernsForCard, generationKey } from './src/generation';
export { summarizeExport } from './src/exportSummary';
`, resolveDir: root }, bundle: true, write: false, format: 'cjs', platform: 'node', external: ['obsidian'], logLevel: 'silent' });
  const mod = new Module('generation-baseline-audit');
  const host = { ItemView: class { constructor(leaf) { this.contentEl = leaf.contentEl; } registerDomEvent() {} registerEvent() {} },
    Notice: class { constructor(text) { notices.push(text); } hide() {} }, normalizePath: x => x,
    requestUrl() { throw Error('Network forbidden by audit'); }, setIcon() {} };
  mod.require = id => id === 'obsidian' ? new Proxy(host, { get: (o, k) => o[k] ?? class {} }) : require(id);
  mod._compile(out.outputFiles[0].text, 'generation-baseline-audit');
  m = mod.exports;
});
function settings() { return { provider: 'codex', codexModel: 'synthetic-no-network', effort: 'low', language: '', concurrency: 1, lintMode: 'off', critiquePass: false, notifyWhenReady: false }; }
async function storage(files = new Map()) {
  const adapter = { exists: async p => files.has(p), mkdir: async () => {}, read: async p => files.get(p),
    write: async (p, text) => { files.set(p, text); }, remove: async p => { files.delete(p); },
    rename: async (a, b) => { assert.ok(files.has(a)); assert.ok(!files.has(b)); files.set(b, files.get(a)); files.delete(a); } };
  const app = { vault: { adapter, getFiles: () => [], configDir: '.obsidian' }, workspace: {}, metadataCache: {} };
  const store = new m.InboxStore(app, 'synthetic'); await store.load();
  return { store, files, app };
}
async function fixture({ two = false, audit } = {}) {
  const disk = await storage();
  const h = m.makeHighlight({ sourcePath: 'synthetic/Neral.md', sourceTitle: 'Neral relay', text: source });
  disk.store.add(h);
  const s = settings(), calls = [], client = new m.LlmClient(() => s), backend = new m.CodexBackend(() => s);
  let auditCount = 0;
  const facts = [{ id: 'F1', statement: 'The Neral relay stores heat.', quote: 'The Neral relay stores heat.' }];
  if (two) facts.push({ id: 'F2', statement: 'Its indicator color is blue.', quote: 'Its indicator color is blue.' });
  const preparation = { facts, plan: facts.map((f, i) => ({ id: `P${i + 1}`, factIds: [f.id], entity: 'Neral relay', aspect: i ? 'indicator color' : 'storage', value: i ? 'blue' : 'heat', reason: 'Synthetic source-supported target.' })), exclusions: [], omissions: [], conflicts: [] };
  backend.exec = async req => {
    const payload = JSON.parse(req.user); calls.push({ label: req.label, payload, roleModel: req.model });
    if (req.label === 'preparation') return JSON.stringify(preparation);
    if (req.label === 'grounded cards') return JSON.stringify({ cards: facts.map((f, i) => ({ planId: `P${i + 1}`, factIds: [f.id], kind: 'qa', front: i ? 'What is the indicator color of the Neral relay?' : 'What does the Neral relay store?', back: i ? 'blue' : 'heat', text: '' })) });
    if (req.label === 'audit' || req.label === 'final audit') {
      auditCount++;
      const verdicts = payload.cards.map((c, index) => auditVerdict(c, { index, cardId: c.id, status: 'verified', reason: 'Synthetic acceptance control, not model quality evidence.' }));
      return JSON.stringify(audit ? audit({ verdicts, payload, auditCount }) : { verdicts });
    }
    if (req.label === 'rewrite cards') return JSON.stringify({ cards: [{ kind: 'qa', front: 'Which substance does the Neral relay store?', back: 'heat', text: '' }] });
    if (req.label === 'rewrite audit') return JSON.stringify({ preservesFacts: true, followsInstruction: true, reason: 'Synthetic positive guard control.', verdicts: [{ index: 0, verdict: 'keep', reason: '' }] });
    throw Error('Unexpected dispatch ' + req.label);
  };
  client.codex = backend;
  const plugin = { ...disk, settings: s, llm: client, refreshStatusBar() {} };
  return { ...disk, h, settings: s, calls, client, backend, plugin, g: new m.Generator(plugin) };
}
async function retry(f) {
  f.g.retry(f.h);
  while (f.g.pending.size) await Promise.all([...f.g.pending]);
}
function record(value) { evidence.push(value); }

test('GEN-001: queue observes failures without exposing exception data', async () => {
  const f = await fixture();
  const canary = 'SYNTHETIC_PRIVATE_SOURCE_CANARY';
  const error = Object.assign(new Error(canary), { providerPayload: { excerpt: canary } });
  const errors = [], saved = console.error;
  const unsubscribe = f.store.onChange(() => { throw error; });
  console.error = (...args) => errors.push(args);
  try { f.g.start(); await new Promise(r => setImmediate(r)); await f.g.stop(); }
  finally { console.error = saved; unsubscribe(); f.store.close(); }
  const leaked = errors.find(args => args[0] === 'Recall Studio: generation failed');
  assert.deepEqual(leaked, ["Recall Studio: generation failed"]);
  assert.equal(JSON.stringify(errors).includes(canary), false);
  assert.equal(f.g.pending.size, 0); assert.equal(f.g.running.size, 0);
  assert.equal(f.calls.length, 0);
});

for (const holdFirst of [false, true]) test(`GEN-002: duplicate audit envelopes retain source holds in either order; first=${holdFirst}`, async () => {
  const f = await fixture({ audit: ({ verdicts, auditCount }) => {
    if (auditCount > 1) return { verdicts };
    const held = { ...structuredClone(verdicts[0]), status: 'unverified', conflicts: [concern] };
    return { verdicts: holdFirst ? [held, verdicts[0]] : [verdicts[0], held] };
  } });
  await f.g.run(f.h);
  assert.equal(f.h.cards.length, 0);
  const first = structuredClone(f.h.generation.audit);
  assert.equal(first.status, 'unverified');
  assert.equal(first.sourceFindings?.length ?? 0, 1);
  assert.match(first.reason, /duplicate card verdict/);
  const draftId = f.h.generation.drafts[0].id;
  const parsed = m.parseInboxJson(f.files.get('synthetic/inbox.json')); assert.equal(parsed.ok, true);
  assert.equal(parsed.data.highlights[0].generation.drafts[0].id, draftId);
  await retry(f);
  assert.equal(f.h.cards.length, 0);
  const final = f.calls.filter(c => c.label === 'audit').at(-1);
  assert.equal(final.payload.cards[0].id, draftId);
  assert.equal(final.payload.sourceFindings.length, 1);
  await f.store.flush(); f.store.close();
  const loaded = await storage(f.files), h = loaded.store.all()[0];
  assert.equal(h.cards.length, 0); assert.equal(h.generation.drafts[0].id, draftId);
  record({ id: 'GEN-002', holdFirst, producerCardId: draftId, initialHeld: true, retainedSourceFindings: first.sourceFindings?.length ?? 0, retrySourceFindings: final.payload.sourceFindings.length, publishedAfterGenericRetry: h.cards.length, calls: f.calls.map(c => c.label), parserAndStoreReloadPassed: true });
  loaded.store.close();
});

test('GEN-003: explicit receipt fork and split refuse unresolved source concerns', async () => {
  const f = await fixture({ two: true, audit: ({ verdicts, auditCount }) => {
    if (auditCount === 1) verdicts[1].reviews = []; // A publishes; B lacks coverage and stays held.
    else { verdicts[0].status = 'unverified'; verdicts[0].conflicts = [concern]; }
    return { verdicts };
  } });
  await f.g.run(f.h); assert.equal(f.h.cards.length, 1);
  const original = f.h.cards[0], originalId = original.id;
  await retry(f); assert.equal(f.h.cards.length, 2); assert.equal(f.h.status, 'ready');
  const holds = m.sourceConcernsForCard(original, f.h); assert.equal(holds.length, 1);
  original.ankiNoteId = 123; // Synthetic receipt: no Anki call is made.
  f.store.touch(); await f.store.flush();
  const before = structuredClone(original), sibling = structuredClone(f.h.cards[1]);
  const initialWarnings = m.summarizeExport([f.h], new Set([original.id])).warnings;
  assert.ok(initialWarnings.some(w => w.reasons.some(r => r.includes(concern.reason))));
  const view = new m.InboxView({ contentEl: element() }, f.plugin);
  const callsBefore = f.calls.length;
  for (const instruction of ['Reword the question.', 'Split into separate cards.']) {
    const result = await view.rewrite(f.h, original, instruction, () => true);
    assert.notEqual(result, true);
    assert.deepEqual(original, before); assert.deepEqual(f.h.cards[1], sibling);
    assert.equal(f.calls.length, callsBefore);
    assert.equal(f.store.revisions().length, 0);
  }
  await assert.rejects(f.client.rewriteCards(f.h, original, 'Split into separate cards.'), /source concern/i);
  assert.equal(f.calls.length, callsBefore);
  await f.store.flush(); f.store.close();
  const loaded = await storage(f.files), h = loaded.store.all()[0];
  assert.equal(h.cards.length, 2); assert.deepEqual(h.cards[0], before);
  assert.equal(m.sourceConcernsForCard(h.cards[0], h).length, 1);
  assert.ok(m.summarizeExport([h], new Set([originalId])).warnings.some(w => w.reasons.some(r => r.includes(concern.reason))));
  loaded.store.close();
});

test('control: actual generated identities survive transport, store, parser and evidence consumer', async () => {
  const f = await fixture(); await f.g.run(f.h); assert.equal(f.h.cards.length, 1);
  const generated = structuredClone(f.h.cards[0]);
  assert.equal(m.resolveCardEvidence(f.h, generated).facts[0].id, 'F1');
  const requestId = f.calls.find(c => c.label === 'audit').payload.cards[0].id; assert.equal(requestId, generated.id);
  assert.equal(m.parseInboxJson(f.files.get('synthetic/inbox.json')).ok, true);
  f.store.close(); const loaded = await storage(f.files), h = loaded.store.all()[0];
  assert.deepEqual(h.cards[0], generated); assert.equal(m.resolveCardEvidence(h, h.cards[0]).state, 'resolved');
  record({ control: 'producer-store-consumer', producerId: generated.id, planId: generated.generation.planId, factIds: generated.generation.factIds, batchId: generated.generation.batchId, calls: f.calls.map(c => c.label), passed: true });
  loaded.store.close();
});

test('control: cancellation during first awaited context read prevents all transport', async () => {
  const f = await fixture(); let release; const barrier = new Promise(r => release = r);
  const original = f.client.generationContext.bind(f.client);
  f.client.generationContext = async (...args) => { await barrier; return original(...args); };
  const pending = f.g.run(f.h); f.settings.language = 'French'; release(); await pending;
  assert.equal(f.calls.length, 0); assert.equal(f.h.cards.length, 0); assert.equal(f.h.status, 'error');
  record({ control: 'first-context-cancellation', transportCalls: 0, published: 0, passed: true }); f.store.close();
});

test('control: mid-transport settings edit prevents parsing result persistence and later stages', async () => {
  const f = await fixture(); let entered, release;
  const ready = new Promise(r => entered = r), barrier = new Promise(r => release = r);
  const exec = f.backend.exec;
  f.backend.exec = async req => { const result = await exec(req); entered(); await barrier; return result; };
  const pending = f.g.run(f.h); await ready; f.settings.language = 'French'; release(); await pending;
  assert.deepEqual(f.calls.map(c => c.label), ['preparation']); assert.equal(f.h.generation.preparation, undefined); assert.equal(f.h.cards.length, 0);
  record({ control: 'mid-transport-cancellation', calls: f.calls.map(c => c.label), savedPreparation: false, published: 0, passed: true }); f.store.close();
});

test('control: source revocation during publication persistence rolls back new cards on disk', async () => {
  const f = await fixture();
  const retained = m.makeCard(f.h.id, { kind: 'qa', front: 'Retained question?', back: 'Retained answer', ankiNoteId: 321 });
  f.h.cards.push(retained); const before = structuredClone(retained);
  const write = f.app.vault.adapter.write; let revoked = false;
  f.app.vault.adapter.write = async (path, text) => {
    const value = JSON.parse(text);
    await write(path, text);
    if (!revoked && value.highlights[0].cards.some(c => c.id !== retained.id)) {
      revoked = true; f.h.text = 'A newer user-edited capture must survive.';
    }
  };
  await f.g.run(f.h);
  assert.equal(revoked, true); assert.deepEqual(f.h.cards, [before]);
  const parsed = m.parseInboxJson(f.files.get('synthetic/inbox.json')); assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.data.highlights[0].cards, [before]);
  assert.equal(parsed.data.highlights[0].text, f.h.text);
  assert.equal(f.h.generation.committed, false);
  record({ control: 'publication-persistence-cancellation', publicationBoundaryReached: true, newCardsRolledBackInMemoryAndStorage: true, retainedCardAndNewerCapturePreserved: true, passed: true });
  f.store.close();
});

test('control: malformed response consumes one staged call and preserves originals/siblings', async () => {
  const f = await fixture();
  const retained = m.makeCard(f.h.id, { kind: 'qa', front: 'Retained question?', back: 'Retained answer', ankiNoteId: 321 });
  f.h.cards.push(retained); const before = structuredClone(retained); let count = 0;
  f.backend.exec = async () => { count++; return '{ malformed JSON'; };
  await f.g.run(f.h); assert.equal(count, 1); assert.deepEqual(f.h.cards, [before]); assert.equal(f.h.generation.preparation, undefined);
  record({ control: 'malformed-staged-response', calls: count, originalAndSiblingPreserved: true, passed: true }); f.store.close();
});
