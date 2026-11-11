import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
let m;
const modals = [], notices = [];
class Modal {
  constructor(app) { this.app = app; this.contentEl = { rows: [], createEl() {}, empty() { this.rows = []; } }; modals.push(this); }
  open() { this.onOpen(); }
  close() { this.closed = true; this.onClose?.(); }
}
class Control {
  options = {}; inputEl = {};
  addOption(k, v) { this.options[k] = v; return this; }
  addOptions(v) { Object.assign(this.options, v); return this; }
  setValue(v) { this.value = v; return this; }
  onChange(f) { this.change = v => { this.value = v; return f(v); }; return this; }
  onClick(f) { this.click = f; return this; }
  setPlaceholder() { return this; } setButtonText(v) { this.label = v; return this; }
  setDisabled() { return this; } setLimits() { return this; } setDynamicTooltip() { return this; }
}
class Setting {
  constructor(root) { root.rows.push(this); this.settingEl = { show() {}, hide() {} }; }
  setName(v) { this.name = v; return this; } setDesc(v) { this.description = v; return this; } setHeading() { return this; }
  addDropdown(f) { this.dropdown = new Control(); f(this.dropdown); return this; }
  addText(f) { this.text = new Control(); f(this.text); return this; }
  addTextArea(f) { return this.addText(f); } addSlider(f) { return this.addText(f); } addToggle(f) { return this.addText(f); }
  addButton(f) { this.button = new Control(); f(this.button); return this; }
}
before(async () => {
  const out = await build({ entryPoints: ['src/settings.ts'], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['obsidian'], logLevel: 'silent' });
  const mod = new Module('agent-settings');
  mod.require = id => id === 'obsidian' ? { Setting, Modal, Notice: class { constructor(text) { notices.push(text); } }, PluginSettingTab: class { constructor() { this.containerEl = { rows: [], empty() { this.rows.length = 0; }, insertBefore() {} }; } } } : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text, 'agent-settings'); m = mod.exports;
});
for (const provider of ['codex', 'deepseek', 'opencode']) test(`${provider}: Agents controls save, reload and isolate provider models`, () => {
  let saved;
  const host = { settings: { ...m.DEFAULT_SETTINGS, provider, knownModels: ['test-strong', 'test-cheap'], cheapModels: { codex: 'prior-codex', deepseek: 'prior-deepseek', opencode: 'prior-opencode' } }, saveSettings() { saved = JSON.stringify(this.settings); } };
  const tab = new m.RecallSettingTab({}, host); tab.display();
  const row = name => { const value = tab.containerEl.rows.find(r => r.name === name); assert.ok(value, name); return value; };
  row('Agents');
  assert.equal(m.DEFAULT_SETTINGS.modelMode, 'unified');
  assert.equal(row('Model mode').dropdown.value, 'unified');
  assert.deepEqual(row('Model mode').dropdown.options, { unified: 'Unified model', split: 'Strong / Cheap' });
  row('Model'); row('Effort');
  assert.ok(!tab.containerEl.rows.some(r => /^(Strong|Cheap|Model roles)/.test(r.name)));
  row('Model mode').dropdown.change('split');
  assert.equal(host.settings.modelMode, 'split');
  row('Strong model').dropdown.change('test-strong'); row('Strong effort').dropdown.change('high');
  row('Cheap model').dropdown.change('test-cheap'); row('Cheap effort').dropdown.change('medium');
  assert.equal(host.settings[`${provider}Model`], 'test-strong');
  assert.equal(host.settings.cheapModels[provider], 'test-cheap'); assert.equal(host.settings.cheapEffort, 'medium');
  for (const p of ['codex', 'deepseek', 'opencode'].filter(p => p !== provider)) assert.equal(host.settings.cheapModels[p], `prior-${p}`);
  host.settings = JSON.parse(saved); tab.display();
  assert.equal(row('Cheap model').dropdown.value, 'test-cheap'); assert.equal(row('Cheap effort').dropdown.value, 'medium');
  row('Cheap model: type an id').text.change(' custom/model '); assert.equal(host.settings.cheapModels[provider], 'custom/model');
  row('Model mode').dropdown.change('unified');
  assert.ok(!tab.containerEl.rows.some(r => /^(Strong|Cheap|Model roles)/.test(r.name)));
  assert.equal(host.settings.cheapModels[provider], 'custom/model');
  assert.equal(host.settings.cheapEffort, 'medium');
  host.settings = JSON.parse(saved); tab.display();
  assert.equal(row('Model mode').dropdown.value, 'unified'); row('Model');
  row('Model mode').dropdown.change('split');
  assert.equal(row('Cheap model').dropdown.value, 'custom/model');
  assert.equal(row('Cheap effort').dropdown.value, 'medium');
  row('Cheap model').dropdown.change(''); row('Cheap effort').dropdown.change('');
  assert.equal(host.settings.cheapModels[provider], undefined); assert.equal(host.settings.cheapEffort, undefined);
  assert.equal(host.settings.language, m.DEFAULT_SETTINGS.language);
});

for (const provider of ['codex', 'deepseek', 'opencode']) test(`${provider}: independent grader selection persists without overwriting other roles`, () => {
  let saved;
  const host = { settings: { ...m.DEFAULT_SETTINGS, provider, modelMode: 'split', graderModels: { codex: 'old-codex', deepseek: 'old-deepseek', opencode: 'old-opencode' } }, saveSettings() { saved = JSON.stringify(this.settings); } };
  const tab = new m.RecallSettingTab({}, host); tab.display();
  const row = n => tab.containerEl.rows.find(r => r.name === n);
  assert.match(row('Model roles').description, /Cheap.*read/i);
  assert.match(row('Cheap model').description, /reader/i);
  row('Grader model: type an id').text.change(' separate-judge ');
  row('Grader effort').dropdown.change('low');
  host.settings = JSON.parse(saved); tab.display();
  assert.equal(row('Grader model').dropdown.value, 'separate-judge');
  assert.equal(row('Grader effort').dropdown.value, 'low');
  for (const p of ['codex','deepseek','opencode'].filter(p => p !== provider)) assert.equal(host.settings.graderModels[p], `old-${p}`);
  row('Grader model').dropdown.change(''); row('Grader effort').dropdown.change('');
  assert.equal(host.settings.graderModels[provider], undefined); assert.equal(host.settings.graderEffort, undefined);
});

test('system prompt editor saves, reloads, cancels and restores only its selected prompt', async () => {
  let saved;
  const host = { settings: { ...m.DEFAULT_SETTINGS, systemPrompts: { reader: 'Keep reader unchanged' } }, async saveSettings() { saved = JSON.stringify(this.settings); } };
  const tab = new m.RecallSettingTab({}, host); tab.display();
  const open = () => { tab.containerEl.rows.find(r => r.name === 'Writer prompt').button.click(); return modals.at(-1); };
  const control = (modal, label) => modal.contentEl.rows.find(r => r.button?.label === label)?.button;
  let modal = open(); let editor = modal.contentEl.rows.find(r => r.text).text;
  assert.match(editor.value, /main flashcard writer/);
  editor.change('My writing instructions');
  assert.equal(host.settings.systemPrompts.writer, undefined, 'typing must not save');
  control(modal, 'Cancel').click(); assert.equal(host.settings.systemPrompts.writer, undefined);
  modal = open(); editor = modal.contentEl.rows.find(r => r.text).text; editor.change('My writing instructions');
  await control(modal, 'Save').click(); assert.equal(modal.closed, true);
  host.settings = JSON.parse(saved); tab.display(); modal = open(); editor = modal.contentEl.rows.find(r => r.text).text;
  assert.equal(editor.value, 'My writing instructions');
  control(modal, 'Restore default').click(); assert.match(editor.value, /main flashcard writer/);
  assert.equal(host.settings.systemPrompts.writer, 'My writing instructions', 'reset is a draft until saved');
  await control(modal, 'Save').click(); assert.equal(host.settings.systemPrompts.writer, undefined);
  assert.equal(host.settings.systemPrompts.reader, 'Keep reader unchanged');
});

test('retired Learn controls stay absent while every system prompt remains editable', () => {
  const legacy = { learnSkillPath: '/old/skill', learnDataPath: '/old/data', learnPythonPath: '/old/python' };
  const host = { settings: { ...m.DEFAULT_SETTINGS, ...legacy }, saveSettings() { throw Error('Rendering must not save'); } };
  const tab = new m.RecallSettingTab({}, host); tab.display();
  const names = tab.containerEl.rows.map(r => r.name ?? '');
  assert.ok(!names.some(n => /LearnHarness|Open Learn|Skill folder|Python executable/.test(n)));
  for (const name of ['Shared writing method', 'Reader prompt', 'Writer prompt', 'Grader prompt']) {
    assert.equal(tab.containerEl.rows.find(r => r.name === name)?.button?.label, 'Open prompt', name);
  }
  for (const [key, value] of Object.entries(legacy)) {
    assert.equal(host.settings[key], value);
    assert.equal(Object.hasOwn(m.DEFAULT_SETTINGS, key), false);
  }
});

test('prompt editor refuses invalid or stale changes and retains a failed-save draft', async () => {
  const host = { settings: { ...m.DEFAULT_SETTINGS }, async saveSettings() { throw Error('Synthetic disk failure'); } };
  const tab = new m.RecallSettingTab({}, host); tab.display();
  const open = () => { tab.containerEl.rows.find(r => r.name === 'Writer prompt').button.click(); return modals.at(-1); };
  let modal = open(), editor = modal.contentEl.rows.find(r => r.text).text;
  const save = modal => modal.contentEl.rows.find(r => r.button?.label === 'Save').button.click();
  for (const bad of ['', 'a'.repeat(30001)]) { editor.change(bad); await save(modal); assert.equal(modal.closed, undefined); assert.equal(host.settings.systemPrompts, undefined); }
  editor.change('unsaved draft'); await save(modal);
  assert.equal(host.settings.systemPrompts?.writer, undefined); assert.equal(editor.value, 'unsaved draft');
  assert.match(notices.at(-1), /could not save/i);
  modal = open(); editor = modal.contentEl.rows.find(r => r.text).text; editor.change('older draft');
  host.settings.systemPrompts = { writer: 'newer change' }; await save(modal);
  assert.equal(host.settings.systemPrompts.writer, 'newer change'); assert.match(notices.at(-1), /changed/i);
});
