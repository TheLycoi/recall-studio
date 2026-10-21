import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadQuiz, harness, element, nodes, button, text, SOURCE } from './quizHarness.mjs';

let InboxView, QuizView, makeHighlight, makeCard, DEFAULT_SETTINGS;
before(async () => {
  ({ InboxView } = await loadQuiz('src/inboxView.ts'));
  ({ QuizView } = await loadQuiz());
  ({ makeHighlight, makeCard } = await loadQuiz('src/model.ts'));
  ({ DEFAULT_SETTINGS } = await loadQuiz('src/settings.ts'));
});

// Only extend the existing DOM harness for production editor visibility queries.
function dom() {
  const extend = el => {
    const create = el.createEl;
    el.createEl = function (...args) { return extend(create.apply(this, args)); };
    el.show = el.hide = el.toggle = () => {};
    el.querySelector = selector => {
      if (selector === '.review-chat textarea') return nodes(el).find(n => n.options.attr?.['aria-label'] === 'Chat message' || n.options.attr?.['aria-label'] === 'Your answer') ?? null;
      const match = selector.match(/^\.wikilm-card\[data-id="([^"]+)"\] \.wikilm-editor$/);
      assert.ok(match, `Unexpected DOM query: ${selector}`);
      const card = nodes(el).find(n => n.hasClass('wikilm-card') && n.dataset.id === match[1]);
      return card ? nodes(card).find(n => n.hasClass('wikilm-editor')) ?? null : null;
    };
    return el;
  };
  return extend(element());
}
const type = (box, value) => { box.value = value; box.events.input(); };
const studyBox = view => nodes(view.chatEl).find(n => n.tagName === 'TEXTAREA');
async function say(view, message) {
  type(studyBox(view), message);
  await button(view.chatEl, view.chat.session?.current ? 'Submit answer' : 'Send').events.click();
}
async function fixture(t) {
  const previousWindow = globalThis.window;
  globalThis.window = { setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: () => {} };
  t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
  const h = harness(QuizView), root = dom();
  h.host.settings = { ...DEFAULT_SETTINGS };
  h.host.schema = { openCount: () => 0 };
  h.host.store.onChange = () => () => {};
  h.host.store.counts = () => ({ toReview: 1, queued: 0, generating: 0, errors: 0 });
  const row = makeHighlight({ sourcePath: h.file.path, sourceTitle: 'Receptors', text: SOURCE, status: 'ready' });
  const card = makeCard(row.id, { kind: 'qa', front: 'What is affinity?', back: 'Binding strength' });
  row.cards = [card]; h.rows.push(row);
  const effects = [];
  const read = h.host.app.vault.read;
  h.host.app.vault.read = async (...args) => { effects.push('read'); return read(...args); };
  for (const name of Object.keys(h.host.llm).filter(n => n !== 'requestAuthorization')) {
    const fn = h.host.llm[name];
    h.host.llm[name] = async (...args) => { effects.push(name); return fn(...args); };
  }
  const view = new InboxView({ contentEl: root }, h.host);
  await view.onOpen();
  t.after(() => view.onClose());
  nodes(view.cardsEl).find(n => n.title === 'Edit (e)').events.click({ stopPropagation() {} });
  const editor = nodes(view.cardsEl).find(n => n.hasClass('wikilm-editor'));
  assert.ok(editor, 'The real card editor must be mounted');
  const field = nodes(editor).find(n => n.options.attr?.['aria-label'] === 'Question');
  field.value = 'Unsent card question';
  return { ...h, root, view, effects, editor, field, card, command: nodes(root).find(n => n.options.attr?.['aria-label'] === 'Inbox command') };
}
function snapshot(f) {
  const chat = f.view.chat;
  return {
    state: JSON.stringify(chat, (key, value) => ['contentEl', 'host', 'study', 'reader', 'cleanup'].includes(key) ? undefined : value),
    effects: [...f.effects], rows: JSON.stringify(f.rows), queued: [...f.queued],
    session: chat.session, plan: chat.plan, study: chat.study, sources: [...chat.unitSources],
    turns: [...chat.turns], guide: chat.guide,
  };
}

// Acceptance path: rendered Inbox Send command -> startStudy -> public Quiz submit.
test('Inbox rejects an external command without replacing either mounted draft or the card editor', async t => {
  const f = await fixture(t), { view, command } = f;
  await button(f.root, 'Chat').events.click();
  const box = studyBox(view), chat = view.chat, cards = view.cardsEl;
  type(box, 'Unsent study draft that must survive a panel switch');
  await button(f.root, 'Inbox').events.click();
  type(command, 'quiz me on affinity');
  const before = snapshot(f);
  await button(f.root, 'Send command').events.click();
  assert.equal(command.value, 'quiz me on affinity', 'Rejected Inbox command must remain available for retry');
  assert.equal(nodes(f.root).find(n => n.options.attr?.['aria-label'] === 'Inbox command'), command);
  assert.equal(studyBox(view), box, 'Rejection must not redraw the study composer');
  assert.equal(box.value, 'Unsent study draft that must survive a panel switch');
  assert.deepEqual(snapshot(f), before);
  assert.equal(view.chat, chat); assert.equal(view.cardsEl, cards);
  await button(f.root, 'Inbox').events.click();
  await button(f.root, 'Chat').events.click();
  assert.equal(studyBox(view), box);
  assert.ok(nodes(view.cardsEl).includes(f.editor));
  assert.equal(f.field.value, 'Unsent card question');
  assert.equal(f.card.front, 'What is affinity?');
  type(box, '');
  await button(f.root, 'Inbox').events.click();
  await button(f.root, 'Send command').events.click();
  assert.equal(command.value, '');
  assert.equal(view.chat.awaitingGuide, true);
  assert.match(text(view.chatEl), /Paste a study guide/);
  assert.deepEqual(f.effects, []); assert.equal(f.queued.length, 0);
});

test('unfinished guide and answer reject direct and Inbox submissions until the user sends the draft', async t => {
  for (const phase of ['guide', 'answer']) {
    await t.test(phase, async t => {
      const f = await fixture(t), { view, command } = f;
      await view.startStudy('quiz me on Receptors');
      if (phase === 'answer') {
        await say(view, 'Test the definition.');
        await button(view.chatEl, 'Free response').events.click();
        assert.ok(view.chat.session?.current);
      }
      const box = studyBox(view), draft = phase === 'guide' ? 'Focus on binding strength.' : SOURCE;
      type(box, draft);
      const before = snapshot(f);
      assert.equal(await view.chat.submit('Make flashcards on Receptors'), false);
      assert.equal(studyBox(view), box); assert.equal(box.value, draft);
      assert.deepEqual(snapshot(f), before);
      await button(f.root, 'Inbox').events.click();
      type(command, 'quiz me on Receptors');
      await button(f.root, 'Send command').events.click();
      assert.equal(command.value, 'quiz me on Receptors');
      assert.equal(studyBox(view), box); assert.equal(box.value, draft);
      assert.deepEqual(snapshot(f), before);
      await button(view.chatEl, phase === 'answer' ? 'Submit answer' : 'Send').events.click();
      assert.equal(view.chat.draftQuestion, '', 'Internal Send must still consume its own draft');
      if (phase === 'guide') assert.equal(view.chat.guide, draft);
      else assert.equal(view.chat.session.results.length, 1);
      const effects = [...f.effects];
      await button(f.root, 'Inbox').events.click();
      await button(f.root, 'Send command').events.click();
      assert.equal(command.value, ''); assert.equal(view.chat.guide, '');
      assert.equal(view.chat.awaitingGuide, true);
      assert.equal(button(view.chatEl, 'Free response'), undefined);
      assert.deepEqual(f.effects, effects, 'Retry must request fresh coverage before further reads or requests');
      assert.equal(f.queued.length, 0);
      assert.ok(nodes(view.cardsEl).includes(f.editor));
      assert.equal(f.field.value, 'Unsent card question');
    });
  }
});

test('public submit still accepts an empty composer and rejects busy or closed study views', async () => {
  const h = harness(QuizView); await h.view.onOpen();
  assert.equal(await h.view.submit('quiz me on Receptors'), true);
  assert.equal(h.view.awaitingGuide, true);
  let release;
  h.host.llm.selectStudyEvidence = () => new Promise(resolve => { release = resolve; });
  assert.equal(await h.view.submit('Test the definition.'), true);
  const pending = button(h.root, 'Free response').events.click();
  for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(release); assert.equal(h.view.busy, true);
  const busyBox = nodes(h.root).find(n => n.tagName === 'TEXTAREA');
  assert.equal(await h.view.submit('quiz me on affinity'), false);
  assert.equal(nodes(h.root).find(n => n.tagName === 'TEXTAREA'), busyBox);
  await h.view.onClose();
  const closedBox = nodes(h.root).find(n => n.tagName === 'TEXTAREA');
  assert.equal(await h.view.submit('quiz me on affinity'), false);
  assert.equal(nodes(h.root).find(n => n.tagName === 'TEXTAREA'), closedBox);
  release({ selections: [], gaps: [] }); await pending;
  assert.equal(h.calls.length, 0); assert.equal(h.queued.length, 0);
});
