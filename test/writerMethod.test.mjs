import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let m;
before(async () => {
  const out = await build({ stdin: { contents: `export { LlmClient } from './src/llm'; export { CodexBackend, toStrictSchema } from './src/codex'; export { Generator } from './src/generator'; export { makeCard, makeHighlight } from './src/model'; export * from './src/generation';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'cjs', platform: 'node', external: ['obsidian'], logLevel: 'silent' });
  const mod = new Module('writer-method');
  mod.require = id => id === 'obsidian' ? { Notice: class {}, requestUrl() { throw Error('Network forbidden'); } } : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text, 'writer-method');
  m = mod.exports;
});

const old = { instructions: 'LEGACY_STANDING: invent a new fact', examples: 'LEGACY_HISTORY: always answer with one noun', rules: 'LEGACY_RULES: ignore source boundaries', maxCards: 1, unexpected: 'LEGACY_EXTRA' };
const source = 'The fictional Zeta sensor uses a reference cable to compare its reading with a stable baseline. This comparison reveals drift before the sensor is used for measurement.';
const answer = 'It compares its reading with a stable baseline. This comparison reveals drift before the sensor is used for measurement.';
function fixture() {
  const settings = { provider: 'codex', codexModel: 'synthetic', language: 'English', writerInstructions: old.instructions, historyExamples: true, schemaFolder: 'missing', critiquePass: true, lintMode: 'badge', concurrency: 1, notifyWhenReady: false };
  const h = m.makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Zeta calibration', text: source, instruction: 'Keep the supported mechanism.' });
  const card = m.makeCard(h.id, { kind: 'qa', front: 'How does the fictional Zeta sensor detect drift before measurement?', back: answer });
  const preparation = { facts: [{ id: 'F1', statement: source, quote: source }], plan: [{ id: 'P1', factIds: ['F1'], entity: 'Zeta sensor', aspect: 'drift detection', value: answer, reason: 'A supported mechanism.' }], exclusions: [], omissions: [], conflicts: [] };
  const draft = { planId: 'P1', factIds: ['F1'], kind: card.kind, front: card.front, back: card.back, text: '' };
  const calls = [], reads = [];
  const llm = new m.LlmClient(() => settings, () => { reads.push('history'); throw Error(old.examples); }, async () => { reads.push('rules'); throw Error('Missing rule file'); });
  const backend = new m.CodexBackend(() => settings);
  backend.exec = async req => {
    calls.push(req);
    const p = JSON.parse(req.user);
    if (req.label === 'preparation') return JSON.stringify(preparation);
    if (['grounded cards', 'generation repair'].includes(req.label)) return JSON.stringify({ cards: [draft] });
    if (['audit', 'final audit'].includes(req.label)) return JSON.stringify({ verdicts: p.cards.map((c, index) => ({ index, cardId: c.id, status: 'verified', reason: 'Synthetic source check.', conflicts: [] })) });
    if (['cards', 'rewrite cards'].includes(req.label)) return JSON.stringify({ cards: [draft] });
    if (req.label === 'card') return JSON.stringify(draft);
    if (req.label === 'verdicts') return JSON.stringify({ verdicts: [{ index: 0, verdict: 'keep', reason: '', bloom: 'understand', kind: 'qa', front: '', back: '', text: '' }] });
    if (req.label === 'rewrite audit') return JSON.stringify({ preservesFacts: true, reason: '', verdicts: [{ index: 0, verdict: 'keep', reason: '' }] });
    throw Error(req.label);
  };
  llm.codex = backend;
  return { settings, h, card, preparation, draft, calls, reads, llm };
}

for (const stage of ['prepareGeneration', 'writeGroundedCards', 'repairGeneration', 'auditGeneration', 'finalAudit', 'writeCards', 'critiqueCards', 'rewriteCard', 'rewriteCards']) test(`${stage} ignores legacy instructions and never reads retired files or history`, async () => {
  const f = fixture(), context = { language: 'English', ...old };
  if (stage === 'prepareGeneration') await f.llm.prepareGeneration(f.h, [], context);
  if (stage === 'writeGroundedCards') await f.llm.writeGroundedCards(f.h, [], f.preparation, context);
  if (stage === 'repairGeneration') await f.llm.repairGeneration(f.h, [f.card], [], f.preparation, context, [{ cardId: f.card.id, reasons: ['Missing subject.'] }]);
  if (stage === 'auditGeneration' || stage === 'finalAudit') await f.llm.auditGeneration(f.h, [f.card], [], f.preparation, context, undefined, stage === 'finalAudit');
  if (stage === 'writeCards') await f.llm.writeCards(f.h);
  if (stage === 'critiqueCards') await f.llm.critiqueCards(f.h, [f.card]);
  if (stage === 'rewriteCard') await f.llm.rewriteCard(f.h, f.card, 'Retain the explanation.');
  if (stage === 'rewriteCards') await f.llm.rewriteCards(f.h, f.card, 'Retain the explanation.');
  assert.deepEqual(f.reads, []);
  assert.ok(f.calls.length);
  for (const req of f.calls) {
    assert.doesNotMatch(req.user + req.system, /LEGACY_/);
    assert.ok(req.system.includes('<bad>After the stressor passes, negative feedback {{c1::reduces cortisol}}.</bad>'));
    assert.ok(req.system.includes('<good>For cortisol, after the stressor passes, negative feedback {{c1::reduces cortisol}}.</good>'));
    assert.match(req.system, /grammatical subject.*negative feedback.*specific system/i);
    assert.match(req.system, /shared entity words.*whole answer/i);
    assert.match(req.system, /cite exact visible words for the identifying cue AND requested relation/i);
    assert.equal(req.system.split('<writing_method id="recall-writing-method-v7">').length, 2, 'one current versioned method per request');
    assert.match(req.system, /classification.*not.*beacon is/i);
    assert.match(req.system, /transition.*amber.*destination/i);
    assert.ok(req.system.includes('<bad>The fictional Orin beacon is {{c1::a coastal marker}}.</bad>'));
    assert.ok(req.system.includes('<bad>The Orin beacon’s indicator {{c1::changes from amber to green}} only when the anchor is locked.</bad>'));
    assert.match(req.system, /separately correct.*incorrect.*split/i);
    assert.match(req.system, /one member hidden per review.*stable display order/i);
    assert.match(req.system, /stable display order.*not.*semantic order/i);
    assert.match(req.system, /learner prerequisites.*understand.*learn first/i);
    assert.match(req.system, /imagery.*mnemonics.*graphic deletion.*learner/i);
    assert.match(req.system, /prior memories.*personal examples.*emotion/i);
    assert.match(req.system, /priority.*source.*dates/i);
    assert.doesNotMatch(req.system, /prefer.*complete-list retrieval|retrieve the complete short set/i);
    assert.match(req.system, /requested attribute, relation or process.*visible cue/i);
    assert.match(req.system, /hiding the whole predicate/i);
    assert.match(req.system, /Cortisol is \{\{c1::a glucocorticoid released by the adrenal cortex through the HPA axis\}\}/);
    assert.match(req.system, /Caching keeps \{\{c1::previous results available\}\}/);
    assert.match(req.system, /before consulting hidden targets or plan context/i);
    for (const property of ['focused', 'precise', 'consistent', 'tractable', 'effortful', 'false positive', 'false negative', 'source fidelity', 'procedures']) assert.ok(req.system.toLowerCase().includes(property), `${req.label}: ${property}`);
    const schema = m.toStrictSchema(req.schema);
    const fields = schema.properties.cards?.items?.properties ?? (schema.properties.kind ? schema.properties : null);
    if (fields) {
      assert.match(fields.back.description, /explanation.*procedure/i);
      assert.doesNotMatch(fields.back.description, /term, number, name, or short phrase/);
      assert.match(fields.text.description, /focused.*source/i);
      assert.deepEqual(Object.keys(fields).filter(k => ['kind', 'front', 'back', 'text'].includes(k)).sort(), ['back', 'front', 'kind', 'text']);
    }
    const p = JSON.parse(req.user);
    assert.equal(p.language, 'English');
    assert.equal(p.instruction ?? p.highlightInstruction, f.h.instruction);
    if (stage.startsWith('rewrite')) assert.equal(p.rewriteInstruction, 'Retain the explanation.');
  }
});

test('assembled highlight requests carry the approved method without changing application schemas', async t => {
  const f = fixture(), context = await f.llm.generationContext();
  await f.llm.prepareGeneration(f.h, [], context);
  await f.llm.writeGroundedCards(f.h, [], f.preparation, context);
  await f.llm.repairGeneration(f.h, [f.card], [], f.preparation, context, [{ cardId: f.card.id, reasons: ['Missing subject.'] }]);
  await f.llm.auditGeneration(f.h, [f.card], [], f.preparation, context);
  await f.llm.auditGeneration(f.h, [f.card], [], f.preparation, context, undefined, true);
  await f.llm.writeCards(f.h);
  await f.llm.critiqueCards(f.h, [f.card]);
  await f.llm.rewriteCard(f.h, f.card, 'Retain the explanation.');
  await f.llm.rewriteCards(f.h, f.card, 'Retain the explanation.');
  assert.deepEqual(f.calls.map(r => r.label), ['preparation', 'grounded cards', 'generation repair', 'audit', 'final audit', 'cards', 'verdicts', 'card', 'rewrite cards', 'rewrite audit']);
  if (process.env.RECALL_PROMPT_EVIDENCE_DIR) {
    mkdirSync(process.env.RECALL_PROMPT_EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(process.env.RECALL_PROMPT_EVIDENCE_DIR, 'highlight-method-requests.json'), JSON.stringify(f.calls.map(({ label, system, user, schema }) => ({ label, system, user: JSON.parse(user), schema: m.toStrictSchema(schema) })), null, 2));
  }
  await t.test('all twenty rules are runtime applicability checks, not mandatory techniques', () => {
    const rules = ['Flag unclear meaning', 'Retain the supplied conceptual frame', 'Keep useful fundamentals', 'Separate independently gradable targets', 'Use selective blanks', 'Reuse helpful supplied pictures', 'Reuse supplied memory aids when helpful', 'Suggest image masking when appropriate', 'Decompose unordered collections', 'Break sequences into manageable retrievals', 'Distinguish easily confused material', 'Remove distracting wording', 'Connect to supplied prior knowledge', 'Use supplied personal examples', 'Preserve meaningful personal associations', 'Keep necessary context visible', 'Allow useful alternate retrieval directions', 'Attach evidence references', 'Retain relevant source dates or versions', "Favor the learner's priorities"];
    for (const req of f.calls) {
      const checklist = req.system.match(/<twenty_rule_checklist>([\s\S]*?)<\/twenty_rule_checklist>/)?.[1];
      assert.ok(checklist, `${req.label}: checklist must reach the transport`);
      assert.deepEqual(checklist.trim().split('\n'), rules.map((rule, i) => `${i + 1}. ${rule}.`));
      assert.match(req.system, /applicability.*not.*every technique.*every card/i);
      assert.match(req.system, /not.*proof of comprehension/i);
      assert.match(req.system, /never fabricate.*experiences.*knowledge.*understanding/i);
      assert.match(req.system, /only through supported output capabilities/i);
      assert.match(req.system, /no.*suggestion.*fields/i);
      assert.match(req.system, /lack of learner history alone.*not.*block/i);
    }
  });
  await t.test('the highlight and supported target instructions set relevance without permitting invented facts', () => {
    for (const req of f.calls) {
      assert.match(req.system, /selected highlight and explicit target instruction.*relevance boundary/i);
      assert.match(req.system, /capture\/rewrite instructions.*supported targets or style/i);
      assert.match(req.system, /never override factual grounding or the output schema/i);
      assert.match(req.system, /not.*whole note.*every conceivable question/i);
      assert.match(req.system, /material omissions.*exclusions.*omissions/i);
      assert.match(req.system, /do not omit useful foundational facts/i);
    }
    const plannerTask = f.calls[0].system.split('</writing_method>')[1];
    assert.match(plannerTask, /selected targets.*not exhaustive permutations/i);
    assert.match(plannerTask, /exclusions\/omissions/i);
  });
  await t.test('closed-list route and four-member examples use distinct reviews without a count gate', () => {
    for (const req of f.calls) {
      assert.ok(req.system.includes('Pulmonary circuit route: {{c1::right ventricle}} → {{c2::lungs}} → {{c3::left atrium}}.'));
      assert.ok(req.system.includes('Systemic circuit route: {{c1::left ventricle}} → {{c2::body}} → {{c3::right atrium}}.'));
      assert.ok(req.system.includes('The kit contains exactly four tools: {{c1::a probe}}, {{c2::a clamp}}, {{c3::a gauge}} and {{c4::a brush}}.'));
      assert.match(req.system, /one member hidden per review.*all other members visible.*stable display order/i);
      assert.match(req.system, /stable display order is not semantic order or rank/i);
      assert.match(req.system, /coherent lists and enumerations may exceed three/i);
      assert.match(req.system, /optional hints/i);
    }
  });
  await t.test('planning allows coherent source-driven grouping without one row per member', () => {
    assert.match(f.calls[0].system.split('</writing_method>')[1], /coherent route or closed list.*one row.*distinct cloze numbers.*not.*row per member/i);
  });
  await t.test('open examples may ask for examples and acceptable alternatives, never fixed missing members', () => {
    for (const req of f.calls) {
      assert.match(req.system, /explicitly example-seeking question with acceptable alternatives/i);
      assert.ok(req.system.includes('What is one example of a tool the kit may contain?'));
      assert.match(req.system, /arbitrary subsets.*unknown completeness cannot support a missing-member/i);
      assert.doesNotMatch(req.system, /use source-supported distinctions or hold with a reason|use a supported relation or hold\./i);
    }
    assert.match(f.calls[0].system.split('</writing_method>')[1], /example-seeking.*acceptable alternatives/i);
    for (const req of f.calls.filter(r => ['audit', 'final audit'].includes(r.label))) {
      assert.match(req.system.split('</writing_method>')[1], /example-seeking.*acceptable alternatives/i);
      assert.match(req.system, /different true completion.*unless.*explicitly.*examples/i);
    }
  });
  await t.test('ordered overlap supplies cue context without bundling independent answers', () => {
    for (const req of f.calls) {
      assert.match(req.system, /individual ordered steps.*overlapping cue context/i);
      assert.match(req.system, /overlap.*context.*not.*independent steps under one number/i);
      assert.match(req.system, /before\/after\/condition boundary in the visible cue/i);
      assert.match(req.system, /test the rationale separately when stated/i);
    }
  });
  await t.test('transport retains the exact schema fields and plan/fact identities', () => {
    const expected = {
      preparation: ['conflicts', 'exclusions', 'facts', 'omissions', 'plan'],
      'rewrite audit': ['preservesFacts', 'reason', 'verdicts'],
    };
    for (const req of f.calls) {
      const schema = m.toStrictSchema(req.schema);
      assert.deepEqual(Object.keys(schema.properties).sort(), expected[req.label] ?? (req.label === 'card' ? ['back', 'front', 'kind', 'text'] : ['audit', 'final audit', 'verdicts'].includes(req.label) ? ['verdicts'] : ['cards']));
      if (['grounded cards', 'generation repair'].includes(req.label)) {
        assert.deepEqual(Object.keys(schema.properties.cards.items.properties).sort(), ['back', 'factIds', 'front', 'kind', 'planId', 'text']);
        assert.equal(JSON.parse(req.user).preparation.plan[0].id, 'P1');
        assert.deepEqual(JSON.parse(req.user).preparation.plan[0].factIds, ['F1']);
      }
    }
  });
});

test('assembled planner request distinguishes scoped source holds from whole-capture holds', async () => {
  const f = fixture();
  await f.llm.prepareGeneration(f.h, [], await f.llm.generationContext());
  const req = f.calls.find(r => r.label === 'preparation');
  assert.match(req.system, /nonempty factIds hold only the affected targets, not unrelated facts/i);
  assert.match(req.system, /empty factIds hold the whole capture/i);
  assert.doesNotMatch(req.system, /empty factIds hold the whole capture, not unrelated facts/i);
});

test('assembled planner request separates attributes rather than locking a catch-all predicate', async () => {
  const f = fixture();
  await f.llm.prepareGeneration(f.h, [], await f.llm.generationContext());
  const req = f.calls.find(r => r.label === 'preparation');
  assert.match(req.system, /classification, release site and release pathway.*independently cued/i);
  assert.match(req.system, /not one catch-all predicate/i);
  assert.match(req.system, /plan a visible relation label or directed question.*aspect alone is not a cue/i);
  assert.match(req.system, /one card per row/i);
});

for (const final of [false, true]) test(`assembled ${final ? 'final ' : ''}audit starts with visible-cue false-negative checks, not source support`, async () => {
  const f = fixture();
  await f.llm.auditGeneration(f.h, [f.card], [], f.preparation, await f.llm.generationContext(), undefined, final);
  const req = f.calls.at(-1);
  assert.match(req.system, /visibleCue first.*hiddenTargets.*targetContext.*plan/i);
  assert.match(req.system, /one defective review fails the card/i);
  assert.match(req.system, /in the reason.*quote.*visibleCue.*requested relation.*missing.*fail/i);
  assert.match(req.system, /ordinal.*requested attribute, relation or process/i);
  assert.match(req.system, /source-supported.*failed/i);
  assert.match(req.system, /conflicts.*separat|separately.*conflicts/i);
  assert.match(req.system, /name the specific system.*visibleCue/i);
  assert.match(req.system, /not.*grammatical subject.*hidden consequence/i);
});

for (const final of [false, true]) test(`assembled ${final ? 'final ' : ''}audit exposes the missing-system feedback contrast without hidden-answer context`, async () => {
  const f = fixture();
  f.h.text = 'Negative feedback reduces cortisol after the stressor passes.';
  const cards = [
    m.makeCard(f.h.id, { kind: 'cloze', text: 'After the stressor passes, negative feedback {{c1::reduces cortisol}}.' }),
    m.makeCard(f.h.id, { kind: 'cloze', text: 'For cortisol, after the stressor passes, negative feedback {{c1::reduces cortisol}}.' }),
  ];
  await f.llm.auditGeneration(f.h, cards, [], f.preparation, await f.llm.generationContext(), undefined, final);
  const req = f.calls.at(-1), payload = JSON.parse(req.user);
  assert.deepEqual(payload.cards.map(c => c.reviews), [
    [{ ordinal: 1, visibleCue: 'After the stressor passes, negative feedback [...].', hiddenTargets: ['reduces cortisol'] }],
    [{ ordinal: 1, visibleCue: 'For cortisol, after the stressor passes, negative feedback [...].', hiddenTargets: ['reduces cortisol'] }],
  ]);
  assert.match(req.system, /name the specific system.*visibleCue/i);
  assert.match(req.system, /not.*grammatical subject.*hidden consequence/i);
});

for (const version of ['v1', 'v2', 'v3', 'v4', 'v5', 'v6']) test(`a ${version} method snapshot cannot certify a v7 generation batch`, async () => {
  const f = fixture();
  const c = { language: 'English', instructions: '', examples: '', rules: `recall-writing-method-${version}` };
  const batch = { id: `${version}-batch`, version: 1, instruction: '', phase: 'auditing', preparation: structuredClone(f.preparation), writerOutput: [f.draft], drafts: [f.card] };
  f.h.generation = batch;
  batch.inputKey = createHash('sha256').update(JSON.stringify({ version: 2, source: m.generationSource(f.h), instruction: '', context: c, provider: 'codex', routing: [f.settings.codexModel, f.settings.codexPath], effort: f.settings.effort, audit: f.settings.critiquePass, lint: f.settings.lintMode, language: f.settings.language, existing: [] })).digest('hex');
  const store = { all: () => [f.h], touch() {}, async flush() {}, hasUnsavedChanges: false };
  await new m.Generator({ settings: f.settings, llm: f.llm, store, refreshStatusBar() {} }).run(f.h);
  assert.notEqual(f.h.generation.id, batch.id);
  assert.equal(f.h.generationHistory[0].id, batch.id);
  assert.deepEqual(f.calls.map(r => r.label), ['preparation', 'grounded cards', 'audit']);
  assert.equal(f.h.cards[0].back, answer);
});

test('generationContext preserves its stored shape without consulting missing rule files', async () => {
  const f = fixture(), c = await f.llm.generationContext('old-batch');
  assert.deepEqual(f.reads, []);
  assert.equal(c.language, 'English');
  assert.equal(c.instructions, '');
  assert.equal(c.examples, '');
  assert.match(c.rules, /^recall-writing-method-v\d+$/);
});

for (const stage of ['prepare', 'write', 'repair', 'audit', 'final audit', 'critique', 'rewrite', 'rewrite cards', 'rewrite audit']) {
  for (const boundary of ['before dispatch', 'after transport']) test(`${stage} retains authorization checks ${boundary} without rule reads`, async () => {
    const f = fixture(), context = await f.llm.generationContext();
    let active = boundary !== 'before dispatch';
    const exec = f.llm.codex.exec;
    f.llm.codex.exec = async req => {
      const reply = await exec(req);
      if (stage !== 'rewrite audit' || req.label === 'rewrite audit') active = false;
      return reply;
    };
    const authorized = () => active;
    const invoke = () => stage === 'prepare' ? f.llm.prepareGeneration(f.h, [], context, authorized)
      : stage === 'write' ? f.llm.writeGroundedCards(f.h, [], f.preparation, context, authorized)
      : stage === 'repair' ? f.llm.repairGeneration(f.h, [f.card], [], f.preparation, context, [], authorized)
      : stage === 'audit' || stage === 'final audit' ? f.llm.auditGeneration(f.h, [f.card], [], f.preparation, context, authorized, stage === 'final audit')
      : stage === 'critique' ? f.llm.critiqueCards(f.h, [f.card], [], authorized)
      : stage === 'rewrite' ? f.llm.rewriteCard(f.h, f.card, 'Retain the explanation.', authorized)
      : f.llm.rewriteCards(f.h, f.card, 'Retain the explanation.', authorized);
    await assert.rejects(invoke, /authorization expired/i);
    assert.equal(f.calls.length, boundary === 'before dispatch' ? 0 : stage === 'rewrite audit' ? 2 : 1);
    assert.deepEqual(f.reads, []);
    assert.deepEqual(f.h.cards, []);
  });
}

test('fingerprint uses the built-in method and active settings, never retired preferences or caller context fields', async () => {
  const f = fixture(), c = await f.llm.generationContext();
  const key = m.generationKey(f.h, c, f.settings, 'batch');
  const dirty = { ...c, ...old };
  assert.equal(m.generationKey(f.h, dirty, { ...f.settings, writerInstructions: 'changed', historyExamples: false, schemaFolder: 'elsewhere', maxCardsPerHighlight: 100 }, 'batch'), key);
  for (const field of ['language', 'codexModel', 'codexPath', 'effort']) {
    assert.notEqual(m.generationKey(f.h, c, { ...f.settings, [field]: 'changed' }, 'batch'), key, field);
  }
  assert.notEqual(m.generationKey(f.h, { ...c, language: 'French' }, f.settings, 'batch'), key, 'caller-supplied language is fingerprinted');
});

for (const fingerprint of ['old method', 'empty', 'absent']) test(`a saved ${fingerprint} fingerprint batch is replaced before its preparation or drafts can be certified`, async () => {
  const f = fixture(), c = { language: 'English', instructions: old.instructions, examples: old.examples, rules: old.rules };
  const batch = { id: 'old-batch', version: 1, instruction: '', phase: 'auditing', preparation: structuredClone(f.preparation), writerOutput: [f.draft], drafts: [f.card] };
  f.h.generation = batch;
  // Exact pre-consolidation fingerprint shape. Its audit may not certify a new method.
  batch.inputKey = createHash('sha256').update(JSON.stringify({ version: 1, source: m.generationSource(f.h), instruction: '', context: c, provider: 'codex', routing: [f.settings.codexModel, f.settings.codexPath], effort: f.settings.effort, audit: f.settings.critiquePass, lint: f.settings.lintMode, liveInstructions: [f.settings.writerInstructions, f.settings.language, f.settings.maxCardsPerHighlight, f.settings.historyExamples, f.settings.schemaFolder], existing: [] })).digest('hex');
  if (fingerprint === 'empty') batch.inputKey = '';
  if (fingerprint === 'absent') delete batch.inputKey;
  const store = { all: () => [f.h], touch() {}, async flush() {}, hasUnsavedChanges: false };
  await new m.Generator({ settings: f.settings, llm: f.llm, store, refreshStatusBar() {} }).run(f.h);
  assert.notEqual(f.h.generation.id, batch.id);
  assert.equal(f.h.generationHistory[0].id, batch.id);
  assert.deepEqual(f.calls.map(r => r.label), ['preparation', 'grounded cards', 'audit']);
  assert.equal(f.h.cards[0].back, answer);
  for (const req of f.calls) assert.doesNotMatch(req.user, /LEGACY_/);
});
