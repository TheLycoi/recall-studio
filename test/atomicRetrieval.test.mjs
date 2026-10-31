import { auditVerdict } from './auditFixture.mjs';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';

let m;
before(async () => {
  const out = await build({ stdin: { contents: `export { Generator } from './src/generator'; export { LlmClient } from './src/llm'; export { CodexBackend } from './src/codex'; export { makeCard, makeHighlight } from './src/model'; export { lintCard, isHardLintFailure } from './src/lint'; export { renderedCardReviews } from './src/generation';`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'], logLevel: 'silent' });
  const mod = new Module('atomic-retrieval');
  mod.require = id => id === 'obsidian' ? { Notice: class {}, requestUrl() { throw Error('Network forbidden'); } } : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text, 'atomic-retrieval');
  m = mod.exports;
});

const originals = ['Non-judging', 'patience', 'beginner’s mind', 'trust', 'non-striving', 'acceptance', 'letting go'];
const additions = ['generosity', 'gratitude'];
const source = '**The Pillars of Mindfulness** — Non-judging, patience, beginner’s mind, trust, non-striving, acceptance, and letting go; generosity and gratitude were added later.';
const screenshot = 'The Pillars of Mindfulness — {{c1::Non-judging, patience, beginner’s mind, trust, non-striving, acceptance, and letting go}}; {{c2::generosity and gratitude}} were added later.';
const repaired = `The original Pillars of Mindfulness: ${originals.map((s, i) => `{{c${i + 1}::${s}}}`).join(', ')}. Later additions to the Pillars of Mindfulness: {{c8::generosity}} and {{c9::gratitude}}.`;
function hard(card, captured = source) {
  return m.lintCard(m.makeCard('h', card), m.makeHighlight({ sourcePath: 'synthetic.md', text: captured }), []).failures.filter(m.isHardLintFailure);
}

async function run({ replacement = repaired, conflict = false, text = screenshot } = {}) {
  const h = m.makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Mindfulness', text: source });
  const preparation = { facts: [{ id: 'F1', statement: source, quote: source }], plan: [{ id: 'P1', factIds: ['F1'], entity: 'Pillars of Mindfulness', aspect: 'original members and later additions', value: source, reason: 'Preserve complete bounded coverage.' }], exclusions: [], omissions: [], conflicts: [] };
  const draft = text => ({ planId: 'P1', factIds: ['F1'], kind: 'cloze', text, front: '', back: '' });
  const settings = { provider: 'codex', codexModel: 'synthetic', language: '', critiquePass: false, lintMode: 'off', concurrency: 1, notifyWhenReady: false };
  const calls = [], saves = [], llm = new m.LlmClient(() => settings), backend = new m.CodexBackend(() => settings);
  backend.exec = async req => {
    calls.push(req);
    assert.equal(h.cards.length, 0, 'candidates stay private through transport');
    if (req.label === 'preparation') return JSON.stringify(preparation);
    if (req.label === 'grounded cards') return JSON.stringify({ cards: [draft(text)] });
    if (req.label === 'generation repair') return JSON.stringify({ cards: [draft(replacement)] });
    return JSON.stringify({ verdicts: JSON.parse(req.user).cards.map((c, index) => (auditVerdict(c, { index, cardId: c.id, status: 'verified', reason: 'Synthetic always-positive audit.', conflicts: conflict ? [{ quote: source, reason: 'Insufficient captured evidence.' }] : [] }))) });
  };
  llm.codex = backend;
  const plugin = { settings, llm, store: { all: () => [h], touch() {}, async flush() { saves.push(structuredClone(h)); }, hasUnsavedChanges: false }, refreshStatusBar() {} };
  await new m.Generator(plugin).run(h);
  return { h, calls, saves };
}

for (const text of [
  `The Pillars of Mindfulness: ${originals.map(s => `{{c1::${s}}}`).join(', ')}.`,
  `**The Pillars of Mindfulness**: {{c1::- Non-judging\n- patience\n- beginner’s mind\n- trust\n- non-striving\n- acceptance\n- letting go}}.`,
]) test(`compound list surface remains hard: ${text}`, () => {
  assert.ok(hard({ kind: 'cloze', text }).includes('compound-retrieval'));
});

test('confident Q&A whole-list answer remains a hard compound', () => {
  assert.ok(hard({ kind: 'qa', front: 'What are the original Pillars of Mindfulness?', back: originals.join(', ') }).includes('compound-retrieval'));
});

for (const [front, answer] of [
  ['What is the city name?', 'Washington, D.C.'],
  ['What is the list author’s name?', 'Crosby, Stills, Nash and Young'],
  ['What is the output count?', '1,024'],
  ['What are the coordinate units?', '(3, 5) m'],
  ['What is the voltage range?', '3–5 V'],
  ['Why does caching retain previous results?', 'To avoid repeated computation and preserve time for new work.'],
]) test(`punctuation is not compound evidence: ${answer}`, () => {
  assert.deepEqual(hard({ kind: 'qa', front, back: answer }, answer), []);
});

test('same-entity repetition does not create independent list members', () => {
  assert.deepEqual(hard({ kind: 'cloze', text: 'The types of Zeta signal include {{c1::alpha}}; the selected signal type is {{c1::alpha}}.' }, 'The types of Zeta signal include alpha; the selected signal type is alpha.'), []);
});

test('source conflicts never authorize screenshot wording repair', async () => {
  const f = await run({ conflict: true });
  assert.equal(f.h.cards.length, 0);
  assert.deepEqual(f.calls.map(r => r.label), ['preparation', 'grounded cards', 'audit']);
  assert.ok(f.h.generation.blocked[0].reasons.some(r => /Insufficient captured evidence/.test(r)));
});

test('an explicit count on open examples does not establish exhaustive membership', () => {
  assert.ok(hard({ kind: 'cloze', text: 'The two types are {{c1::alpha}} and {{c2::beta}}.' }, 'Two types include alpha and beta.').includes('unordered-list-slots'));
});

test('visible list vocabulary cannot turn a focused explanation into a hidden list', () => {
  const captured = 'Cortisol keeps blood glucose available for the brain and muscles and enhances catecholamine effects on the cardiovascular system.';
  assert.deepEqual(hard({ kind: 'cloze', text: "Cortisol's role in glucose availability is to keep {{c1::blood glucose available for the brain and muscles}}; cortisol {{c2::enhances}} catecholamine effects on the cardiovascular system." }, captured), []);
});

test('a complete bounded unordered list permits one missing member without inventing definitions', () => {
  const text = 'In Zeta warning mode, the two effects are {{c1::lower sensor gain}} and {{c2::slower sampling}}.';
  assert.deepEqual(hard({ kind: 'cloze', text }, 'Zeta warning mode has two effects: lower sensor gain and slower sampling.'), []);
});

test('all nine mindfulness members and later-addition relation survive a coverage-preserving repair', async () => {
  const f = await run();
  assert.equal(f.h.cards.length, 1);
  const reviews = m.renderedCardReviews(f.h.cards[0]);
  assert.equal(reviews.length, 9);
  assert.deepEqual(reviews.map(r => r.hiddenTargets), [...originals, ...additions].map(s => [s]));
  for (const review of reviews) {
    assert.match(review.visibleCue, /original Pillars of Mindfulness/);
    assert.match(review.visibleCue, /Later additions to the Pillars of Mindfulness/);
    assert.equal(review.visibleCue.match(/\[\.\.\.\]/g).length, 1);
  }
  assert.equal(f.h.cards[0].generation.planId, 'P1');
  assert.deepEqual(f.h.cards[0].generation.factIds, ['F1']);
});

test('exact screenshot compound list cannot publish despite positive audit and lint off', async () => {
  const f = await run({ replacement: screenshot });
  assert.equal(f.h.cards.length, 0);
  assert.deepEqual(f.calls.map(r => r.label), ['preparation', 'grounded cards', 'audit', 'generation repair', 'final audit']);
  assert.equal(f.h.generation.repairs.length, 1);
  assert.equal(f.h.generation.drafts[0].text, screenshot);
  assert.ok(f.h.generation.blocked[0].reasons.some(r => /independently|multiple.*members/i.test(r)));
  assert.ok(f.saves.every(h => !h.cards.length));
});
