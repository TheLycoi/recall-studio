// Exercise assembled production requests, not source-text template matching.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';

let m, system;
before(async () => {
  const out = await build({ stdin: { contents: `export { LlmClient } from './src/llm'; export { lintCard } from './src/lint'; export { makeCard, makeHighlight } from './src/model'; export { validatePreparation, validateDrafts } from './src/generation';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'cjs', platform: 'node', external: ['obsidian'], logLevel: 'silent' });
  const mod = new Module('prompt-examples');
  mod.require = id => id === 'obsidian' ? { Notice: class {}, requestUrl() { throw Error('Network forbidden'); } } : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text, 'prompt-examples');
  m = mod.exports;
  const llm = new m.LlmClient(() => ({ provider: 'codex', language: '' }));
  llm.codex = { async complete(req) { system = req.system; return req.schema.parse({ cards: [] }); } };
  await llm.writeCards(m.makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Synthetic', text: 'Synthetic source.' }));
});

function examples() {
  return [...system.matchAll(/<example>([\s\S]*?)<\/example>/g)].map(([, block]) => {
    const text = block.match(/<highlight>([\s\S]*?)<\/highlight>/)[1];
    const heading = block.match(/<heading>([\s\S]*?)<\/heading>/)?.[1];
    const h = m.makeHighlight({ sourcePath: 'example.md', sourceTitle: heading ?? 'Zeta calibration', heading, text });
    const cards = (block.match(/<cards>([\s\S]*?)<\/cards>/)?.[1] ?? '').split('\n').filter(line => /^(qa|cloze) \|/.test(line)).map(line => {
      const [kind, front, back] = line.split(' | ');
      return m.makeCard(h.id, kind === 'qa' ? { kind, front, back } : { kind, text: front });
    });
    return { h, cards, block };
  });
}

test('the shared method has three aligned examples: procedure/explanation, subject cue and withheld unsupported reason', () => {
  const ex = examples();
  assert.equal(ex.length, 3);
  assert.deepEqual(ex.map(e => e.cards.length), [2, 1, 0]);
  assert.match(ex[0].cards[0].text, /c1::disconnect power.*c2::attach the reference cable.*c3::reconnect power/);
  assert.match(ex[1].cards[0].text, /^Testosterone signalling: Type III binds/);
  assert.match(ex[2].block, /requested_target.*Why/);
  assert.match(ex[2].block, /Withhold this unsupported reason/);
});

test('examples keep structural and source checks, while the meaningful long explanation requires length adjudication', () => {
  for (const { h, cards } of examples()) for (const card of cards) {
    const lint = m.lintCard(card, h, cards.filter(c => c !== card));
    const expected = card.kind === 'qa' ? ['qa-answer-long'] : [];
    assert.deepEqual(lint.failures, expected, card.text || card.front);
    assert.deepEqual(lint.warnings, []);
    const preparation = m.validatePreparation({ facts: [{ id: 'F1', statement: h.text, quote: h.text }], plan: [{ id: 'P1', factIds: ['F1'], entity: h.sourceTitle, aspect: '', value: h.text, reason: 'A meaningful source-supported unit.' }], exclusions: [], omissions: [], conflicts: [] }, h.text);
    const [draft] = m.validateDrafts({ cards: [{ planId: 'P1', factIds: ['F1'], kind: card.kind, front: card.front, back: card.back, text: card.text }] }, preparation);
    assert.equal(draft.back, card.back);
    assert.equal(draft.text, card.text);
  }
  assert.match(system, /length warning without becoming a different retrieval task/);
});
