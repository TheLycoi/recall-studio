import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadQuiz } from './quizHarness.mjs';

let anki, actions, model, settings;
let transport = () => { throw new Error('Real Anki access is forbidden'); };
before(async () => {
  anki = await loadQuiz('src/anki.ts', { requestUrl: opts => transport(opts) });
  actions = await loadQuiz('src/cardActions.ts');
  model = await loadQuiz('src/model.ts');
  settings = (await loadQuiz('src/settings.ts')).DEFAULT_SETTINGS;
});

function fixture() {
  const h = model.makeHighlight({ sourcePath: 'Synthetic.md', sourceTitle: 'Synthetic',
    text: 'The original answer is alpha; the corrected answer is beta.', status: 'ready' });
  const c = model.makeCard(h.id, { kind: 'qa', front: 'Which answer?', back: 'alpha' });
  h.cards = [c];
  const ctx = { settings: { ...settings }, vaultName: 'Synthetic', deck: 'Default' };
  const notes = new Map();
  const calls = [];
  const handlers = {};
  function respond(action, params) {
    switch (action) {
      case 'createDeck': return null;
      case 'findNotes': return params.query.startsWith('tag:') ? [...notes.keys()] : [];
      case 'addNotes': {
        const id = 1234;
        notes.set(id, structuredClone(params.notes[0]));
        return [id];
      }
      case 'notesInfo': return params.notes.filter(id => notes.has(id)).map(id => ({
        noteId: id, modelName: notes.get(id).modelName, tags: notes.get(id).tags,
        fields: Object.fromEntries(Object.entries(notes.get(id).fields).map(([key, value], order) => [key, { value, order }])),
      }));
      case 'storeMediaFile': return params.filename;
      default: throw new Error(`Unexpected Anki action: ${action}`);
    }
  }
  transport = async opts => {
    const { action, params } = JSON.parse(opts.body);
    calls.push({ action, params });
    const result = await (handlers[action] ?? (p => respond(action, p)))(params);
    return { status: 200, json: { result, error: null } };
  };
  const client = new anki.AnkiClient(() => 'http://synthetic.invalid');
  const items = [{ card: c, highlight: h }];
  return { h, c, ctx, notes, calls, handlers, respond,
    send: () => actions.withExportAcceptance(items, () => anki.exportToAnki(client, items, ctx)) };
}

test('lost-response recovery refuses an identity whose remote content differs from the sent snapshot', async () => {
  const f = fixture();
  f.handlers.addNotes = params => {
    f.respond('addNotes', params);
    f.notes.get(1234).fields.Back = 'A different answer in Anki';
    throw new Error('response lost after write');
  };
  const result = await f.send();
  assert.equal(f.c.status, 'pending');
  assert.equal(f.h.status, 'ready');
  assert.equal(f.c.ankiNoteId, undefined);
  assert.equal(result.alreadyExported, 0);
  assert.equal(result.duplicates, 0, 'an identity conflict is not an unrelated content duplicate');
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /content conflict/i);
  assert.equal(f.notes.get(1234).fields.Back, 'A different answer in Anki');
  assert.equal(f.calls.filter(call => call.action === 'addNotes').length, 1);
});

for (const path of ['initial add', 'existing identity']) {
  test(`${path} cannot receipt a source-link change made while Anki responds`, async () => {
    const f = fixture();
    if (path === 'existing identity') seed(f);
    const action = path === 'initial add' ? 'addNotes' : 'notesInfo';
    f.handlers[action] = params => {
      const result = f.respond(action, params);
      f.h.page = 7;
      return result;
    };
    const result = await f.send();
    assert.equal(f.c.status, 'pending');
    assert.equal(f.h.status, 'ready');
    assert.equal(result.alreadyExported, 0);
    if (path === 'existing identity') assert.match(result.failed[0].error, /changed during export/i);
  });
}

function seed(f) {
  const note = anki.buildNote(f.c, f.h, f.ctx);
  note.tags.push(anki.cardIdentityTag(f.ctx.vaultName, f.c.id));
  f.notes.set(1234, structuredClone(note));
  return note;
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('retry refuses an old remote answer after a local edit during the first add', async () => {
  const f = fixture();
  const sent = deferred();
  const resume = deferred();
  f.handlers.addNotes = async params => {
    const ids = f.respond('addNotes', params);
    sent.resolve();
    await resume.promise;
    return ids;
  };
  const first = f.send();
  await sent.promise;
  f.c.back = 'beta';
  f.c.status = 'pending';
  resume.resolve();
  assert.equal((await first).added, 1);
  assert.equal(f.c.status, 'pending', 'the first response must preserve the newer draft');
  const remote = structuredClone(f.notes.get(1234));
  assert.match(remote.fields.Back, /^alpha(?:<br>|$)/);

  const retry = await f.send();
  assert.equal(f.c.status, 'pending', 'old remote content must not receipt the new answer');
  assert.equal(f.h.status, 'ready');
  assert.equal(f.c.back, 'beta');
  assert.equal(retry.alreadyExported, 0);
  assert.equal(retry.failed.length, 1);
  assert.match(retry.failed[0].error, /conflict.*content|content.*conflict/i);
  assert.deepEqual(f.notes.get(1234), remote, 'the remote note must not be overwritten');
  assert.equal(f.calls.filter(call => call.action === 'addNotes').length, 1);
  assert.ok(f.calls.some(call => call.action === 'notesInfo'));
});

for (const kind of ['qa', 'cloze']) {
  test(`a matching legacy ${kind} identity needs no stored receipt or second add`, async () => {
    const f = fixture();
    if (kind === 'cloze') Object.assign(f.c, { kind, front: '', back: '', text: 'The answer is {{c1::alpha}}.' });
    seed(f);
    assert.equal(f.c.ankiNoteId, undefined);
    const result = await f.send();
    assert.equal(result.added, 0);
    assert.equal(result.alreadyExported, 1);
    assert.deepEqual(result.failed, []);
    assert.equal(f.c.status, 'exported');
    assert.equal(f.c.ankiNoteId, 1234);
    assert.equal(f.h.status, 'exported');
    assert.equal(f.calls.filter(call => call.action === 'addNotes').length, 0);
  });
}

test('a lost add response recovers only after the actual note matches the sent snapshot', async () => {
  const f = fixture();
  f.handlers.addNotes = params => {
    f.respond('addNotes', params);
    throw new Error('response lost after write');
  };
  const result = await f.send();
  assert.equal(result.added, 0);
  assert.equal(result.alreadyExported, 1);
  assert.deepEqual(result.failed, []);
  assert.equal(f.c.status, 'exported');
  assert.equal(f.c.ankiNoteId, 1234);
  assert.equal(f.calls.filter(call => call.action === 'notesInfo').length, 1);
});

test('matching retries compare resolved HTML and media while allowing deck and metadata tag changes', async () => {
  const f = fixture();
  f.c.back = '**alpha** ![[pic.png]]';
  f.ctx.resolveMedia = async () => ({ path: 'pic.png', data: Uint8Array.from([1, 2, 3]).buffer });
  assert.equal((await f.send()).added, 1);
  const remote = structuredClone(f.notes.get(1234));
  assert.match(remote.fields.Back, /<b>alpha<\/b>/);
  assert.match(remote.fields.Back, /<img src="review-inbox-[a-f0-9]{64}\.png">/);
  f.c.status = 'pending';
  f.h.status = 'ready';
  f.ctx.deck = 'Other deck';
  f.ctx.settings.extraTags = 'new-metadata';
  const retry = await f.send();
  assert.equal(retry.alreadyExported, 1);
  assert.deepEqual(retry.failed, []);
  assert.equal(f.c.status, 'exported');
  assert.deepEqual(f.notes.get(1234), remote, 'retry must not move, retag or overwrite the note');
  assert.equal(f.calls.filter(call => call.action === 'addNotes').length, 1);
});

const conflicts = [
  ['question', f => { f.c.front = 'A different question?'; }],
  ['answer', f => { f.c.back = 'beta'; }],
  ['annotation', f => { f.c.extra = 'A local annotation'; }],
  ['model', f => { f.ctx.settings.basicModel = 'Other Basic'; }],
  ['field mapping', f => { f.ctx.settings.basicBackField = 'Answer'; }],
  ['source text', f => { f.h.text = 'A different captured passage'; }],
  ['source path', f => { f.h.sourcePath = 'Other.md'; }],
  ['source title', f => { f.h.sourceTitle = 'Other'; }],
  ['source page', f => { f.h.page = 7; }],
  ['source subpath', f => { f.h.subpath = 'page=7&selection=abc'; }],
  ['topic link', f => { f.h.topicPath = 'Topic.md'; }],
  ['HTML formatting', f => { f.c.back = '**alpha**'; }],
  ['source inclusion setting', f => { f.ctx.settings.includeExtra = false; }],
  ['card kind', f => { Object.assign(f.c, { kind: 'cloze', front: '', back: '', text: '{{c1::alpha}}' }); }],
];
for (const [name, change] of conflicts) {
  test(`existing identity reports a conflict for changed ${name}`, async () => {
    const f = fixture();
    seed(f);
    const remote = structuredClone(f.notes.get(1234));
    change(f);
    const result = await f.send();
    assert.equal(f.c.status, 'pending');
    assert.equal(f.h.status, 'ready');
    assert.equal(f.c.ankiNoteId, undefined);
    assert.equal(result.alreadyExported, 0);
    assert.equal(result.duplicates, 0);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].error, /content conflict/i);
    assert.deepEqual(f.notes.get(1234), remote);
    assert.equal(f.calls.filter(call => call.action === 'addNotes').length, 0);
  });
}

const malformed = [
  ['missing result', () => undefined],
  ['null result', () => null],
  ['non-array result', () => ({ noteId: 1234 })],
  ['missing note', () => []],
  ['null note', () => [null]],
  ['multiple notes', info => [info[0], info[0]]],
  ['wrong note ID', info => [{ ...info[0], noteId: 5678 }]],
  ['string note ID', info => [{ ...info[0], noteId: '1234' }]],
  ['missing model', info => [{ ...info[0], modelName: undefined }]],
  ['missing tags', info => [{ ...info[0], tags: undefined }]],
  ['wrong identity tag', info => [{ ...info[0], tags: ['unrelated'] }]],
  ['missing fields', info => [{ ...info[0], fields: undefined }]],
  ['null fields', info => [{ ...info[0], fields: null }]],
  ['array fields', info => [{ ...info[0], fields: [] }]],
  ['missing outgoing field', info => [{ ...info[0], fields: {} }]],
  ['null field', info => [{ ...info[0], fields: { ...info[0].fields, Back: null } }]],
  ['non-string field value', info => [{ ...info[0], fields: { ...info[0].fields, Back: { value: 42, order: 1 } } }]],
  ['invalid field order', info => [{ ...info[0], fields: { ...info[0].fields, Back: { value: info[0].fields.Back.value, order: -1 } } }]],
];
for (const path of ['existing identity', 'lost-response recovery']) {
  for (const [name, corrupt] of malformed) {
    test(`${path} fails safely on notesInfo with ${name}`, async () => {
      const f = fixture();
      if (path === 'existing identity') seed(f);
      else f.handlers.addNotes = params => {
        f.respond('addNotes', params);
        throw new Error('response lost after write');
      };
      f.handlers.notesInfo = params => corrupt(f.respond('notesInfo', params));
      const result = await f.send();
      assert.equal(f.c.status, 'pending');
      assert.equal(f.h.status, 'ready');
      assert.equal(f.c.ankiNoteId, undefined);
      assert.equal(result.alreadyExported, 0);
      assert.equal(result.failed.length, 1);
      assert.match(result.failed[0].error, /cannot verify|content conflict/i);
    });
  }
}

for (const path of ['existing identity', 'lost-response recovery']) {
  test(`${path} preserves the draft when notesInfo is unavailable`, async () => {
    const f = fixture();
    if (path === 'existing identity') seed(f);
    else f.handlers.addNotes = params => {
      f.respond('addNotes', params);
      throw new Error('response lost after write');
    };
    f.handlers.notesInfo = () => { throw new Error('Anki unavailable'); };
    const result = await f.send();
    assert.equal(f.c.status, 'pending');
    assert.equal(f.h.status, 'ready');
    assert.equal(result.alreadyExported, 0);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].error, /Anki is not open/i);
  });
}

for (const path of ['initial add', 'existing identity', 'lost-response recovery']) {
  for (const [name, change] of [
    ['answer', f => { f.c.back = 'beta'; }],
    ['model setting', f => { f.ctx.settings.basicModel = 'Other Basic'; }],
  ]) {
    test(`${path} cannot receipt a ${name} edit while Anki responds`, async () => {
      const f = fixture();
      if (path === 'existing identity') seed(f);
      if (path === 'lost-response recovery') f.handlers.addNotes = params => {
        f.respond('addNotes', params);
        throw new Error('response lost after write');
      };
      const action = path === 'initial add' ? 'addNotes' : 'notesInfo';
      f.handlers[action] = params => {
        const result = f.respond(action, params);
        change(f);
        return result;
      };
      const result = await f.send();
      assert.equal(f.c.status, 'pending');
      assert.equal(f.h.status, 'ready');
      assert.equal(result.alreadyExported, 0);
      if (path !== 'initial add') assert.match(result.failed[0].error, /changed during export/i);
    });
  }
}
