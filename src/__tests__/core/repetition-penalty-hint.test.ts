// repetition-penalty-hint.test.ts
//
// v1.26.3 PATCH follow-up (user E2E 2026-08-13): a custom `repetitionPenalty`
// above 1.0 was confirmed (on qwen3.5-9b / gemma-4-12b via LM Studio) to
// break grammar-constrained extraction — the model bails with empty or
// mis-structured JSON, and the ingest fails with a generic "Source analysis
// failed" message that never mentioned the setting. This helper appends a
// localized hint to that failure message ONLY when the user opted into the
// setting AND the current provider actually sends it, so the fix is
// actionable and not misleading.

import { describe, it, expect } from 'vitest';
import { buildRepetitionPenaltyHint } from '../../core/repetition-penalty-hint';

// `lmstudio` puts the field on the wire (`repeat_penalty`), so the hint fires.
// `deepseek` drops it, so the hint must be suppressed there.
const WIRE_PROVIDER = 'lmstudio';
const DROP_PROVIDER = 'deepseek';

describe('buildRepetitionPenaltyHint', () => {
  it('returns an empty string when no custom repetitionPenalty is set', () => {
    expect(buildRepetitionPenaltyHint('en', undefined, WIRE_PROVIDER)).toBe('');
    // 1.0 is a no-op value (no penalty) — a user who set it deliberately is
    // not at risk, but the value is still "custom". Treat any defined value
    // as opted-in so the hint surfaces for the exact failure class. Assert
    // the RENDERED interpolation (`String(1.0)` === '1'), not the template's
    // static "above 1.0" text — the latter would pass even if interpolation
    // were broken.
    expect(buildRepetitionPenaltyHint('en', 1.0, WIRE_PROVIDER)).toContain('penalty of 1 is set');
  });

  it('interpolates the set value into the localized hint', () => {
    const hint = buildRepetitionPenaltyHint('en', 1.5, WIRE_PROVIDER);
    expect(hint).toContain('1.5');
    expect(hint.toLowerCase()).toContain('repetition penalty');
    expect(hint.toLowerCase()).toContain('reduce');
  });

  it('returns a string meant to be appended (leading separator)', () => {
    expect(buildRepetitionPenaltyHint('en', 1.5, WIRE_PROVIDER).startsWith(' ')).toBe(true);
  });

  it('localizes the hint per language while keeping the value', () => {
    const zh = buildRepetitionPenaltyHint('zh', 1.5, WIRE_PROVIDER);
    expect(zh).toContain('1.5');
    expect(zh).not.toBe(buildRepetitionPenaltyHint('en', 1.5, WIRE_PROVIDER));
  });

  it('is suppressed when the provider drops the field (never reached the wire)', () => {
    // Issue #414 / DocTpoint review 2026-08-13: hinting "reduce or clear" for
    // a setting that was never sent is misinformation — the mirror image of
    // the silent-drop failure class. deepseek / anthropic / gemini / minimax
    // / glm drop repetitionPenalty by design (repetitionPenaltyWireField
    // returns null).
    expect(buildRepetitionPenaltyHint('en', 1.5, DROP_PROVIDER)).toBe('');
    expect(buildRepetitionPenaltyHint('en', 1.5, 'anthropic')).toBe('');
    expect(buildRepetitionPenaltyHint('en', 1.5, 'gemini')).toBe('');
    expect(buildRepetitionPenaltyHint('en', 1.5, 'glm')).toBe('');
    expect(buildRepetitionPenaltyHint('en', 1.5, 'minimax')).toBe('');
  });
});
