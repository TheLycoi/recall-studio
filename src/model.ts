import { newId } from "./util";

export type HighlightStatus = "queued" | "generating" | "ready" | "exported" | "error" | "dismissed";
/**
 * A card's lifecycle. Generated cards are `pending` (shown as "Draft") until
 * the reviewer approves them, which is the only thing that makes a card
 * exportable. `approved` is written only by an explicit approve action
 * (src/inboxView.ts); editing or regenerating an approved card returns it to
 * `pending`, because the approved wording is no longer the stored one.
 * `flagged` is a card the critique or the linter rejected; it keeps its
 * reasons, stays visible in the inbox so the reviewer decides, and is never
 * approved implicitly or exported. `duplicate` and `deleted` are terminal
 * states for a card that already left or was removed. Only `approved` exports
 * (main.ts approvedItems) — the strict allowlist that keeps every other status
 * out of Anki.
 */
export type CardStatus = "pending" | "approved" | "exported" | "duplicate" | "deleted" | "flagged";
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

export type GenerationAuditStatus = "verified" | "unverified" | "failed";
export interface GenerationPreparation {
  facts: { id: string; statement: string; quote: string }[];
  plan: { id: string; factIds: string[]; entity: string; aspect: string; value: string; reason: string }[];
  exclusions: { factIds: string[]; reason: string }[];
  omissions: { factIds: string[]; reason: string }[];
  /** Conflicting or insufficient source evidence, separate from prompt quality. Empty or legacy absent factIds holds the whole capture. */
  conflicts: { quote: string; reason: string; factIds?: string[] }[];
}
export interface GenerationContext {
  /** Legacy saved batches may carry this field; it no longer limits writing. */
  maxCards?: number;
  language: string;
  instructions: string;
  rules: string;
  examples: string;
}
/** Runtime release identity, distinct from every persisted schema version. */
export interface GenerationBuild {
  release: string;
  commit?: string;
}
export interface GenerationProvenance {
  /** Absent means unknown, including historical records; never inferred from timestamps. */
  build?: GenerationBuild;
  sourceKey: string;
  /** Reuses the generation input key for source, authorized writing context and settings. */
  inputKey: string;
}
export interface GenerationAuditRecord {
  provenance?: GenerationProvenance;
  status: GenerationAuditStatus;
  reason: string;
  verdicts: { index: number; cardId: string; status: GenerationAuditStatus; reason: string; conflicts?: { quote: string; reason: string }[] }[];
  /** A verdict applies only to the exact candidate wording checked. */
  contents?: string[];
}
export interface GenerationRepair {
  cardId: string;
  round: number;
  content: string;
  findings: string[];
  requested: boolean;
  /** Retain even a rejected response without changing the original draft. */
  output?: unknown;
  candidate?: Card;
  error?: string;
}
export interface GenerationBatch {
  version: 1;
  /** New batch start only. Individual audit records retain their own runtime identity. */
  provenance?: GenerationProvenance;
  id: string;
  /** One-off request, retained across reloads; never replaces the capture instruction. */
  instruction: string;
  inputKey: string;
  phase: "preparing" | "writing" | "auditing" | "repairing" | "rechecking" | "blocked" | "complete";
  preparation?: GenerationPreparation;
  preparationRequested?: boolean;
  writingRequested?: boolean;
  writerOutput?: unknown;
  writerHistory?: unknown[];
  /** Stable original IDs and wording, retained privately even after repair. */
  drafts?: Card[];
  audit?: GenerationAuditRecord;
  auditRequested?: boolean;
  repairs?: GenerationRepair[];
  repairRound?: number;
  finalAudit?: GenerationAuditRecord;
  finalAuditRequested?: boolean;
  auditHistory?: GenerationAuditRecord[];
  /** Held drafts are not Inbox cards and cannot be edited or exported. */
  blocked?: { cardId: string; reasons: string[] }[];
  /** Findings explicitly authorized for one additional bounded retry. */
  retryFindings?: { cardId: string; reasons: string[] }[];
  committed?: boolean;
}

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
  /**
   * Vault path this card was written to as a Spaced Repetition note. Set only
   * by that export, so it also records which destination the card left to.
   */
  srNote?: string;
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
  generation?: {
    batchId: string;
    planId: string;
    factIds: string[];
    audit: { status: GenerationAuditStatus; reason: string; content: string; sourceKey?: string; provenance?: GenerationProvenance };
  };
  /** Present only after a user-requested check of this exact content. */
  userCheck?: { content: string; at: string; issues: string[] };
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
  /** Hidden from the active Inbox, but kept with its cards and source provenance. Absent on legacy records. */
  archived?: boolean;
  error: string | null;
  createdAt: string;
  generatedAt: string | null;
  exportedAt: string | null;
  cards: Card[];
  /** Optional staged-generation checkpoints; legacy captures have none. */
  generation?: GenerationBatch;
  /** Prior inventories/audits keep older cards’ fact IDs resolvable without a second card store. */
  generationHistory?: GenerationBatch[];
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
  /** "repair" is a best-practices fix, retained as history but not learned as a preference. */
  via: "rewrite" | "edit" | "repair";
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

/** Cards the reviewer has approved and that have not left the inbox yet. The only exportable set. */
export function approvedCards(h: Highlight): Card[] {
  return h.cards.filter((c) => c.status === "approved");
}

/** Every card still awaiting a decision: a draft, or one the critique flagged. */
export function undecidedCards(h: Highlight): Card[] {
  return h.cards.filter((c) => c.status === "pending" || c.status === "flagged");
}
