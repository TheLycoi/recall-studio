import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';

let m;
before(async () => {
  const out = await build({ stdin: { contents: `export {Generator} from './src/generator'; export {LlmClient} from './src/llm'; export {makeHighlight,makeCard} from './src/model'; export * from './src/generation'; export {parseInboxJson} from './src/inboxData'; export {schemaJson} from './src/jsonOut';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'cjs', platform: 'node', external: ['obsidian'], logLevel: 'silent' });
  const mod = new Module('generation-hbio');
  mod.require = id => id === 'obsidian' ? { Notice: class {}, requestUrl() { throw Error('Network forbidden'); } } : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text, 'generation-hbio');
  m = mod.exports;
});

// Bounded synthetic verdicts test transport and publication, not model accuracy or physiology.
const cases = [
  { name: 'Type III missing testosterone', source: 'Testosterone: Type III binds intracellular receptors.', entity: 'Testosterone',
    text: 'Type III binds {{c1::intracellular receptors}}.', reviews: [{ ordinal: 1, visibleCue: 'Type III binds [...].', hiddenTargets: ['intracellular receptors'] }],
    reason: 'c1 lacks the required subject testosterone; Type III alone is ambiguous.' },
  { name: 'generic GIP slots', source: 'GIP has two effects: insulin release and reduced gastric acid secretion.', entity: 'GIP',
    text: 'GIP has two effects: {{c1::insulin release}} and {{c2::reduced gastric acid secretion}}.', reviews: [
      { ordinal: 1, visibleCue: 'GIP has two effects: [...] and reduced gastric acid secretion.', hiddenTargets: ['insulin release'] },
      { ordinal: 2, visibleCue: 'GIP has two effects: insulin release and [...].', hiddenTargets: ['reduced gastric acid secretion'] },
    ], reason: 'c1 and c2 are arbitrary unordered slots, not independently cued effects or an ordered sequence.' },
  { name: 'sodium central-answer echo', source: 'Sodium reabsorption raises blood pressure by increasing sodium uptake.', entity: 'Sodium reabsorption',
    text: 'Sodium reabsorption raises blood pressure by {{c1::increasing sodium uptake}}.', reviews: [{ ordinal: 1, visibleCue: 'Sodium reabsorption raises blood pressure by [...].', hiddenTargets: ['increasing sodium uptake'] }],
    reason: 'c1 central answer is echoed by visible Sodium reabsorption; exact whole-answer matching misses the equivalent cue.' },
  { name: 'broken parentheses', source: 'GIP (glucose-dependent insulinotropic peptide) is an incretin.', entity: 'GIP',
    text: '{{c1::GIP (}}glucose-dependent insulinotropic peptide{{c2::)}} is an incretin.', reviews: [
      { ordinal: 1, visibleCue: '[...]glucose-dependent insulinotropic peptide) is an incretin.', hiddenTargets: ['GIP ('] },
      { ordinal: 2, visibleCue: 'GIP (glucose-dependent insulinotropic peptide[...] is an incretin.', hiddenTargets: [')'] },
    ], reason: 'c1 leaves an unmatched closing parenthesis; c2 tests punctuation, not a meaningful retrieval.' },
  { name: 'reciprocal fiber cues', source: 'Type I fibers resist fatigue, whereas Type II fibers fatigue rapidly.', entity: 'Muscle fiber types',
    text: 'Type I fibers {{c1::resist fatigue}}, whereas Type II fibers {{c2::fatigue rapidly}}.', reviews: [
      { ordinal: 1, visibleCue: 'Type I fibers [...], whereas Type II fibers fatigue rapidly.', hiddenTargets: ['resist fatigue'] },
      { ordinal: 2, visibleCue: 'Type I fibers resist fatigue, whereas Type II fibers [...].', hiddenTargets: ['fatigue rapidly'] },
    ], reason: 'c1 and c2 reveal opposite properties through visible siblings and the whereas contrast.' },
  { name: 'longer contextual cue', source: 'During Zeta calibration, disconnect power before attaching the reference cable to prevent a false reading.', entity: 'Zeta calibration',
    text: 'During Zeta calibration, disconnect power before attaching the reference cable to {{c1::prevent a false reading}}.', reviews: [{ ordinal: 1, visibleCue: 'During Zeta calibration, disconnect power before attaching the reference cable to [...].', hiddenTargets: ['prevent a false reading'] }] },
  { name: 'meaningful same-number contrast', source: 'Type I fibers resist fatigue, whereas Type II fibers fatigue rapidly.', entity: 'Muscle fiber types',
    text: 'Type I fibers {{c1::resist fatigue}}, whereas Type II fibers {{c1::fatigue rapidly}}.', reviews: [{ ordinal: 1, visibleCue: 'Type I fibers [...], whereas Type II fibers [...].', hiddenTargets: ['resist fatigue', 'fatigue rapidly'] }] },
  { name: 'real ordered sequence', source: 'Zeta calibration proceeds in order: disconnect power, attach cable, reconnect power.', entity: 'Zeta calibration',
    text: 'Zeta calibration proceeds in order: {{c1::disconnect power}}, {{c2::attach cable}}, {{c3::reconnect power}}.', reviews: [
      { ordinal: 1, visibleCue: 'Zeta calibration proceeds in order: [...], attach cable, reconnect power.', hiddenTargets: ['disconnect power'] },
      { ordinal: 2, visibleCue: 'Zeta calibration proceeds in order: disconnect power, [...], reconnect power.', hiddenTargets: ['attach cable'] },
      { ordinal: 3, visibleCue: 'Zeta calibration proceeds in order: disconnect power, attach cable, [...].', hiddenTargets: ['reconnect power'] },
    ] },
  { name: 'independent hormone-cell mappings', source: 'GIP is secreted by K cells; GLP-1 is secreted by L cells.', entity: 'Incretin-cell mappings',
    text: 'GIP is secreted by {{c1::K cells}}; GLP-1 is secreted by {{c2::L cells}}.', reviews: [
      { ordinal: 1, visibleCue: 'GIP is secreted by [...]; GLP-1 is secreted by L cells.', hiddenTargets: ['K cells'] },
      { ordinal: 2, visibleCue: 'GIP is secreted by K cells; GLP-1 is secreted by [...].', hiddenTargets: ['L cells'] },
    ] },
  { name: 'necessary shared vocabulary', source: 'During Zeta calibration the reference cable carries the reference signal.', entity: 'Zeta calibration',
    text: 'During Zeta calibration the reference cable carries {{c1::the reference signal}}.', reviews: [{ ordinal: 1, visibleCue: 'During Zeta calibration the reference cable carries [...].', hiddenTargets: ['the reference signal'] }] },
];

function fixture(c) {
  const h = m.makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Synthetic capture', text: c.source });
  const preparation = { facts: [{ id: 'F1', statement: c.source, quote: c.source }], plan: [{ id: 'P1', factIds: ['F1'], entity: c.entity, aspect: 'stated relationship', value: c.source, reason: 'Synthetic planned target.' }], exclusions: [], omissions: [], conflicts: [] };
  const draft = { planId: 'P1', factIds: ['F1'], kind: 'cloze', front: '', back: '', text: c.text };
  const settings = { provider: 'codex', codexModel: 'synthetic', language: '', writerInstructions: '', historyExamples: false, critiquePass: true, lintMode: 'badge', concurrency: 1, notifyWhenReady: false };
  const calls = [], llm = new m.LlmClient(() => settings);
  const conflict = c.sourceConflict ? { ...c.sourceConflict } : undefined;
  const backend = { async complete(req) {
    calls.push(req);
    if (req.label === 'preparation') return req.schema.parse(preparation);
    if (req.label === 'grounded cards' || req.label === 'generation repair') return req.schema.parse({ cards: [draft] });
    const card = JSON.parse(req.user).cards[0];
    assert.deepEqual(card.reviews, c.reviews, 'auditor receives the exact per-ordinal retrieval, not just the unhidden note');
    assert.deepEqual(card.targetContext, { entity: c.entity, aspect: 'stated relationship' });
    return req.schema.parse({ verdicts: [{ index: 0, cardId: card.id, status: c.reason ? 'failed' : 'verified', reason: c.reason ?? 'Synthetic positive control, not live model evidence.', ...(conflict ? { conflicts: [conflict] } : {}) }] });
  } };
  llm.codex = backend;
  const plugin = { settings, llm, store: { all: () => [h], touch() {}, async flush() {}, hasUnsavedChanges: false }, refreshStatusBar() {} };
  return { h, preparation, draft, settings, calls, backend, llm, plugin, g: new m.Generator(plugin) };
}

for (const c of cases) test(`P3 rendered contract: ${c.name}`, async () => {
  const f = fixture(c);
  await f.g.run(f.h);
  assert.equal(f.h.cards.length, c.reason ? 0 : 1, f.h.error ?? 'publication follows the supplied synthetic verdict');
  assert.deepEqual(f.h.generation.audit.verdicts.map(v => v.status), [c.reason ? 'failed' : 'verified']);
  assert.deepEqual(f.calls.map(r => r.label), c.reason ? ['preparation', 'grounded cards', 'audit', 'generation repair', 'final audit'] : ['preparation', 'grounded cards', 'audit']);
  assert.equal(f.h.generation.drafts[0].text, c.text, 'the original wording stays intact');
  if (c.reason) assert.ok(f.h.generation.blocked[0].reasons.includes(c.reason));
});

const sourceCases = [
  { name: 'absolute copied clinical claim', source: 'Treatment Z always prevents every complication.', entity: 'Treatment Z', text: 'Treatment Z {{c1::always}} prevents every complication.',
    reviews: [{ ordinal: 1, visibleCue: 'Treatment Z [...] prevents every complication.', hiddenTargets: ['always'] }],
    sourceConflict: { quote: 'Treatment Z always prevents every complication.', reason: 'Insufficient evidence for universal clinical scope; faithful copying is not factual verification.' } },
  { name: 'intra-source contradiction', source: 'Treatment Z always prevents complications. Treatment Z sometimes fails to prevent complications.', entity: 'Treatment Z', text: 'Treatment Z {{c1::always}} prevents complications.',
    reviews: [{ ordinal: 1, visibleCue: 'Treatment Z [...] prevents complications.', hiddenTargets: ['always'] }],
    sourceConflict: { quote: 'Treatment Z always prevents complications. Treatment Z sometimes fails to prevent complications.', reason: 'Conflicting source positions cannot support this absolute target.' } },
  { name: 'malformed source grammar', source: 'Treatment Z do not never prevent complications.', entity: 'Treatment Z', text: 'Treatment Z {{c1::do not never}} prevent complications.',
    reviews: [{ ordinal: 1, visibleCue: 'Treatment Z [...] prevent complications.', hiddenTargets: ['do not never'] }],
    sourceConflict: { quote: 'Treatment Z do not never prevent complications.', reason: 'Insufficient evidence: malformed source grammar makes the negation ambiguous; a grammar edit must not choose the fact.' } },
];

for (const c of sourceCases) test(`P4 independent source hold: ${c.name}`, async () => {
  const f = fixture(c);
  const before = f.h.text;
  await f.g.run(f.h);
  assert.equal(f.h.cards.length, 0, 'a positive quality verdict cannot waive a source hold');
  assert.notEqual(f.h.generation.audit.status, 'verified');
  assert.deepEqual(f.calls.map(r => r.label), ['preparation', 'grounded cards', 'audit'], 'source findings must not authorize a wording repair');
  assert.deepEqual(f.h.generation.audit.verdicts[0].conflicts, [c.sourceConflict]);
  assert.equal(f.h.generation.drafts[0].text, c.text);
  assert.equal(f.h.text, before);
  assert.match(f.h.generation.blocked[0].reasons.join(' '), /Source.*(?:conflict|evidence)/i);
  assert.ok(f.h.generation.blocked[0].reasons.some(reason => reason.includes(c.sourceConflict.quote)));
  const reload = m.parseInboxJson(JSON.stringify({ version: 1, highlights: [f.h] }));
  assert.equal(reload.ok, true);
  assert.deepEqual(reload.data.highlights[0].generation.audit.verdicts[0].conflicts, [c.sourceConflict]);
});

test('P4 preparation can scope an evidence hold and omit its target without blocking an unrelated qualified fact', async () => {
  const f = fixture(cases[5]);
  const uncertain = 'Treatment Z do not never prevent complications.';
  f.h.text += '\n' + uncertain;
  f.preparation.facts.push({ id: 'F2', statement: uncertain, quote: uncertain });
  f.preparation.omissions.push({ factIds: ['F2'], reason: 'Insufficient evidence: ambiguous negation.' });
  f.preparation.conflicts.push({ factIds: ['F2'], quote: uncertain, reason: 'Insufficient evidence: grammar does not establish the intended claim.' });
  await f.g.run(f.h);
  assert.equal(f.h.cards.length, 1, 'the excluded uncertainty must not block the independent target');
  assert.deepEqual(f.h.generation.preparation.conflicts[0].factIds, ['F2']);
  assert.equal(f.h.generation.preparation.conflicts[0].quote, uncertain);
  assert.equal(f.h.generation.audit.status, 'verified');
});

test('P4 a preparation hold on a planned target cannot be waived by a positive audit or sent for factual repair', async () => {
  const f = fixture(cases[5]);
  const conflict = { factIds: ['F1'], quote: f.h.text, reason: 'Insufficient evidence for this planned scope.' };
  f.preparation.conflicts.push(conflict);
  await f.g.run(f.h);
  assert.equal(f.h.cards.length, 0);
  assert.deepEqual(f.h.generation.preparation.conflicts[0], conflict);
  assert.equal(f.calls.filter(r => r.label === 'generation repair').length, 0);
  assert.ok(f.h.generation.blocked[0].reasons.some(reason => reason.includes(conflict.quote)));
});

test('P4 rejects invented audit evidence and invalid conflict fact references', () => {
  const c = m.makeCard('h', { kind: 'qa', front: 'Which signal?', back: 'reference signal' });
  const v = { index: 0, cardId: c.id, status: 'verified', reason: 'Synthetic', conflicts: [{ quote: 'invented authority', reason: 'Unsupported claim' }] };
  assert.throws(() => m.validateAudit({ verdicts: [v] }, [c], 'Original captured source.'), /quote.*captured snapshot/i);
  const f = fixture(cases[5]);
  f.preparation.conflicts.push({ quote: f.h.text, reason: 'Insufficient', factIds: ['F99'] });
  assert.throws(() => m.validatePreparation(f.preparation, f.h.text), /fact reference/i);
});

test('P4 a later positive final verdict cannot erase a source hold while a different card is repaired', async () => {
  const f = fixture(sourceCases[0]);
  const independent = cases[5];
  f.h.text += '\n' + independent.source;
  f.preparation.facts.push({ id: 'F2', quote: independent.source, statement: independent.source });
  f.preparation.plan.push({ id: 'P2', factIds: ['F2'], entity: independent.entity, aspect: 'calibration rationale', value: 'prevent a false reading', reason: 'Independent target' });
  const second = { planId: 'P2', factIds: ['F2'], kind: 'qa', front: 'Why do it?', back: 'prevent a false reading', text: '' };
  f.backend.complete = async req => {
    f.calls.push(req);
    if (req.label === 'preparation') return req.schema.parse(f.preparation);
    if (req.label === 'grounded cards') return req.schema.parse({ cards: [f.draft, second] });
    if (req.label === 'generation repair') {
      assert.deepEqual(JSON.parse(req.user).candidates.map(c => c.planId), ['P2'], 'only prompt quality is repairable');
      return req.schema.parse({ cards: [{ ...second, front: 'During Zeta calibration, why disconnect power before cable attachment?' }] });
    }
    return req.schema.parse({ verdicts: JSON.parse(req.user).cards.map((c, index) => ({ index, cardId: c.id,
      status: req.label === 'audit' && index === 1 ? 'failed' : 'verified', reason: 'Synthetic quality finding',
      conflicts: req.label === 'audit' && index === 0 ? [sourceCases[0].sourceConflict] : [],
    })) });
  };
  await f.g.run(f.h);
  assert.equal(f.h.cards.length, 1);
  assert.equal(f.h.cards[0].generation.planId, 'P2');
  assert.equal(f.h.generation.blocked[0].cardId, f.h.generation.drafts[0].id);
  assert.notEqual(f.h.generation.finalAudit.status, 'verified', 'a final summary must not label a retained source hold green');
  assert.ok(f.h.generation.blocked[0].reasons.some(reason => reason.includes(sourceCases[0].source)));
});

for (const variant of ['initial', 'final verified', 'final failed']) test(`P4 ${variant} source hold survives explicit retries without wording repair`, async () => {
  const f = fixture(sourceCases[0]);
  f.g.kick = () => {};
  const conflict = sourceCases[0].sourceConflict;
  const complete = f.backend.complete;
  let retry = false;
  f.backend.complete = async req => {
    if (!['audit', 'final audit', 'generation repair'].includes(req.label)) return complete(req);
    f.calls.push(req);
    if (req.label === 'generation repair') return req.schema.parse({ cards: [{ ...f.draft, text: 'Treatment Z prevents every complication {{c1::always}}.' }] });
    const initial = req.label === 'audit';
    return req.schema.parse({ verdicts: JSON.parse(req.user).cards.map((c, index) => ({
      index, cardId: c.id,
      status: variant !== 'initial' && (initial || (!retry && variant === 'final failed')) ? 'failed' : 'verified',
      reason: initial && variant !== 'initial' ? 'Synthetic retrieval quality defect.' : !retry && variant === 'final failed' ? 'Captured evidence cannot support universal scope.' : 'Synthetic positive quality verdict.',
      conflicts: !retry && (variant === 'initial' ? initial : !initial) ? [conflict] : [],
    })) });
  };
  await f.g.run(f.h);
  assert.equal(f.h.cards.length, 0);
  const heldAudit = structuredClone(variant === 'initial' ? f.h.generation.audit : f.h.generation.finalAudit);
  assert.deepEqual(heldAudit.verdicts[0].conflicts, [conflict]);
  const original = structuredClone(f.h.generation.drafts);
  const repairs = structuredClone(f.h.generation.repairs);
  const batchId = f.h.generation.id;
  retry = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    // Exercise the persisted history, not only objects retained in this process.
    const parsed = m.parseInboxJson(JSON.stringify({ version: 1, highlights: [f.h] }));
    assert.equal(parsed.ok, true);
    Object.assign(f.h, parsed.data.highlights[0]);
    f.g.retry(f.h);
    await f.g.run(f.h);
    assert.equal(f.calls.filter(r => r.label === 'generation repair').length, variant === 'initial' ? 0 : 1, 'source insufficiency must never become a wording-repair instruction');
    assert.equal(f.h.cards.length, 0, 'a positive retry does not resolve insufficient source evidence');
    assert.equal(f.h.generation.blocked.length, 1);
    assert.ok(f.h.generation.blocked[0].reasons.some(reason => reason.includes(conflict.quote) && reason.includes(conflict.reason)));
    assert.notEqual((f.h.generation.finalAudit ?? f.h.generation.audit).status, 'verified');
    assert.ok(f.h.generation.auditHistory.some(a => JSON.stringify(a) === JSON.stringify(heldAudit)), 'retain the exact original audit without adding release identity');
    assert.equal(f.h.generation.id, batchId);
    assert.deepEqual(f.h.generation.drafts, original);
    assert.deepEqual(f.h.generation.repairs, repairs);
    assert.equal(f.h.text, sourceCases[0].source);
  }
});

test('P4 removing retained source evidence during retry prevents stale acceptance', async () => {
  const f = fixture(sourceCases[0]);
  f.g.kick = () => {};
  await f.g.run(f.h);
  f.g.retry(f.h);
  const complete = f.backend.complete;
  f.backend.complete = async req => {
    if (req.label !== 'audit') return complete(req);
    f.calls.push(req);
    f.h.generation.auditHistory = [];
    return req.schema.parse({ verdicts: JSON.parse(req.user).cards.map((c, index) => ({ index, cardId: c.id, status: 'verified', reason: 'Synthetic positive quality verdict.', conflicts: [] })) });
  };
  await f.g.run(f.h);
  assert.equal(f.h.cards.length, 0, 'changed source-hold state revokes the in-flight retry');
  assert.match(f.h.error, /inputs changed/i);
  assert.equal(f.calls.filter(r => r.label === 'generation repair').length, 0);
});

for (const stale of ['card identity', 'card index', 'source identity', 'input identity']) test(`P4 unrelated historical ${stale} cannot hold the current target`, async () => {
  const f = fixture(cases[5]);
  f.g.kick = () => {};
  await new m.Generator(f.plugin, { release: 'original-release' }).run(f.h);
  const batch = f.h.generation;
  const historical = structuredClone(batch.audit);
  historical.verdicts[0].conflicts = [{ quote: f.h.text, reason: 'Unrelated historical finding.' }];
  if (stale === 'card identity') historical.verdicts[0].cardId = 'unrelated-card';
  else if (stale === 'card index') historical.verdicts[0].index = 1;
  else if (stale === 'source identity') historical.provenance.sourceKey = '0'.repeat(64);
  else historical.provenance.inputKey = '0'.repeat(64);
  batch.auditHistory = [historical];
  const before = structuredClone(historical);
  f.h.cards = [];
  f.g.retry(f.h);
  await f.g.run(f.h);
  assert.equal(f.h.cards.length, 1, 'a stale finding is not evidence against a different target or capture');
  assert.equal(f.calls.filter(r => r.label === 'generation repair').length, 0);
  assert.deepEqual(batch.auditHistory[0], before, 'irrelevant evidence stays intact without becoming a current hold');
});

for (const revision of ['source context', 'writing context', 'explicit new batch']) test(`P4 ${revision} starts a new batch without inheriting retry source holds`, async () => {
  const f = fixture(sourceCases[0]);
  f.g.kick = () => {};
  await f.g.run(f.h);
  f.g.retry(f.h);
  const old = structuredClone(f.h.generation);
  const complete = f.backend.complete;
  f.backend.complete = async req => {
    if (!['audit', 'final audit'].includes(req.label)) return complete(req);
    f.calls.push(req);
    return req.schema.parse({ verdicts: JSON.parse(req.user).cards.map((c, index) => ({ index, cardId: c.id, status: 'verified', reason: 'Synthetic reconsideration in a new evidence batch.', conflicts: [] })) });
  };
  if (revision === 'source context') f.h.before = 'New source context supplied for reconsideration.';
  else if (revision === 'writing context') f.settings.writerInstructions = 'New authorized writing context.';
  else f.g.more(f.h, 'Reconsider in a new batch.');
  await f.g.run(f.h);
  assert.notEqual(f.h.generation.id, old.id);
  assert.equal(f.h.cards.length, 1);
  assert.equal(f.h.generation.auditHistory, undefined);
  assert.deepEqual(f.h.generationHistory.find(b => b.id === old.id), old);
  assert.equal(f.h.text, sourceCases[0].source);
  assert.equal(f.h.generationHistory[0].auditHistory[0].verdicts[0].conflicts[0].quote, sourceCases[0].sourceConflict.quote);
});

test('P4 provider schemas require all object fields while old responses and saved records still load', () => {
  function strict(schema) {
    if (!schema || typeof schema !== 'object') return;
    if (schema.type === 'object') assert.deepEqual(new Set(schema.required), new Set(Object.keys(schema.properties)), 'strict providers require every property');
    for (const value of Object.values(schema)) if (Array.isArray(value)) value.forEach(strict); else strict(value);
  }
  strict(m.schemaJson(m.PreparationOut));
  strict(m.schemaJson(m.AuditOut));
  const f = fixture(cases[5]);
  f.preparation.conflicts.push({ quote: f.h.text, reason: 'Legacy whole-capture hold' });
  const p = m.validatePreparation(f.preparation, f.h.text);
  const card = m.makeCard(f.h.id, { kind: 'qa', front: 'Which signal?', back: 'reference signal' });
  assert.equal(m.sourceConflictsForCard(p, card).length, 1);
  p.conflicts[0].factIds = [];
  assert.equal(m.sourceConflictsForCard(p, card).length, 1, 'an empty wire scope must fail closed for the whole capture');
  f.h.generation = { version: 1, id: 'legacy', inputKey: '', instruction: '', phase: 'preparing', preparation: f.preparation };
  const original = JSON.stringify({ version: 1, highlights: [f.h] });
  const parsed = m.parseInboxJson(original);
  assert.equal(parsed.ok, true);
  assert.equal(JSON.stringify(parsed.data), original, 'legacy parser does not backfill new fields');
});

test('P4 exact original excerpts survive readable whitespace and link normalization', async () => {
  const source = 'In this course, GIP  are secreted by [[lecture.pdf#page=2|K cells]].\n';
  const c = { source, entity: 'Course GIP model', text: 'In this course, GIP is secreted by {{c1::K cells}}.', reviews: [{ ordinal: 1, visibleCue: 'In this course, GIP is secreted by [...].', hiddenTargets: ['K cells'] }] };
  const f = fixture(c);
  await f.g.run(f.h);
  assert.equal(f.h.cards.length, 1, f.h.error ?? 'exact source quote must be accepted');
  assert.equal(f.h.text, source);
  assert.equal(f.h.generation.preparation.facts[0].quote, source, 'surface grammar fixes do not rewrite the quote');
  for (const req of f.calls.filter(r => ['preparation', 'audit'].includes(r.label))) {
    const payload = JSON.parse(req.user);
    assert.equal(payload.capturedOriginal, source, 'quote authority retains original bytes');
    assert.equal(payload.captured, 'In this course, GIP are secreted by K cells.', 'keep the existing readable answer-evidence view');
  }
});

test('P4 new quotes require original bytes while legacy staged quotes retain their former readable authority', () => {
  const raw = 'Treatment Z  always prevents complications.\n';
  const readable = 'Treatment Z always prevents complications.';
  const f = fixture({ ...sourceCases[0], source: readable });
  const before = structuredClone(f.preparation);
  assert.throws(() => m.validatePreparation(f.preparation, raw), /quote.*captured snapshot/i);
  assert.equal(m.validatePreparation(f.preparation, raw, undefined, readable).facts[0].quote, readable);
  assert.deepEqual(f.preparation, before, 'legacy evidence is not backfilled or cleaned');
  const card = m.makeCard(f.h.id, { kind: 'qa', front: 'Treatment Z: which frequency?', back: 'always' });
  const audit = { verdicts: [{ index: 0, cardId: card.id, status: 'unverified', reason: 'Source issue', conflicts: [{ quote: readable, reason: 'Legacy source insufficiency' }] }] };
  assert.throws(() => m.validateAudit(audit, [card], raw), /quote.*captured snapshot/i);
  assert.deepEqual(m.validateAudit(audit, [card], raw, readable), audit);
});

test('P4 a qualified course fact remains capture-supported, not universally factually verified', async () => {
  const c = { name: 'course fact', source: 'In this course model, Type III testosterone receptors are intracellular.', entity: 'Course model of testosterone receptors', text: 'In this course model, Type III testosterone receptors are {{c1::intracellular}}.', reviews: [{ ordinal: 1, visibleCue: 'In this course model, Type III testosterone receptors are [...].', hiddenTargets: ['intracellular'] }] };
  const f = fixture(c);
  await f.g.run(f.h);
  assert.equal(f.h.cards.length, 1);
  assert.equal(f.h.cards[0].text, c.text);
  assert.match(m.cardAuditLabel(f.h.cards[0], f.h), /against captured source/);
  assert.doesNotMatch(m.cardAuditLabel(f.h.cards[0], f.h), /factually verified/);
  for (const req of f.calls.filter(r => ['preparation', 'audit'].includes(r.label))) {
    assert.match(req.system, /faithful copying.*factual truth/i);
    assert.match(req.system, /qualified course.*universal/i);
    assert.match(req.system, /grammar.*factual correction/i);
    assert.match(req.system, /(?:external|outside).*authority/i);
  }
});

test('P4 later source revision starts fresh evidence without rewriting the original excerpt or source hold', async () => {
  const f = fixture(sourceCases[0]);
  await f.g.run(f.h);
  const original = structuredClone(f.h.generation);
  const revision = fixture(cases[5]);
  revision.plugin.store.all = () => [f.h];
  Object.assign(f.h, { text: revision.h.text });
  revision.plugin.llm = revision.llm;
  await new m.Generator(revision.plugin).run(f.h);
  assert.notEqual(f.h.generation.id, original.id);
  assert.equal(f.h.cards.length, 1);
  assert.deepEqual(f.h.generationHistory.find(g => g.id === original.id), original);
  assert.equal(original.preparation.facts[0].quote, sourceCases[0].source);
  assert.equal(original.audit.verdicts[0].conflicts[0].quote, sourceCases[0].source);
});

test('P5 provenance never certifies edited content and malformed persisted identity fails validation', async () => {
  const f = fixture(cases[5]);
  await new m.Generator(f.plugin, { release: 'synthetic-release' }).run(f.h);
  const card = f.h.cards[0];
  const provenance = structuredClone(card.generation.audit.provenance);
  card.text += ' User edit.';
  assert.match(m.cardAuditLabel(card, f.h), /card changed/);
  assert.deepEqual(card.generation.audit.provenance, provenance, 'preserve historical identity without certifying the edit');
  f.h.before = 'Changed capture context';
  assert.match(m.cardAuditLabel(card, f.h), /capture changed/);
  for (const invalid of [{ build: { release: 42 } }, { sourceKey: 'not-a-source-key' }, { inputKey: 'not-an-input-key' }]) {
    const h = structuredClone(f.h);
    Object.assign(h.cards[0].generation.audit.provenance, invalid);
    const parsed = m.parseInboxJson(JSON.stringify({ version: 1, highlights: [h] }));
    assert.equal(parsed.ok, false, 'do not silently drop malformed generation identity at the storage boundary');
    assert.equal(parsed.reason, 'bad-shape');
  }
});

test('P3 rendered Q&A, hints, markup and repeated numbers preserve review semantics', () => {
  assert.deepEqual(m.renderedCardReviews(m.makeCard('h', { kind: 'qa', front: '**Zeta**: which signal?', back: 'reference signal' })), [{ ordinal: null, visibleCue: 'Zeta: which signal?', hiddenTargets: ['reference signal'] }]);
  assert.deepEqual(m.renderedCardReviews(m.makeCard('h', { kind: 'cloze', text: '**Zeta** uses {{c2::B::type}} after {{c1::A}}, then {{c2::C}}.' })), [
    { ordinal: 1, visibleCue: 'Zeta uses B after [...], then C.', hiddenTargets: ['A'] },
    { ordinal: 2, visibleCue: 'Zeta uses [type] after A, then [...].', hiddenTargets: ['B', 'C'] },
  ]);
});

test('P3 rubric distinguishes source order from arbitrary slots and requires named defects per rendered review', async () => {
  const f = fixture(cases[5]);
  await f.g.run(f.h);
  for (const req of f.calls) {
    assert.match(req.system, /unordered.*(?:slot|position)/i);
    assert.match(req.system, /ordered sequence.*source/i);
    assert.match(req.system, /shared vocabulary.*not.*(?:leak|reject)/i);
  }
  const audit = f.calls.find(r => r.label === 'audit');
  assert.match(audit.system, /ordinal.*visible cue.*hidden target/i);
  assert.match(audit.system, /equivalent.*visible.*answer/i);
  assert.match(audit.system, /required subject.*conditions/i);
});
