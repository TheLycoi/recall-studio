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
function setup({ raw = "quote\n", history = [h()], ignored = () => false } = {}) {
  const listeners = new Set(), reads = [], events = new Events(), workspace = new Events();
  const files = new Map([["a.md", { path: "a.md", extension: "md" }], ["paper.pdf", { path: "paper.pdf", extension: "pdf" }]]);
  const state = { raw, history, active: files.get("a.md"), markdown: null };
  let extension, processor;
  const plugin = { settings: { schemaFolder: "Review Inbox", exportFolder: "Review Inbox/exports" },
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

test("registered CM6 path uses unsaved doc, invalidates on edits, source switches and store refresh", () => {
  const env = setup({ raw: "changed on disk" });
  const e = editor(env, "quote");
  assert.equal(e.marks().length, 1);
  assert.equal(env.reads.length, 0);
  e.view.dispatch({ changes: { from: 0, to: 5, insert: "altered" } });
  assert.equal(e.marks().length, 0);
  e.view.dispatch({ changes: { from: 0, to: 7, insert: "quote" } });
  assert.equal(e.marks().length, 1);
  env.state.active.path = "b.md";
  e.view.dispatch();
  assert.equal(e.marks().length, 0);
  env.state.active.path = "a.md";
  env.changed();
  assert.equal(e.marks().length, 1);
  e.instance.destroy();
  assert.equal(env.listeners.size, 0);
});
test("editor button opens exact saved quote and archived card contents with partial export receipts", async () => {
  const env = setup({ history: [h({ archived: true, cards: [
    { kind: "qa", front: "Question <script>", back: "Exact answer", status: "pending" },
    { kind: "cloze", text: "{{c1::answer}}", status: "exported", ankiNoteId: 42 },
    { kind: "qa", front: "Other", back: "Answer", status: "exported" },
  ] })] });
  const e = editor(env);
  const button = e.marks()[0].widget.toDOM(e.view);
  assert.equal(button.tagName, "button");
  assert.equal(button.type, "button");
  assert.match(button.attributes["aria-label"], /Open source history/);
  button.click(); await settle();
  const modal = opened.at(-1), text = modal.contentEl.textContent;
  for (const fragment of ["quote", "a.md", "Section", "Archived", "Question <script>", "Exact answer", "{{c1::answer}}", "Partial export", "Anki ID 42", "unconfirmed"]) assert.ok(text.includes(fragment), fragment);
  assert.equal(modal.contentEl.querySelector("script"), null);
  assert.doesNotMatch(text, /learned|completion|\d+%/i);
  modal.close(); e.instance.destroy();
  assert.equal(env.listeners.size, 0);
});
test("reading path maps nonzero line ranges from whole-note section.text", async () => {
  const env = setup({ raw: "# Heading\n\nquote\n\nOther section", history: [h()] });
  const r = reading(env, { start: 2, end: 2 });
  await settle();
  assert.equal(r.paragraph.querySelectorAll("button").length, 1);
  r.child.unload();
  assert.equal(r.paragraph.querySelectorAll("button").length, 0);
  assert.equal(env.listeners.size, 0);
  assert.equal(env.events.refs.size, 0);
});
test("reading path refuses stale snapshots, ambiguous repeats, changed quotes and mismapped sections", async () => {
  for (const data of [
    { raw: "quote\nquote", text: "quote\nquote" },
    { raw: "changed", text: "quote" },
    { raw: "quote\n\nother", start: 2, end: 2 },
  ]) {
    const env = setup({ raw: data.raw }); const r = reading(env, data); await settle();
    assert.equal(r.paragraph.querySelectorAll("button").length, 0);
    r.child.unload();
  }
});
test("source command includes unmatched history and PDF page locators without reading the PDF", async () => {
  const env = setup({ raw: "changed", history: [h(), h({ id: "pdf", sourcePath: "paper.pdf", page: 4, subpath: "page=4&selection=abc", archived: true })] });
  api.openCurrentSourceHistory(env.plugin); await settle();
  assert.match(opened.at(-1).contentEl.textContent, /changed:.*quote/);
  opened.at(-1).close();
  env.state.active = env.files.get("paper.pdf");
  env.reads.length = 0;
  api.openCurrentSourceHistory(env.plugin); await settle();
  assert.match(opened.at(-1).contentEl.textContent, /page 4.*page=4&selection=abc/);
  assert.equal(env.reads.length, 0);
  opened.at(-1).close();
});
test("history command offers retained missing sources even while another note is active", async () => {
  const env = setup({ history: [h({ sourcePath: "gone.md", archived: true })] });
  api.openCurrentSourceHistory(env.plugin); await settle();
  const modal = opened.at(-1);
  const choose = modal.contentEl.querySelectorAll("button").find(b => /other captured sources/i.test(b.textContent));
  assert.ok(choose, "current-note history needs a route to archived missing sources");
  choose.click(); await settle();
  const source = opened.at(-1).contentEl.querySelectorAll("button").find(b => b.textContent === "gone.md");
  assert.ok(source); source.click(); await settle();
  assert.match(opened.at(-1).contentEl.textContent, /missing:.*missing/);
  opened.at(-1).close();
});
test("ignored and managed sources are not read or decorated, including a mid-read exclusion", async () => {
  let ignore = false;
  const env = setup({ ignored: () => ignore });
  ignore = true;
  const e = editor(env); assert.equal(e.marks().length, 0); e.instance.destroy();
  const r = reading(env); await settle(); assert.equal(env.reads.length, 0); r.child.unload();
  api.openCurrentSourceHistory(env.plugin); await settle();
  assert.equal(env.reads.length, 0); assert.doesNotMatch(opened.at(-1).contentEl.textContent, /Captured passage|quote/); opened.at(-1).close();
  ignore = false;
  let finish;
  env.plugin.app.vault.read = () => new Promise(resolve => finish = resolve);
  const pending = reading(env); ignore = true; finish("quote\n"); await settle();
  assert.equal(pending.paragraph.querySelectorAll("button").length, 0); pending.child.unload();
  env.state.active.path = "Review Inbox/a.md";
  const managed = editor(env); assert.equal(managed.marks().length, 0); managed.instance.destroy();
});
test("reading and modal async work cannot resurrect after unload or close", async () => {
  const env = setup(); let finish;
  env.plugin.app.vault.read = () => new Promise(resolve => finish = resolve);
  const r = reading(env); r.child.unload(); finish("quote\n"); await settle();
  assert.equal(r.paragraph.querySelectorAll("button").length, 0);
  api.openCurrentSourceHistory(env.plugin);
  const modal = opened.at(-1); modal.close(); finish("quote\n"); await settle();
  assert.equal(modal.contentEl.textContent, "");
  assert.equal(env.listeners.size, 0);
});
test("widgets compare immutable label snapshots when cards mutate in place", () => {
  const record = h(); const env = setup({ history: [record] }); const e = editor(env);
  const original = e.marks()[0].widget;
  record.cards.push({ status: "pending" }); env.changed();
  const updated = e.marks()[0].widget;
  assert.equal(original.eq(updated), false);
  assert.match(updated.toDOM(e.view).textContent, /1 card/);
  assert.equal(updated.ignoreEvent(), true, "native button keyboard events must not become editor commands");
  e.instance.destroy();
});
test("deleting a source removes editor and reading indicators without erasing retained cards", async () => {
  const env = setup({ history: [h({ archived: true })] }); const e = editor(env); const r = reading(env); await settle();
  const file = env.files.get("a.md"); env.files.delete("a.md"); env.events.emit("delete", file); await settle();
  assert.equal(e.marks().length, 0);
  assert.equal(r.paragraph.querySelectorAll("button").length, 0);
  api.openCurrentSourceHistory(env.plugin); await settle();
  assert.match(opened.at(-1).contentEl.textContent, /missing:.*missing/);
  assert.equal(env.state.history.length, 1);
  opened.at(-1).close(); e.instance.destroy(); r.child.unload();
});
test("reading button opens saved history and refreshes a full but unconfirmed export honestly", async () => {
  const record = h({ cards: [{ kind: "qa", front: "Q", back: "A", status: "pending" }] });
  const env = setup({ history: [record] }); const r = reading(env); await settle();
  r.paragraph.querySelector("button").click(); await settle();
  const modal = opened.at(-1); assert.match(modal.contentEl.textContent, /1 pending draft/);
  record.cards[0].status = "exported"; env.changed(); await settle();
  assert.match(modal.contentEl.textContent, /Full export status recorded; Anki import is unconfirmed/);
  assert.doesNotMatch(modal.contentEl.textContent, /Anki ID/);
  modal.close(); r.child.unload();
});
test("open history follows file and folder renames, preserving PDF subpath and source boundaries", async () => {
  const env = setup(); api.openCurrentSourceHistory(env.plugin); await settle();
  const modal = opened.at(-1), file = env.files.get("a.md");
  file.path = "notes/a.md"; env.files.delete("a.md"); env.files.set(file.path, file); env.state.history[0].sourcePath = file.path;
  env.events.emit("rename", file, "a.md"); await settle();
  assert.match(modal.titleEl.textContent, /notes\/a.md/);
  assert.match(modal.contentEl.textContent, /matched:/);
  const folder = { path: "renamed" };
  file.path = "renamed/a.md"; env.files.delete("notes/a.md"); env.files.set(file.path, file); env.state.history[0].sourcePath = file.path;
  env.events.emit("rename", folder, "notes"); await settle();
  assert.match(modal.titleEl.textContent, /renamed\/a.md/);
  modal.close();
});
test("multiple reading labels never become matching text for a later passage", async () => {
  const env = setup({ raw: "quote\n\n1 card", history: [h({ cards: [{ status: "pending" }] }), h({ id: "second", text: "1 card" })] });
  const root = new Element(); root.createEl("p", { text: "quote" }); root.createEl("p", { text: "1 card" });
  let child;
  env.processor(root, { sourcePath: "a.md", getSectionInfo: () => ({ text: env.state.raw, lineStart: 0, lineEnd: 2 }), addChild: c => { child = c; c.load(); } });
  await settle(); assert.equal(root.querySelectorAll("button").length, 2); child.unload();
});
test("a source switch during a pending reading render cannot mark a different note", async () => {
  const env = setup(); let finish;
  env.plugin.app.vault.read = () => new Promise(resolve => finish = resolve);
  const r = reading(env); r.ctx.sourcePath = "b.md"; finish("quote\n"); await settle();
  assert.equal(r.paragraph.querySelectorAll("button").length, 0); r.child.unload();
});
test("no captured history means no source read, and unrelated vault edits do not reread this note", async () => {
  const empty = setup({ history: [] }); const noHistory = reading(empty); await settle();
  assert.equal(empty.reads.length, 0); noHistory.child.unload();
  const env = setup(); const r = reading(env); await settle(); env.reads.length = 0;
  env.events.emit("modify", { path: "unrelated.md" }); await settle();
  assert.equal(env.reads.length, 0); r.child.unload();
});

test("plugin cleanup closes history, removes indicators and listeners before host teardown", async () => {
  const env = setup(); const e = editor(env); const r = reading(env); await settle();
  api.openCurrentSourceHistory(env.plugin); await settle();
  assert.equal(typeof env.controller?.destroy, "function");
  env.controller.destroy();
  assert.equal(opened.at(-1).contentEl.textContent, "");
  assert.equal(r.paragraph.querySelectorAll("button").length, 0);
  assert.equal(e.marks().length, 0);
  assert.equal(env.listeners.size, 0);
  assert.equal(env.events.refs.size, 0);
  assert.equal(env.workspace.refs.size, 0);
  e.instance.destroy();
});
