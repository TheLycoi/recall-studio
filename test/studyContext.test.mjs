import { afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { button, harness, loadQuiz, nodes, prepare, start, text } from './quizHarness.mjs';

let QuizView, LlmClient, InboxStore, Generator, validateStudyEvidence;
let transport;
const stores = [];
before(async () => {
  globalThis.window ??= globalThis;
  ({ QuizView } = await loadQuiz());
  ({ LlmClient } = await loadQuiz('src/llm.ts', { requestUrl: req => transport(req) }));
  ({ InboxStore } = await loadQuiz('src/store.ts', { normalizePath: path => path }));
  ({ Generator } = await loadQuiz('src/generator.ts'));
  ({ validateStudyEvidence } = await loadQuiz('src/studySchemas.ts'));
});
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

const claim = 'affinity measures receptor size instead of the strength with which a drug binds its receptor.';
const negated = `The receptor lecture explicitly states that it is false that ${claim}`;
const conditional = `Only in the fictional receptor model used for this exercise, ${claim}`;
const source = (text, extra = {}) => ({ id: '1', path: 'biology/Receptors.md', title: 'Receptors', text, line: 3, page: null, ...extra });
const selection = (quote, id = '1') => ({ selections: [{ id, quote }], gaps: [] });

function fixture(passage, quote = claim) {
  const h = harness(QuizView);
  h.setRaw(`# Receptors\n\n${passage}`);
  h.host.settings = { provider: 'deepseek', deepseekApiKey: 'synth...ey', deepseekModel: 'synthetic-model', effort: 'low' };
  h.host.store = new InboxStore(h.host.app, 'rules'); stores.push(h.host.store);
  h.rows = h.host.store.allHistory();
  h.host.generator = new Generator(h.host);
  void h.host.generator.stop(); // Exercise queueing without starting background card writing.
  const enqueue = h.host.generator.enqueue.bind(h.host.generator);
  h.host.generator.enqueue = highlight => { h.queued.push(highlight); enqueue(highlight); };
  h.host.llm = new LlmClient(() => h.host.settings);
  h.requests = [];
  // Synthetic replies exercise orchestration, not a model's semantic judgment.
  const replies = [
    body => selection(quote, JSON.parse(body.messages[1].content).passages[0].id),
    () => ({ question: 'What does the receptor lecture say about affinity?', shape: 'concept', expects: [1] }),
    () => ({ supported: true }),
    () => ({ points: [{ n: 1, status: 'wrong', said: claim, note: '', cue: '' }], feedback: '' }),
    () => ({ points: [{ n: 1, agrees: true }] }),
  ];
  transport = async req => {
    const body = JSON.parse(req.body);
    h.requests.push(body);
    const reply = replies.shift();
    assert.ok(reply, 'Unexpected provider request');
    return { status: 200, json: { choices: [{ message: { content: JSON.stringify(reply(body)) }, finish_reason: 'stop' }] } };
  };
  return h;
}

for (const [name, passage] of [['negated', negated], ['conditional', conditional]]) {
  test(`exact selection retains the original ${name} source passage`, () => {
    const original = source(passage);
    const result = validateStudyEvidence(selection(claim), [original], 'Explain affinity.');
    assert.deepEqual(result.passages, [original]);
  });

  test(`mounted Make Flashcards queues the complete ${name} passage through StudyCoordinator`, async () => {
    const h = fixture(passage);
    await prepare(h, 'make flashcards on Receptors');
    assert.equal(h.requests.length, 1, 'Only synthetic evidence selection runs before queueing');
    assert.equal(h.rows.length, 1, text(h.root));
    assert.equal(h.queued.length, 1);
    assert.equal(h.rows[0].text, passage);
    assert.equal(h.queued[0].text, passage);
    assert.equal(h.rows[0].sourcePath, h.file.path);
    assert.equal(h.rows[0].sourceTitle, 'Receptors');
    assert.equal(h.rows[0].line, 2, 'Original passage line, zero-based for highlight capture');
    assert.equal(h.rows[0].page, null);
    assert.equal(h.rows[0].status, 'queued');
    assert.deepEqual(h.rows[0].cards, []);
    assert.match(text(h.root), /1 reference passages queued/);
  });

  test(`mounted Quiz retains ${name} grounding and provenance without auto-capture on answer`, async () => {
    const h = fixture(passage);
    await h.view.onOpen();
    await start(h);
    assert.ok(h.view.session?.current, text(h.root));
    assert.equal(h.requests.length, 3);
    assert.deepEqual(h.view.plan.passages, [source(passage)]);
    assert.equal(h.view.session.items[0].points[0].text, passage);
    assert.ok(h.requests[1].messages[1].content.includes(passage), 'Question receives original qualifier');
    assert.ok(h.requests[2].messages[1].content.includes(passage), 'Question audit receives original qualifier');
    assert.ok(nodes(h.root).some(n => n.tagName === 'A' && n.options.href === h.file.path && n.text === 'Receptors · line 3'));
    assert.deepEqual(h.rows, []);
    h.view.draftQuestion = claim;
    await h.view.ask();
    assert.equal(h.requests.length, 5);
    assert.equal(h.view.session.results.length, 1);
    assert.ok(h.requests[3].messages[1].content.includes(passage), 'Grader receives original qualifier');
    assert.ok(h.requests[4].messages[1].content.includes(passage), 'Grade audit receives original qualifier');
    assert.ok(text(h.root).includes(passage), 'Reveal retains qualified source text');
    assert.ok(nodes(h.root).some(n => n.tagName === 'A' && n.options.href === h.file.path && n.text === 'Receptors · line 3'));
    assert.deepEqual(h.rows, [], 'Answering never captures a card automatically');
    assert.deepEqual(h.queued, []);
    const send = button(h.root, 'Send to Inbox');
    assert.ok(send, text(h.root));
    await send.events.click();
    assert.equal(h.rows.length, 1);
    assert.equal(h.queued.length, 1);
    assert.equal(h.rows[0].text, passage, 'Explicit Quiz capture retains the original passage');
    assert.equal(h.rows[0].line, 2);
    assert.equal(h.rows[0].sourcePath, h.file.path);
    assert.equal(h.rows[0].page, null);
  });
}

test('multiline substring selection keeps the original passage start for capture', async () => {
  const passage = `The receptor lecture rejects the following claim:\n${claim}\nThis sentence is part of the same original passage.`;
  const original = source(passage);
  assert.deepEqual(validateStudyEvidence(selection(claim), [original], 'Explain affinity.').passages, [original]);
  const h = fixture(passage);
  await prepare(h, 'make flashcards on Receptors');
  assert.equal(h.rows.length, 1, text(h.root));
  assert.equal(h.rows[0].text, passage);
  assert.equal(h.rows[0].line, 2, 'The substring begins on line 4; the retained passage begins on line 3');
  assert.equal(h.queued[0].line, 2);
});

test('a full passage selection keeps the original text and location unchanged', () => {
  const original = source('Affinity is the strength with which a drug binds its receptor.', { page: 7 });
  assert.deepEqual(validateStudyEvidence(selection(original.text), [original], 'Explain affinity.').passages, [original]);
});

for (const [name, passage, quote] of [
  ['fabricated', negated, 'Affinity measures drug mass.'],
  ['ambiguous', `${negated} The same incorrect claim is repeated: ${claim}`, claim],
  ['normalized rather than exact', negated, claim.replace('receptor size', 'receptor  size')],
]) {
  test(`${name} selection fails before Quiz or capture`, async () => {
    assert.throws(() => validateStudyEvidence(selection(quote), [source(passage)], 'Explain affinity.'), /quote.*exact|ambiguous/i);
    const h = fixture(passage, quote);
    await start(h);
    assert.equal(h.requests.length, 1, 'Invalid selection cannot reach the question writer or retry');
    assert.equal(h.view.session, null);
    assert.equal(h.view.plan, null);
    assert.deepEqual(h.rows, []);
    assert.deepEqual(h.queued, []);
  });
}

test('deduplication uses retained spans, not the different quotes selected within them', () => {
  const first = source(negated);
  const duplicate = { ...first, id: '2' };
  const draft = { selections: [{ id: '1', quote: claim }, { id: '2', quote: 'it is false that' }], gaps: [] };
  const starts = new Map([['1', 50], ['2', 50]]);
  assert.deepEqual(validateStudyEvidence(draft, [first, duplicate], 'Explain affinity.', starts).passages, [first]);
  draft.selections[1].quote = 'Invented quote.';
  assert.throws(() => validateStudyEvidence(draft, [first, duplicate], 'Explain affinity.', starts), /quote.*exact|ambiguous/i, 'Duplicate retained spans still require exact quote validation');
});

test('distinct same-line PDF occurrences and pages never collapse by quote text', () => {
  const first = source(negated, { path: 'sources/Receptors.pdf', line: 1, page: 2 });
  const second = { ...first, id: '2' };
  const third = { ...first, id: '3', page: 3 };
  const passages = [first, second, third];
  const draft = { selections: passages.map(p => ({ id: p.id, quote: claim })), gaps: [] };
  const starts = new Map([['1', 0], ['2', 1000], ['3', 0]]);
  assert.deepEqual(validateStudyEvidence(draft, passages, 'Explain affinity.', starts).passages, passages);
  assert.deepEqual(validateStudyEvidence(draft, passages, 'Explain affinity.').passages, passages, 'Without offsets, distinct candidate IDs are retained');
  assert.deepEqual(validateStudyEvidence(draft, passages, 'Explain affinity.', new Map()).passages, passages, 'Missing offsets cannot conflate distinct same-line candidates');
});
