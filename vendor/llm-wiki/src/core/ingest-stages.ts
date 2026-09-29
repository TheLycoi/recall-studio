/**
 * v1.25.11 PATCH #169 — fine-grained stage labels for the status bar.
 *
 * The v3 plan moves the always-changing pipeline progress (e.g. "Analyzing
 * source", "Generating summary", "Detecting duplicates") from Notice popups
 * to the bottom-right status bar. The always-visible base label (e.g. the
 * localized "Ingesting… (click to cancel)" / "Linting… (click to cancel)" /
 * "Reading PDF: foo.pdf" string) stays put — these stage labels are
 * ADD-only emission sandwiched between the page name and the base label.
 *
 * This file holds the canonical ordered list of stage key names. Each
 * production call site resolves them through `getText()` directly — the
 * standard i18n access pattern used 350+ times in the codebase — so no
 * composition helper is layered on top. `STAGE_KEYS` exists for two
 * consumers:
 *   - Tests that assert "every key exists in every locale" via the
 *     bidirectional parity sweep.
 *   - Future UI (breadcrumbs, telemetry) that needs a single authoritative
 *     list of all available stage names.
 */

/**
 * Canonical ordered list of fine-grained stage keys.
 *
 * v3 plan coverage: ingest (7) + PDF (3) + lint scan (4) = 14 keys.
 */
export const STAGE_KEYS = [
  // Ingest pipeline — mirrors the 7 stages that wiki-engine.ts drives
  // through `onProgress` (analyze, summary, entity, concept, retry, save,
  // index). See `wiki-engine.ts:830-1069` for the per-stage emit points.
  'ingestStageAnalyze',
  'ingestStageSummary',
  'ingestStageEntity',
  'ingestStageConcept',
  'ingestStageRetry',
  'ingestStageSave',
  'ingestStageIndex',
  // PDF ingest pipeline — reading the file, LLM-driven conversion, optional
  // sidecar write when `writePdfMarkdownToVault` is on.
  'pdfStageReading',
  'pdfStageConverting',
  'pdfStageSidecar',
  // Lint SCAN pipeline (NOT lint fix) — preparation, programmatic checks,
  // LLM dedup pass, contradiction pass. Lint fix-all uses `makeMirroredNotice`
  // (lint/fix-runners.ts:33) which is already a dual-channel Notice +
  // status-bar mirror; no new keys needed there.
  'lintStagePrep',
  'lintStageProgrammatic',
  'lintStageAnalyzing',
  'lintStageDedup',
  'lintStageContradiction',
] as const;

/** Read-only tuple element type. */
export type StageKey = (typeof STAGE_KEYS)[number];
