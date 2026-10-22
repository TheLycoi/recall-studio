import test from 'node:test';
import assert from 'node:assert/strict';
import { loadQuiz } from './quizHarness.mjs';

const ENTRY = 'src/studyGuidePdf.ts';
const bytes = () => new TextEncoder().encode('%PDF-1.7\nsynthetic test bytes').buffer;
const file = (overrides = {}) => ({ name: 'Review.pdf', type: 'application/pdf', size: bytes().byteLength, arrayBuffer: async () => bytes(), ...overrides });
const item = (str, hasEOL = false) => ({ str, hasEOL });
async function setup(pages = [[item('First topic')], [item('Later topic')]], overrides = {}) {
  const calls = { load: 0, parse: [], pages: [], text: [], destroy: 0 };
  const doc = {
    numPages: pages.length,
    getMetadata: async () => ({ info: { EncryptFilterName: null } }),
    getPage: async n => {
      calls.pages.push(n);
      return { getTextContent: async () => { calls.text.push(n); return { items: pages[n - 1] }; } };
    },
    destroy: () => task.destroy(),
    ...overrides.doc,
  };
  const task = { promise: Promise.resolve(doc), destroy: async () => { calls.destroy++; }, ...overrides.task };
  const pdfjs = { getDocument: options => { calls.parse.push(options); return task; }, ...overrides.pdfjs };
  const api = await loadQuiz(ENTRY, { loadPdfJs: async () => { calls.load++; return pdfjs; }, ...overrides.host });
  return { api, calls, doc, task, pdfjs };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function promptly(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('operation did not settle promptly')), 250); })]);
  } finally { clearTimeout(timer); }
}

test('does not return a stale result when cancellation wins during successful cleanup', async () => {
  const { api, calls, task } = await setup();
  const controller = new AbortController();
  task.destroy = async () => { calls.destroy++; queueMicrotask(() => controller.abort()); };
  await assert.rejects(api.readStudyGuidePdf(file(), 100, controller.signal), { name: 'AbortError', message: 'PDF reading was cancelled.' });
  assert.equal(calls.destroy, 1);
});

test('aborts before reading bytes and does not disclose the caller abort reason', async () => {
  const { api, calls } = await setup();
  const controller = new AbortController();
  controller.abort(new Error('PRIVATE reason /Users/private'));
  let reads = 0;
  await assert.rejects(api.readStudyGuidePdf(file({ arrayBuffer: async () => { reads++; return bytes(); } }), 100, controller.signal), error => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.message, 'PDF reading was cancelled.');
    return true;
  });
  assert.equal(reads, 0);
  assert.equal(calls.load, 0);
});

test('aborts promptly at pending async boundaries without resuming stale work', async t => {
  for (const stage of ['read', 'load', 'parse', 'metadata', 'page', 'text', 'destroy']) await t.test(stage, async () => {
    const entered = deferred(), gate = deferred();
    let pdfjs;
    const pending = () => { entered.resolve(); return gate.promise; };
    const h = await setup(undefined, stage === 'load' ? { host: { loadPdfJs: pending } } : {});
    pdfjs = h.pdfjs;
    const { api, calls, task, doc } = h;
    let input = file();
    let lateValue;
    if (stage === 'read') { input = file({ arrayBuffer: pending }); lateValue = bytes(); }
    if (stage === 'load') lateValue = pdfjs;
    if (stage === 'parse') { Object.defineProperty(task, 'promise', { get: pending }); lateValue = doc; }
    if (stage === 'metadata') { doc.getMetadata = pending; lateValue = { info: { EncryptFilterName: null } }; }
    if (stage === 'page') { doc.getPage = n => { calls.pages.push(n); return pending(); }; lateValue = { getTextContent: async () => { calls.text.push(1); return { items: [item('STALE')] }; } }; }
    if (stage === 'text') { doc.getPage = async n => { calls.pages.push(n); return { getTextContent: () => { calls.text.push(n); return pending(); } }; }; lateValue = { items: [item('STALE')] }; }
    if (stage === 'destroy') task.destroy = () => { calls.destroy++; return pending(); };
    const controller = new AbortController();
    const result = api.readStudyGuidePdf(input, 100, controller.signal);
    const rejected = assert.rejects(result, error => {
      assert.equal(error.name, 'AbortError');
      assert.equal(error.message, 'PDF reading was cancelled.');
      return true;
    });
    await promptly(entered.promise);
    controller.abort(new Error('PRIVATE reason'));
    try { await promptly(rejected); } finally { gate.resolve(lateValue); }
    const snapshot = structuredClone(calls);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, snapshot);
    assert.equal(calls.destroy, ['read', 'load'].includes(stage) ? 0 : 1);
  });
});

test('uses local byte data with eval, resource fetching, fonts, XFA, and recovery disabled', async () => {
  const forbidden = () => { throw new Error('must not render or execute PDF content'); };
  const { api, calls } = await setup(undefined, { doc: { getJSActions: forbidden, getJavaScript: forbidden, getAttachments: forbidden } });
  await api.readStudyGuidePdf(file(), 100);
  const options = calls.parse[0];
  assert.equal(options.isEvalSupported, false);
  assert.equal(options.useWorkerFetch, false);
  assert.equal(options.useWasm, false);
  assert.equal(options.disableFontFace, true);
  assert.equal(options.enableXfa, false);
  assert.equal(options.stopAtErrors, true);
  for (const field of ['url', 'docBaseUrl', 'cMapUrl', 'standardFontDataUrl', 'wasmUrl', 'iccUrl']) assert.ok(!options[field]);
});

test('sanitizes failures at each native or file boundary and always releases created tasks', async t => {
  const secret = 'PRIVATE contents at /Users/private/Review.pdf';
  for (const stage of ['read', 'load', 'getDocument', 'parse', 'metadata', 'page', 'text', 'destroy']) await t.test(stage, async () => {
    const { api, calls, pdfjs, doc, task } = await setup();
    const fail = () => { throw new Error(secret); };
    let input = file();
    if (stage === 'read') input = file({ arrayBuffer: fail });
    if (stage === 'load') {
      // The host accessor is the actual platform boundary.
      const isolated = await setup(undefined, { host: { loadPdfJs: fail } });
      await assert.rejects(isolated.api.readStudyGuidePdf(input, 100), error => {
        assert.ok(error instanceof isolated.api.StudyGuidePdfError);
        assert.equal(error.message, 'The PDF could not be read. Try another PDF with selectable text.');
        return true;
      });
      return;
    }
    if (stage === 'getDocument') pdfjs.getDocument = fail;
    if (stage === 'parse') task.promise = Promise.reject(new Error(secret));
    if (stage === 'metadata') doc.getMetadata = async () => { throw new Error(secret); };
    if (stage === 'page') doc.getPage = fail;
    if (stage === 'text') doc.getPage = async () => ({ getTextContent: fail });
    if (stage === 'destroy') task.destroy = async () => { calls.destroy++; throw new Error(secret); };
    await assert.rejects(api.readStudyGuidePdf(input, 100), error => {
      assert.ok(error instanceof api.StudyGuidePdfError);
      assert.equal(error.message, 'The PDF could not be read. Try another PDF with selectable text.');
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls.destroy, ['read', 'getDocument'].includes(stage) ? 0 : 1);
  });
});

test('rejects encrypted PDFs without exposing the parser error or requesting a password', async () => {
  const { api, calls, task } = await setup();
  task.promise = Promise.reject(Object.assign(new Error('secret encrypted content'), { name: 'PasswordException' }));
  await assert.rejects(api.readStudyGuidePdf(file(), 100), error => {
    assert.ok(error instanceof api.StudyGuidePdfError);
    assert.equal(error.message, 'Encrypted PDFs are not supported. Choose an unencrypted PDF.');
    return true;
  });
  assert.deepEqual(calls.pages, []);
  assert.equal(calls.destroy, 1);
});

test('rejects encryption even when the PDF opens without a password', async () => {
  const { api, calls } = await setup(undefined, { doc: { getMetadata: async () => ({ info: { EncryptFilterName: 'Standard' } }) } });
  await assert.rejects(api.readStudyGuidePdf(file(), 100), error => {
    assert.ok(error instanceof api.StudyGuidePdfError);
    assert.equal(error.message, 'Encrypted PDFs are not supported. Choose an unencrypted PDF.');
    return true;
  });
  assert.deepEqual(calls.pages, []);
  assert.equal(calls.destroy, 1);
});

test('reports one-indexed empty pages without claiming image-only content was read', async () => {
  const { api, calls } = await setup([[], [item('Selectable topic')], [item('  \n')]]);
  assert.deepEqual(await api.readStudyGuidePdf(file(), 100), {
    name: 'Review.pdf', text: '\n\nSelectable topic\n\n', pages: 3, emptyPages: [1, 3],
  });
  assert.deepEqual(calls.pages, [1, 2, 3]);
  assert.equal(calls.destroy, 1);
});

test('rejects wholly image-only or blank documents with a no-OCR message', async () => {
  const { api, calls } = await setup([[], [item(' \n')]]);
  await assert.rejects(api.readStudyGuidePdf(file(), 100), error => {
    assert.ok(error instanceof api.StudyGuidePdfError);
    assert.match(error.message, /no selectable text.*image-only.*OCR/i);
    return true;
  });
  assert.equal(calls.destroy, 1);
});

test('rejects invalid or over-limit page counts before extracting any page', async t => {
  for (const count of [201, 0, -1, NaN, 1.5]) await t.test(`pages ${count}`, async () => {
    const { api, calls } = await setup(undefined, { doc: { numPages: count } });
    await assert.rejects(api.readStudyGuidePdf(file(), 100), error => {
      assert.ok(error instanceof api.StudyGuidePdfError);
      assert.match(error.message, count > 200 ? /200 pages/ : /could not be read/);
      return true;
    });
    assert.deepEqual(calls.pages, []);
    assert.equal(calls.destroy, 1);
  });
});

test('reads exactly 200 pages within the text budget', async () => {
  const { api, calls } = await setup(Array.from({ length: 200 }, () => [item('x')]));
  const result = await api.readStudyGuidePdf(file(), 598);
  assert.equal(result.pages, 200);
  assert.equal(result.text.length, 598);
  assert.equal(calls.pages.length, 200);
});

test('rejects text overflow during extraction without clipping or reading later pages', async () => {
  const { api, calls } = await setup([[item('abc'), item('def')], [item('later')]]);
  await assert.rejects(api.readStudyGuidePdf(file(), 6), /text exceeds.*6 characters/);
  assert.deepEqual(calls.pages, [1]);
  assert.equal(calls.destroy, 1);
});

test('counts separators for empty pages before extracting beyond the text budget', async () => {
  const { api, calls } = await setup([[item('a')], []]);
  await assert.rejects(api.readStudyGuidePdf(file(), 1), /text exceeds.*1 characters/);
  assert.deepEqual(calls.pages, [1]);
  assert.equal(calls.destroy, 1);
});

test('includes line and page separators in the exact text budget', async () => {
  const { api } = await setup([[item('a', true), item('b')], [item('c')]]);
  assert.equal((await api.readStudyGuidePdf(file(), 6)).text, 'a\nb\n\nc');
  await assert.rejects(api.readStudyGuidePdf(file(), 5), /text exceeds.*5 characters/);
});

test('checks actual bytes and PDF signature before native parsing', async t => {
  for (const [name, data, message] of [
    ['actual oversize', new ArrayBuffer(20 * 1024 * 1024 + 1), /20 MiB/],
    ['actual empty', new ArrayBuffer(0), /empty/],
    ['mislabeled contents', new TextEncoder().encode('<html>Not a PDF</html>').buffer, /could not be read/],
  ]) await t.test(name, async () => {
    const { api, calls } = await setup();
    await assert.rejects(api.readStudyGuidePdf(file({ arrayBuffer: async () => data }), 100), error => {
      assert.ok(error instanceof api.StudyGuidePdfError);
      assert.match(error.message, message);
      return true;
    });
    assert.equal(calls.load, 0);
    assert.equal(calls.parse.length, 0);
  });
});

test('accepts actual bytes exactly at the byte ceiling', async () => {
  const { api, calls } = await setup();
  const data = new Uint8Array(api.PDF_GUIDE_MAX_BYTES);
  data.set(new TextEncoder().encode('%PDF-1.7\n'));
  await api.readStudyGuidePdf(file({ size: data.byteLength, arrayBuffer: async () => data.buffer }), 100);
  assert.equal(calls.parse[0].data.byteLength, api.PDF_GUIDE_MAX_BYTES);
});

test('validates file metadata and the caller budget before reading bytes or loading PDF.js', async t => {
  const cases = [
    ['wrong extension', { name: 'Review.txt' }, 100, /Choose a PDF file/],
    ['wrong MIME', { type: 'text/plain' }, 100, /Choose a PDF file/],
    ['too large', { size: 20 * 1024 * 1024 + 1 }, 100, /20 MiB/],
    ['empty', { size: 0 }, 100, /empty/],
    ['negative size', { size: -1 }, 100, /could not be read/],
    ['invalid size', { size: NaN }, 100, /could not be read/],
    ...[0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1].map(n => [`budget ${n}`, {}, n, /text limit/]),
  ];
  for (const [name, metadata, maxChars, message] of cases) await t.test(name, async () => {
    const { api, calls } = await setup();
    let reads = 0;
    await assert.rejects(api.readStudyGuidePdf(file({ ...metadata, arrayBuffer: async () => { reads++; return bytes(); } }), maxChars), error => {
      assert.ok(error instanceof api.StudyGuidePdfError);
      assert.match(error.message, message);
      return true;
    });
    assert.equal(reads, 0);
    assert.equal(calls.load, 0);
    assert.equal(calls.parse.length, 0);
  });
});

test('accepts an empty OS MIME and case-insensitive PDF extension at the declared byte ceiling', async () => {
  const { api } = await setup();
  assert.equal(api.PDF_GUIDE_MAX_BYTES, 20 * 1024 * 1024);
  assert.equal(api.PDF_GUIDE_MAX_PAGES, 200);
  assert.equal((await api.readStudyGuidePdf(file({ name: 'Review.PDF', type: '', size: api.PDF_GUIDE_MAX_BYTES }), 100)).pages, 2);
});

test('honors empty EOL items without inserting duplicate spaces into real text', async () => {
  const { api } = await setup([[item('First '), item('topic'), item('', true), item('Next')]]);
  assert.equal((await api.readStudyGuidePdf(file(), 21)).text, 'First topic\nNext');
});

test('preserves text-item lines, embedded breaks, and page order without metadata objects', async () => {
  const { api } = await setup([
    [item('First'), item('topic', true), { type: 'beginMarkedContent', id: 'tag' }, item('Second\nline', true), item('Third')],
    [item('Last page')],
  ]);
  assert.equal((await api.readStudyGuidePdf(file(), 100)).text, 'First topic\nSecond\nline\nThird\n\nLast page');
});

test('reads every page in order and releases its native loading task', async () => {
  const { api, calls } = await setup();
  assert.deepEqual(await api.readStudyGuidePdf(file(), 100), {
    name: 'Review.pdf', text: 'First topic\n\nLater topic', pages: 2, emptyPages: [],
  });
  assert.deepEqual(calls.pages, [1, 2]);
  assert.equal(calls.parse.length, 1);
  assert.deepEqual(calls.parse[0].data, bytes());
  assert.equal(calls.destroy, 1);
});
