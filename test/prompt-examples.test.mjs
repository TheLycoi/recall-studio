// Exercise assembled production requests, not source-text template matching.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';

let m, system;
before(async () => {
  const out = await build({ stdin: { contents: `export { LlmClient } from './src/llm'; export { lintCard } from './src/lint'; export { makeCard, makeHighlight } from './src/model'; export { validatePreparation, validateDrafts, renderedCardReviews } from './src/generation';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'cjs', platform: 'node', external: ['obsidian'], logLevel: 'silent' });
  const mod = new Module('prompt-examples');
  mod.require = id => id === 'obsidian' ? { Notice: class {}, requestUrl() { throw Error('Network forbidden'); } } : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text, 'prompt-examples');
  m = mod.exports;
  const llm = new m.LlmClient(() => ({ provider: 'codex', language: '' }));
  llm.codex = { async complete(req) { system = req.system; return req.schema.parse({ cards: [] }); } };
  await llm.writeCards(m.makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Synthetic', text: 'Synthetic source.' }));
});

// Retired runtime demonstrations remain behavioral regression fixtures.
const regressionExamples = `<example>
<highlight>Pulmonary circuit route: right ventricle → lungs → left atrium. Systemic circuit route: left ventricle → body → right atrium.</highlight>
<good>Pulmonary circuit route: {{c1::right ventricle}} → {{c2::lungs}} → {{c3::left atrium}}.</good>
<good>Systemic circuit route: {{c1::left ventricle}} → {{c2::body}} → {{c3::right atrium}}.</good>
<note>Each numbered location is a separate review with its ordered neighbours visible; never hide the whole route as independent answers under one number.</note>
</example>
<example>
<highlight>To calibrate the fictional Zeta sensor, first disconnect power, then attach the reference cable, and finally reconnect power. Disconnecting power prevents a false calibration reading because the reference cable must be attached before the sensor resumes measurement.</highlight>
<bad>During Zeta calibration, {{c1::disconnect power}}.</bad>
<good>qa | For Zeta sensor calibration, what must happen before attaching the reference cable? | disconnect power</good>
<cards>
cloze | To calibrate the fictional Zeta sensor, first {{c1::disconnect power}}, then {{c2::attach the reference cable}}, and finally {{c3::reconnect power}}.
qa | Why disconnect power before attaching the reference cable when calibrating the fictional Zeta sensor? | Disconnecting power prevents a false calibration reading because the reference cable must be attached before the sensor resumes measurement.
</cards>
<note>Keep the ordered actions and supported rationale. The focused explanation may exceed a length warning without becoming a different retrieval task.</note>
</example>
<example>
<heading>Testosterone signalling</heading>
<highlight>Type III binds intracellular receptors.</highlight>
<cards>
cloze | Testosterone signalling: Type III binds {{c1::intracellular receptors}}.
</cards>
<note>The heading supplies the subject, not answer evidence. An arbitrary course label would not disambiguate Type III.</note>
</example>
<example>
<highlight>The fictional Zeta sensor uses a blue calibration signal.</highlight>
<requested_target>Why use a blue calibration signal?</requested_target>
<cards>
</cards>
<note>Withhold this unsupported reason; the capture supplies none. For a supported color target instead, choose either alternative below, not both.</note>
<good>The fictional Zeta sensor's calibration signal is {{c1::blue::color}}.</good>
<good>The fictional Zeta sensor's calibration signal color is {{c1::blue}}.</good>
<bad>The fictional Zeta sensor's calibration signal is {{c1::blue::blue}}.</bad>
<note>The optional color hint distinguishes color from timing or signal strength without revealing blue; the explicit color cue needs no hint. The bad hint reveals the value.</note>
</example>`;

function examples() {
  return [...regressionExamples.matchAll(/<example>([\s\S]*?)<\/example>/g)].map(([, block]) => {
    const text = block.match(/<highlight>([\s\S]*?)<\/highlight>/)[1];
    const heading = block.match(/<heading>([\s\S]*?)<\/heading>/)?.[1];
    const h = m.makeHighlight({ sourcePath: 'example.md', sourceTitle: heading ?? 'Zeta calibration', heading, text });
    const cardsElement = block.match(/<cards>([\s\S]*?)<\/cards>/);
    const lines = cardsElement ? cardsElement[1].split('\n') : [...block.matchAll(/<good>([\s\S]*?)<\/good>/g)].map(([, text]) => `cloze | ${text}`);
    const cards = lines.filter(line => /^(qa|cloze) \|/.test(line)).map(line => {
      const [kind, front, back] = line.split(' | ');
      return m.makeCard(h.id, kind === 'qa' ? { kind, front, back } : { kind, text: front });
    });
    return { h, cards, block };
  });
}

test('retired examples retain routes, procedure/explanation, subject cue and withheld unsupported reason', () => {
  const ex = examples();
  assert.equal(ex.length, 4);
  assert.deepEqual(ex.map(e => e.cards.length), [2, 2, 1, 0]);
  assert.match(ex[1].cards[0].text, /c1::disconnect power.*c2::attach the reference cable.*c3::reconnect power/);
  assert.match(ex[2].cards[0].text, /^Testosterone signalling: Type III binds/);
  assert.match(ex[3].block, /requested_target.*Why/);
  assert.match(ex[3].block, /Withhold this unsupported reason/);
  assert.match(ex[3].block, /<cards>\s*<\/cards>/);
  assert.equal([...ex[3].block.matchAll(/<good>/g)].length, 2);
});

test('each retained route fixture renders three independent reviews with its other locations visible', () => {
  const { cards } = examples()[0];
  const routes = [
    ['Pulmonary circuit route', ['right ventricle', 'lungs', 'left atrium']],
    ['Systemic circuit route', ['left ventricle', 'body', 'right atrium']],
  ];
  assert.equal(cards.length, routes.length);
  for (const [index, [label, locations]] of routes.entries()) {
    assert.equal(cards[index].kind, 'cloze');
    assert.deepEqual(m.renderedCardReviews(cards[index]), locations.map((location, hiddenIndex) => ({
      ordinal: hiddenIndex + 1,
      visibleCue: `${label}: ${locations.map((other, i) => i === hiddenIndex ? '[...]' : other).join(' → ')}.`,
      hiddenTargets: [location],
    })));
  }
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

// Actual assembled instructions keep four concise fictional example groups.
test('runtime examples cover grouping, reciprocal cues, visible relations and ordered explanations', () => {
  const groups = [...system.matchAll(/<(contrast|example)>([\s\S]*?)<\/\1>/g)].map(m => m[2]);
  assert.equal(groups.length, 4);
  for (const group of groups) {
    assert.match(group, /<highlight>/);
    assert.match(group, /<good>|<cards>/);
  }
  assert.match(groups[0], /c1::optical.*c2::acoustic/);
  assert.match(groups[1], /c2::velin.*c1::a pause/);
  assert.match(groups[2], /classification[\s\S]*amber[\s\S]*c1::green/);
  assert.match(groups[3], /c1::disconnect power.*c2::attach.*c3::reconnect/);
  assert.match(groups[3], /Why disconnect power/);
});
