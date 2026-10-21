import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadQuiz, harness, button, nodes, text, SOURCE } from './quizHarness.mjs';
let QuizView;
before(async () => { ({ QuizView } = await loadQuiz()); });
async function say(h, message) { h.view.draftQuestion = message; await h.view.ask(); }
function study() {
  const h = harness(QuizView);
  h.host.store.allHistory = () => h.rows;
  h.host.store.touch = () => {};
  h.host.llm.requestAuthorization = (check = () => true) => check;
  h.selections = [];
  h.host.llm.selectStudyEvidence = async args => {
    h.selections.push(args);
    return { selections: args.passages.map(p => ({ id: p.id, quote: p.text })), gaps: [] };
  };
  return h;
}
test('the shared study surface says Chat and names both experimental activities', async () => {
  for (const command of ['quiz me on affinity', 'Make flashcards on affinity']) {
    const h = study(); await h.view.onOpen();
    assert.equal(nodes(h.root).find(n => n.tagName === 'H3')?.text, 'Chat');
    assert.match(text(h.root), /Quiz & Make Flashcards · Experimental/);
    const box = nodes(h.root).find(n => n.tagName === 'TEXTAREA');
    assert.equal(box.options.attr['aria-label'], 'Chat message');
    assert.match(box.options.attr.placeholder, /quiz me on/i);
    assert.match(box.options.attr.placeholder, /make flashcards on/i);
    await say(h, command);
    assert.equal(nodes(h.root).find(n => n.tagName === 'H3')?.text, 'Chat');
    assert.match(text(h.root), /Paste a study guide/);
    assert.equal(h.selections.length, 0);
  }
});
test('each quiz asks for a fresh coverage-only guide before reading notes or calling a model', async () => {
  const h = study(); let reads = 0;
  h.host.app.vault.read = async () => { reads++; return SOURCE; };
  await say(h, 'quiz me on Receptors');
  assert.match(text(h.root), /paste.*study guide|study guide.*paste/i);
  assert.match(text(h.root), /coverage.*only|only.*coverage/i);
  assert.equal(reads, 0); assert.equal(h.calls.length, 0); assert.equal(h.selections.length, 0);
  assert.equal(button(h.root, 'Free response'), undefined);
  await say(h, ' '); assert.equal(reads, 0);
});
test('Make Flashcards finds a topic inside notes and queues only selected references after the guide', async () => {
  const h = study();
  await say(h, 'Make flashcards on affinity');
  assert.match(text(h.root), /study guide/i);
  assert.equal(h.queued.length, 0); assert.equal(h.selections.length, 0);
  await say(h, 'Focus on the definition, not invented guide-only facts.');
  assert.equal(h.selections.length, 1);
  assert.equal(h.selections[0].topic, 'affinity');
  assert.equal(h.rows.length, 1); assert.equal(h.queued.length, 1);
  assert.equal(h.rows[0].text, SOURCE); assert.equal(h.rows[0].sourcePath, h.file.path);
  assert.match(h.rows[0].instruction, /coverage instructions only/i);
  assert.ok(nodes(h.root).some(n => n.tagName === 'A' && n.options.href === h.file.path));
  assert.match(text(h.root), /queued.*1|1.*queued/i);
});
test('topic Quiz uses only selected reference passages and passes the guide as instructions', async () => {
  const h = study(); h.setRaw(`${SOURCE}\n\nAn unrelated planet has an invented property.`);
  h.host.llm.selectStudyEvidence = async args => { h.selections.push(args); return { selections:[{id:args.passages[0].id, quote:SOURCE}], gaps:[] }; };
  await say(h, 'quiz me on affinity');
  await say(h, 'Test the definition. Guide-only claim: unicorns bind receptors.');
  const free = button(h.root, 'Free response'); assert.ok(free);
  await free.events.click();
  assert.equal(h.selections.length, 1);
  assert.deepEqual(h.calls[0][1].points, [SOURCE]);
  assert.match(h.calls[0][1].standingInstructions, /Guide-only claim/);
  assert.doesNotMatch(text(h.root), /Affinity is the strength/);
  await say(h, SOURCE);
  const log = nodes(h.root).find(n => n.classes.includes('review-chat-log'));
  const transcript = text(log);
  assert.ok(transcript.indexOf('What does affinity mean?') < transcript.indexOf(SOURCE));
  assert.match(transcript, /Recalled 1 of 1/);
  await say(h, 'quiz me on affinity');
  assert.match(text(h.root), /Paste a study guide/);
  assert.equal(button(h.root, 'Free response'), undefined);
  assert.equal(h.selections.length, 1, 'a previous guide must not be reused');
});
test('topic Quiz never clips a selected passage to its relevance quote', async () => {
  const h = study();
  const original = `${SOURCE}\nAn unrelated planet has an invented property.`;
  h.setRaw(original);
  h.host.llm.selectStudyEvidence = async args => {
    h.selections.push(args);
    return { selections: [{ id: args.passages[0].id, quote: SOURCE }], gaps: [] };
  };
  await say(h, 'quiz me on affinity');
  await say(h, 'Test the definition.');
  await button(h.root, 'Free response').events.click();
  assert.equal(h.view.plan.passages[0].text, original, 'The old single-newline fixture stays intact instead of being clipped');
  assert.deepEqual(h.calls[0][1].points, [SOURCE, 'An unrelated planet has an invented property.']);
  assert.equal(h.view.plan.passages[0].line, 1);
  assert.deepEqual(h.rows, []);
  assert.deepEqual(h.queued, []);
});
test('bare study commands ask for a topic, then a fresh guide, and show Experimental', async () => {
  for (const command of ['Make flashcards', 'quiz me']) {
    const h = study(); await say(h, command);
    assert.match(text(h.root), /what topic/i); assert.match(text(h.root), /Experimental/);
    await say(h, 'affinity'); assert.match(text(h.root), /Paste a study guide/);
    assert.equal(h.selections.length, 0);
    await say(h, 'cancel'); assert.match(text(h.root), /cancelled/i);
    assert.equal(h.selections.length, 0);
  }
});
test('a long guide remains intact and oversized input is rejected without provider calls', async () => {
  const h = study(); await say(h, 'quiz me on affinity');
  const box = nodes(h.root).find(n => n.tagName === 'TEXTAREA');
  assert.ok(!box.maxLength || box.maxLength < 0, 'native maxLength must not silently truncate pasted guides');
  const guide = 'Guide '.repeat(1400); await say(h, guide);
  assert.equal(h.view.draftQuestion, guide);
  assert.match(text(h.root), /8000/); assert.equal(h.selections.length, 0);
  assert.equal(button(h.root, 'Free response'), undefined);
});
test('unsupported guide coverage is reported in both experimental flows', async () => {
  for (const mode of ['quiz me', 'make flashcards']) {
    const h = study();
    h.host.llm.selectStudyEvidence = async args => ({ selections:[{id:args.passages[0].id, quote:SOURCE}], gaps:[2] });
    await say(h, `${mode} on affinity`);
    await say(h, 'Test affinity.\nTest an absent topic.');
    if (mode === 'quiz me') await button(h.root, 'Free response').events.click();
    assert.match(text(h.root), /Not supported by the selected note excerpts/);
    assert.match(text(h.root), /Test an absent topic/);
  }
});
