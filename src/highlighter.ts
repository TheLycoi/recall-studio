import { FileView, MarkdownView, Notice, WorkspaceWindow } from "obsidian";
import type WikiLmPlugin from "./main";
import { captureReadingSelection, capturePdfSelection, captureSelection } from "./capture";
import { isPdfFile, readPdfSelection } from "./pdf";
import { normalizeWs } from "./util";
import { WIKILM_HIGHLIGHT_ICON } from "./icon";

/**
 * Highlighter mode: pick up the pen, drag across a passage, and it is
 * highlighted and sent to the inbox with no key pressed. Works in the
 * markdown editor (source and live preview), in reading view, and in
 * Obsidian's PDF viewer.
 *
 * Gesture rules, learned the hard way in Loopback:
 * - Only a drag that *started* inside the active file view counts. Where the
 *   mouse is released is not checked, because dragging past the bottom of
 *   the pane or over a sidebar is a normal way to select to the end.
 * - The selection is read one tick after mouseup; the browser has not always
 *   settled it synchronously.
 * - A minimum length keeps a double-click on one word from becoming a card.
 * - The last captured text is remembered so a double-fire never captures twice.
 * - After capturing, the selection is collapsed. Otherwise the next mouseup
 *   anywhere sees the same selection still standing.
 */
export class Highlighter {
  private ribbon: HTMLElement | null = null;
  /** The view a mousedown landed in, if it was a file view. */
  private gestureView: FileView | null = null;
  private gestureDetail = 0;
  private last: { path: string; text: string } | null = null;
  private busy = false;

  constructor(private plugin: WikiLmPlugin) {}

  install(): void {
    const p = this.plugin;
    this.ribbon = p.addRibbonIcon(WIKILM_HIGHLIGHT_ICON, "WikiLM highlighter mode", () => void this.toggle());
    this.reflect();
    p.addCommand({ id: "toggle-highlighter", name: "Toggle highlighter mode", callback: () => void this.toggle() });

    this.attach(window);
    p.registerEvent(p.app.workspace.on("window-open", (_ww: WorkspaceWindow, win: Window) => this.attach(win)));
  }

  get enabled(): boolean {
    return this.plugin.settings.highlighterMode;
  }

  async toggle(on = !this.enabled): Promise<void> {
    this.plugin.settings.highlighterMode = on;
    await this.plugin.saveSettings();
    this.reflect();
    new Notice(`WikiLM: highlighter ${on ? "on. Drag across a passage to send it to the inbox." : "off."}`);
  }

  reflect(): void {
    this.ribbon?.toggleClass("wikilm-highlighter-on", this.enabled);
    this.ribbon?.setAttribute("aria-label", `WikiLM highlighter mode (${this.enabled ? "on" : "off"})`);
    document.body.toggleClass("wikilm-highlighter-active", this.enabled);
    this.plugin.refreshStatusBar();
  }

  private attach(win: Window): void {
    const p = this.plugin;
    p.registerDomEvent(win.document, "mousedown", (evt: MouseEvent) => {
      if (!this.enabled || evt.button !== 0) return;
      const view = p.app.workspace.getActiveViewOfType(FileView);
      const target = evt.target as Node | null;
      const inView = !!(view && target && view.containerEl.contains(target));
      // Clicks on the view's own toolbar/header are not a drag over text.
      const inChrome = !!(target instanceof Element && target.closest(".view-header, .view-actions, .pdf-toolbar, .wikilm-notebook"));
      this.gestureView = inView && !inChrome ? view : null;
      this.gestureDetail = evt.detail;
    });
    p.registerDomEvent(win.document, "mouseup", (evt: MouseEvent) => {
      if (!this.enabled || evt.button !== 0) return;
      const view = this.gestureView;
      this.gestureView = null;
      if (!view) return;
      // A double-click selects one word; that is never a highlight.
      if (this.gestureDetail === 2 || evt.detail === 2) return;
      win.setTimeout(() => void this.finish(view, win), 0);
    });
  }

  private async finish(view: FileView, win: Window): Promise<void> {
    if (this.busy) return;
    const active = this.plugin.app.workspace.getActiveViewOfType(FileView);
    if (active !== view || !view.file) return;
    const min = Math.max(3, this.plugin.settings.highlighterMinChars);
    this.busy = true;
    try {
      if (view instanceof MarkdownView) {
        const reading = view.getMode() === "preview";
        const raw = reading ? (win.getSelection()?.toString() ?? "") : view.editor.getSelection();
        const text = normalizeWs(raw.replace(/==/g, ""));
        if (text.length < min || this.isRepeat(view.file.path, text)) return;
        this.last = { path: view.file.path, text };
        if (reading) await captureReadingSelection(this.plugin, view, win, { gesture: true });
        else await captureSelection(this.plugin, view.editor, view.file, { gesture: true });
      } else if (isPdfFile(view.file) || view.getViewType() === "pdf") {
        const sel = readPdfSelection(win);
        if (!sel) return;
        const text = normalizeWs(sel.text);
        if (text.length < min || this.isRepeat(view.file.path, text)) return;
        this.last = { path: view.file.path, text };
        capturePdfSelection(this.plugin, view.file, sel, { gesture: true });
        win.getSelection()?.removeAllRanges();
      }
    } catch (e) {
      console.error("WikiLM: highlighter capture failed", e);
    } finally {
      this.busy = false;
    }
  }

  private isRepeat(path: string, text: string): boolean {
    return !!this.last && this.last.path === path && this.last.text === text;
  }
}
