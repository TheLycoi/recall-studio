// Pure inbox-file logic: parsing inbox.json and appending a CardRevision.
// Kept free of Obsidian imports (see src/util.ts) so InboxStore's disk format
// can be unit-tested with node directly; InboxStore itself imports `obsidian`
// and so cannot be.
import type { CardRevision, InboxData } from "./model";
import { z } from "zod";
import { PreparationOut, AuditOut, GenerationProvenanceOut, ScopedSourceFindingOut } from "./generation";
import { QualityAcceptanceOut } from "./qualityAcceptance";

const AuditStatus = z.enum(["verified", "unverified", "failed"]);

const CardRecord = z.object({
  id: z.string(), kind: z.enum(["qa", "cloze"]), status: z.enum(["pending", "approved", "exported", "duplicate", "deleted", "flagged"]),
  front: z.string(), back: z.string(), text: z.string(), extra: z.string(),
  highlightId: z.string().optional(), edited: z.boolean().optional(), ankiNoteId: z.number().optional(),
  srNote: z.string().optional(), createdAt: z.string().optional(), critiqueReason: z.string().optional(),
  bloom: z.string().optional(), critiqueRan: z.boolean().optional(),
  lintFailures: z.array(z.string()).optional(), lintWarnings: z.array(z.string()).optional(),
  qualityAcceptance: QualityAcceptanceOut.optional(),
  userCheck: z.object({ content: z.string(), at: z.string(), issues: z.array(z.string()) }).optional(),
  exportAcceptance: z.object({ content: z.string(), at: z.string(), issues: z.array(z.string()) }).optional(),
  generation: z.object({
    batchId: z.string(), planId: z.string(), factIds: z.array(z.string()),
    audit: z.object({ status: AuditStatus, reason: z.string(), content: z.string(), sourceKey: z.string().optional(), provenance: GenerationProvenanceOut.optional() }),
  }).optional(),
});
const AuditRecord = z.object({
  sourceFindings: z.array(ScopedSourceFindingOut).optional(),
  status: AuditStatus, reason: z.string(), verdicts: AuditOut.shape.verdicts,
  contents: z.array(z.string()).optional(), provenance: GenerationProvenanceOut.optional(),
});
const HeldFindings = z.array(z.object({ cardId: z.string(), reasons: z.array(z.string()) }));
const BatchRecord = z.object({
  version: z.literal(1), id: z.string(), instruction: z.string(), inputKey: z.string(),
  provenance: GenerationProvenanceOut.optional(),
  phase: z.enum(["preparing", "writing", "auditing", "repairing", "rechecking", "blocked", "complete"]),
  preparation: PreparationOut.optional(), drafts: z.array(CardRecord).optional(),
  preparationRequested: z.boolean().optional(), writingRequested: z.boolean().optional(),
  writerOutput: z.unknown().optional(), writerHistory: z.array(z.unknown()).optional(),
  audit: AuditRecord.optional(), finalAudit: AuditRecord.optional(), auditHistory: z.array(AuditRecord).optional(),
  auditRequested: z.boolean().optional(), finalAuditRequested: z.boolean().optional(), committed: z.boolean().optional(),
  blocked: HeldFindings.optional(), retryFindings: HeldFindings.optional(), repairRound: z.number().optional(),
  repairs: z.array(z.object({
    cardId: z.string(), round: z.number(), content: z.string(), findings: z.array(z.string()), requested: z.boolean(),
    output: z.unknown().optional(), candidate: CardRecord.optional(), error: z.string().optional(),
  })).optional(),
});
const HighlightRecord = z.object({
  id: z.string(), sourcePath: z.string(), sourceTitle: z.string(), text: z.string(),
  before: z.string(), after: z.string(), instruction: z.string(), status: z.enum(["queued", "generating", "ready", "exported", "error", "dismissed"]),
  cards: z.array(CardRecord), archived: z.boolean().optional(),
  line: z.number().optional(), page: z.number().nullable().optional(),
  heading: z.string().nullable().optional(), blockId: z.string().nullable().optional(),
  title: z.string().optional(), origin: z.string().optional(), subpath: z.string().optional(),
  error: z.string().nullable().optional(), createdAt: z.string().optional(),
  generatedAt: z.string().nullable().optional(), exportedAt: z.string().nullable().optional(),
  generation: BatchRecord.optional(), generationHistory: z.array(BatchRecord).optional(),
});
const CardSnapshot = CardRecord.pick({ kind: true, front: true, back: true, text: true, extra: true });
const InboxFile = z.object({
  version: z.literal(1).optional(), highlights: z.array(HighlightRecord),
  highlightInstructions: z.record(z.string(), z.string()).optional(),
  ingested: z.record(z.string(), z.string()).optional(),
  transcripts: z.record(z.string(), z.object({
    text: z.string(), origin: z.string().optional(), sourceFile: z.string().nullable().optional(),
    addedAt: z.string().optional(), truncated: z.boolean().optional(),
  })).optional(),
  revisions: z.array(z.object({
    before: CardSnapshot, after: CardSnapshot, instruction: z.string(),
    cardId: z.string().optional(), at: z.string().optional(), via: z.string().optional(),
  })).optional(),
});

/** Revisions are kept vault-wide, not per-card, so one number bounds the file. */
export const REVISION_CAP = 200;

/** Remembered highlight instructions are one per file; the cap bounds a vault with thousands of notes. */
export const INSTRUCTION_CAP = 200;

export function emptyInbox(): InboxData {
  return { version: 1, highlights: [] };
}

export type ParsedInbox =
  | { ok: true; data: InboxData; fresh: boolean }
  | { ok: false; reason: "invalid-json" | "bad-shape"; detail: string };

/**
 * Parse the raw contents of inbox.json. Never throws: a truncated write or a
 * hand-edited file becomes a typed failure instead of an exception, so the
 * caller can decide what to do with the bad file rather than losing it.
 *
 * `fresh` distinguishes blank, never-written input from a serialized empty
 * inbox. A blank file is not proof of a completed save and must not supersede
 * recovery data; the caller decides whether a new writable inbox is safe.
 *
 * Validate the fields consumers need, without adding defaults or filtering
 * records. Return the original object so unknown legacy fields survive saves.
 */
export function parseInboxJson(raw: string): ParsedInbox {
  if (raw.trim() === "") return { ok: true, data: emptyInbox(), fresh: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: "invalid-json", detail: (e as Error).message };
  }
  const checked = InboxFile.safeParse(parsed);
  if (!checked.success) {
    return { ok: false, reason: "bad-shape", detail: checked.error.message };
  }
  return { ok: true, data: parsed as InboxData, fresh: false };
}

/**
 * Append a card revision, oldest first, dropping from the front once the
 * cap is exceeded. Creates `data.revisions` when this is the first one.
 */
export function pushRevision(data: InboxData, rev: CardRevision, cap = REVISION_CAP): void {
  data.revisions ??= [];
  data.revisions.push(rev);
  if (data.revisions.length > cap) data.revisions.splice(0, data.revisions.length - cap);
}

/**
 * Remember the last instruction the reader gave AI highlight for one file, so
 * the modal opens with it next time. Keys are kept oldest first: setting a
 * file again moves it to the end, and past the cap the least recently used
 * files are forgotten. An empty instruction forgets the file, since an empty
 * box is already the default.
 */
export function rememberInstruction(data: InboxData, path: string, instruction: string, cap = INSTRUCTION_CAP): void {
  const map = (data.highlightInstructions ??= {});
  delete map[path];
  const text = instruction.trim();
  if (!text) return;
  map[path] = text;
  const keys = Object.keys(map);
  for (const k of keys.slice(0, Math.max(0, keys.length - cap))) delete map[k];
}

/**
 * The instruction one generation run reads. An extra instruction typed for
 * "Write more cards" wins for that run only; a blank one falls back to the
 * instruction stored on the highlight. Never writes anything back, so the
 * Ask or quiz-miss instruction the highlight was captured with survives.
 */
export function nextInstruction(base: string | undefined, extra: string): string {
  return extra.trim() ? extra.trim() : (base ?? "");
}
