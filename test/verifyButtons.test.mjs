import { before, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadQuiz, element, nodes } from './quizHarness.mjs';

let InboxView, LlmClient, makeHighlight, makeCard, DEFAULT_SETTINGS, transport, previousWindow;
const notices = [];
before(async () => {
  ({ InboxView } = await loadQuiz('src/inboxView.ts', { Notice: class { constructor(message) { notices.push(message); } hide() {} } }));
  ({ LlmClient } = await loadQuiz('src/llm.ts', { requestUrl: request => transport(request) }));
  ({ makeHighlight, makeCard } = await loadQuiz('src/model.ts'));
  ({ DEFAULT_SETTINGS } = await loadQuiz('src/settings.ts'));
});
beforeEach(() => {
  notices.length = 0;
  previousWindow = globalThis.window;
  globalThis.window = { requestAnimationFrame: callback => setImmediate(callback), setTimeout() {} };
});
afterEach(() => {
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
});

function matches(el, selector) {
  const tag = selector.match(/^[a-z]+/i)?.[0];
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  if ([...selector.matchAll(/\.([\w-]+)/g)].some(([, cls]) => !el.classes.includes(cls))) return false;
  const id = selector.match(/\[data-id="([^"]+)"\]/)?.[1];
  return !id || el.dataset.id === id;
}
function dom() {
  const extend = el => {
    Object.assign(el, el.options.attr);
    const create = el.createEl;
    el.createEl = function (...args) { const child = extend(create.apply(this, args)); child.parentElement = this; return child; };
    el.closest = function (selector) { for (let n = this; n; n = n.parentElement) if (matches(n, selector)) return n; return null; };
    el.querySelectorAll = function (selector) {
      const parts = selector.split(' '), last = parts.pop();
      return nodes(this).slice(1).filter(n => matches(n, last) && (!parts.length || n.parentElement?.closest(parts.join(' '))));
    };
    el.querySelector = function (selector) { return this.querySelectorAll(selector)[0] ?? null; };
    el.show = el.hide = el.toggle = () => {};
    return el;
  };
  return extend(element());
}
const buttons = root => nodes(root).filter(n => n.tagName === 'BUTTON');
const byClass = (root, cls) => nodes(root).find(n => n.classes.includes(cls));
const reply = value => ({ status: 200, json: { choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] } });
const keep = { index: 0, verdict: 'keep', reason: '', bloom: 'remember', kind: 'qa', front: '', back: '', text: '' };
async function fixture(t, { rules = async () => ({ cards: '' }), onRequest } = {}) {
  const highlights = [], requests = [], revisions = [], exports = [];
  const settings = { ...DEFAULT_SETTINGS, provider: 'deepseek', deepseekApiKey: 'synthetic-test-key', deepseekModel: 'synthetic', historyExamples: false, schemaLearning: false, lintMode: 'badge' };
  const add = (path, text, front, back) => {
    const h = makeHighlight({ sourcePath: path, sourceTitle: path, text, status: 'ready', line: highlights.length });
    h.cards = [makeCard(h.id, { kind: 'qa', front, back })]; highlights.push(h); return h;
  };
  const first = add('seeds.md', 'Dormancy delays germination.', 'What does dormancy delay?', 'germination');
  const second = add('seeds.md', 'Heat increases evaporation.', 'What does heat increase?', 'evaporation');
  const other = add('roots.md', 'Roots absorb water.', 'What do roots absorb?', 'water');
  transport = async request => { const user = JSON.parse(request.body).messages[1].content; requests.push(user); return onRequest ? onRequest(user) : reply({ verdicts: [keep] }); };
  const llm = new LlmClient(() => settings, () => [], rules);
  const root = dom();
  let changed = () => {};
  const host = { app: { vault: { getFiles: () => [], configDir: '.obsidian' }, workspace: {}, metadataCache: {} }, settings, llm,
    schema: { openCount: () => 0 }, exportHighlights: async (hs, ids) => exports.push({ hs, ids }),
    store: { all: () => highlights.filter(h => !h.archived), counts: () => ({ toReview: 3, queued: 0, generating: 0, errors: 0 }), onChange: fn => { changed = fn; return () => { changed = () => {}; }; }, touch() { changed(); }, recordRevision: r => revisions.push(r) } };
  const view = new InboxView({ contentEl: root }, host);
  await view.onOpen();
  t.after(() => view.onClose());
  const group = scope => scope === 'inbox' ? byClass(root, 'wikilm-header-right') : scope === 'source' ? byClass(root, 'wikilm-source-actions') : byClass(root, 'wikilm-hl-actions');
  return { root, view, host, settings, highlights, first, second, other, add, requests, revisions, exports, group };
}

test('mounted Inbox, source and passage retain Export without Verify or rule suggestions', async t => {
  const f = await fixture(t);
  f.host.settings.schemaLearning = true;
  f.host.schema.openCount = () => 3;
  f.view.render();
  for (const scope of ['inbox', 'source', 'passage']) {
    const row = f.group(scope);
    assert.ok(buttons(row).some(b => b.text === 'Export'), `${scope} retains Export`);
    assert.ok(!buttons(row).some(b => /verify|suggestion/i.test(b.text ?? '')), `${scope} has no retired controls`);
  }
  assert.ok(!byClass(f.root, 'wikilm-schema-chip'));
  assert.ok(buttons(f.root).some(b => /Rewrite card with AI/.test(b.title ?? '')));
  assert.ok(buttons(f.root).some(b => b.title === 'Convert to cloze'));
  assert.deepEqual(f.requests, []); assert.deepEqual(f.exports, []);
});

test('mounted editor retains authoring and unsaved text without manual Check', async t => {
  const f = await fixture(t);
  buttons(f.root).find(b => b.title === 'Edit (e)').events.click({ stopPropagation() {} });
  const editor = byClass(f.root, 'wikilm-editor');
  assert.deepEqual(buttons(editor).map(b => b.text), ['Cloze', 'Cancel', 'Save']);
  const question = nodes(editor).find(n => n['aria-label'] === 'Question');
  const instruction = nodes(editor).find(n => n['aria-label'] === 'Rewrite instruction');
  question.value = 'Unfinished wording'; instruction.value = 'Unfinished instruction';
  f.view.scheduleRender();
  assert.equal(byClass(f.root, 'wikilm-editor'), editor);
  assert.equal(question.value, 'Unfinished wording'); assert.equal(instruction.value, 'Unfinished instruction');
  assert.notEqual(f.first.cards[0].front, question.value);
  assert.deepEqual(f.requests, []); assert.deepEqual(f.exports, []);
});

test('source and passage action rows can wrap in narrow panes', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  for (const selector of ['wikilm-source-actions', 'wikilm-hl-actions']) {
    const rule = css.match(new RegExp(`\\.${selector}\\s*\\{([^}]+)\\}`))[1];
    assert.match(rule, /display:\s*flex/);
    assert.match(rule, /flex-wrap:\s*wrap/);
  }
});
