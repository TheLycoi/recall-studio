import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadQuiz, harness, nodes, text, button } from './quizHarness.mjs';

// Native study entrypoints are retired; inboxOnly.test.mjs checks their absence.
test('registered export remains available without an Inbox textbox', async () => {
  const { runNamedCommand } = await loadQuiz('src/commands.ts');
  const h = harness(class {});
  let exports = 0; h.host.exportHighlights = async rows => { assert.deepEqual(rows, []); exports++; };
  assert.equal(await runNamedCommand(h.host, '/export'), true);
  assert.equal(exports, 1); assert.equal(h.calls.length, 0);
});
