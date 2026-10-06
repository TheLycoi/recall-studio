import { CODEX_FALLBACK_MODELS, modelOptions } from "./modelRoles";
import { App, Notice, PluginSettingTab, Setting, ButtonComponent } from "obsidian";
import type WikiLmPlugin from "./main";
import { DEFAULT_EXPORT_FOLDER, DEFAULT_RULES_FOLDER, DEFAULT_WIKI_FOLDER } from "./paths";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type MarkMode = "none" | "highlight" | "highlight+block";
export type LintMode = "badge" | "hide" | "drop";

export interface WikiLmSettings {
  // LLM
  /** Absolute path to the codex binary; empty = auto-detect (PATH, then the ChatGPT app bundle). */
  codexPath: string;
  /** Codex model slug, e.g. gpt-5.5. */
  codexModel: string;
  /** What the last Test found Codex offering; the model dropdown is built from it. */
  knownModels: string[];
  effort: Effort;
  maxCardsPerHighlight: number;
  contextChars: number;
  language: string;
  writerInstructions: string;
  concurrency: number;
  notifyWhenReady: boolean;

  // Capture
  /** Off by default: capture sends passages to the inbox without editing the note. */
  markMode: MarkMode;
  openInboxOnCapture: boolean;
  /** Drag-to-capture. Off by default: with it on, every drag-selection is a capture. */
  highlighterMode: boolean;
  /** Selections shorter than this are ignored by highlighter mode (a double-clicked word, a stray drag). */
  highlighterMinChars: number;

  // Anki
  ankiConnectUrl: string;
  defaultDeck: string;
  basicModel: string;
  basicFrontField: string;
  basicBackField: string;
  basicExtraField: string;
  clozeModel: string;
  clozeTextField: string;
  clozeExtraField: string;
  extraTags: string;
  includeSourceTag: boolean;
  includeExtra: boolean;
  exportFolder: string;

  // Quiz
  /** The wiki plugin's folder; the quiz reads the pages in it and Recall never changes them. */
  topicFolder: string;
  /** Recall's own folder, for the card rules note. Keep it outside the wiki folder. */
  schemaFolder: string;
  /**
   * A runaway guard, not a target: the quiz ends when it brackets the edge of
   * what the reader knows. This only stops a session that never gets there.
   */
  quizCap: number;
  quizPoolSize: number;
  quizInstructions: string;

  // Sidebar
  /** Persisted by the view; no setting UI. */
  sidebarMode: "inbox" | "quiz";

  // Card quality
  /** Second model call per highlight that checks grounding, sibling interference, and Bloom fit before the card is stored. */
  critiquePass: boolean;
  /** What happens to a card that fails a deterministic lint check. */
  lintMode: LintMode;
  /** Show the card writer examples from cards you kept, edited, or deleted, drawn from the local inbox. */
  historyExamples: boolean;
  /** Propose a schema rule when the same correction turns up in three or four card edits. */
  schemaLearning: boolean;
}

const CUSTOM_MODEL = "__custom__";

export const DEFAULT_SETTINGS: WikiLmSettings = {
  codexPath: "",
  codexModel: "gpt-5.5",
  knownModels: [],
  effort: "high",
  maxCardsPerHighlight: 5,
  contextChars: 700,
  language: "",
  writerInstructions: "",
  concurrency: 2,
  notifyWhenReady: true,

  markMode: "none",
  openInboxOnCapture: false,
  highlighterMode: false,
  highlighterMinChars: 12,

  ankiConnectUrl: "http://127.0.0.1:8765",
  defaultDeck: "Default",
  basicModel: "Basic",
  basicFrontField: "Front",
  basicBackField: "Back",
  basicExtraField: "",
  clozeModel: "Cloze",
  clozeTextField: "Text",
  clozeExtraField: "Back Extra",
  extraTags: "wikilm",
  includeSourceTag: true,
  includeExtra: true,
  exportFolder: DEFAULT_EXPORT_FOLDER,

  topicFolder: DEFAULT_WIKI_FOLDER,
  schemaFolder: DEFAULT_RULES_FOLDER,
  quizCap: 30,
  quizPoolSize: 20,
  quizInstructions: "",

  sidebarMode: "inbox",

  critiquePass: true,
  lintMode: "badge",
  historyExamples: true,
  schemaLearning: true,
};

export class WikiLmSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: WikiLmPlugin,
  ) {
    super(app, plugin);
  }

  /**
   * Test: one tiny request on Codex, then Codex's model list into the
   * dropdown. The probe is the answer; a list that cannot be fetched is said
   * and does not fail the test.
   */
  private async testProvider(b: ButtonComponent): Promise<void> {
    const s = this.plugin.settings;
    b.setDisabled(true);
    try {
      const r = await this.plugin.llm.probe(s.codexModel);
      let listed = "";
      try {
        const list = await this.plugin.llm.listModels();
        s.knownModels = list;
        await this.plugin.saveSettings();
        listed = ` ${list.length} model${list.length === 1 ? "" : "s"} listed.`;
        this.display();
      } catch (e) {
        listed = ` Could not list models: ${(e as Error).message}`;
      }
      new Notice(`WikiLM: ${r.model} answered (${r.via}).${listed}`, 8000);
    } catch (e) {
      new Notice(`WikiLM: ${(e as Error).message}`, 8000);
    } finally {
      b.setDisabled(false);
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => void this.plugin.saveSettings();

    new Setting(containerEl).setName("Card writer").setHeading();

    new Setting(containerEl)
      .setName("Model")
      .setDesc(
        "Recall runs on OpenAI's Codex CLI, signed in with your ChatGPT account. No API key is needed. Sign in through the ChatGPT app or with `codex login`. Test sends one small request and loads the model list.",
      )
      .addButton((b) => b.setButtonText("Test").onClick(() => void this.testProvider(b)));

    new Setting(containerEl)
      .setName("Codex CLI path")
      .setDesc(
        "Leave empty to auto-detect: `codex` on the PATH, then the copy bundled in the ChatGPT app (/Applications/ChatGPT.app/Contents/Resources/codex). Otherwise paste the output of `which codex`. Sign in through the ChatGPT app or `codex login`.",
      )
      .addText((t) =>
        t.setPlaceholder("auto-detect").setValue(s.codexPath).onChange((v) => {
          s.codexPath = v.trim();
          save();
        }),
      );

    // A model dropdown: what the last Test found, the value in use, and the
    // known names, plus "Other…" for an id the list lacks.
    {
      const name = "Codex model";
      const desc = "Model slug passed to codex exec. gpt-5.5 is the lightest on your usage limit; gpt-5.6-luna and gpt-5.6-terra are newer and heavier.";
      const get = () => s.codexModel;
      const set = (v: string) => (s.codexModel = v || DEFAULT_SETTINGS.codexModel);
      const options = modelOptions(s.knownModels, get(), CODEX_FALLBACK_MODELS);
      const known = s.knownModels?.length ?? 0;
      const custom = new Setting(containerEl)
        .setName(`${name}: type an id`)
        .setDesc("For a model the list does not show.")
        .addText((t) =>
          t.setPlaceholder("model id").onChange((v) => {
            if (!v.trim()) return;
            set(v.trim());
            save();
          }),
        );
      const row = new Setting(containerEl)
        .setName(name)
        .setDesc(`${desc} ${known > 0 ? `${known} model${known === 1 ? "" : "s"} listed by the last Test.` : "Click Test to load the list."}`)
        .addDropdown((d) => {
          for (const m of options) d.addOption(m, m);
          d.addOption(CUSTOM_MODEL, "Other…");
          d.setValue(get()).onChange((v) => {
            if (v === CUSTOM_MODEL) {
              custom.settingEl.show();
              return;
            }
            set(v);
            save();
          });
        });
      containerEl.insertBefore(row.settingEl, custom.settingEl);
      custom.settingEl.hide();
    }

    new Setting(containerEl)
      .setName("Effort")
      .setDesc("Reasoning effort passed to Codex. Levels the chosen model does not support (gpt-5.5 stops at xhigh) are rounded down automatically.")
      .addDropdown((d) =>
        d
          .addOptions({ low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" })
          .setValue(s.effort)
          .onChange((v) => {
            s.effort = v as Effort;
            save();
          }),
      );

    new Setting(containerEl)
      .setName("Max cards per highlight")
      .setDesc("Upper bound. The writer makes fewer when the highlight only supports one or two.")
      .addSlider((sl) =>
        sl
          .setLimits(1, 12, 1)
          .setValue(s.maxCardsPerHighlight)
          .setDynamicTooltip()
          .onChange((v) => {
            s.maxCardsPerHighlight = v;
            save();
          }),
      );

    new Setting(containerEl)
      .setName("Context window (characters)")
      .setDesc("Text before and after the highlight that the writer sees for disambiguation. Cards are only written about the highlight itself.")
      .addText((t) =>
        t.setValue(String(s.contextChars)).onChange((v) => {
          const n = parseInt(v, 10);
          if (!Number.isNaN(n) && n >= 0) {
            s.contextChars = n;
            save();
          }
        }),
      );

    new Setting(containerEl)
      .setName("Card language")
      .setDesc("Leave empty to match the language of the highlight.")
      .addText((t) =>
        t.setPlaceholder("e.g. Dutch").setValue(s.language).onChange((v) => {
          s.language = v.trim();
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Standing instructions for the card writer")
      .setDesc("Appended to every request, e.g. 'Prefer cloze for numbers and dates.'")
      .addTextArea((t) => {
        t.inputEl.rows = 3;
        t.inputEl.cols = 50;
        t.setValue(s.writerInstructions).onChange((v) => {
          s.writerInstructions = v;
          save();
        });
      });

    new Setting(containerEl).setName("Card quality").setHeading();

    new Setting(containerEl)
      .setName("Critique pass")
      .setDesc(
        "Before a card is stored, a second model call checks it for grounding, interference between sibling cards, and Bloom fit. On by default, because it is the difference between a card you keep and one you delete. The cost is one extra model call per highlight, so cards take a little longer to appear; capture itself is unaffected either way. Turn it off if you are drafting in bulk and would rather triage by hand.",
      )
      .addToggle((t) =>
        t.setValue(s.critiquePass).onChange((v) => {
          s.critiquePass = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Lint mode")
      .setDesc(
        "The deterministic checks (cloze grounding, card length, yes/no questions) always run. This only decides what happens to a card that fails one.",
      )
      .addDropdown((d) =>
        d
          .addOptions({
            badge: "Badge only — flag problems, keep the card",
            hide: "Collapse — tuck flagged cards behind a toggle",
            drop: "Flag — mark them flagged so they cannot be exported",
          })
          .setValue(s.lintMode)
          .onChange((v) => {
            s.lintMode = v as LintMode;
            save();
          }),
      );

    new Setting(containerEl)
      .setName("Learn from my decisions")
      .setDesc(
        "Shows the card writer a few cards you kept or edited, and a few you deleted, as examples of how you like cards worded. On by default and free: it reads the local inbox only and sends nothing anywhere new. It has no effect until you have triaged some cards, and improves as you do.",
      )
      .addToggle((t) =>
        t.setValue(s.historyExamples).onChange((v) => {
          s.historyExamples = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Propose schema rules from my edits")
      .setDesc(
        "When the same correction shows up in three or four of your card edits, WikiLM writes a proposed rule to `wikilm-suggestions.md` and shows a chip in the inbox. Nothing enters the schema until you accept it.",
      )
      .addToggle((t) =>
        t.setValue(s.schemaLearning).onChange((v) => {
          s.schemaLearning = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Parallel requests")
      .setDesc("How many highlights are written at once in the background. With Codex, drop to 1 if you ever see refresh_token_failed.")
      .addSlider((sl) =>
        sl
          .setLimits(1, 4, 1)
          .setValue(s.concurrency)
          .setDynamicTooltip()
          .onChange((v) => {
            s.concurrency = v;
            save();
          }),
      );

    new Setting(containerEl)
      .setName("Notify when cards are ready")
      .addToggle((t) =>
        t.setValue(s.notifyWhenReady).onChange((v) => {
          s.notifyWhenReady = v;
          save();
        }),
      );

    new Setting(containerEl).setName("Capture").setHeading();

    new Setting(containerEl)
      .setName("Highlighter mode")
      .setDesc(
        "Drag across a passage in a note (editing or reading view) or in the PDF viewer and it is highlighted and sent to the inbox, no key pressed. Also toggled from the ribbon pen. Off by default because with it on every drag-selection is a capture.",
      )
      .addToggle((t) =>
        t.setValue(s.highlighterMode).onChange((v) => {
          void this.plugin.highlighter.toggle(v);
        }),
      );

    new Setting(containerEl)
      .setName("Highlighter: ignore selections shorter than")
      .setDesc("Characters. Keeps a double-clicked word or a stray drag from becoming a card.")
      .addSlider((sl) =>
        sl
          .setLimits(3, 80, 1)
          .setValue(s.highlighterMinChars)
          .setDynamicTooltip()
          .onChange((v) => {
            s.highlighterMinChars = v;
            save();
          }),
      );

    new Setting(containerEl)
      .setName("Mark captured text in the note")
      .setDesc(
        "Off by default — WikiLM sends passages to the inbox without editing your notes. Marking wraps the passage in ==…==, which can break headings and list formatting when a passage spans more than one line. Leave this off when you capture from wiki pages, so Recall does not edit them.",
      )
      .addDropdown((d) =>
        d
          .addOptions({ none: "Do not touch the note", highlight: "Highlight (==…==)", "highlight+block": "Highlight + block ID" })
          .setValue(s.markMode)
          .onChange((v) => {
            s.markMode = v as MarkMode;
            save();
          }),
      );

    new Setting(containerEl)
      .setName("Open the inbox after capturing")
      .setDesc("Off by default: the point of the inbox is that you keep reading and triage later.")
      .addToggle((t) =>
        t.setValue(s.openInboxOnCapture).onChange((v) => {
          s.openInboxOnCapture = v;
          save();
        }),
      );

    new Setting(containerEl).setName("Quiz").setHeading();

    new Setting(containerEl)
      .setName("Wiki folder")
      .setDesc("The folder your wiki plugin writes its pages to. The quiz reads the pages in it. Recall never changes them.")
      .addText((t) =>
        t.setValue(s.topicFolder).onChange((v) => {
          s.topicFolder = v.trim() || DEFAULT_SETTINGS.topicFolder;
          void this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Card rules folder")
      .setDesc("Where Recall keeps the note that holds your card rules. Keep it outside the wiki folder.")
      .addText((t) =>
        t.setValue(s.schemaFolder).onChange((v) => {
          s.schemaFolder = v.trim() || DEFAULT_SETTINGS.schemaFolder;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Question cap per quiz")
      .setDesc(
        "A safety limit, not a target. A quiz asks every section in its pool once; this only cuts short a pool longer than one sitting.",
      )
      .addSlider((sl) =>
        sl
          .setLimits(5, 60, 5)
          .setValue(s.quizCap)
          .setDynamicTooltip()
          .onChange((v) => {
            s.quizCap = v;
            save();
          }),
      );

    new Setting(containerEl)
      .setName("Sections per quiz")
      .setDesc("How many sections a quiz on a class, a subject or everything asks. A single note is always asked whole.")
      .addSlider((sl) =>
        sl
          .setLimits(5, 60, 5)
          .setValue(s.quizPoolSize)
          .setDynamicTooltip()
          .onChange((v) => {
            s.quizPoolSize = v;
            save();
          }),
      );

    new Setting(containerEl)
      .setName("Standing instructions for quizzes")
      .addTextArea((t) => {
        t.inputEl.rows = 3;
        t.inputEl.cols = 50;
        t.setValue(s.quizInstructions).onChange((v) => {
          s.quizInstructions = v;
          save();
        });
      });

    new Setting(containerEl).setName("Anki").setHeading();

    new Setting(containerEl)
      .setName("AnkiConnect URL")
      .setDesc("Anki must be open with the AnkiConnect add-on installed.")
      .addText((t) =>
        t.setValue(s.ankiConnectUrl).onChange((v) => {
          s.ankiConnectUrl = v.trim() || DEFAULT_SETTINGS.ankiConnectUrl;
          save();
        }),
      )
      .addButton((b) =>
        b.setButtonText("Test").onClick(async () => {
          try {
            const v = await this.plugin.anki.version();
            new Notice(`AnkiConnect reachable (version ${v}).`);
          } catch (e) {
            new Notice(`AnkiConnect not reachable: ${(e as Error).message}`);
          }
        }),
      );

    new Setting(containerEl)
      .setName("Default deck")
      .setDesc("Deck new cards go to unless you pick another in the inbox. Created if missing.")
      .addText((t) =>
        t.setValue(s.defaultDeck).onChange((v) => {
          s.defaultDeck = v.trim() || DEFAULT_SETTINGS.defaultDeck;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Detect note types from Anki")
      .setDesc("Looks for Anki's stock Basic and Cloze note types, and fills in the field names below.")
      .addButton((b) =>
        b.setButtonText("Detect").onClick(async () => {
          try {
            await this.plugin.detectNoteTypes();
            this.display();
            new Notice("WikiLM: note types detected.");
          } catch (e) {
            new Notice(`WikiLM: ${(e as Error).message}`);
          }
        }),
      );

    const field = (name: string, key: keyof WikiLmSettings, desc = "") =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) =>
          t.setValue(String(s[key])).onChange((v) => {
            (s as unknown as Record<string, string>)[key] = v.trim();
            save();
          }),
        );

    field("Q&A note type", "basicModel");
    field("Q&A front field", "basicFrontField");
    field("Q&A back field", "basicBackField");
    field("Q&A extra field", "basicExtraField", "Optional. Receives the highlight quote and source link.");
    field("Cloze note type", "clozeModel");
    field("Cloze text field", "clozeTextField");
    field("Cloze extra field", "clozeExtraField", "Optional.");

    new Setting(containerEl)
      .setName("Tags")
      .setDesc("Space-separated tags added to every exported note.")
      .addText((t) =>
        t.setValue(s.extraTags).onChange((v) => {
          s.extraTags = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Add a source:: tag")
      .setDesc("Adds source::<note-slug> so an Anki add-on can link the card back to its vault page.")
      .addToggle((t) =>
        t.setValue(s.includeSourceTag).onChange((v) => {
          s.includeSourceTag = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Fill the extra field with the highlight and source link")
      .addToggle((t) =>
        t.setValue(s.includeExtra).onChange((v) => {
          s.includeExtra = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Text export folder")
      .setDesc("Vault folder for Anki text-import files when AnkiConnect is unavailable. Keep it outside the wiki folder.")
      .addText((t) =>
        t.setValue(s.exportFolder).onChange((v) => {
          s.exportFolder = v.trim() || DEFAULT_SETTINGS.exportFolder;
          save();
        }),
      );
  }
}
