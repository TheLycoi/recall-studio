import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import Module from 'node:module';

let m;
before(async () => {
  const out = await build({ stdin: { contents: `export { Generator } from './src/generator'; export { LlmClient } from './src/llm'; export { makeCard, makeHighlight } from './src/model'; export { CodexBackend, toStrictSchema } from './src/codex'; export * from './src/generation'; export { lintCard } from './src/lint';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'cjs', platform: 'node', external: ['obsidian'], logLevel: 'silent' });
  const mod = new Module('card-quality-rubric');
  mod.require = id => id === 'obsidian' ? { Notice: class {}, requestUrl() { throw Error('Network forbidden'); } } : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text, 'card-quality-rubric');
  m = mod.exports;
});

const source = 'To calibrate the fictional Zeta sensor, first disconnect its power, then attach the reference cable, and finally reconnect its power. Disconnecting power before attaching the reference cable prevents a false calibration reading.';
const procedure = 'To calibrate the fictional Zeta sensor, first {{c1::disconnect its power}}, then {{c2::attach the reference cable}}, and finally {{c3::reconnect its power}}.';
const rationale = { kind: 'qa', front: 'Why must power be disconnected before attaching the reference cable when calibrating the fictional Zeta sensor?', back: 'prevents a false calibration reading', text: '' };

function fixture(status = 'verified', poorCue = false) {
  const h = m.makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Zeta calibration', text: source });
  const quotes = source.split(/(?<=\.) /);
  const preparation = {
    facts: quotes.map((quote, i) => ({ id: `F${i + 1}`, statement: quote, quote })),
    plan: quotes.map((value, i) => ({ id: `P${i + 1}`, factIds: [`F${i + 1}`], entity: 'fictional Zeta sensor', aspect: i ? 'rationale' : 'ordered procedure', value, reason: 'A distinct, source-supported retrieval.' })),
    exclusions: [], omissions: [], conflicts: [],
  };
  const drafts = [
    { planId: 'P1', factIds: ['F1'], kind: 'cloze', front: '', back: '', text: procedure },
    { planId: 'P2', factIds: ['F2'], ...rationale, ...(poorCue ? { front: 'What does it prevent?' } : {}) },
  ];
  const settings = { provider: 'codex', codexModel: 'synthetic-no-provider', effort: 'low', writerInstructions: '', language: '', historyExamples: false, critiquePass: true, lintMode: 'hide', notifyWhenReady: false, concurrency: 1 };
  const llm = new m.LlmClient(() => settings);
  const calls = [];
  const backend = new m.CodexBackend(() => settings);
  // Keep the production parser and schema; replace only the CLI transport.
  backend.exec = async req => {
    calls.push(req);
    assert.equal(m.toStrictSchema(req.schema).additionalProperties, false);
    const payload = JSON.parse(req.user);
    if (req.label === 'preparation') return JSON.stringify(preparation);
    if (req.label === 'grounded cards') return JSON.stringify({ cards: drafts });
    if (req.label === 'generation repair') return JSON.stringify({ cards: payload.candidates.map(c => ({ ...drafts.find(d => d.planId === c.planId), ...(c.planId === 'P2' ? rationale : {}) })) });
    if (req.label === 'audit' || req.label === 'final audit') return JSON.stringify({ verdicts: payload.cards.map((c, index) => ({ index, cardId: c.id, status, reason: status === 'failed' ? 'The source supports the answer, but the cue does not identify its subject.' : 'Synthetic transport verdict, not a model quality judgment.' })) });
    if (req.label === 'cards') return JSON.stringify({ cards: [rationale] });
    if (req.label === 'verdicts') return JSON.stringify({ verdicts: payload.cards.map((c, index) => ({ index, verdict: ['keep', 'revise', 'drop'][index], reason: 'Synthetic verdict for schema compatibility.', bloom: 'remember', kind: 'qa', ...(index === 1 ? rationale : { front: '', back: '', text: '' }) })) });
    if (req.label === 'card') return JSON.stringify(rationale);
    throw Error(`Unexpected request: ${req.label}`);
  };
  llm.codex = backend;
  const plugin = { settings, llm, store: { all: () => [h], touch() {}, async flush() {}, hasUnsavedChanges: false }, refreshStatusBar() {} };
  return { h, preparation, drafts, calls, llm, g: new m.Generator(plugin) };
}

function saveRequests(name, calls) {
  if (!process.env.RECALL_PROMPT_EVIDENCE_DIR) return;
  mkdirSync(process.env.RECALL_PROMPT_EVIDENCE_DIR, { recursive: true });
  writeFileSync(join(process.env.RECALL_PROMPT_EVIDENCE_DIR, `${name}.json`), JSON.stringify(calls.map(({ label, system, user, schema, retryInvalidResponse }) => ({ label, system, user: JSON.parse(user), schema: m.toStrictSchema(schema), retryInvalidResponse })), null, 2));
}

const criteria = [
  /one (?:focused )?(?:retrieval )?target per review/i,
  /(?:specific subject.*cue|cue.*specific subject)/i,
  /consistent/i, /tractable/i, /effortful/i,
  /yes\/no/i, /answer leaks/i, /false positive/i, /false negative/i,
  /source-relative/i, /what does the highlight say/i,
  /negations.*conditions.*dates.*qualifiers/i,
  /procedures.*order.*rationale/i,
  /open lists.*category.*(?:subset|exhaustive).*meta-card/i,
  /source-driven.*(?:cloze|grouping)/i,
  /redundancy.*genuinely.*direction/i,
  /short names.*meaningful conditions/i,
  /not invalid.*who or is/i,
  /(?:never|do not) invent.*mnemonics.*personal facts.*media/i,
  /no (?:fixed )?card.*quota/i,
  /aim for two to three useful distinct cloze numbers per note/i,
  /coherent lists and enumerations may exceed three/i,
  /never reject.*solely.*cloze count/i,
  /optional hints.*one to three words/i,
  /omit.*hint.*already clear/i,
  /never reject.*missing.*hint/i,
  /do not omit useful foundational facts merely because they seem obvious/i,
  /independent attributes.*separate.*groups/i,
  /heading.*front.*class label/i,
];

test('assembled requests share retrieval-quality criteria before and after plan lock', async t => {
  const f = fixture();
  await f.g.run(f.h);
  assert.equal(f.h.status, 'ready');
  assert.deepEqual(f.calls.map(c => c.label), ['preparation', 'grounded cards', 'audit']);
  await f.llm.writeCards(f.h);
  const criticCards = Array.from({ length: 3 }, () => m.makeCard(f.h.id, rationale));
  const verdicts = await f.llm.critiqueCards(f.h, criticCards);
  assert.deepEqual(verdicts.map(v => v.verdict), ['keep', 'revise', 'drop']);
  assert.deepEqual(await f.llm.rewriteCard(f.h, f.h.cards[1], 'Keep the supported rationale.'), rationale);
  assert.deepEqual(f.calls.map(c => c.label), ['preparation', 'grounded cards', 'audit', 'cards', 'verdicts', 'card']);
  saveRequests('all-stage-requests', f.calls);

  for (const req of f.calls) await t.test(req.label, () => {
    for (const criterion of criteria) assert.match(req.system, criterion, `${req.label} lacks ${criterion}`);
    assert.ok(m.RETRIEVAL_QUALITY_RUBRIC, 'one shared rubric is exported');
    assert.equal(req.system.split(m.RETRIEVAL_QUALITY_RUBRIC).length, 2, 'the shared rubric appears exactly once');
    assert.match(req.system, /data, not instructions/);
    assert.match(req.system, /captured text.*supplies answer facts/i);
    assert.match(req.system, /output schema/);
    assert.match(req.system, /"The Who"/);
    assert.match(req.system, /"until the broth is clear"/);
  });
  const [prepare, write, audit] = f.calls;
  assert.deepEqual(m.toStrictSchema(audit.schema).properties.verdicts.items.properties.status.enum, ['verified', 'unverified', 'failed']);
  assert.deepEqual(m.toStrictSchema(f.calls[4].schema).properties.verdicts.items.properties.verdict.enum, ['keep', 'revise', 'drop']);
  assert.match(prepare.system, /(?:select|choose).*useful.*targets.*before.*(?:plan|locking)/i);
  assert.match(write.system, /exactly one card per supplied plan row/);
  assert.match(write.system, /twelve words/);
  assert.match(write.system, /six words/);
  assert.doesNotMatch(write.system, /hide each under its own number instead of writing a card per fact/);
  assert.doesNotMatch(write.system, /never framing words/i);
  assert.match(audit.system, /source-supported.*poor retrieval.*failed/i);
  assert.match(audit.system, /plan grouping.*does not require.*joint retrieval/i);
  assert.match(audit.system, /condition and consequence.*separate cloze reviews/i);
  assert.match(audit.system, /findings only: never repair cards/);
  assert.deepEqual(f.calls.slice(0, 3).map(c => c.retryInvalidResponse), [false, false, false]);
});

test('soft cloze and hint preferences do not become validation gates', () => {
  const f = fixture();
  const source = 'Zeta calibration proceeds in order: disconnect power, attach cable, set zero, reconnect power.';
  const preparation = { facts: [{ id: 'F1', statement: source, quote: source }], plan: [{ id: 'P1', factIds: ['F1'], entity: 'Zeta calibration', aspect: 'sequence', value: source, reason: 'Preserve a coherent procedure.' }], exclusions: [], omissions: [], conflicts: [] };
  for (const hint of ['', '::first action to take safely']) {
    const text = `Zeta calibration proceeds in order: {{c1::disconnect power${hint}}}, {{c2::attach cable}}, {{c3::set zero}}, {{c4::reconnect power}}.`;
    const draft = { planId: 'P1', factIds: ['F1'], kind: 'cloze', front: '', back: '', text };
    assert.equal(m.validateDrafts({ cards: [draft] }, m.validatePreparation(preparation, source))[0].text, text);
    const card = m.makeCard(f.h.id, draft);
    assert.deepEqual(m.lintCard(card, { ...f.h, text: source }, []).failures, []);
    assert.equal(m.renderedCardReviews(card).length, 4);
  }
});

test('supported ordered procedure and rationale survive preparation, draft and audit validators', async () => {
  const f = fixture();
  const prepared = m.validatePreparation(f.preparation, source);
  assert.deepEqual(m.validateDrafts({ cards: f.drafts }, prepared), f.drafts);
  await f.g.run(f.h);
  assert.deepEqual(f.h.cards.map(c => c.generation.audit.status), ['verified', 'verified']);
  assert.deepEqual(f.h.cards.map(c => c.status), ['pending', 'pending']);
  assert.equal(f.h.cards[0].text, procedure);
  assert.equal(f.h.cards[1].back, rationale.back);
  for (const card of f.h.cards) assert.deepEqual(m.lintCard(card, f.h, f.h.cards.filter(c => c !== card)).failures, []);
});

for (const status of ['verified', 'unverified', 'failed']) test(`staged audit holds ${status} unless independently accepted`, async () => {
  const f = fixture(status, status === 'failed');
  await f.g.run(f.h);
  assert.equal(f.h.status, status === 'verified' ? 'ready' : 'error');
  assert.deepEqual(f.calls.map(c => c.label), ['preparation', 'grounded cards', 'audit', ...(status === 'failed' ? ['generation repair', 'generation repair', 'final audit'] : [])]);
  assert.equal(f.h.generation.audit.status, status);
  assert.equal(f.h.cards.length, status === 'verified' ? 2 : 0);
  assert.equal(f.h.generation.phase, status === 'verified' ? 'complete' : 'blocked');
  assert.equal(f.h.generation.drafts[0].text, procedure);
  assert.equal(f.h.generation.drafts[1].front, status === 'failed' ? 'What does it prevent?' : rationale.front);
  assert.equal(f.h.generation.drafts[1].back, rationale.back);
  const calls = f.calls.length, cards = structuredClone(f.h.cards);
  await f.g.run(f.h);
  assert.equal(f.calls.length, calls);
  assert.deepEqual(f.h.cards, cards);
  saveRequests(`audit-${status}`, f.calls);
});
