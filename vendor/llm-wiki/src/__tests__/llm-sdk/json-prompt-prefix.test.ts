// json-prompt-prefix.test.ts
//
// v1.26.3 PATCH Phase A1: the JSON-shape enforcement prefix moved out of
// an inline string in openai-compat-sdk-client.ts into a reusable
// constant. The test pins the contract that callers depend on:
//
//   1. The prefix is non-empty (it must convey the constraint).
//   2. The prefix names "JSON" so model-side parsers can recognize it.
//   3. The prefix mentions array/object closure (the most common
//      unconstrained-model failure mode).
//   4. The prefix explicitly forbids markdown fences (```json ... ```)
//      because some models default to fenced output when no response_format
//      field is on the wire.
//
// If any of these contracts drift, downstream callers (Tier 1 / Tier 2
// retries, plus future prompt-engineered callers) will produce
// unparseable JSON. The test is the regression guard.

import { describe, it, expect } from 'vitest';
import { JSON_ENFORCEMENT_SYSTEM_PREFIX } from '../../llm-sdk/json-prompt-prefix';

describe('JSON_ENFORCEMENT_SYSTEM_PREFIX — Tier 1/2 prompt companion', () => {
  it('is a non-empty string', () => {
    expect(typeof JSON_ENFORCEMENT_SYSTEM_PREFIX).toBe('string');
    expect(JSON_ENFORCEMENT_SYSTEM_PREFIX.length).toBeGreaterThan(0);
  });

  it('mentions JSON explicitly so the model-side parser can recognize the constraint', () => {
    expect(JSON_ENFORCEMENT_SYSTEM_PREFIX.toLowerCase()).toContain('json');
  });

  it('mentions array closure — the most common unconstrained-model failure', () => {
    // Without this hint, models on the wire-no-field path emit
    // `[{...},{...]` (missing `]`) at the end of long outputs.
    expect(JSON_ENFORCEMENT_SYSTEM_PREFIX).toMatch(/array|\[|]/i);
  });

  it('mentions object closure — second most common failure mode', () => {
    expect(JSON_ENFORCEMENT_SYSTEM_PREFIX).toMatch(/object|\{|\}/i);
  });

  it('forbids markdown fences so the model does not wrap output in ```json ... ```', () => {
    expect(JSON_ENFORCEMENT_SYSTEM_PREFIX.toLowerCase()).toMatch(/markdown|fence|```/);
  });
});