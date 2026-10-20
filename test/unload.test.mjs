import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sharedBuildOptions } from "../scripts/esbuild-shared.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let PluginClass;
let dir;
let notices;
before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "review-unload-"));
  const out = path.join(dir, "main.cjs");
  const shared = sharedBuildOptions();
  await build({
    ...shared,
    stdin: { contents: 'import Plugin from "./src/main"; export { notices } from "obsidian"; export default Plugin;', resolveDir: root, sourcefile: "unload-probe.ts", loader: "ts" },
    outfile: out,
    logLevel: "error",
    external: shared.external.filter(e => e !== "obsidian" && e !== "@codemirror/view"),
    plugins: [{ name: "obsidian-stub", setup(b) {
      b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ loader: "js", contents: `
        export class Plugin {}
        export class TAbstractFile {}
        export class TFile extends TAbstractFile {}
        export class TFolder extends TAbstractFile {}
        export class ItemView {}
        export class Modal {}
        export class MarkdownRenderChild {}
        export const editorInfoField = {};
        export class SuggestModal {}
        export class PluginSettingTab {}
        export class MarkdownView {}
        export class FileView {}
        export class WorkspaceWindow {}
        export class Editor {}
        export class WorkspaceLeaf {}
        export class Setting {}
        export class ButtonComponent {}
        export const notices = [];
        export class Notice { constructor(message) { notices.push(message); } }
        export const normalizePath = p => p;
        export const addIcon = () => {};
        export const setIcon = () => {};
        export const requestUrl = () => {};
        export const loadPdfJs = () => {};
        export class Menu {}
      ` }));
    } }, { name: "cm-stub", setup(b) {
      b.onResolve({ filter: /^@codemirror\/view$/ }, () => ({ path: "cm", namespace: "stub-cm" }));
      b.onLoad({ filter: /.*/, namespace: "stub-cm" }, () => ({ loader: "js", contents: `
        export class WidgetType {}
        export const Decoration = { none: [], widget: () => ({ range: () => ({ from: 0 }) }), set: xs => xs };
        export const ViewPlugin = { fromClass: c => c };
      ` }));
    } }],
  });
  const mod = createRequire(import.meta.url)(out);
  PluginClass = mod.default;
  notices = mod.notices;
});
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

for (const failing of ["visibility", "abort", "flush", "unsubscribe", "drain"]) {
  test(`registered plugin unload closes the store when ${failing} rejects`, async () => {
    const steps = [];
    const plugin = new PluginClass();
    plugin.generator = { stop: async () => { steps.push("stop"); if (failing === "drain") throw Error("drain failed"); } };
    plugin.unsubscribeStatus = () => { steps.push("unsubscribe"); if (failing === "unsubscribe") throw Error("unsubscribe failed"); };
    plugin.sourceVisibility = { destroy: () => { steps.push("visibility"); if (failing === "visibility") throw Error("visibility failed"); } };
    plugin.llm = { abort: async () => { steps.push("abort"); if (failing === "abort") throw Error("abort failed"); } };
    plugin.store = {
      flush: async () => { steps.push("flush"); if (failing === "flush") throw Error("disk full"); },
      close: () => steps.push("close"),
      get hasUnsavedChanges() { return failing === "flush"; },
    };
    await assert.rejects(plugin.onunload(), failing === "flush" ? /disk full/ : new RegExp(`${failing} failed`));
    assert.deepEqual(steps, ["stop", "unsubscribe", "visibility", "abort", "flush", "close"]);
    if (failing === "flush") assert.ok(notices.some(n => /not yet durable|not saved|unsaved/.test(n)));
  });
}
