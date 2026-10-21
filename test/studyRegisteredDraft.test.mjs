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
  return { ...h, root, plugin, view, leaves, effects, editor, field, card, command: nodes(root).find(n => n.options.attr?.['aria-label'] === 'Inbox command') };
}
function snapshot(f) {
  return {
    state: JSON.stringify(f.view.chat, (key, value) => ['contentEl', 'host', 'study', 'reader', 'cleanup'].includes(key) ? undefined : value),
    effects: [...f.effects], rows: JSON.stringify(f.rows), queued: [...f.queued],
    session: f.view.chat.session, plan: f.view.chat.plan, study: f.view.chat.study, sources: [...f.view.chat.unitSources],
  };
}
function assertMounted(f, box, draft) {
  assert.equal(nodes(f.root).find(n => n.options.attr?.['aria-label'] === 'Inbox command'), f.command);
  assert.equal(studyBox(f.view), box, 'Rejection must not redraw the study composer');
  assert.equal(box.value, draft);
  assert.ok(nodes(f.view.cardsEl).includes(f.editor));
  assert.equal(f.field.value, 'Unsent card question');
  assert.equal(f.card.front, 'What is affinity?');
}

test('registered Make flashcards preserves a rejected Inbox command through the real plugin', async t => {
  const f = await fixture(t), { view, command } = f;
  await button(f.root, 'Chat').events.click();
  const box = studyBox(view), draft = 'An unfinished study draft';
  type(box, draft);
  await button(f.root, 'Inbox').events.click();
  type(command, 'Make flashcards');
  const before = snapshot(f);
  await button(f.root, 'Send command').events.click();
  assert.equal(command.value, 'Make flashcards', 'Rejected registered study command must remain in the Inbox for retry');
  assertMounted(f, box, draft);
  assert.deepEqual(snapshot(f), before);
});

test('registered Open quiz preserves the Inbox command when no view can open', async t => {
  const f = await fixture(t);
  f.leaves.length = 0;
  type(f.command, '/chat');
  const before = snapshot(f);
  await button(f.root, 'Send command').events.click();
  assert.equal(f.command.value, '/chat', 'A registered focus command must propagate missing-view refusal');
  assert.deepEqual(snapshot(f), before);
});

const flashcardForms = [
  'Make flashcards', '/flashcards', '/make-flashcards', 'flashcards', 'make-flashcards',
  'Make flashcards (Experimental)', 'Recall Studio: Make flashcards',
  '/Recall Studio: Make flashcards (Experimental)',
];
test('registered names, prefixes and aliases retain both drafts and retry after explicit Send or clearing', async t => {
  for (const action of ['clear', 'send']) for (const form of flashcardForms) {
    await t.test(`${action}: ${form}`, async t => {
      const f = await fixture(t), { view, command } = f;
      await view.startStudy('quiz me on Receptors');
      const box = studyBox(view), draft = 'Test the definition.';
      type(box, draft);
      await button(f.root, 'Inbox').events.click();
      type(command, form);
      let focuses = 0;
      box.focus = () => { focuses++; };
      const before = snapshot(f);
      await button(f.root, 'Send command').events.click();
      assert.equal(command.value, form, 'Rejected command must remain available for retry');
      assert.equal(focuses, 1, 'A recognized refusal must not dispatch a second study message');
      assertMounted(f, box, draft);
      assert.deepEqual(snapshot(f), before);
      if (action === 'send') {
        await button(view.chatEl, 'Send').events.click();
        assert.equal(view.chat.guide, draft, 'Ordinary internal Send must consume its own draft');
        assert.equal(view.chat.draftQuestion, '');
      } else type(box, '');
      const effects = [...f.effects], userTurns = view.chat.turns.filter(turn => turn.role === 'user').length;
      await button(f.root, 'Inbox').events.click();
      await button(f.root, 'Send command').events.click();
      assert.equal(command.value, '');
      assert.equal(view.chat.studyMode, 'flashcards');
      assert.equal(view.chat.awaitingTopic, true);
      assert.equal(view.chat.awaitingGuide, false);
      assert.equal(view.chat.guide, '');
      assert.equal(view.chat.turns.filter(turn => turn.role === 'user').length, userTurns + 1, 'Accepted commands dispatch exactly once');
      assert.match(text(view.chatEl), /What topic should we study/);
      await say(view, 'Receptors');
      assert.equal(view.chat.awaitingGuide, true);
      assert.match(text(view.chatEl), /Paste a study guide/);
      assert.deepEqual(f.effects, effects, 'Retry must wait for fresh coverage before reading sources or calling providers');
      assert.equal(f.queued.length, 0);
      assert.ok(nodes(view.cardsEl).includes(f.editor));
      assert.equal(f.field.value, 'Unsent card question');
    });
  }
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
  type(f.command, '/flashcards');
  await button(f.root, 'Send command').events.click();
  assert.equal(f.command.value, '/flashcards');
  assertMounted(f, box, '');
  assert.equal(f.view.panel, 'inbox', 'Refusal must not fall through and focus the originating study view');
  assert.deepEqual(snapshot(f), before);
});

test('busy and closed study views refuse registered commands without mutations', async t => {
  for (const state of ['busy', 'closed']) await t.test(state, async t => {
    const f = await fixture(t), { plugin, view, command } = f;
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
      type(command, '/make-flashcards');
      assert.equal(await plugin.openChat('Make flashcards'), false);
      assert.equal(await runNamedCommand(plugin, '/flashcards'), false);
      await button(f.root, 'Send command').events.click();
      assert.equal(command.value, '/make-flashcards');
      assertMounted(f, box, draft);
      assert.deepEqual(snapshot(f), before);
    } finally {
      if (release) { release({ selections: [], gaps: [] }); await pending; }
    }
  });
});

test('closed Inbox does not dispatch a retained command', async t => {
  const f = await fixture(t);
  type(f.command, '/flashcards');
  await f.view.onClose();
  let reveals = 0;
  f.plugin.app.workspace.revealLeaf = async () => { reveals++; };
  const before = snapshot(f);
  await button(f.root, 'Send command').events.click();
  assert.equal(f.command.value, '/flashcards');
  assert.equal(reveals, 0);
  assert.deepEqual(snapshot(f), before);
});

test('plugin exceptions propagate through the registry and leave rendered drafts intact', async t => {
  const f = await fixture(t), { plugin, view, command } = f;
  const box = studyBox(view), draft = 'Unsent study topic';
  type(box, draft); type(command, '/flashcards');
  const failure = new Error('Workspace could not reveal Inbox');
  plugin.app.workspace.revealLeaf = async () => { throw failure; };
  const before = snapshot(f);
  await assert.rejects(plugin.openChat('Make flashcards'), error => error === failure);
  await assert.rejects(runNamedCommand(plugin, '/flashcards'), error => error === failure);
  await button(f.root, 'Send command').events.click();
  assert.equal(command.value, '/flashcards');
  assertMounted(f, box, draft);
  assert.deepEqual(snapshot(f), before);
  assert.equal(button(f.root, 'Send command').disabled, false, 'An exception must not leave the composer busy');
});

test('edits typed during an accepted registered-command await are not overwritten or dispatched', async t => {
  const f = await fixture(t), { plugin, view, command } = f;
  let release;
  plugin.app.workspace.revealLeaf = () => new Promise(resolve => { release = resolve; });
  type(command, '/flashcards');
  const pending = button(f.root, 'Send command').events.click();
  assert.ok(release);
  type(command, 'A newer Inbox draft');
  await button(f.root, 'Send command').events.click();
  release(); await pending;
  assert.equal(command.value, 'A newer Inbox draft');
  assert.equal(view.chat.studyMode, 'flashcards');
  assert.equal(view.chat.awaitingTopic, true);
  assert.deepEqual(view.chat.turns.filter(turn => turn.role === 'user').map(turn => turn.text), ['Make flashcards']);
  assert.deepEqual(f.effects, []); assert.equal(f.queued.length, 0);
  assert.equal(button(f.root, 'Send command').disabled, false);
});

test('legacy void commands succeed and unavailable known commands never become study messages', async t => {
  const f = await fixture(t), { plugin, command, view } = f;
  const box = studyBox(view), draft = 'Unfinished study request';
  type(box, draft);
  const before = snapshot(f);
  assert.equal(await runNamedCommand(plugin, '/inbox'), true, 'Legacy void-returning commands still count as handled');
  type(command, '/inbox');
  await button(f.root, 'Send command').events.click();
  assert.equal(command.value, '');
  assertMounted(f, box, draft);
  assert.deepEqual(snapshot(f), before);
  plugin.app.workspace.getActiveFile = () => null;
  type(command, '/sweep');
  assert.equal(await runNamedCommand(plugin, '/sweep'), false);
  await button(f.root, 'Send command').events.click();
  assert.equal(command.value, '/sweep');
  assert.equal(view.panel, 'inbox', 'Unavailable known commands must not focus or submit to Quiz');
  assert.deepEqual(snapshot(f), before);
});

test('an unregistered study request still reaches the real ordinary study flow once', async t => {
  const f = await fixture(t), { view, command } = f;
  type(command, 'quiz me on Receptors');
  await button(f.root, 'Send command').events.click();
  assert.equal(command.value, '');
  assert.equal(view.chat.studyMode, 'quiz');
  assert.equal(view.chat.awaitingGuide, true);
  assert.deepEqual(view.chat.turns.filter(turn => turn.role === 'user').map(turn => turn.text), ['quiz me on Receptors']);
  assert.deepEqual(f.effects, []); assert.equal(f.queued.length, 0);
});
