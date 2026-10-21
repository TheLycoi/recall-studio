import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadQuiz, harness, SOURCE } from './quizHarness.mjs';

const { StudyCoordinator } = await loadQuiz('src/study.ts');
const { ChatRetriever } = await loadQuiz('src/chatRetrieval.ts');
const request = { mode: 'flashcards', topic: '#bio', guide: 'Compare mechanisms.' };
const selectAll = args => ({ selections: args.passages.map(p => ({ id: p.id, quote: p.text })), gaps: [] });

function fixture(entries = [{ path: 'A.md', text: SOURCE }]) {
  const h = harness(class {});
  const files = entries.map(e => ({ path: e.path, basename: e.path.split('/').at(-1).replace(/\.[^.]+$/, ''), extension: e.path.split('.').at(-1), stat: { mtime: 1, size: e.text.length } }));
  const reads = [], requests = [];
  h.host.settings = { schemaFolder: 'rules', exportFolder: 'exports' };
  h.host.app.vault.getFiles = () => files;
  h.host.app.vault.read = async file => { reads.push(file.path); return entries.find(e => e.path === file.path).text; };
  h.host.app.metadataCache.isUserIgnored = path => path.startsWith('ignored/');
  h.host.store.allHistory = () => h.rows;
  h.host.store.touch = () => {};
  h.host.llm.requestAuthorization = check => check;
  h.host.llm.selectStudyEvidence = async args => { requests.push(args); return selectAll(args); };
  return { ...h, files, reads, requests, coordinator: new StudyCoordinator(h.host) };
}

for (const topic of ['#bio', 'A']) test(`explicit A.md supplies exact candidates without topic, title or guide overlap: ${topic}`, async () => {
  const f = fixture([{ path: 'A.md', text: '# Heading\n\n' + SOURCE }, { path: 'other.md', text: 'Bio mechanisms belong only to the unselected note.' }]);
  const plan = await f.coordinator.prepare({ ...request, topic }, ['A.md']);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].topic, topic);
  assert.equal(f.requests[0].guide, request.guide);
  assert.deepEqual(f.reads, ['A.md']);
  assert.deepEqual(plan.passages, [{ id: '1', path: 'A.md', title: 'A', text: SOURCE, line: 3, page: null }]);
  const captured = f.coordinator.capture(plan);
  assert.equal(captured.added, 1);
  assert.equal(f.rows[0].text, SOURCE);
  assert.equal(f.rows[0].line, 2);
  assert.ok(f.rows[0].instruction.includes(`Study topic: ${topic}`));
});

for (const topic of ['Binding sites', '#bio', 'A']) test(`free-topic study still requires lexical relevance: ${topic}`, async () => {
  const f = fixture();
  const plan = await f.coordinator.prepare({ ...request, topic, guide: SOURCE });
  assert.deepEqual(f.reads, ['A.md']);
  assert.deepEqual(f.requests, [], 'Neither resolved metadata nor the guide makes a free-topic match');
  assert.deepEqual(plan.passages, []);
  assert.deepEqual(plan.gaps, [SOURCE]);
  assert.equal(f.coordinator.capture(plan).added, 0);
});

test('free-topic study still finds literal content in an insignificantly named note', async () => {
  const f = fixture();
  const plan = await f.coordinator.prepare({ ...request, topic: 'affinity' });
  assert.equal(f.requests.length, 1);
  assert.deepEqual(plan.passages.map(p => p.text), [SOURCE]);
});

const excluded = ['.hidden/A.md', '.obsidian/A.md', 'ignored/A.md', 'rules/A.md', 'exports/A.md'];
for (const paths of [[], ['missing.md'], ...excluded.map(path => [path]), ['image.png']]) test(`explicit unavailable scope never broadens: ${JSON.stringify(paths)}`, async () => {
  const f = fixture([{ path: 'other.md', text: 'Bio mechanisms match the topic but are outside scope.' }, ...excluded.map(path => ({ path, text: SOURCE })), { path: 'image.png', text: SOURCE }]);
  const plan = await f.coordinator.prepare(request, paths);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(plan.passages, []);
  assert.deepEqual(plan.gaps, [request.guide]);
  for (const path of paths) assert.ok(plan.skipped.some(s => s.includes(path)));
});

test('explicit mixed scope reads only eligible listed notes and deduplicates paths', async () => {
  const f = fixture([{ path: 'A.md', text: SOURCE }, { path: 'other.md', text: 'Bio mechanisms are outside scope.' }, ...excluded.map(path => ({ path, text: SOURCE }))]);
  const plan = await f.coordinator.prepare(request, ['A.md', 'A.md', 'missing.md', ...excluded]);
  assert.deepEqual(f.reads, ['A.md']);
  assert.deepEqual(f.requests[0].passages.map(p => p.path), ['A.md']);
  assert.deepEqual(plan.passages.map(p => p.text), [SOURCE]);
});

test('explicit scope with only headings and dividers sends no candidates', async () => {
  const f = fixture([{ path: 'A.md', text: '# Bio\n\n---\n\n' }]);
  const plan = await f.coordinator.prepare(request, ['A.md']);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(plan.passages, []);
});

test('explicit candidates still allow model refusal without substituting guide facts', async () => {
  const f = fixture();
  f.host.llm.selectStudyEvidence = async args => { f.requests.push(args); return { selections: [], gaps: [] }; };
  const plan = await f.coordinator.prepare(request, ['A.md']);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(plan.passages, []);
  assert.deepEqual(plan.gaps, [request.guide]);
  assert.equal(f.coordinator.capture(plan).added, 0);
  assert.deepEqual(f.rows, []);
});

test('explicit candidates still reject a guide-only fabricated quote', async () => {
  const f = fixture();
  f.host.llm.selectStudyEvidence = async args => ({ selections: [{ id: args.passages[0].id, quote: request.guide }], gaps: [] });
  await assert.rejects(f.coordinator.prepare(request, ['A.md']), /quote|evidence|source/i);
  assert.deepEqual(f.rows, []);
});

for (const stage of ['read', 'selection']) test(`explicit unmatched candidates retain source authorization during ${stage}`, async () => {
  const f = fixture();
  const revoke = () => { f.files[0].stat.mtime++; };
  if (stage === 'read') {
    const read = f.host.app.vault.read;
    f.host.app.vault.read = async file => { const text = await read(file); revoke(); return text; };
  } else {
    f.host.llm.selectStudyEvidence = async args => { f.requests.push(args); revoke(); return selectAll(args); };
  }
  await assert.rejects(f.coordinator.prepare(request, ['A.md']), /authorization|changed/i);
  assert.equal(f.requests.length, stage === 'read' ? 0 : 1);
  assert.deepEqual(f.rows, []);
  assert.deepEqual(f.queued, []);
});

test('explicit unmatched plan binds unsaved editor text and rejects later edits before capture', async () => {
  const f = fixture();
  let text = 'Unsaved source sentence.';
  f.editors.push({ view: { file: f.files[0], editor: { getValue: () => text } } });
  const plan = await f.coordinator.prepare(request, ['A.md']);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(plan.passages.map(p => p.text), [text]);
  text = 'Changed unsaved source sentence.';
  assert.equal(f.coordinator.current(plan), false);
  assert.throws(() => f.coordinator.capture(plan), /stale|authorization/i);
  assert.deepEqual(f.rows, []);
});

test('explicit candidates retain the 40-passage cap across sources', async () => {
  const f = fixture(Array.from({ length: 45 }, (_, i) => ({ path: `notes/${String(i).padStart(2, '0')}.md`, text: `Source sentence number ${i}.` })));
  const plan = await f.coordinator.prepare(request, f.files.map(file => file.path));
  assert.equal(f.requests[0].passages.length, 40);
  assert.equal(plan.passages.length, 40);
  assert.equal(plan.truncated, true);
  assert.deepEqual(plan.passages.map(p => p.path), f.files.slice(0, 40).map(file => file.path));
});

test('explicit candidates retain the 1200-window and 12000-context caps with exact provenance', async () => {
  const raw = '# Heading\n\n' + Array.from({ length: 20 }, (_, i) => Array.from({ length: 250 }, (_, j) => `p${i}w${j}`).join(' ')).join('\n\n');
  const f = fixture([{ path: 'A.md', text: raw }]);
  const plan = await f.coordinator.prepare(request, ['A.md']);
  const candidates = f.requests[0].passages;
  assert.ok(candidates.length <= 40);
  assert.equal(candidates.reduce((n, p) => n + p.text.length, 0), 12000);
  for (const p of candidates) {
    assert.ok(p.text.length <= 1200);
    assert.ok(raw.split('\n').slice(p.line - 1).join('\n').includes(p.text), 'Candidate remains a literal source window on its original line');
    assert.equal(p.path, 'A.md');
    assert.equal(p.page, null);
  }
  assert.equal(plan.truncated, true);
});

test('non-study retrieval keeps its relevance requirement even with explicit paths', async () => {
  const f = fixture();
  f.host.app.vault.cachedRead = f.host.app.vault.read;
  const retriever = new ChatRetriever(f.host.app, () => true);
  for (const paths of [undefined, ['A.md']]) {
    const result = await retriever.search('#bio', { paths });
    assert.deepEqual(result.seeds, []);
  }
  const matching = await retriever.search('affinity', { paths: ['A.md'] });
  assert.deepEqual(matching.seeds.map(s => s.text), [SOURCE]);
});

test('unmatched-candidate opt-in cannot remove relevance without explicit paths', async () => {
  const f = fixture();
  f.host.app.vault.cachedRead = f.host.app.vault.read;
  const retriever = new ChatRetriever(f.host.app, () => true);
  const unscoped = await retriever.search('#bio', { includeUnmatched: true });
  assert.deepEqual(unscoped.seeds, []);
  for (const paths of [[], ['missing.md']]) {
    const empty = await retriever.search('#bio', { paths, includeUnmatched: true });
    assert.deepEqual(empty.seeds, []);
  }
});
