import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadQuiz, harness, nodes, button, text, SOURCE } from './quizHarness.mjs';

let QuizView, runtime;
before(async () => { ({ QuizView } = await loadQuiz('src/quizView.ts', { loadPdfJs: async () => runtime })); });
const bytes = () => new TextEncoder().encode('%PDF-1.7\nsynthetic unit fixture').buffer;
const file = (name = 'Exam review.pdf', overrides = {}) => ({ name, type: 'application/pdf', size: bytes().byteLength, arrayBuffer: async () => bytes(), ...overrides });
async function say(h, message) { h.view.draftQuestion = message; await h.view.ask(); }
async function setup(pages = ['Cover affinity.', 'Guide-only unicorns bind receptors.']) {
  const h = harness(QuizView);
  h.selections = []; h.reads = 0; h.parses = 0; h.destroyed = 0;
  const read = h.host.app.vault.read;
  h.host.app.vault.read = async (...args) => { h.reads++; return read(...args); };
  h.host.llm.selectStudyEvidence = async args => {
    h.selections.push(args);
    return { selections: args.passages.map(p => ({ id: p.id, quote: p.text })), gaps: [] };
  };
  h.doc = {
    numPages: pages.length,
    getMetadata: async () => ({ info: { EncryptFilterName: null } }),
    getPage: async n => ({ getTextContent: async () => ({ items: [{ str: pages[n - 1], hasEOL: false }] }) }),
  };
  runtime = { getDocument: () => { h.parses++; return { promise: Promise.resolve(h.doc), destroy: async () => { h.destroyed++; } }; } };
  await h.view.onOpen();
  return h;
}
function input(h) { return nodes(h.root).find(n => n.tagName === 'INPUT' && n.options.attr?.type === 'file'); }
async function pick(h, selected = file()) {
  const field = input(h); assert.ok(field, 'coverage prompt must render a file input');
  field.click = () => {};
  await button(h.root, 'Attach PDF').events.click();
  field.files = selected ? [selected] : [];
  await field.events.change();
}

test('PDF-only coverage uses the rendered picker and Send without importing or supplying answer evidence', async () => {
  const h = await setup();
  assert.equal(input(h), undefined);
  await say(h, 'quiz me on affinity');
  assert.equal(input(h).options.attr.accept, '.pdf,application/pdf');
  assert.equal(input(h).options.attr['aria-label'], 'Attach coverage PDF');
  await pick(h);
  assert.match(text(h.root), /Exam review\.pdf/);
  assert.match(text(h.root), /2 pages/);
  assert.match(text(h.root), /coverage only/i);
  assert.match(text(h.root), /configured model/i);
  assert.equal(h.reads, 0); assert.equal(h.selections.length, 0);
  assert.deepEqual(h.rows, []); assert.deepEqual(h.queued, []);
  await button(h.root, 'Send').events.click();
  assert.ok(button(h.root, 'Free response'));
  assert.equal(h.view.guide, 'Cover affinity.\n\nGuide-only unicorns bind receptors.');
  await button(h.root, 'Free response').events.click();
  assert.equal(h.selections.length, 1);
  assert.equal(h.selections[0].guide, h.view.guide);
  assert.deepEqual(h.calls[0][1].points, [SOURCE]);
  assert.doesNotMatch(JSON.stringify(h.selections[0].passages), /unicorns|Exam review/);
  assert.deepEqual(h.rows, []); assert.deepEqual(h.queued, []);
  await button(h.root, 'Skip').events.click();
  await button(h.root, 'Send to Inbox').events.click();
  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0].sourcePath, h.file.path);
  assert.equal(h.rows[0].text, SOURCE);
  assert.doesNotMatch(JSON.stringify(h.rows[0]), /unicorns|Exam review/);
  assert.equal(h.destroyed, 1);
});

function deferred() {
  let resolve; const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

test('typed instructions precede PDF coverage and a new quiz requires a fresh attachment', async () => {
  const h = await setup(); await say(h, 'quiz me on affinity'); await pick(h);
  await say(h, 'Focus on definitions.');
  assert.equal(h.view.guide, 'Focus on definitions.\n\nCover affinity.\n\nGuide-only unicorns bind receptors.');
  assert.equal(h.view.guidePdf, null);
  await say(h, 'quiz me on affinity');
  assert.equal(h.view.guide, ''); assert.equal(h.view.guidePdf, null);
  await button(h.root, 'Send').events.click();
  assert.equal(button(h.root, 'Free response'), undefined);
  assert.equal(h.selections.length, 0);
});

test('a PDF can exceed the Chat limit and reach the exact combined guide boundary intact', async () => {
  const guide = 'g'.repeat(64000);
  const h = await setup([guide]); await say(h, 'quiz me on affinity'); await pick(h);
  await button(h.root, 'Send').events.click();
  assert.equal(h.view.guide, guide);
  await button(h.root, 'Free response').events.click();
  assert.equal(h.selections[0].guide, guide);
  assert.ok(h.calls[0][1].standingInstructions.includes(guide));
});

test('combined overflow preserves both inputs and sends nothing until corrected', async () => {
  const guide = 'g'.repeat(63999);
  const h = await setup([guide]); await say(h, 'quiz me on affinity'); await pick(h);
  await say(h, 'x');
  assert.equal(h.view.draftQuestion, 'x'); assert.equal(h.view.guidePdf.text, guide);
  assert.match(text(h.root), /combined coverage within 64000/);
  assert.equal(h.reads, 0); assert.equal(h.selections.length, 0);
  assert.equal(button(h.root, 'Free response'), undefined);
  h.view.draftQuestion = ''; await button(h.root, 'Send').events.click();
  assert.equal(h.view.guide, guide);
});

test('mixed blank pages are disclosed before submitting, and image-only PDFs cannot start a quiz', async () => {
  const h = await setup(['', 'Cover affinity.', '']); await say(h, 'quiz me on affinity'); await pick(h);
  assert.match(text(h.root), /Pages without selectable text were not read: 1, 3/);
  assert.equal(h.selections.length, 0);
  await button(h.root, 'Remove PDF').events.click();
  h.doc.numPages = 1; h.doc.getPage = async () => ({ getTextContent: async () => ({ items: [] }) });
  await pick(h);
  assert.match(text(h.root), /no selectable text.*OCR/i);
  await button(h.root, 'Send').events.click();
  assert.equal(button(h.root, 'Free response'), undefined);
});

test('removal and cancelled selection preserve a newer typed draft', async () => {
  const h = await setup(); await say(h, 'quiz me on affinity'); await pick(h);
  const box = nodes(h.root).find(n => n.tagName === 'TEXTAREA');
  box.value = 'Keep this newer draft'; box.events.input();
  await pick(h, null);
  assert.equal(h.view.guidePdf.name, 'Exam review.pdf');
  await button(h.root, 'Remove PDF').events.click();
  assert.equal(h.view.guidePdf, null);
  assert.equal(nodes(h.root).find(n => n.tagName === 'TEXTAREA').value, 'Keep this newer draft');
  assert.equal(h.selections.length, 0);
});

for (const operation of ['remove', 'cancel', 'restart', 'close', 'replace']) {
  test(`pending extraction cannot restore stale state after ${operation}`, async () => {
    const h = await setup(); await say(h, 'quiz me on affinity');
    const gate = deferred(), entered = deferred();
    const pending = pick(h, file('Old.pdf', { arrayBuffer: () => { entered.resolve(); return gate.promise; } }));
    await entered.promise;
    assert.equal(button(h.root, 'Send').disabled, true);
    const box = nodes(h.root).find(n => n.tagName === 'TEXTAREA');
    box.value = 'newer draft'; box.events.input();
    if (operation === 'remove') await button(h.root, 'Remove PDF').events.click();
    if (operation === 'cancel') await button(h.root, 'Cancel').events.click();
    if (operation === 'restart') await say(h, 'quiz me on Receptors');
    if (operation === 'close') await h.view.onClose();
    if (operation === 'replace') await pick(h, file('New.pdf'));
    await pending;
    const snapshot = { draft: h.view.draftQuestion, guide: h.view.guide, attachment: h.view.guidePdf, status: text(h.root), parses: h.parses };
    gate.resolve(bytes()); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual({ draft: h.view.draftQuestion, guide: h.view.guide, attachment: h.view.guidePdf, status: text(h.root), parses: h.parses }, snapshot);
    assert.equal(h.view.pdfRead, null); assert.equal(h.reads, 0); assert.equal(h.selections.length, 0);
    assert.deepEqual(h.rows, []); assert.deepEqual(h.queued, []);
    if (operation === 'replace') assert.equal(h.view.guidePdf.name, 'New.pdf');
    else assert.equal(h.view.guidePdf, null);
    if (operation !== 'restart') assert.equal(h.view.draftQuestion, 'newer draft');
  });
}

test('an old file-picker event cannot attach into a new quiz or undo removal', async () => {
  const h = await setup(); await say(h, 'quiz me on affinity');
  const old = input(h); old.files = [file('Stale.pdf')];
  await say(h, 'quiz me on Receptors'); await old.events.change();
  assert.equal(h.parses, 0); assert.equal(h.view.guidePdf, null);
  await pick(h); const another = input(h); another.files = [file('Stale.pdf')];
  await button(h.root, 'Remove PDF').events.click(); await another.events.change();
  assert.equal(h.view.guidePdf, null); assert.equal(h.parses, 1);
});

test('attachment completion preserves typing done while parsing and source refreshes', async () => {
  const h = await setup(); await say(h, 'quiz me on affinity');
  const gate = deferred(), entered = deferred();
  h.doc.getPage = async () => { entered.resolve(); await gate.promise; return { getTextContent: async () => ({ items: [{ str: 'Cover affinity.' }] }) }; };
  const pending = pick(h); await entered.promise;
  const box = nodes(h.root).find(n => n.tagName === 'TEXTAREA'); box.value = 'Keep newer text'; box.events.input();
  h.view.refreshSources(); gate.resolve(); await pending;
  assert.equal(nodes(h.root).find(n => n.tagName === 'TEXTAREA').value, 'Keep newer text');
  assert.equal(button(h.root, 'Send').disabled, false);
  assert.equal(h.selections.length, 0);
});

test('invalid replacement discards the previous PDF rather than silently sending it', async () => {
  const h = await setup(); await say(h, 'quiz me on affinity'); await pick(h);
  await pick(h, file('Not a PDF.txt', { type: 'text/plain' }));
  assert.equal(h.view.guidePdf, null); assert.match(text(h.root), /Choose a PDF file/);
  assert.ok(nodes(h.root).some(n => n.options.attr?.role === 'alert'));
  await button(h.root, 'Send').events.click(); assert.equal(button(h.root, 'Free response'), undefined);
  assert.equal(h.reads, 0); assert.equal(h.selections.length, 0);
});

test('pasted coverage uses the guide budget without widening ordinary Chat messages', async () => {
  const h = await setup(); await say(h, 'quiz me on affinity');
  const guide = 'g'.repeat(64000);
  await say(h, guide); assert.equal(h.view.guide, guide);
  assert.ok(button(h.root, 'Free response'));
  await button(h.root, 'Cancel').events.click();
  await say(h, 'x'.repeat(8001));
  assert.match(text(h.root), /Keep the message within 8000 characters; it has not been truncated or sent/);
  assert.equal(h.view.draftQuestion.length, 8001);
});

test('Make Flashcards keeps its typed-guide flow without the PDF control', async () => {
  const h = await setup(); await say(h, 'Make flashcards on affinity');
  assert.equal(input(h), undefined); assert.equal(button(h.root, 'Attach PDF'), undefined);
  await say(h, 'Cover the definition.'); assert.equal(h.rows[0].text, SOURCE);
});
