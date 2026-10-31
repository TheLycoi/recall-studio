import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';

let m;
before(async () => {
  const out = await build({ stdin: { contents: `export * from './src/generation'; export * from './src/model'; export * from './src/cardActions'; export * from './src/exportSummary'; export {Generator} from './src/generator'; export {LlmClient} from './src/llm'; export {parseInboxJson} from './src/inboxData'; export {toStrictSchema} from './src/codex'; export {lintCard} from './src/lint';`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'], logLevel: 'silent' });
  const mod = new Module('quality-contracts');
  mod.require = id => id === 'obsidian' ? { Notice: class {}, requestUrl() { throw Error('Network forbidden'); } } : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text, 'quality-contracts');
  m = mod.exports;
});
function verdict(card, status = 'verified', checks = []) {
  return { index: 0, cardId: card.id, contractVersion: 1, status, reason: 'Synthetic independent assessment.', conflicts: [], reassessments: [],
    reviews: m.renderedCardReviews(card).map(r => ({ ordinal: r.ordinal, status, reason: 'Synthetic review.', identifyingCue: status === 'verified' ? r.visibleCue.split(' ')[0] : '', relationCue: status === 'verified' ? r.visibleCue.split(' ')[1] : '', answerable: status === 'verified', effortful: status === 'verified' })),
    checks: checks.map(id => ({ id, resolution: 'accepted', reason: 'One focused supported target, despite the product length heuristic.' })) };
}
function preparation(source = 'Amber stores heat.') {
  return { facts: [{ id: 'F1', statement: source, quote: source }], plan: [{ id: 'P1', factIds: ['F1'], entity: 'Amber', aspect: 'property', value: 'heat', reason: 'A supported property.' }], exclusions: [], omissions: [], conflicts: [] };
}

for (const shape of ['qa', 'multiple', 'repeated']) test(`complete ${shape} review coverage is accepted`, () => {
  const c = m.makeCard('h', shape === 'qa' ? { kind: 'qa', front: 'What does Amber store?', back: 'heat' } : { kind: 'cloze', text: shape === 'multiple' ? 'Amber stores {{c1::heat}}. Cobalt reflects {{c2::light}}.' : 'Amber stores {{c1::heat}}; its store is {{c1::heat}}.' });
  assert.equal(m.validateAudit({ verdicts: [verdict(c)] }, [c]).verdicts[0].status, 'verified');
});
for (const defect of ['omitted', 'duplicate', 'invented', 'wrong-front', 'hidden-cue', 'failed-review', 'no-cue', 'legacy', 'missing-check', 'duplicate-check', 'unknown-check', 'hard-waiver']) test(`audit rejects ${defect}`, () => {
  const c = m.makeCard('h', { kind: 'cloze', text: 'Amber stores {{c1::heat}}. Cobalt reflects {{c2::light}}.' });
  const ids = [defect === 'hard-waiver' ? 'answer-in-question' : 'cloze-framing'];
  const v = verdict(c, 'verified', ids);
  if (defect === 'omitted') v.reviews.pop();
  if (defect === 'duplicate') v.reviews[1].ordinal = 1;
  if (defect === 'invented') v.reviews[1].ordinal = 9;
  if (defect === 'wrong-front') v.reviews[1].relationCue = 'light';
  if (defect === 'hidden-cue') v.reviews[0].identifyingCue = 'heat';
  if (defect === 'failed-review') v.reviews[1].status = 'failed';
  if (defect === 'no-cue') v.reviews[1].relationCue = '';
  if (defect === 'legacy') { delete v.reviews; delete v.checks; delete v.contractVersion; }
  if (defect === 'missing-check') v.checks = [];
  if (defect === 'duplicate-check') v.checks.push(v.checks[0]);
  if (defect === 'unknown-check') v.checks[0].id = 'invented';
  assert.throws(() => m.validateAudit({ verdicts: [v] }, [c], undefined, undefined, [ids]));
});

function pipeline({ source = 'Amber stores heat.', draft, assess, prep } = {}) {
  const h = m.makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Synthetic', text: source });
  const p = prep ?? preparation(source);
  const d = draft ?? { kind: 'qa', front: 'What does Amber store?', back: 'heat', text: '', planId: 'P1', factIds: ['F1'] };
  const settings = { provider: 'codex', codexModel: 'synthetic', writerInstructions: '', language: '', concurrency: 1, notifyWhenReady: false };
  const calls = [];
  const llm = new m.LlmClient(() => settings);
  llm.codex = { async complete(req) {
    calls.push(req);
    const u = JSON.parse(req.user);
    if (req.label === 'preparation') return req.schema.parse(p);
    if (req.label === 'grounded cards') return req.schema.parse({ cards: [d] });
    if (req.label === 'generation repair') return req.schema.parse({ cards: [{ ...d, front: 'Name one example of an Amber tool.' }] });
    return req.schema.parse({ verdicts: u.cards.map((c, index) => ({ ...verdict(c, 'verified', c.checks.map(c => c.id)), index, ...(assess?.(c, req, u) ?? {}) })) });
  } };
  const plugin = { settings, llm, store: { all: () => [h], touch() {}, notify() {}, async flush() {}, hasUnsavedChanges: false }, refreshStatusBar() {} };
  const g = new m.Generator(plugin); g.kick = () => {};
  return { h, p, d, calls, llm, plugin, g };
}
for (const bad of [false, true]) test(`production Generator ${bad ? 'holds incomplete' : 'accepts complete'} multiple-review audit`, async () => {
  const f = pipeline({ source: 'Amber stores heat. Cobalt reflects light.', draft: { kind: 'cloze', front: '', back: '', text: 'Amber stores {{c1::heat}}. Cobalt reflects {{c2::light}}.', planId: 'P1', factIds: ['F1'] }, assess: c => bad ? { reviews: verdict(c).reviews.slice(0, 1) } : {} });
  await f.g.run(f.h);
  assert.equal(f.h.cards.length, bad ? 0 : 1);
});
for (const kind of ['framing', 'contradiction', 'insufficient', undefined]) test(`typed ${kind ?? 'legacy'} finding routes conservatively`, async () => {
  const source = "Amber's tools include a probe and a clamp.";
  const f = pipeline({ source, draft: { kind: 'qa', front: 'What are all of Amber’s tools?', back: 'a probe', text: '', planId: 'P1', factIds: ['F1'] }, assess: (_c, req) => req.label === 'audit' ? { status: 'failed', reason: 'Exhaustive wording needs a supported example cue.', conflicts: [{ ...(kind ? { kind } : {}), quote: source, reason: 'The selected target needs review.' }] } : {} });
  await f.g.run(f.h);
  assert.equal(f.calls.filter(r => r.label === 'generation repair').length, kind === 'framing' ? 1 : 0);
  assert.equal(f.h.cards.length, kind === 'framing' ? 1 : 0);
});
test('a writer that already addressed preparation framing needs no repair call', async () => {
  const source = "Amber's tools include a probe and a clamp.";
  const p = preparation(source);
  p.plan[0].aspect = 'tool example'; p.plan[0].value = 'a probe';
  p.conflicts = [{ kind: 'framing', factIds: ['F1'], quote: source, reason: 'Use an example cue, not an exhaustive set.' }];
  const f = pipeline({ source, prep: p, draft: { kind: 'qa', front: 'Name one example of an Amber tool.', back: 'a probe', text: '', planId: 'P1', factIds: ['F1'] } });
  await f.g.run(f.h);
  assert.deepEqual(f.calls.map(r => r.label), ['preparation', 'grounded cards', 'audit']);
  assert.equal(f.h.cards.length, 1);
});

for (const outcome of ['framing', 'resolved', 'generic', 'unknown', 'wrong-source', 'wrong-content', 'fake-quote', 'unresolved']) test(`scoped retry ${outcome} cannot silently erase source history`, async () => {
  const source = "Amber's tools include a probe and a clamp.";
  let retry = false;
  const f = pipeline({ source, draft: { kind: 'qa', front: 'What are all of Amber’s tools?', back: 'a probe', text: '', planId: 'P1', factIds: ['F1'] }, assess: (_c, req, u) => {
    if (!retry) return { status: 'failed', conflicts: [{ quote: source, reason: 'An exhaustive cue was confused with missing evidence.' }] };
    if (req.label !== 'audit' || outcome === 'generic') return {};
    assert.equal(u.sourceFindings.length, 1, 'auditor receives retained finding identity and scope');
    const finding = u.sourceFindings[0];
    const reassessment = { findingId: finding.id, cardId: finding.cardId, sourceKey: finding.sourceKey, content: finding.content,
      resolution: outcome === 'unresolved' ? 'unresolved' : outcome === 'resolved' ? 'resolved' : 'framing', quote: source,
      reason: 'Captured include wording supports one example, not exhaustiveness; repair the question.' };
    if (outcome === 'unknown') reassessment.findingId = 'invented';
    if (outcome === 'wrong-source') reassessment.sourceKey = '0'.repeat(64);
    if (outcome === 'wrong-content') reassessment.content = 'unrelated';
    if (outcome === 'fake-quote') reassessment.quote = 'fabricated';
    return { reassessments: [reassessment] };
  } });
  await f.g.run(f.h);
  assert.equal(f.h.cards.length, 0);
  const original = structuredClone(f.h.generation.drafts);
  const history = structuredClone(f.h.generation.audit);
  retry = true; f.g.retry(f.h); await f.g.run(f.h);
  assert.equal(f.calls.filter(r => r.label === 'audit').length, 2, 'explicit source-held retry performs useful fresh reassessment');
  assert.deepEqual(f.h.generation.drafts, original);
  assert.ok(f.h.generation.auditHistory.some(a => JSON.stringify(a) === JSON.stringify(history)));
  assert.equal(f.h.cards.length, ['framing', 'resolved'].includes(outcome) ? 1 : 0);
  if (outcome === 'framing') assert.equal(f.calls.filter(r => r.label === 'generation repair').length, 1);
});

for (const malformed of ['missing review', 'bad cue', 'invalid boolean']) test(`source holds survive a malformed quality response: ${malformed}`, async () => {
  const source = 'Amber is a tool. Amber is not a tool.';
  let retry = false;
  const f = pipeline({ source, draft: { kind: 'cloze', front: '', back: '', text: 'Amber is {{c1::a tool}}.', planId: 'P1', factIds: ['F1'] }, assess: c => {
    if (retry) return {};
    const v = verdict(c, 'failed');
    v.conflicts = [{ kind: 'contradiction', quote: source, reason: 'Captured claims contradict one another.' }];
    v.checks = c.checks.map(({ id }) => ({ id, resolution: 'defect', reason: 'Visible relation is missing.' }));
    if (malformed === 'missing review') v.reviews = [];
    if (malformed === 'bad cue') v.reviews[0].identifyingCue = 'fabricated cue';
    if (malformed === 'invalid boolean') v.reviews[0].answerable = 'not a boolean';
    return v;
  } });
  // Return raw transport data here: parsing is part of the production boundary under test.
  const original = f.llm.codex.complete;
  f.llm.codex.complete = req => original({ ...req, schema: req.label.includes('audit') ? { parse: x => x } : req.schema });
  await f.g.run(f.h);
  assert.equal(f.h.cards.length, 0);
  assert.equal(f.calls.filter(r => r.label === 'generation repair').length, 0);
  assert.ok(f.h.generation.blocked[0].reasons.some(r => r.includes('Captured claims contradict')));
  const parsed = m.parseInboxJson(JSON.stringify({ version: 1, highlights: [f.h] }));
  assert.equal(parsed.ok, true); Object.assign(f.h, parsed.data.highlights[0]);
  retry = true; f.g.retry(f.h); await f.g.run(f.h);
  assert.equal(f.h.cards.length, 0);
  assert.equal(f.calls.filter(r => r.label === 'generation repair').length, 0);
});

test('seven-word focused cloze acceptance survives generation, clean reuse, reload and export', async () => {
  const source = 'Matching checksums do not prove who sent the transfer.';
  const f = pipeline({ source, draft: { kind: 'cloze', front: '', back: '', text: 'Matching checksums {{c1::do not prove who sent the transfer}}.', planId: 'P1', factIds: ['F1'] } });
  await f.g.run(f.h);
  assert.equal(f.h.cards.length, 1);
  let card = f.h.cards[0];
  const never = async () => assert.fail('Current complete generation acceptance needs zero redundant model calls');
  assert.equal((await m.checkAndRepairCard(card, f.h, never, never)).status, 'checked');
  assert.deepEqual(m.summarizeExport([f.h], new Set([card.id])).warnings, []);
  const saved = m.parseInboxJson(JSON.stringify({ version: 1, highlights: [f.h] }));
  assert.equal(saved.ok, true); Object.assign(f.h, saved.data.highlights[0]); card = f.h.cards[0];
  assert.equal((await m.checkAndRepairCard(card, f.h, never, never)).status, 'checked');
  let explicitCalls = 0;
  await m.checkCard(card, f.h, async (_h, [c]) => { explicitCalls++; return [{ verdict: 'keep', ...verdict(c, 'verified', ['cloze-framing']) }]; });
  assert.equal(explicitCalls, 1, 'explicit Check still performs the requested check');
  assert.deepEqual(m.currentCardCheck(card, f.h).issues, []);
  assert.equal((await m.checkAndRepairCard(card, f.h, never, never)).status, 'checked');
  for (const mutate of [() => { card.text += ' '; }, () => { f.h.text += ' '; }, () => { f.h.cards.push(m.makeCard(f.h.id, { kind: 'qa', front: 'Other question?', back: 'other' })); }, () => { card.qualityAcceptance.method = 'old-method'; }]) {
    const copy = structuredClone(f.h); mutate();
    assert.ok(m.summarizeExport([f.h], new Set([card.id])).warnings.some(w => w.reasons.includes('cloze framing')));
    Object.assign(f.h, copy); card = f.h.cards[0];
  }
});
for (const staleReason of ['', 'Original cue omitted its subject.']) test(`a changed repair receives new acceptance without inheriting its old critique: ${staleReason || 'clean metadata'}`, async () => {
  const f = pipeline(); f.h.status = 'ready';
  const card = m.makeCard(f.h.id, { kind: 'qa', front: 'Unfocused cue?', back: 'heat' }); f.h.cards = [card];
  if (staleReason) card.critiqueReason = staleReason;
  let calls = 0;
  const text = 'Matching checksums {{c1::do not prove who sent the transfer}}.';
  f.h.text = 'Matching checksums do not prove who sent the transfer.';
  const result = await m.checkAndRepairCard(card, f.h, async (_h, [c]) => {
    calls++;
    return [{ verdict: calls === 1 ? 'revise' : 'keep', ...verdict(c, calls === 1 ? 'failed' : 'verified', calls === 1 ? [] : ['cloze-framing']) }];
  }, async () => ({ kind: 'cloze', front: '', back: '', text }));
  assert.equal(result.status, 'repaired'); assert.equal(calls, 2);
  assert.equal(card.text, text);
  assert.deepEqual(m.summarizeExport([f.h], new Set([card.id])).warnings, []);
});
test('unadjudicated length warnings, adverse critique and source findings remain visible', async () => {
  const f = pipeline(); f.h.status = 'ready'; f.h.text = 'Matching checksums do not prove who sent the transfer.';
  const c = m.makeCard(f.h.id, { kind: 'cloze', text: 'Matching checksums {{c1::do not prove who sent the transfer}}.' }); f.h.cards = [c];
  await m.checkCard(c, f.h, async () => [{ verdict: 'keep' }]);
  assert.ok(m.currentCardCheck(c, f.h).issues.includes('cloze framing'));
  await m.checkCard(c, f.h, async (_h, [card]) => [{ verdict: 'keep', ...verdict(card, 'verified', ['cloze-framing']) }]);
  await m.checkCard(c, f.h, async () => [{ verdict: 'revise', reason: 'The target is unfocused.' }]);
  assert.ok(m.summarizeExport([f.h], new Set([c.id])).warnings.length);
});

test('real critique request carries rendered reviews and soft decisions through the strict transport', async () => {
  const f = pipeline(); f.h.status = 'ready';
  f.h.text = 'Matching checksums do not prove who sent the transfer.';
  const c = m.makeCard(f.h.id, { kind: 'cloze', text: 'Matching checksums {{c1::do not prove who sent the transfer}}.' }); f.h.cards = [c];
  let calls = 0;
  f.llm.codex = { async complete(req) {
    calls++;
    const sent = JSON.parse(req.user).cards[0];
    assert.deepEqual(sent.reviews, m.renderedCardReviews(c));
    assert.deepEqual(sent.checks.map(check => check.id), ['cloze-framing']);
    const schema = m.toStrictSchema(req.schema).properties.verdicts.items;
    for (const field of ['contractVersion', 'reviews', 'checks']) assert.ok(schema.required.includes(field));
    return req.schema.parse({ verdicts: [{ ...verdict(c, 'verified', ['cloze-framing']), verdict: 'keep', bloom: 'understand', kind: 'cloze', front: '', back: '', text: '' }] });
  } };
  await m.checkCard(c, f.h, f.llm.critiqueCards.bind(f.llm));
  assert.equal(calls, 1);
  assert.deepEqual(m.currentCardCheck(c, f.h).issues, []);
  assert.deepEqual(m.summarizeExport([f.h], new Set([c.id])).warnings, []);
});

test('explicit retry refreshes a legacy checkpoint without repeating the writer', async () => {
  const f = pipeline(); await f.g.run(f.h);
  f.h.cards = [];
  const old = f.h.generation.audit;
  for (const v of old.verdicts) { delete v.contractVersion; delete v.reviews; delete v.checks; }
  f.h.generation.committed = false;
  f.g.retry(f.h); await f.g.run(f.h);
  assert.equal(f.h.cards.length, 1, f.h.error);
  assert.equal(f.calls.filter(r => r.label === 'audit').length, 2);
  assert.equal(f.calls.filter(r => r.label === 'grounded cards').length, 1);
  assert.ok(f.h.generation.auditHistory.some(a => !a.verdicts[0].contractVersion));
});

test('later source concerns supersede earlier scoped resolution, including export warnings', () => {
  const f = pipeline(); f.h.status = 'ready';
  const c = m.makeCard(f.h.id, { kind: 'qa', front: 'What does Amber store?', back: 'heat' });
  const key = m.generationSourceKey(f.h), content = m.cardAuditContent(c);
  const issue = { kind: 'insufficient', quote: f.h.text, reason: 'Synthetic unresolved source scope.' };
  const raised = { status: 'unverified', reason: issue.reason, contents: [content], verdicts: [{ ...verdict(c, 'unverified'), conflicts: [issue] }] };
  const [finding] = m.retainedSourceFindings(f.p, [raised], [c], key);
  const decision = { findingId: finding.id, cardId: c.id, sourceKey: key, content, resolution: 'resolved', quote: f.h.text, reason: 'Synthetic explicit scoped resolution.' };
  const cleared = { status: 'verified', reason: decision.reason, contents: [content], verdicts: [{ ...verdict(c), reassessments: [decision] }] };
  assert.deepEqual(m.activeSourceFindings([finding], [raised, cleared], key, f.h.text), []);
  const later = structuredClone(raised);
  assert.deepEqual(m.activeSourceFindings([finding], [raised, cleared, later], key, f.h.text), [finding]);
  const unresolved = structuredClone(cleared); unresolved.verdicts[0].reassessments[0].resolution = 'unresolved';
  assert.deepEqual(m.activeSourceFindings([finding], [raised, cleared, unresolved], key, f.h.text), [finding]);
  assert.deepEqual(m.activeSourceFindings([finding], [raised, cleared, later, cleared], key, f.h.text), []);
  c.generation = { batchId: 'batch', planId: 'P1', factIds: ['F1'], audit: { status: 'unverified', reason: issue.reason, content, sourceKey: key } };
  f.h.cards = [c]; f.h.generation = { version: 1, id: 'batch', instruction: '', phase: 'blocked', preparation: f.p, drafts: [structuredClone(c)], auditHistory: [raised, cleared], audit: later };
  assert.ok(m.summarizeExport([f.h], new Set([c.id])).warnings[0].reasons.some(r => r.includes(issue.reason)));
  f.h.generation.inputKey = key;
  f.h.generation.auditHistory = [raised]; f.h.generation.audit = cleared; f.h.generation.finalAudit = later;
  f.g.retry(f.h);
  assert.deepEqual(f.h.generation.auditHistory, [raised, cleared, later], 'retry archives initial before final, not in reverse chronological order');
  assert.equal(m.sourceConcernsForCard(c, f.h).length, 1);
});

test('duplicate plan fails in production before writer dispatch', async () => {
  const p = preparation(); p.plan.push({ ...p.plan[0], id: 'P2' });
  const f = pipeline({ prep: p }); await f.g.run(f.h);
  assert.deepEqual(f.calls.map(r => r.label), ['preparation']);
  assert.match(f.h.error, /Duplicate plan payload/);
});

test('exact duplicate plan payloads ignoring only ID fail, without normalizing legitimate differences', () => {
  const p = preparation();
  p.plan.push({ ...structuredClone(p.plan[0]), id: 'P2' });
  assert.throws(() => m.validatePreparation(p, p.facts[0].quote), /duplicate plan payload.*P1.*P2/i);
  for (const field of ['entity', 'aspect', 'value', 'reason']) {
    const distinct = structuredClone(p);
    distinct.plan[1][field] += ' ';
    assert.equal(m.validatePreparation(distinct, p.facts[0].quote).plan.length, 2, field);
  }
});
