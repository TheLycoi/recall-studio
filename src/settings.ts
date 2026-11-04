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
  /** External pinned LearnHarness skill; empty uses the explicit installer's location. */
  learnSkillPath?: string;
  /** Empty uses LearnHarness's desktop data directory. */
  learnDataPath?: string;
  /** Absolute Python 3.10+ executable; empty checks standard locations. */
  learnPythonPath?: string;
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
  /** Cheap overrides belong to the selected provider; omitted values inherit Strong. */
  cheapModels?: Partial<Record<Provider, string>>;
  cheapEffort?: Effort;
  /** Retained only for compatibility with saved settings; no writing quota. */
  maxCardsPerHighlight: number;
  contextChars: number;
  language: string;
  /** Legacy saved field; ignored by card requests. */
  writerInstructions: string;
  concurrency: number;
  notifyWhenReady: boolean;
  /** Recall data folder: inbox, captured passages and revision history. */
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
  /** Legacy saved field; automatic generation checks cannot be disabled. */
  critiquePass: boolean;
  /** What happens to a card that fails a deterministic lint check. */
  lintMode: LintMode;
  /** Legacy saved field; card requests do not use edit-history examples. */
  historyExamples: boolean;
  /** Legacy saved field; rule learning is retired. */
  schemaLearning: boolean;
}

const CUSTOM_MODEL = "__custom__";

export const DEFAULT_SETTINGS: RecallSettings = {
  ...SR_RECOGNITION_DEFAULTS,
  learnSkillPath: "",
  learnDataPath: "",
  learnPythonPath: "",
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
  historyExamples: false,
  schemaLearning: false,
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

    new Setting(containerEl).setName("LearnHarness skill").setHeading();
    new Setting(containerEl).setName("Open Learn").setDesc("Read-only chat using the upstream LearnHarness skill and your configured provider. Requires its pinned skill installation and Python 3.10+; this does not run the teaching application.").addButton(b => b.setButtonText("Open Learn").onClick(() => void this.plugin.openLearn()));
    for (const [key, label, description] of [
      ["learnSkillPath", "Skill folder", "Folder containing SKILL.md, scripts and references. Leave empty for the pinned installer's location. No code is downloaded on startup."],
      ["learnDataPath", "LearnHarness data folder", "Absolute folder containing chats/ and graph/. Leave empty for LearnHarness's desktop default. Records stay read-only."],
      ["learnPythonPath", "Python executable", "Absolute path to Python 3.10+. Leave empty to check standard installations."],
    ] as const) {
      new Setting(containerEl).setName(label).setDesc(description).addText(t => t.setValue(s[key] ?? "").onChange(value => { s[key] = value.trim(); save(); }));
    }

    new Setting(containerEl).setName("Agents").setHeading();
    new Setting(containerEl).setName("Model roles").setDesc("Strong is the main model for thinking, planning and quality checks. Cheap reads the captured source context and writes or repairs cards. Context collection stays local; no extra model stage is added. Prompts and checks are unchanged. Unset Cheap options inherit Strong.");

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
        .setName("Strong model: type an id")
        .setDesc("For a model the list does not show.")
        .addText((t) =>
          t.setPlaceholder("model id").onChange((v) => {
            if (!v.trim()) return;
            s.deepseekModel = v.trim() || DEFAULT_SETTINGS.deepseekModel;
            save();
          }),
        );
      const row = new Setting(containerEl)
        .setName("Strong model")
        .setDesc(
          `Main model id sent to api.deepseek.com for planning and quality checks. ${known > 0 ? `${known} model${known === 1 ? "" : "s"} listed by the last Test.` : "Click Test to load the list."}`,
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
        .setName("Strong model: type an id")
        .setDesc("For a model the list does not show.")
        .addText((t) =>
          t.setPlaceholder("provider/model").onChange((v) => {
            if (!v.trim()) return;
            s.opencodeModel = v.trim() || DEFAULT_SETTINGS.opencodeModel;
            save();
          }),
        );
      const row = new Setting(containerEl)
        .setName("Strong model")
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
        .setName("Strong model: type an id")
        .setDesc("For a model the list does not show.")
        .addText((t) =>
          t.setPlaceholder("model id").onChange((v) => {
            if (!v.trim()) return;
            s.codexModel = v.trim() || DEFAULT_SETTINGS.codexModel;
            save();
          }),
        );
      const row = new Setting(containerEl)
        .setName("Strong model")
        .setDesc(
          `Main model slug passed to codex exec for planning and quality checks. ${known > 0 ? `${known} model${known === 1 ? "" : "s"} listed by the last Test.` : "Click Test to load the list."}`,
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
      .setName("Strong effort")
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

    const cheap = s.cheapModels?.[s.provider] ?? "";
    const fallback = s.provider === "deepseek" ? DEEPSEEK_FALLBACK_MODELS : s.provider === "opencode" ? OPENCODE_FALLBACK_MODELS : CODEX_FALLBACK_MODELS;
    const setCheap = (value: string) => {
      s.cheapModels = { ...s.cheapModels };
      if (value.trim()) s.cheapModels[s.provider] = value.trim();
      else delete s.cheapModels[s.provider];
      save();
    };
    const cheapCustom = new Setting(containerEl).setName("Cheap model: type an id")
      .setDesc("An exact model id for the selected provider. Clear it to inherit Strong.")
      .addText(t => t.setValue(cheap).setPlaceholder("model id").onChange(setCheap));
    const cheapRow = new Setting(containerEl).setName("Cheap model")
      .setDesc("Reads the original source context and writes, rewrites and repairs cards. Strong independently checks the result. No cost or quality ranking is implied by the role name.")
      .addDropdown(d => {
        d.addOption("", "Same as Strong");
        for (const model of modelOptions(s.knownModels, cheap, fallback)) d.addOption(model, model);
        d.addOption(CUSTOM_MODEL, "Other…");
        d.setValue(cheap).onChange(value => {
          if (value === CUSTOM_MODEL) { cheapCustom.settingEl.show(); return; }
          setCheap(value); this.display();
        });
      });
    containerEl.insertBefore(cheapRow.settingEl, cheapCustom.settingEl);
    cheapCustom.settingEl.hide();
    new Setting(containerEl).setName("Cheap effort")
      .setDesc("Overrides Strong effort for writing and repairs. OpenCode uses model-id variants instead; the selected provider's supported levels still apply.")
      .addDropdown(d => d.addOptions({ "": "Same as Strong", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" })
        .setValue(s.cheapEffort ?? "").onChange(value => {
          if (value) s.cheapEffort = value as Effort;
          else delete s.cheapEffort;
          save();
        }));

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
      .setName("Recall data folder")
      .setDesc(
        "Where Recall Studio keeps the inbox, captures and revision history. Keep it outside the wiki folder. Reload Recall Studio after changing it. Existing files stay in the old folder; changing this path does not move them.",
      )
      .addText((t) =>
        t.setValue(s.schemaFolder).onChange((v) => {
          s.schemaFolder = v.trim() || DEFAULT_SETTINGS.schemaFolder;
          save();
        }),
      );

    new Setting(containerEl).setName("Automatic source checks")
      .setDesc("New cards receive automatic source checks, one bounded repair attempt and a recheck when needed. Unresolved drafts stay held for explicit Retry. These checks are not proof of truth; review your cards before exporting.");

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
    field("Cloze extra field", "clozeExtraField", "Required for source links or card extras. Choose a field distinct from Text and show it only on the back of the Anki template.");

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
