import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadQuiz, harness, element, nodes, button, text, SOURCE } from './quizHarness.mjs';

let RecallPlugin, InboxView, QuizView, runNamedCommand, makeHighlight, makeCard, DEFAULT_SETTINGS;
before(async () => {
  ({ RecallPlugin, InboxView, QuizView, runNamedCommand, makeHighlight, makeCard, DEFAULT_SETTINGS } = await loadQuiz('test/fixtures/studyRegistryEntry.ts'));
});

// Supply only the Obsidian DOM operations missing from the shared host double.
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
  delete h.host.openInbox;
  const plugin = Object.assign(new RecallPlugin(), h.host);
  plugin.settings = { ...DEFAULT_SETTINGS };
  plugin.schema = { openCount: () => 0 };
  plugin.store.onChange = () => () => {};
  plugin.store.counts = () => ({ toReview: 1, queued: 0, generating: 0, errors: 0 });
  const row = makeHighlight({ sourcePath: h.file.path, sourceTitle: 'Receptors', text: SOURCE, status: 'ready' });
  const card = makeCard(row.id, { kind: 'qa', front: 'What is affinity?', back: 'Binding strength' });
  row.cards = [card]; h.rows.push(row);
  const effects = [];
  const read = plugin.app.vault.read;
  plugin.app.vault.read = async (...args) => { effects.push('read'); return read(...args); };
  for (const name of Object.keys(plugin.llm).filter(n => n !== 'requestAuthorization')) {
    const fn = plugin.llm[name];
    plugin.llm[name] = async (...args) => { effects.push(name); return fn(...args); };
  }
  const view = new InboxView({ contentEl: root }, plugin);
  const leaves = [{ view }];
  plugin.app.workspace.getLeavesOfType = kind => kind === 'review-inbox' ? leaves : [];
  plugin.app.workspace.revealLeaf = async () => {};
  plugin.app.workspace.getRightLeaf = () => null;
  await view.onOpen();
  t.after(() => view.onClose());
  nodes(view.cardsEl).find(n => n.title === 'Edit (e)').events.click({ stopPropagation() {} });
  const editor = nodes(view.cardsEl).find(n => n.hasClass('wikilm-editor'));
  assert.ok(editor, 'The real card editor must be mounted');
  const field = nodes(editor).find(n => n.options.attr?.['aria-label'] === 'Question');
  field.value = 'Unsent card question';
  return { ...h, root, plugin, view, leaves, effects, editor, field, card };
}
test('retired study aliases preserve the real mounted card editor and stored data', async t => {
  const f = await fixture(t);
  const before = JSON.stringify(f.rows);
  for (const name of ['Make flashcards', '/flashcards', '/make-flashcards', '/chat',
    'Open quiz (Experimental)', 'Recall Studio: Make flashcards']) {
    assert.equal(await runNamedCommand(f.plugin, name), null);
    assert.ok(nodes(f.view.cardsEl).includes(f.editor));
    assert.equal(f.field.value, 'Unsent card question');
    assert.equal(JSON.stringify(f.rows), before);
    assert.deepEqual(f.effects, []);
    assert.equal(f.queued.length, 0);
  }
  assert.equal(f.plugin.openChat, undefined);
  assert.equal(f.view.startStudy, undefined);
});

test('opening Inbox preserves the actual unsaved card editor', async t => {
  const f = await fixture(t);
  assert.equal(await runNamedCommand(f.plugin, '/inbox'), true);
  assert.ok(nodes(f.view.cardsEl).includes(f.editor));
  assert.equal(f.field.value, 'Unsent card question');
  assert.equal(f.card.front, 'What is affinity?');
  f.plugin.app.workspace.getActiveFile = () => null;
  assert.equal(await runNamedCommand(f.plugin, '/sweep'), false);
  assert.deepEqual(f.effects, []);
});

test('Inbox navigation failures preserve the unsaved card editor', async t => {
  const f = await fixture(t);
  const failure = new Error('Workspace could not reveal Inbox');
  f.plugin.app.workspace.revealLeaf = async () => { throw failure; };
  await assert.rejects(f.plugin.openInbox(), error => error === failure);
  assert.ok(nodes(f.view.cardsEl).includes(f.editor));
  assert.equal(f.field.value, 'Unsent card question');
  assert.deepEqual(f.effects, []);
});
