import { cardContent, exportCandidates, withExportAcceptance, type ExportItem } from "./cardActions";
import { randomUUID } from "crypto";
import { MarkdownView, Notice, Plugin, TFile, normalizePath } from "obsidian";
import { RECALL_ICON, RECALL_SPARK_ICON, registerRecallIcon } from "./icon";
import { AnkiClient, exportToAnki, finalizeHighlights, buildNote, type ExportResult } from "./anki";
import { captureSelection } from "./capture";
import { RECALL_COMMANDS } from "./commands";
import { paletteCommands } from "./commandTable";
import { Generator } from "./generator";
import { Highlighter } from "./highlighter";
import { InboxView, VIEW_TYPE_INBOX } from "./inboxView";
import { LlmClient } from "./llm";
import { askInstruction, pickDeck } from "./modals";
import type { Card, Highlight } from "./model";
import { DEFAULT_SETTINGS, RecallSettingTab, type RecallSettings } from "./settings";
import { SchemaFile } from "./schemaFile";
import { InboxStore } from "./store";
import { registerSourceVisibility } from "./sourceVisibility";
import { buildAnkiTextImport } from "./util";

export default class RecallPlugin extends Plugin {
  settings: RecallSettings = { ...DEFAULT_SETTINGS };
  store!: InboxStore;
  generator!: Generator;
  llm!: LlmClient;
  schema!: SchemaFile;
  anki!: AnkiClient;
  highlighter!: Highlighter;
  private statusBar: HTMLElement | null = null;
  private unsubscribeStatus?: () => void;
  private sourceVisibility?: ReturnType<typeof registerSourceVisibility>;
  private unloading?: Promise<void>;

  async onload(): Promise<void> {
    await this.loadSettings();
    if (this.unloading) return;
    registerRecallIcon();
    this.store = new InboxStore(this.app, this.settings.schemaFolder, this.manifest.dir ?? `${this.app.vault.configDir}/plugins/review-inbox`);
    await this.store.load();
    if (this.unloading) return;
    // Before the client, which holds a callback into it: the reader's house
    // rules are read on the way to every model call (src/schemaFile.ts).
    this.schema = new SchemaFile(this);
    this.llm = new LlmClient(
      () => this.settings,
      () => this.store.all(),
      () => this.schema.blocks(), // Strict: an unavailable note cannot authorize empty rules.
    );
    // Not awaited: the inbox header wants a count of waiting proposals, and
    // nothing else on load depends on having one.
    void this.schema.refresh().catch(e => console.error("Recall Studio: schema startup recovery failed", e));
    this.anki = new AnkiClient(() => this.settings.ankiConnectUrl);
    this.generator = new Generator(this);

    this.registerView(VIEW_TYPE_INBOX, (leaf) => new InboxView(leaf, this));

    this.addSettingTab(new RecallSettingTab(this.app, this));

    this.addRibbonIcon(RECALL_ICON, "Recall Studio inbox", () => void this.openInbox());
    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("wikilm-statusbar");
    this.statusBar.addEventListener("click", () => void this.openInbox());
    this.unsubscribeStatus = this.store.onChange(() => this.refreshStatusBar());
    this.sourceVisibility = registerSourceVisibility(this);
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      this.store.moveSource(oldPath, file.path);
    }));
    this.highlighter = new Highlighter(this);
    this.highlighter.install();
    this.refreshStatusBar();

    // ---- commands -------------------------------------------------------
    // Hidden commands stay in the table but are not registered: no palette
    // entry, no hotkey.
    for (const c of paletteCommands(RECALL_COMMANDS))
      this.addCommand({
        id: c.id,
        name: c.name,
        checkCallback: (checking) => {
          if (!c.available(this)) return false;
          if (!checking) void c.run(this);
          return true;
        },
      });

    // ---- editor context menu --------------------------------------------
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, info) => {
        const file = info.file;
        if (!file) return;
        menu.addItem((item) =>
          item
            .setTitle(editor.getSelection().trim() ? "Recall Studio: send selection to inbox" : "Recall Studio: send paragraph to inbox")
            .setIcon(RECALL_ICON)
            .setSection("review-inbox")
            .onClick(() => void captureSelection(this, editor, file)),
        );
        menu.addItem((item) =>
          item
            .setTitle("Recall Studio: send with instructions…")
            .setIcon(RECALL_SPARK_ICON)
            .setSection("review-inbox")
            .onClick(async () => {
              const inst = await askInstruction(this.app, "Instructions for this highlight", "e.g. one cloze on the number");
              if (inst !== null) await captureSelection(this, editor, file, inst);
            }),
        );
      }),
    );

    this.app.workspace.onLayoutReady(() => {
      if (this.unloading) return;
      this.app.workspace.iterateAllLeaves(leaf => {
        if (this.unloading) return;
        if (leaf.getViewState().type === "review-inbox-chat") {
          void leaf.setViewState({ type: VIEW_TYPE_INBOX }).catch(console.error);
        }
      });
      if (!this.unloading) this.generator.start();
    });
  }

  onunload(): Promise<void> {
    return this.unloading ??= this.store
      ? this.store.handover(() => this.finishUnload())
      : this.finishUnload();
  }

  private async finishUnload(): Promise<void> {
    let failure: unknown;
    const schemaStopped = Promise.resolve(this.schema?.stop()).catch(e => {
      console.error("Recall Studio: schema cleanup failed during unload", e);
      failure ??= e;
    });
    const stopped = Promise.resolve(this.generator?.stop()).catch(e => {
      console.error("Recall Studio: generation cleanup failed during unload", e);
      failure ??= e;
    });
    try {
      this.unsubscribeStatus?.();
    } catch (e) {
      console.error("Recall Studio: status cleanup failed during unload", e);
      failure ??= e;
    }
    try {
      this.sourceVisibility?.destroy();
    } catch (e) {
      console.error("Recall Studio: source visibility cleanup failed during unload", e);
      failure = e;
    }
    try {
      await this.llm?.abort();
    } catch (e) {
      console.error("Recall Studio: model abort failed during unload", e);
      failure = e;
    }
    // A cancelled run can still roll back cards after its final write resumes.
    await Promise.all([stopped, schemaStopped]);
    try {
      await this.store?.flush();
    } catch (e) {
      console.error("Recall Studio: inbox save failed during unload", e);
      failure ??= e;
    } finally {
      this.store?.close();
    }
    if (this.store?.hasUnsavedChanges) {
      new Notice("Recall Studio: inbox.json was not saved on unload; changes are not yet durable.", 0);
      failure ??= new Error("Inbox changes were not saved on unload.");
    }
    if (failure) throw failure;
  }

  // ---------------------------------------------------------------- helpers

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<RecallSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.sourceVisibility?.refresh();
    this.refreshStatusBar();
  }

  refreshStatusBar(): void {
    if (!this.statusBar) return;
    const c = this.store.counts();
    const parts: string[] = [];
    if (this.highlighter?.enabled) parts.push("🖊 highlighter");
    if (c.queued + c.generating) parts.push(`✎ ${c.queued + c.generating}`);
    if (c.toReview) parts.push(`⧉ ${c.toReview}`);
    if (c.flagged) parts.push(`⚑ ${c.flagged}`);
    if (c.errors) parts.push(`⚠ ${c.errors}`);
    this.statusBar.setText(parts.length ? `Recall Studio ${parts.join(" · ")}` : "Recall Studio");
    this.statusBar.toggleClass("wikilm-statusbar-highlighter", !!this.highlighter?.enabled);
    this.statusBar.title = `Recall Studio: ${this.highlighter?.enabled ? "highlighter mode on, " : ""}${c.queued + c.generating} writing, ${c.toReview} cards to review${c.flagged ? `, ${c.flagged} flagged` : ""}${c.errors ? `, ${c.errors} failed` : ""}. Click to open the inbox.`;
  }

  async openInbox(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_INBOX);
    const leaf = existing[0] ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    if (!existing[0]) await leaf.setViewState({ type: VIEW_TYPE_INBOX, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  async chooseDeck(): Promise<string | null> {
    let decks: string[] = [];
    try {
      decks = await this.anki.deckNames();
    } catch {
      new Notice("Recall Studio: Anki not reachable; type a deck name.");
    }
    return pickDeck(this.app, decks);
  }

  /** Fill note-type settings from what Anki actually has. */
  async detectNoteTypes(): Promise<void> {
    const models = await this.anki.modelNames();
    const pick = (cands: string[]) => cands.find((c) => models.includes(c));
    // Stock Anki note types, in preference order. Third-party types are not
    // preferred: they are not present on a fresh install, and picking one the
    // reader happens to have installed silently changes where a card's fields
    // land. The regex fallbacks still find a renamed or localised type.
    const basic = pick(["Basic", "Basic+"]) ?? models.find((m) => /basic/i.test(m));
    const cloze = pick(["Cloze", "Cloze+"]) ?? models.find((m) => /cloze/i.test(m));
    if (basic) {
      const f = await this.anki.modelFieldNames(basic);
      this.settings.basicModel = basic;
      this.settings.basicFrontField = f.find((x) => /front|question/i.test(x)) ?? f[0];
      this.settings.basicBackField = f.find((x) => /back|answer/i.test(x)) ?? f[1] ?? f[0];
      this.settings.basicExtraField = f.find((x) => /extra|source|notes/i.test(x)) ?? "";
    }
    if (cloze) {
      const f = await this.anki.modelFieldNames(cloze);
      this.settings.clozeModel = cloze;
      this.settings.clozeTextField = f.find((x) => /text/i.test(x)) ?? f[0];
      this.settings.clozeExtraField = f.find((x) => /extra|source|notes/i.test(x)) ?? "";
    }
    await this.saveSettings();
  }

  private exportBusy = false;

  /** Export is the acceptance action; failed attempts restore draft state. */
  private async acceptExport(list: Highlight[], ids: ReadonlySet<string> | undefined, send: (items: ExportItem[]) => Promise<void>): Promise<void> {
    if (this.exportBusy) { new Notice("Recall Studio: an export is already running."); return; }
    this.exportBusy = true;
    try {
      const items = exportCandidates(list, ids);
      if (!items.length) { new Notice("Recall Studio: no visible drafts to export."); return; }
      await withExportAcceptance(items, () => send(items));
    } catch (e) {
      new Notice(`Recall Studio: export failed. ${(e as Error).message}`, 8000);
    } finally {
      this.exportBusy = false;
      this.store.touch();
    }
  }

  async exportHighlights(list: Highlight[], ids?: ReadonlySet<string>): Promise<void> {
    await this.acceptExport(list, ids, items => this.sendToAnki(items));
  }

  async exportAsTextFile(list: Highlight[], ids?: ReadonlySet<string>): Promise<void> {
    await this.acceptExport(list, ids, items => this.writeTextFile(items));
  }

  private async sendToAnki(items: ExportItem[]): Promise<void> {
    const notice = new Notice(`Recall Studio: exporting ${items.length} card${items.length === 1 ? "" : "s"} to “${this.settings.defaultDeck}”…`, 0);
    try {
      const res: ExportResult = await exportToAnki(this.anki, items, {
        settings: this.settings,
        vaultName: this.app.vault.getName(),
        deck: this.settings.defaultDeck,
        resolveMedia: async (link: string, sourcePath: string) => {
          const dest = this.app.metadataCache.getFirstLinkpathDest(link, sourcePath);
          if (!dest) return null;
          const data = await this.app.vault.readBinary(dest);
          return { path: dest.path, data };
        },
      });
      this.store.touch();
      const bits = [`${res.added} added`];
      if (res.alreadyExported) bits.push(`${res.alreadyExported} already sent`);
      if (res.duplicates) bits.push(`${res.duplicates} duplicate content`);
      if (res.failed.length) bits.push(`${res.failed.length} failed`);
      new Notice(`Recall Studio: ${bits.join(", ")}.`, res.failed.length ? 8000 : 4000);
      for (const f of res.failed) console.warn("Recall Studio: export failed", f.error, f.card);
      if (res.failed.length) new Notice(`Recall Studio: ${res.failed[0].error}`, 8000);
    } catch (e) {
      const msg = (e as Error).message;
      new Notice(`Recall Studio: export failed. ${msg}\nUse “Export as Anki text file” from the inbox menu if Anki is closed.`, 10000);
      this.store.touch();
    } finally {
      notice.hide();
    }
  }

  /** Fallback when Anki is not running: write a text file Anki can import. */
  private async writeTextFile(items: ExportItem[]): Promise<void> {
    const contents = items.map(({ card, highlight }) => cardContent(card, highlight));
    const ctx = { settings: this.settings, vaultName: this.app.vault.getName(), deck: this.settings.defaultDeck };
    const rows = items.map(({ card, highlight }) => {
      const n = buildNote(card, highlight, ctx);
      const order =
        card.kind === "qa"
          ? [this.settings.basicFrontField, this.settings.basicBackField, this.settings.basicExtraField]
          : [this.settings.clozeTextField, this.settings.clozeExtraField];
      return { notetype: n.modelName, deck: n.deckName, tags: n.tags, fields: order.filter(Boolean).map((f) => n.fields[f] ?? "") };
    });
    const folder = normalizePath(this.settings.exportFolder);
    if (!(await this.app.vault.adapter.exists(folder))) await this.app.vault.createFolder(folder);
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
    const path = normalizePath(`${folder}/review-inbox-${stamp}-${randomUUID()}.txt`);
    // Group by note type, not by column count. A cloze model with no Extra
    // field writes ONE column while a Q&A row writes two, so classifying by
    // `fields.length !== 2` misfiled that cloze row as Q&A and put both shapes
    // in one file. Every row of a note type shares its field order, so one file
    // per note type always has a consistent column count. The explicit export
    // action supplies only the accepted batch.
    const cloze = rows.filter((r) => r.notetype === this.settings.clozeModel);
    const qa = rows.filter((r) => r.notetype !== this.settings.clozeModel);
    const files: Array<[string, typeof rows]> = [];
    if (qa.length && cloze.length) {
      files.push([path.replace(/\.txt$/, "-qa.txt"), qa], [path.replace(/\.txt$/, "-cloze.txt"), cloze]);
    } else files.push([path, rows]);
    const unchanged = () => items.every(({ card, highlight }, i) => card.status === "approved" && highlight.status === "ready" && cardContent(card, highlight) === contents[i]);
    if (!unchanged()) throw new Error("Cards changed during export. Review and export again.");
    for (const [p, rs] of files) await this.app.vault.create(p, buildAnkiTextImport(rs));
    items.forEach(({ card, highlight }, i) => {
      if (card.status === "approved" && highlight.status === "ready" && cardContent(card, highlight) === contents[i]) card.status = "exported";
    });
    finalizeHighlights(items.map((i) => i.highlight));
    this.store.touch();
    new Notice(`Recall Studio: wrote ${files.map(([p]) => p).join(" and ")}. In Anki: File → Import.`, 8000);
  }

  /** Used by the settings tab and tests; resolves a TFile from a path. */
  fileAt(path: string): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }

  /** Active markdown view, when there is one. */
  activeMarkdown(): MarkdownView | null {
    return this.app.workspace.getActiveViewOfType(MarkdownView);
  }
}
