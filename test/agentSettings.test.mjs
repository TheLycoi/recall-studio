import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
let m;
class Control {
  options = {}; inputEl = {};
  addOption(k, v) { this.options[k] = v; return this; }
  addOptions(v) { Object.assign(this.options, v); return this; }
  setValue(v) { this.value = v; return this; }
  onChange(f) { this.change = f; return this; }
  onClick(f) { this.click = f; return this; }
  setPlaceholder() { return this; } setButtonText() { return this; }
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
  mod.require = id => id === 'obsidian' ? { Setting, PluginSettingTab: class { constructor() { this.containerEl = { rows: [], empty() { this.rows.length = 0; }, insertBefore() {} }; } } } : Module.createRequire(import.meta.url)(id);
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
