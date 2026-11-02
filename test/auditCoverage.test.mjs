// Real request assembly, backend parsing and orchestration; synthetic replies only.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';

let m;
before(async () => {
  const out = await build({ stdin: { contents: `export * from './src/generation'; export * from './src/model'; export * from './src/qualityAcceptance'; export {Generator} from './src/generator'; export {LlmClient} from './src/llm'; export {parseInboxJson} from './src/inboxData'; export {schemaJson} from './src/jsonOut';`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'], logLevel: 'silent' });
  const mod = new Module('audit-coverage');
  mod.require = id => id === 'obsidian' ? { Notice: class {}, requestUrl() { throw Error('Network forbidden'); } } : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text, 'audit-coverage'); m = mod.exports;
});

function fixture(mutate, { provider = 'codex', repair = false } = {}) {
  const h = m.makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Synthetic storage', text: 'Amber stores heat. Zephyr stores light.' });
  const preparation = { facts: [{ id: 'F1', statement: 'Amber stores heat.', quote: 'Amber stores heat.' }, { id: 'F2', statement: 'Zephyr stores light.', quote: 'Zephyr stores light.' }], plan: [{ id: 'P1', factIds: ['F1'], entity: 'Amber', aspect: 'stored energy', value: 'heat', reason: 'Recall stated storage.' }, { id: 'P2', factIds: ['F2'], entity: 'Zephyr', aspect: 'stored energy', value: 'light', reason: 'Recall stated storage.' }], exclusions: [], omissions: [], conflicts: [] };
  const drafts = [{ kind: 'qa', front: 'What does Amber store?', back: 'heat', text: '', planId: 'P1', factIds: ['F1'] }, { kind: 'cloze', front: '', back: '', text: 'The energy stored by Zephyr is {{c1::light}}.', planId: 'P2', factIds: ['F2'] }];
  const settings = { provider, codexModel: 'synthetic', language: '', concurrency: 1, notifyWhenReady: false };
  const llm = new m.LlmClient(() => settings), calls = [];
  let retried = false, response, outputSchema;
  const transport = async (req, label, wireSchema) => {
    const u = JSON.parse(req.user); calls.push({ label: req.label, input: u });
    if (req.label === 'preparation') return JSON.stringify(preparation);
    if (req.label === 'grounded cards') return JSON.stringify({ cards: drafts });
    if (repair && req.label === 'generation repair') return JSON.stringify({ cards: [{ ...drafts[0], front: 'Which form of energy does Amber store?' }] });
    assert.ok(req.label === 'audit' || (repair && req.label === 'final audit'), 'Malformed assessment alone must not start a writer repair');
    outputSchema = wireSchema;
    response = { verdicts: u.cards.map((c, i) => ({ index: c.index, cardId: c.id, contractVersion: 1, status: 'verified', reason: 'Synthetic positive control.', conflicts: [], reassessments: [],
      reviews: c.reviews.map(r => ({ ordinal: r.ordinal, status: 'verified', reason: 'Synthetic review.', identifyingCue: i === 0 ? 'Amber' : 'Zephyr', relationCue: i === 0 ? 'store' : 'energy stored', answerable: true, effortful: true })),
      checks: c.checks.map(x => ({ id: x.id, resolution: 'accepted', reason: 'Synthetic decision.' })) })) };
    if (!retried) mutate?.(response, u, req.label);
    return JSON.stringify(response);
  };
  if (provider === 'deepseek') llm.deepseek.jsonText = transport;
  else if (provider === 'opencode') llm.opencode.exec = (req, prompt) => {
    const wire = req.outputSchema ?? req.schema;
    assert.ok(prompt.includes(JSON.stringify(m.schemaJson(wire), null, 2)), 'OpenCode prompt must include the output contract');
    return transport(req, req.label, wire);
  };
  else llm.codex.exec = transport;
  const plugin = { settings, llm, store: { all: () => [h], touch() {}, notify() {}, async flush() {}, hasUnsavedChanges: false }, refreshStatusBar() {} };
  const g = new m.Generator(plugin); g.kick = () => {};
  return { h, g, calls, response: () => response, outputSchema: () => outputSchema, retry: async () => { retried = true; g.retry(h); await g.run(h); } };
}

test('a missing review holds its card without discarding a valid sibling', async () => {
  const f = fixture(r => { r.verdicts[0].reviews = []; }); await f.g.run(f.h);
  assert.equal(f.h.cards.length, 1, f.h.error);
  assert.equal(f.h.cards[0].generation.planId, 'P2');
  assert.equal(f.h.generation.blocked.length, 1);
  const rejected = f.h.generation.audit.verdicts.find(v => v.index === 0);
  assert.equal(rejected.status, 'unverified');
  assert.match(rejected.reason, /rendered-review coverage/);
  assert.deepEqual(f.calls.map(c => c.label), ['preparation', 'grounded cards', 'audit']);
});

test('a malformed final audit holds the repaired candidate without discarding a clean sibling', async () => {
  const f = fixture((r, u, label) => {
    if (label === 'audit') { r.verdicts[0].status = 'failed'; r.verdicts[0].reviews[0].status = 'failed'; }
    else r.verdicts[0].reviews = [];
  }, { repair: true });
  await f.g.run(f.h);
  assert.equal(f.h.cards.length, 1); assert.equal(f.h.cards[0].generation.planId, 'P2');
  assert.equal(f.h.generation.blocked.length, 1);
  assert.equal(f.h.generation.repairs.length, 1);
  assert.equal(f.h.generation.finalAudit.verdicts[0].status, 'unverified');
  assert.deepEqual(f.calls.map(c => c.label), ['preparation', 'grounded cards', 'audit', 'generation repair', 'final audit']);
});

test('the provider output schema constrains this batch without replacing tolerant parsing', async () => {
  const f = fixture(); await f.g.run(f.h);
  const schema = f.outputSchema(), wire = m.schemaJson(schema);
  assert.equal(wire.properties.verdicts.minItems, 2);
  assert.equal(wire.properties.verdicts.maxItems, 2);
  assert.equal(schema.safeParse(f.response()).success, true);
  const missingReview = structuredClone(f.response()); missingReview.verdicts[0].reviews = [];
  assert.equal(schema.safeParse(missingReview).success, false);
  const extraCheck = structuredClone(f.response()); extraCheck.verdicts[1].checks.push({ id: 'invented', resolution: 'accepted', reason: 'Not supplied.' });
  assert.equal(schema.safeParse(extraCheck).success, false);
  const wrongCard = structuredClone(f.response()); wrongCard.verdicts[0].cardId = 'foreign';
  assert.equal(schema.safeParse(wrongCard).success, false);
  const wrongOrdinal = structuredClone(f.response()); wrongOrdinal.verdicts[1].reviews[0].ordinal = 99;
  assert.equal(schema.safeParse(wrongOrdinal).success, false);
  const malformedQuality = structuredClone(f.response()); malformedQuality.verdicts[0].reviews = null;
  assert.equal(m.AuditTransportOut.safeParse(malformedQuality).success, true, 'Source envelope recovery must remain available');
});

for (const [name, mutate] of Object.entries({
  'extra check': v => { v.checks.push({ id: 'invented', resolution: 'accepted', reason: 'Not supplied.' }); },
  'duplicate review': v => { v.reviews.push(structuredClone(v.reviews[0])); },
  'unknown ordinal': v => { v.reviews[0].ordinal = 99; },
  'false positive review': v => { v.reviews[0].effortful = false; },
  'invented cue quote': v => { v.reviews[0].relationCue = 'Absent from front'; },
  'malformed quality': v => { v.reviews = null; },
  'unsupported conflict quote': v => { v.conflicts = [{ kind: 'insufficient', quote: 'Absent evidence.', reason: 'Cannot support.' }]; },
  'foreign source resolution': v => { v.reassessments = [{ findingId: 'foreign', cardId: v.cardId, sourceKey: 'foreign', content: '', resolution: 'resolved', quote: 'Amber stores heat.', reason: 'Unrequested.' }]; },
})) test(`${name} remains held while a valid sibling survives reload and explicit retry`, async () => {
  const f = fixture(r => mutate(r.verdicts[0])); await f.g.run(f.h);
  assert.equal(f.h.cards.length, 1, f.h.error);
  assert.equal(f.h.cards[0].generation.planId, 'P2');
  assert.equal(f.h.generation.blocked.length, 1);
  const published = JSON.stringify(f.h.cards[0]);
  const saved = m.parseInboxJson(JSON.stringify({ version: 1, highlights: [f.h] }));
  assert.equal(saved.ok, true); Object.assign(f.h, saved.data.highlights[0]);
  await f.g.run(f.h); assert.equal(f.calls.length, 3, 'Resume must not spend another audit request');
  await f.retry();
  assert.equal(f.h.cards.length, 2, f.h.error);
  assert.equal(f.h.generation.blocked.length, 0);
  assert.equal(JSON.stringify(f.h.cards.find(c => c.generation.planId === 'P2')), published, 'Retry preserves the already-published sibling');
  assert.deepEqual(f.calls.map(c => c.label), ['preparation', 'grounded cards', 'audit', 'audit']);
});

for (const [name, mutate] of Object.entries({
  'duplicate verdict': r => { r.verdicts.push(structuredClone(r.verdicts[0])); },
  'mismatched ID': r => { r.verdicts[0].cardId = r.verdicts[1].cardId; },
  'unknown index': r => { r.verdicts[0].index = 99; },
})) test(`${name} rejects the ambiguous response rather than choosing a favorable verdict`, async () => {
  const f = fixture(mutate); await f.g.run(f.h);
  assert.equal(f.h.cards.length, 0);
  assert.equal(f.h.generation.blocked.length, 2);
  assert.match(f.h.generation.audit.reason, /unknown, mismatched or duplicate/);
});

test('an omitted verdict holds only the omitted card', async () => {
  const f = fixture(r => { r.verdicts.shift(); }); await f.g.run(f.h);
  assert.equal(f.h.cards.length, 1); assert.equal(f.h.cards[0].generation.planId, 'P2');
  assert.equal(f.h.generation.blocked.length, 1);
});

test('malformed coverage retains genuine source evidence through reload and a generic positive retry', async () => {
  const f = fixture(r => {
    r.verdicts[0].reviews = [];
    r.verdicts[0].conflicts = [{ kind: 'insufficient', quote: 'Amber stores heat.', reason: 'Synthetic unresolved source scope.' }];
  });
  await f.g.run(f.h); assert.equal(f.h.cards.length, 1);
  assert.equal(f.h.generation.audit.sourceFindings.length, 1);
  const saved = m.parseInboxJson(JSON.stringify({ version: 1, highlights: [f.h] }));
  assert.equal(saved.ok, true); Object.assign(f.h, saved.data.highlights[0]);
  await f.retry(); assert.equal(f.h.cards.length, 1, 'Generic approval does not resolve the source hold');
  assert.equal(f.h.generation.blocked.length, 1);
  assert.equal(f.calls.at(-1).input.sourceFindings.length, 1);
  assert.deepEqual(f.calls.map(c => c.label), ['preparation', 'grounded cards', 'audit', 'audit']);
});

for (const provider of ['codex', 'deepseek', 'opencode']) test(`${provider} receives the constrained schema but preserves malformed source-bearing responses`, async () => {
  const f = fixture(r => { r.verdicts[0].reviews = null; r.verdicts[0].conflicts = [{ kind: 'insufficient', quote: 'Amber stores heat.', reason: 'Synthetic unresolved scope.' }]; }, { provider });
  await f.g.run(f.h);
  assert.equal(m.schemaJson(f.outputSchema()).properties.verdicts.minItems, 2);
  assert.equal(f.outputSchema().safeParse(f.response()).success, false);
  assert.equal(f.h.cards.length, 1); assert.equal(f.h.generation.audit.sourceFindings.length, 1);
  assert.equal(f.calls.length, 3);
});

test('multi-review schema constrains allowed ordinals and nonempty check IDs; local validation rejects duplicates', () => {
  const card = m.makeCard('synthetic', { kind: 'cloze', text: '{{c2::Amber}} stores {{c1::heat}}.', front: '', back: '' });
  const checks = [['shared-answer', 'cross-interference']];
  const schema = m.auditOutputSchema([card], checks);
  const verdict = { index: 0, cardId: card.id, contractVersion: 1, status: 'verified', reason: 'Synthetic coverage.', conflicts: [], reassessments: [],
    reviews: m.renderedCardReviews(card).map(r => ({ ordinal: r.ordinal, status: 'verified', reason: 'Synthetic review.', identifyingCue: r.visibleCue, relationCue: 'stores', answerable: true, effortful: true })),
    checks: checks[0].map(id => ({ id, resolution: 'accepted', reason: 'Synthetic adjudication.' })) };
  const complete = { verdicts: [verdict] };
  assert.equal(schema.safeParse(complete).success, true);
  assert.doesNotThrow(() => m.validateAudit(complete, [card], 'Amber stores heat.', undefined, checks));
  for (const change of [v => v.reviews.pop(), v => { v.reviews[0].ordinal = null; }, v => v.checks.pop(), v => { v.checks[0].id = 'foreign'; }]) {
    const bad = structuredClone(complete); change(bad.verdicts[0]);
    assert.equal(schema.safeParse(bad).success, false);
  }
  for (const key of ['reviews', 'checks']) {
    const duplicate = structuredClone(complete); duplicate.verdicts[0][key][1] = structuredClone(duplicate.verdicts[0][key][0]);
    assert.throws(() => m.validateAudit(duplicate, [card], 'Amber stores heat.', undefined, checks), /coverage|ID set/);
    const isolated = m.isolateAuditFailures(duplicate, [card], 'Amber stores heat.', checks);
    assert.equal(isolated.verdicts[0].status, 'unverified');
    assert.doesNotThrow(() => m.validateAudit(isolated, [card], 'Amber stores heat.', undefined, checks));
  }
  assert.deepEqual(m.auditOutputSchema([], []).parse({ verdicts: [] }), { verdicts: [] });
});
