// Authored production regressions, not live-model quality measurements.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';

let m;
before(async () => {
  const out = await build({ stdin: { contents: `export { lintCard, isHardLintFailure } from './src/lint'; export { renderedCardReviews } from './src/generation'; export { checkCard, checkAndRepairCard } from './src/cardActions'; export { makeCard, makeHighlight } from './src/model';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'cjs', platform: 'node', external: ['obsidian'], logLevel: 'silent' });
  const mod = new Module('lint-retrieval-exceptions');
  mod.require = id => id === 'obsidian' ? { Notice: class {}, requestUrl() { throw Error('Network forbidden'); } } : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text, 'lint-retrieval-exceptions');
  m = mod.exports;
});
const source = "Zeta's signal types include alpha and beta.";
function qa(front, back = 'alpha or beta', text = source) {
  const h = m.makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Zeta', text, status: 'ready' });
  const c = m.makeCard(h.id, { kind: 'qa', front, back });
  h.cards = [c];
  return { h, c, lint: m.lintCard(c, h, []) };
}

for (const front of [
  "Name one example of Zeta's signal types.",
  "Give **one example** of Zeta's signal types?",
  "What is one example of Zeta's signal types?",
  "Name one type of Zeta signal.",
  "Give one kind of Zeta signal.",
]) test(`singular example alternatives: ${front}`, () => {
  const { c, lint } = qa(front, '**alpha** or `beta`.');
  assert.deepEqual(lint.failures, []);
  assert.deepEqual(m.renderedCardReviews(c), [{ ordinal: null, visibleCue: front.replaceAll('**', ''), hiddenTargets: ['alpha or beta.'] }]);
});

for (const [front, back, text = source] of [
  ["Name two examples of Zeta's signal types.", 'alpha or beta'],
  ["List all Zeta signal types.", 'alpha or beta'],
  ["Name both Zeta signal types.", 'alpha and beta'],
  ["Give examples of Zeta's signal types.", 'alpha or beta'],
  ["Name one example of Zeta's signal types and explain its use.", 'alpha or beta'],
  ["Name one example of Zeta's signal types; what is its color?", 'alpha or beta'],
  ["Name one example of Zeta's signal types? What is its color?", 'alpha or beta'],
  ["Name one example of Zeta's signal types, then explain its use.", 'alpha or beta'],
  ["Name one example of Zeta's signal types plus its color.", 'alpha or beta'],
  ["Name one type of Zeta signal.", 'alpha or gamma'],
  ["Give one kind of Zeta signal.", 'alpha and beta'],
  ["Name one example of Zeta's signal types.", 'alpha and beta'],
  ["Name one example of Zeta's alpha signal types.", 'alpha or beta'],
  ["Name one example of Zeta's signal types.", 'alpha or gamma'],
  ["Name one example of Zeta's signal types.", 'alpha or beta', "Zeta's signal types include alphabet and betamax."],
  ["Name **two examples** of Zeta's signal types?", '**alpha** or `beta`.'],
]) test(`compound/unsupported control: ${front} / ${back} / ${text}`, () => {
  assert.ok(qa(front, back, text).lint.failures.includes('compound-retrieval'));
});

test('production Check/Repair accepts a supported singular alternative without rewriting', async () => {
  const { h, c } = qa("Name one example of Zeta's signal types.");
  let calls = 0;
  const critique = async () => { calls++; return [{ verdict: 'keep', reason: 'Synthetic supported alternative.' }]; };
  const result = await m.checkAndRepairCard(c, h, critique, async () => { throw Error('Unexpected rewrite'); });
  assert.equal(result.status, 'checked');
  assert.equal(calls, 1);
  assert.deepEqual(c.userCheck.issues, []);
});

const setSource = 'For Zeta, the three effects are alpha, beta and gamma.';
function cloze(text, source = setSource) {
  const h = m.makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Zeta', text: source });
  const c = m.makeCard(h.id, { kind: 'cloze', text });
  return { h, c, lint: m.lintCard(c, h, []) };
}
for (const text of [
  'For Zeta, the three effects are {{c1::gamma}}, beta and alpha.',
  'For Zeta, the three effects are {{c1::gamma}}, {{c2::beta}} and {{c3::alpha}}.',
  'For **Zeta**, the three effects are {{c1::`gamma`}}, **beta**, and {{c2::alpha}}!',
]) test(`complete unordered membership permits authored display order: ${text}`, () => {
  const { c, lint } = cloze(text);
  assert.deepEqual(lint.failures, []);
  for (const r of m.renderedCardReviews(c)) {
    assert.equal(r.hiddenTargets.length, 1);
    const hidden = r.hiddenTargets[0].replaceAll('`', ''); // Export preserves markup inside a cloze body literally.
    for (const member of ['alpha', 'beta', 'gamma'].filter(x => x !== hidden)) assert.ok(r.visibleCue.includes(member));
  }
});
for (const [text, source = setSource] of [
  ['For Zeta, the three effects are {{c1::gamma}} and alpha.'],
  ['For Zeta, the two effects are {{c1::gamma}} and alpha.'],
  ['For Zeta, the three effects are {{c1::gamma}}, alpha and alpha.'],
  ['For Zeta, the four effects are {{c1::gamma}}, beta, alpha and delta.', setSource + ' Delta is a color.'],
  ['For Zeta, the three effects are {{c1::gamma}}, beta and alpha.', 'For Zeta, three effects include alpha, beta and gamma.'],
  ['For Zeta, the three effects are {{c1::gamma}}, beta and alpha.', 'For Zeta, the three effects in ranked order are alpha, beta and gamma.'],
  ['For Zeta, the three effects are {{c1::gamma}}, beta and alpha.', 'For Zeta, the three ordered effects are alpha, beta and gamma.'],
]) test(`set boundary control: ${text} / ${source}`, () => {
  assert.ok(cloze(text, source).lint.failures.includes('unordered-list-slots'));
});

test('independent unordered members may not share a hidden number', () => {
  const { c, lint } = cloze('For Zeta, the three effects are {{c1::gamma}}, {{c1::beta}} and alpha.');
  assert.ok(lint.failures.includes('compound-retrieval'));
  assert.deepEqual(m.renderedCardReviews(c)[0].hiddenTargets, ['gamma', 'beta']);
});

test('membership preserves multiplicity, not merely a Set of distinct words', () => {
  const { lint } = cloze('For Zeta, the three effects are {{c1::gamma}}, alpha and alpha.', 'For Zeta, the three effects are alpha, gamma and gamma.');
  assert.ok(lint.failures.includes('unordered-list-slots'));
});

test('ordered procedure boundary and whole-route compound controls survive', () => {
  const { lint } = cloze('During Zeta calibration, {{c1::disconnect power}}.', 'During Zeta calibration, disconnect power before attaching the reference cable.');
  assert.ok(lint.failures.includes('procedure-boundary-hidden'));
  const route = cloze('The route components are {{c1::inlet and outlet}}.', 'The route components are inlet and outlet.');
  assert.ok(route.lint.failures.includes('compound-retrieval'));
});
