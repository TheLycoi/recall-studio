import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let m;
before(async () => {
  const out = await build({ stdin: { contents: `export {Generator} from './src/generator';export {LlmClient} from './src/llm';export {makeHighlight,makeCard} from './src/model';`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'], logLevel: 'silent' });
  const mod = new Module('generation-repair');
  mod.require = id => id === 'obsidian' ? { Notice: class {}, requestUrl() { throw Error('Network forbidden'); } } : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text, 'generation-repair');
  m = mod.exports;
});

function fixture({ defect = true, legacyAudit = true, final = 'verified', repair } = {}) {
  const source = 'During Zeta sensor calibration, disconnect power before attaching the reference cable to prevent a false reading.';
  const h = m.makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Zeta calibration', text: source });
  const p = { facts: [{ id: 'F1', statement: source, quote: source }], plan: [{ id: 'P1', factIds: ['F1'], entity: 'Zeta sensor', aspect: 'calibration rationale', value: 'prevent a false reading', reason: 'A meaningful causal relationship.' }], omissions: [], exclusions: [], conflicts: [] };
  const good = { planId: 'P1', factIds: ['F1'], kind: 'qa', front: 'During Zeta sensor calibration, why disconnect power before attaching the reference cable?', back: 'to prevent a false reading', text: '' };
  const poor = { ...good, front: 'Why do this?' };
  const settings = { provider: 'codex', codexModel: 'synthetic', language: '', writerInstructions: '', historyExamples: false, critiquePass: legacyAudit, lintMode: 'badge', notifyWhenReady: false, concurrency: 1 };
  const calls = [], saves = [];
  const llm = new m.LlmClient(() => settings);
  const backend = { async complete(req) {
    calls.push(req);
    const payload = JSON.parse(req.user);
    assert.equal(h.cards.length, 0, 'all model calls precede Inbox publication');
    if (req.label === 'preparation') return req.schema.parse(p);
    if (req.label === 'grounded cards') return req.schema.parse({ cards: [defect ? poor : good] });
    if (req.label === 'generation repair') return req.schema.parse({ cards: [repair ?? good] });
    const status = req.label === 'audit' && defect ? 'failed' : final;
    return req.schema.parse({ verdicts: payload.cards.map((c, index) => ({ index, cardId: c.id, status, reason: status === 'failed' ? 'The front omits the subject and essential calibration condition; Extra does not fix the cue.' : 'Synthetic verdict, not real-model quality evidence.' })) });
  } };
  llm.codex = backend;
  const plugin = { settings, llm, store: { all: () => [h], touch() {}, async flush() { saves.push(structuredClone(h)); }, hasUnsavedChanges: false }, refreshStatusBar() {} };
  return { h, p, poor, good, settings, calls, saves, backend, llm, plugin, g: new m.Generator(plugin) };
}

for (const missing of [false, true]) for (const duplicate of [false, true]) test(`G2: ${missing ? 'missing' : 'unverified'} partial retry audits the current ${duplicate ? 'conflicting' : 'distinct'} published sibling`, async () => {
  const f = fixture({ defect: false });
  let retry = false;
  const inputs = [];
  const second = { ...f.good, planId: 'P2', front: 'During Zeta calibration, what precedes cable attachment?', back: 'disconnect power' };
  f.backend.complete = async req => {
    f.calls.push(req);
    const u = JSON.parse(req.user);
    if (req.label === 'preparation') return req.schema.parse({ ...f.p, plan: [f.p.plan[0], { ...f.p.plan[0], id: 'P2' }] });
    if (req.label === 'grounded cards') return req.schema.parse({ cards: [f.good, second] });
    if (req.label === 'generation repair') throw Error('Synthetic repair unavailable');
    inputs.push(u);
    const duplicated = u.cards.some((c, i) => u.cards.some((other, j) => i !== j && other.front === c.front) || u.existing.some(other => other.front === c.front));
    return req.schema.parse({ verdicts: u.cards.flatMap((c, index) => !retry && missing && !index ? [] : [{ index, cardId: c.id,
      status: !retry && !index ? 'unverified' : duplicated ? 'failed' : 'verified', reason: duplicated ? 'Duplicate current sibling cue' : 'Synthetic distinct cue' }]) });
  };
  await f.g.run(f.h);
  assert.equal(f.h.cards.length, 1);
  assert.equal(f.h.generation.repairs, undefined);
  const originals = structuredClone(f.h.generation.drafts);
  const sibling = f.h.cards[0];
  sibling.front = duplicate ? f.good.front : 'Zeta sensor calibration: what must happen before cable attachment?';
  sibling.edited = true; sibling.ankiNoteId = 42; sibling.extra = 'Retained annotation';
  const saved = structuredClone(sibling);
  retry = true; f.g.kick = () => {}; f.g.retry(f.h); await f.g.run(f.h);
  assert.equal(inputs.at(-1).cards.find(c => c.id === sibling.id).front, saved.front, 'audit must see the exact edited sibling');
  assert.deepEqual(sibling, saved, 'published edits and receipts are not rewritten');
  assert.deepEqual(f.h.generation.drafts, originals, 'private originals remain evidence');
  assert.equal(f.h.cards.length, duplicate ? 1 : 2);
  assert.equal(f.calls.filter(r => r.label === 'grounded cards').length, 1);
  if (duplicate) assert.match(f.h.generation.blocked[0].reasons.join(' '), /Duplicate current sibling|repair unavailable/);
  else assert.equal(f.calls.filter(r => r.label === 'generation repair').length, 0, 'a current audit does not require another writer');
});

test('G3: a procedure accepted by generation can be explicitly reworded without losing its condition', async () => {
  const f = fixture({ defect: false });
  const answer = 'disconnect the power, attach the reference cable, and reconnect power only after the indicator turns green';
  f.h.text = `Zeta sensor calibration uses this ordered procedure: ${answer}.`;
  f.p.facts[0] = { id: 'F1', statement: f.h.text, quote: f.h.text };
  f.p.plan[0].value = answer;
  f.good.front = 'During Zeta sensor calibration, what is the ordered procedure including the reconnection condition?';
  f.good.back = answer;
  await f.g.run(f.h);
  assert.equal(f.h.cards.length, 1);
  const original = structuredClone(f.h.cards[0]);
  const replacement = { ...f.good, front: 'Zeta sensor calibration: what ordered actions and reconnection condition apply?' };
  f.backend.complete = async req => {
    f.calls.push(req);
    return req.schema.parse(req.label === 'rewrite cards' ? { cards: [replacement] }
      : { preservesFacts: true, reason: 'Same complete procedure', verdicts: [{ index: 0, verdict: 'keep', reason: 'Meaningful procedural unit' }] });
  };
  const result = await f.llm.rewriteCards(f.h, f.h.cards[0], 'Keep the full procedure and condition; improve the cue.', () => true);
  assert.equal(result[0].back, answer);
  assert.equal(f.calls.at(-1).label, 'rewrite audit');
  assert.equal(JSON.parse(f.calls.at(-1).user).cards[0].checks[0].id, 'qa-answer-long');
  assert.deepEqual(f.h.cards[0], original, 'client validation does not mutate the original before the caller commits');
});

test('source-grounded context repair is private, bounded and independently rechecked before publication', async () => {
  const f = fixture();
  await f.g.run(f.h);
  assert.deepEqual(f.calls.map(r => r.label), ['preparation', 'grounded cards', 'audit', 'generation repair', 'final audit']);
  assert.equal(f.h.status, 'ready');
  assert.equal(f.h.cards[0].front, f.good.front);
  assert.equal(f.h.cards[0].generation.audit.status, 'verified');
  assert.equal(f.h.cards[0].edited, false);
  assert.equal(f.h.generation.drafts[0].front, f.poor.front, 'retain the original');
  assert.equal(f.h.generation.repairs[0].candidate.id, f.h.generation.drafts[0].id, 'stable identity');
  assert.equal(f.h.generation.phase, 'complete');
  if (process.env.RECALL_PROMPT_EVIDENCE_DIR) {
    mkdirSync(process.env.RECALL_PROMPT_EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(process.env.RECALL_PROMPT_EVIDENCE_DIR, 'context-repair-requests.json'), JSON.stringify(f.calls.map(({ label, system, user, retryInvalidResponse }) => ({ label, system, user: JSON.parse(user), retryInvalidResponse })), null, 2));
  }
  const request = f.calls.find(r => r.label === 'generation repair');
  const payload = JSON.parse(request.user);
  assert.equal(payload.captured, f.h.text);
  assert.deepEqual(payload.preparation, f.p);
  assert.match(JSON.stringify(payload), /Extra does not fix/);
  for (const label of ['grounded cards', 'generation repair', 'final audit']) {
    const req = f.calls.find(r => r.label === label);
    assert.match(req.system, /one meaningful retrieval target/i);
    assert.match(req.system, /front.*subject.*conditions/i);
    assert.match(req.system, /Extra.*source link.*not/i);
    assert.match(req.system, /causal relationships.*short procedures/i);
    assert.match(req.system, /word.*product polic/i);
    assert.equal(req.retryInvalidResponse, false);
    assert.equal(typeof req.authorized, 'function');
  }
});

test('legacy disabled critique cannot bypass independent generation auditing', async () => {
  const f = fixture({ defect: false, legacyAudit: false });
  await f.g.run(f.h);
  assert.deepEqual(f.calls.map(r => r.label), ['preparation', 'grounded cards', 'audit']);
  assert.equal(f.h.cards[0].generation.audit.status, 'verified');
});

for (const failure of ['missing', 'duplicate', 'provider']) test(`${failure} final verdict holds the original and candidate outside Inbox`, async () => {
  const f = fixture();
  const complete = f.backend.complete;
  f.backend.complete = async req => {
    if (req.label !== 'final audit') return complete(req);
    f.calls.push(req);
    if (failure === 'provider') throw Error('synthetic unavailable');
    const c = JSON.parse(req.user).cards[0];
    const v = { index: 0, cardId: c.id, status: 'verified', reason: 'Synthetic.' };
    return req.schema.parse({ verdicts: failure === 'missing' ? [] : [v, v] });
  };
  await f.g.run(f.h);
  assert.equal(f.h.cards.length, 0);
  assert.equal(f.h.generation.phase, 'blocked');
  assert.equal(f.h.generation.blocked.length, 1);
  assert.equal(f.h.generation.drafts[0].front, f.poor.front);
  assert.equal(f.h.generation.repairs[0].candidate.front, f.good.front);
  const count = f.calls.length;
  await new m.Generator(f.plugin).run(f.h);
  assert.equal(f.calls.length, count, 'restart never silently repeats paid work');
});

for (const defect of ['unsupported', 'leak', 'malformed']) test(`positive model cannot publish ${defect} replacement`, async () => {
  const f = fixture({ repair: { planId: 'P1', factIds: ['F1'], kind: 'cloze', front: '', back: '', text: defect === 'unsupported' ? 'Zeta calibration prevents {{c1::supernovae}}.' : defect === 'leak' ? 'Zeta calibration prevents {{c1::a false reading}} (a false reading).' : 'Zeta prevents {{c1::a false reading}.' } });
  await f.g.run(f.h);
  assert.equal(f.h.cards.length, 0);
  assert.equal(f.h.generation.phase, 'blocked');
  assert.equal(f.calls.filter(r => r.label === 'generation repair').length, 1);
  assert.ok(f.h.generation.blocked[0].reasons.length);
  assert.equal(f.h.generation.drafts[0].front, f.poor.front);
});

test('explicit retry retains identity and original while authorizing one new repair attempt', async () => {
  const f = fixture({ final: 'failed' });
  await f.g.run(f.h);
  assert.equal(f.h.cards.length, 0);
  const id = f.h.generation.drafts[0].id;
  const complete = f.backend.complete;
  f.backend.complete = async req => req.label.includes('audit') ? (f.calls.push(req), req.schema.parse({ verdicts: JSON.parse(req.user).cards.map((c, index) => ({ index, cardId: c.id, status: 'verified', reason: 'Synthetic retry.' })) })) : req.label === 'generation repair' ? (f.calls.push(req), req.schema.parse({ cards: [{ ...f.good, front: 'Zeta sensor calibration: why disconnect power before attaching the reference cable?' }] })) : complete(req);
  f.g.kick = () => {};
  f.g.retry(f.h);
  await f.g.run(f.h);
  assert.equal(f.h.cards[0].id, id);
  assert.equal(f.calls.filter(r => r.label === 'preparation').length, 1);
  assert.equal(f.calls.filter(r => r.label === 'generation repair').length, 2);
  assert.equal(f.h.generation.repairs.length, 2);
});


for (const action of ['settings', 'sibling']) test(`${action} change during initial rules read prevents disclosure`, async () => {
  const f = fixture({ defect: false });
  const context = f.llm.generationContext.bind(f.llm);
  let first = true;
  f.llm.generationContext = async (...args) => {
    const result = await context(...args);
    if (first) {
      first = false;
      if (action === 'settings') f.settings.writerInstructions = 'Changed during rules read';
      else f.h.cards.push(m.makeCard(f.h.id, { kind: 'qa', front: 'Other current cue', back: 'Other answer' }));
    }
    return result;
  };
  await f.g.run(f.h);
  assert.equal(f.calls.length, 0);
  assert.equal(f.h.status, 'error');
});

for (const stage of ['generation repair', 'final audit']) for (const action of ['stop', 'source', 'rules', 'settings', 'sibling', 'archive', 'delete']) test(`${action} during ${stage} blocks stale acceptance and later dispatch`, async () => {
  const f = fixture();
  const complete = f.backend.complete;
  f.backend.complete = async req => {
    const result = await complete(req);
    if (req.label === stage) {
      if (action === 'stop') f.g.stop();
      else if (action === 'source') f.h.text += ' Changed';
      else if (action === 'rules') f.llm.getSchema = async () => ({ cards: 'Changed rules' });
      else if (action === 'settings') f.settings.writerInstructions = 'Changed rules';
      else if (action === 'sibling') f.h.cards.push(m.makeCard(f.h.id, { kind: 'qa', front: 'New sibling', back: 'New user answer' }));
      else if (action === 'archive') f.h.archived = true;
      else f.plugin.store.all = () => [];
    }
    return result;
  };
  await f.g.run(f.h);
  assert.equal(f.h.cards.filter(c => c.generation).length, 0);
  assert.equal(f.calls.at(-1).label, stage);
});

test('final audit includes unchanged siblings and can hold a newly interfering repair', async () => {
  const f = fixture();
  const complete = f.backend.complete;
  f.backend.complete = async req => {
    if (req.label === 'preparation') {
      const p = structuredClone(f.p);
      p.plan.push({ ...p.plan[0], id: 'P2', aspect: 'procedure', reason: 'A separate procedural target.' });
      f.calls.push(req);
      return req.schema.parse(p);
    }
    if (req.label === 'grounded cards') {
      f.calls.push(req);
      return req.schema.parse({ cards: [f.poor, { ...f.good, planId: 'P2', front: 'During Zeta calibration, what must happen before attaching the reference cable?', back: 'disconnect power' }] });
    }
    if (req.label === 'audit' || req.label === 'final audit') {
      f.calls.push(req);
      const payload = JSON.parse(req.user);
      assert.equal(payload.cards.length, 2, 'audit all candidates, not only the repair');
      return req.schema.parse({ verdicts: payload.cards.map((c, index) => ({ index, cardId: c.id, status: index === 0 ? 'failed' : 'verified', reason: index === 0 ? req.label === 'final audit' ? 'Repair now interferes with unchanged sibling' : 'Missing context' : 'Synthetic clean sibling' })) });
    }
    return complete(req);
  };
  await f.g.run(f.h);
  assert.equal(f.calls.filter(r => r.label === 'generation repair').length, 1);
  assert.equal(f.h.cards.length, 1);
  assert.equal(f.h.cards[0].generation.planId, 'P2');
  assert.equal(f.h.generation.phase, 'blocked');
  assert.match(f.h.generation.blocked[0].reasons.join(' '), /interferes/);
});

test('a saved repair response survives failed checkpoint and reload without another paid request', async () => {
  const f = fixture();
  let fail = true;
  f.plugin.store.flush = async () => { if (fail && f.h.generation?.repairs?.[0]?.candidate) throw Error('synthetic disk full'); };
  await f.g.run(f.h);
  assert.equal(f.h.cards.length, 0);
  const id = f.h.generation.drafts[0].id;
  assert.equal(f.calls.filter(r => r.label === 'generation repair').length, 1);
  Object.assign(f.h, JSON.parse(JSON.stringify(f.h)));
  fail = false;
  await new m.Generator(f.plugin).run(f.h);
  assert.equal(f.calls.filter(r => r.label === 'generation repair').length, 1);
  assert.equal(f.h.cards[0].id, id);
});

for (const stage of ['preparation', 'grounded cards', 'generation repair', 'final audit']) test(`unknown ${stage} outcome is not automatically repeated on restart`, async () => {
  const f = fixture();
  const complete = f.backend.complete;
  f.backend.complete = async req => {
    const result = await complete(req);
    if (req.label === stage) f.g.stop();
    return result;
  };
  await f.g.run(f.h);
  await new m.Generator(f.plugin).run(f.h);
  assert.equal(f.calls.filter(r => r.label === stage).length, 1);
  assert.equal(f.h.cards.length, 0);
});


test('explicit partial retry checks current published sibling wording without rewriting it', async () => {
  const f = fixture();
  let phase = 'first';
  f.backend.complete = async req => {
    f.calls.push(req);
    const payload = JSON.parse(req.user);
    if (req.label === 'preparation') return req.schema.parse({ ...f.p, plan: [f.p.plan[0], { ...f.p.plan[0], id: 'P2' }] });
    if (req.label === 'grounded cards') return req.schema.parse({ cards: [f.poor, { ...f.good, planId: 'P2' }] });
    if (req.label === 'generation repair') {
      if (phase === 'retry') assert.ok(payload.existing.some(c => c.front === 'New user sibling wording'), 'repair sees the current sibling');
      return req.schema.parse({ cards: [{ ...f.good, ...(phase === 'retry' ? { front: 'Zeta sensor calibration: why disconnect power before attaching the reference cable?' } : {}) }] });
    }
    if (phase === 'retry') assert.ok(payload.cards.some(c => c.front === 'New user sibling wording'), 'final audit sees the current sibling');
    return req.schema.parse({ verdicts: payload.cards.map((c, index) => ({ index, cardId: c.id, status: phase === 'first' && index === 0 ? 'failed' : 'verified', reason: 'Synthetic test verdict.' })) });
  };
  await f.g.run(f.h);
  assert.equal(f.h.cards.length, 1);
  const sibling = f.h.cards[0];
  sibling.front = 'New user sibling wording';
  sibling.edited = true;
  const saved = structuredClone(sibling);
  phase = 'retry';
  f.g.kick = () => {};
  f.g.retry(f.h);
  await f.g.run(f.h);
  assert.equal(f.h.cards.length, 2);
  assert.deepEqual(f.h.cards.find(c => c.id === sibling.id), saved);
});


test('changed inputs on restart cannot silently repeat an unknown paid writer outcome', async () => {
  const f = fixture();
  const complete = f.backend.complete;
  f.backend.complete = async req => {
    const result = await complete(req);
    if (req.label === 'grounded cards') f.g.stop();
    return result;
  };
  await f.g.run(f.h);
  f.settings.writerInstructions = 'New wording after interruption';
  await new m.Generator(f.plugin).run(f.h);
  assert.equal(f.calls.filter(r => r.label === 'grounded cards').length, 1);
  assert.equal(f.calls.filter(r => r.label === 'preparation').length, 1);
  assert.equal(f.h.cards.length, 0);
  assert.match(f.h.error, /unknown.*explicit retry/i);
});


for (const kind of ['qa', 'cloze']) test(`independent adjudication can retain a meaningful ${kind} procedure beyond a product word cap`, async () => {
  const f = fixture({ defect: false });
  const answer = 'disconnect the power, attach the reference cable, and reconnect power only after the indicator turns green';
  f.h.text = `Zeta sensor calibration uses this ordered procedure: ${answer}.`;
  f.p.facts[0] = { id: 'F1', statement: f.h.text, quote: f.h.text };
  f.p.plan[0].value = answer;
  f.p.plan[0].aspect = 'ordered procedure';
  f.good.front = 'During Zeta sensor calibration, what is the short ordered procedure, including the reconnection condition?';
  f.good.back = answer;
  if (kind === 'cloze') Object.assign(f.good, { kind, front: '', back: '', text: `Zeta sensor calibration: {{c1::${answer}}}.` });
  await f.g.run(f.h);
  assert.equal(kind === 'qa' ? f.h.cards[0].back : f.h.cards[0].text, kind === 'qa' ? answer : f.good.text, 'do not shorten away the sequence or essential condition');
  assert.equal(f.h.cards[0].generation.audit.status, 'verified');
  assert.equal(f.calls.filter(r => r.label === 'generation repair').length, 0);
  const audit = f.calls.find(r => r.label === 'audit');
  const finding = JSON.parse(audit.user).cards[0].checks.find(check => check.id === (kind === 'qa' ? 'qa-answer-long' : 'cloze-framing')).finding;
  assert.match(finding, /product policy/);
  assert.match(finding, /causal relationships.*short procedures/);
  assert.match(audit.system, /adjudicate.*length-policy/i);
});


test('an unchanged rejected draft cannot become ready through a later positive verdict', async () => {
  const f = fixture();
  const complete = f.backend.complete;
  f.backend.complete = async req => req.label === 'generation repair' ? (f.calls.push(req), req.schema.parse({ cards: [f.poor] })) : complete(req);
  await f.g.run(f.h);
  assert.equal(f.h.cards.length, 0);
  assert.equal(f.h.generation.phase, 'blocked');
  assert.match(f.h.generation.blocked[0].reasons.join(' '), /did not change/i);
});


test('explicit retry of an unavailable final audit reuses the saved successful repair', async () => {
  const f = fixture();
  const complete = f.backend.complete;
  let unavailable = true;
  f.backend.complete = async req => {
    if (req.label === 'final audit' && unavailable) { f.calls.push(req); throw Error('synthetic final checker unavailable'); }
    return complete(req);
  };
  await f.g.run(f.h);
  assert.equal(f.h.generation.phase, 'blocked');
  unavailable = false;
  f.g.kick = () => {};
  f.g.retry(f.h);
  await f.g.run(f.h);
  assert.equal(f.h.cards.length, 1);
  assert.equal(f.calls.filter(r => r.label === 'generation repair').length, 1, 'saved successful repair must not be requested again');
  assert.equal(f.calls.filter(r => r.label === 'final audit').length, 2);
});


test('a stale repair exposes retained draft count and reasons for source-level retry', async () => {
  const f = fixture();
  const complete = f.backend.complete;
  f.backend.complete = async req => {
    const result = await complete(req);
    if (req.label === 'generation repair') f.h.text += ' Changed source';
    return result;
  };
  await f.g.run(f.h);
  assert.equal(f.h.cards.length, 0);
  assert.equal(f.h.generation.phase, 'blocked');
  assert.equal(f.h.generation.blocked[0].cardId, f.h.generation.drafts[0].id);
  assert.ok(f.h.generation.blocked[0].reasons.length);
});


test('explicit retry independently audits a legacy private draft and clears stale lint metadata', async () => {
  const f = fixture({ defect: false });
  await f.g.run(f.h);
  f.h.cards = [];
  f.h.generation.committed = false;
  f.h.generation.phase = 'auditing';
  delete f.h.generation.audit.contents;
  f.h.generation.drafts[0].lintFailures = ['qa-answer-long'];
  f.h.generation.drafts[0].critiqueReason = 'An obsolete draft finding';
  f.h.status = 'error';
  f.g.kick = () => {};
  f.g.retry(f.h);
  await f.g.run(f.h);
  assert.equal(f.calls.filter(r => r.label === 'audit').length, 2);
  assert.equal(f.calls.filter(r => r.label === 'generation repair').length, 0);
  assert.equal(f.h.cards.length, 1);
  assert.equal(f.h.cards[0].lintFailures, undefined);
  assert.equal(f.h.cards[0].critiqueReason, undefined);
});
