import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadQuiz, harness, nodes, text, button } from './quizHarness.mjs';

test('Make flashcards has an Experimental palette command and uses the existing Chat entrypoint', async () => {
  const { RECALL_COMMANDS } = await loadQuiz('src/commands.ts');
  const command = RECALL_COMMANDS.find(c => c.id === 'make-flashcards');
  assert.ok(command); assert.match(command.name, /Experimental/);
  const calls = []; const host = { openChat: async request => calls.push(request) };
  assert.equal(command.available(host), true); await command.run(host);
  assert.deepEqual(calls, ['Make flashcards']);
});
test('Inbox has no message composer; Chat alone accepts study text and retains its draft across tabs', async () => {
  const { InboxView } = await loadQuiz('src/inboxView.ts');
  const h = harness(class {}); h.host.store.onChange = () => () => {};
  const view = new InboxView({ contentEl:h.root }, h.host);
  view.renderHeader = () => {}; view.rebuildCrossInterference = () => {};
  await view.onOpen();
  assert.equal(nodes(h.root).some(n => n.options.attr?.['aria-label'] === 'Inbox command'), false);
  assert.equal(button(h.root, 'Send command'), undefined);
  assert.equal(nodes(h.root).some(n => n.hasClass('review-inbox-command')), false);
  assert.equal(nodes(h.root).filter(n => n.tagName === 'TEXTAREA').length, 1);
  const input = nodes(view.chatEl).find(n => n.tagName === 'TEXTAREA');
  const chat = view.chat, cards = view.cardsEl;
  await button(h.root, 'Chat').events.click();
  assert.equal(view.chatEl.hasClass('review-inbox-hidden'), false);
  input.value = 'quiz me on affinity'; input.events.input();
  await button(h.root, 'Inbox').events.click();
  assert.equal(view.chatEl.hasClass('review-inbox-hidden'), true);
  await button(h.root, 'Chat').events.click();
  assert.equal(nodes(view.chatEl).find(n => n.tagName === 'TEXTAREA'), input);
  assert.equal(input.value, 'quiz me on affinity');
  await button(view.chatEl, 'Send').events.click();
  assert.equal(view.panel, 'chat'); assert.equal(view.chat, chat); assert.equal(view.cardsEl, cards);
  assert.match(text(view.chatEl), /Paste a study guide/);
  assert.equal(h.calls.length, 0);
  await view.onClose();
});
test('registered export remains available without an Inbox textbox', async () => {
  const { runNamedCommand } = await loadQuiz('src/commands.ts');
  const h = harness(class {});
  let exports = 0; h.host.exportHighlights = async rows => { assert.deepEqual(rows, []); exports++; };
  assert.equal(await runNamedCommand(h.host, '/export'), true);
  assert.equal(exports, 1); assert.equal(h.calls.length, 0);
});
