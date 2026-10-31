import { auditVerdict } from './auditFixture.mjs';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';

let m;
before(async () => {
  const out = await build({ stdin: { contents: `
    export { Generator } from './src/generator';
    export { LlmClient } from './src/llm';
    export { GroundedCardsOut, validatePreparation, validateDrafts, validateAudit, renderedCardReviews } from './src/generation';
    export { makeCard, makeHighlight, approvedCards } from './src/model';
    export { lintCard, isHardLintFailure } from './src/lint';
  `, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'], logLevel: 'silent' });
  const mod = new Module('bidirectional-cloze-cases');
  mod.require = id => id === 'obsidian' ? { Notice: class {}, requestUrl() { throw Error('Network forbidden'); } } : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text, 'bidirectional-cloze-cases');
  m = mod.exports;
});

// Fictional fixtures and supplied verdicts test production contracts, not live model judgment.
const source = 'In Neral notation, velin is defined as a pause between repeated pulses.';
const pair = 'In Neral notation, {{c2::velin}} is defined as {{c1::a pause between repeated pulses}}.';
const pairReviews = [
  { ordinal: 1, visibleCue: 'In Neral notation, velin is defined as [...].', hiddenTargets: ['a pause between repeated pulses'] },
  { ordinal: 2, visibleCue: 'In Neral notation, [...] is defined as a pause between repeated pulses.', hiddenTargets: ['velin'] },
];
const cloze = text => ({ planId: 'P1', factIds: ['F1'], kind: 'cloze', text, front: '', back: '' });
function preparation(captured) {
  return m.validatePreparation({
    facts: [{ id: 'F1', statement: captured, quote: captured }],
    plan: [{ id: 'P1', factIds: ['F1'], entity: 'Synthetic fixture', aspect: 'source-supported relationship', value: captured, reason: 'Selected passage target.' }],
    exclusions: [], omissions: [], conflicts: [],
  }, captured);
}
function check(captured, text) {
  const [draft] = m.validateDrafts(m.GroundedCardsOut.parse({ cards: [cloze(text)] }), preparation(captured));
  const h = m.makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Synthetic fixture', text: captured });
  const card = m.makeCard(h.id, draft);
  return { card, reviews: m.renderedCardReviews(card), hard: m.lintCard(card, h, []).failures.filter(m.isHardLintFailure) };
}

async function run({ captured = source, text = pair, status = 'verified', reason = 'Supplied approving audit, not live model evidence.', conflicts = [] } = {}) {
  const h = m.makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Synthetic fixture', text: captured });
  const p = preparation(captured);
  const calls = [], saves = [], exports = [];
  const settings = { provider: 'codex', codexModel: 'synthetic', language: '', critiquePass: false, lintMode: 'off', concurrency: 1, notifyWhenReady: false };
  const llm = new m.LlmClient(() => settings);
  llm.codex = { async complete(req) {
    const payload = JSON.parse(req.user);
    calls.push({ label: req.label, payload });
    assert.equal(h.cards.length, 0, 'candidates remain private through every transport call');
    assert.equal(payload.captured, captured);
    if (req.label === 'preparation') return req.schema.parse(p);
    if (req.label === 'grounded cards') return req.schema.parse({ cards: [cloze(text)] });
    // Change punctuation only so final rejection cannot be attributed to an unchanged repair.
    if (req.label === 'generation repair') return req.schema.parse({ cards: [cloze(text.replace(/\.$/, '') + '!')] });
    assert.ok(['audit', 'final audit'].includes(req.label), `Unexpected request: ${req.label}`);
    for (const card of payload.cards) {
      assert.deepEqual(card.reviews, m.renderedCardReviews(card), 'audit receives production-rendered cues and answers');
      assert.equal(card.planId, 'P1');
      assert.deepEqual(card.factIds, ['F1']);
    }
    return req.schema.parse({ verdicts: payload.cards.map((card, index) => (auditVerdict(card, { index, cardId: card.id, status, reason, conflicts }))) });
  } };
  const plugin = {
    settings, llm,
    store: { all: () => [h], touch() {}, async flush() { saves.push(structuredClone(h)); }, hasUnsavedChanges: false },
    refreshStatusBar() {},
    async exportHighlights(...args) { exports.push(args); },
    async exportAsTextFile(...args) { exports.push(args); },
  };
  await new m.Generator(plugin).run(h);
  assert.equal(h.exportedAt, null);
  assert.deepEqual(m.approvedCards(h), [], 'generation never grants human approval');
  assert.deepEqual(exports, [], 'generation never invokes an export action');
  for (const snapshot of [...saves, h]) for (const card of snapshot.cards) {
    assert.equal(card.status, 'pending');
    assert.equal(card.ankiNoteId, undefined);
    assert.equal(card.srNote, undefined);
    assert.equal(card.exportAcceptance, undefined);
  }
  return { h, calls, saves };
}
function held(f, reason) {
  assert.equal(f.h.generation.phase, 'blocked');
  assert.deepEqual(f.h.cards, []);
  assert.ok(f.saves.every(h => h.cards.length === 0), 'held drafts never enter persisted Inbox cards');
  assert.equal(f.h.generation.blocked.length, 1);
  assert.equal(f.h.generation.blocked[0].cardId, f.h.generation.drafts[0].id);
  assert.match(f.h.generation.blocked[0].reasons.join(' '), reason);
}
function repairedAndRechecked(f) {
  assert.deepEqual(f.calls.map(r => r.label), ['preparation', 'grounded cards', 'audit', 'generation repair', 'final audit']);
  assert.equal(f.h.generation.repairs.length, 1);
  assert.equal(f.h.generation.repairs[0].error, undefined);
  assert.notEqual(f.h.generation.repairs[0].candidate.text, f.h.generation.drafts[0].text);
}

test('separate numbers render reciprocal cues with the inactive cloze visible and no term leak', () => {
  const result = check(source, pair);
  assert.deepEqual(result.hard, []);
  assert.deepEqual(result.reviews, pairReviews);
  assert.equal(result.reviews[1].visibleCue.includes('velin'), false);
  assert.ok(result.reviews[1].visibleCue.includes('In Neral notation'));
  assert.ok(result.reviews[1].visibleCue.includes('a pause between repeated pulses'));
});

test('a supplied approving audit publishes one reciprocal note pending human approval, without export', async () => {
  const f = await run();
  assert.deepEqual(f.calls.map(r => r.label), ['preparation', 'grounded cards', 'audit']);
  assert.equal(f.h.status, 'ready');
  assert.equal(f.h.generation.phase, 'complete');
  assert.equal(f.h.cards.length, 1);
  const card = f.h.cards[0];
  assert.equal(card.text, pair);
  assert.equal(card.generation.audit.status, 'verified');
  assert.equal(card.generation.planId, 'P1');
  assert.deepEqual(card.generation.factIds, ['F1']);
  assert.deepEqual(m.renderedCardReviews(card), pairReviews);
  assert.deepEqual(f.calls.at(-1).payload.cards[0].reviews, pairReviews);
});

test('same-number term and definition lose both cues; a modeled rejecting judgment holds the note', async () => {
  const text = pair.replace('{{c2::', '{{c1::');
  const result = check(source, text);
  assert.deepEqual(result.hard, [], 'this semantic cue defect is not a deterministic lint guarantee');
  assert.deepEqual(result.reviews, [{ ordinal: 1, visibleCue: 'In Neral notation, [...] is defined as [...].', hiddenTargets: ['velin', 'a pause between repeated pulses'] }]);
  const f = await run({ text, status: 'failed', reason: 'Modeled judgment: hiding both the term and its definition removes the identifying cue.' });
  held(f, /Modeled judgment: hiding both/);
  repairedAndRechecked(f);
});

test('an ambiguous reverse is held on a supplied modeled semantic judgment, not a deterministic uniqueness check', async () => {
  const captured = source + ' In Neral notation, sorin is also defined as a pause between repeated pulses.';
  assert.deepEqual(check(captured, pair).hard, []);
  const f = await run({ captured, status: 'failed', reason: 'Modeled judgment: the reverse cue permits velin or sorin; the definition does not distinguish the term.' });
  held(f, /reverse cue permits velin or sorin/);
  repairedAndRechecked(f);
});

test('an ordinary supported subject and attribute retain their visible relation', async () => {
  const captured = "The Zeta sensor's calibration signal color is blue.";
  const text = "The Zeta sensor's calibration signal color is {{c1::blue}}.";
  const reviews = [{ ordinal: 1, visibleCue: "The Zeta sensor's calibration signal color is [...].", hiddenTargets: ['blue'] }];
  assert.deepEqual(check(captured, text).hard, []);
  const f = await run({ captured, text });
  assert.equal(f.h.generation.phase, 'complete');
  assert.equal(f.h.cards.length, 1);
  assert.deepEqual(m.renderedCardReviews(f.h.cards[0]), reviews);
});

for (const { name, captured, text, failure, reason } of [
  { name: 'a bare named subject without the requested attribute', captured: 'Zeta has a blue calibration signal.', text: 'Zeta is {{c1::blue}}.', failure: 'cloze-cue-unspecified', reason: /visible review names only a topic/ },
  { name: 'a literal visible term leak', captured: source, text: 'In Neral notation, velin ({{c2::velin}}) is defined as {{c1::a pause between repeated pulses}}.', failure: 'answer-in-question', reason: /visible review text already contains the answer/ },
  { name: 'an invented hidden definition', captured: source, text: 'In Neral notation, {{c2::velin}} is defined as {{c1::a burst of continuous noise}}.', failure: 'cloze-not-grounded', reason: /not in the highlight/ },
]) test(`${name} remains hard-rejected even with approving initial and final audits and lint off`, async () => {
  assert.ok(check(captured, text).hard.includes(failure));
  const f = await run({ captured, text });
  held(f, reason);
  repairedAndRechecked(f);
  for (const audit of [f.h.generation.audit, f.h.generation.finalAudit]) {
    assert.equal(audit.status, 'unverified', 'contradictory positive verdicts fail the structured contract');
    assert.match(audit.reason, /Hard checks cannot be waived/);
  }
  for (const req of f.calls.filter(r => ['audit', 'final audit'].includes(r.label))) {
    assert.ok(req.payload.cards[0].checks.some(check => check.id === failure));
  }
});

test('invented visible disambiguation is held on a modeled source-support judgment despite grounded deletions', async () => {
  const text = pair.replace('In Neral notation', 'In ancient Neral notation');
  assert.deepEqual(check(source, text).hard, [], 'literal deletion grounding does not validate visible assertions');
  const f = await run({ text, status: 'failed', reason: 'Modeled judgment: ancient is invented distinguishing context absent from the captured source.' });
  held(f, /ancient is invented/);
  repairedAndRechecked(f);
});

test('a supplied quoted source conflict prevents publication despite an approving verdict and skips wording repair', async () => {
  const conflicts = [{ quote: source, reason: 'Supplied semantic evidence finding: the captured definition is insufficient to disambiguate this term.' }];
  const f = await run({ conflicts });
  held(f, /Source conflicts or insufficient evidence need human review/);
  assert.deepEqual(f.calls.map(r => r.label), ['preparation', 'grounded cards', 'audit']);
  assert.equal(f.h.generation.audit.verdicts[0].status, 'verified');
  assert.deepEqual(f.h.generation.audit.verdicts[0].conflicts, conflicts.map(c => ({ ...c, kind: 'legacy' })));
  assert.equal(f.h.generation.repairs, undefined);
});

test('production schemas and validators enforce reciprocal draft provenance and audit identity', () => {
  const p = preparation(source);
  for (const field of ['planId', 'factIds']) {
    const draft = cloze(pair); delete draft[field];
    assert.equal(m.GroundedCardsOut.safeParse({ cards: [draft] }).success, false);
  }
  assert.throws(() => m.validateDrafts({ cards: [{ ...cloze(pair), planId: 'P99' }] }, p), /plan reference/);
  assert.throws(() => m.validateDrafts({ cards: [{ ...cloze(pair), factIds: ['F99'] }] }, p), /fact links/);
  const { card } = check(source, pair);
  const verdict = auditVerdict(card, { index: 0, cardId: card.id, status: 'verified', reason: 'Supplied audit.', conflicts: [] });
  assert.throws(() => m.validateAudit({ verdicts: [{ ...verdict, cardId: 'wrong-card' }] }, [card], source), /mismatched/);
  assert.throws(() => m.validateAudit({ verdicts: [{ ...verdict, conflicts: [{ quote: 'invented evidence', reason: 'Unsupported quote.' }] }] }, [card], source), /quote is not in the captured snapshot/);
});
