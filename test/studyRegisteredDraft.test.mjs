import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadQuiz, harness, element, nodes, button, text, SOURCE } from './quizHarness.mjs';

let RecallPlugin, InboxView, QuizView, runNamedCommand, makeHighlight, makeCard, DEFAULT_SETTINGS;
before(async () => {
  ({ RecallPlugin, InboxView, QuizView, runNamedCommand, makeHighlight, makeCard, DEFAULT_SETTINGS } = await loadQuiz('test/fixtures/studyRegistryEntry.ts'));
});

// Supply only the Obsidian DOM operations missing from the shared host double.
function dom() {
  const extend = el => {
    const create = el.createEl;
    el.createEl = function (...args) { return extend(create.apply(this, args)); };
    el.show = el.hide = el.toggle = () => {};
    el.querySelector = selector => {
      if (selector === '.review-chat textarea') return nodes(el).find(n => n.options.attr?.['aria-label'] === 'Chat message' || n.options.attr?.['aria-label'] === 'Your answer') ?? null;
      const match = selector.match(/^\.wikilm-card\[data-id="([^"]+)"\] \.wikilm-editor$/);
      assert.ok(match, `Unexpected DOM query: ${selector}`);
      const card = nodes(el).find(n => n.hasClass('wikilm-card') && n.dataset.id === match[1]);
      return card ? nodes(card).find(n => n.hasClass('wikilm-editor')) ?? null : null;
    };
    return el;
  };
  return extend(element());
}
const type = (box, value) => { box.value = value; box.events.input(); };
const studyBox = view => nodes(view.chatEl).find(n => n.tagName === 'TEXTAREA');
async function say(view, message) {
  type(studyBox(view), message);
  await button(view.chatEl, view.chat.session?.current ? 'Submit answer' : 'Send').events.click();
}
async function fixture(t) {
  const previousWindow = globalThis.window;
  globalThis.window = { setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: () => {} };
  t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
  const h = harness(QuizView), root = dom();
  delete h.host.openInbox;
  const plugin = Object.assign(new RecallPlugin(), h.host);
  plugin.settings = { ...DEFAULT_SETTINGS };
  plugin.schema = { openCount: () => 0 };
  plugin.store.onChange = () => () => {};
  plugin.store.counts = () => ({ toReview: 1, queued: 0, generating: 0, errors: 0 });
  const row = makeHighlight({ sourcePath: h.file.path, sourceTitle: 'Receptors', text: SOURCE, status: 'ready' });
  const card = makeCard(row.id, { kind: 'qa', front: 'What is affinity?', back: 'Binding strength' });
  row.cards = [card]; h.rows.push(row);
  const effects = [];
  const read = plugin.app.vault.read;
  plugin.app.vault.read = async (...args) => { effects.push('read'); return read(...args); };
  for (const name of Object.keys(plugin.llm).filter(n => n !== 'requestAuthorization')) {
    const fn = plugin.llm[name];
    plugin.llm[name] = async (...args) => { effects.push(name); return fn(...args); };
  }
  const view = new InboxView({ contentEl: root }, plugin);
  const leaves = [{ view }];
  plugin.app.workspace.getLeavesOfType = kind => kind === 'review-inbox' ? leaves : [];
  plugin.app.workspace.revealLeaf = async () => {};
  plugin.app.workspace.getRightLeaf = () => null;
  await view.onOpen();
  t.after(() => view.onClose());
  nodes(view.cardsEl).find(n => n.title === 'Edit (e)').events.click({ stopPropagation() {} });
  const editor = nodes(view.cardsEl).find(n => n.hasClass('wikilm-editor'));
  assert.ok(editor, 'The real card editor must be mounted');
  const field = nodes(editor).find(n => n.options.attr?.['aria-label'] === 'Question');
  field.value = 'Unsent card question';
  return { ...h, root, plugin, view, leaves, effects, editor, field, card };
}
function snapshot(f) {
  return {
    state: JSON.stringify(f.view.chat, (key, value) => ['contentEl', 'host', 'study', 'reader', 'cleanup'].includes(key) ? undefined : value),
    effects: [...f.effects], rows: JSON.stringify(f.rows), queued: [...f.queued],
    session: f.view.chat.session, plan: f.view.chat.plan, study: f.view.chat.study, sources: [...f.view.chat.unitSources],
  };
}
function assertMounted(f, box, draft) {
  assert.equal(nodes(f.root).find(n => n.options.attr?.['aria-label'] === 'Inbox command'), undefined);
  assert.equal(studyBox(f.view), box, 'Rejection must not redraw the study composer');
  assert.equal(box.value, draft);
  assert.ok(nodes(f.view.cardsEl).includes(f.editor));
  assert.equal(f.field.value, 'Unsent card question');
  assert.equal(f.card.front, 'What is affinity?');
}

test('registered names and aliases preserve an unfinished Chat draft, then accept a fresh request', async t => {
  const forms = ['Make flashcards', '/flashcards', '/make-flashcards', 'flashcards', 'make-flashcards',
    'Make flashcards (Experimental)', 'Recall Studio: Make flashcards', '/Recall Studio: Make flashcards (Experimental)'];
  for (const action of ['clear', 'send']) for (const form of forms) await t.test(`${action}: ${form}`, async t => {
    const f = await fixture(t), { view, plugin } = f;
    await view.startStudy('quiz me on Receptors');
    const box = studyBox(view), draft = 'Test the definition.';
    type(box, draft);
    await button(f.root, 'Inbox').events.click();
    const before = snapshot(f);
    assert.equal(await runNamedCommand(plugin, form), false);
    assertMounted(f, box, draft);
    assert.deepEqual(snapshot(f), before);
    if (action === 'send') {
      await button(view.chatEl, 'Send').events.click();
      assert.equal(view.chat.guide, draft);
    } else type(box, '');
    const effects = [...f.effects], count = view.chat.turns.filter(turn => turn.role === 'user').length;
    assert.equal(await runNamedCommand(plugin, form), true);
    assert.equal(view.chat.studyMode, 'flashcards');
    assert.equal(view.chat.awaitingTopic, true);
    assert.equal(view.chat.awaitingGuide, false);
    assert.equal(view.chat.guide, '');
    assert.equal(view.chat.turns.filter(turn => turn.role === 'user').length, count + 1);
    await say(view, 'Receptors');
    assert.equal(view.chat.awaitingGuide, true);
    assert.match(text(view.chatEl), /Paste a study guide/);
    assert.deepEqual(f.effects, effects);
    assert.equal(f.queued.length, 0);
    assert.ok(nodes(view.cardsEl).includes(f.editor));
    assert.equal(f.field.value, 'Unsent card question');
  });
});

test('the real plugin and registry distinguish acceptance, refusal and unknown commands', async t => {
  const f = await fixture(t), { plugin, view } = f;
  assert.equal(await plugin.openChat('Make flashcards'), true);
  assert.equal(view.chat.awaitingTopic, true);
  type(studyBox(view), 'An unfinished topic');
  const before = snapshot(f);
  assert.equal(await plugin.openChat('Make flashcards'), false);
  assert.equal(await runNamedCommand(plugin, '/flashcards'), false);
  assert.equal(await runNamedCommand(plugin, 'quiz me on Receptors'), null);
  assert.deepEqual(snapshot(f), before);
  assert.equal(await plugin.openChat(), true, 'Opening Quiz alone does not submit or consume a study draft');
  assert.deepEqual(snapshot(f), before);
  f.leaves.length = 0;
  assert.equal(await plugin.openChat('Make flashcards'), false);
  assert.equal(await plugin.openChat(), false);
  assert.equal(await runNamedCommand(plugin, '/flashcards'), false);
  assert.equal(await runNamedCommand(plugin, '/chat'), false);
  f.leaves.push({ view: {} });
  assert.equal(await plugin.openChat('Make flashcards'), false, 'A non-Inbox leaf cannot accept a study command');
  assert.deepEqual(snapshot(f), before);
});

test('missing registered-command destination cannot fall through to the originating study view', async t => {
  const f = await fixture(t);
  f.leaves.length = 0;
  const box = studyBox(f.view), before = snapshot(f);
  assert.equal(await runNamedCommand(f.plugin, '/flashcards'), false);
  assertMounted(f, box, '');
  assert.equal(f.view.panel, 'inbox', 'Refusal must not fall through and focus the originating study view');
  assert.deepEqual(snapshot(f), before);
});

test('busy and closed study views refuse registered commands without mutations', async t => {
  for (const state of ['busy', 'closed']) await t.test(state, async t => {
    const f = await fixture(t), { plugin, view } = f;
    let release, pending;
    if (state === 'busy') {
      await view.startStudy('quiz me on Receptors');
      await say(view, 'Test the definition.');
      let entered;
      const barrier = new Promise(resolve => { entered = resolve; });
      plugin.llm.selectStudyEvidence = () => { f.effects.push('selectStudyEvidence'); entered(); return new Promise(resolve => { release = resolve; }); };
      pending = button(view.chatEl, 'Free response').events.click();
      await barrier;
      assert.equal(view.chat.busy, true);
    } else await view.chat.onClose();
    try {
      const box = studyBox(view), draft = box.value, before = snapshot(f);
      assert.equal(await plugin.openChat('Make flashcards'), false);
      assert.equal(await runNamedCommand(plugin, '/flashcards'), false);
      assert.equal(await runNamedCommand(plugin, '/make-flashcards'), false);
      assertMounted(f, box, draft);
      assert.deepEqual(snapshot(f), before);
    } finally {
      if (release) { release({ selections: [], gaps: [] }); await pending; }
    }
  });
});

test('plugin exceptions propagate through the registry and leave rendered drafts intact', async t => {
  const f = await fixture(t), { plugin, view } = f;
  const box = studyBox(view), draft = 'Unsent study topic';
  type(box, draft);
  const failure = new Error('Workspace could not reveal Inbox');
  plugin.app.workspace.revealLeaf = async () => { throw failure; };
  const before = snapshot(f);
  await assert.rejects(plugin.openChat('Make flashcards'), error => error === failure);
  await assert.rejects(runNamedCommand(plugin, '/flashcards'), error => error === failure);
  assertMounted(f, box, draft);
  assert.deepEqual(snapshot(f), before);
});

test('new Chat edits during a palette command await are not overwritten', async t => {
  const f = await fixture(t), { plugin, view } = f;
  let release;
  plugin.app.workspace.revealLeaf = () => new Promise(resolve => { release = resolve; });
  const pending = runNamedCommand(plugin, '/flashcards');
  assert.ok(release);
  const box = studyBox(view);
  type(box, 'A newer Chat draft');
  release();
  assert.equal(await pending, false);
  assertMounted(f, box, 'A newer Chat draft');
  assert.deepEqual(view.chat.turns, []);
  assert.deepEqual(f.effects, []); assert.equal(f.queued.length, 0);
});

test('legacy void commands succeed and unavailable commands do not become study text', async t => {
  const f = await fixture(t), { plugin, view } = f;
  const box = studyBox(view), draft = 'Unfinished study request';
  type(box, draft);
  const before = snapshot(f);
  assert.equal(await runNamedCommand(plugin, '/inbox'), true);
  assertMounted(f, box, draft);
  assert.deepEqual(snapshot(f), before);
  plugin.app.workspace.getActiveFile = () => null;
  assert.equal(await runNamedCommand(plugin, '/sweep'), false);
  assert.equal(view.panel, 'inbox');
  assert.deepEqual(snapshot(f), before);
});
