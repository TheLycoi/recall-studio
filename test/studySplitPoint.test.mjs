import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadQuiz, harness, start, button, nodes, SOURCE } from './quizHarness.mjs';

const SENTENCES = [
  'Affinity is the strength with which a drug binds its receptor, and this binding strength describes the interaction between that drug and its receptor.',
  'Receptor occupancy is the proportion of receptors occupied by a drug at a given concentration, and occupancy increases as that concentration rises.',
  'Efficacy is the capacity of a bound drug to activate its receptor and produce a biological response after binding has occurred.',
];
const PARAGRAPH = SENTENCES.join(' ');
let QuizView;
before(async () => { ({ QuizView } = await loadQuiz()); });

function selected(excerpt = PARAGRAPH) {
  const h = harness(QuizView);
  h.setRaw(`# Receptors\n\nThis introduction is outside the selected evidence.\n\n${excerpt}`);
  h.host.llm.selectStudyEvidence = async args => ({
    selections: [{ id: args.passages[0].id, quote: excerpt }], gaps: [],
  });
  return h;
}

test('a sentence-split miss captures its whole selected source only after the rendered Inbox action', async () => {
  const h = selected();
  await start(h);
  const points = h.view.session.items.flatMap(item => item.points);
  assert.deepEqual(points.map(point => point.text), SENTENCES);
  assert.ok(points.every((point, i) => point.id.endsWith(`#s${i + 1}`)));
  await button(h.root, 'Skip').events.click();
  assert.equal(h.rows.length, 0);
  assert.equal(h.queued.length, 0);
  const send = button(h.root, 'Send to Inbox');
  assert.ok(send);
  await send.events.click();
  assert.equal(h.rows.length, 1);
  assert.equal(h.queued.length, 1);
  const capture = h.rows[0];
  assert.equal(h.queued[0], capture);
  assert.equal(capture.text, PARAGRAPH);
  assert.equal(capture.sourcePath, h.file.path);
  assert.equal(capture.sourceTitle, h.file.basename);
  assert.equal(capture.line, 4);
  assert.equal(capture.page, null);
  assert.equal(capture.origin, 'quiz');
  assert.equal(capture.instruction, `The reader missed this source point during Quiz: ${SENTENCES[0]}\nTest only this point using the captured note excerpt.`);
  await send.events.click();
  assert.equal(h.rows.length, 1);
  assert.equal(h.queued.length, 1);
  assert.equal(button(h.root, 'Sent to Inbox').disabled, true);
});

for (const [name, excerpt, expected, point] of [
  ...SENTENCES.map((sentence, i) => [`split point ${i + 1}`, PARAGRAPH, sentence, i + 1]),
  ['unsplit point', SOURCE, SOURCE, 1],
]) test(`${name} retains question/reveal provenance and captures source instead of learner prose`, async () => {
  const h = selected(excerpt);
  h.host.llm.quizQuestion = async () => ({ question: 'Explain the binding concept?', shape: 'concept', expects: [point] });
  await start(h);
  assert.ok(h.view.session.current);
  const source = h.view.plan.passages[0];
  const question = h.view.turns.at(-1);
  assert.equal(question.source, source);
  const assistantRows = () => nodes(h.root).filter(n => n.classes.includes('is-assistant'));
  const assertLink = row => {
    const link = nodes(row).find(n => n.tagName === 'A');
    assert.equal(link?.options.href, h.file.path);
    assert.equal(link?.text, 'Receptors · line 5');
  };
  assertLink(assistantRows().at(-1));
  if (excerpt === SOURCE) assert.ok(!h.view.session.items[0].points[0].id.includes('#s'));
  h.host.llm.quizRecallGrade = async () => ({ points: [{ n: 1, status: 'missed', said: '', note: '', cue: '' }], feedback: '' });
  const answer = nodes(h.root).find(n => n.tagName === 'TEXTAREA');
  answer.value = 'LEARNER PROSE THAT MUST NOT BECOME EVIDENCE';
  answer.events.input();
  await button(h.root, 'Submit answer').events.click();
  assert.equal(h.view.session.results.length, 1);
  assert.equal(h.view.turns.at(-1).source, source);
  assistantRows().slice(-2).forEach(assertLink);
  assert.equal(h.rows.length, 0);
  await button(h.root, 'Send to Inbox').events.click();
  assert.equal(h.rows.length, 1);
  assert.equal(h.queued.length, 1);
  assert.equal(h.rows[0].text, excerpt);
  assert.equal(h.rows[0].sourcePath, source.path);
  assert.equal(h.rows[0].line, source.line - 1);
  assert.equal(h.rows[0].page, source.page);
  assert.equal(h.rows[0].instruction, `The reader missed this source point during Quiz: ${expected}\nTest only this point using the captured note excerpt.`);
  assert.doesNotMatch(JSON.stringify(h.rows), /LEARNER PROSE/);
});

test('a split point in a second selected note is never remapped to the first source', async () => {
  const h = harness(QuizView);
  const other = { path: 'biology/Binding.md', basename: 'Binding', extension: 'md', stat: { mtime: 1, size: PARAGRAPH.length + 20 } };
  h.host.app.vault.getFiles = () => [h.file, other];
  h.host.app.vault.getAbstractFileByPath = path => [h.file, other].find(file => file.path === path) ?? null;
  h.host.app.vault.read = async file => file === other ? `# Binding\n\n${PARAGRAPH}` : SOURCE;
  h.host.llm.selectStudyEvidence = async args => ({
    selections: [h.file, other].map(file => {
      const passage = args.passages.find(p => p.path === file.path);
      assert.ok(passage);
      return { id: passage.id, quote: passage.text };
    }), gaps: [],
  });
  await start(h, 'Free response', 'quiz me on all');
  await button(h.root, 'Skip').events.click();
  await button(h.root, 'Next question').events.click();
  assert.equal(h.view.turns.at(-1).source.path, other.path);
  assert.equal(h.view.session.items[1].points.length, 3);
  await button(h.root, 'Skip').events.click();
  assert.equal(h.view.turns.at(-1).source.path, other.path);
  const sends = nodes(h.root).filter(n => n.tagName === 'BUTTON' && n.text === 'Send to Inbox');
  assert.equal(sends.length, 2);
  await sends[1].events.click();
  assert.equal(h.rows.length, 1);
  assert.equal(h.queued.length, 1);
  assert.equal(h.rows[0].sourcePath, other.path);
  assert.equal(h.rows[0].sourceTitle, other.basename);
  assert.equal(h.rows[0].text, PARAGRAPH);
  assert.equal(h.rows[0].line, 2);
  assert.equal(h.rows[0].page, null);
});

test('multiple-choice split points retain source turns and deliberate capture', async () => {
  const h = selected();
  h.host.llm.quizMultipleChoice = async () => ({
    question: 'Which statement describes occupancy?', point: 2,
    choices: [{ id: 'A', text: 'Occupancy measures drug mass.' }, { id: 'B', text: SENTENCES[1] }, { id: 'C', text: 'Occupancy measures receptor size.' }], correctId: 'B',
  });
  h.host.llm.quizChoiceAudit = async () => ({ choices: [{ id: 'A', supported: false }, { id: 'B', supported: true }, { id: 'C', supported: false }] });
  await start(h, 'Multiple choice');
  assert.equal(h.view.turns.at(-1).source, h.view.plan.passages[0]);
  await button(h.root, 'A. Occupancy measures drug mass.').events.click();
  assert.equal(h.view.turns.at(-1).source, h.view.plan.passages[0]);
  assert.equal(h.rows.length, 0);
  await button(h.root, 'Send to Inbox').events.click();
  assert.equal(h.rows.length, 1);
  assert.equal(h.queued.length, 1);
  assert.equal(h.rows[0].text, PARAGRAPH);
  assert.ok(h.rows[0].instruction.includes(SENTENCES[1]));
  assert.doesNotMatch(h.rows[0].instruction, /Occupancy measures drug mass/);
});

test('separate missed sentences from one excerpt queue only one source capture', async () => {
  const h = selected();
  h.host.llm.quizQuestion = async () => ({ question: 'Explain the binding concept?', shape: 'concept', expects: [1, 2, 3] });
  await start(h);
  await button(h.root, 'Skip').events.click();
  const sends = nodes(h.root).filter(n => n.tagName === 'BUTTON' && n.text === 'Send to Inbox');
  assert.equal(sends.length, 3);
  for (const send of sends) await send.events.click();
  assert.equal(h.rows.length, 1);
  assert.equal(h.queued.length, 1);
  assert.equal(nodes(h.root).filter(n => n.tagName === 'BUTTON' && n.text === 'Already captured' && n.disabled).length, 2);
});

for (const duplicate of ['active history', 'archived history', 'archived duplicate index']) {
  test(`split misses respect ${duplicate} without queueing more`, async () => {
    const h = selected();
    await start(h);
    await button(h.root, 'Skip').events.click();
    const existing = { id: 'existing', sourcePath: h.file.path, text: PARAGRAPH.replaceAll(' ', '\n '), status: 'ready' };
    if (duplicate === 'active history') h.rows.push(existing);
    if (duplicate === 'archived history') {
      h.host.store.allHistory = () => [existing];
      h.host.store.hasDuplicate = () => false;
    }
    if (duplicate === 'archived duplicate index') h.host.store.hasDuplicate = () => true;
    const count = h.rows.length;
    await button(h.root, 'Send to Inbox').events.click();
    assert.equal(h.rows.length, count);
    assert.equal(h.queued.length, 0);
    assert.equal(button(h.root, 'Already captured').disabled, true);
  });
}

for (const mutation of ['ignored', 'disk edit', 'rename', 'unsaved edit']) {
  test(`a retained split-point capture action rejects a stale source: ${mutation}`, async () => {
    const h = selected();
    await start(h);
    await button(h.root, 'Skip').events.click();
    const send = button(h.root, 'Send to Inbox');
    if (mutation === 'ignored') h.ignore();
    if (mutation === 'disk edit') h.file.stat.mtime++;
    if (mutation === 'rename') h.file.path = 'renamed.md';
    if (mutation === 'unsaved edit') h.editors.push({ view: { file: h.file, editor: { getValue: () => 'Changed unsaved source' } } });
    await send.events.click();
    assert.equal(h.rows.length, 0);
    assert.equal(h.queued.length, 0);
    assert.equal(button(h.root, 'Send to Inbox'), undefined);
    assert.equal(nodes(h.root).filter(n => n.tagName === 'A').length, 0);
  });
}
