import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';

let m;
before(async () => {
  const out = await build({ stdin: { contents: `
    export { Generator } from './src/generator';
    export { LlmClient } from './src/llm';
    export { CodexBackend } from './src/codex';
    export { makeHighlight, makeCard } from './src/model';
    export { lintCard, isHardLintFailure, LINT_LABELS, LINT_FIX_INSTRUCTIONS } from './src/lint';
    export { CARD_WRITING_METHOD } from './src/writerMethod';
    export { renderedCardReviews } from './src/generation';
    export { parseInboxJson } from './src/inboxData';
    export { rewriteCandidates } from './src/explicitRewrite';
    export { buildNote } from './src/anki';
    export { clozeToDisplay, inlineMarkdownToHtml, buildAnkiTextImport } from './src/util';
  `, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'], logLevel: 'silent' });
  const mod = new Module('writing-limitations');
  mod.require = id => id === 'obsidian' ? { Notice: class {}, requestUrl() { throw Error('Network forbidden'); } } : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text, 'writing-limitations');
  m = mod.exports;
});

const list = {
  source: 'Zeta warning mode has two effects: lower sensor gain and slower sampling.',
  text: 'In Zeta warning mode, the two effects are {{c1::lower sensor gain and slower sampling}}.',
  repeated: 'In Zeta warning mode, the two effects are {{c1::lower sensor gain}} and {{c1::slower sampling}}.',
  repaired: 'In Zeta warning mode, the two effects are {{c1::lower sensor gain}} and {{c2::slower sampling}}.',
  id: 'compound-retrieval',
};

function fixture(c, { repeat = false, conflict = false } = {}) {
  const h = m.makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Synthetic Zeta capture', text: c.source });
  const preparation = { facts: [{ id: 'F1', statement: c.source, quote: c.source }], plan: [{ id: 'P1', factIds: ['F1'], entity: 'Zeta', aspect: 'captured relationship', value: c.source, reason: 'Synthetic supported target.' }], exclusions: [], omissions: [], conflicts: [] };
  const draft = text => ({ planId: 'P1', factIds: ['F1'], kind: 'cloze', text, front: '', back: '' });
  const settings = { provider: 'codex', codexModel: 'synthetic', language: '', critiquePass: false, lintMode: 'off', concurrency: 1, notifyWhenReady: false };
  const calls = [], saves = [], retained = [];
  const llm = new m.LlmClient(() => settings);
  const backend = new m.CodexBackend(() => settings);
  backend.exec = async req => {
    calls.push(req);
    const payload = JSON.parse(req.user);
    assert.deepEqual(h.cards, retained, 'private candidates stay outside Inbox through the final transport');
    if (req.label === 'preparation') return JSON.stringify(preparation);
    if (req.label === 'grounded cards') return JSON.stringify({ cards: [draft(c.text)] });
    if (req.label === 'generation repair') return JSON.stringify({ cards: [draft(repeat ? c.repeated : c.repaired)] });
    assert.ok(['audit', 'final audit'].includes(req.label), req.label);
    assert.deepEqual(payload.cards[0].reviews, m.renderedCardReviews(m.makeCard(h.id, { kind: 'cloze', text: req.label === 'audit' ? c.text : repeat ? c.repeated : c.repaired })));
    return JSON.stringify({ verdicts: payload.cards.map((card, index) => ({ index, cardId: card.id, status: 'verified', reason: 'Always-positive synthetic audit, not live-model evidence.', conflicts: conflict ? [{ quote: c.source, reason: 'Insufficient evidence for the planned scope.' }] : [] })) });
  };
  llm.codex = backend;
  const plugin = { settings, llm, store: { all: () => [h], touch() {}, async flush() { saves.push(structuredClone(h)); }, hasUnsavedChanges: false }, refreshStatusBar() {} };
  return { h, preparation, calls, saves, retained, plugin, g: new m.Generator(plugin) };
}

function hardFailures(source, text) {
  return m.lintCard(m.makeCard('h', { kind: 'cloze', text }), m.makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Synthetic', text: source }), []).failures.filter(m.isHardLintFailure);
}

function guardedCases(c) {
  test(`${c.id}: recognized surface is a hard defect with an actionable label`, () => {
    assert.ok(hardFailures(c.source, c.text).includes(c.id));
    assert.ok(m.LINT_LABELS[c.id]);
    assert.match(m.LINT_FIX_INSTRUCTIONS[c.id], /source|highlight|supported/);
  });
  for (const repeat of [false, true]) test(`${c.id}: positive audits ${repeat ? 'cannot waive repeated defects' : 'publish only a valid repair after recheck'}`, async () => {
    const f = fixture(c, { repeat });
    await f.g.run(f.h);
    assert.deepEqual(f.calls.map(r => r.label), ['preparation', 'grounded cards', 'audit', 'generation repair', 'final audit']);
    assert.equal(f.h.cards.length, repeat ? 0 : 1, f.h.error ?? 'recognized hard defect must not publish');
    assert.equal(f.h.generation.drafts[0].text, c.text, 'retain original wording');
    assert.equal(f.h.generation.preparation.facts[0].quote, c.source);
    assert.equal(f.h.text, c.source);
    assert.equal(f.h.generation.repairs.length, 1, 'one bounded repair, no loop');
    assert.equal(f.h.generation.repairs[0].candidate.id, f.h.generation.drafts[0].id);
    const repair = JSON.parse(f.calls.find(r => r.label === 'generation repair').user);
    assert.ok(JSON.stringify(repair).includes(m.LINT_FIX_INSTRUCTIONS[c.id]));
    if (repeat) {
      assert.ok(f.h.generation.blocked[0].reasons.includes(m.LINT_FIX_INSTRUCTIONS[c.id]));
      assert.ok(f.saves.every(h => h.cards.length === 0));
    } else {
      const card = f.h.cards[0];
      assert.equal(card.text, c.repaired);
      assert.equal(card.generation.audit.status, 'verified');
      assert.ok(card.generation.audit.provenance.sourceKey);
      assert.equal(card.status, 'pending', 'generation is not export approval');
      assert.ok(f.saves.at(-1).cards.some(saved => saved.text === c.repaired));
    }
    const parsed = m.parseInboxJson(JSON.stringify({ version: 1, highlights: [f.h] }));
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.data.highlights[0], f.h, 'preserve findings, history and provenance without a migration');
  });
  test(`${c.id}: source holds never authorize wording repair`, async () => {
    const f = fixture(c, { conflict: true });
    await f.g.run(f.h);
    assert.equal(f.h.cards.length, 0);
    assert.deepEqual(f.calls.map(r => r.label), ['preparation', 'grounded cards', 'audit']);
    assert.equal(f.h.generation.drafts[0].text, c.text);
    assert.ok(f.h.generation.blocked[0].reasons.some(reason => reason.includes(c.source)));
    assert.equal(f.h.generation.audit.verdicts[0].conflicts[0].quote, c.source);
  });
}

for (const [source, text] of [
  ['Zeta sensor voltage is 5 V.', 'Zeta sensor voltage is {{c1::5 V}}.'],
  ['Normal body temperature is 37 °C.', 'Normal body temperature is {{c1::37 °C}}.'],
]) {
  test(`explicit attribute survives production generation without repair: ${text}`, async () => {
    const f = fixture({ source, text });
    await f.g.run(f.h);
    assert.deepEqual(f.calls.map(r => r.label), ['preparation', 'grounded cards', 'audit']);
    assert.equal(f.h.cards[0]?.text, text);
    assert.equal(f.h.cards[0].status, 'pending');
  });
  test(`explicit rewrite validation accepts a clear attribute: ${text}`, () => {
    const h = m.makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Synthetic', text: source });
    const card = m.makeCard(h.id, { kind: 'cloze', text });
    assert.equal(m.rewriteCandidates(card, h, [{ kind: 'cloze', text, front: '', back: '' }])[0].text, text);
  });
}

guardedCases(list);

const cortisolSource = '- **Cortisol and its role in the body’s stress response** — A glucocorticoid released by the adrenal cortex through the HPA axis. It keeps blood glucose available for the brain and muscles and enhances catecholamine effects on the cardiovascular system. Negative feedback reduces cortisol after the stressor passes.';
for (const [text, repaired] of [
  ['Cortisol is {{c1::a glucocorticoid released by the adrenal cortex through the HPA axis}}.', 'Cortisol hormone class: {{c1::glucocorticoid}}; cortisol is released by the {{c2::adrenal cortex}} through the {{c3::HPA axis}}.'],
  ['Cortisol keeps {{c1::blood glucose available for the brain and muscles}}.', "Cortisol's role in glucose availability is to keep {{c1::blood glucose available for the brain and muscles}}."],
  ['Cortisol {{c1::enhances catecholamine effects on the cardiovascular system}}.', "Cortisol's cardiovascular interaction {{c1::enhances catecholamine effects on the cardiovascular system}}."],
]) guardedCases({ source: cortisolSource, text, repeated: text.replace('.', '!'), repaired, id: 'cloze-cue-unspecified' });

for (const [text, repaired] of [
  ['Cortisol {{c1::enhances catecholamine effects on the cardiovascular system::its role}}.', "Cortisol's cardiovascular interaction {{c1::enhances catecholamine effects on the cardiovascular system}}."],
  ['Cortisol keeps {{c1::blood glucose available for the brain and muscles::main function}}.', "Cortisol's role in glucose availability is to keep {{c1::blood glucose available for the brain and muscles}}."],
  ['Cortisol {{c1::enhances catecholamine effects on the cardiovascular system}} and keeps {{c2::blood glucose available for the brain and muscles}}.', "Cortisol's cardiovascular interaction {{c1::enhances catecholamine effects on the cardiovascular system}}; cortisol's role in glucose availability is to keep {{c2::blood glucose available for the brain and muscles}}."],
  ['Cortisol is {{c1::a glucocorticoid}} and keeps {{c1::blood glucose available for the brain and muscles}}.', "Cortisol hormone class: {{c1::glucocorticoid}}; cortisol's role in glucose availability is to keep {{c2::blood glucose available for the brain and muscles}}."],
]) {
  guardedCases({ source: cortisolSource, text, repeated: text.replace('.', '!'), repaired, id: 'cloze-cue-unspecified' });
  test(`explicit rewrite rejects an unspecified hint or joined clause: ${text}`, () => {
    const h = m.makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Synthetic', text: cortisolSource });
    const card = m.makeCard(h.id, { kind: 'cloze', text });
    assert.throws(() => m.rewriteCandidates(card, h, [{ kind: 'cloze', text, front: '', back: '' }]), /missing retrieval relation/);
  });
}

test('the observed feedback control publishes unchanged without a repair', async () => {
  const text = 'For cortisol, after the stressor passes, negative feedback {{c1::reduces cortisol}}.';
  const f = fixture({ source: cortisolSource, text });
  await f.g.run(f.h);
  assert.deepEqual(f.calls.map(r => r.label), ['preparation', 'grounded cards', 'audit']);
  assert.equal(f.h.cards.length, 1);
  assert.equal(f.h.cards[0].text, text);
});

test('the class, site and pathway replacement has an independently cued rendered review for each attribute', () => {
  const card = m.makeCard('h', { kind: 'cloze', text: 'Cortisol hormone class: {{c1::glucocorticoid}}; cortisol is released by the {{c2::adrenal cortex}} through the {{c3::HPA axis}}.' });
  assert.deepEqual(m.renderedCardReviews(card), [
    { ordinal: 1, visibleCue: 'Cortisol hormone class: [...]; cortisol is released by the adrenal cortex through the HPA axis.', hiddenTargets: ['glucocorticoid'] },
    { ordinal: 2, visibleCue: 'Cortisol hormone class: glucocorticoid; cortisol is released by the [...] through the HPA axis.', hiddenTargets: ['adrenal cortex'] },
    { ordinal: 3, visibleCue: 'Cortisol hormone class: glucocorticoid; cortisol is released by the adrenal cortex through the [...].', hiddenTargets: ['HPA axis'] },
  ]);
  assert.match(m.CARD_WRITING_METHOD, /never independent attributes or list members/i);
  assert.deepEqual(hardFailures(cortisolSource, card.text), []);
});

// Closed-list slots are intentional: display order does not assert semantic order.
for (const [source, text] of [
  [list.source, list.repaired],
  [list.source, 'In Zeta warning mode, the two effects are {{c1::lower sensor gain}} and slower sampling.'],
  [list.source, 'In Zeta warning mode, the two effects are lower sensor gain and {{c1::slower sampling}}.'],
  ['The two types are alpha and beta.', 'The two types: {{c1::alpha}} and beta.'],
  ['The two parts are alpha and beta.', 'The two parts include alpha and {{c1::beta}}.'],
  ['The two features are higher output and longer battery life.', 'The two features are {{c1::higher output}} and longer battery life.'],
  ['The three types are alpha, beta and gamma.', 'The 3 types: {{c1::alpha}}, {{c2::beta}}, and {{c3::gamma}}.'],
  ['The three types are alpha, beta and gamma.', 'The three types are {{c1::alpha::type}}, {{c2::beta::type}} and {{c3::gamma::type}}.'],
]) test(`complete bounded slots publish without repair: ${text}`, async () => {
  assert.deepEqual(hardFailures(source, text), []);
  const f = fixture({ source, text });
  await f.g.run(f.h);
  assert.deepEqual(f.calls.map(r => r.label), ['preparation', 'grounded cards', 'audit']);
  assert.equal(f.h.cards[0].text, text);
});

for (const [source, text] of [
  ['Types include alpha and beta.', 'The types include {{c1::alpha}} and {{c2::beta}}.'],
  ['Some examples of types are alpha and beta.', 'The two types are {{c1::alpha}} and {{c2::beta}}.'],
  ['The three types are alpha, beta and gamma.', 'The three types are {{c1::alpha}} and beta.'],
  ['The two effects are lower sensor gain and faster sampling.', 'The two effects are {{c1::lower sensor gain}} and slower sampling.'],
]) test(`open, arbitrary subset or unsupported list stays defective: ${text}`, () => {
  assert.ok(hardFailures(source, text).includes('unordered-list-slots'));
});

test('list boundary controls retain order, named relations and focused procedures', () => {
  for (const [source, text] of [
    ['Zeta setup requires first disconnect power, then attach the reference cable.', 'Zeta setup requires first {{c1::disconnect power}}, then {{c2::attach the reference cable}}.'],
    ['In Zeta warning mode, sensor gain is lower and sampling is slower.', 'In Zeta warning mode, sensor gain is {{c1::lower}} and sampling is {{c2::slower}}.'],
    ['Zeta uses two channels: input carries voltage and output carries current.', 'Zeta uses two channels: input carries {{c1::voltage}} and output carries {{c2::current}}.'],
  ]) assert.deepEqual(hardFailures(source, text), [], text);
});

test('shared method contrasts whole-set recall with atomic closed-list retrieval', () => {
  assert.match(m.CARD_WRITING_METHOD, /never hide the whole set or independent members under one number/i);
  assert.match(m.CARD_WRITING_METHOD, /one member hidden per review with all other members visible/i);
  assert.match(m.CARD_WRITING_METHOD, /stable display order is not semantic order/i);
});

const procedure = {
  source: 'During Zeta calibration, disconnect power before attaching the reference cable.',
  text: 'During Zeta calibration, {{c1::disconnect power}}.',
  repeated: 'During Zeta calibration, {{c1::disconnect power}}!',
  repaired: 'During Zeta calibration, before attaching the reference cable, {{c1::disconnect power}}.',
  id: 'procedure-boundary-hidden',
};
guardedCases(procedure);

test('procedural boundary controls keep full procedures, facts, explicit cues and unrelated source steps valid', () => {
  const cases = [
    [procedure.source, procedure.repaired],
    [procedure.source, 'During Zeta calibration, {{c1::disconnect power before attaching the reference cable}}.'],
    ['During Zeta calibration, disconnect power.', procedure.text],
    ['During Zeta calibration, the LED glows blue before the reference cable is attached.', 'During Zeta calibration, {{c1::the LED glows blue}}.'],
    ['During Zeta maintenance, open circuit voltage is stable before the next test.', 'During Zeta maintenance, {{c1::open circuit voltage is stable}}.'],
    ['During Zeta setup, set A is active before the next check.', 'During Zeta setup, {{c1::set A is active}}.'],
    ['During Zeta calibration, disconnect switch opens before the reference cable is attached.', 'During Zeta calibration, {{c1::disconnect switch opens}}.'],
    ['During Zeta calibration, disconnect power. Before attaching the reference cable, inspect the pins.', procedure.text],
    ['During Zeta calibration, disconnect power before attaching the reference cable. Then wait until the indicator turns green before reconnecting power.', 'During Zeta calibration, {{c1::disconnect power before attaching the reference cable}}. Then wait until {{c2::the indicator turns green}} before reconnecting power.'],
    ['Durante la calibración Zeta, desconecte la alimentación antes de conectar el cable.', 'Durante la calibración Zeta, {{c1::desconecte la alimentación}}.'],
  ];
  for (const [source, text] of cases) assert.deepEqual(hardFailures(source, text), [], text);
});

test('shared method shows an explicit source-supported procedural cue', () => {
  assert.ok(m.CARD_WRITING_METHOD.includes(procedure.text));
  assert.ok(m.CARD_WRITING_METHOD.includes('For Zeta sensor calibration, what must happen before attaching the reference cable?'));
});

test('narrow procedural detector retains before/after/condition source boundaries', () => {
  for (const boundary of ['before', 'after', 'until', 'only when', 'when']) {
    const source = `For Zeta setup, connect the power supply ${boundary} the indicator turns green.`;
    assert.ok(hardFailures(source, 'For Zeta setup, {{c1::connect the power supply::action}}.').includes('procedure-boundary-hidden'), boundary);
  }
});

const hintSource = 'The fictional Zeta sensor uses a blue calibration signal.';
const hinted = "The fictional Zeta sensor's calibration signal is {{c1::blue::color}}.";
const noHint = "The fictional Zeta sensor's calibration signal color is {{c1::blue}}.";
const leakingHint = "The fictional Zeta sensor's calibration signal is {{c1::blue::blue}}.";

test('shared method contrasts a useful optional type hint, a clear no-hint cue and an answer-leaking hint', () => {
  assert.match(m.CARD_WRITING_METHOD, /optional hints.*omit when clear/i);
  assert.match(m.CARD_WRITING_METHOD, /hints cannot replace subject\/conditions or leak through synonyms, initials or grammar/i);
  assert.match(m.CARD_WRITING_METHOD, /no hint quota/i);
  assert.match(m.CARD_WRITING_METHOD, /unsupported reason/i);
});

for (const [text, cue] of [[hinted, "The fictional Zeta sensor's calibration signal is [color]."], [noHint, "The fictional Zeta sensor's calibration signal color is [...]."]]) test(`optional hint: exact production parse, review, persistence and export retention: ${text}`, async () => {
  const f = fixture({ source: hintSource, text });
  await f.g.run(f.h);
  assert.deepEqual(f.calls.map(r => r.label), ['preparation', 'grounded cards', 'audit']);
  assert.equal(f.h.cards.length, 1);
  const card = f.h.cards[0];
  assert.equal(card.text, text);
  assert.deepEqual(m.renderedCardReviews(card), [{ ordinal: 1, visibleCue: cue, hiddenTargets: ['blue'] }]);
  assert.equal(m.clozeToDisplay(text), text.replace(/\{\{c1::blue(?:::color)?\}\}/, '[blue]'), 'Inbox display does not confuse a hint with its answer');
  const reload = m.parseInboxJson(JSON.stringify({ version: 1, highlights: [f.h] }));
  assert.equal(reload.ok, true);
  assert.equal(reload.data.highlights[0].cards[0].text, text);
  const before = structuredClone(card);
  const note = m.buildNote(card, f.h, { vaultName: 'Synthetic', deck: 'Synthetic', settings: { includeExtra: true, extraTags: '', includeSourceTag: false, clozeModel: 'Cloze', clozeTextField: 'Text', clozeExtraField: 'Back Extra' } });
  assert.equal(note.fields.Text, m.inlineMarkdownToHtml(text));
  assert.ok(note.fields['Back Extra'].includes(hintSource));
  assert.ok(!note.fields.Text.includes(hintSource), 'source quote stays off the question');
  const tsv = m.buildAnkiTextImport([{ notetype: note.modelName, deck: note.deckName, fields: Object.values(note.fields), tags: note.tags }]);
  assert.ok(tsv.includes(text));
  assert.deepEqual(card, before, 'building an export does not rewrite a saved card');
});

test('missing and longer hints alone remain valid', () => {
  for (const text of [noHint, hinted.replace('::color', '::the visible color rather than duration or intensity')]) assert.deepEqual(hardFailures(hintSource, text), []);
});

guardedCases({ source: hintSource, text: leakingHint, repaired: hinted, repeated: leakingHint.replace('.', '!'), id: 'answer-in-question' });

test('new lint IDs round-trip as existing string arrays without a storage migration', () => {
  const f = fixture(list);
  const card = m.makeCard(f.h.id, { kind: 'cloze', text: list.text, lintFailures: ['unordered-list-slots', 'procedure-boundary-hidden'] });
  f.h.cards.push(card);
  const reload = m.parseInboxJson(JSON.stringify({ version: 1, highlights: [f.h] }));
  assert.equal(reload.ok, true);
  assert.deepEqual(reload.data.highlights[0].cards[0], card);
});

test('new generation never silently rewrites existing generated or exported cards', async () => {
  const f = fixture(procedure);
  for (const status of ['pending', 'exported']) {
    const card = m.makeCard(f.h.id, { kind: 'qa', front: `Retained ${status} question`, back: 'Retained answer', status, extra: 'Reviewer annotation', ankiNoteId: status === 'exported' ? 42 : undefined });
    f.h.cards.push(card);
    f.retained.push(structuredClone(card));
  }
  await f.g.run(f.h);
  assert.equal(f.h.cards.length, 3);
  assert.deepEqual(f.h.cards.slice(0, 2), f.retained);
});
