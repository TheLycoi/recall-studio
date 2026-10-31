import { auditVerdict } from './auditFixture.mjs';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';

let m;
before(async () => {
  const out = await build({ stdin: { contents: `export { Generator } from './src/generator'; export { LlmClient } from './src/llm'; export { CodexBackend } from './src/codex'; export { makeCard, makeHighlight } from './src/model'; export { lintCard, isHardLintFailure } from './src/lint'; export { renderedCardReviews } from './src/generation';`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'], logLevel: 'silent' });
  const mod = new Module('atomic-correction');
  mod.require = id => id === 'obsidian' ? { Notice: class {}, requestUrl() { throw Error('Network forbidden'); } } : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text, 'atomic-correction');
  m = mod.exports;
});

function fixture(source, fields, replacement = fields, rejectInitial = false) {
  const h = m.makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Correction fixture', text: source });
  const preparation = { facts: [{ id: 'F1', statement: source, quote: source }], plan: [{ id: 'P1', factIds: ['F1'], entity: 'Synthetic system', aspect: 'classification or transition', value: source, reason: 'Regression fixture.' }], exclusions: [], omissions: [], conflicts: [] };
  const draft = fields => ({ planId: 'P1', factIds: ['F1'], front: '', back: '', text: '', ...fields });
  const settings = { provider: 'codex', codexModel: 'synthetic', language: '', critiquePass: false, lintMode: 'off', concurrency: 1, notifyWhenReady: false };
  const calls = [], saves = [], llm = new m.LlmClient(() => settings), backend = new m.CodexBackend(() => settings);
  backend.exec = async req => {
    calls.push(req);
    assert.equal(h.cards.length, 0, 'candidates remain private during transport');
    if (req.label === 'preparation') return JSON.stringify(preparation);
    if (req.label === 'grounded cards') return JSON.stringify({ cards: [draft(fields)] });
    if (req.label === 'generation repair') return JSON.stringify({ cards: [draft(replacement)] });
    if (req.label === 'rewrite cards') return JSON.stringify({ cards: [draft(replacement)] });
    if (req.label === 'rewrite audit') return JSON.stringify({ preservesFacts: true, reason: 'Synthetic source/coverage check.', verdicts: [{ index: 0, verdict: 'keep', reason: '' }] });
    const payload = JSON.parse(req.user);
    const failed = rejectInitial && (req.label === 'audit' || JSON.stringify(fields) === JSON.stringify(replacement));
    return JSON.stringify({ verdicts: payload.cards.map((c, index) => (auditVerdict(c, { index, cardId: c.id, status: failed ? 'failed' : 'verified', reason: failed ? 'Synthetic regression verdict: requested classification/transition has no visible relation words.' : 'Synthetic positive audit, not live inference.', conflicts: [] }))) });
  };
  llm.codex = backend;
  const g = new m.Generator({ settings, llm, store: { all: () => [h], touch() {}, async flush() { saves.push(structuredClone(h)); }, hasUnsavedChanges: false }, refreshStatusBar() {} });
  return { h, llm, calls, saves, run: () => g.run(h) };
}

const orinSource = 'The fictional Orin beacon is a coastal marker. The Orin beacon’s indicator changes from amber to green only when the anchor is locked.';
for (const [bad, good, cue] of [
  ['The fictional Orin beacon is {{c1::a coastal marker}}.', "The fictional Orin beacon's classification is {{c1::a coastal marker}}.", 'classification'],
  ['The Orin beacon’s indicator {{c1::changes from amber to green}} only when the anchor is locked.', 'The Orin beacon’s indicator changes from amber to {{c1::green}} only when the anchor is locked.', 'changes from amber to'],
]) for (const repeat of [false, true]) test(`R1 exact observed front ${bad} ${repeat ? 'stays held' : 'repairs with visible relation'}`, async () => {
  const fields = { kind: 'cloze', text: bad };
  const f = fixture(orinSource, fields, repeat ? fields : { kind: 'cloze', text: good }, true);
  await f.run();
  assert.deepEqual(f.calls.map(r => r.label), ['preparation', 'grounded cards', 'audit', 'generation repair', 'final audit']);
  assert.equal(f.h.cards.length, repeat ? 0 : 1);
  const initial = JSON.parse(f.calls.find(r => r.label === 'audit').user).cards[0];
  assert.equal(initial.reviews[0].visibleCue, bad.replace(/\{\{c1::.*?\}\}/, '[...]'));
  assert.ok(!initial.reviews[0].visibleCue.includes(cue), 'a plan aspect cannot supply visible relation evidence');
  for (const req of f.calls) assert.match(req.system, /cite exact visible words for the identifying cue AND requested relation/i);
  if (repeat) assert.ok(f.saves.every(h => !h.cards.length));
  else assert.ok(m.renderedCardReviews(f.h.cards[0])[0].visibleCue.includes(cue));
  assert.equal(f.h.text, orinSource);
});

const featureSource = 'The two features are red casing and blue trim.';
for (const [attribute, answer] of [['title', 'War and Peace'], ['author', 'Crosby, Stills, Nash and Young'], ['name', 'Salt and Pepper']]) {
  const source = `The list’s ${attribute} is ${answer}.`;
  for (const fields of [{ kind: 'cloze', text: `The list’s ${attribute} is {{c1::${answer}}}.` }, { kind: 'qa', front: `Which ${attribute} does the list have?`, back: answer }]) {
    test(`R3 explicit singular ${attribute} ${fields.kind} publishes without repair`, async () => {
      const f = fixture(source, fields);
      await f.run();
      assert.equal(f.h.cards.length, 1);
      assert.deepEqual(f.calls.map(r => r.label), ['preparation', 'grounded cards', 'audit']);
      assert.equal(f.h.text, source);
    });
    test(`R3 explicit singular ${attribute} ${fields.kind} survives rewrite audit`, async () => {
      const f = fixture(source, fields);
      const card = m.makeCard(f.h.id, fields);
      const results = await f.llm.rewriteCards(f.h, card, 'Keep this single attribute.');
      assert.equal(results.length, 1);
      assert.equal(results[0].kind, fields.kind);
    });
    test(`R3 repair can replace a rejected draft with a singular ${attribute} ${fields.kind}`, async () => {
      const original = { kind: 'qa', front: 'What are the list items?', back: answer };
      const f = fixture(source, original, fields);
      await f.run();
      assert.equal(f.h.cards.length, 1);
      assert.ok(f.calls.some(r => r.label === 'generation repair'));
    });
  }
}
for (const front of ['What are the two titles on the list?', 'Which names are list members?', 'What is the name of each list member?', 'What are the list’s title and author?']) test(`R3 real multi-target request stays hard: ${front}`, async () => {
  const f = fixture('The list contains Alpha and Beta.', { kind: 'qa', front, back: 'Alpha and Beta.' });
  await f.run();
  assert.equal(f.h.cards.length, 0);
});
for (const front of ['Which features does the list author describe?', 'What are the features of the list with title Atlas?']) test(`CQ-R3 incidental attribute does not waive a feature request: ${front}`, async () => {
  const fields = { kind: 'qa', front, back: 'red casing and blue trim' };
  const f = fixture(featureSource, fields);
  assert.ok(m.lintCard(m.makeCard(f.h.id, fields), f.h, []).failures.includes('compound-retrieval'));
  await f.run();
  assert.deepEqual(f.calls.map(r => r.label), ['preparation', 'grounded cards', 'audit', 'generation repair', 'final audit']);
  assert.equal(f.h.cards.length, 0);
  assert.ok(f.saves.every(h => h.cards.length === 0));
  await assert.rejects(() => f.llm.rewriteCards(f.h, m.makeCard(f.h.id, fields), 'Preserve the requested features.'));
  assert.equal(f.h.text, featureSource);
});
const atomic = { kind: 'cloze', text: 'The two features are {{c1::red casing}} and {{c2::blue trim}}.' };
for (const back of ['red casing and blue trim', 'red casing and blue trim.', 'red casing and blue trim!', 'red casing and blue trim?', 'red casing and blue trim;', '- red casing\n- blue trim.', '**red casing** and **blue trim**.', 'red casing\nblue trim.']) {
  for (const repeat of [true, false]) test(`R2 ${JSON.stringify(back)} ${repeat ? 'holds repeated defect' : 'accepts atomic repair'}`, async () => {
    const fields = { kind: 'qa', front: 'What are the two features?', back };
    const f = fixture(featureSource, fields, repeat ? fields : atomic);
    await f.run();
    assert.deepEqual(f.calls.map(r => r.label), ['preparation', 'grounded cards', 'audit', 'generation repair', 'final audit']);
    assert.equal(f.h.cards.length, repeat ? 0 : 1);
    assert.equal(f.h.text, featureSource, 'source bytes unchanged');
    assert.equal(f.h.generation.repairs.length, 1);
    if (repeat) assert.ok(f.saves.every(h => h.cards.length === 0));
    else assert.equal(f.h.cards[0].text, atomic.text);
  });
}
for (const front of ['Why does the list cache retain results?', 'How does the list cache save work?']) test(`CQ-R2 focused explanation publishes with incidental list vocabulary: ${front}`, async () => {
  const source = 'The list cache retains results to avoid repeated computation and preserve time for new work.';
  const fields = { kind: 'qa', front, back: 'To avoid repeated computation and preserve time for new work.' };
  const f = fixture(source, fields);
  assert.ok(!m.lintCard(m.makeCard(f.h.id, fields), f.h, []).failures.includes('compound-retrieval'));
  await f.run();
  assert.equal(f.h.cards.length, 1);
  assert.deepEqual(f.calls.map(r => r.label), ['preparation', 'grounded cards', 'audit']);
  assert.ok(f.saves.some(h => h.cards.length === 1));
  const rewrite = fixture(source, fields);
  assert.equal((await rewrite.llm.rewriteCards(rewrite.h, m.makeCard(rewrite.h.id, fields), 'Keep the causal explanation.')).length, 1);
  assert.equal(f.h.text, source);
  const repaired = fixture(source, { kind: 'qa', front: 'What are the list features?', back: 'red casing and blue trim.' }, fields);
  await repaired.run();
  assert.equal(repaired.h.cards.length, 1);
  assert.equal(repaired.h.cards[0].back, fields.back);
  assert.deepEqual(repaired.calls.map(r => r.label), ['preparation', 'grounded cards', 'audit', 'generation repair', 'final audit']);
});
for (const text of ['The two features are {{c1::red casing and blue trim.}}', 'The two features are {{c1::red casing}} and {{c1::blue trim.}}']) test(`R2 punctuated same-number cloze: ${text}`, async () => {
  const fields = { kind: 'cloze', text };
  const f = fixture(featureSource, fields);
  await f.run();
  assert.equal(f.h.cards.length, 0);
  assert.ok(f.h.generation.blocked[0].reasons.some(r => /multiple|independently/i.test(r)));
});
