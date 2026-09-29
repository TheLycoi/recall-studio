// json-thinking-block-fallback.test.ts — Layer 3 fallback (#443 follow-up)
//
// v1.26.x PATCH follow-up (LMStudio + Qwen3.5 — Issue #443). Some
// reasoning-mode backends route the model's structured output into
// `reasoning_content` and leave `content` empty. parseJsonResponse was
// stripping `<think>...</think>` blocks before the balanced-JSON finder
// ran, discarding the JSON-shaped payload.
//
// Layer 3 captures the inner content of every `<think>...` / `<thinking>...`
// block before stripping, then re-examines them when Layer 1+2 found
// nothing. A schema-field gate (when caller passes `expectedSchemaFields`)
// rejects grammar-constrained placeholders like `{"": ""}`. Without the
// gate, a 2-non-empty-fields heuristic plays the same role.

import { describe, it, expect, vi } from 'vitest';
import { parseJsonResult, parseJsonResponse } from '../../core/json';

describe('parseJsonResult — Layer 3 thinking-block fallback (#443 follow-up)', () => {
  it('recovers a schema-shaped JSON from a thinking block when visible text is empty', async () => {
    // The Qwen3.5-on-LMStudio shape: model routed the JSON into
    // reasoning_content, content was empty.
    const response = '<think>{"entities": [{"name": "X"}], "concepts": []}</think>\n\n';
    const result = await parseJsonResult(response, undefined, {
      expectedSchemaFields: ['entities', 'concepts'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ entities: [{name: 'X'}], concepts: []});
    }
  });

  it('recovers JSON from thinking block when visible text was unparseable', async () => {
    // Visible text is prose, JSON is only in the thinking block.
    const response =
      '<think>{"entities": [{"name": "A"}], "summary": "yes"}</think>I cannot comply.';
    const result = await parseJsonResult(response, undefined, {
      expectedSchemaFields: ['entities'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ entities: [{name: 'A'}], summary: 'yes' });
    }
  });

  it('rejects a 5-token placeholder when expectedSchemaFields rejects empty keys', async () => {
    // The Qwen3.5 grammar-constrained placeholder shape: minimum-valid
    // JSON with one empty key/value pair.
    const response = '<think>{"": ""}</think>';
    const result = await parseJsonResult(response, undefined, {
      expectedSchemaFields: ['entities', 'concepts'],
    });
    // Schema gate rejects — no schema field names present.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('thinking-block-only');
    }
  });

  it('uses 2-non-empty-fields heuristic when no expectedSchemaFields given', async () => {
    // Without the schema gate, the heuristic accepts any object that has
    // >= 2 fields with non-empty values. `{"a": "x", "b": "y"}` passes.
    const response = '<think>{"a": "x", "b": "y"}</think>';
    const result = await parseJsonResult(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ a: 'x', b: 'y' });
    }
  });

  it('heuristic rejects the 5-token placeholder even without schema gate', async () => {
    const response = '<think>{"": ""}</think>';
    const result = await parseJsonResult(response);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('thinking-block-only');
    }
  });

  it('Layer 1+2 still take precedence when they can parse the visible text', async () => {
    // Even with a thinking block present, if visible text parses, that
    // wins. This is the "no regression for cloud providers" guarantee —
    // DeepSeek R1 / OpenAI o-series wrap their reasoning in <think>
    // tags; their visible text is the structured payload.
    const response =
      '<think>some reasoning about how to answer</think>{"entities": [{"name": "Z"}]}';
    const result = await parseJsonResult(response, undefined, {
      expectedSchemaFields: ['entities'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Visible text was parsed first.
      expect(result.value).toEqual({ entities: [{name: 'Z'}] });
    }
  });

  it('returns thinking-block-only when thinking exists but no schema match', async () => {
    // Thinking block has JSON, but the keys are not schema fields.
    const response = '<think>{"foo": "bar", "baz": "qux"}</think>';
    const result = await parseJsonResult(response, undefined, {
      expectedSchemaFields: ['entities', 'concepts'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('thinking-block-only');
    }
  });

  it('returns empty when there is no thinking block and no visible JSON', async () => {
    const response = '   \n\n   ';
    const result = await parseJsonResult(response);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('empty');
    }
  });
});

describe('parseJsonResponse — Layer 3 surfaced via legacy wrapper', () => {
  it('returns null and emits the thinking-block-only debug line when silentOnEmpty', async () => {
    const debugs = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const response = '<think>{"": ""}</think>';
    const result = await parseJsonResponse(response, undefined, {
      silentOnEmpty: true,
      expectedSchemaFields: ['entities'],
    });
    expect(result).toBeNull();
    // silentOnEmpty suppresses the noisy error path; uses debug line.
    expect(debugs.mock.calls.some((c) => String(c[0]).includes('thinking-block-only'))).toBe(true);
  });

  it('legacy wrapper passes expectedSchemaFields through to parseJsonResult', async () => {
    const debugs = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const response = '<think>{"entities": [{"name": "X"}]}</think>';
    const result = await parseJsonResponse(response, undefined, {
      expectedSchemaFields: ['entities'],
    });
    expect(result).toEqual({ entities: [{name: 'X'}] });
    // Layer 3 fallback debug line surfaced.
    expect(debugs.mock.calls.some((c) => String(c[0]).includes('thinking-block fallback'))).toBe(true);
  });
});

// ============================================================================
// Placeholder gate (#443 follow-up — user E2E 2026-08-11).
//
// `{"": ""}` is VALID JSON — JSON.parse succeeds on it. The Layer-3
// fallback above never runs because Layer 1's direct parse returns
// `{ "": "" }` as a success. A grammar-constrained reasoning model under
// tight thinking budget emits this minimum-valid-object placeholder, and
// downstream callers see `entities: undefined` — silently dropping the
// batch. These tests pin that EVERY parse-success path rejects the
// placeholder shape.
// ============================================================================
describe('parseJsonResult — placeholder gate ({"": ""} must not reach downstream)', () => {
  it('rejects bare {"": ""} (no thinking block) as thinking-block-only', async () => {
    // The user's exact E2E failure: SDK prepends `{"": ""}` and
    // parseJsonResponse Layer 1 JSON.parse succeeds — but the object is a
    // placeholder. Must return failure, not `{ "": "" }`.
    const result = await parseJsonResult('{"": ""}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('thinking-block-only');
    }
  });

  it('rejects {"": ""} when wrapped by the SDK prepend helper', async () => {
    // The SDK's prependReasoningForParse produces `{"": ""}\n\n` for the
    // empty-content case. The trailing whitespace must not change the
    // placeholder rejection.
    const result = await parseJsonResult('{"": ""}\n\n');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('thinking-block-only');
    }
  });

  it('rejects {"": ""} even when caller passes expectedSchemaFields', async () => {
    const result = await parseJsonResult('{"": ""}', undefined, {
      expectedSchemaFields: ['entities', 'concepts'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('thinking-block-only');
    }
  });

  it('rejects any all-empty-key object', async () => {
    // A model might emit `{"": "", "": ""}` or `{"": null}` — all
    // placeholder variants must be caught.
    const result = await parseJsonResult('{"": "", "": null}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('thinking-block-only');
    }
  });

  it.each([
    ['{"": {}}', 'empty-OBJECT value variant (user E2E 2026-08-13)'],
    ['{"": []}', 'empty-array value variant'],
  ])('rejects %s — %s', async (json, variant) => {
    // Grammar-constrained placeholders vary by run: `{"": ""}` (2026-08-11),
    // then `{"": {}}` / `{"": []}` (2026-08-13 on qwen3.5-9b). All are
    // minimum-valid-object bails the widened empty-value predicate must catch.
    const result = await parseJsonResult(json);
    expect(result).toMatchObject({ ok: false, reason: 'thinking-block-only' });
  });

  it('allows legitimate empty object {} through (real "no entities" intent)', async () => {
    // `{}` is a valid answer meaning "nothing extracted". It is NOT the
    // grammar-constrained placeholder shape (which always carries a
    // non-empty key). Downstream normalizeBatchResponse treats `{}` as
    // `validity: 'empty'` — the intended "stop iteration" signal.
    const result = await parseJsonResult('{}');
    expect(result.ok).toBe(true);
  });

  it('allows a real single-field object through (e.g. {"match": false})', async () => {
    // Legitimately small objects that are NOT placeholders must pass.
    const result = await parseJsonResult('{"match": false}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ match: false });
    }
  });

  it('allows {"a": "x", "b": "y"} (non-empty keys, non-empty values) through', async () => {
    const result = await parseJsonResult('{"a": "x", "b": "y"}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ a: 'x', b: 'y' });
    }
  });
});