import { newId } from "./util";

export type HighlightStatus = "queued" | "generating" | "ready" | "exported" | "error" | "dismissed";
/**
 * "flagged" is a card the critique or the linter rejected. It stays in the
 * inbox with its reasons attached so the reviewer decides. It is not pending,
 * so `pendingItems` in main.ts keeps it out of Anki with no extra check.
 */
export type CardStatus = "pending" | "exported" | "duplicate" | "deleted" | "flagged";
export type CardKind = "qa" | "cloze";

/**
 * Deterministic lint rule ids. Declared here, not in lint.ts, so the linter
 * that produces them, the Card that stores them, and the inbox view that
 * renders a label for each share one union: renaming an id then fails to
 * compile instead of silently rendering no badge.
 */
export type LintFailureId =
  | "cloze-not-grounded"
  | "cloze-count"
  | "cloze-numbering"
  | "cloze-framing"
  | "qa-empty"
  | "qa-answer-long"
  | "qa-yes-no"
  | "card-long"
  | "answer-in-question";

export type LintWarningId = "duplicate-card" | "shared-answer" | "cross-interference";

/** Bloom's taxonomy level, judged by the critique pass. See README. */
export type BloomLevel = "remember" | "understand" | "apply" | "analyze" | "evaluate" | "create";

export interface Card {
  id: string;
  highlightId: string;
  kind: CardKind;
  /** Q&A front (question). Empty for cloze. */
  front: string;
  /** Q&A back (answer). Empty for cloze. */
  back: string;
  /** Cloze text with {{c1::...}} markers. Empty for Q&A. */
  text: string;
  extra: string;
  status: CardStatus;
  edited: boolean;
  ankiNoteId?: number;
  createdAt: string;
  /** Deterministic lint failures recorded when the card was generated. */
  lintFailures?: LintFailureId[];
  /** Deterministic lint warnings (including interference risks) recorded at generation; advisory, never change status. */
  lintWarnings?: LintWarningId[];
  /** One-sentence reason from the critique pass, shown to the reviewer. */
  critiqueReason?: string;
  /** Bloom level the critique judged this card to sit at. */
  bloom?: BloomLevel;
  /**
   * True when a critique verdict came back for this card. Absent means the
   * pass was off, skipped, or failed — not that the card was approved.
   */
  critiqueRan?: boolean;
}

export interface Highlight {
  id: string;
  sourcePath: string;
  sourceTitle: string;
  /** Verbatim highlighted text. */
  text: string;
  before: string;
  after: string;
  line: number;
  /** 1-indexed PDF page when the source is a PDF; null for markdown notes. */
  page: number | null;
  heading: string | null;
  blockId: string | null;
  /** Short AI or user-supplied label, e.g. "Catholic Church definition". */
  title: string;
  /** Per-highlight user instruction passed to the card writer. */
  instruction: string;
  status: HighlightStatus;
  error: string | null;
  createdAt: string;
  generatedAt: string | null;
  exportedAt: string | null;
  cards: Card[];
  origin: "selection" | "markdown-highlight" | "ai" | "highlighter" | "pdf" | "quiz" | "ask";
  /** PDF++ subpath (page=…&selection=…|annotation=…|rect=…) when the highlight came from a PDF++ link; lets the inbox open the exact highlight. */
  subpath?: string;
  /** Unused by Recall. Kept so an inbox file written by an earlier version still parses. */
  topicPath?: string;
}

export interface TranscriptRecord {
  text: string;
  origin: "pasted" | "file";
  sourceFile: string | null;
  addedAt: string;
  truncated: boolean;
}

/** The five fields a rewrite or a hand edit can change, frozen at one moment. */
export interface CardSnapshot {
  kind: CardKind;
  front: string;
  back: string;
  text: string;
  extra: string;
}

/**
 * One change the reader made to one card: what it said before, what it says
 * now, and how the change was asked for. Kept vault-wide in
 * `InboxData.revisions` rather than on the card, so it survives
 * `clearExported` and the cap is a single number. This is what the schema
 * note learns from (src/preferences.ts).
 */
export interface CardRevision {
  cardId: string;
  /** ISO timestamp of the edit. */
  at: string;
  /** "rewrite" = the model rewrote it from an instruction; "edit" = typed by hand. */
  via: "rewrite" | "edit";
  /** The rewrite instruction, or "" for a hand edit. */
  instruction: string;
  before: CardSnapshot;
  after: CardSnapshot;
}

export interface InboxData {
  version: 1;
  highlights: Highlight[];
  transcripts?: Record<string, TranscriptRecord>;
  /** Unused by Recall. Kept so an inbox file written by an earlier version still parses. */
  ingested?: Record<string, string>;
  /** Recent card edits, oldest first, capped by the store (src/inboxData.ts). */
  revisions?: CardRevision[];
  /** The last AI highlight instruction per file, least recently used first, capped (src/inboxData.ts). */
  highlightInstructions?: Record<string, string>;
}

export function makeHighlight(
  init: Partial<Highlight> & Pick<Highlight, "sourcePath" | "sourceTitle" | "text">,
): Highlight {
  return {
    id: newId("h"),
    before: "",
    after: "",
    line: 0,
    page: null,
    heading: null,
    blockId: null,
    title: "",
    instruction: "",
    status: "queued",
    error: null,
    createdAt: new Date().toISOString(),
    generatedAt: null,
    exportedAt: null,
    cards: [],
    origin: "selection",
    ...init,
  };
}

export function makeCard(highlightId: string, init: Partial<Card> & { kind: CardKind }): Card {
  return {
    id: newId("c"),
    highlightId,
    front: "",
    back: "",
    text: "",
    extra: "",
    status: "pending",
    edited: false,
    createdAt: new Date().toISOString(),
    ...init,
  };
}

export function isPdfHighlight(h: Highlight): boolean {
  return h.page !== null || /\.pdf$/i.test(h.sourcePath);
}

export function liveCards(h: Highlight): Card[] {
  return h.cards.filter((c) => c.status !== "deleted");
}

export function pendingCards(h: Highlight): Card[] {
  return h.cards.filter((c) => c.status === "pending");
}
