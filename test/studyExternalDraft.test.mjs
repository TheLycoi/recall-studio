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
  return { ...h, root, view, effects, editor, field, card };
}
test('background store changes preserve the actual unsaved card editor', async t => {
  const f = await fixture(t);
  const before = JSON.stringify(f.rows);
  f.view.scheduleRender();
  assert.ok(nodes(f.view.cardsEl).includes(f.editor));
  assert.equal(f.field.value, 'Unsent card question');
  assert.equal(JSON.stringify(f.rows), before);
  assert.equal(f.view.dirty, true);
  assert.deepEqual(f.effects, []);
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
