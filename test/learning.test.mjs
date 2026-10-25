import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { build } from 'esbuild';
import { element, nodes, button } from './quizHarness.mjs';

const require = createRequire(import.meta.url);
let api;
class TFile { constructor(path) { this.path = path; this.stat = { mtime: 1 }; } }
class TFolder {}
const notices = [];
function dom() {
  const extend = el => {
    const create = el.createEl;
    el.createEl = function (...args) { const child = extend(create.apply(this, args)); child.parent = this; return child; };
    el.remove = () => { if (el.parent) el.parent.children = el.parent.children.filter(c => c !== el); };
    el.querySelector = selector => nodes(el).find(n => selector.startsWith('.') && n.hasClass(selector.slice(1))) ?? null;
    return el;
  };
  return extend(element());
}
class Modal {
  constructor(app) { this.app = app; this.contentEl = dom(); }
  open() { this.onOpen?.(); }
  close() { this.onClose?.(); this.contentEl.empty(); }
}
class Setting {
  constructor(el) { this.el = el; }
  addButton(fn) {
    const el = this.el.createEl('button');
    fn({ setButtonText(t) { el.setText(t); return this; }, setCta() { return this; }, setTooltip(t) { el.title = t; return this; }, setDisabled(v) { el.disabled = v; return this; }, onClick(cb) { el.addEventListener('click', cb); return this; } });
    return this;
  }
}
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
before(async () => {
  const built = await build({ stdin: { contents: `export * from './src/preferences'; export * from './src/schemaNote'; export { SchemaFile } from './src/schemaFile'; export { SchemaSuggestionsModal } from './src/modals';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'cjs', platform: 'node', external: ['obsidian'], logLevel: 'silent' });
  const mod = new Module('learning-regressions');
  const obsidian = new Proxy({ TFile, TFolder, Modal, Setting, Notice: class { constructor(message) { notices.push(message); } }, normalizePath: p => p }, { get: (obj, key) => obj[key] ?? class {} });
  mod.require = id => id === 'obsidian' ? obsidian : require(id);
  mod._compile(built.outputFiles[0].text, 'learning-regressions.cjs');
  api = mod.exports;
});
const today = '2026-10-24';
const suggestions = 'Recall/recall-suggestions.md';
const rules = 'Recall/recall-rules.md';
const snap = (init = {}) => ({ kind: 'qa', front: 'What is the subject?', back: 'one two three four five six seven eight nine ten eleven twelve', text: '', extra: '', ...init });
let clock = 0;
const rev = (cardId, before, after, init = {}) => ({ cardId, at: new Date(Date.UTC(2026, 9, 24, 0, 0, clock++)).toISOString(), via: 'edit', instruction: '', before: snap(before), after: snap(after), ...init });
const shortEdits = () => Array.from({ length: 4 }, (_, i) => rev(`card-${i}`, {}, { back: 'one two three four five six' }));
function env(revisions = [], initial = {}) {
  const bytes = new Map(Object.entries(initial));
  const files = new Map([...bytes.keys()].map(p => [p, new TFile(p)]));
  files.set('Recall', new TFolder());
  const app = { vault: {
    getAbstractFileByPath: p => files.get(p),
    cachedRead: async f => { assert.ok(bytes.has(f.path)); return bytes.get(f.path); },
    createFolder: async p => files.set(p, new TFolder()),
    create: async (p, md) => { assert.equal(files.has(p), false, 'create refuses an existing file'); const f = new TFile(p); files.set(p, f); bytes.set(p, md); return f; },
    process: async (f, fn) => { const next = fn(bytes.get(f.path)); bytes.set(f.path, next); f.stat.mtime++; return next; },
  } };
  const host = { app, settings: { schemaFolder: 'Recall' }, store: { revisions: () => revisions } };
  return { bytes, app, host, schema: new api.SchemaFile(host), revisions };
}
const proposal = (id = 'shorter-answers', init = {}) => ({ id, date: today, summary: 'A correction', rule: 'Keep answers to at most 6 words.', evidence: ['synthetic edit'], count: 4, ...init });

test('observer instruction and opening IDs round-trip through status changes', () => {
  const revisions = Array.from({ length: 3 }, (_, i) => rev(`c-${i}`, {}, { front: 'Name this subject?', back: 'short' }, { via: 'rewrite', instruction: 'Use active voice' }));
  for (const observation of api.observe(revisions)) {
    const md = api.renderProposal({ ...observation, date: today });
    const parsed = api.parseProposals(md);
    assert.equal(parsed.length, 1, observation.id);
    assert.equal(parsed[0].id, observation.id);
    const next = api.setProposalStatus(md, parsed[0].occurrenceId ?? parsed[0].id, 'dismissed', today);
    assert.equal(api.parseProposals(next)[0].status, 'dismissed');
  }
});

test('expired reproposal has its own occurrence and dismissal preserves the old decision', async () => {
  const old = api.setProposalStatus(api.renderProposal(proposal('shorter-answers', { date: '2026-08-01' })), 'shorter-answers', 'dismissed', '2026-08-01');
  const f = env(shortEdits(), { [suggestions]: old });
  assert.equal(await f.schema.learn(today), 1);
  const before = await f.schema.proposals();
  assert.equal(new Set(before.map(p => p.occurrenceId)).size, 2);
  await f.schema.dismiss(before[1].occurrenceId, today);
  const after = await f.schema.proposals();
  assert.deepEqual(after.map(p => p.status), ['dismissed', 'dismissed']);
  assert.equal(after[0].statusDate, '2026-08-01');
  assert.equal(after[1].statusDate, today);
});

test('legacy spaced duplicate recovery closes only redundant open occurrences', async () => {
  const p = proposal('instruction:use active voice', { count: 3, rule: 'Use active voice.' });
  const open = api.renderProposal(p);
  const historical = api.setProposalStatus(open, p.id, 'dismissed', '2026-08-01');
  const revisions = Array.from({ length: 3 }, (_, i) => rev(`i-${i}`, {}, { back: 'Short' }, { via: 'rewrite', instruction: 'Use active voice' }));
  const f = env(revisions, { [suggestions]: historical + open + open });
  await f.schema.learn(today);
  const got = await f.schema.proposals();
  assert.equal(got.filter(p => p.status === 'open').length, 1);
  assert.equal(got[0].statusDate, '2026-08-01');
  assert.equal(got.length, 3, 'keep every historical block');
  assert.equal(got[2].status, 'superseded');
  assert.equal(got[2].rule, p.rule, 'keep duplicate wording and evidence');
});

test('overlapping learn calls insert and report one occurrence, including first creation', async () => {
  for (const initial of [{}, { [suggestions]: api.renderEmptySuggestions() }]) {
    const f = env(shortEdits(), initial);
    const counts = await Promise.all([f.schema.learn(today), f.schema.learn(today)]);
    assert.equal(counts.reduce((a, b) => a + b, 0), 1);
    assert.equal((await f.schema.proposals()).filter(p => p.status === 'open').length, 1);
  }
});

test('repeated shortening of one card and full undo do not manufacture support', () => {
  const revisions = [];
  const words = n => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
  for (let n = 12; n > 8; n--) revisions.push(rev('one-card', { back: words(n) }, { back: words(n - 1) }));
  assert.deepEqual(api.observe(revisions), []);
  revisions.push(rev('one-card', { back: words(8) }, { back: words(12) }));
  assert.deepEqual(api.observe(revisions), []);
});

test('net retained corrections count distinct cards even after later unrelated edits', () => {
  const revisions = shortEdits();
  revisions.push(rev('card-0', { back: 'one two three four five six' }, { back: 'one two three four five', extra: 'A note' }));
  revisions.push(rev('card-1', { back: 'one two three four five six' }, { back: 'one two three four five six', extra: 'A note' }));
  const got = api.observe(revisions).find(p => p.id === 'shorter-answers');
  assert.equal(got.count, 4);
  assert.equal(got.rule, 'Keep answers to at most 6 words.');
  revisions.push(rev('card-2', { back: 'one two three four five six' }, {}));
  assert.equal(api.observe(revisions).find(p => p.id === 'shorter-answers'), undefined);
});

test('reversed conversions and superseded rewrite instructions are not retained evidence', () => {
  const conversions = Array.from({ length: 4 }, (_, i) => rev(`c-${i}`, {}, { kind: 'cloze', text: 'A {{c1::subject}}.' }));
  conversions.push(rev('c-0', conversions[0].after, conversions[0].before));
  assert.equal(api.observe(conversions).find(p => p.id === 'prefer-kind:cloze'), undefined);
  const asks = Array.from({ length: 3 }, (_, i) => rev(`r-${i}`, {}, { back: 'Short' }, { via: 'rewrite', instruction: 'Use active voice' }));
  assert.equal(api.observe(asks).find(p => p.id === 'instruction:use active voice').count, 3);
  asks.push(rev('r-0', asks[0].after, asks[0].before));
  assert.equal(api.observe(asks).find(p => p.id === 'instruction:use active voice'), undefined);
});

test('repairs cannot supply shortening evidence in mixed user history', () => {
  const revisions = Array.from({ length: 4 }, (_, i) => rev(`m-${i}`, {}, { back: 'Short' }, { via: 'repair' }));
  for (let i = 0; i < 4; i++) revisions.push(rev(`m-${i}`, { back: 'Short' }, { back: 'Short', extra: 'Manual note' }));
  assert.deepEqual(api.observe(revisions), []);
});

test('learning withdraws contradicted pending rules without changing accepted rules', async () => {
  const f = env(shortEdits());
  await f.schema.learn(today);
  const selected = (await f.schema.proposals())[0];
  await f.schema.accept(selected.occurrenceId, 'My deliberate house rule.', today);
  const accepted = f.bytes.get(rules);
  f.revisions.push(rev('card-0', { back: 'one two three four five six' }, {}));
  f.revisions.push(rev('card-1', { back: 'one two three four five six' }, {}));
  // A second, still-pending occurrence from an earlier session.
  const pending = proposal('shorter-answers', { occurrenceId: 'pending-contradicted' });
  f.bytes.set(suggestions, f.bytes.get(suggestions) + api.renderProposal(pending));
  await f.schema.learn(today);
  const got = await f.schema.proposals();
  assert.equal(got.find(p => p.occurrenceId === pending.occurrenceId).status, 'withdrawn');
  assert.equal(f.schema.openCount(), 0);
  assert.equal(f.bytes.get(rules), accepted);
});

test('Accept revalidates current support even when learn has not run again', async () => {
  const f = env(shortEdits());
  await f.schema.learn(today);
  const selected = (await f.schema.proposals())[0];
  f.revisions.push(rev('card-0', { back: 'one two three four five six' }, {}));
  await assert.rejects(f.schema.accept(selected.occurrenceId, 'My custom rule.', today), /evidence|support/i);
  assert.equal(f.bytes.has(rules), false, 'unsupported Accept does not create the rules note');
  assert.equal((await f.schema.proposals())[0].status, 'open');
});

test('Accept rejects a stale inferred cap but keeps deliberate custom wording', async () => {
  const f = env(shortEdits());
  await f.schema.learn(today);
  const selected = (await f.schema.proposals())[0];
  f.revisions.push(rev('card-0', { back: 'one two three four five six' }, { back: 'one two three four five six seven' }));
  await assert.rejects(f.schema.accept(selected.occurrenceId, selected.rule, today), /evidence|changed/i);
  await f.schema.accept(selected.occurrenceId, '  Keep the context needed for recall.  ', today);
  assert.match(f.bytes.get(rules), /- Keep the context needed for recall\./);
  assert.equal((await f.schema.proposals())[0].status, 'applied');
});

test('partial Accept retries after restart without appending or counting twice', async () => {
  const f = env(shortEdits());
  await f.schema.learn(today);
  const selected = (await f.schema.proposals())[0];
  const process = f.app.vault.process;
  f.app.vault.process = async (file, fn) => {
    if (file.path === suggestions) throw new Error('synthetic status write failure');
    return process(file, fn);
  };
  await assert.rejects(f.schema.accept(selected.occurrenceId, 'The chosen rule.', today), /saved.*retry|retry.*saved/i);
  assert.equal(api.parseSchema(f.bytes.get(rules)).learnedCount, 1);
  assert.equal((await f.schema.proposals())[0].status, 'open');
  assert.equal(api.schemaBlocks(api.parseSchema(f.bytes.get(rules))).cards.includes('recall-accept'), false);
  f.app.vault.process = process;
  // A receipt completes the earlier acceptance even if evidence has since changed.
  f.revisions.length = 0;
  const restarted = new api.SchemaFile(f.host);
  await restarted.accept(selected.occurrenceId, 'Changed retry text must not replace the chosen rule.', today);
  const stored = f.bytes.get(rules);
  assert.equal(api.parseSchema(stored).learnedCount, 1);
  assert.equal(stored.split('- The chosen rule.').length - 1, 1);
  assert.equal(stored.includes('Changed retry text'), false);
  assert.equal((await restarted.proposals())[0].status, 'applied');
});

test('retrying partial Accept with unchanged evidence does not duplicate the rule', async () => {
  const f = env(shortEdits());
  await f.schema.learn(today);
  const selected = (await f.schema.proposals())[0];
  const process = f.app.vault.process;
  f.app.vault.process = async (file, fn) => {
    if (file.path === suggestions) throw new Error('synthetic status write failure');
    return process(file, fn);
  };
  await assert.rejects(f.schema.accept(selected.occurrenceId, selected.rule, today));
  f.app.vault.process = process;
  await f.schema.accept(selected.occurrenceId, selected.rule, today);
  assert.equal(api.parseSchema(f.bytes.get(rules)).learnedCount, 1);
});

test('legacy occurrence identity survives partial Accept and later block insertion', async () => {
  const f = env(shortEdits(), { [suggestions]: api.renderProposal(proposal()) });
  const selected = (await f.schema.proposals())[0];
  const process = f.app.vault.process;
  f.app.vault.process = async (file, fn) => {
    if (file.path === suggestions && api.parseProposals(fn(f.bytes.get(file.path))).some(p => p.status === 'applied')) throw new Error('stamp failure');
    return process(file, fn);
  };
  await assert.rejects(f.schema.accept(selected.occurrenceId, selected.rule, today));
  assert.match(f.bytes.get(suggestions), /<!-- occurrence:/);
  f.app.vault.process = process;
  f.bytes.set(suggestions, api.renderProposal(proposal()) + f.bytes.get(suggestions));
  const restarted = new api.SchemaFile(f.host);
  await restarted.accept(selected.occurrenceId, selected.rule, today);
  assert.deepEqual((await restarted.proposals()).map(p => p.status), ['open', 'applied']);
  assert.equal(api.parseSchema(f.bytes.get(rules)).learnedCount, 1);
});

test('failed rule write leaves the proposal open and permits a safe retry', async () => {
  const f = env(shortEdits(), { [rules]: api.renderDefaultSchema({ today }) });
  await f.schema.learn(today);
  const selected = (await f.schema.proposals())[0];
  const before = f.bytes.get(rules), process = f.app.vault.process;
  f.app.vault.process = async (file, fn) => {
    if (file.path === rules) throw new Error('synthetic first-file failure');
    return process(file, fn);
  };
  await assert.rejects(f.schema.accept(selected.occurrenceId, selected.rule, today), /first-file/);
  assert.equal(f.bytes.get(rules), before);
  assert.equal((await f.schema.proposals())[0].status, 'open');
  f.app.vault.process = process;
  await Promise.all([f.schema.accept(selected.occurrenceId, selected.rule, today), f.schema.accept(selected.occurrenceId, selected.rule, today)]);
  assert.equal(api.parseSchema(f.bytes.get(rules)).learnedCount, 1);
});

test('equal custom rule text from different occurrences is not arbitrarily deduplicated', async () => {
  const revisions = shortEdits();
  revisions.push(...Array.from({ length: 3 }, (_, i) => rev(`i-${i}`, {}, { back: 'Short' }, { via: 'rewrite', instruction: 'Use active voice' })));
  const f = env(revisions);
  await f.schema.learn(today);
  const selected = await f.schema.proposals();
  assert.equal(selected.length, 2);
  for (const p of selected) await f.schema.accept(p.occurrenceId, 'Same deliberate wording.', today);
  assert.equal(api.parseSchema(f.bytes.get(rules)).learnedCount, 2);
  assert.equal(f.bytes.get(rules).split('- Same deliberate wording.').length - 1, 2);
});

test('learning finishes a recorded partial acceptance rather than withdrawing it', async () => {
  const f = env(shortEdits());
  await f.schema.learn(today);
  const selected = (await f.schema.proposals())[0], process = f.app.vault.process;
  f.app.vault.process = async (file, fn) => {
    if (file.path === suggestions) throw new Error('stamp failure');
    return process(file, fn);
  };
  await assert.rejects(f.schema.accept(selected.occurrenceId, selected.rule, today));
  const saved = f.bytes.get(rules);
  f.app.vault.process = process;
  f.revisions.length = 0;
  await f.schema.learn(today);
  assert.equal((await f.schema.proposals())[0].status, 'applied');
  assert.equal(f.bytes.get(rules), saved);
});

test('learning uses evidence current at the atomic transform, not before its await', async () => {
  const f = env(shortEdits(), { [suggestions]: api.renderEmptySuggestions() });
  const process = f.app.vault.process;
  f.app.vault.process = async (file, fn) => {
    f.revisions.length = 0;
    return process(file, fn);
  };
  assert.equal(await f.schema.learn(today), 0);
  assert.equal((await f.schema.proposals()).length, 0);
});

test('Accept reports a partial outcome when its selected occurrence disappears', async () => {
  const f = env(shortEdits());
  await f.schema.learn(today);
  const selected = (await f.schema.proposals())[0], process = f.app.vault.process;
  f.app.vault.process = async (file, fn) => {
    const result = await process(file, fn);
    if (file.path === rules) f.bytes.set(suggestions, api.renderEmptySuggestions());
    return result;
  };
  await assert.rejects(f.schema.accept(selected.occurrenceId, selected.rule, today), /rule is saved/i);
  assert.equal(api.parseSchema(f.bytes.get(rules)).learnedCount, 1);
});

test('persisted deliberate wording survives reconciliation when inferred cap changes', async () => {
  const f = env(shortEdits());
  await f.schema.learn(today);
  const selected = (await f.schema.proposals())[0];
  f.bytes.set(suggestions, f.bytes.get(suggestions).replace(`**Rule:** ${selected.rule}`, '**Rule:** Keep necessary context.'));
  f.revisions.push(rev('card-0', { back: 'one two three four five six' }, { back: 'one two three four five six seven' }));
  await f.schema.learn(today);
  const pending = (await f.schema.proposals()).filter(p => p.status === 'open');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].rule, 'Keep necessary context.');
  await f.schema.accept(pending[0].occurrenceId, pending[0].rule, today);
  assert.match(f.bytes.get(rules), /- Keep necessary context\./);
});

test('Dismiss cannot report a recorded partial acceptance as an unapplied rule', async () => {
  const f = env(shortEdits());
  await f.schema.learn(today);
  const selected = (await f.schema.proposals())[0], process = f.app.vault.process;
  f.app.vault.process = async (file, fn) => {
    if (file.path === suggestions) throw new Error('stamp failure');
    return process(file, fn);
  };
  await assert.rejects(f.schema.accept(selected.occurrenceId, selected.rule, today));
  f.app.vault.process = process;
  await assert.rejects(f.schema.dismiss(selected.occurrenceId, today), /already saved|already applied/i);
  assert.equal((await f.schema.proposals())[0].status, 'open');
  assert.equal(api.parseSchema(f.bytes.get(rules)).learnedCount, 1);
});

test('a historical applied decision supersedes duplicate legacy open blocks', async () => {
  const block = api.renderProposal(proposal());
  const applied = api.setProposalStatus(block, 'shorter-answers', 'applied', '2026-08-01');
  const f = env(shortEdits(), { [suggestions]: applied + block + block });
  assert.equal(await f.schema.learn(today), 0);
  const got = await f.schema.proposals();
  assert.deepEqual(got.map(p => p.status), ['applied', 'superseded', 'superseded']);
  assert.equal(got[0].statusDate, '2026-08-01');
  assert.equal(got.length, 3);
});

test('legacy inferred caps reconcile while legacy custom wording stays deliberate', async () => {
  for (const custom of [false, true]) {
    const p = proposal('shorter-answers', { rule: custom ? 'Keep necessary context.' : 'Keep answers to at most 6 words.' });
    const legacy = api.renderProposal(p).replace(/^<!-- suggested-rule:.*\n/gm, '');
    const f = env(shortEdits(), { [suggestions]: legacy });
    f.revisions.push(rev('card-0', { back: 'one two three four five six' }, { back: 'one two three four five six seven' }));
    await f.schema.learn(today);
    const got = await f.schema.proposals();
    if (custom) {
      assert.equal(got.length, 1);
      assert.equal(got[0].rule, p.rule);
      await f.schema.accept(got[0].occurrenceId, got[0].rule, today);
      assert.match(f.bytes.get(rules), /- Keep necessary context\./);
    } else {
      assert.deepEqual(got.map(p => p.status), ['withdrawn', 'open']);
      assert.equal(got[0].rule, p.rule, 'preserve old wording for recovery');
      assert.equal(got[1].rule, 'Keep answers to at most 7 words.');
    }
  }
});

test('Accept addresses the selected reproposal and keeps the historical dismissal unchanged', async () => {
  const old = api.setProposalStatus(api.renderProposal(proposal('shorter-answers', { date: '2026-08-01' })), 'shorter-answers', 'dismissed', '2026-08-01');
  const f = env(shortEdits(), { [suggestions]: old });
  await f.schema.learn(today);
  const selected = (await f.schema.proposals())[1];
  await f.schema.accept(selected.occurrenceId, selected.rule, today);
  const got = await f.schema.proposals();
  assert.deepEqual(got.map(p => p.status), ['dismissed', 'applied']);
  assert.equal(got[0].statusDate, '2026-08-01');
  assert.equal(api.parseSchema(f.bytes.get(rules)).learnedCount, 1);
});

test('observer output learning stays deduplicated for spaced IDs across repeated runs', async () => {
  const revisions = Array.from({ length: 3 }, (_, i) => rev(`o-${i}`, {}, { front: 'Name this subject?', back: 'Short' }, { via: 'rewrite', instruction: 'Use active voice' }));
  const f = env(revisions);
  assert.equal(await f.schema.learn(today), 2);
  assert.equal(await f.schema.learn(today), 0);
  const got = await f.schema.proposals();
  assert.deepEqual(got.map(p => p.id).sort(), ['drop-opening:what is the', 'instruction:use active voice']);
  assert.equal(f.schema.openCount(), 2);
});

test('existing legacy duplicates recover on refresh without needing another card edit', async () => {
  const p = proposal('instruction:use active voice', { rule: 'Use active voice.' });
  const block = api.renderProposal(p).replace(/^<!-- suggested-rule:.*\n/gm, '');
  const historical = api.setProposalStatus(block, p.id, 'dismissed', '2026-08-01');
  const f = env([], { [suggestions]: historical + block + block });
  await f.schema.refresh();
  assert.equal(f.schema.openCount(), 1);
  const got = await f.schema.proposals();
  assert.deepEqual(got.map(p => p.status), ['dismissed', 'open', 'superseded']);
  assert.equal(got[0].statusDate, '2026-08-01');
  assert.equal(got[2].rule, p.rule);
  assert.equal(f.bytes.has(rules), false);
});

test('startup duplicate recovery preserves a partially accepted occurrence receipt', async () => {
  const f = env(shortEdits());
  await f.schema.learn(today);
  const selected = (await f.schema.proposals())[0], process = f.app.vault.process;
  f.app.vault.process = async (file, fn) => {
    if (file.path === suggestions) throw new Error('stamp failure');
    return process(file, fn);
  };
  await assert.rejects(f.schema.accept(selected.occurrenceId, selected.rule, today));
  f.app.vault.process = process;
  f.bytes.set(suggestions, api.renderProposal(proposal()) + f.bytes.get(suggestions));
  const restarted = new api.SchemaFile(f.host);
  await restarted.refresh();
  assert.deepEqual((await restarted.proposals()).map(p => p.status), ['superseded', 'applied']);
  await restarted.accept(selected.occurrenceId, selected.rule, today);
  assert.equal(api.parseSchema(f.bytes.get(rules)).learnedCount, 1);
});

async function mounted() {
  const revisions = shortEdits();
  revisions.push(...Array.from({ length: 3 }, (_, i) => rev(`i-${i}`, {}, { back: 'Short' }, { via: 'rewrite', instruction: 'Use active voice' })));
  const f = env(revisions);
  await f.schema.learn(today);
  const modal = new api.SchemaSuggestionsModal(f.app, f.schema);
  modal.open();
  await settle();
  assert.equal(nodes(modal.contentEl).filter(n => n.tagName === 'INPUT').length, 2);
  return { ...f, modal };
}

for (const action of ['Accept', 'Dismiss']) test(`${action} preserves the other occurrence's unsaved draft`, async () => {
  const f = await mounted();
  const inputs = nodes(f.modal.contentEl).filter(n => n.tagName === 'INPUT');
  inputs[1].value = 'My carefully edited second rule.';
  inputs[1].events.input?.();
  button(f.modal.contentEl, action).events.click();
  await settle();
  const remaining = nodes(f.modal.contentEl).filter(n => n.tagName === 'INPUT');
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0], inputs[1], 'the other editor stays mounted');
  assert.equal(remaining[0].value, 'My carefully edited second rule.');
  f.modal.close();
});

for (const action of ['Accept', 'Dismiss']) test(`${action} failure explains the error and restores retry controls`, async () => {
  const f = await mounted();
  const input = nodes(f.modal.contentEl).find(n => n.tagName === 'INPUT');
  input.value = 'My retry wording.';
  input.events.input?.();
  const process = f.app.vault.process, before = notices.length;
  f.app.vault.process = async () => { throw new Error('synthetic disk full'); };
  const clicked = button(f.modal.contentEl, action);
  clicked.events.click();
  await settle();
  assert.equal(clicked.disabled, false);
  assert.equal(button(f.modal.contentEl, action === 'Accept' ? 'Dismiss' : 'Accept').disabled, false);
  assert.equal(input.value, 'My retry wording.');
  assert.equal(notices.length, before + 1);
  assert.match(notices.at(-1), /disk full/i);
  f.app.vault.process = process;
  clicked.events.click();
  await settle();
  assert.equal((await f.schema.proposals()).filter(p => p.status === 'open').length, 1);
  f.modal.close();
});

test('partial Accept shows the saved outcome, retains drafts and safely retries', async () => {
  const f = await mounted();
  const inputs = nodes(f.modal.contentEl).filter(n => n.tagName === 'INPUT');
  inputs[0].value = 'Chosen custom wording.';
  inputs[1].value = 'Other draft must survive.';
  const process = f.app.vault.process, before = notices.length;
  f.app.vault.process = async (file, fn) => {
    if (file.path === suggestions) throw new Error('synthetic stamp failure');
    return process(file, fn);
  };
  const accept = button(f.modal.contentEl, 'Accept');
  accept.events.click();
  await settle();
  assert.equal(notices.length, before + 1);
  assert.match(notices.at(-1), /rule is saved.*Retry Accept/);
  assert.equal(accept.disabled, false);
  assert.equal(inputs[0].value, 'Chosen custom wording.');
  assert.equal(inputs[1].value, 'Other draft must survive.');
  assert.equal(api.parseSchema(f.bytes.get(rules)).learnedCount, 1);
  f.app.vault.process = process;
  accept.events.click();
  await settle();
  assert.equal(api.parseSchema(f.bytes.get(rules)).learnedCount, 1);
  assert.equal(nodes(f.modal.contentEl).find(n => n.tagName === 'INPUT'), inputs[1]);
  f.modal.close();
});
