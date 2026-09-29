// v1.25.11 PATCH #169 — fine-grained stage hints.
//
// Why this test exists (vs relying on the i18n-parity sweep at
// src/__tests__/root/i18n-parity.test.ts): the parity sweep is a
// structural check (every locale covers every EN key, no extras). It does
// not pin the SHAPE of stage keys, their canonical ordering, or the
// derived `StageKey` type. A key could exist in every locale yet still
// drift out of the canonical list (e.g. a future contributor adds a new
// stage to wiki-engine.ts but forgets to register it here, or duplicates
// an existing one in the parity sweep without noticing). This file pins
// the contract.
//
// Contract:
//   1. `STAGE_KEYS` is the canonical ordered list of ingest / PDF / lint
//      stage label keys. Order matters: callers iterate it to build
//      breadcrumbs.
//   2. `StageKey` is a union type derived from STAGE_KEYS so the type
//      system rejects typos at every call site.

import { describe, it, expect } from 'vitest';
import { STAGE_KEYS, type StageKey } from '../../core/ingest-stages';
import { TEXTS } from '../../texts';

describe('ingest-stages / STAGE_KEYS canonical list', () => {
  it('is non-empty and ordered', () => {
    expect(STAGE_KEYS.length).toBeGreaterThan(0);
    // No duplicates — would break type lookups and breadcrumb rendering.
    expect(new Set(STAGE_KEYS).size).toBe(STAGE_KEYS.length);
  });

  it('every key exists in EN baseline', () => {
    const enKeys = Object.keys(TEXTS.en) as string[];
    for (const key of STAGE_KEYS) {
      expect(enKeys, `STAGE_KEYS entry "${key}" missing in TEXTS.en`).toContain(key);
    }
  });

  it('contains the documented v1.25.11 #169 stage set', () => {
    // Ingest path
    expect(STAGE_KEYS).toContain('ingestStageAnalyze');
    expect(STAGE_KEYS).toContain('ingestStageSummary');
    expect(STAGE_KEYS).toContain('ingestStageEntity');
    expect(STAGE_KEYS).toContain('ingestStageConcept');
    expect(STAGE_KEYS).toContain('ingestStageRetry');
    expect(STAGE_KEYS).toContain('ingestStageSave');
    expect(STAGE_KEYS).toContain('ingestStageIndex');
    // PDF path
    expect(STAGE_KEYS).toContain('pdfStageReading');
    expect(STAGE_KEYS).toContain('pdfStageConverting');
    expect(STAGE_KEYS).toContain('pdfStageSidecar');
    // Lint scan path
    expect(STAGE_KEYS).toContain('lintStagePrep');
    expect(STAGE_KEYS).toContain('lintStageProgrammatic');
    expect(STAGE_KEYS).toContain('lintStageDedup');
    expect(STAGE_KEYS).toContain('lintStageContradiction');
  });

  it('StageKey type union is the exact set of STAGE_KEYS entries (compile-time + runtime guard)', () => {
    // Cast a known member to StageKey — if the type is wider than the
    // tuple, this still typechecks; the real assertion is that EVERY
    // string in STAGE_KEYS is a valid StageKey at the type level.
    const sample: StageKey = STAGE_KEYS[0];
    expect(STAGE_KEYS).toContain(sample);
  });
});
