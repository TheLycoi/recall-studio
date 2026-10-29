import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';

let m;
before(async () => {
  const out = await build({ stdin: { contents: `
    export { GroundedCardsOut, validatePreparation, validateDrafts, renderedCardReviews } from './src/generation';
    export { makeCard, makeHighlight } from './src/model';
    export { lintCard, isHardLintFailure } from './src/lint';
  `, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const mod = new Module('highlight-writer-cases');
  mod._compile(out.outputFiles[0].text, 'highlight-writer-cases');
  m = mod.exports;
});

// Authored regression fixtures exercise production checks, not model compliance.
const cloze = text => ({ kind: 'cloze', text, front: '', back: '' });
const qa = (front, back) => ({ kind: 'qa', front, back, text: '' });
function preparation(source) {
  return m.validatePreparation({
    facts: [{ id: 'F1', statement: source, quote: source }],
    plan: [{ id: 'P1', factIds: ['F1'], entity: 'Synthetic fixture', aspect: 'supported target', value: source, reason: 'Selected passage target.' }],
    exclusions: [], omissions: [], conflicts: [],
  }, source);
}
function check(source, fields) {
  const raw = { cards: [{ planId: 'P1', factIds: ['F1'], ...fields }] };
  const [draft] = m.validateDrafts(m.GroundedCardsOut.parse(raw), preparation(source));
  const highlight = m.makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Synthetic fixture', text: source });
  const card = m.makeCard(highlight.id, draft);
  return { draft, reviews: m.renderedCardReviews(card), hard: m.lintCard(card, highlight, []).failures.filter(m.isHardLintFailure) };
}

for (const [circuit, targets] of [
  ['Pulmonary', ['right ventricle', 'lungs', 'left atrium']],
  ['Systemic', ['left ventricle', 'body', 'right atrium']],
]) test(`${circuit} route keeps one source-backed location hidden per review`, () => {
  const source = `${circuit} circuit route: ${targets.join(' → ')}.`;
  const text = `${circuit} circuit route: ${targets.map((s, i) => `{{c${i + 1}::${s}}}`).join(' → ')}.`;
  const result = check(source, cloze(text));
  assert.deepEqual(result.hard, []);
  assert.deepEqual(result.reviews, targets.map((target, i) => ({
    ordinal: i + 1,
    visibleCue: `${circuit} circuit route: ${targets.map((s, j) => i === j ? '[...]' : s).join(' → ')}.`,
    hiddenTargets: [target],
  })));
});

const tools = ['a probe', 'a clamp', 'a gauge', 'a brush'];
const kit = 'The kit contains exactly four tools: a probe, a clamp, a gauge and a brush.';
test('the approved four-tool note permits four distinct cloze reviews', () => {
  const result = check(kit, cloze('The kit contains exactly four tools: {{c1::a probe}}, {{c2::a clamp}}, {{c3::a gauge}} and {{c4::a brush}}.'));
  assert.deepEqual(result.hard, []);
  assert.deepEqual(result.reviews.map(r => r.hiddenTargets), tools.map(s => [s]));
  assert.deepEqual(result.reviews.map(r => r.visibleCue), [
    'The kit contains exactly four tools: [...], a clamp, a gauge and a brush.',
    'The kit contains exactly four tools: a probe, [...], a gauge and a brush.',
    'The kit contains exactly four tools: a probe, a clamp, [...] and a brush.',
    'The kit contains exactly four tools: a probe, a clamp, a gauge and [...].',
  ]);
});

test('meaningful same-target repetition stays one review with both spans hidden', () => {
  const source = 'The types of Zeta signal include alpha; the selected signal type is alpha.';
  const result = check(source, cloze('The types of Zeta signal include {{c1::alpha}}; the selected signal type is {{c1::alpha}}.'));
  assert.deepEqual(result.hard, []);
  assert.deepEqual(result.reviews, [{ ordinal: 1, visibleCue: 'The types of Zeta signal include [...]; the selected signal type is [...].', hiddenTargets: ['alpha', 'alpha'] }]);
});

test('independent tool-list members cannot share one cloze number', () => {
  const result = check(kit, cloze('The kit tool list: {{c1::a probe}}, {{c1::a clamp}}, {{c1::a gauge}} and {{c1::a brush}}.'));
  assert.ok(result.hard.includes('compound-retrieval'));
  assert.deepEqual(result.reviews, [{ ordinal: 1, visibleCue: 'The kit tool list: [...], [...], [...] and [...].', hiddenTargets: tools }]);
});

for (const [source, text] of [
  ['Types include alpha and beta.', 'The types are {{c1::alpha}} and {{c2::beta}}.'],
  ['Two types include alpha and beta.', 'The two types are {{c1::alpha}} and {{c2::beta}}.'],
]) test(`open-list missing-member slots fail without completeness: ${source}`, () => {
  const result = check(source, cloze(text));
  assert.ok(result.hard.includes('unordered-list-slots'));
  assert.deepEqual(result.reviews.map(r => r.hiddenTargets), [['alpha'], ['beta']]);
});

for (const example of ['a probe', 'a clamp']) test(`explicit example-seeking Q&A accepts a supported alternative: ${example}`, () => {
  const result = check('Tools may include a probe, a clamp, a gauge and a brush.', qa('Name one example of a tool the kit may contain.', example));
  assert.deepEqual(result.hard, []);
  assert.deepEqual(result.reviews, [{ ordinal: null, visibleCue: 'Name one example of a tool the kit may contain.', hiddenTargets: [example] }]);
});

for (const [text, cue] of [
  ["The Zeta sensor's calibration signal is {{c1::blue::color}}.", "The Zeta sensor's calibration signal is [color]."],
  ["The Zeta sensor's calibration signal color is {{c1::blue}}.", "The Zeta sensor's calibration signal color is [...]."],
]) test(`optional hint contract: ${text}`, () => {
  const result = check("The Zeta sensor's calibration signal is blue.", cloze(text));
  assert.deepEqual(result.hard, []);
  assert.deepEqual(result.reviews, [{ ordinal: 1, visibleCue: cue, hiddenTargets: ['blue'] }]);
});

test('an unsupported answer span cannot widen the selected-highlight evidence boundary', () => {
  const source = "The Zeta sensor's calibration signal is blue.";
  const result = check(source, cloze("The Zeta sensor's calibration signal color is {{c1::violet}}."));
  assert.ok(result.hard.includes('cloze-not-grounded'));
  assert.throws(() => m.validatePreparation({ ...preparation(source), facts: [{ id: 'F1', statement: 'Context-only claim.', quote: 'violet' }] }, source), /quote is not in the captured snapshot/);
});

for (const kind of ['cloze', 'qa']) test(`GroundedCardsOut preserves identity while normalizing unused ${kind} fields`, () => {
  const fields = kind === 'cloze'
    ? { kind, text: '  The signal color is {{c1::blue}}.  ', front: 'Unused question', back: 'Unused answer' }
    : { kind, front: '  What is the signal color?  ', back: '  blue  ', text: 'Unused cloze text' };
  const result = check('The signal color is blue.', fields);
  assert.deepEqual(result.draft, { planId: 'P1', factIds: ['F1'], ...(kind === 'cloze'
    ? cloze('The signal color is {{c1::blue}}.') : qa('What is the signal color?', 'blue')) });
  assert.deepEqual(result.hard, []);
});

test('application schema still requires valid plan and fact references', () => {
  const source = 'The signal color is blue.';
  const draft = { planId: 'P1', factIds: ['F1'], ...cloze('The signal color is {{c1::blue}}.') };
  for (const key of ['planId', 'factIds']) {
    const missing = { ...draft }; delete missing[key];
    assert.equal(m.GroundedCardsOut.safeParse({ cards: [missing] }).success, false);
  }
  assert.throws(() => m.validateDrafts({ cards: [{ ...draft, planId: 'P99' }] }, preparation(source)), /plan reference/);
  assert.throws(() => m.validateDrafts({ cards: [{ ...draft, factIds: ['F99'] }] }, preparation(source)), /fact links/);
});
