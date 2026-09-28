import { CLAUDE_CLI_MODELS, CODEX_FALLBACK_MODELS, DEFAULT_ROLES, modelOptions, providerModel, type ModelRole, type RoleChoice } from "./modelRoles";
import { App, Notice, PluginSettingTab, Setting, ButtonComponent } from "obsidian";
import type WikiLmPlugin from "./main";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type Provider = "anthropic" | "gemini" | "codex" | "claudecli";
export type MarkMode = "none" | "highlight" | "highlight+block";
export type LintMode = "badge" | "hide" | "drop";
export type SuggestGranularity = "minimal" | "standard" | "detailed";
export const SUGGEST_PER_PAGE: Record<SuggestGranularity, number> = { minimal: 1, standard: 2, detailed: 4 };

export interface WikiLmSettings {
  // LLM
  /** "anthropic": Messages API with an API key. "codex": OpenAI's Codex CLI signed in with a ChatGPT subscription. */
  provider: Provider;
  apiKey: string;
  /** Claude model ID (Anthropic provider). */
  model: string;
  /** Absolute path to the codex binary; empty = auto-detect (PATH, then the ChatGPT app bundle). */
  codexPath: string;
  /** Codex model slug, e.g. gpt-5.5. */
  codexModel: string;
  /** Absolute path to the claude binary; empty = auto-detect (PATH, then ~/.local/bin). */
  claudeCliPath: string;
  /** Claude Code model alias or ID, e.g. sonnet. */
  claudeCliModel: string;
  /** Google AI Studio API key (Gemini provider). */
  geminiApiKey: string;
  /** Gemini model ID, e.g. gemini-3.1-pro-preview. */
  geminiModel: string;
  /** What the last Test found each provider offering; the model dropdowns are built from it. */
  knownModels: Partial<Record<Provider, string[]>>;
  /** When on, lint, query and digest may each run on their own provider and model. */
  rolesEnabled: boolean;
  roles: Record<ModelRole, RoleChoice>;
  effort: Effort;
  maxCardsPerHighlight: number;
  contextChars: number;
  language: string;
  writerInstructions: string;
  highlighterInstructions: string;
  maxAiHighlights: number;
  transcriptMaxChars: number;
  /** Where lecture notes and transcripts (Wispr Flow exports) live; the transcript picker lists this folder first. */
  transcriptFolder: string;
  concurrency: number;
  notifyWhenReady: boolean;

  // Capture
  /** Off by default: capture sends passages to the inbox without editing the note. */
  markMode: MarkMode;
  /** Set once the 0.9.2 migration has forced markMode off for an install that predates it. */
  markModeMigrated: boolean;
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

  // PDF digest
  topicFolder: string;
  /** Vault folder holding `wikilm.md`, the reader's house rules, and `wikilm-suggestions.md`. */
  schemaFolder: string;
  digestMaxNotes: number;
  digestInstructions: string;
  paperTextMaxChars: number;

  // AI highlights for PDFs
  /** How many spans per page the model may pick when suggesting highlights. */
  suggestGranularity: SuggestGranularity;
  /** Upper bound on suggestions accepted across the whole PDF. */
  suggestMaxPerPdf: number;
  /** Pages sent to the model per batch request. */
  suggestPagesPerBatch: number;
  /** Folder for new concept notes created from suggested highlights. */
  wikiConceptsFolder: string;
  /** Folder for new entity notes created from suggested highlights. */
  wikiEntitiesFolder: string;
  /** Page format this vault's wiki uses: karpathy `type:` pages, or `class:` pages. */
  wikiSchema: "karpathy" | "class";
  suggestInstructions: string;

  // Lint wiki
  /** After the instant scan, the model reads the pages with findings and proposes rows; off, Lint wiki makes no model call. */
  lintModelReview: boolean;

  // Ask
  /** Passages the answer is written from; with the relevance filter on, the pool is three times this (at most 30) and the judge keeps up to this many. */
  askEvidenceCount: number;
  /** Entries of conversation sent to the model with a question (a question and its answer are two); the log keeps twice as many. */
  askMaxTurns: number;
  askInstructions: string;
  /** When the question's words match weakly and find fewer passages than `askEvidenceCount`, ask the model for the terms the notes would use. */
  askKeywordExpansion: boolean;
  /** Retrieve three times as many passages (at most 30), then spend one model call keeping only the ones that bear on the question. */
  askRelevanceFilter: boolean;
  /** Match each sentence of the answer against the cited notes locally, and list the ones no passage states. Marks, never deletes. */
  askClaimCheck: boolean;
  /** When the notes do not cover a question, let the model answer from general knowledge behind a warning. */
  askGeneralKnowledge: boolean;
  /** Show the line under an answer: how well the notes covered it, the retrieval route, and the class scope. */
  askShowGrounding: boolean;
  /** List the sentences that matched no passage under the answer; the count on the grounding line stays either way. */
  askShowUnmatched: boolean;
  /**
   * A runaway guard, not a target: the quiz ends when it brackets the edge of
   * what the reader knows. This only stops a session that never gets there.
   */
  quizCap: number;
  quizPoolSize: number;
  quizInstructions: string;

  // Sidebar
  /** Persisted by the view; no setting UI. */
  sidebarMode: "inbox" | "chat";

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

const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: "Anthropic (API key)",
  gemini: "Google Gemini (API key)",
  codex: "Codex (ChatGPT subscription)",
  claudecli: "Claude Code (Claude subscription)",
};
/** The names a provider's dropdown shows before any Test has listed its models. */
const FALLBACK_MODELS: Record<Provider, string[]> = { anthropic: [], gemini: [], codex: CODEX_FALLBACK_MODELS, claudecli: CLAUDE_CLI_MODELS };
const CUSTOM_MODEL = "__custom__";
const ROLE_ORDER: ModelRole[] = ["lint", "query", "digest"];
const ROLE_LABELS: Record<ModelRole, string> = { lint: "Lint", query: "Query", digest: "Digest" };
const ROLE_WORK: Record<ModelRole, string> = {
  lint: "the model review in Lint wiki and the fix plan's aliases, tags and duplicate checks",
  query: "Ask answers and the search terms behind them",
  digest: "digesting highlights and AI-highlighting into the wiki",
};

export const DEFAULT_SETTINGS: WikiLmSettings = {
  provider: "anthropic",
  apiKey: "",
  model: "claude-opus-5",
  codexPath: "",
  codexModel: "gpt-5.5",
  claudeCliPath: "",
  claudeCliModel: "sonnet",
  geminiApiKey: "",
  geminiModel: "gemini-3.1-pro-preview",
  knownModels: {},
  rolesEnabled: false,
  roles: { lint: { ...DEFAULT_ROLES.lint }, query: { ...DEFAULT_ROLES.query }, digest: { ...DEFAULT_ROLES.digest } },
  effort: "high",
  maxCardsPerHighlight: 5,
  contextChars: 700,
  language: "",
  writerInstructions: "",
  highlighterInstructions: "",
  maxAiHighlights: 12,
  transcriptMaxChars: 150000,
  transcriptFolder: "wiki/sources/wispr",
  concurrency: 2,
  notifyWhenReady: true,

  markMode: "none",
  markModeMigrated: true,
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
  exportFolder: "wiki/schema/exports",

  topicFolder: "classes",
  schemaFolder: "wiki/schema",
  digestMaxNotes: 6,
  digestInstructions: "",
  paperTextMaxChars: 60000,

  suggestGranularity: "standard",
  suggestMaxPerPdf: 40,
  suggestPagesPerBatch: 8,
  wikiConceptsFolder: "wiki/concepts",
  wikiEntitiesFolder: "wiki/entities",
  wikiSchema: "class",
  suggestInstructions: "",

  lintModelReview: true,

  askEvidenceCount: 6,
  askMaxTurns: 10,
  askInstructions: "",
  askKeywordExpansion: true,
  askRelevanceFilter: true,
  askClaimCheck: true,
  askGeneralKnowledge: false,
  askShowGrounding: true,
  askShowUnmatched: true,
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
   * Test: one tiny request on the provider and model, then the provider's
   * model list into the dropdowns. The probe is the answer; a list that
   * cannot be fetched is said and does not fail the test.
   */
  private async testProvider(b: ButtonComponent, provider: Provider, model: string): Promise<void> {
    const s = this.plugin.settings;
    b.setDisabled(true);
    try {
      const r = await this.plugin.llm.probeWith(provider, model);
      let listed = "";
      try {
        const list = await this.plugin.llm.listModels(provider);
        s.knownModels = { ...s.knownModels, [provider]: list };
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
      .setName("Provider")
      .setDesc(
        "Anthropic and Gemini use an API key. Codex uses OpenAI's Codex CLI signed in with your ChatGPT subscription, so no key is needed. Claude Code runs the `claude` CLI signed in to your Claude subscription; no key. Test sends one tiny request and loads the provider's model list into the dropdown below.",
      )
      .addDropdown((d) =>
        d
          .addOptions(PROVIDER_LABELS)
          .setValue(s.provider)
          .onChange((v) => {
            s.provider = v as Provider;
            save();
            this.display();
          }),
      )
      .addButton((b) =>
        b.setButtonText("Test").onClick(() => void this.testProvider(b, s.provider, providerModel(s, s.provider))),
      );

    // A model dropdown: what the last Test found, the value in use, and the
    // provider's known names, plus "Other…" for an id the list lacks.
    const modelRow = (name: string, desc: string, provider: Provider, get: () => string, set: (v: string) => void) => {
      const options = modelOptions(s.knownModels?.[provider], get(), FALLBACK_MODELS[provider]);
      const known = s.knownModels?.[provider]?.length ?? 0;
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
    };

    if (s.provider === "codex") {
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

      modelRow(
        "Codex model",
        "Model slug passed to codex exec. gpt-5.5 is the lightest on your usage limit; gpt-5.6-luna and gpt-5.6-terra are newer and heavier.",
        "codex",
        () => s.codexModel,
        (v) => (s.codexModel = v || DEFAULT_SETTINGS.codexModel),
      );
    } else if (s.provider === "gemini") {
      new Setting(containerEl)
        .setName("Gemini API key")
        .setDesc(
          "Leave empty to read GEMINI_API_KEY from the environment or the macOS keychain (service \u201CGEMINI_API_KEY\u201D or \u201CWikiLM Gemini API key\u201D). A key typed here is stored in data.json, which this vault syncs through iCloud in plaintext. Get one from Google AI Studio.",
        )
        .addText((t) => {
          t.inputEl.type = "password";
          t.setPlaceholder("AIza\u2026 or leave empty for keychain")
            .setValue(s.geminiApiKey)
            .onChange((v) => {
              s.geminiApiKey = v.trim();
              save();
            });
        });
      modelRow(
        "Gemini model",
        "gemini-3.1-pro-preview for quality; gemini-3-flash-preview is faster and cheaper.",
        "gemini",
        () => s.geminiModel,
        (v) => (s.geminiModel = v || DEFAULT_SETTINGS.geminiModel),
      );
    } else if (s.provider === "claudecli") {
      new Setting(containerEl)
        .setName("Claude Code CLI path")
        .setDesc(
          "Leave empty to auto-detect `claude` on the PATH or in ~/.local/bin. Otherwise paste the output of `which claude`. Sign in by running `claude` in a terminal; check with `claude auth status`.",
        )
        .addText((t) =>
          t.setPlaceholder("auto-detect").setValue(s.claudeCliPath).onChange((v) => {
            s.claudeCliPath = v.trim();
            save();
          }),
        );

      modelRow(
        "Claude Code model",
        "An alias such as sonnet, opus, or fable, or a full model id. sonnet is the default because the Claude Code session limit is shared with your interactive Claude Code sessions; opus for quality.",
        "claudecli",
        () => s.claudeCliModel,
        (v) => (s.claudeCliModel = v || DEFAULT_SETTINGS.claudeCliModel),
      );
    } else {
      new Setting(containerEl)
        .setName("Anthropic API key")
        .setDesc(
          "Leave empty to read ANTHROPIC_API_KEY from the environment or the macOS keychain (service “ANTHROPIC_API_KEY” or “WikiLM Anthropic API key”). A key typed here is stored in data.json, which this vault syncs through iCloud in plaintext.",
        )
        .addText((t) => {
          t.inputEl.type = "password";
          t.setPlaceholder("sk-ant-… or leave empty for keychain")
            .setValue(s.apiKey)
            .onChange((v) => {
              s.apiKey = v.trim();
              save();
            });
        });

      modelRow("Model", "Claude model ID used for highlighting and card writing.", "anthropic", () => s.model, (v) => (s.model = v || DEFAULT_SETTINGS.model));
    }

    new Setting(containerEl)
      .setName("Effort")
      .setDesc(
        s.provider === "codex"
          ? "Reasoning effort passed to Codex. Levels the chosen model does not support (gpt-5.5 stops at xhigh) are rounded down automatically."
          : s.provider === "gemini"
            ? "Sent to Gemini as its thinking level. Gemini's scale stops at high, so xhigh and max are rounded down to it."
            : s.provider === "claudecli"
              ? "Passed to the CLI as --effort; all five levels are accepted."
              : "How much reasoning the model spends per highlight. Highlights are small, so high is cheap.",
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
      .setName("Use different models for lint, query and digest")
      .setDesc(
        "Off, the provider above does everything. On, each of the three below may run on its own provider and model; card writing, critique, quizzes and highlighting stay on the provider above.",
      )
      .addToggle((t) =>
        t.setValue(s.rolesEnabled).onChange((v) => {
          s.rolesEnabled = v;
          save();
          this.display();
        }),
      );
    if (s.rolesEnabled) {
      for (const role of ROLE_ORDER) {
        const choice = s.roles[role];
        const row = new Setting(containerEl).setName(`${ROLE_LABELS[role]} model`).setDesc(`Runs ${ROLE_WORK[role]}.`);
        row.addDropdown((d) =>
          d
            .addOptions({ default: "Same as above", ...PROVIDER_LABELS })
            .setValue(choice.provider)
            .onChange((v) => {
              choice.provider = v as RoleChoice["provider"];
              choice.model = "";
              save();
              this.display();
            }),
        );
        if (choice.provider !== "default") {
          const prov = choice.provider;
          const inUse = choice.model || providerModel(s, prov);
          row.addDropdown((d) => {
            for (const m of modelOptions(s.knownModels?.[prov], inUse, FALLBACK_MODELS[prov])) d.addOption(m, m);
            d.setValue(inUse).onChange((v) => {
              choice.model = v;
              save();
            });
          });
          row.addButton((b) => b.setButtonText("Test").onClick(() => void this.testProvider(b, prov, choice.model || providerModel(s, prov))));
        }
      }
    }

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

    new Setting(containerEl)
      .setName("Standing instructions for the AI highlighter")
      .setDesc("Used by 'AI-highlight this note', e.g. 'Only pick definitions and numbers.'")
      .addTextArea((t) => {
        t.inputEl.rows = 3;
        t.inputEl.cols = 50;
        t.setValue(s.highlighterInstructions).onChange((v) => {
          s.highlighterInstructions = v;
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
      .setName("Max AI highlights per note")
      .addSlider((sl) =>
        sl
          .setLimits(3, 40, 1)
          .setValue(s.maxAiHighlights)
          .setDynamicTooltip()
          .onChange((v) => {
            s.maxAiHighlights = v;
            save();
          }),
      );

    new Setting(containerEl)
      .setName("Transcript size limit")
      .setDesc(
        "Characters of an attached lecture transcript sent to the highlighter; longer transcripts are cut at a sentence boundary.",
      )
      .addText((t) =>
        t.setValue(String(s.transcriptMaxChars)).onChange((v) => {
          const n = Number(v);
          s.transcriptMaxChars = Number.isInteger(n) && n > 0 ? n : DEFAULT_SETTINGS.transcriptMaxChars;
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
        "Off by default — WikiLM sends passages to the inbox without editing your notes. Marking wraps the passage in ==…==, which can break headings and list formatting when a passage spans more than one line.",
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

    new Setting(containerEl).setName("PDF digest").setHeading();

    new Setting(containerEl)
      .setName("Topic notes folder")
      .setDesc(
        "Topic notes are written to <folder>/<class code>/<title>.md; the class code comes from sources/class notes/<code>/ or is asked for.",
      )
      .addText((t) =>
        t.setValue(s.topicFolder).onChange((v) => {
          s.topicFolder = v.trim() || DEFAULT_SETTINGS.topicFolder;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Schema folder")
      .setDesc(
        "The plugin's own folder inside the wiki: `wikilm.md` (your house rules for pages and cards), `wikilm-suggestions.md`, and `inbox.json`, the inbox itself. Not indexed, linted or graphed as pages. Reload the plugin after changing it.",
      )
      .addText((t) =>
        t.setValue(s.schemaFolder).onChange((v) => {
          s.schemaFolder = v.trim() || DEFAULT_SETTINGS.schemaFolder;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Transcript folder")
      .setDesc(
        "Where your lecture notes and transcripts live (Wispr Flow exports, for instance). The transcript picker lists this folder first, newest note on top.",
      )
      .addText((t) =>
        t.setValue(s.transcriptFolder).onChange((v) => {
          s.transcriptFolder = v.trim() || DEFAULT_SETTINGS.transcriptFolder;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Max topic notes per PDF")
      .addSlider((sl) =>
        sl
          .setLimits(1, 12, 1)
          .setValue(s.digestMaxNotes)
          .setDynamicTooltip()
          .onChange((v) => {
            s.digestMaxNotes = v;
            save();
          }),
      );

    new Setting(containerEl)
      .setName("Paper text limit")
      .setDesc(
        "Characters of the PDF's text sent with the highlights when writing summaries; longer papers are cut at a sentence boundary.",
      )
      .addText((t) =>
        t.setValue(String(s.paperTextMaxChars)).onChange((v) => {
          const n = Number(v);
          s.paperTextMaxChars = Number.isInteger(n) && n > 0 ? n : DEFAULT_SETTINGS.paperTextMaxChars;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Standing instructions for the digest")
      .addTextArea((t) => {
        t.inputEl.rows = 3;
        t.inputEl.cols = 50;
        t.setValue(s.digestInstructions).onChange((v) => {
          s.digestInstructions = v;
          save();
        });
      });

    new Setting(containerEl).setName("AI highlights for PDFs").setHeading();

    new Setting(containerEl)
      .setName("Granularity")
      .setDesc("How many spans the model may pick on each page when suggesting highlights in a PDF.")
      .addDropdown((d) =>
        d
          .addOptions({ minimal: "Minimal (1 per page)", standard: "Standard (2 per page)", detailed: "Detailed (4 per page)" })
          .setValue(s.suggestGranularity)
          .onChange((v) => {
            s.suggestGranularity = v as SuggestGranularity;
            save();
          }),
      );

    new Setting(containerEl)
      .setName("Max suggestions per PDF")
      .addSlider((sl) =>
        sl
          .setLimits(5, 100, 1)
          .setValue(s.suggestMaxPerPdf)
          .setDynamicTooltip()
          .onChange((v) => {
            s.suggestMaxPerPdf = v;
            save();
          }),
      );

    new Setting(containerEl)
      .setName("Pages per batch")
      .setDesc("Pages sent to the model per request; long decks are processed in batches.")
      .addText((t) =>
        t.setValue(String(s.suggestPagesPerBatch)).onChange((v) => {
          const n = Number(v);
          s.suggestPagesPerBatch = Number.isInteger(n) && n > 0 ? n : DEFAULT_SETTINGS.suggestPagesPerBatch;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Wiki concepts folder")
      .setDesc(
        "Notes whose `class` frontmatter matches the PDF's class are offered to the model as targets; new concept notes are created here.",
      )
      .addText((t) =>
        t.setValue(s.wikiConceptsFolder).onChange((v) => {
          s.wikiConceptsFolder = v.trim() || DEFAULT_SETTINGS.wikiConceptsFolder;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Wiki entities folder")
      .setDesc(
        "Notes whose `class` frontmatter matches the PDF's class are offered to the model as targets; new entity notes are created here.",
      )
      .addText((t) =>
        t.setValue(s.wikiEntitiesFolder).onChange((v) => {
          s.wikiEntitiesFolder = v.trim() || DEFAULT_SETTINGS.wikiEntitiesFolder;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Standing instructions for PDF suggestions")
      .addTextArea((t) => {
        t.inputEl.rows = 3;
        t.inputEl.cols = 50;
        t.setValue(s.suggestInstructions).onChange((v) => {
          s.suggestInstructions = v;
          save();
        });
      });

    new Setting(containerEl).setName("Lint wiki").setHeading();

    new Setting(containerEl)
      .setName("Model reviews pages on lint")
      .setDesc(
        "After the instant scan, the model reads the pages with findings, judges unsupported sentences, nominates links and checks each page's kind. One request per five pages; nothing is written until you tick a row.",
      )
      .addToggle((t) =>
        t.setValue(s.lintModelReview).onChange((v) => {
          s.lintModelReview = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Ask")
      .setDesc(
        "A question costs one model call for the answer, one more when the evidence filter is on, and sometimes one to find other wording: one to three calls.",
      )
      .setHeading();

    new Setting(containerEl)
      .setName("Evidence per question")
      .setDesc(
        "How many passages the answer is written from. With “Filter evidence with the model” on, three times as many (at most 30) are retrieved and the filter keeps up to this many. No model call. More passages make each answer call longer.",
      )
      .addSlider((sl) =>
        sl
          .setLimits(4, 30, 1)
          .setValue(s.askEvidenceCount)
          .setDynamicTooltip()
          .onChange((v) => {
            s.askEvidenceCount = v;
            save();
          }),
      );

    new Setting(containerEl)
      .setName("Conversation turns kept")
      .setDesc(
        "Entries of the conversation sent to the model with each question; a question and its answer are two. The log keeps twice that many. No model call. A longer history makes every answer call longer.",
      )
      .addSlider((sl) =>
        sl
          .setLimits(2, 30, 1)
          .setValue(s.askMaxTurns)
          .setDynamicTooltip()
          .onChange((v) => {
            s.askMaxTurns = v;
            save();
          }),
      );

    new Setting(containerEl)
      .setName("Standing instructions for Ask")
      .setDesc("Added to every answer call. No model call.")
      .addTextArea((t) => {
        t.inputEl.rows = 3;
        t.inputEl.cols = 50;
        t.setValue(s.askInstructions).onChange((v) => {
          s.askInstructions = v;
          save();
        });
      });

    new Setting(containerEl)
      .setName("Find other wording when a question comes up short")
      .setDesc(
        "When your question's words match your notes only weakly and find fewer passages than the evidence count, the model turns the question into the terms your notes would use and they are searched for locally. One extra model call, only on those questions.",
      )
      .addToggle((t) =>
        t.setValue(s.askKeywordExpansion).onChange((v) => {
          s.askKeywordExpansion = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Filter evidence with the model")
      .setDesc(
        "Retrieve three times as many passages (at most 30), then keep only the ones a model judges to bear on the question. One extra model call per question. When it keeps none, the reply says so and no answer call is made.",
      )
      .addToggle((t) =>
        t.setValue(s.askRelevanceFilter).onChange((v) => {
          s.askRelevanceFilter = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Check the answer's sentences")
      .setDesc(
        "Match each sentence of the answer against the cited notes. No model call. Sentences that match no passage are listed under the answer; they are not deleted.",
      )
      .addToggle((t) =>
        t.setValue(s.askClaimCheck).onChange((v) => {
          s.askClaimCheck = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Answer from general knowledge when your notes do not")
      .setDesc(
        "Off, a question your notes do not cover is answered with that fact and nothing else, and an answer the model drew from general knowledge is replaced by that refusal. On, the model may answer from what it knows, with a warning above the answer; it can be sent to the inbox marked unverified. Costs one answer call on questions that would otherwise be refused without one.",
      )
      .addToggle((t) =>
        t.setValue(s.askGeneralKnowledge).onChange((v) => {
          s.askGeneralKnowledge = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Show the grounding line under answers")
      .setDesc("The line under an answer: how well your notes covered it, the route that found the evidence, and the class it was searched in. No model call.")
      .addToggle((t) =>
        t.setValue(s.askShowGrounding).onChange((v) => {
          s.askShowGrounding = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("List unmatched sentences")
      .setDesc("List the sentences that matched no passage under the answer. The count on the grounding line stays.")
      .addToggle((t) =>
        t.setValue(s.askShowUnmatched).onChange((v) => {
          s.askShowUnmatched = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Question cap per quiz")
      .setDesc(
        "A safety limit, not a target. A quiz runs until it finds the edge of what you know; this only stops one that never does.",
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
      .setName("Evidence pool per quiz")
      .setDesc("How many matching highlights and claims a quiz draws its questions from.")
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
      .setDesc("Adds source::<note-slug> so the Anki Wiki Sync add-on can link the card back to its vault page.")
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
      .setDesc("Vault folder for Anki text-import files when AnkiConnect is unavailable.")
      .addText((t) =>
        t.setValue(s.exportFolder).onChange((v) => {
          s.exportFolder = v.trim() || DEFAULT_SETTINGS.exportFolder;
          save();
        }),
      );
  }
}
