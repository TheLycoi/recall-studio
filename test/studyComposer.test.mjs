import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadQuiz, harness, nodes, button } from './quizHarness.mjs';

let QuizView;
before(async () => { ({ QuizView } = await loadQuiz()); });

test('Chat keeps the full-width textbox and compact actions in one composer', async () => {
  const { root, view } = harness(QuizView);
  await view.onOpen();
  const composer = nodes(root).find(n => n.hasClass('review-chat-input'));
  const box = nodes(composer).find(n => n.tagName === 'TEXTAREA');
  assert.ok(box.hasClass('review-chat-question'));
  const actions = composer.children.find(n => n.hasClass('review-chat-input-actions'));
  assert.ok(actions, 'Send and Cancel must share the composer action row');
  assert.deepEqual(actions.children.map(n => n.text), ['Send', 'Cancel']);
  assert.ok(actions.children.every(n => n.tagName === 'BUTTON'));
  assert.equal(root.children.filter(n => n.tagName === 'BUTTON').length, 0);
  box.value = 'quiz me on affinity'; box.events.input();
  await button(root, 'Send').events.click();
  assert.equal(view.awaitingGuide, true);
  assert.equal(nodes(root).find(n => n.tagName === 'TEXTAREA').value, '');
  await button(root, 'Cancel').events.click();
  assert.equal(view.awaitingGuide, false);
});

test('Chat composer preserves the draft during rendering and keeps Cancel enabled while busy', async () => {
  const { root, view } = harness(QuizView);
  await view.onOpen();
  const box = nodes(root).find(n => n.tagName === 'TEXTAREA');
  box.value = 'Unsent study guide'; box.events.input();
  view.busy = true; view.render();
  assert.equal(nodes(root).find(n => n.tagName === 'TEXTAREA').value, box.value);
  assert.equal(nodes(root).find(n => n.tagName === 'TEXTAREA').disabled, true);
  assert.equal(button(root, 'Send').disabled, true);
  assert.equal(button(root, 'Cancel').disabled, false);
});

test('Chat sizing contains the textarea and does not reserve an empty transcript gap', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const rule = selector => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const found = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
    assert.ok(found, `Missing ${selector}`);
    return found[1];
  };
  const input = rule('.review-chat-question');
  assert.match(input, /box-sizing:\s*border-box/);
  assert.match(input, /width:\s*100%/);
  assert.match(input, /max-width:\s*100%/);
  assert.match(input, /min-width:\s*0/);
  assert.match(input, /resize:\s*vertical/);
  assert.match(rule('.review-chat-log:empty'), /display:\s*none/);
});
