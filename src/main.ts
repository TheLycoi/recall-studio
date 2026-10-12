import { MarkdownView, Notice, Plugin, TFile, normalizePath } from "obsidian";
import { RECALL_ICON, RECALL_SPARK_ICON, registerRecallIcon } from "./icon";
import { AnkiClient, exportToAnki, finalizeHighlights, buildNote, type ExportResult } from "./anki";
import { captureSelection } from "./capture";
import { RECALL_COMMANDS } from "./commands";
import { paletteCommands } from "./commandTable";
import { Generator } from "./generator";
import { Highlighter } from "./highlighter";
import { InboxView, VIEW_TYPE_INBOX } from "./inboxView";
import { ChatView, VIEW_TYPE_CHAT } from "./reviewChatView";
import { LlmClient } from "./llm";
import { askInstruction, pickDeck } from "./modals";
import type { Card, Highlight } from "./model";
import { DEFAULT_SETTINGS, RecallSettingTab, type RecallSettings } from "./settings";
import { SchemaFile } from "./schemaFile";
import { InboxStore } from "./store";
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

  async onload(): Promise<void> {
    await this.loadSettings();
    registerRecallIcon();
    this.store = new InboxStore(this.app, this.settings.schemaFolder, this.manifest.dir ?? `${this.app.vault.configDir}/plugins/review-inbox`);
    await this.store.load();
    // Before the client, which holds a callback into it: the reader's house
    // rules are read on the way to every model call (src/schemaFile.ts).
    this.schema = new SchemaFile(this);
    this.llm = new LlmClient(
      () => this.settings,
      () => this.store.all(),
      () => this.schema.blocks(),
    );
    // Not awaited: the inbox header wants a count of waiting proposals, and
    // nothing else on load depends on having one.
    void this.schema.refresh();
    this.anki = new AnkiClient(() => this.settings.ankiConnectUrl);
    this.generator = new Generator(this);

    this.registerView(VIEW_TYPE_INBOX, (leaf) => new InboxView(leaf, this));
    this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this));
    this.addSettingTab(new RecallSettingTab(this.app, this));

    this.addRibbonIcon(RECALL_ICON, "Review Inbox inbox", () => void this.openInbox());
    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("wikilm-statusbar");
    this.statusBar.addEventListener("click", () => void this.openInbox());
    this.store.onChange(() => this.refreshStatusBar());
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
            .setTitle(editor.getSelection().trim() ? "Review Inbox: send selection to inbox" : "Review Inbox: send paragraph to inbox")
            .setIcon(RECALL_ICON)
            .setSection("review-inbox")
            .onClick(() => void captureSelection(this, editor, file)),
        );
        menu.addItem((item) =>
          item
            .setTitle("Review Inbox: send with instructions…")
            .setIcon(RECALL_SPARK_ICON)
            .setSection("review-inbox")
            .onClick(async () => {
              const inst = await askInstruction(this.app, "Instructions for this highlight", "e.g. one cloze on the number");
              if (inst !== null) await captureSelection(this, editor, file, inst);
            }),
        );
      }),
    );

    this.app.workspace.onLayoutReady(() => this.generator.start());
  }

  async onunload(): Promise<void> {
    this.generator.stop();
    await this.llm.abort();
    await this.store.flush();
    this.store.close();
  }

  // ---------------------------------------------------------------- helpers

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<RecallSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
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
    this.statusBar.setText(parts.length ? `Review Inbox ${parts.join(" · ")}` : "Review Inbox");
    this.statusBar.toggleClass("wikilm-statusbar-highlighter", !!this.highlighter?.enabled);
    this.statusBar.title = `Review Inbox: ${this.highlighter?.enabled ? "highlighter mode on, " : ""}${c.queued + c.generating} writing, ${c.toReview} cards to review${c.flagged ? `, ${c.flagged} flagged` : ""}${c.errors ? `, ${c.errors} failed` : ""}. Click to open the inbox.`;
  }

  async openInbox(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_INBOX);
    const leaf = existing[0] ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    if (!existing[0]) await leaf.setViewState({ type: VIEW_TYPE_INBOX, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  /** The chat view, opened beside the inbox. */
  async openChat(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
    const leaf = existing[0] ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    if (!existing[0]) await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  async chooseDeck(): Promise<string | null> {
    let decks: string[] = [];
    try {
      decks = await this.anki.deckNames();
    } catch {
      new Notice("Review Inbox: Anki not reachable; type a deck name.");
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

  /**
   * The exportable set: approved cards under a ready highlight. A strict
   * equality allowlist on `approved` and nothing else — it is the single funnel
   * into both exportHighlights and exportAsTextFile. Widening it into a
   * denylist (e.g. `!== "exported"`) would export drafts and cards the critique
   * flagged. Approved cards are the only cards a human has explicitly accepted.
   */
  private approvedItems(list: Highlight[]): Array<{ card: Card; highlight: Highlight }> {
    const items: Array<{ card: Card; highlight: Highlight }> = [];
    for (const h of list) {
      if (h.status !== "ready") continue;
      for (const c of h.cards) if (c.status === "approved") items.push({ card: c, highlight: h });
    }
    return items;
  }

  /** Push every approved card of the given highlights to Anki via AnkiConnect. */
  async exportHighlights(list: Highlight[]): Promise<void> {
    const items = this.approvedItems(list);
    if (items.length === 0) {
      new Notice("Review Inbox: nothing approved to export.");
      return;
    }
    const notice = new Notice(`Review Inbox: exporting ${items.length} card${items.length === 1 ? "" : "s"} to “${this.settings.defaultDeck}”…`, 0);
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
      new Notice(`Review Inbox: ${bits.join(", ")}.`, res.failed.length ? 8000 : 4000);
      for (const f of res.failed) console.warn("Review Inbox: export failed", f.error, f.card);
      if (res.failed.length) new Notice(`Review Inbox: ${res.failed[0].error}`, 8000);
    } catch (e) {
      const msg = (e as Error).message;
      new Notice(`Review Inbox: export failed. ${msg}\nUse “Export approved as Anki text file” from the inbox menu if Anki is closed.`, 10000);
      this.store.touch();
    } finally {
      notice.hide();
    }
  }

  /** Fallback when Anki is not running: write a text file Anki can import. */
  async exportAsTextFile(list: Highlight[]): Promise<void> {
    const items = this.approvedItems(list);
    if (items.length === 0) {
      new Notice("Review Inbox: nothing approved to export.");
      return;
    }
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
    const path = normalizePath(`${folder}/review-inbox-${stamp}.txt`);
    // Group by note type, not by column count. A cloze model with no Extra
    // field writes ONE column while a Q&A row writes two, so classifying by
    // `fields.length !== 2` misfiled that cloze row as Q&A and put both shapes
    // in one file. Every row of a note type shares its field order, so one file
    // per note type always has a consistent column count. approvedItems above
    // is the only funnel, so only approved cards reach this split.
    const cloze = rows.filter((r) => r.notetype === this.settings.clozeModel);
    const qa = rows.filter((r) => r.notetype !== this.settings.clozeModel);
    const files: Array<[string, typeof rows]> = [];
    if (qa.length && cloze.length) {
      files.push([path.replace(/\.txt$/, "-qa.txt"), qa], [path.replace(/\.txt$/, "-cloze.txt"), cloze]);
    } else files.push([path, rows]);
    for (const [p, rs] of files) await this.app.vault.create(p, buildAnkiTextImport(rs));
    for (const { card } of items) card.status = "exported";
    finalizeHighlights(items.map((i) => i.highlight));
    this.store.touch();
    new Notice(`Review Inbox: wrote ${files.map(([p]) => p).join(" and ")}. In Anki: File → Import.`, 8000);
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
