import { CODEX_FALLBACK_MODELS, modelOptions } from "./modelRoles";
import { DEEPSEEK_FALLBACK_MODELS } from "./deepseekModels";
import { OPENCODE_FALLBACK_MODELS } from "./opencode";
import { forgetCachedKey } from "./deepseekKey";
import { App, Notice, PluginSettingTab, Setting, ButtonComponent } from "obsidian";
import type RecallPlugin from "./main";
import { DEFAULT_EXPORT_FOLDER, DEFAULT_RULES_FOLDER, DEFAULT_WIKI_FOLDER } from "./paths";
import { SR_RECOGNITION_DEFAULTS, type SrRecognitionSettings } from "./srRecognition";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type MarkMode = "none" | "highlight" | "highlight+block";
export type LintMode = "badge" | "hide" | "drop";
/** "codex": OpenAI's Codex CLI on your ChatGPT sign-in. "deepseek": the DeepSeek API with a key. "opencode": the opencode CLI, which owns its own credentials. */
export type Provider = "codex" | "deepseek" | "opencode";

export interface RecallSettings extends SrRecognitionSettings {
  // LLM
  /** Which provider writes and checks the cards. */
  provider: Provider;
  /** Absolute path to the codex binary; empty = auto-detect (PATH, then the ChatGPT app bundle). */
  codexPath: string;
  /** Codex model slug, e.g. gpt-5.5. */
  codexModel: string;
  /** What the last Test found the active provider offering; the model dropdown is built from it. */
  knownModels: string[];
  /** DeepSeek API key. Empty = read DEEPSEEK_API_KEY from the environment or the macOS keychain. */
  deepseekApiKey: string;
  /** DeepSeek model id, e.g. deepseek-v4-pro. */
  deepseekModel: string;
  /** Absolute path to the opencode binary; empty = auto-detect (PATH, then ~/.opencode/bin). */
  opencodePath: string;
  /** opencode model id, in the `provider/model` form `opencode models` prints, e.g. deepseek/deepseek-flash. */
  opencodeModel: string;
  effort: Effort;
  /** Retained only for compatibility with saved settings; no writing quota. */
  maxCardsPerHighlight: number;
  contextChars: number;
  language: string;
  writerInstructions: string;
  concurrency: number;
  notifyWhenReady: boolean;
  /** Recall Studio's own folder: the card rules note, the inbox, and the rule suggestions note. Keep it outside the wiki folder. */
  schemaFolder: string;

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

  // Sources
  /** The wiki or sources folder protected from capture marking. */
  topicFolder: string;

  // Card quality
  /** Independent source audit after preparation, writing and deterministic lint. */
  critiquePass: boolean;
  /** What happens to a card that fails a deterministic lint check. */
  lintMode: LintMode;
  /** Show the card writer examples from cards you kept, edited, or deleted, drawn from the local inbox. */
  historyExamples: boolean;
  /** Propose a schema rule when the same correction turns up in three or four card edits. */
  schemaLearning: boolean;
}

const CUSTOM_MODEL = "__custom__";

export const DEFAULT_SETTINGS: RecallSettings = {
  ...SR_RECOGNITION_DEFAULTS,
  provider: "codex",
  codexPath: "",
  codexModel: "gpt-5.5",
  knownModels: [],
  deepseekApiKey: "",
  deepseekModel: "deepseek-v4-pro",
  opencodePath: "",
  opencodeModel: "deepseek/deepseek-flash",
  effort: "high",
  maxCardsPerHighlight: 5,
  contextChars: 700,
  language: "",
  writerInstructions: "",
  concurrency: 2,
  notifyWhenReady: true,
  schemaFolder: DEFAULT_RULES_FOLDER,

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
  extraTags: "review-inbox",
  includeSourceTag: true,
  includeExtra: true,
  exportFolder: DEFAULT_EXPORT_FOLDER,

  topicFolder: DEFAULT_WIKI_FOLDER,

  critiquePass: true,
  lintMode: "badge",
  historyExamples: true,
  schemaLearning: true,
};

export class RecallSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: RecallPlugin,
  ) {
    super(app, plugin);
  }

  /**
   * Test: one tiny request on the active provider, then that provider's model
   * list into the dropdown. The probe is the answer; a list that cannot be
   * fetched is said and does not fail the test.
   */
  private async testProvider(b: ButtonComponent): Promise<void> {
    const s = this.plugin.settings;
    b.setDisabled(true);
    try {
      const r = await this.plugin.llm.probe();
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
      new Notice(`Recall Studio: ${r.model} answered (${r.via}).${listed}`, 8000);
    } catch (e) {
      new Notice(`Recall Studio: ${(e as Error).message}`, 8000);
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
      .setName("Provider")
      .setDesc(
        "Codex runs OpenAI's CLI on your ChatGPT sign-in and needs no key. DeepSeek calls the DeepSeek API with an API key. OpenCode runs the opencode CLI, which owns its own credentials, so Recall Studio holds no key for it. Test sends one small request and loads the model list.",
      )
      .addDropdown((d) =>
        d
          .addOptions({
            codex: "Codex (ChatGPT sign-in)",
            deepseek: "DeepSeek (API key)",
            opencode: "OpenCode (its own sign-in)",
          })
          .setValue(s.provider)
          .onChange((v) => {
            s.provider = v as Provider;
            // The list belongs to the provider that was just tested, so it
            // must not carry over to the other one's dropdown.
            s.knownModels = [];
            save();
            this.display();
          }),
      )
      .addButton((b) => b.setButtonText("Test").onClick(() => void this.testProvider(b)));

    if (s.provider === "deepseek") {
      new Setting(containerEl)
        .setName("DeepSeek API key")
        .setDesc(
          "Leave empty to read DEEPSEEK_API_KEY from the environment or the macOS keychain, under “DEEPSEEK_API_KEY”, “Review Inbox DeepSeek API key”, or the earlier “Recall DeepSeek API key”. A key typed here is stored in data.json, which this vault syncs through iCloud in plaintext, so the keychain is the safer place for it.",
        )
        .addText((t) => {
          t.inputEl.type = "password";
          t.setPlaceholder("sk-… or leave empty for keychain")
            .setValue(s.deepseekApiKey)
            .onChange((v) => {
              s.deepseekApiKey = v.trim();
              forgetCachedKey();
              save();
            });
        });

      // A model dropdown: what the last Test found, the value in use, and the
      // known names, plus "Other…" for an id the list lacks.
      const options = modelOptions(s.knownModels, s.deepseekModel, DEEPSEEK_FALLBACK_MODELS);
      const known = s.knownModels.length;
      const custom = new Setting(containerEl)
        .setName("DeepSeek model: type an id")
        .setDesc("For a model the list does not show.")
        .addText((t) =>
          t.setPlaceholder("model id").onChange((v) => {
            if (!v.trim()) return;
            s.deepseekModel = v.trim() || DEFAULT_SETTINGS.deepseekModel;
            save();
          }),
        );
      const row = new Setting(containerEl)
        .setName("DeepSeek model")
        .setDesc(
          `Model id sent to api.deepseek.com. deepseek-v4-pro reasons harder and costs more; deepseek-flash is the cheap one. ${known > 0 ? `${known} model${known === 1 ? "" : "s"} listed by the last Test.` : "Click Test to load the list."}`,
        )
        .addDropdown((d) => {
          for (const m of options) d.addOption(m, m);
          d.addOption(CUSTOM_MODEL, "Other…");
          d.setValue(s.deepseekModel).onChange((v) => {
            if (v === CUSTOM_MODEL) {
              custom.settingEl.show();
              return;
            }
            s.deepseekModel = v || DEFAULT_SETTINGS.deepseekModel;
            save();
          });
        });
      containerEl.insertBefore(row.settingEl, custom.settingEl);
      custom.settingEl.hide();
    } else if (s.provider === "opencode") {
      new Setting(containerEl)
        .setName("OpenCode CLI path")
        .setDesc(
          "Leave empty to auto-detect: `opencode` on the PATH, then ~/.opencode/bin/opencode. Sign in with `opencode auth login`; add a provider key with `opencode service set env`. OpenCode owns its credentials, so Recall Studio stores none for it.",
        )
        .addText((t) =>
          t.setPlaceholder("auto-detect").setValue(s.opencodePath).onChange((v) => {
            s.opencodePath = v.trim();
            save();
          }),
        );

      // A model dropdown: what the last Test found, the value in use, and the
      // known names, plus "Other…" for an id the list lacks.
      const options = modelOptions(s.knownModels, s.opencodeModel, OPENCODE_FALLBACK_MODELS);
      const known = s.knownModels.length;
      const custom = new Setting(containerEl)
        .setName("OpenCode model: type an id")
        .setDesc("For a model the list does not show.")
        .addText((t) =>
          t.setPlaceholder("provider/model").onChange((v) => {
            if (!v.trim()) return;
            s.opencodeModel = v.trim() || DEFAULT_SETTINGS.opencodeModel;
            save();
          }),
        );
      const row = new Setting(containerEl)
        .setName("OpenCode model")
        .setDesc(
          `Model id in the provider/model form \`opencode models\` prints, e.g. deepseek/deepseek-flash. A model from a keyed provider is listed only once that provider has a key, so it can be missing before you sign in. ${known > 0 ? `${known} model${known === 1 ? "" : "s"} listed by the last Test.` : "Click Test to load the list."}`,
        )
        .addDropdown((d) => {
          for (const m of options) d.addOption(m, m);
          d.addOption(CUSTOM_MODEL, "Other…");
          d.setValue(s.opencodeModel).onChange((v) => {
            if (v === CUSTOM_MODEL) {
              custom.settingEl.show();
              return;
            }
            s.opencodeModel = v || DEFAULT_SETTINGS.opencodeModel;
            save();
          });
        });
      containerEl.insertBefore(row.settingEl, custom.settingEl);
      custom.settingEl.hide();
    } else {
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
      const options = modelOptions(s.knownModels, s.codexModel, CODEX_FALLBACK_MODELS);
      const known = s.knownModels.length;
      const custom = new Setting(containerEl)
        .setName("Codex model: type an id")
        .setDesc("For a model the list does not show.")
        .addText((t) =>
          t.setPlaceholder("model id").onChange((v) => {
            if (!v.trim()) return;
            s.codexModel = v.trim() || DEFAULT_SETTINGS.codexModel;
            save();
          }),
        );
      const row = new Setting(containerEl)
        .setName("Codex model")
        .setDesc(
          `Model slug passed to codex exec. gpt-5.5 is the lightest on your usage limit; gpt-5.6-luna and gpt-5.6-terra are newer and heavier. ${known > 0 ? `${known} model${known === 1 ? "" : "s"} listed by the last Test.` : "Click Test to load the list."}`,
        )
        .addDropdown((d) => {
          for (const m of options) d.addOption(m, m);
          d.addOption(CUSTOM_MODEL, "Other…");
          d.setValue(s.codexModel).onChange((v) => {
            if (v === CUSTOM_MODEL) {
              custom.settingEl.show();
              return;
            }
            s.codexModel = v || DEFAULT_SETTINGS.codexModel;
            save();
          });
        });
      containerEl.insertBefore(row.settingEl, custom.settingEl);
      custom.settingEl.hide();
    }

    new Setting(containerEl)
      .setName("Effort")
      .setDesc(
        s.provider === "deepseek"
          ? "How much reasoning DeepSeek spends per call. It accepts low, high and max; medium and xhigh both land on high, which is the level the API maps them to. Thinking is always on."
          : s.provider === "opencode"
            ? "Unused by OpenCode, which carries a model's reasoning level in the model id itself: append #low, #high or #max to an id whose model offers that variant, e.g. deepseek/deepseek-flash#high. Recall Studio passes the id through unchanged rather than guessing a variant, because naming one the model does not offer fails the call."
            : "Reasoning effort passed to Codex. Levels the chosen model does not support (gpt-5.5 stops at xhigh) are rounded down automatically.",
      )
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

    new Setting(containerEl)
      .setName("Recall Studio folder")
      .setDesc(
        "Where Recall Studio keeps its own files: the card rules note, your inbox, and the rule suggestions. Keep it outside the wiki folder. Reload Recall Studio after you change it. Files already in the old folder stay there. Move them by hand if you want to keep them.",
      )
      .addText((t) =>
        t.setValue(s.schemaFolder).onChange((v) => {
          s.schemaFolder = v.trim() || DEFAULT_SETTINGS.schemaFolder;
          save();
        }),
      );

    new Setting(containerEl).setName("Card quality").setHeading();

    new Setting(containerEl)
      .setName("Independent audit")
      .setDesc(
        "New cards always receive an independent source audit, one bounded repair attempt when needed, and a separate recheck after repair. Unresolved drafts stay held for explicit Retry; this legacy toggle cannot bypass that gate. Verify remains optional for older or hand-written cards. Auditing is not export approval; you decide what to export.",
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
      .setName("Propose card rules from my edits")
      .setDesc(
        "When the same correction shows up in three or four of your card edits, Recall Studio writes a proposed rule to `recall-suggestions.md` and shows a chip in the inbox. Nothing enters the card rules note until you accept it.",
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
        "Off by default — Recall Studio sends passages to the inbox without editing your notes. Marking wraps the passage in ==…==, which can break headings and list formatting when a passage spans more than one line. Pages under the wiki folder are never marked.",
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

    new Setting(containerEl).setName("Sources").setHeading();

    new Setting(containerEl)
      .setName("Wiki folder")
      .setDesc("The folder your wiki or sources live in. Capture never marks these pages.")
      .addText((t) =>
        t.setValue(s.topicFolder).onChange((v) => {
          s.topicFolder = v.trim() || DEFAULT_SETTINGS.topicFolder;
          void this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName("Existing Spaced Repetition cards").setHeading();
    new Setting(containerEl)
      .setName("Recognize existing SR cards")
      .setDesc("Read-only syntax indicators and source history. Off by default; configure eligible tags or exact note paths below. These are explicit settings, not detected SR configuration. No SR installation is required. No scheduling or Inbox records are written.")
      .addToggle(t => t.setValue(s.srRecognitionEnabled).onChange(v => { s.srRecognitionEnabled = v; save(); }));
    const srText = (name: string, key: keyof Omit<SrRecognitionSettings, "srRecognitionEnabled" | "srHighlightCloze" | "srBoldCloze">, desc: string) =>
      new Setting(containerEl).setName(name).setDesc(desc).addText(t => t.setValue(s[key]).onChange(v => { s[key] = v; save(); }));
    srText("SR body tags", "srRecognitionTags", "Space-separated tags, including # (for example #flashcards). Matching body tags or their subtags enable the note. Frontmatter tags are not used; use an exact note path instead. Empty means no tag scope.");
    new Setting(containerEl).setName("SR note paths")
      .setDesc("One exact vault-relative Markdown path per line. Either a listed path or a configured body tag is required; access exclusions still apply.")
      .addTextArea(t => t.setValue(s.srRecognitionNotePaths).onChange(v => { s.srRecognitionNotePaths = v; save(); }));
    srText("SR single-line separator", "srSingleLineSeparator", "Reference default ::. Empty disables this format. Longest inline separator wins before multiline or cloze syntax.");
    srText("SR reversed single-line separator", "srSingleLineReversedSeparator", "Reference default :::. Recognition identifies an existing reversed question, not a generated-card count.");
    srText("SR multiline separator", "srMultilineSeparator", "Reference default ?. Separator must occupy its own line, with nonempty text on both sides.");
    srText("SR reversed multiline separator", "srMultilineReversedSeparator", "Reference default ??. Separator must occupy its own line.");
    srText("SR multiline end marker", "srMultilineEndMarker", "Reference default is empty (a blank line ends the card). A configured marker occupies its own line and permits blank lines inside cards.");
    new Setting(containerEl).setName("SR plain highlight clozes")
      .setDesc("Recognize plain ==answer== and {{answer}} paragraphs. Indexed/hinted or custom cloze patterns and complex excluded blocks are unsupported. Syntax recognition does not verify scheduling or learning progress.")
      .addToggle(t => t.setValue(s.srHighlightCloze).onChange(v => { s.srHighlightCloze = v; save(); }));
    new Setting(containerEl).setName("SR bold clozes")
      .setDesc("Also treat **bold** spans as cloze deletions. Off by default: bold is ordinary emphasis in most study notes, so enabling this marks emphasised text as a hidden answer. Highlight and curly-brace clozes are unaffected.")
      .addToggle(t => t.setValue(s.srBoldCloze === true).onChange(v => { s.srBoldCloze = v; save(); }));

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
            new Notice("Recall Studio: note types detected.");
          } catch (e) {
            new Notice(`Recall Studio: ${(e as Error).message}`);
          }
        }),
      );

    const field = (name: string, key: keyof RecallSettings, desc = "") =>
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
