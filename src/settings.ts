import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type WikiLmPlugin from "./main";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type Provider = "anthropic" | "codex" | "claudecli";
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

  // Ask
  askEvidenceCount: number;
  askMaxTurns: number;
  askInstructions: string;
  /** Second model call per question that re-checks each drafted sentence against the evidence it cited. */
  /** When lexical search and the note graph leave an answer short, ask the model for better search terms. */
  askKeywordExpansion: boolean;
  /** When the notes do not cover a question, let the model answer from general knowledge behind a warning. */
  askGeneralKnowledge: boolean;
  /** Show the line under an answer reporting what was kept, removed, verified, and rejected. */
  askShowGrounding: boolean;
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

export const DEFAULT_SETTINGS: WikiLmSettings = {
  provider: "anthropic",
  apiKey: "",
  model: "claude-opus-5",
  codexPath: "",
  codexModel: "gpt-5.5",
  claudeCliPath: "",
  claudeCliModel: "sonnet",
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
  exportFolder: "wikilm-exports",

  topicFolder: "classes",
  schemaFolder: "wiki/sources/schema",
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

  askEvidenceCount: 6,
  askMaxTurns: 10,
  askInstructions: "",
  askKeywordExpansion: true,
  askGeneralKnowledge: false,
  askShowGrounding: true,
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

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => void this.plugin.saveSettings();

    new Setting(containerEl).setName("Card writer").setHeading();


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
        "Where WikiLM keeps `wikilm.md`, the note that holds your house rules for pages and cards, and `wikilm-suggestions.md`.",
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

    new Setting(containerEl).setName("Ask").setHeading();

    new Setting(containerEl)
      .setName("Evidence per question")
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
        "When your words and the linked notes do not fill the evidence list, the model turns the question into the terms your notes would use and they are searched for locally. One extra call, and only on questions that were about to come up short.",
      )
      .addToggle((t) =>
        t.setValue(s.askKeywordExpansion).onChange((v) => {
          s.askKeywordExpansion = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Answer from general knowledge when your notes do not")
      .setDesc(
        "Off, a question your notes do not cover is answered with that fact and nothing else. On, the model may answer from what it knows, with a warning above the answer saying it did not come from your notes.",
      )
      .addToggle((t) =>
        t.setValue(s.askGeneralKnowledge).onChange((v) => {
          s.askGeneralKnowledge = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Show the grounding line under answers")
      .addToggle((t) =>
        t.setValue(s.askShowGrounding).onChange((v) => {
          s.askShowGrounding = v;
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
