import { afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadQuiz } from './quizHarness.mjs';

let StudyCoordinator, STUDY_GUIDE_MAX_CHARS, STUDY_MESSAGE_MAX_CHARS, validateStudyInput, LlmClient, InboxStore, Generator;
let transport, pdfRuntime;
const stores = [];
before(async () => {
  globalThis.window ??= globalThis;
  ({ StudyCoordinator, STUDY_GUIDE_MAX_CHARS, STUDY_MESSAGE_MAX_CHARS } = await loadQuiz('src/study.ts', { loadPdfJs: () => pdfRuntime() }));
  ({ validateStudyInput } = await loadQuiz('src/studySchemas.ts'));
  ({ LlmClient } = await loadQuiz('src/llm.ts', { requestUrl: req => transport(req) }));
  ({ InboxStore } = await loadQuiz('src/store.ts', { normalizePath: path => path }));
  ({ Generator } = await loadQuiz('src/generator.ts'));
});
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const selectAll = args => ({ selections: args.passages.map(p => ({ id: p.id, quote: p.text })), gaps: [] });
const request = (mode = 'flashcards') => ({ mode, topic: 'dormancy', guide: 'Cover the timing of germination.' });
function fixture(entries = [{ path: 'notes/lecture.md', text: 'Introduction.\n\nDormancy delays germination.' }]) {
  const files = entries.map(e => ({ path: e.path, basename: e.path.split('/').at(-1).replace(/\.[^.]+$/, ''), extension: e.path.split('.').at(-1), stat: { mtime: 1, size: (e.text ?? '').length } }));
  const queued = [], calls = [], reads = [], editors = [];
  const host = {
    settings: { schemaFolder: 'rules', exportFolder: 'exports', provider: 'deepseek', deepseekApiKey: 'synthetic-test-key', deepseekModel: 'synthetic-model', effort: 'low' },
    app: {
      vault: {
        configDir: 'config', getFiles: () => files,
        read: async file => { reads.push(file.path); return entries.find(e => e.path === file.path).text; },
        readBinary: async file => { reads.push(file.path); return Buffer.from(JSON.stringify({ pages: entries.find(e => e.path === file.path).pdf })); },
      },
      metadataCache: { isUserIgnored: path => path.startsWith('ignored/') },
      workspace: { getLeavesOfType: () => editors },
    },
  };
  host.store = new InboxStore(host.app, 'rules'); stores.push(host.store);
  const rows = host.store.allHistory();
  host.generator = new Generator(host);
  void host.generator.stop(); // Queue contract only; never start background card writing in a fixture.
  const enqueue = host.generator.enqueue.bind(host.generator);
  host.generator.enqueue = h => { queued.push(h); enqueue(h); };
  host.llm = new LlmClient(() => host.settings);
  const coordinator = new StudyCoordinator(host);
  const state = { coordinator, host, files, entries, rows, queued, calls, reads, editors, reply: selectAll, pdfOpened: 0, pdfDestroyed: 0, beforePdfLoad: async () => {}, beforePdfText: async () => {} };
  pdfRuntime = async () => {
    await state.beforePdfLoad();
    return { getDocument: ({ data }) => {
      const spec = JSON.parse(Buffer.from(data).toString()); state.pdfOpened++;
      return { promise: Promise.resolve({
        numPages: spec.pages.length,
        getPage: async n => ({ getTextContent: async () => { await state.beforePdfText(); return { items: [{ str: spec.pages[n - 1] }] }; } }),
        destroy: async () => { state.pdfDestroyed++; },
      }) };
    } };
  };
  transport = async req => {
    const args = JSON.parse(JSON.parse(req.body).messages[1].content);
    calls.push(args);
    const value = await state.reply(args);
    return { status: 200, json: { choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] } };
  };
  return state;
}
function barrier() {
  let release, arrived;
  const pending = new Promise(resolve => { arrived = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  return { pending, release, pause: async () => { arrived(); await wait; } };
}
const revocations = {
  cancel: f => f.coordinator.cancel(),
  settings: f => { f.host.settings.schemaFolder = 'notes'; },
  'file-version': f => { f.files[0].stat.mtime++; },
  'file-identity': f => { f.files[0] = { ...f.files[0] }; },
  'file-rename': f => { f.files[0].path = 'renamed.md'; },
  'file-delete': f => { f.files.length = 0; },
  'new-unsaved-editor': f => { f.editors.push({ view: { file: f.files[0], editor: { getValue: () => 'Private unsaved change.' } } }); },
  'client-cancel': f => { void f.host.llm.abort(); },
};
for (const [name, revoke] of Object.entries(revocations)) {
  test(`revocation during source read blocks selection: ${name}`, async () => {
    const f = fixture(), b = barrier();
    const read = f.host.app.vault.read;
    f.host.app.vault.read = async file => { const text = await read(file); await b.pause(); return text; };
    const pending = f.coordinator.prepare(request());
    await b.pending;
    revoke(f); b.release();
    await assert.rejects(pending, /stale|changed|authorization|cancel/i);
    assert.deepEqual(f.calls, [], 'No model disclosure after source authorization expires');
    assert.deepEqual(f.rows, []);
  });
  test(`revocation during selection rejects its result: ${name}`, async () => {
    const f = fixture(), b = barrier();
    f.reply = async args => { await b.pause(); return selectAll(args); };
    const pending = f.coordinator.prepare(request());
    await b.pending;
    revoke(f); b.release();
    await assert.rejects(pending, /stale|changed|authorization|cancel/i);
    assert.equal(f.calls.length, 1, 'No retry after authorization expires');
    assert.deepEqual(f.rows, []);
  });
}
test('exclusions apply before reads, even for explicit paths, with honest skipped coverage', async () => {
  const entries = ['.hidden/a.md', 'ignored/a.md', 'config/a.md', 'rules/a.md', 'exports/a.md', 'notes/lecture.md', 'image.png'].map(path => ({ path, text: 'Dormancy delays germination.' }));
  const f = fixture(entries);
  const plan = await f.coordinator.prepare(request(), entries.map(e => e.path).concat('missing.md'));
  assert.deepEqual(f.reads, ['notes/lecture.md']);
  assert.equal(plan.passages.length, 1);
  for (const entry of entries.filter(e => e.path !== 'notes/lecture.md')) assert.ok(plan.skipped.some(s => s.includes(entry.path)), entry.path);
  assert.ok(plan.skipped.some(s => s.includes('missing.md')));
  assert.equal(plan.truncated, true);
});
test('unsaved text is the source and conflicting open editors skip the note without disclosure', async () => {
  const f = fixture();
  let text = 'Dormancy is an unsaved note fact.';
  f.editors.push({ view: { file: f.files[0], editor: { getValue: () => text } } });
  const plan = await f.coordinator.prepare(request());
  assert.equal(plan.passages[0].text, text);
  assert.deepEqual(f.reads, []);
  text = 'Dormancy changed without a disk timestamp.';
  assert.equal(f.coordinator.current(plan), false);
  f.editors.push({ view: { file: f.files[0], editor: { getValue: () => 'Conflicting text.' } } });
  f.calls.length = 0;
  const conflict = await f.coordinator.prepare(request());
  assert.deepEqual(conflict.passages, []);
  assert.match(conflict.skipped.join('\n'), /conflicting editors/);
  assert.deepEqual(f.calls, []);
});
test('coverage above the Chat limit passes the real coordinator and model-input validator intact', async () => {
  const f = fixture();
  const guide = 'Cover dormancy.\n' + 'g'.repeat(7985);
  assert.equal(guide.length, 8001);
  assert.doesNotThrow(() => validateStudyInput({ ...request(), guide, passages: [], authorized: () => true }));
  const plan = await f.coordinator.prepare({ ...request(), guide });
  assert.equal(STUDY_MESSAGE_MAX_CHARS, 8000);
  assert.equal(STUDY_GUIDE_MAX_CHARS, 64000);
  assert.equal(plan.request.guide, guide);
  assert.deepEqual(f.calls[0].guide, [{ n: 1, text: 'Cover dormancy.' }, { n: 2, text: 'g'.repeat(7985) }]);
  assert.deepEqual(plan.passages, f.calls[0].passages);
});
test('the exact 64000-character guide reaches selection transport and capture without clipping', async () => {
  const f = fixture();
  const tail = '\nFinal-page coverage goal';
  const guide = 'Cover dormancy.\n'.padEnd(64000 - tail.length, 'g') + tail;
  assert.equal(guide.length, 64000);
  assert.doesNotThrow(() => validateStudyInput({ ...request(), guide, passages: [], authorized: () => true }));
  const plan = await f.coordinator.prepare({ ...request(), guide });
  assert.equal(plan.request.guide, guide);
  assert.deepEqual(f.calls[0].guide, guide.split('\n').map((text, i) => ({ n: i + 1, text })));
  f.coordinator.capture(plan);
  assert.ok(f.queued[0].instruction.includes(guide));
  assert.equal(f.queued[0].text, 'Dormancy delays germination.');
});
test('64001 characters are rejected before vault enumeration, reads or model dispatch', async () => {
  const f = fixture();
  let enumerations = 0;
  f.host.app.vault.getFiles = () => { enumerations++; return f.files; };
  const guide = 'g'.repeat(64001);
  const args = { ...request(), guide, passages: [], authorized: () => true };
  assert.throws(() => validateStudyInput(args), /Invalid study topic, guide or authorization\./);
  await assert.rejects(f.host.llm.selectStudyEvidence(args), /Invalid study topic, guide or authorization\./);
  await assert.rejects(f.coordinator.prepare({ ...request(), guide }), { message: 'Study guide exceeds 64000 characters.' });
  assert.equal(enumerations, 0);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.rows, []);
  assert.deepEqual(f.queued, []);
});
test('a long coverage guide stays instructions and never supplies source or captured factual text', async () => {
  const f = fixture();
  const claim = 'Dormancy always promotes immediate germination. Guide-only unicorns power seeds.';
  const guide = `Cover dormancy.\n${claim}\n`.padEnd(8001, 'g');
  const plan = await f.coordinator.prepare({ ...request(), guide });
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].guide.some(line => line.text === claim));
  assert.deepEqual(plan.passages, [{ id: '1', path: 'notes/lecture.md', title: 'lecture', text: 'Dormancy delays germination.', line: 3, page: null }]);
  f.coordinator.capture(plan);
  assert.equal(f.rows.length, 1);
  assert.equal(f.queued[0], f.rows[0]);
  assert.equal(f.rows[0].text, 'Dormancy delays germination.');
  assert.equal(f.rows[0].sourcePath, 'notes/lecture.md');
  assert.equal(f.rows[0].sourceTitle, 'lecture');
  assert.ok(f.rows[0].instruction.includes(`Coverage instructions only, not factual evidence:\n${guide}\nUse only facts stated in this captured passage.`));
  assert.doesNotMatch(JSON.stringify(f.calls[0].passages), /unicorns|promotes immediate/);
});
for (const id of ['1', 'guide-only']) test(`a long guide cannot supply a selected quote or source ID: ${id}`, async () => {
  const f = fixture();
  const claim = 'Dormancy always promotes immediate germination.';
  const guide = `${claim}\n`.padEnd(8001, 'g');
  f.reply = () => ({ selections: [{ id, quote: claim }], gaps: [] });
  await assert.rejects(f.coordinator.prepare({ ...request(), guide }), /study.*quote|selection ID/i);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.rows, []);
  assert.deepEqual(f.queued, []);
});
test('empty topic/oversized guide are errors, while no matches and model refusal create no evidence', async () => {
  const f = fixture();
  await assert.rejects(f.coordinator.prepare({ ...request(), topic: '' }), /topic/i);
  await assert.rejects(f.coordinator.prepare({ ...request(), guide: 'x'.repeat(STUDY_GUIDE_MAX_CHARS + 1) }), /guide.*exceeds/i);
  const none = await f.coordinator.prepare({ ...request(), topic: 'absentword', guide: 'Dormancy: facts only in this guide.' });
  assert.deepEqual(none.passages, []);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(none.gaps, ['Dormancy: facts only in this guide.']);
  f.reply = () => ({ selections: [], gaps: [] });
  const refusal = await f.coordinator.prepare(request());
  assert.deepEqual(refusal.passages, []);
  assert.deepEqual(refusal.gaps, [request().guide]);
});
test('selection validates exact note quotes, retains their source passages and reports guide gaps', async () => {
  const f = fixture();
  f.reply = args => {
    return { selections: [{ id: args.passages[0].id, quote: 'delays germination.' }], gaps: [2] };
  };
  const plan = await f.coordinator.prepare({ ...request(), guide: 'Cover dormancy.\nCover invented guide-only fact.' });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(plan.passages, [f.calls[0].passages[0]]);
  assert.equal(plan.passages[0].text, 'Dormancy delays germination.');
  assert.deepEqual(plan.gaps, ['Cover invented guide-only fact.']);
});

for (const draft of [
  { selections: [{ id: 'invented', quote: 'Dormancy delays germination.' }], gaps: [] },
  { selections: [{ id: '1', quote: 'A fact only in the guide.' }], gaps: [] },
  { selections: [{ id: '1', quote: 'Dormancy delays germination.' }, { id: '1', quote: 'Dormancy delays germination.' }], gaps: [] },
  { selections: [], gaps: [99] },
  { selections: [], gaps: [1, 1] },
  { selections: [{ id: '1', quote: 'Dormancy  delays germination.' }], gaps: [] },
  { selections: [{ id: '1', quote: ' ' }], gaps: [] },
  { selections: [], gaps: [], advice: 'Add outside facts.' },
  { selections: 'malformed', gaps: [] },
]) test(`rejects malformed or ungrounded selection ${JSON.stringify(draft)}`, async () => {
  const f = fixture();
  f.reply = () => draft;
  await assert.rejects(f.coordinator.prepare(request()), /study|selection|evidence|gap/i);
  assert.deepEqual(f.rows, []);
});

for (const [name, revoke] of Object.entries(revocations)) test(`capture preflight rejects ${name} without writes`, async () => {
  const f = fixture();
  const plan = await f.coordinator.prepare(request());
  revoke(f);
  assert.equal(f.coordinator.current(plan), false);
  assert.throws(() => f.coordinator.capture(plan), /stale|authorization/i);
  assert.deepEqual(f.rows, []);
  assert.deepEqual(f.queued, []);
});
test('capture refuses forged, mutated, old, foreign and quiz plans', async () => {
  const f = fixture();
  const plan = await f.coordinator.prepare(request());
  assert.equal(f.coordinator.current(structuredClone(plan)), false);
  assert.throws(() => f.coordinator.capture(structuredClone(plan)), /stale/i);
  const other = new StudyCoordinator(f.host);
  assert.equal(other.current(plan), false);
  assert.throws(() => other.capture(plan), /stale/i);
  plan.passages[0].text = 'Fabricated fact.';
  assert.equal(f.coordinator.current(plan), false);
  assert.throws(() => f.coordinator.capture(plan), /stale/i);
  const old = await f.coordinator.prepare(request());
  const quiz = await f.coordinator.prepare(request('quiz'));
  assert.equal(f.coordinator.current(old), false);
  assert.throws(() => f.coordinator.capture(old), /stale/i);
  assert.throws(() => f.coordinator.capture(quiz), /flashcard/i);
  assert.deepEqual(f.rows, []);
});
test('an archived duplicate, even with no live cards, is retained without regeneration', async () => {
  const f = fixture();
  const old = { id: 'archived', archived: true, status: 'dismissed', sourcePath: 'notes/lecture.md', text: 'Dormancy delays germination.', cards: [], instruction: 'Do not change me.' };
  f.rows.push(old);
  assert.deepEqual(f.host.store.all(), []);
  assert.equal(f.host.store.hasDuplicate(old.sourcePath, old.text), false);
  const before = structuredClone(old);
  const plan = await f.coordinator.prepare(request());
  assert.deepEqual(f.coordinator.capture(plan), { added: 0, duplicates: 1, highlightIds: ['archived'] });
  assert.deepEqual(f.rows, [before]);
  assert.deepEqual(f.queued, []);
});
test('preflight checks every source before the first capture write', async () => {
  const f = fixture([{ path: 'a.md', text: 'Dormancy delays germination.' }, { path: 'b.md', text: 'Dormancy postpones growth.' }]);
  const plan = await f.coordinator.prepare(request());
  f.files[1].stat.mtime++;
  assert.throws(() => f.coordinator.capture(plan), /stale/i);
  assert.deepEqual(f.rows, []);
});
test('new prepare supersedes a pending model response, even if the new request is invalid', async () => {
  const f = fixture(), b = barrier();
  f.reply = async args => { await b.pause(); return selectAll(args); };
  const pending = f.coordinator.prepare(request());
  await b.pending;
  await assert.rejects(f.coordinator.prepare({ ...request(), guide: '' }), /guide/);
  b.release();
  await assert.rejects(pending, /authorization/i);
});
test('capture queues exact evidence once through draft highlights without altering old records', async () => {
  const f = fixture();
  const existing = { id: 'old', sourcePath: 'other.md', text: 'Keep old history', cards: [{ id: 'card', status: 'exported', schedule: { due: 'retained' } }], instruction: 'old instructions' };
  f.rows.push(existing);
  const before = structuredClone(existing);
  const plan = await f.coordinator.prepare(request());
  const result = f.coordinator.capture(plan);
  assert.equal(result.added, 1);
  assert.equal(result.duplicates, 0);
  assert.deepEqual(result.highlightIds, [f.queued[0].id]);
  const h = f.queued[0];
  assert.equal(h.text, plan.passages[0].text);
  assert.equal(h.sourcePath, plan.passages[0].path);
  assert.equal(h.sourceTitle, 'lecture');
  assert.equal(h.line, 2, 'One-based evidence line becomes zero-based highlight line');
  assert.equal(h.status, 'queued');
  assert.deepEqual(h.cards, []);
  assert.match(h.instruction, /dormancy/);
  assert.ok(h.instruction.includes(request().guide));
  assert.deepEqual(existing, before);
  const retry = f.coordinator.capture(plan);
  assert.equal(retry.added, 0);
  assert.equal(retry.duplicates, 1);
  assert.equal(f.queued.length, 1);
});

test('text-bearing PDF evidence keeps the actual page and queues through the existing generator', async () => {
  const f = fixture([{ path: 'sources/lecture.pdf', pdf: ['Cover.', 'Dormancy delays germination.'] }]);
  const plan = await f.coordinator.prepare(request());
  assert.equal(plan.passages.length, 1);
  assert.equal(plan.passages[0].page, 2);
  assert.equal(plan.passages[0].text, 'Dormancy delays germination.');
  assert.equal(f.pdfOpened, 1);
  assert.equal(f.pdfDestroyed, 1);
  f.coordinator.capture(plan);
  assert.equal(f.queued[0].page, 2);
  assert.equal(f.queued[0].line, 0);
  assert.equal(f.queued[0].origin, 'pdf');
});
test('PDF substring selection keeps the original qualified passage and page on capture', async () => {
  const quote = 'dormancy always promotes germination.';
  const passage = `The lecture explicitly states that it is false that ${quote}`;
  const f = fixture([{ path: 'sources/lecture.pdf', pdf: ['Cover.', passage] }]);
  f.reply = args => ({ selections: [{ id: args.passages[0].id, quote }], gaps: [] });
  const plan = await f.coordinator.prepare(request());
  assert.deepEqual(plan.passages, f.calls[0].passages);
  f.coordinator.capture(plan);
  assert.equal(f.queued.length, 1);
  assert.equal(f.queued[0].text, passage);
  assert.equal(f.queued[0].sourcePath, 'sources/lecture.pdf');
  assert.equal(f.queued[0].page, 2);
  assert.equal(f.queued[0].line, 0);
  assert.equal(f.queued[0].origin, 'pdf');
});
for (const stage of ['load', 'page']) test(`cancelling PDF ${stage} setup blocks later reads or disclosure and releases documents`, async () => {
  const f = fixture([{ path: 'sources/lecture.pdf', pdf: ['Dormancy delays germination.'] }]), b = barrier();
  f[stage === 'load' ? 'beforePdfLoad' : 'beforePdfText'] = b.pause;
  const pending = f.coordinator.prepare(request());
  await b.pending;
  f.coordinator.cancel(); b.release();
  await assert.rejects(pending, /authorization/i);
  assert.deepEqual(f.calls, []);
  if (stage === 'load') assert.deepEqual(f.reads, []);
  else assert.equal(f.pdfDestroyed, 1);
});
test('image-only, unsupported, unreadable and over-limit sources report skips instead of inventing evidence', async () => {
  const f = fixture([{ path: 'scan.pdf', pdf: [''] }, { path: 'long.md', text: 'Dormancy ' + 'x'.repeat(100001) }, { path: 'broken.md', text: undefined }, { path: 'image.png' }]);
  const plan = await f.coordinator.prepare(request());
  assert.deepEqual(plan.passages, []);
  assert.deepEqual(f.calls, []);
  for (const path of ['scan.pdf', 'long.md', 'broken.md', 'image.png']) assert.ok(plan.skipped.some(s => s.includes(path)));
  assert.deepEqual(f.coordinator.capture(plan), { added: 0, duplicates: 0, highlightIds: [] });
  assert.equal(f.pdfDestroyed, 1);
});
test('an empty explicit scope cannot widen retrieval', async () => {
  const f = fixture();
  const plan = await f.coordinator.prepare(request(), []);
  assert.deepEqual(plan.passages, []);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.calls, []);
});
test('plan gap text can never contain generated advice or instructions', async () => {
  const f = fixture();
  f.reply = () => ({ selections: [], gaps: ['Use outside knowledge to explain growth.'] });
  await assert.rejects(f.coordinator.prepare(request()), /study evidence|study.*schema/i);
  assert.deepEqual(f.rows, []);
});
test('overlapping selected windows retain original context and distinct occurrences on the same line', async () => {
  const text = 'Dormancy delays germination.';
  const f = fixture([{ path: 'notes/long.md', text: 'dormancy ' + 'a'.repeat(1000) + ' ' + text + 'b'.repeat(1400) + ' ' + text + 'c'.repeat(1000) }]);
  f.reply = args => ({ selections: args.passages.filter(p => p.text.includes(text)).map(p => ({ id: p.id, quote: text })), gaps: [] });
  const plan = await f.coordinator.prepare(request());
  const candidates = f.calls[0].passages.filter(p => p.text.includes(text));
  assert.deepEqual(plan.passages, candidates, 'Distinct bounded windows retain their context even if their selected quotes overlap');
  assert.equal(candidates.length, 3, 'The first occurrence appears in two overlapping windows');
  const occurrenceStarts = new Set(plan.passages.map(p => f.entries[0].text.indexOf(p.text) + p.text.indexOf(text)));
  assert.equal(occurrenceStarts.size, 2, 'Both original quote occurrences remain represented');
  assert.ok(plan.passages.every(p => p.line === 1));
  assert.ok(f.calls[0].passages.length > 2, 'Overlap must actually be exercised');
});
test('a caller-supplied toJSON cannot hide mutated evidence from preflight', async () => {
  const f = fixture();
  const plan = await f.coordinator.prepare(request());
  const original = structuredClone(plan);
  plan.passages[0].text = 'Guide-only invented fact.';
  plan.toJSON = () => original;
  assert.equal(f.coordinator.current(plan), false);
  assert.throws(() => f.coordinator.capture(plan), /stale/i);
  assert.deepEqual(f.rows, []);
});
test('revocation in a store callback cannot enqueue the just-added capture', async () => {
  const f = fixture();
  const plan = await f.coordinator.prepare(request());
  f.host.store.onChange(() => f.coordinator.cancel());
  assert.throws(() => f.coordinator.capture(plan), /authorization/i);
  assert.deepEqual(f.queued, []);
  assert.equal(f.rows[0].status, 'error');
});
test('an observed mutation permanently invalidates the plan, even if its text is restored', async () => {
  const f = fixture();
  const plan = await f.coordinator.prepare(request());
  const original = plan.passages[0].text;
  plan.passages[0].text = 'Forged';
  assert.equal(f.coordinator.current(plan), false);
  plan.passages[0].text = original;
  assert.equal(f.coordinator.current(plan), false);
});
test('duplicate source text at distinct lines stays in the plan but queues only one capture', async () => {
  const f = fixture([{ path: 'a.md', text: 'Dormancy delays germination.\n\nDormancy delays germination.' }]);
  const plan = await f.coordinator.prepare(request());
  assert.equal(plan.passages.length, 2);
  assert.deepEqual(plan.passages.map(p => p.line), [1, 3]);
  const captured = f.coordinator.capture(plan);
  assert.equal(captured.added, 1);
  assert.equal(captured.duplicates, 1);
  assert.equal(f.rows.length, 1);
});
test('source revalidation does not enumerate the vault once per snapshot for each eligibility check', async () => {
  const f = fixture(Array.from({ length: 25 }, (_, i) => ({ path: `n${i}.md`, text: 'Dormancy delays germination.' })));
  let enumerations = 0;
  f.host.app.vault.getFiles = () => { enumerations++; return f.files; };
  await f.coordinator.prepare(request());
  assert.ok(enumerations < 500, `Vault enumerations must scale with reads, not reads cubed: ${enumerations}`);
});
test('undefined optional folders still exclude the default plugin-managed paths', async () => {
  const f = fixture([{ path: 'Review Inbox/card-rules.md', text: 'Dormancy rule-only facts.' }]);
  f.host.settings.schemaFolder = undefined;
  f.host.settings.exportFolder = undefined;
  const plan = await f.coordinator.prepare(request());
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(plan.passages, []);
  assert.match(plan.skipped.join('\n'), /excluded/);
});
test('excluded and out-of-scope open editors are never read', async () => {
  const f = fixture([{ path: 'notes/lecture.md', text: 'Dormancy delays germination.' }, { path: 'ignored/private.md', text: 'Private facts.' }, { path: 'other.md', text: 'Other facts.' }]);
  for (const file of f.files.slice(1)) f.editors.push({ view: { file, editor: { getValue() { assert.fail(`Must not read editor: ${file.path}`); } } } });
  const plan = await f.coordinator.prepare(request(), ['notes/lecture.md']);
  assert.equal(plan.passages.length, 1);
  assert.deepEqual(f.reads, ['notes/lecture.md']);
});
test('retrieval delegates vault enumeration with the original host receiver', async () => {
  const f = fixture();
  f.host.app.vault.getFiles = function () { assert.equal(this, f.host.app.vault); return f.files; };
  const plan = await f.coordinator.prepare(request());
  assert.equal(plan.passages.length, 1);
});
test('a fresh required guide accompanies a topic found inside a differently named note', async () => {
  const f = fixture();
  await assert.rejects(f.coordinator.prepare({ ...request(), guide: '  ' }), /guide/i);
  const plan = await f.coordinator.prepare(request());
  assert.equal(plan.passages.length, 1);
  assert.equal(plan.passages[0].path, 'notes/lecture.md');
  assert.equal(plan.passages[0].text, 'Dormancy delays germination.');
  assert.equal(plan.passages[0].line, 3);
  assert.equal(plan.passages[0].page, null);
});
