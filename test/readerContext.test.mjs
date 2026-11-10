import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadQuiz } from './quizHarness.mjs';
let capture, generation, llm, data;
before(async () => {
  capture = await loadQuiz('src/capture.ts'); generation = await loadQuiz('src/generation.ts');
  llm = await loadQuiz('src/llm.ts'); data = await loadQuiz('src/inboxData.ts');
});
async function captureNote(raw, text) {
  const highlights = [];
  const host = { settings: { contextChars: 20, markMode: 'none' }, app: { vault: { async read() { return raw; } } },
    store: { hasDuplicate() { return false; }, add(h) { highlights.push(h); } }, generator: { enqueue() {} } };
  return capture.captureReadingSelection(host, { file: { path: 'synthetic.md' } }, { getSelection() { return null; } }, { text });
}
test('capture retains the source note for the reader, separate from short writer context', async () => {
  const raw = 'Velin means a pause between pulses.\n' + 'Background '.repeat(100) + '\nThe Vela signal is blue.';
  const h = await captureNote(raw, 'The Vela signal is blue.');
  assert.equal(h.noteContext.text, raw);
  assert.equal(h.noteContext.truncated, false);
  assert.equal(h.before, 'Background Background'); // Existing context snaps out to word boundaries.
  assert.notEqual(generation.generationSourceKey(h), generation.generationSourceKey({ ...h, noteContext: { ...h.noteContext, text: 'changed' } }));
});
test('long notes use an explicitly truncated bounded window containing the selection', async () => {
  const text = 'The Vela signal is blue.', raw = 'a'.repeat(30000) + text + 'b'.repeat(30000);
  const h = await captureNote(raw, text);
  assert.ok(h.noteContext.text.length <= 24000);
  assert.ok(h.noteContext.text.includes(text)); assert.equal(h.noteContext.truncated, true);
});
test('note context excludes frontmatter and survives the real inbox parser without changing legacy records', async () => {
  const body = 'Velin means a pause.\nThe Vela signal is blue.';
  const h = await captureNote('---\nprivate_metadata: do not include\n---\n' + body, 'The Vela signal is blue.');
  assert.equal(h.noteContext.text, body);
  const roundtrip = data.parseInboxJson(JSON.stringify({ version: 1, highlights: [h] }));
  assert.equal(roundtrip.ok, true);
  assert.deepEqual(roundtrip.data.highlights[0], h);
  const legacy = { ...h }; delete legacy.noteContext;
  assert.deepEqual(data.parseInboxJson(JSON.stringify({ highlights: [legacy] })).data.highlights[0], legacy);
  assert.equal(data.parseInboxJson(JSON.stringify({ highlights: [{ ...h, noteContext: { text: 'a'.repeat(24001), truncated: true } }] })).ok, false);
});
test('reader context terms retain exact evidence but cannot become highlight facts', async () => {
  const h = await captureNote('Velin means a pause.\nThe Vela signal is blue.', 'The Vela signal is blue.');
  const p = { facts: [], plan: [], exclusions: [], omissions: [], conflicts: [], contextTerms: [{ term: 'Velin', definition: 'a pause', quote: 'Velin means a pause.' }] };
  assert.deepEqual(generation.validatePreparation(p, h.text, undefined, undefined, h.noteContext.text).contextTerms, p.contextTerms);
  assert.throws(() => generation.validatePreparation(p, h.text, undefined, undefined, 'No definition here.'), /context.*quote/i);
  assert.throws(() => generation.validatePreparation({ ...p, facts: [{ id: 'F1', statement: 'Velin is a pause.', quote: p.contextTerms[0].quote }] }, h.text, undefined, undefined, h.noteContext.text), /captured snapshot/);
  const client = new llm.LlmClient(() => ({ provider: 'codex' })), requests = [];
  client.codex = { async complete(req) { requests.push(req); return p; } };
  await client.prepareGeneration(h, [], {});
  assert.deepEqual(JSON.parse(requests[0].user).noteContext, h.noteContext);
  await client.auditGeneration(h, [], [], p, {});
  assert.deepEqual(JSON.parse(requests[1].user).noteContext, h.noteContext, 'grader checks context definitions against their original note');
});
