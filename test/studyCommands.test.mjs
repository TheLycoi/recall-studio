import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadQuiz, harness, nodes, text } from './quizHarness.mjs';

test('Make flashcards has an Experimental palette command and uses the existing Inbox entrypoint', async () => {
  const { RECALL_COMMANDS } = await loadQuiz('src/commands.ts');
  const command = RECALL_COMMANDS.find(c => c.id === 'make-flashcards');
  assert.ok(command); assert.match(command.name, /Experimental/);
  const calls = []; const host = { openChat: async request => calls.push(request) };
  assert.equal(command.available(host), true); await command.run(host);
  assert.deepEqual(calls, ['Make flashcards']);
});
test('the mounted Inbox accepts study commands without replacing its Quiz or card editor', async () => {
  const { InboxView } = await loadQuiz('src/inboxView.ts');
  const h = harness(class {}); h.host.store.onChange = () => () => {};
  const view = new InboxView({ contentEl:h.root }, h.host);
  view.renderHeader = () => {}; view.rebuildCrossInterference = () => {};
  await view.onOpen();
  const input = nodes(h.root).find(n => n.tagName === 'TEXTAREA' && n.options.attr?.['aria-label'] === 'Inbox command');
  assert.ok(input, 'a command composer must be mounted in the Inbox');
  input.value = 'quiz me on affinity'; input.events.input();
  const chat = view.chat, cards = view.cardsEl;
  view.render(); assert.equal(input.value, 'quiz me on affinity');
  await nodes(h.root).find(n => n.options.text === 'Send command').events.click();
  assert.equal(view.panel, 'chat'); assert.equal(view.chat, chat); assert.equal(view.cardsEl, cards);
  assert.match(text(view.chatEl), /Paste a study guide/);
  assert.equal(input.value, ''); assert.equal(h.calls.length, 0);
  await view.onClose();
});
test('Inbox slash commands run the registered action without starting a study session', async () => {
  const { InboxView } = await loadQuiz('src/inboxView.ts');
  const h = harness(class {}); h.host.store.onChange = () => () => {};
  let exports = 0; h.host.exportHighlights = async rows => { assert.deepEqual(rows, []); exports++; };
  const view = new InboxView({ contentEl:h.root }, h.host);
  view.renderHeader = () => {}; view.rebuildCrossInterference = () => {};
  await view.onOpen();
  const input = nodes(h.root).find(n => n.options.attr?.['aria-label'] === 'Inbox command');
  input.value = '/export'; input.events.input();
  await nodes(h.root).find(n => n.options.text === 'Send command').events.click();
  assert.equal(exports, 1); assert.equal(view.panel, 'inbox');
  assert.equal(input.value, ''); assert.equal(h.calls.length, 0);
  await view.onClose();
});
