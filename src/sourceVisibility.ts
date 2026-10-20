import { MarkdownRenderChild, Modal, editorInfoField, type MarkdownPostProcessorContext } from "obsidian";
import { Decoration, ViewPlugin, WidgetType, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import type RecallPlugin from "./main";
import type { Highlight } from "./model";
import { passageLabel, passageSummary, resolvePassage } from "./passageHistory";

type Resource = { path?(): string; refresh(): void; destroy(): void; rename?(oldPath: string, newPath: string): void };
type Lifecycle = { stopped: boolean; resources: Set<Resource> };
const lifecycles = new WeakMap<RecallPlugin, Lifecycle>();

/** Same exclusions as Chat. Explicit history never broadens into a vault search. */
function allowed(plugin: RecallPlugin, path: string): boolean {
  if (!path || path.split("/").some(part => !part || part.startsWith("."))) return false;
  const cache = plugin.app.metadataCache as unknown as { isUserIgnored?: (path: string) => boolean } | undefined;
  if (cache?.isUserIgnored?.(path)) return false;
  return ![plugin.app.vault.configDir, plugin.settings.schemaFolder, plugin.settings.exportFolder].some(folder => {
    const root = folder?.replace(/\/+$/, "");
    return root && (path === root || path.startsWith(`${root}/`));
  });
}

function bind(plugin: RecallPlugin, resource: Resource, editorChanges = false): () => void {
  const lifecycle = lifecycles.get(plugin);
  if (lifecycle?.stopped) return () => {};
  lifecycle?.resources.add(resource);
  const unsubscribe = plugin.store.onChange(() => resource.refresh());
  const vault = plugin.app.vault;
  const related = (path: string) => !resource.path || resource.path() === path || resource.path().startsWith(`${path}/`);
  const refs = [
    vault.on("modify", file => { if (related(file.path)) resource.refresh(); }),
    vault.on("delete", file => { if (related(file.path)) resource.refresh(); }),
    vault.on("rename", (file, oldPath) => {
      if (related(oldPath) || related(file.path)) { resource.rename?.(oldPath, file.path); resource.refresh(); }
    }),
  ];
  const workspace = plugin.app.workspace;
  const editorRef = editorChanges ? workspace.on("editor-change", () => resource.refresh()) : null;
  const switchRef = editorChanges ? workspace.on("file-open", () => resource.refresh()) : null;
  return () => {
    unsubscribe();
    for (const ref of refs) vault.offref(ref);
    if (editorRef) workspace.offref(editorRef);
    if (switchRef) workspace.offref(switchRef);
    lifecycle?.resources.delete(resource);
  };
}

/** Reads the current editor snapshot if possible. Never writes to a source note. */
export function openSourceHistory(plugin: RecallPlugin, path: string, selectedId?: string, snapshot?: () => string | null): void {
  if (!lifecycles.get(plugin)?.stopped) new SourceHistoryModal(plugin, path, selectedId, snapshot).open();
}

/** The palette also reaches retained records whose source was deleted. */
export function openCurrentSourceHistory(plugin: RecallPlugin): void {
  if (lifecycles.get(plugin)?.stopped) return;
  const file = plugin.app.workspace.getActiveFile();
  if (file && /^(md|pdf)$/i.test(file.extension)) openSourceHistory(plugin, file.path);
  else new SourcePickerModal(plugin).open();
}

class SourcePickerModal extends Modal {
  private release?: () => void;
  constructor(private plugin: RecallPlugin) { super(plugin.app); }
  onOpen(): void {
    this.release = bind(this.plugin, { refresh: () => this.render(), destroy: () => this.close() });
    this.render();
  }
  onClose(): void { this.release?.(); }
  private render(): void {
    this.titleEl.setText("Captured source history");
    const root = this.contentEl;
    root.empty();
    const paths = [...new Set(this.plugin.store.allHistory().map(h => h.sourcePath))].filter(p => allowed(this.plugin, p)).sort();
    if (!paths.length) root.createEl("p", { text: "No accessible captured sources." });
    for (const path of paths) {
      const button = root.createEl("button", { text: path, cls: "ri-source-choice" });
      button.type = "button";
      button.addEventListener("click", () => { this.close(); openSourceHistory(this.plugin, path); });
    }
  }
}

class SourceHistoryModal extends Modal {
  private release?: () => void;
  private epoch = 0;
  private closed = false;
  private focused = false;
  constructor(private plugin: RecallPlugin, private path: string, private selectedId?: string, private snapshot?: () => string | null) { super(plugin.app); }
  onOpen(): void {
    this.closed = false;
    this.release = bind(this.plugin, {
      path: () => this.path, refresh: () => void this.render(), destroy: () => this.close(),
      rename: (oldPath, newPath) => {
        if (this.path === oldPath || this.path.startsWith(`${oldPath}/`)) {
          this.path = newPath + this.path.slice(oldPath.length);
          this.snapshot = undefined;
        }
      },
    }, true);
    void this.render();
  }
  onClose(): void {
    this.closed = true;
    this.epoch++;
    this.release?.();
    this.contentEl.empty();
  }
  private async render(): Promise<void> {
    if (this.closed) return;
    const epoch = ++this.epoch;
    const path = this.path;
    this.titleEl.setText(`Source history: ${path}`);
    const root = this.contentEl;
    root.empty();
    root.addClass("ri-source-history");
    const picker = root.createEl("button", { text: "Other captured sources", cls: "ri-source-choice" });
    picker.type = "button";
    picker.addEventListener("click", () => { this.close(); new SourcePickerModal(this.plugin).open(); });
    if (!allowed(this.plugin, path)) { root.createEl("p", { text: "Source excluded by access controls." }); return; }
    if (!this.plugin.store.sourceHistory(path).length) { root.createEl("p", { text: "No captured passage history for this source." }); return; }
    let raw: string | null = null;
    let unavailable = "";
    const file = this.plugin.fileAt(path);
    if (file?.extension.toLowerCase() === "pdf") raw = "";
    if (file?.extension.toLowerCase() === "md") {
      const current = this.plugin.activeMarkdown();
      raw = this.snapshot?.() ?? null;
      if (raw === null && current?.file?.path === path && current.getMode() !== "preview") raw = current.editor.getValue();
      if (raw === null) try { raw = await this.plugin.app.vault.read(file); } catch { unavailable = "Source could not be read; saved history remains available."; }
    }
    if (this.closed || epoch !== this.epoch || path !== this.path) return;
    if (!allowed(this.plugin, path)) { root.empty(); root.createEl("p", { text: "Source excluded by access controls." }); return; }
    if (file && (file.path !== path || this.plugin.fileAt(path) !== file)) { raw = null; unavailable = "Source changed while reading; reopen history to verify its location."; }
    for (const h of this.plugin.store.sourceHistory(path)) {
      const item = root.createDiv({ cls: "ri-history-item" });
      const location = unavailable ? { state: "unresolved", reason: unavailable } : resolvePassage(raw, h);
      const { locator, counts } = passageSummary(h);
      item.createEl("h3", { text: h.title || h.heading || (h.page != null ? `Page ${h.page}` : "Captured passage") });
      item.createEl("p", { cls: "ri-history-meta", text: `${h.sourcePath} · ${locator} · ${h.archived ? "Archived" : "Active"} · ${h.status}` });
      item.createEl("blockquote", { text: h.text });
      item.createEl("p", { text: `${location.state}: ${location.reason}` });
      item.createEl("p", { text: passageLabel(h) });
      const pending = h.cards.filter(c => c.status === "pending").length;
      item.createEl("p", { text: `${pending} pending draft${pending === 1 ? "" : "s"}.` });
      if (counts.partial) item.createEl("p", { text: "Partial export (some cards still await export)." });
      else if (counts.full) item.createEl("p", { text: counts.confirmedAnki === counts.created ? "Full export: all retained cards have confirmed Anki IDs." : "Full export status recorded; Anki import is unconfirmed for cards without IDs." });
      if (counts.dismissed) item.createEl("p", { text: "Dismissed capture." });
      for (const card of h.cards) {
        const entry = item.createDiv({ cls: "ri-history-card" });
        const confirmed = card.status === "exported" && Number.isSafeInteger(card.ankiNoteId) && (card.ankiNoteId ?? 0) > 0;
        entry.createEl("p", { text: `${card.kind === "cloze" ? "Cloze" : "Q&A"} · ${card.status}${confirmed ? ` · Anki ID ${card.ankiNoteId}` : card.status === "exported" ? " · export recorded; Anki import unconfirmed" : ""}${card.srNote ? ` · SR note ${card.srNote}` : ""}` });
        if (card.kind === "cloze") entry.createEl("p", { text: card.text });
        else { entry.createEl("p", { text: card.front }); entry.createEl("p", { text: card.back }); }
        if (card.extra) entry.createEl("p", { text: card.extra });
      }
      if (h.id === this.selectedId) {
        item.addClass("ri-history-selected");
        item.tabIndex = -1;
        if (!this.focused) { item.focus(); item.scrollIntoView({ block: "nearest" }); this.focused = true; }
      }
    }
  }
}

class PassageWidget extends WidgetType {
  private label: string;
  constructor(private plugin: RecallPlugin, private path: string, private h: Highlight, private snapshot: () => string | null) {
    super();
    this.label = passageLabel(h); // Records mutate in place; equality must compare the rendered labels.
  }
  eq(other: PassageWidget): boolean { return other.h.id === this.h.id && other.label === this.label && other.path === this.path; }
  toDOM(view: EditorView): HTMLElement {
    const button = view.dom.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "ri-source-mark";
    button.textContent = this.label;
    button.setAttribute("aria-label", `Open source history: ${this.label}`);
    button.addEventListener("click", () => openSourceHistory(this.plugin, this.path, this.h.id, this.snapshot));
    return button;
  }
  ignoreEvent(): boolean { return true; }
}

/** CM6 serves both source mode and Live Preview; the postprocessor serves reading view. */
export function registerSourceVisibility(plugin: RecallPlugin): { refresh(): void; destroy(): void } {
  const lifecycle: Lifecycle = { stopped: false, resources: new Set() };
  lifecycles.set(plugin, lifecycle);
  const extension = ViewPlugin.fromClass(class {
    decorations: DecorationSet = Decoration.none;
    private release: () => void;
    private stopped = false;
    constructor(private view: EditorView) {
      this.release = bind(plugin, { path: () => this.view.state.field(editorInfoField, false)?.file?.path ?? "", refresh: () => this.view.dispatch({}), destroy: () => { this.destroy(); this.view.dispatch({}); } });
      this.refresh();
    }
    update(_update: ViewUpdate): void { this.refresh(); }
    refresh(): void {
      const path = this.view.state.field(editorInfoField, false)?.file?.path ?? "";
      const raw = this.view.state.doc.toString();
      const marks = !this.stopped && !lifecycle.stopped && /\.md$/i.test(path) && allowed(plugin, path) && plugin.fileAt(path) ? plugin.store.sourceHistory(path).flatMap(h => {
        const loc = resolvePassage(raw, h);
        const snapshot = () => !this.stopped && this.view.state.field(editorInfoField, false)?.file?.path === path ? this.view.state.doc.toString() : null;
        return loc.state === "matched" ? [Decoration.widget({ widget: new PassageWidget(plugin, path, h, snapshot), side: 1 }).range(loc.end)] : [];
      }) : [];
      this.decorations = Decoration.set(marks.sort((a, b) => a.from - b.from), true);
    }
    destroy(): void { this.stopped = true; this.decorations = Decoration.none; this.release(); }
  }, { decorations: v => v.decorations });
  plugin.registerEditorExtension(extension);
  plugin.registerMarkdownPostProcessor((el, ctx) => {
    if (!lifecycle.stopped && /\.md$/i.test(ctx.sourcePath)) ctx.addChild(new PassageReadingChild(el, ctx, plugin));
  });
  return {
    refresh: () => { for (const resource of [...lifecycle.resources]) resource.refresh(); },
    destroy: () => {
      lifecycle.stopped = true;
      for (const resource of [...lifecycle.resources]) resource.destroy();
      lifecycle.resources.clear();
    },
  };
}

class PassageReadingChild extends MarkdownRenderChild {
  private release?: () => void;
  private epoch = 0;
  private stopped = false;
  private marks: HTMLElement[] = [];
  constructor(el: HTMLElement, private ctx: MarkdownPostProcessorContext, private plugin: RecallPlugin) { super(el); }
  onload(): void {
    this.release = bind(this.plugin, { path: () => this.ctx.sourcePath, refresh: () => void this.refresh(), destroy: () => this.unload() });
    void this.refresh();
  }
  onunload(): void {
    this.stopped = true;
    this.epoch++;
    this.release?.();
    this.clear();
  }
  private clear(): void { for (const mark of this.marks) mark.remove(); this.marks = []; }
  private async refresh(): Promise<void> {
    const epoch = ++this.epoch;
    this.clear();
    const path = this.ctx.sourcePath;
    if (this.stopped || !allowed(this.plugin, path) || !this.plugin.store.sourceHistory(path).length) return;
    const file = this.plugin.fileAt(path);
    if (!file || file.extension.toLowerCase() !== "md") return;
    let raw: string;
    try { raw = await this.plugin.app.vault.read(file); } catch { return; }
    if (this.stopped || epoch !== this.epoch || this.ctx.sourcePath !== path || file.path !== path || this.plugin.fileAt(path) !== file || !allowed(this.plugin, path)) return;
    const section = this.ctx.getSectionInfo(this.containerEl);
    // Obsidian supplies the whole note plus inclusive section line offsets.
    if (!section || section.text !== raw) return;
    const lines = raw.split("\n");
    if (section.lineStart < 0 || section.lineEnd < section.lineStart || section.lineEnd >= lines.length) return;
    const slice = lines.slice(section.lineStart, section.lineEnd + 1).join("\n");
    const offset = lines.slice(0, section.lineStart).join("\n").length + (section.lineStart ? 1 : 0);
    const end = offset + slice.length;
    const selector = "p, li, blockquote, h1, h2, h3, h4, h5, h6";
    const rendered = [...this.containerEl.querySelectorAll<HTMLElement>(selector)]
      .filter(node => !node.querySelector(selector)).map(node => ({ node, text: node.textContent ?? "" }));
    for (const h of this.plugin.store.sourceHistory(path)) {
      const loc = resolvePassage(raw, h);
      if (loc.state !== "matched" || loc.start < offset || loc.end > end) continue;
      const candidates = rendered.filter(entry => entry.text.includes(h.text));
      // shortcut: complex Markdown and repeated DOM text stay command-only; require an unambiguous rendered node.
      if (candidates.length !== 1 || slice.replace(/==/g, "").split(h.text).length !== 2) continue;
      const button = this.containerEl.ownerDocument.createElement("button");
      button.type = "button";
      button.className = "ri-source-mark";
      button.textContent = passageLabel(h);
      button.setAttribute("aria-label", `Open source history: ${button.textContent}`);
      button.addEventListener("click", () => openSourceHistory(this.plugin, path, h.id));
      candidates[0].node.appendChild(button);
      this.marks.push(button);
    }
  }
}
