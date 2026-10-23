import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadQuiz, harness, nodes, button } from './quizHarness.mjs';

// Exercise the production view; no model transport or live store is used.
test('Inbox mounts alone without Chat, study controls or a message composer', async () => {
  const { InboxView } = await loadQuiz('src/inboxView.ts');
  const h = harness(class {});
  h.host.store.onChange = () => () => {};
  const view = new InboxView({ contentEl: h.root }, h.host);
  view.renderHeader = () => {};
  view.rebuildCrossInterference = () => {};
  await view.onOpen();
  assert.equal(button(h.root, 'Chat'), undefined);
  assert.equal(nodes(h.root).some(n => n.hasClass('wikilm-tabs')), false);
  assert.equal(nodes(h.root).some(n => n.hasClass('review-inbox-chat')), false);
  assert.equal(nodes(h.root).filter(n => n.tagName === 'TEXTAREA').length, 0);
  assert.ok(view.cardsEl);
  assert.equal(view.cardsEl.hasClass('review-inbox-hidden'), false);
  assert.equal(view.chat, undefined);
  assert.equal(h.calls.length, 0);
  await view.onClose();
});

test('retired study commands and aliases are unavailable without invoking a model', async () => {
  const { RECALL_COMMANDS, runNamedCommand } = await loadQuiz('src/commands.ts');
  assert.equal(RECALL_COMMANDS.some(c => ['open-chat', 'make-flashcards'].includes(c.id)), false);
  const host = new Proxy({}, { get() { throw Error('Retired command accessed the host'); } });
  for (const name of ['open-chat', '/chat', 'Open quiz', 'Open quiz (Experimental)',
    'make-flashcards', '/flashcards', 'Make flashcards', 'Make flashcards (Experimental)']) {
    assert.equal(await runNamedCommand(host, name), null, name);
  }
});
