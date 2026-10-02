import { MarkdownView, Notice, Plugin, TFile, normalizePath } from "obsidian";
import { WIKILM_ICON, WIKILM_SPARK_ICON, registerWikiLmIcon } from "./icon";
import { AnkiClient, exportToAnki, finalizeHighlights, buildNote } from "./anki";
import { CancelToken } from "./cancel";
import { captureSelection } from "./capture";
import { WIKILM_COMMANDS } from "./commands";
import { paletteCommands } from "./commandTable";
import { Generator } from "./generator";
import { Highlighter } from "./highlighter";
import { InboxView, VIEW_TYPE_INBOX } from "./inboxView";
import { LlmClient } from "./llm";
import { askInstruction, pickDeck } from "./modals";
import type { Card, Highlight } from "./model";
import { DEFAULT_SETTINGS, WikiLmSettingTab, type WikiLmSettings } from "./settings";
import { LEGACY_TOPIC_FOLDER, resolveTopicFolderDefault } from "./settingsDefaults";
import { SchemaFile } from "./schemaFile";
import { InboxStore } from "./store";
import { UpstreamHost } from "./upstream/host";
import { buildAnkiTextImport } from "./util";

export default class WikiLmPlugin extends Plugin {
  settings: WikiLmSettings = { ...DEFAULT_SETTINGS };
  store!: InboxStore;
  generator!: Generator;
  llm!: LlmClient;
  schema!: SchemaFile;
  anki!: AnkiClient;
  highlighter!: Highlighter;
  cancel = new CancelToken();
  private statusBar: HTMLElement | null = null;
  private upstream: UpstreamHost | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    registerWikiLmIcon();
    this.store = new InboxStore(this.app, this.settings.schemaFolder, this.manifest.dir ?? `${this.app.vault.configDir}/plugins/wikilm`);
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
    this.addSettingTab(new WikiLmSettingTab(this.app, this));

    this.addRibbonIcon(WIKILM_ICON, "WikiLM inbox", () => void this.openInbox());
    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("wikilm-statusbar");
    this.statusBar.addEventListener("click", () => {
      if (this.cancel.active) {
        this.cancel.cancel();
        new Notice("WikiLM: stopping after this batch.");
        return;
      }
      void this.openInbox();
    });
    this.store.onChange(() => this.refreshStatusBar());
    this.cancel.onChange(() => this.refreshStatusBar());
    this.highlighter = new Highlighter(this);
    this.highlighter.install();
    this.refreshStatusBar();

    // ---- commands -------------------------------------------------------
    // Hidden commands stay in WIKILM_COMMANDS for the chat to run by alias,
    // but are not registered: no palette entry, no hotkey.
    for (const c of paletteCommands(WIKILM_COMMANDS))
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
            .setTitle(editor.getSelection().trim() ? "WikiLM: send selection to inbox" : "WikiLM: send paragraph to inbox")
            .setIcon(WIKILM_ICON)
            .setSection("wikilm")
            .onClick(() => void captureSelection(this, editor, file)),
        );
        menu.addItem((item) =>
          item
            .setTitle("WikiLM: send with instructions…")
            .setIcon(WIKILM_SPARK_ICON)
            .setSection("wikilm")
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
    this.upstream?.dispose();
    this.upstream = null;
    await this.llm.abort();
    await this.store.flush();
    this.store.close();
  }

  // ---------------------------------------------------------------- helpers

  /** Upstream's wiki engine host (src/upstream/host.ts), built the first time something asks for it. */
  upstreamHost(): UpstreamHost {
    return (this.upstream ??= new UpstreamHost(this));
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<WikiLmSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    // 0.9.2: capture no longer edits notes by default. An install that predates
    // the change has markMode saved, so the new default alone would not reach it.
    if (saved && !saved.markModeMigrated) {
      this.settings.markMode = "none";
      this.settings.markModeMigrated = true;
      await this.saveData(this.settings);
    }
    // 0.11.0: a quiz runs until it brackets the edge, so `quizQuestions` (a
    // target, default 5) became `quizCap` (a runaway guard). The old number is
    // not carried over — it would cap every quiz at five and defeat the change —
    // and `quizCap` is not reset either: `Object.assign` above already gave it
    // the default, and an install that has both keys (downgraded and back) has
    // a cap the reader chose. Only the stale key is dropped.
    type LegacySettings = Partial<WikiLmSettings> & { quizQuestions?: number };
    if ((saved as LegacySettings | null)?.quizQuestions !== undefined) {
      delete (this.settings as LegacySettings).quizQuestions;
      await this.saveData(this.settings);
    }
    // 0.14.0: the topic folder defaults to `wiki`, where ingest writes, not
    // `classes`. Saved settings without the key predate it and were using
    // `classes`; such an install keeps `classes` if the vault has that folder,
    // and the choice is saved so it holds from now on. Nothing saved is a
    // fresh install, which takes the new default. The folder is looked up on
    // disk as well, because the vault's file index may still be filling while
    // plugins load.
    if (saved && !saved.topicFolder) {
      const hasClasses =
        this.app.vault.getFolderByPath(LEGACY_TOPIC_FOLDER) !== null ||
        (await this.app.vault.adapter.stat(LEGACY_TOPIC_FOLDER))?.type === "folder";
      this.settings.topicFolder = resolveTopicFolderDefault(saved, hasClasses);
      await this.saveData(this.settings);
    }
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
    if (this.cancel.active) parts.push(`⏹ ${this.cancel.cancelled ? "stopping…" : this.cancel.label}`);
    if (c.queued + c.generating) parts.push(`✎ ${c.queued + c.generating}`);
    if (c.toReview) parts.push(`⧉ ${c.toReview}`);
    if (c.flagged) parts.push(`⚑ ${c.flagged}`);
    if (c.errors) parts.push(`⚠ ${c.errors}`);
    this.statusBar.setText(parts.length ? `WikiLM ${parts.join(" · ")}` : "WikiLM");
    this.statusBar.toggleClass("wikilm-statusbar-highlighter", !!this.highlighter?.enabled);
    this.statusBar.title = `${this.cancel.active ? `Click to stop: ${this.cancel.label}. ` : ""}WikiLM: ${this.highlighter?.enabled ? "highlighter mode on, " : ""}${c.queued + c.generating} writing, ${c.toReview} cards to review${c.flagged ? `, ${c.flagged} flagged` : ""}${c.errors ? `, ${c.errors} failed` : ""}. Click to open the inbox.`;
  }

  async openInbox(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_INBOX);
    const leaf = existing[0] ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    if (!existing[0]) await leaf.setViewState({ type: VIEW_TYPE_INBOX, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  /** The inbox, switched to its Ask half. */
  async openChat(): Promise<void> {
    await this.openInbox();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_INBOX)) {
      if (leaf.view instanceof InboxView) await leaf.view.setMode("chat");
    }
  }

  /**
   * Open the chat and check the wiki there.
   *
   * The lint lives in the chat panel because its report is a turn in the log —
   * something to read, scroll back to and act on — rather than a Notice that
   * disappears. Routing the command through the panel keeps one implementation
   * instead of a second copy that drifts.
   */
  async lintWiki(): Promise<void> {
    await this.openChat();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_INBOX)) {
      if (leaf.view instanceof InboxView) {
        await leaf.view.chatPanel().runVaultLint();
        return;
      }
    }
  }

  async chooseDeck(): Promise<string | null> {
    let decks: string[] = [];
    try {
      decks = await this.anki.deckNames();
    } catch {
      new Notice("WikiLM: Anki not reachable; type a deck name.");
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

  // The `c.status === "pending"` strict-equality allowlist below is the only
  // thing keeping flagged cards out of Anki: this is the single funnel into
  // both exportHighlights and exportAsTextFile. Widening it into a denylist
  // (e.g. `!== "exported"`) would export cards the critique rejected.
  private pendingItems(list: Highlight[]): Array<{ card: Card; highlight: Highlight }> {
    const items: Array<{ card: Card; highlight: Highlight }> = [];
    for (const h of list) {
      if (h.status !== "ready") continue;
      for (const c of h.cards) if (c.status === "pending") items.push({ card: c, highlight: h });
    }
    return items;
  }

  /** Push every pending card of the given highlights to Anki via AnkiConnect. */
  async exportHighlights(list: Highlight[]): Promise<void> {
    const items = this.pendingItems(list);
    if (items.length === 0) {
      new Notice("WikiLM: nothing to export.");
      return;
    }
    const notice = new Notice(`WikiLM: exporting ${items.length} card${items.length === 1 ? "" : "s"} to “${this.settings.defaultDeck}”…`, 0);
    try {
      const res = await exportToAnki(this.anki, items, {
        settings: this.settings,
        vaultName: this.app.vault.getName(),
        deck: this.settings.defaultDeck,
      });
      this.store.touch();
      const bits = [`${res.added} added`];
      if (res.duplicates) bits.push(`${res.duplicates} already in Anki`);
      if (res.failed.length) bits.push(`${res.failed.length} failed`);
      new Notice(`WikiLM: ${bits.join(", ")}.`, res.failed.length ? 8000 : 4000);
      for (const f of res.failed) console.warn("WikiLM: export failed", f.error, f.card);
      if (res.failed.length) new Notice(`WikiLM: ${res.failed[0].error}`, 8000);
    } catch (e) {
      const msg = (e as Error).message;
      new Notice(`WikiLM: export failed. ${msg}\nUse “Export reviewed as Anki text file” from the inbox menu if Anki is closed.`, 10000);
      this.store.touch();
    } finally {
      notice.hide();
    }
  }

  /** Fallback when Anki is not running: write a text file Anki can import. */
  async exportAsTextFile(list: Highlight[]): Promise<void> {
    const items = this.pendingItems(list);
    if (items.length === 0) {
      new Notice("WikiLM: nothing to export.");
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
    const path = normalizePath(`${folder}/wikilm-${stamp}.txt`);
    const qa = rows.filter((r) => r.fields.length !== 2 || r.notetype !== this.settings.clozeModel);
    const cloze = rows.filter((r) => !qa.includes(r));
    // Anki's importer needs a consistent column count per file, so split by note type when the field counts differ.
    const files: Array<[string, typeof rows]> = [];
    if (qa.length && cloze.length && qa[0].fields.length !== cloze[0].fields.length) {
      files.push([path.replace(/\.txt$/, "-qa.txt"), qa], [path.replace(/\.txt$/, "-cloze.txt"), cloze]);
    } else files.push([path, rows]);
    for (const [p, rs] of files) await this.app.vault.create(p, buildAnkiTextImport(rs));
    for (const { card } of items) card.status = "exported";
    finalizeHighlights(items.map((i) => i.highlight));
    this.store.touch();
    new Notice(`WikiLM: wrote ${files.map(([p]) => p).join(" and ")}. In Anki: File → Import.`, 8000);
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
