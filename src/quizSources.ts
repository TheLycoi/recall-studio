import type { App, TFile } from "obsidian";

export interface QuizSource {
  file: TFile;
  path: string;
  mtime: number;
  size: number;
  editorText: string | null;
  text: string;
}
/** No cache: a sitting is bound to file identity, version, eligibility and all open editors. */
export class QuizSources {
  constructor(private app: App, private settings: () => { schemaFolder?: string; exportFolder?: string }) {}
  allowed(path: string): boolean {
    if (path.split("/").some(p => p.startsWith("."))) return false;
    const cache = this.app.metadataCache as unknown as { isUserIgnored?: (p: string) => boolean } | undefined;
    if (cache?.isUserIgnored?.(path)) return false;
    for (const folder of [this.app.vault.configDir, this.settings().schemaFolder, this.settings().exportFolder]) {
      const root = folder?.replace(/\/+$/, "");
      if (root && (root === path || path.startsWith(`${root}/`))) return false;
    }
    return true;
  }
  private editorText(path: string): string | null {
    const texts = (this.app.workspace.getLeavesOfType?.("markdown") ?? []).flatMap(leaf => {
      const view = leaf.view as unknown as { file?: TFile; editor?: { getValue(): string } };
      return view.file?.path === path && view.editor ? [view.editor.getValue()] : [];
    });
    if (new Set(texts).size > 1) throw Error("conflicting editors");
    return texts[0] ?? null;
  }
  current(source: QuizSource): boolean {
    try {
      const file = this.app.vault.getFiles().find(f => f.path === source.path);
      return this.allowed(source.path) && file === source.file && file.path === source.path &&
        file.stat.mtime === source.mtime && file.stat.size === source.size && this.editorText(source.path) === source.editorText;
    } catch { return false; }
  }
  async read(path: string): Promise<QuizSource> {
    const file = this.app.vault.getFiles().find(f => f.path === path);
    if (!file || file.extension.toLowerCase() !== "md" || !this.allowed(path) || file.stat.size > 100_000) throw Error("ineligible source");
    const source: QuizSource = { file, path, mtime: file.stat.mtime, size: file.stat.size, editorText: this.editorText(path), text: "" };
    source.text = source.editorText ?? await this.app.vault.read(file);
    if (!this.current(source) || source.text.length > 100_000) throw Error("source changed or too large");
    return source;
  }
}
