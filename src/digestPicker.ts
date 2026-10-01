/**
 * The Digest picker: which PDFs a "Digest…" run is about.
 *
 * Its own file because it is the one modal with a tree in it, and because the
 * pure half (src/digestGate.ts pickerFolders) is what the tests cover; what is
 * here only draws that tree and keeps the ticks.
 */
import { App, ButtonComponent, Modal, Notice, Setting, TFile } from "obsidian";
import { pickerFolders, type PickerFolder } from "./digestGate";

/**
 * "Digest…": tick the PDFs to digest, one at a time or a folder at a time.
 *
 * One list for the whole vault rather than a folder picker and a file picker,
 * because the reader asked (2026-10-01) for one Digest whose picker takes a
 * whole folder or several items under it. The rows are the folders that hold
 * PDFs (src/digestGate.ts pickerFolders), each opening to its PDFs. The only
 * state is the set of ticked PDF paths: a folder's box shows its PDFs' state
 * (all, some, none) and ticking it ticks every PDF under it, so what the run
 * gets is a list of PDFs and never a folder to walk later. With a filter
 * typed, a folder's box acts on the PDFs the filter shows.
 */
class DigestPickerModal extends Modal {
  private readonly rows: PickerFolder<TFile>[];
  private readonly byPath = new Map<string, TFile>();
  private ticked: Set<string>;
  private expanded = new Set<string>();
  private query = "";
  private resolved = false;
  private list!: HTMLElement;
  private count!: HTMLElement;
  private run!: ButtonComponent;

  constructor(
    app: App,
    pdfs: TFile[],
    preselected: TFile[],
    private resolve: (v: TFile[] | null) => void,
  ) {
    super(app);
    this.rows = pickerFolders(pdfs);
    for (const f of pdfs) this.byPath.set(f.path, f);
    this.ticked = new Set(preselected.filter((f) => this.byPath.has(f.path)).map((f) => f.path));
    // Open the folders that hold a pre-ticked PDF, so the reader sees what
    // the active file put in the selection.
    for (const row of this.rows) if (row.pdfs.some((f) => this.ticked.has(f.path))) this.expandTo(row.path);
  }

  private expandTo(path: string): void {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) this.expanded.add(parts.slice(0, i).join("/"));
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("wikilm-modal");
    contentEl.createEl("h3", { text: "Digest" });
    contentEl.createEl("p", { cls: "wikilm-muted", text: "Tick PDFs, or a folder to tick every PDF under it. Each PDF is digested behind its own preview." });

    const filter = contentEl.createEl("input", { cls: "wikilm-pick-filter", attr: { type: "text", placeholder: "Filter by folder or file name" } });
    filter.addEventListener("input", () => {
      this.query = filter.value;
      this.draw();
    });
    filter.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && this.ticked.size > 0) {
        e.preventDefault();
        this.submit();
      }
    });

    this.list = contentEl.createDiv({ cls: "wikilm-pick-list" });

    const footer = new Setting(contentEl);
    this.count = footer.descEl;
    footer.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
    footer.addButton((b) => {
      this.run = b.setCta().onClick(() => this.submit());
    });
    this.draw();
    window.setTimeout(() => filter.focus(), 20);
  }

  /** Redraw the list in place; the filter box and the buttons keep their state. */
  private draw(): void {
    const q = this.query.trim().toLowerCase();
    const matches = (f: TFile) => q === "" || f.path.toLowerCase().includes(q);
    this.list.empty();
    let shown = 0;
    for (const row of this.rows) {
      const visible = row.all.filter(matches);
      if (visible.length === 0) continue;
      shown++;
      // A filter opens every folder it leaves, since what matched is inside.
      const open = q !== "" || this.expanded.has(row.path);
      const head = this.list.createDiv({ cls: "wikilm-pick-row wikilm-pick-folder" });
      head.style.setProperty("--wikilm-depth", String(row.depth));
      const box = head.createEl("input", { attr: { type: "checkbox" } }) as HTMLInputElement;
      const on = visible.filter((f) => this.ticked.has(f.path)).length;
      box.checked = on === visible.length;
      box.indeterminate = on > 0 && on < visible.length;
      box.addEventListener("change", () => {
        for (const f of visible) box.checked ? this.ticked.add(f.path) : this.ticked.delete(f.path);
        this.draw();
      });
      const toggle = () => {
        if (this.expanded.has(row.path)) this.expanded.delete(row.path);
        else this.expanded.add(row.path);
        this.draw();
      };
      head.createSpan({ cls: "wikilm-pick-toggle", text: open ? "▾" : "▸" }).addEventListener("click", toggle);
      const name = head.createSpan({ cls: "wikilm-pick-name", text: row.path === "" ? "(vault root)" : (row.path.split("/").pop() ?? row.path) });
      name.setAttr("title", row.path === "" ? "/" : row.path);
      name.addEventListener("click", toggle);
      head.createSpan({ cls: "wikilm-muted", text: `${visible.length} PDF${visible.length === 1 ? "" : "s"}` });
      if (!open) continue;
      for (const f of row.pdfs.filter(matches)) {
        const line = this.list.createDiv({ cls: "wikilm-pick-row wikilm-pick-file" });
        line.style.setProperty("--wikilm-depth", String(row.depth + 1));
        const tick = line.createEl("input", { attr: { type: "checkbox" } }) as HTMLInputElement;
        tick.checked = this.ticked.has(f.path);
        tick.addEventListener("change", () => {
          tick.checked ? this.ticked.add(f.path) : this.ticked.delete(f.path);
          this.draw();
        });
        const label = line.createSpan({ cls: "wikilm-pick-name", text: f.basename });
        label.setAttr("title", f.path);
        label.addEventListener("click", () => {
          tick.checked = !tick.checked;
          tick.dispatchEvent(new Event("change"));
        });
      }
    }
    if (shown === 0) this.list.createEl("p", { cls: "wikilm-muted", text: "No PDF matches." });
    const n = this.ticked.size;
    this.count.setText(n === 0 ? "Nothing ticked" : `${n} PDF${n === 1 ? "" : "s"} ticked`);
    this.run.setButtonText(n <= 1 ? "Digest" : `Digest ${n} PDFs`).setDisabled(n === 0);
  }

  private submit(): void {
    if (this.ticked.size === 0) return;
    this.resolved = true;
    const files = [...this.ticked]
      .map((p) => this.byPath.get(p))
      .filter((f): f is TFile => !!f)
      .sort((a, b) => a.path.localeCompare(b.path));
    this.resolve(files);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) this.resolve(null);
  }
}

/**
 * Open the Digest picker over every PDF in the vault, with `preselected`
 * ticked. Null when the reader closes it; a Notice and null when the vault
 * has no PDF to offer.
 */
export function pickDigestFiles(app: App, preselected: TFile[]): Promise<TFile[] | null> {
  const pdfs = app.vault.getFiles().filter((f) => f.extension.toLowerCase() === "pdf");
  if (pdfs.length === 0) {
    new Notice("WikiLM: there are no PDFs in this vault to digest.");
    return Promise.resolve(null);
  }
  return new Promise((resolve) => new DigestPickerModal(app, pdfs, preselected, resolve).open());
}
