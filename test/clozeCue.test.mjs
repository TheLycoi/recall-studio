import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';

let m;
before(async () => {
  const out = await build({ stdin: { contents: `
    export { makeHighlight, makeCard } from './src/model';
    export { lintCard, isHardLintFailure } from './src/lint';
  `, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const mod = new Module('cloze-cue');
  mod._compile(out.outputFiles[0].text, 'cloze-cue');
  m = mod.exports;
});

const source = '- **Cortisol and its role in the body’s stress response** — A glucocorticoid released by the adrenal cortex through the HPA axis. It keeps blood glucose available for the brain and muscles and enhances catecholamine effects on the cardiovascular system. Negative feedback reduces cortisol after the stressor passes.';
const weak = [
  'Cortisol is {{c1::a glucocorticoid released by the adrenal cortex through the HPA axis}}.',
  'Cortisol keeps {{c1::blood glucose available for the brain and muscles}}.',
  'Cortisol {{c1::enhances catecholamine effects on the cardiovascular system}}.',
];
function failures(text, captured = source) {
  return m.lintCard(m.makeCard('h', { kind: 'cloze', text }), m.makeHighlight({ sourcePath: 'capture.md', text: captured }), []).failures.filter(m.isHardLintFailure);
}

test('the three observed topic-only fronts fail a non-waivable cue check', () => {
  for (const text of weak) assert.ok(failures(text).includes('cloze-cue-unspecified'), text);
});

test('the observed feedback condition remains a valid retrieval cue', () => {
  assert.deepEqual(failures('For cortisol, after the stressor passes, negative feedback {{c1::reduces cortisol}}.'), []);
});

const structuralDefects = [
  ['Insulin is {{c1::a peptide hormone}}.', 'Insulin is a peptide hormone.'],
  ['Working memory keeps {{c1::information available for ongoing tasks}}.', 'Working memory keeps information available for ongoing tasks.'],
  ['New York {{c1::has five boroughs}}.', 'New York has five boroughs.'],
  ['**Cortisol** keeps {{c1::blood glucose available for the brain and muscles::effect}}.', source],
  ['`Cortisol` {{c1::enhances catecholamine effects on the cardiovascular system::relation}}.', source],
  ['Cortisol is {{c1::a glucocorticoid::type}}.', source],
  ['Cortisol {{c1::keeps blood glucose available for the brain and muscles}} and {{c1::enhances catecholamine effects on the cardiovascular system}}.', source],
  ['Cortisol keeps {{c1::blood glucose available for the brain and muscles}}. For cortisol, after the stressor passes, negative feedback {{c1::reduces cortisol}}.', source],
  ['For cortisol, after the stressor passes, negative feedback {{c1::reduces cortisol}}. Cortisol keeps {{c2::blood glucose available for the brain and muscles}}.', source],
  ['Cortisol keeps {{c1::blood glucose available for the brain and muscles}}. For cortisol, after the stressor passes, negative feedback {{c2::reduces cortisol}}.', source],
];
for (const [text, captured] of structuralDefects) test(`bare-topic structural family: ${text}`, () => {
  assert.ok(failures(text, captured).includes('cloze-cue-unspecified'), text);
});

const clearCues = [
  ['Cortisol hormone class: {{c1::glucocorticoid}}.', source],
  ['Cortisol release site is the {{c1::adrenal cortex}}.', source],
  ['Cortisol release pathway is the {{c1::HPA axis}}.', source],
  ["Cortisol's role in glucose availability is to keep {{c1::blood glucose available for the brain and muscles}}.", source],
  ["Cortisol's cardiovascular interaction {{c1::enhances catecholamine effects on the cardiovascular system}}.", source],
  ['Definition of insulin: {{c1::a peptide hormone}}.', 'Insulin is a peptide hormone.'],
  ['Insulin classification is {{c1::a peptide hormone}}.', 'Insulin is a peptide hormone.'],
  ['Insulin is {{c1::a peptide hormone::hormone class}}.', 'Insulin is a peptide hormone.'],
  ['Insulin is {{c1::a peptide hormone::definition}}.', 'Insulin is a peptide hormone.'],
  ['The sky is {{c1::blue::color}}.', 'The sky is blue.'],
  ['Cortisol is {{c1::a glucocorticoid::hormone class}}.', source],
  ['Cortisol is {{c1::released by the adrenal cortex::release site}}.', source],
  ['New York borough count is {{c1::five}}.', 'New York has five boroughs.'],
  ['Cortisol enhances {{c1::catecholamine effects on the cardiovascular system}}.', source],
  ['Cortisol inhibits {{c1::its own release}}.', 'Cortisol inhibits its own release.'],
  ['After the stressor passes, cortisol is {{c1::reduced by negative feedback}}.', 'After the stressor passes, cortisol is reduced by negative feedback.'],
  ['If the indicator turns green, the sensor is {{c1::ready}}.', 'If the indicator turns green, the sensor is ready.'],
  ['Why disconnect power before calibration? {{c1::Disconnecting power prevents a false reading because the cable must be attached before measurement resumes}}.', 'Disconnecting power prevents a false reading because the cable must be attached before measurement resumes.'],
  ['Zeta calibration procedure: {{c1::disconnect power, attach cable, reconnect power}}.', 'Zeta calibration procedure: disconnect power, attach cable, reconnect power.'],
  ['Cortisol release site is the {{c1::adrenal cortex}} and release pathway is the {{c2::HPA axis}}.', source],
  ['Cortisol release site is the {{c1::adrenal cortex}} and release pathway is the {{c1::HPA axis}}.', source],
];
for (const [text, captured] of clearCues) test(`explicit relation or focused explanation stays valid: ${text}`, () => {
  assert.deepEqual(failures(text, captured), []);
});
