import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadQuiz, harness, button, nodes, text, SOURCE } from './quizHarness.mjs';

let QuizView, pdfRuntime;
const GUIDE = 'Test affinity. Guide-only claims are not evidence.';
before(async () => {
  globalThis.window ??= globalThis;
  ({ QuizView } = await loadQuiz('src/quizView.ts', { loadPdfJs: () => pdfRuntime() }));
});
const selectAll = args => ({ selections: args.passages.map(p => ({ id: p.id, quote: p.text })), gaps: [] });
function fixture(path = 'biology/Receptors.pdf') {
  const h = harness(QuizView);
  const pdf = { path, basename: path.split('/').at(-1).replace(/\.pdf$/i, ''), extension: 'pdf', stat: { mtime: 1, size: 100 } };
  const files = [pdf, h.file];
  const reads = [], selections = [];
  const state = { ...h, pdf, files, reads, selections, destroyed: 0, beforeText: async () => {}, beforeSelection: async () => {} };
  h.host.settings = { schemaFolder: 'rules', exportFolder: 'exports' };
  h.host.app.vault.configDir = 'config';
  h.host.app.vault.getFiles = () => files;
  h.host.app.vault.getAbstractFileByPath = path => files.find(f => f.path === path) ?? null;
  h.host.app.vault.read = async file => { reads.push(file.path); return SOURCE; };
  h.host.app.vault.readBinary = async file => { reads.push(file.path); return Buffer.from('synthetic-pdf'); };
  const cache = h.host.app.metadataCache.getFileCache;
  h.host.app.metadataCache.getFileCache = file => file.extension === 'md' ? cache(file) : null;
  h.host.app.metadataCache.isUserIgnored = path => path.startsWith('ignored/');
  h.host.llm.selectStudyEvidence = async args => {
    selections.push(args); await state.beforeSelection(); return selectAll(args);
  };
  pdfRuntime = async () => ({ getDocument: () => ({ promise: Promise.resolve({
    numPages: 2,
    getPage: async n => ({ getTextContent: async () => {
      await state.beforeText(); return { items: [{ str: n === 2 ? SOURCE : '' }] };
    } }),
    destroy: async () => { state.destroyed++; },
  }) }) });
  return state;
}
async function say(h, message) {
  const box = nodes(h.root).find(n => n.tagName === 'TEXTAREA');
  assert.ok(box); box.value = message; box.events.input();
  await button(h.root, h.view.session?.current ? 'Submit answer' : 'Send').events.click();
}

test('Make Flashcards resolves and reads an explicit eligible PDF only after a fresh guide', async () => {
  const h = fixture(); await h.view.onOpen();
  await say(h, `make flashcards on ${h.pdf.path}`);
  assert.match(text(h.root), /Paste a study guide/);
  assert.deepEqual(h.reads, []); assert.deepEqual(h.selections, []); assert.deepEqual(h.calls, []);
  await say(h, GUIDE);
  assert.deepEqual(h.reads, [h.pdf.path]);
  assert.equal(h.selections.length, 1);
  assert.deepEqual(h.selections[0].passages.map(p => p.path), [h.pdf.path]);
  assert.equal(h.queued.length, 1);
  assert.equal(h.queued[0].sourcePath, h.pdf.path);
  assert.equal(h.queued[0].page, 2);
  assert.equal(h.queued[0].text, SOURCE);
  assert.equal(h.queued[0], h.rows[0]);
  assert.equal(h.queued[0].origin, 'pdf');
  assert.equal(h.queued[0].line, 0);
  assert.equal(h.queued[0].instruction, `Study topic: ${h.pdf.path}\nCoverage instructions only, not factual evidence:\n${GUIDE}\nUse only facts stated in this captured passage.`);
  assert.equal(h.view.plan.passages[0].page, 2);
  assert.equal(h.destroyed, 1);
  await say(h, `make flashcards on ${h.pdf.path}`);
  assert.match(text(h.root), /Paste a study guide/);
  assert.equal(h.selections.length, 1, 'A previous guide cannot authorize a fresh request');
});

for (const path of ['Receptors.pdf', 'biology/Receptors.pdf', 'biology/Receptors.PDF', '[[biology/Receptors.pdf]]']) {
  test(`rendered Quiz preserves exact PDF scope, page links and explicit missed-point capture: ${path}`, async () => {
    const actual = path.replace(/^\[\[|\]\]$/g, '');
    const h = fixture(actual); await h.view.onOpen();
    await say(h, `quiz me on ${path}`);
    assert.deepEqual(h.reads, []); assert.deepEqual(h.selections, []); assert.deepEqual(h.calls, []);
    await say(h, GUIDE);
    assert.deepEqual(h.reads, []); assert.deepEqual(h.selections, []);
    await button(h.root, 'Free response').events.click();
    assert.deepEqual(h.reads, [actual]);
    assert.deepEqual(h.selections[0].passages.map(p => p.path), [actual]);
    assert.deepEqual(h.calls[0][1].points, [SOURCE]);
    assert.ok(h.calls[0][1].standingInstructions.includes(GUIDE));
    const source = h.view.plan.passages[0];
    assert.equal(source.text, SOURCE); assert.equal(source.path, actual); assert.equal(source.page, 2);
    assert.equal(h.view.turns.at(-1).source, source);
    const assertPageLink = row => assert.ok(nodes(row).some(n => n.tagName === 'A' && n.options.href === `${actual}#page=2` && /page 2/.test(n.text)));
    assertPageLink(nodes(h.root).filter(n => n.classes.includes('is-assistant')).at(-1));
    await button(h.root, 'Skip').events.click();
    assert.equal(h.view.turns.at(-1).source, source);
    nodes(h.root).filter(n => n.classes.includes('is-assistant')).slice(-2).forEach(assertPageLink);
    assert.deepEqual(h.rows, []); assert.deepEqual(h.queued, []);
    await button(h.root, 'Send to Inbox').events.click();
    assert.equal(h.rows.length, 1); assert.equal(h.queued.length, 1);
    assert.equal(h.queued[0], h.rows[0]);
    assert.equal(h.rows[0].sourcePath, actual); assert.equal(h.rows[0].page, 2);
    assert.equal(h.rows[0].text, SOURCE); assert.equal(h.rows[0].line, 0);
    assert.equal(h.rows[0].instruction, `The reader missed this source point during Quiz: ${SOURCE}\nTest only this point using the captured note excerpt.`);
  });
}

function barrier() {
  let release, arrived;
  const pending = new Promise(resolve => { arrived = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  return { pending, release, pause: async () => { arrived(); await wait; } };
}
const revocations = {
  cancel: async h => { await button(h.root, 'Cancel').events.click(); },
  version: h => { h.pdf.stat.mtime++; },
  permission: h => { h.host.app.metadataCache.isUserIgnored = () => true; },
  settings: h => { h.host.settings.schemaFolder = 'biology'; },
  delete: h => { h.files.splice(0, 1); },
  identity: h => { h.files[0] = { ...h.pdf }; },
  rename: h => { h.pdf.path = 'renamed.pdf'; },
};
for (const mode of ['make flashcards', 'quiz me']) for (const stage of ['reading', 'selection']) {
  for (const [name, revoke] of Object.entries(revocations)) {
    test(`${mode} rejects PDF ${name} revocation during ${stage}`, { timeout: 2000 }, async () => {
      const h = fixture(), b = barrier(); await h.view.onOpen();
      h[stage === 'reading' ? 'beforeText' : 'beforeSelection'] = b.pause;
      await say(h, `${mode} on ${h.pdf.path}`);
      let pending;
      if (mode === 'quiz me') {
        await say(h, GUIDE); pending = button(h.root, 'Free response').events.click();
      } else pending = say(h, GUIDE);
      await b.pending;
      await revoke(h); b.release(); await pending;
      assert.equal(h.selections.length, stage === 'reading' ? 0 : 1);
      assert.deepEqual(h.calls, []);
      assert.deepEqual(h.rows, []); assert.deepEqual(h.queued, []);
      assert.equal(h.view.session, null);
      assert.equal(h.destroyed, 1);
    });
  }
}

for (const topic of ['Binding sites', '#bio', '#bio/receptors', 'biology/Receptors.md', 'affinity', 'invented-topic']) {
  test(`PDF enumeration preserves Markdown resolution and free-topic evidence rules: ${topic}`, async () => {
    const h = fixture(); await h.view.onOpen();
    await say(h, `make flashcards on ${topic}`); await say(h, GUIDE);
    if (topic === 'invented-topic') {
      assert.deepEqual(h.selections, []); assert.deepEqual(h.queued, []);
      assert.deepEqual(h.view.plan.passages, []);
    } else {
      assert.equal(h.selections.length, 1);
      assert.ok(h.selections[0].passages.every(p => p.text === SOURCE));
      if (topic !== 'affinity') assert.deepEqual(h.reads, [h.file.path]);
    }
  });
}

test('ambiguous source selection reads only the chosen exact PDF path', async () => {
  const h = fixture(); await h.view.onOpen();
  await say(h, 'make flashcards on Receptors'); await say(h, GUIDE);
  assert.deepEqual(h.reads, []); assert.deepEqual(h.selections, []);
  assert.ok(button(h.root, h.file.path)); assert.ok(button(h.root, h.pdf.path));
  await button(h.root, h.pdf.path).events.click();
  assert.deepEqual(h.reads, [h.pdf.path]);
  assert.equal(h.queued.length, 1); assert.equal(h.queued[0].sourcePath, h.pdf.path);
});

for (const stage of ['guide', 'format']) test(`cancellation before PDF ${stage} acceptance does not read or disclose`, async () => {
  const h = fixture(); await h.view.onOpen();
  await say(h, `quiz me on ${h.pdf.path}`);
  if (stage === 'format') await say(h, GUIDE);
  await button(h.root, 'Cancel').events.click();
  await say(h, GUIDE);
  assert.deepEqual(h.reads, []); assert.deepEqual(h.selections, []); assert.deepEqual(h.calls, []);
});

const unavailable = ['Missing.pdf', 'biology/Missing.pdf', 'ignored/Receptors.pdf', '.hidden/Receptors.pdf', 'biology/.hidden/Receptors.pdf', 'config/Receptors.pdf', 'rules/Receptors.pdf', 'exports/Receptors.pdf'];
for (const mode of ['make flashcards', 'quiz me']) for (const path of unavailable) {
  test(`${mode} refuses unavailable explicit PDF without aliases, suggestions or disclosure: ${path}`, async () => {
    const h = fixture(path.includes('Missing') ? `other-${path}` : path);
    h.host.app.metadataCache.getFileCache = file => file.extension === 'md' ? { frontmatter: { aliases: [path] } } : null;
    await h.view.onOpen(); await say(h, `${mode} on ${path}`); await say(h, GUIDE);
    assert.equal(h.view.target, null);
    assert.deepEqual(h.view.choices, []);
    assert.equal(button(h.root, 'Free response'), undefined);
    assert.match(text(h.root), /No eligible note or tag matched/);
    assert.deepEqual(h.reads, []); assert.deepEqual(h.selections, []); assert.deepEqual(h.calls, []);
    assert.deepEqual(h.rows, []); assert.deepEqual(h.queued, []);
  });
}
