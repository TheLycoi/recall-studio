import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { sharedBuildOptions } from "../scripts/esbuild-shared.mjs";
const require = createRequire(import.meta.url);
let api, dir;
const rows = [];
class Setting {
  constructor() { rows.push(this); this.settingEl = { show() {}, hide() {} }; }
  setName(v) { this.name = v; return this; }
  setDesc(v) { this.desc = v; return this; }
  setHeading() { return this; }
}
for (const kind of ["Text", "TextArea", "Toggle", "Dropdown", "Slider", "Button"]) {
  Setting.prototype[`add${kind}`] = function(fn) {
    const row = this;
    const control = new Proxy({ inputEl: {} }, { get(target, key) {
      if (key in target) return target[key];
      return v => { if (key === "onChange") row.change = v; if (key === "setValue") row.value = v; return control; };
    } });
    fn(control); return this;
  };
}
class PluginSettingTab { constructor() { this.containerEl = { empty() { rows.length = 0; }, insertBefore() {} }; } }
before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sr-settings-"));
  const out = path.join(dir, "settings.cjs");
  await build({ ...sharedBuildOptions(), entryPoints: ["src/settings.ts"], outfile: out, logLevel: "silent" });
  const mod = new Module(out); mod.filename = out; mod.paths = Module._nodeModulePaths(process.cwd());
  mod.require = name => name === "obsidian" ? { Setting, PluginSettingTab } : require(name);
  mod._compile(readFileSync(out, "utf8"), out); api = mod.exports;
});
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
test("real settings tab exposes default-off explicit scope and all recognized syntax, without an SR installation", () => {
  let saved = 0;
  const plugin = { settings: { ...api.DEFAULT_SETTINGS }, saveSettings() { saved++; return Promise.resolve(); } };
  new api.RecallSettingTab({}, plugin).display();
  const toggle = rows.find(r => r.name === "Recognize existing SR cards");
  assert.ok(toggle); assert.equal(toggle.value, false);
  assert.match(toggle.desc, /read.only/i); assert.match(toggle.desc, /not detected/i);
  assert.equal(plugin.settings.srRecognitionTags, "");
  assert.equal(plugin.settings.srRecognitionNotePaths, "");
  toggle.change(true); assert.equal(plugin.settings.srRecognitionEnabled, true);
  for (const [name, key, value] of [
    ["SR body tags", "srRecognitionTags", "#learn"],
    ["SR note paths", "srRecognitionNotePaths", "notes/a.md"],
    ["SR single-line separator", "srSingleLineSeparator", "->"],
    ["SR reversed single-line separator", "srSingleLineReversedSeparator", "<->"],
    ["SR multiline separator", "srMultilineSeparator", "ANSWER"],
    ["SR reversed multiline separator", "srMultilineReversedSeparator", "BOTH"],
    ["SR multiline end marker", "srMultilineEndMarker", "END"],
  ]) {
    const row = rows.find(r => r.name === name); assert.ok(row, name);
    row.change(value); assert.equal(plugin.settings[key], value);
  }
  const cloze = rows.find(r => r.name === "SR plain highlight clozes"); assert.ok(cloze);
  cloze.change(false); assert.equal(plugin.settings.srHighlightCloze, false);
  assert.equal(saved, 9);
});
