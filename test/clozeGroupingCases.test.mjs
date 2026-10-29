import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';

let m;
const forbiddenNetwork = () => { throw Error('Network forbidden in synthetic grouping cases'); };
before(async t => {
  t.mock.method(globalThis, 'fetch', forbiddenNetwork);
  const out = await build({ stdin: { contents: `
    export { Generator } from './src/generator';
    export { LlmClient } from './src/llm';
    export { GroundedCardsOut, validatePreparation, validateDrafts, validateAudit,
      renderedCardReviews, generationSourceKey, cardAuditContent } from './src/generation';
    export { makeCard, makeHighlight, approvedCards } from './src/model';
    export { lintCard, isHardLintFailure } from './src/lint';
  `, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'], logLevel: 'silent' });
  const mod = new Module('cloze-grouping-cases');
  mod.require = id => id === 'obsidian' ? { Notice: class {}, requestUrl: forbiddenNetwork } : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text, 'cloze-grouping-cases');
  m = mod.exports;
});

// Authored fixtures and supplied audit judgments test boundaries, not real model compliance.
// The supplied screenshot wording below tests grouping, not medical correctness.
const screenshot = {
  source: 'Conversion disorder reports sensory or motor symptoms.',
  facts: ['Conversion disorder reports sensory symptoms.', 'Conversion disorder reports motor symptoms.'],
  text: 'Conversion disorder reports {{c1::sensory}} or {{c2::motor}} symptoms.',
  reviews: [
    { ordinal: 1, visibleCue: 'Conversion disorder reports [...] or motor symptoms.', hiddenTargets: ['sensory'] },
    { ordinal: 2, visibleCue: 'Conversion disorder reports sensory or [...] symptoms.', hiddenTargets: ['motor'] },
  ],
  reason: 'Keep both selected targets from the same sentence in one row.',
};
const route = {
  source: 'The Luma courier route runs from Arin through Belin to Corin.',
  facts: ['The Luma courier route starts at Arin.', 'The Luma courier route passes through Belin.', 'The Luma courier route ends at Corin.'],
  text: 'The Luma courier route runs from {{c1::Arin}} through {{c2::Belin}} to {{c3::Corin}}.',
  reviews: [
    { ordinal: 1, visibleCue: 'The Luma courier route runs from [...] through Belin to Corin.', hiddenTargets: ['Arin'] },
    { ordinal: 2, visibleCue: 'The Luma courier route runs from Arin through [...] to Corin.', hiddenTargets: ['Belin'] },
    { ordinal: 3, visibleCue: 'The Luma courier route runs from Arin through Belin to [...].', hiddenTargets: ['Corin'] },
  ],
  reason: 'The three named stops share one source-supported route and retain positional cues.',
};
const single = {
  source: "The Zeta sensor's calibration signal color is blue.",
  facts: ["The Zeta sensor's calibration signal color is blue."],
  text: "The Zeta sensor's calibration signal color is {{c1::blue}}.",
  reviews: [{ ordinal: 1, visibleCue: "The Zeta sensor's calibration signal color is [...].", hiddenTargets: ['blue'] }],
  reason: 'Only one useful answer is selected; do not invent filler to reach two.',
};
const kit = {
  source: 'The Vela kit contains exactly four tools: a probe, a clamp, a gauge and a brush.',
  facts: ['The Vela kit contains a probe.', 'The Vela kit contains a clamp.', 'The Vela kit contains a gauge.', 'The Vela kit contains a brush.'],
  text: 'The Vela kit contains exactly four tools: {{c1::a probe}}, {{c2::a clamp}}, {{c3::a gauge}} and {{c4::a brush}}.',
  reviews: [
    { ordinal: 1, visibleCue: 'The Vela kit contains exactly four tools: [...], a clamp, a gauge and a brush.', hiddenTargets: ['a probe'] },
    { ordinal: 2, visibleCue: 'The Vela kit contains exactly four tools: a probe, [...], a gauge and a brush.', hiddenTargets: ['a clamp'] },
    { ordinal: 3, visibleCue: 'The Vela kit contains exactly four tools: a probe, a clamp, [...] and a brush.', hiddenTargets: ['a gauge'] },
    { ordinal: 4, visibleCue: 'The Vela kit contains exactly four tools: a probe, a clamp, a gauge and [...].', hiddenTargets: ['a brush'] },
  ],
  reason: 'A complete bounded set of four belongs together; preserve every selected member.',
};
const reciprocal = {
  source: 'In Neral notation, velin is defined as a pause between repeated pulses.',
  facts: ['In Neral notation, velin is defined as a pause between repeated pulses.'],
  text: 'In Neral notation, {{c2::velin}} is defined as {{c1::a pause between repeated pulses}}.',
  reviews: [
    { ordinal: 1, visibleCue: 'In Neral notation, velin is defined as [...].', hiddenTargets: ['a pause between repeated pulses'] },
    { ordinal: 2, visibleCue: 'In Neral notation, [...] is defined as a pause between repeated pulses.', hiddenTargets: ['velin'] },
  ],
  reason: 'Keep the two supported retrieval directions with identifying context visible.',
};
const separate = {
  source: 'The Orin beacon flashes amber during startup.',
  facts: ['The Orin beacon flashes amber during startup.'],
  text: 'The Orin beacon flashes {{c1::amber}} during startup.',
  reviews: [{ ordinal: 1, visibleCue: 'The Orin beacon flashes [...] during startup.', hiddenTargets: ['amber'] }],
  reason: 'A beacon startup signal is unrelated to the sensor calibration signal; keep separate context.',
};

function fixture(groups) {
  const captured = [...new Set(groups.map(g => g.source))].join(' ');
  const facts = [], plan = [], drafts = [];
  for (const [i, group] of groups.entries()) {
    const factIds = group.facts.map(statement => {
      const id = `F${facts.length + 1}`;
      facts.push({ id, statement, quote: group.source });
      return id;
    });
    const id = `P${i + 1}`;
    plan.push({ id, factIds, entity: 'Synthetic fixture', aspect: 'source-supported retrieval targets', value: group.source, reason: group.reason });
    drafts.push({ planId: id, factIds, kind: 'cloze', text: group.text, front: '', back: '' });
  }
  const preparation = m.validatePreparation({ facts, plan, exclusions: [], omissions: [], conflicts: [] }, captured);
  return { captured, preparation, drafts, groups };
}
function inspect(f) {
  const h = m.makeHighlight({ sourcePath: 'synthetic/grouping.md', sourceTitle: 'Synthetic grouping fixture', text: f.captured });
  const drafts = m.validateDrafts(m.GroundedCardsOut.parse({ cards: f.drafts }), f.preparation);
  const cards = drafts.map(draft => m.makeCard(h.id, draft));
  return cards.map(card => ({ card, reviews: m.renderedCardReviews(card), hard: m.lintCard(card, h, cards.filter(c => c.id !== card.id)).failures.filter(m.isHardLintFailure) }));
}

async function run(f, { status = 'verified', reason = 'Supplied synthetic approving audit, not live model evidence.' } = {}) {
  const h = m.makeHighlight({ sourcePath: 'synthetic/grouping.md', sourceTitle: 'Synthetic grouping fixture', text: f.captured, heading: 'Selected passage', line: 17 });
  const sourceKey = m.generationSourceKey(h);
  const calls = [], saves = [], exports = [];
  const settings = { provider: 'codex', codexModel: 'synthetic-no-network', language: '', critiquePass: false, lintMode: 'off', concurrency: 1, notifyWhenReady: false };
  const llm = new m.LlmClient(() => settings);
  llm.deepseek = { complete: forbiddenNetwork };
  llm.opencode = { complete: forbiddenNetwork };
  llm.codex = { async complete(req) {
    const payload = JSON.parse(req.user);
    calls.push({ label: req.label, payload });
    assert.deepEqual(h.cards, [], 'drafts stay private during all synthetic transport requests');
    assert.equal(payload.captured, f.captured);
    if (req.label === 'preparation') return req.schema.parse(f.preparation);
    assert.deepEqual(payload.preparation, f.preparation, 'all quoted facts and rows reach writing, repair and audit');
    if (req.label === 'grounded cards') return req.schema.parse({ cards: f.drafts });
    if (req.label === 'generation repair') {
      assert.equal(payload.candidates.length, 1, 'repair remains one replacement per supplied candidate');
      const card = payload.candidates[0];
      const original = f.drafts.find(d => d.planId === card.planId);
      assert.ok(original);
      assert.deepEqual(card.factIds, original.factIds);
      // Change punctuation without repairing the defect, so the final gate must adjudicate it again.
      return req.schema.parse({ cards: [{ ...original, text: original.text.replace(/\.$/, '') + '!' }] });
    }
    assert.ok(['audit', 'final audit'].includes(req.label), `Unexpected request: ${req.label}`);
    assert.equal(payload.cards.length, f.drafts.length);
    for (const [i, card] of payload.cards.entries()) {
      assert.equal(card.planId, f.drafts[i].planId);
      assert.deepEqual(card.factIds, f.drafts[i].factIds);
      assert.deepEqual(card.reviews, m.renderedCardReviews(card));
    }
    return req.schema.parse({ verdicts: payload.cards.map((card, index) => ({ index, cardId: card.id, status, reason, conflicts: [] })) });
  } };
  const plugin = {
    settings, llm,
    store: { all: () => [h], touch() {}, async flush() { saves.push(structuredClone(h)); }, hasUnsavedChanges: false },
    refreshStatusBar() {},
    async exportHighlights(...args) { exports.push(args); },
    async exportAsTextFile(...args) { exports.push(args); },
  };
  await new m.Generator(plugin).run(h);
  assert.equal(m.generationSourceKey(h), sourceKey, 'source metadata and captured text remain unchanged');
  assert.deepEqual(h.generation.preparation, f.preparation, 'retain every quoted fact, fact ID and plan row');
  assert.equal(h.generation.provenance.sourceKey, sourceKey);
  assert.equal(h.generation.provenance.inputKey, h.generation.inputKey);
  for (const audit of [h.generation.audit, h.generation.finalAudit].filter(Boolean)) {
    assert.deepEqual(audit.provenance, h.generation.provenance);
  }
  for (const snapshot of [...saves, h]) {
    assert.equal(snapshot.exportedAt, null);
    assert.deepEqual(m.approvedCards(snapshot), [], 'generation never grants human approval');
    for (const card of snapshot.cards) {
      assert.equal(card.status, 'pending');
      assert.equal(card.ankiNoteId, undefined);
      assert.equal(card.srNote, undefined);
      assert.equal(card.exportAcceptance, undefined);
    }
  }
  assert.deepEqual(exports, [], 'generation does not invoke export');
  return { h, calls, saves };
}
function assertHeld(result, count, reason) {
  const { h, saves } = result;
  assert.equal(h.status, 'error');
  assert.equal(h.generation.phase, 'blocked');
  assert.deepEqual(h.cards, []);
  assert.ok(saves.every(snapshot => snapshot.cards.length === 0), 'held candidates never enter persisted Inbox notes');
  assert.equal(h.generation.blocked.length, count);
  assert.deepEqual(h.generation.blocked.map(b => b.cardId), h.generation.drafts.map(c => c.id));
  for (const blocked of h.generation.blocked) assert.match(blocked.reasons.join(' '), reason);
  assert.equal(h.generation.repairs.length, count);
  for (const repair of h.generation.repairs) {
    assert.equal(repair.error, undefined);
    const original = h.generation.drafts.find(c => c.id === repair.cardId);
    assert.equal(repair.candidate.id, original.id);
    assert.deepEqual(repair.candidate.generation, original.generation);
    assert.notEqual(repair.candidate.text, original.text);
  }
  assert.deepEqual(result.calls.map(c => c.label), ['preparation', 'grounded cards', 'audit', ...Array(count).fill('generation repair'), 'final audit']);
}

for (const [name, groups] of [
  ['supplied two-target sentence stays one note with two distinctly numbered reviews', [screenshot]],
  ['three-stop route stays one note with three distinctly numbered reviews', [route]],
  ['one legitimate deletion stays valid without invented filler', [single]],
  ['coherent four-member set keeps all targets instead of imposing a three-cloze ceiling', [kit]],
  ['different justified contexts remain two notes rather than a universal one-note quota', [single, separate]],
  ['reciprocal term-definition reviews retain their visible identifying context', [reciprocal]],
]) test(name, async () => {
  const f = fixture(groups);
  const checked = inspect(f);
  for (const [i, result] of checked.entries()) {
    assert.deepEqual(result.hard, []);
    assert.deepEqual(result.reviews, groups[i].reviews);
  }
  const { h, calls, saves } = await run(f);
  assert.equal(h.status, 'ready');
  assert.equal(h.generation.phase, 'complete');
  assert.equal(h.generation.preparation.plan.length, groups.length);
  assert.equal(h.cards.length, groups.length);
  assert.equal(saves.at(-1).cards.length, groups.length);
  assert.deepEqual(calls.map(c => c.label), ['preparation', 'grounded cards', 'audit']);
  for (const [i, card] of h.cards.entries()) {
    assert.equal(card.text, groups[i].text);
    assert.equal(card.highlightId, h.id);
    assert.equal(card.id, h.generation.drafts[i].id);
    assert.equal(card.generation.batchId, h.generation.id);
    assert.equal(card.generation.planId, f.drafts[i].planId);
    assert.deepEqual(card.generation.factIds, f.drafts[i].factIds);
    assert.equal(card.generation.audit.status, 'verified');
    assert.equal(card.generation.audit.content, m.cardAuditContent(card));
    assert.deepEqual(card.generation.audit.provenance, h.generation.provenance);
    assert.deepEqual(m.renderedCardReviews(card), groups[i].reviews);
    assert.deepEqual(calls.at(-1).payload.cards[i].reviews, groups[i].reviews);
  }
});

for (const { name, group, failure, reason } of [
  { name: 'independent same-number list answers', group: { ...kit, text: 'The Vela kit tool list: {{c1::a probe}}, {{c1::a clamp}}, {{c1::a gauge}} and {{c1::a brush}}.' }, failure: 'compound-retrieval', reason: /multiple independently gradable members/ },
  { name: 'a visible answer leak beside a grouped deletion', group: { ...kit, text: kit.text.replace('exactly four tools:', 'exactly four tools (including a probe):') }, failure: 'answer-in-question', reason: /visible review text already contains the answer/ },
  { name: 'a visible sibling deletion leaking another review answer', group: {
    source: 'The Orin beacon flashes amber during startup and amber during shutdown.',
    facts: ['The Orin beacon flashes amber during startup.', 'The Orin beacon flashes amber during shutdown.'],
    text: 'The Orin beacon flashes {{c1::amber}} during startup and {{c2::amber}} during shutdown.',
    reason: 'Synthetic leak control with a grounded answer repeated under distinct numbers.',
  }, failure: 'answer-in-question', reason: /visible review text already contains the answer/ },
]) test(`${name} is held despite positive synthetic audits and lint off`, async () => {
  const f = fixture([group]);
  assert.ok(inspect(f)[0].hard.includes(failure));
  const result = await run(f);
  assertHeld(result, 1, reason);
  for (const audit of [result.h.generation.audit, result.h.generation.finalAudit]) assert.equal(audit.verdicts[0].status, 'verified');
  for (const request of result.calls.filter(c => ['audit', 'final audit'].includes(c.label))) {
    assert.ok(request.payload.cards[0].checks.some(check => check.id === failure));
  }
});

test('synthetic failed split-note duplication audit holds both rows without silent merging or publication', async () => {
  const source = 'The Nera beacon has exactly two signal modes: amber and violet.';
  const groups = [
    { source, facts: ['The Nera beacon has an amber signal mode.'], text: 'The Nera beacon has exactly two signal modes: {{c1::amber}} and violet.', reason: 'Synthetic fragmented row for amber.' },
    { source, facts: ['The Nera beacon has a violet signal mode.'], text: 'The Nera beacon has exactly two signal modes: amber and {{c1::violet}}.', reason: 'Synthetic fragmented row for violet.' },
  ];
  const f = fixture(groups);
  assert.ok(inspect(f).every(result => result.hard.length === 0), 'this split-note duplication judgment is semantic, not hard lint');
  const result = await run(f, { status: 'failed', reason: 'Synthetic semantic judgment: avoidable split-note duplication; the same sentence differs only in its hidden target.' });
  assertHeld(result, 2, /Synthetic semantic judgment: avoidable split-note duplication/);
  assert.deepEqual(result.h.generation.drafts.map(c => c.text), groups.map(g => g.text));
  assert.deepEqual(result.h.generation.drafts.map(c => c.generation.factIds), [['F1'], ['F2']]);
  assert.deepEqual(result.h.generation.repairs.map(r => r.candidate.generation.planId), ['P1', 'P2']);
  assert.equal(result.h.generation.finalAudit.status, 'failed');
});

test('production validators forbid splitting locked rows, dropping fact links or merging separate rows', () => {
  const grouped = fixture([screenshot]);
  assert.throws(() => m.validateDrafts({ cards: [grouped.drafts[0], grouped.drafts[0]] }, grouped.preparation), /repeated card plan reference/);
  assert.throws(() => m.validateDrafts({ cards: [{ ...grouped.drafts[0], factIds: ['F1'] }] }, grouped.preparation), /fact links do not match/);
  const two = fixture([single, separate]);
  assert.throws(() => m.validateDrafts({ cards: [two.drafts[0]] }, two.preparation), /omitted a planned card/);
  assert.throws(() => m.validateDrafts({ cards: [{ ...two.drafts[0], factIds: ['F1', 'F2'] }] }, two.preparation), /fact links do not match/);
  const card = inspect(grouped)[0].card;
  assert.throws(() => m.validateAudit({ verdicts: [{ index: 0, cardId: 'wrong-card', status: 'verified', reason: 'Synthetic approval.', conflicts: [] }] }, [card], grouped.captured), /mismatched/);
});
