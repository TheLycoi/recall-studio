import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadQuiz, harness, button, nodes, text, SOURCE } from './quizHarness.mjs';

let QuizView, resolveQuizTarget;
const GUIDE = 'Test the source definition. Guide-only claims are not evidence.';
before(async () => {
  ({ QuizView } = await loadQuiz());
  ({ resolveQuizTarget } = await loadQuiz('src/quizTarget.ts'));
});

function fixture(path, aliases = [path, path?.replace(/\.md$/i, '')].filter(Boolean)) {
  const h = harness(QuizView);
  const files = [h.file];
  if (path && !path.startsWith('missing/')) files.push({ ...h.file, path, basename: 'Private' });
  const reads = [], selections = [];
  h.host.settings = { schemaFolder: 'rules', exportFolder: 'exports' };
  h.host.app.vault.configDir = 'config';
  h.host.app.vault.getFiles = () => files;
  h.host.app.vault.getAbstractFileByPath = path => files.find(f => f.path === path) ?? null;
  h.host.app.vault.read = async file => { reads.push(file.path); return SOURCE; };
  const cache = h.host.app.metadataCache.getFileCache;
  h.host.app.metadataCache.getFileCache = file => file === h.file
    ? { ...cache(file), frontmatter: { ...cache(file).frontmatter, aliases: ['Binding sites', ...aliases] } }
    : null;
  h.host.app.metadataCache.isUserIgnored = path => path.startsWith('ignored/');
  h.host.llm.selectStudyEvidence = async args => {
    selections.push(args);
    return { selections: args.passages.map(p => ({ id: p.id, quote: p.text })), gaps: [] };
  };
  return { ...h, files, reads, selections };
}

async function say(h, message) {
  const box = nodes(h.root).find(n => n.tagName === 'TEXTAREA');
  assert.ok(box); box.value = message; box.events.input();
  await button(h.root, h.view.session?.current ? 'Submit answer' : 'Send').events.click();
}

async function request(h, mode, topic) {
  await h.view.onOpen();
  await say(h, `${mode} on ${topic}`);
  assert.match(text(h.root), /Paste a study guide/);
  assert.deepEqual(h.reads, []); assert.deepEqual(h.selections, []); assert.deepEqual(h.calls, []);
  await say(h, GUIDE);
}

async function assertUnavailable(h, mode, topic) {
  await request(h, mode, topic);
  const free = button(h.root, 'Free response');
  if (free) await free.events.click();
  assert.deepEqual(h.reads, [], 'An unavailable explicit path must not read an alias target');
  assert.deepEqual(h.selections, [], 'An unavailable explicit path must not disclose evidence');
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.rows, []); assert.deepEqual(h.queued, []);
  assert.equal(h.view.target, null); assert.deepEqual(h.view.choices, []);
  assert.equal(button(h.root, 'Free response'), undefined);
  assert.equal(button(h.root, 'Send to Inbox'), undefined);
  assert.match(text(h.root), /No eligible note or tag matched/);
}

const unavailable = ['missing/Private.md', 'ignored/Private.md', 'Missing.md', '.hidden/Private.md', 'biology/.hidden/Private.md', 'config/Private.md', 'rules/Private.md', 'exports/Private.md'];
for (const mode of ['quiz me', 'make flashcards']) {
  for (const path of unavailable) {
    const stem = path.replace(/\.md$/, '');
    const existing = path === 'Missing.md' ? undefined : path;
    test(`${mode} refuses unavailable Markdown path despite colliding aliases: ${path}`, async () => {
      await assertUnavailable(fixture(existing, [path, stem]), mode, path);
    });
    test(`${mode} refuses unavailable wikilink and extensionless path: ${path}`, async () => {
      await assertUnavailable(fixture(existing, [path, stem]), mode, `[[${stem.includes('/') ? stem : path}]]`);
    });
    test(`${mode} never suggests another note for unavailable path: ${path}`, async () => {
      await assertUnavailable(fixture(existing, [`Study ${stem}`]), mode, path);
    });
  }

  test(`${mode} refuses an unavailable root Markdown wikilink with inner whitespace`, async () => {
    await assertUnavailable(fixture(undefined, ['Missing']), mode, '[[Missing.md ]]');
  });

  for (const topic of ['biology//Receptors.md', './biology/Receptors.md', 'biology/../biology/Receptors.md', 'biology\\Receptors.md', '/biology/Receptors.md']) {
    test(`${mode} does not repair malformed paths or accept their aliases: ${topic}`, async () => {
      await assertUnavailable(fixture(undefined, [topic, topic.replace(/\.md$/, '')]), mode, topic);
    });
  }
}

async function assertSelected(h, mode, topic, path) {
  await request(h, mode, topic);
  assert.deepEqual(h.view.target.paths, [path]);
  await finishSelection(h, mode, path);
}

async function finishSelection(h, mode, path) {
  if (mode === 'quiz me') {
    assert.deepEqual(h.reads, []); assert.deepEqual(h.selections, []);
    await button(h.root, 'Free response').events.click();
  }
  assert.deepEqual(h.reads, [path]);
  assert.equal(h.selections.length, 1);
  assert.deepEqual(h.selections[0].passages.map(p => p.path), [path]);
  assert.equal(h.selections[0].guide, GUIDE);
  assert.ok(h.selections[0].passages.every(p => p.text === SOURCE));
  if (mode === 'quiz me') {
    assert.deepEqual(h.calls[0][1].points, [SOURCE]);
    assert.deepEqual(h.rows, []); assert.deepEqual(h.queued, []);
    await button(h.root, 'Skip').events.click();
    assert.deepEqual(h.rows, []); assert.deepEqual(h.queued, []);
    await button(h.root, 'Send to Inbox').events.click();
  }
  assert.equal(h.rows.length, 1); assert.equal(h.queued.length, 1);
  assert.equal(h.queued[0], h.rows[0]);
  assert.equal(h.rows[0].sourcePath, path); assert.equal(h.rows[0].text, SOURCE);
}

for (const mode of ['quiz me', 'make flashcards']) {
  for (const topic of ['biology/Receptors.md', 'biology/Receptors', 'BIOLOGY/RECEPTORS.MD', '[[biology/Receptors.md]]', '[[biology/Receptors]]', 'Receptors', 'Binding sites', '[[Binding sites]]', '#bio', '#bio/receptors']) {
    test(`${mode} preserves valid exact paths, names, aliases and tags: ${topic}`, async () => {
      const h = fixture();
      await assertSelected(h, mode, topic, h.file.path);
    });
  }

  test(`${mode} resolves the eligible exact path before another note's colliding alias`, async () => {
    const path = 'biology/Exact.md';
    const h = fixture(path);
    await assertSelected(h, mode, path, path);
  });

  test(`${mode} preserves root-level eligible Markdown paths`, async () => {
    const h = fixture('Root.md');
    await assertSelected(h, mode, '[[Root.md]]', 'Root.md');
  });

  for (const topic of ['Receptors', 'Binding sites', 'biology']) {
    test(`${mode} retains explicit choices for ambiguous names, aliases and suggestions: ${topic}`, async () => {
      const h = fixture();
      const other = { ...h.file, path: 'biology/Other.md', basename: topic === 'Receptors' ? 'Receptors' : 'Other' };
      h.files.push(other);
      const cache = h.host.app.metadataCache.getFileCache;
      h.host.app.metadataCache.getFileCache = file => file === other
        ? { frontmatter: { aliases: ['Binding sites'] } } : cache(file);
      await request(h, mode, topic);
      assert.equal(h.view.target, null);
      assert.deepEqual(h.view.choices.map(n => n.path), [h.file.path, other.path]);
      assert.deepEqual(h.reads, []); assert.deepEqual(h.selections, []);
      assert.deepEqual(h.calls, []); assert.deepEqual(h.rows, []); assert.deepEqual(h.queued, []);
      await button(h.root, other.path).events.click();
      await finishSelection(h, mode, other.path);
    });
  }

  test(`${mode} retains lexical retrieval for free topics`, async () => {
    const h = fixture(); await request(h, mode, 'affinity');
    assert.deepEqual(h.view.target.paths, []);
    await finishSelection(h, mode, h.file.path);
  });

  test(`${mode} does not invent evidence for an unmatched free topic`, async () => {
    const h = fixture(); await request(h, mode, 'invented-topic');
    assert.deepEqual(h.view.target.paths, []);
    if (mode === 'quiz me') await button(h.root, 'Free response').events.click();
    assert.deepEqual(h.view.plan.passages, []);
    assert.deepEqual(h.selections, []); assert.deepEqual(h.calls, []);
    assert.deepEqual(h.rows, []); assert.deepEqual(h.queued, []);
  });
}

for (const topic of ['Missing.md', 'Missing.pdf', 'missing/Private', 'missing\\Private']) {
  test(`shared resolver rejects explicit paths before alias ambiguity or suggestions: ${topic}`, () => {
    const key = topic.replace(/\.md$/, '');
    const notes = [
      { path: 'biology/One.md', name: key, aliases: [key], tags: [] },
      { path: 'biology/Two.md', name: 'Two', aliases: [key], tags: [] },
    ];
    assert.deepEqual(resolveQuizTarget(topic, notes, null), { kind: 'missing' });
    assert.deepEqual(resolveQuizTarget(topic, [notes[0]], null), { kind: 'missing' });
    assert.deepEqual(resolveQuizTarget(topic, [{ ...notes[0], name: 'One', aliases: [`Study ${key}`] }], null), { kind: 'missing' });
  });
}

test('shared resolver preserves exact eligible PDF paths and wikilinks', () => {
  const note = { path: 'biology/Receptors.pdf', name: 'Receptors', aliases: [], tags: [] };
  for (const query of [note.path, '[[BIOLOGY/RECEPTORS.PDF]]']) {
    assert.deepEqual(resolveQuizTarget(query, [note], null).paths, [note.path]);
  }
});
