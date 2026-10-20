import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { sharedBuildOptions } from "../scripts/esbuild-shared.mjs";
import { EditorState, StateField } from "@codemirror/state";

// Real CM6 state, ViewPlugin, DecorationSet and widgets; only Obsidian and DOM
// mounting are doubled. getSectionInfo.text is the whole note, not the section.
const require = createRequire(import.meta.url);
require("@codemirror/view"); // Load CM before installing the minimal detached DOM.
const editorInfoField = StateField.define({ create: () => ({}), update: v => v });
class Element {
  constructor(tag = "div") { this.tagName = tag; this.children = []; this.listeners = new Map(); this.attributes = {}; this.ownerDocument = documentStub; this._text = ""; this.className = ""; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(""); }
  set textContent(v) { this._text = v; this.children = []; }
  setText(v) { this.textContent = v; }
  empty() { this.textContent = ""; }
  addClass(c) { this.className += ` ${c}`; }
  setAttribute(k, v) { this.attributes[k] = v; }
  addEventListener(k, fn) { this.listeners.set(k, fn); }
  click() { this.listeners.get("click")?.({ preventDefault() {}, stopPropagation() {} }); }
  appendChild(el) { el.parent = this; this.children.push(el); return el; }
  createEl(tag, opts = {}) { const el = new Element(tag); el.textContent = opts.text ?? ""; el.className = opts.cls ?? ""; return this.appendChild(el); }
  createDiv(opts) { return this.createEl("div", opts); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  querySelectorAll(selector) { const tags = selector.split(",").map(t => t.trim()); return this.children.flatMap(c => [...(tags.includes(c.tagName) ? [c] : []), ...c.querySelectorAll(selector)]); }
  querySelector(s) { return this.querySelectorAll(s)[0] ?? null; }
  scrollIntoView() {}
  focus() { this.focused = true; }
}
const documentStub = { createElement: tag => new Element(tag) };
const opened = [];
class Modal {
  constructor(app) { this.app = app; this.contentEl = new Element(); this.titleEl = new Element("h1"); }
  open() { opened.push(this); this.onOpen(); }
  close() { this.onClose?.(); this.contentEl.empty(); }
}
class MarkdownRenderChild {
  constructor(el) { this.containerEl = el; this.refs = []; }
  registerEvent(ref) { this.refs.push(ref); }
  load() { this.onload(); }
  unload() { this.onunload(); for (const ref of this.refs) ref.bus.offref(ref); this.refs = []; }
}
class Events {
  refs = new Set();
  on(name, fn) { const ref = { bus: this, name, fn }; this.refs.add(ref); return ref; }
  offref(ref) { this.refs.delete(ref); }
  emit(name, ...args) { for (const ref of [...this.refs]) if (ref.name === name) ref.fn(...args); }
}
let api, dir;
before(async () => {
  globalThis.document = documentStub;
  dir = mkdtempSync(path.join(tmpdir(), "source-visibility-"));
  const out = path.join(dir, "visibility.cjs");
  await build({ ...sharedBuildOptions(), entryPoints: ["src/sourceVisibility.ts"], outfile: out, logLevel: "silent" });
  const mod = new Module(out);
  mod.filename = out;
  mod.paths = Module._nodeModulePaths(process.cwd());
  mod.require = name => name === "obsidian" ? { Modal, MarkdownRenderChild, editorInfoField } : require(name);
  mod._compile(readFileSync(out, "utf8"), out);
  api = mod.exports;
});
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
const h = (over = {}) => ({ id: "h", sourcePath: "a.md", text: "quote", before: "", after: "", heading: "Section", blockId: null, page: null, cards: [], status: "ready", ...over });
const settle = async () => { await new Promise(r => setImmediate(r)); };
function setup({ raw = "quote\n", history = [], ignored = () => false, settings = {} } = {}) {
  const listeners = new Set(), reads = [], events = new Events(), workspace = new Events();
  const files = new Map([["a.md", { path: "a.md", extension: "md" }], ["paper.pdf", { path: "paper.pdf", extension: "pdf" }]]);
  const state = { raw, history, active: files.get("a.md"), markdown: null };
  let extension, processor;
  const plugin = { settings: { schemaFolder: "Review Inbox", exportFolder: "Review Inbox/exports", ...settings },
    app: { metadataCache: { isUserIgnored: ignored }, vault: Object.assign(events, { configDir: ".obsidian", read: async file => { reads.push(file.path); return state.raw; } }),
      workspace: Object.assign(workspace, { getActiveFile: () => state.active }) },
    activeMarkdown: () => state.markdown,
    fileAt: p => files.get(p) ?? null,
    store: { sourceHistory: p => state.history.filter(h => h.sourcePath === p), allHistory: () => state.history,
      onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); } },
    registerEditorExtension: x => extension = x,
    registerMarkdownPostProcessor: x => processor = x };
  const controller = api.registerSourceVisibility(plugin);
  return { plugin, state, files, listeners, reads, events, workspace, extension, processor, controller,
    changed: () => { for (const fn of [...listeners]) fn(); } };
}
function editor(env, raw = env.state.raw) {
  const file = env.state.active;
  let instance;
  const view = { dom: new Element(), state: EditorState.create({ doc: raw, extensions: [editorInfoField.init(() => ({ file }))] }),
    dispatch(spec = {}) { const tr = this.state.update(spec); this.state = tr.state; instance.update({ state: this.state, docChanged: tr.docChanged, view: this }); } };
  instance = env.extension.create(view);
  const marks = () => { const found = []; instance.decorations.between(0, view.state.doc.length, (from, to, value) => found.push({ from, to, widget: value.spec.widget })); return found; };
  return { view, instance, marks };
}
function reading(env, { start = 0, end = env.state.raw.split("\n").length - 1, text = env.state.raw, rendered = "quote" } = {}) {
  const root = new Element();
  const paragraph = root.createEl("p", { text: rendered });
  let child;
  const ctx = { sourcePath: "a.md", getSectionInfo: () => ({ lineStart: start, lineEnd: end, text }), addChild: c => { child = c; c.load(); } };
  env.processor(root, ctx);
  return { root, paragraph, child, ctx };
}

const sr = { srRecognitionEnabled: true, srRecognitionTags: "#cards" };
test("registered editor SR indicator is opt-in, exact, unsaved and separate from capture receipts", async () => {
  const raw = "#cards\n\nProse\n\nQ::A <!--SR:!2026-10-20,1,250-->\n\nProse";
  const off = setup({ raw }); const disabled = editor(off);
  assert.equal(disabled.marks().length, 0); disabled.instance.destroy();
  const env = setup({ raw: "disk differs", settings: sr }); const e = editor(env, raw);
  assert.equal(e.marks().length, 1);
  assert.equal(e.marks()[0].from, raw.indexOf("Q::A") + 4);
  const button = e.marks()[0].widget.toDOM(e.view);
  assert.match(button.textContent, /Existing SR card/);
  assert.match(button.attributes["aria-label"], /existing SR card/i);
  assert.doesNotMatch(button.textContent, /created|Anki|awaiting/);
  button.click(); await settle();
  const modal = opened.at(-1);
  assert.match(modal.contentEl.textContent, /Existing SR card.*basic/);
  assert.match(modal.contentEl.textContent, /Q::A/);
  assert.doesNotMatch(modal.contentEl.textContent, /SR:|1 card created|Anki ID/);
  assert.equal(env.state.history.length, 0); assert.equal(env.reads.length, 0);
  e.view.dispatch({ changes: { from: 0, to: e.view.state.doc.length, insert: "#cards\n\nNo card" } });
  env.workspace.emit("editor-change"); await settle();
  assert.equal(e.marks().length, 0);
  assert.doesNotMatch(modal.contentEl.textContent, /Q::A/);
  modal.close(); env.controller.destroy();
  assert.equal(env.workspace.refs.size, 0);
});
test("container code has no registered SR indicator or history entry and leaves adjacent prose uncovered", async () => {
  for (const block of [
    "> ```\n> Not a question::Not an answer\n> ```",
    "- ~~~\n  Not a question::Not an answer\n  ~~~",
  ]) {
    const env = setup({ raw: block, settings: { srRecognitionEnabled: true, srRecognitionNotePaths: "a.md" } });
    let writes = 0;
    for (const method of ["modify", "create", "append", "process"]) env.plugin.app.vault[method] = () => { writes++; throw new Error("Recognition must not write source notes"); };
    const e = editor(env);
    assert.deepEqual(e.marks(), [], block);
    const code = reading(env, { start: 1, end: 1, rendered: block.split("\n")[1] }); await settle();
    assert.equal(code.paragraph.querySelectorAll("button").length, 0);
    api.openCurrentSourceHistory(env.plugin); await settle();
    assert.doesNotMatch(opened.at(-1).contentEl.textContent, /Existing SR card|Not a question/);
    opened.at(-1).close(); code.child.unload();
    assert.equal(env.state.raw, block);
    assert.deepEqual(env.state.history, []);

    const raw = `Before::Answer\n\n${block}\n\nAfter:::Answer\n\nAdjacent prose`;
    env.state.raw = raw;
    e.view.dispatch({ changes: { from: 0, to: e.view.state.doc.length, insert: raw } });
    assert.deepEqual(e.marks().map(m => m.from), ["Before::Answer".length, raw.indexOf("After:::Answer") + "After:::Answer".length]);
    for (const mark of e.marks()) assert.match(mark.widget.toDOM(e.view).textContent, /Existing SR card/);
    const before = reading(env, { start: 0, end: 0, rendered: "Before::Answer" });
    const after = reading(env, { start: 6, end: 6, rendered: "After:::Answer" });
    const prose = reading(env, { start: 8, end: 8, rendered: "Adjacent prose" });
    await settle();
    assert.equal(before.paragraph.querySelectorAll("button").length, 1);
    assert.equal(after.paragraph.querySelectorAll("button").length, 1);
    assert.equal(prose.paragraph.querySelectorAll("button").length, 0);
    assert.equal(writes, 0);
    assert.equal(env.state.raw, raw);
    assert.deepEqual(env.state.history, []);
    before.child.unload(); after.child.unload(); prose.child.unload();
    e.instance.destroy(); env.controller.destroy();
  }
});
test("reading SR marker requires one exact whole section card, and invalidates on unsaved edits/exclusion/unload", async () => {
  let ignore = false;
  const raw = "#cards\n\nQ::A\n\nNearby prose";
  const env = setup({ raw, settings: sr, ignored: () => ignore });
  const r = reading(env, { start: 2, end: 2, rendered: "Q::A" }); await settle();
  assert.equal(r.paragraph.querySelectorAll("button").length, 1);
  r.paragraph.querySelector("button").click(); await settle();
  assert.match(opened.at(-1).contentEl.textContent, /Existing SR card/); opened.at(-1).close();
  env.state.markdown = { file: env.state.active, getMode: () => "source", editor: { getValue: () => "#cards\n\nEdited" } };
  env.workspace.emit("editor-change"); await settle();
  assert.equal(r.paragraph.querySelectorAll("button").length, 0);
  env.state.markdown = null; env.controller.refresh(); await settle();
  assert.equal(r.paragraph.querySelectorAll("button").length, 1);
  ignore = true; env.controller.refresh(); await settle();
  assert.equal(r.paragraph.querySelectorAll("button").length, 0);
  ignore = false; env.controller.refresh(); await settle(); env.controller.destroy();
  assert.equal(r.paragraph.querySelectorAll("button").length, 0);
  assert.equal(env.events.refs.size, 0); assert.equal(env.workspace.refs.size, 0);
});
test("inactive registered unsaved editors and changed file versions revoke reading SR indicators", async () => {
  const raw = "#cards\n\nQ::A";
  const env = setup({ raw, settings: sr });
  const e = editor(env, "#cards\n\nChanged");
  const r = reading(env, { start: 2, end: 2, rendered: "Q::A" }); await settle();
  assert.equal(r.paragraph.querySelectorAll("button").length, 0);
  api.openCurrentSourceHistory(env.plugin); await settle();
  assert.doesNotMatch(opened.at(-1).contentEl.textContent, /Q::A/); opened.at(-1).close();
  e.instance.destroy(); r.child.unload();
  const file = env.files.get("a.md"); file.stat = { mtime: 1, size: raw.length };
  let finish; env.plugin.app.vault.read = () => new Promise(resolve => finish = resolve);
  const pending = reading(env, { start: 2, end: 2, rendered: "Q::A" });
  file.stat.mtime = 2; finish(raw); await settle();
  assert.equal(pending.paragraph.querySelectorAll("button").length, 0); pending.child.unload();
});
test("history rechecks unsaved editor content after an asynchronous saved-file read", async () => {
  const raw = "#cards\n\nQ::A";
  const env = setup({ raw, settings: sr }); let finish;
  env.plugin.app.vault.read = () => new Promise(resolve => finish = resolve);
  api.openCurrentSourceHistory(env.plugin);
  const modal = opened.at(-1);
  const e = editor(env, "#cards\n\nChanged");
  finish(raw); await settle();
  assert.doesNotMatch(modal.contentEl.textContent, /Q::A/);
  modal.close(); env.controller.destroy(); e.instance.destroy();
});
test("SR scope changes, ignored paths, source deletion and unload leave retained capture counts untouched", async () => {
  let ignored = false;
  const record = h({ text: "Prose", cards: [{ status: "pending" }] });
  const raw = "#cards\n\nQ::A\n\nProse";
  const env = setup({ raw, settings: sr, history: [record], ignored: () => ignored });
  const e = editor(env);
  assert.equal(e.marks().length, 2);
  assert.match(e.marks().find(m => m.from === raw.length).widget.toDOM(e.view).textContent, /1 card created.*1 awaiting.*0 Anki confirmed/);
  env.plugin.settings.srRecognitionEnabled = false; env.controller.refresh();
  assert.equal(e.marks().length, 1);
  env.plugin.settings.srRecognitionEnabled = true;
  env.plugin.settings.srRecognitionTags = "#other"; env.controller.refresh();
  assert.equal(e.marks().length, 1);
  env.plugin.settings.srRecognitionTags = "#cards"; env.controller.refresh();
  assert.equal(e.marks().length, 2);
  ignored = true; env.controller.refresh(); assert.equal(e.marks().length, 0);
  ignored = false; env.controller.refresh(); assert.equal(e.marks().length, 2);
  const file = env.files.get("a.md"); env.files.delete("a.md"); env.events.emit("delete", file);
  assert.equal(e.marks().length, 0);
  assert.equal(env.state.history.length, 1); assert.equal(record.cards.length, 1);
  env.controller.destroy(); assert.equal(env.listeners.size, 0);
});
test("reading SR refuses nearby-prose nodes, repeats and stale async results", async () => {
  for (const data of [
    { raw: "#cards\n\nQ::A\n\nNearby prose", start: 4, end: 4, rendered: "Q::A" },
    { raw: "#cards\n\nQ::A\n\nNearby prose", start: 2, end: 4, rendered: "Q::A Nearby prose" },
    { raw: "#cards\n\nQ::A\nQ::A", start: 2, end: 3, rendered: "Q::A" },
  ]) {
    const env = setup({ raw: data.raw, settings: sr }); const r = reading(env, data); await settle();
    assert.equal(r.paragraph.querySelectorAll("button").length, 0); r.child.unload();
  }
  const env = setup({ raw: "#cards\n\nQ::A", settings: sr }); let finish;
  env.plugin.app.vault.read = () => new Promise(resolve => finish = resolve);
  const r = reading(env, { start: 2, end: 2, rendered: "Q::A" });
  env.controller.destroy(); finish(env.state.raw); await settle();
  assert.equal(r.paragraph.querySelectorAll("button").length, 0);
});
