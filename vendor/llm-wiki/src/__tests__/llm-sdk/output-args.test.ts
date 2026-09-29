// output-args.test.ts
//
// v1.26.3 PATCH Phase A3: buildOutputArgs accepts an OutputMode (one of
// 'json_schema' / 'json_object' / 'text_prompt') and emits one of
//   - { output: Output.object({schema, name}) }   for Tier 0 with schema
//   - { output: Output.json() }                    for Tier 1 (or Tier 0 with no schema)
//   - {}                                          for Tier 2 (or no response_format caller)
//
// Output shape (verified by inspection of the AI SDK v6 Output factory
// at node_modules/ai/dist/index.mjs): both Output.object() and Output.json()
// return an object with these public keys: `name`, `responseFormat`,
// `parseCompleteOutput`, `parsePartialOutput`, `createElementStreamTransform`.
//
// `responseFormat` is a Promise (the SDK awaits it inside generateText).
// The simple discriminator is `name`:
//   - Output.json()         → name === 'json'   (no schema, wire = json_object)
//   - Output.object({...})  → name === 'object' (with schema, wire = json_schema)
//
// We assert on `name` instead of probing the Promise / Symbol-keyed
// holders. The top-level `name` field is the documented public
// discriminator (the AI SDK's own docs use it).

import { describe, it, expect } from 'vitest';
import { buildOutputArgs } from '../../llm-sdk/output-args';
import type { OutputMode } from '../../llm-sdk/output-mode-prober';

describe('buildOutputArgs — 3-tier mode dispatch', () => {
  const schema = {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  } as const;

  // Helper to read the Output factory name (the public discriminator).
  const outputName = (result: { output?: unknown }): string | undefined =>
    (result.output as { name?: string } | undefined)?.name;

  describe('no response_format → always {} regardless of mode', () => {
    it.each<OutputMode>(['json_schema', 'json_object', 'text_prompt'])(
      'mode=%s returns {}',
      (mode) => {
        expect(buildOutputArgs(undefined, mode)).toEqual({});
      },
    );
  });

  describe('mode=json_schema', () => {
    it('with schema → Output.object (Tier 0 strongest, name="object")', () => {
      const result = buildOutputArgs({ type: 'json_object', schema }, 'json_schema');
      expect(outputName(result)).toBe('object');
    });

    it('without schema → Output.json() fallback (name="json")', () => {
      const result = buildOutputArgs({ type: 'json_object' }, 'json_schema');
      expect(outputName(result)).toBe('json');
    });
  });

  describe('mode=json_object', () => {
    it('emits Output.json() (name="json") regardless of schema presence', () => {
      // Schema is silently ignored because the AI SDK cannot attach a
      // schema to a json_object wire field. Documenting this here so
      // a future contributor doesn't try to "fix" it by promoting to
      // Output.object — that would violate the user's mode choice.
      const withSchema = buildOutputArgs({ type: 'json_object', schema }, 'json_object');
      const withoutSchema = buildOutputArgs({ type: 'json_object' }, 'json_object');
      expect(outputName(withSchema)).toBe('json');
      expect(outputName(withoutSchema)).toBe('json');
    });
  });

  describe('mode=text_prompt', () => {
    it('returns {} even when schema is supplied (we drop the wire field)', () => {
      // Tier 2 has no wire constraint. The schema is meaningless at this
      // tier (no SDK grammar enforcement) and would just confuse the
      // model. Caller is expected to add the JSON-shape enforcement
      // prefix to the system prompt at retry time.
      expect(buildOutputArgs({ type: 'json_object', schema }, 'text_prompt')).toEqual({});
    });
  });

  describe('backward-compat: default mode is json_schema', () => {
    // Phase B callers will start passing response_format with schema and
    // a mode; existing 16 callers that call buildOutputArgs without a
    // mode argument should behave as before (default = json_schema).
    it('omitting mode defaults to json_schema (Output.object when schema present)', () => {
      const result = buildOutputArgs({ type: 'json_object', schema });
      expect(outputName(result)).toBe('object');
    });

    it('omitting mode with no schema falls through to Output.json()', () => {
      const result = buildOutputArgs({ type: 'json_object' });
      expect(outputName(result)).toBe('json');
    });
  });
});