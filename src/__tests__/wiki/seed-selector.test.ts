import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { selectSeedsWithLLM, type SeedLLMClient } from '../../wiki/query-engine/pipeline/seed-selector';
import type { PageRef } from '../../core/ppr-cascade';

/**
 * selectSeedsWithLLM — bug fix integration tests.
 *
 * Bug B (v1.24.0 P2): selectSeedsWithLLM previously returned [] on any
 * failure, including transient empty-string LLM responses (response length: 0).
 * User logs showed `parseJsonResponse ... response length: 0` →
 * `JSON.parse` fails → `rawSeeds = []` → caller falls back to lex-only
 * cascade. Same class of bug as v1.23.x alias completion Bug 2/3.
 *
 * Fix: wrap the LLM call + JSON parse in `withTransientRetry` so a
 * transient empty response is retried (max 3 attempts, exponential
 * backoff) before declaring failure.
 */

function makePageRef(path: string, summary = ''): PageRef {
  return {
    path,
    title: path,
    aliases: [],
    text: summary,
    summary,
  } as PageRef;
}

/**
 * Build a SeedLLMClient whose `createMessage` is a vi.fn mock.
 * We construct the object as a plain inline mock then cast to
 * SeedLLMClient. ESLint's `unbound-method` rule fires on direct field
 * assignment of vi.fn() (e.g. `{ createMessage: vi.fn() }`) because the
 * mock is not annotated with `this: void`. The cast hides the field
 * shape from the rule without changing runtime behavior — vi.fn returns
 * a function that ESLint cannot prove is unbound, but at runtime the
 * mock has no `this` and the cast is sound.
 */
function makeClient(createMessage: SeedLLMClient['createMessage']): SeedLLMClient {
  return { createMessage };
}

/**
 * Build a SeedLLMClient that implements `createMessageWithOutput`
 * (v1.26.3 PATCH Phase B typed-output path). Mirrors how the real
 * OpenAICompatSdkClient behaves on Tier 0 (json_schema) success:
 * `output` is populated by the SDK parse, `text` is the raw JSON.
 */
function makeTypedClient(createMessageWithOutput: NonNullable<SeedLLMClient['createMessageWithOutput']>): SeedLLMClient {
  return { createMessage: vi.fn(), createMessageWithOutput };
}

describe('selectSeedsWithLLM', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Restore all mocks installed via vi.spyOn in beforeEach.
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns [] when client is undefined (no LLM available)', async () => {
    const result = await selectSeedsWithLLM('q', [makePageRef('a.md')], undefined, { model: 'gpt-4' });
    expect(result).toEqual([]);
  });

  it('returns [] when pageRefs is empty', async () => {
    const createMessage = vi.fn();
    const result = await selectSeedsWithLLM('q', [], makeClient(createMessage), { model: 'gpt-4' });
    expect(result).toEqual([]);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('returns parsed seeds on first success', async () => {
    const createMessage = vi.fn();
    createMessage.mockResolvedValueOnce('{"seeds":["a.md","b.md"]}');

    const result = await selectSeedsWithLLM('q', [makePageRef('a.md'), makePageRef('b.md'), makePageRef('c.md')], makeClient(createMessage), { model: 'gpt-4' });

    expect(result.sort()).toEqual(['a.md', 'b.md']);
    expect(createMessage).toHaveBeenCalledTimes(1);
  });

  it('drops LLM-hallucinated paths that are not in pageRefs', async () => {
    const createMessage = vi.fn();
    createMessage.mockResolvedValueOnce('{"seeds":["a.md","hallucinated.md"]}');

    const result = await selectSeedsWithLLM('q', [makePageRef('a.md'), makePageRef('b.md')], makeClient(createMessage), { model: 'gpt-4' });

    expect(result).toEqual(['a.md']);
  });

  it('retries on transient empty response and returns parsed seeds (1st empty, 2nd valid)', async () => {
    const createMessage = vi.fn();
    createMessage
      .mockResolvedValueOnce('') // 1st: transient empty
      .mockResolvedValueOnce('{"seeds":["a.md"]}'); // 2nd: valid

    const promise = selectSeedsWithLLM('q', [makePageRef('a.md')], makeClient(createMessage), { model: 'gpt-4', disableThinking: true });
    // Advance past first backoff (250ms).
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result).toEqual(['a.md']);
    expect(createMessage).toHaveBeenCalledTimes(2);
  });

  it('retries on malformed JSON and returns parsed seeds (1st malformed, 2nd valid)', async () => {
    const createMessage = vi.fn();
    createMessage
      .mockResolvedValueOnce('not json{')
      .mockResolvedValueOnce('{"seeds":["a.md"]}');

    const promise = selectSeedsWithLLM('q', [makePageRef('a.md')], makeClient(createMessage), { model: 'gpt-4' });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result).toEqual(['a.md']);
    expect(createMessage).toHaveBeenCalledTimes(2);
  });

  it('gives up after 3 empty attempts and returns [] (with lastError logged)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const createMessage = vi.fn();
    createMessage.mockResolvedValue('');

    const promise = selectSeedsWithLLM('q', [makePageRef('a.md')], makeClient(createMessage), { model: 'gpt-4' });
    // Advance past 2 backoffs: 250ms + 500ms (default jitter ≤ 100ms each).
    await vi.advanceTimersByTimeAsync(1500);
    const result = await promise;

    expect(result).toEqual([]);
    expect(createMessage).toHaveBeenCalledTimes(3);
    // Should have logged a giveup warning.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[LLM retry\].*giving up after 3 attempts/),
    );
  });

  it('gives up after 3 malformed JSON attempts and returns []', async () => {
    const createMessage = vi.fn();
    createMessage.mockResolvedValue('not json{');

    const promise = selectSeedsWithLLM('q', [makePageRef('a.md')], makeClient(createMessage), { model: 'gpt-4' });
    await vi.advanceTimersByTimeAsync(1500);
    const result = await promise;

    expect(result).toEqual([]);
    expect(createMessage).toHaveBeenCalledTimes(3);
  });

  it('does not retry on auth error (401) — surface immediately, return []', async () => {
    const authError = Object.assign(new Error('status 401'), { statusCode: 401 });
    const createMessage = vi.fn();
    createMessage.mockRejectedValue(authError);

    const result = await selectSeedsWithLLM('q', [makePageRef('a.md')], makeClient(createMessage), { model: 'gpt-4' });

    expect(result).toEqual([]);
    expect(createMessage).toHaveBeenCalledTimes(1);
  });

  it('preserves path validation after retry (1st parse fail, 2nd valid path)', async () => {
    const createMessage = vi.fn();
    createMessage
      .mockResolvedValueOnce('not json{') // 1st: parse fails → retry
      .mockResolvedValueOnce('{"seeds":["a.md"]}'); // 2nd: valid

    const promise = selectSeedsWithLLM('q', [makePageRef('a.md')], makeClient(createMessage), { model: 'gpt-4' });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result).toEqual(['a.md']);
    expect(createMessage).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry when parse succeeds but all paths are hallucinated (returns [] without retry)', async () => {
    // Legitimate "no relevant pages" case: LLM returns valid JSON with
    // an empty seeds array (or seeds that don't match any pageRef).
    // The selector must NOT treat this as transient.
    const createMessage = vi.fn();
    createMessage.mockResolvedValue('{"seeds":["hallucinated.md"]}');

    const result = await selectSeedsWithLLM('q', [makePageRef('a.md')], makeClient(createMessage), { model: 'gpt-4' });

    expect(result).toEqual([]);
    expect(createMessage).toHaveBeenCalledTimes(1);
  });

  it('caps pagesList at 50 entries to keep prompt bounded', async () => {
    const createMessage = vi.fn();
    createMessage.mockResolvedValue('{"seeds":[]}');
    const pageRefs = Array.from({ length: 100 }, (_, i) => makePageRef(`p${i}.md`));

    await selectSeedsWithLLM('q', pageRefs, makeClient(createMessage), { model: 'gpt-4' });

    const firstCall = createMessage.mock.calls[0];
    expect(firstCall).toBeDefined();
    const callArg = firstCall?.[0] as { messages: Array<{ content: string }> };
    const promptContent: string = callArg.messages[0].content;
    // The implementation caps at 50, so p49.md should appear but p50.md should not.
    expect(promptContent).toContain('p49.md');
    expect(promptContent).not.toContain('p50.md');
  });

  it('passes a system message to LLM (DeepSeek requires system for JSON mode)', async () => {
    // Bug B+ fix: seed-selector previously sent only a user message, which
    // caused DeepSeek to return empty body in JSON mode. The fix moves the
    // role/task/output-format instructions to a system field.
    const createMessage = vi.fn();
    createMessage.mockResolvedValue('{"seeds":["a.md"]}');

    await selectSeedsWithLLM('q', [makePageRef('a.md')], makeClient(createMessage), { model: 'gpt-4' });

    const firstCall = createMessage.mock.calls[0];
    expect(firstCall).toBeDefined();
    const callArg = firstCall?.[0] as {
      system?: string;
      messages: Array<{ role: string; content: string }>;
    };

    // System field must be a non-empty string describing the role.
    expect(typeof callArg.system).toBe('string');
    expect(callArg.system!.length).toBeGreaterThan(0);
    expect(callArg.system).toMatch(/selecting Wiki pages/i);
    expect(callArg.system).toMatch(/JSON/i);

    // User message should NOT contain the system-style role instructions.
    expect(callArg.messages).toHaveLength(1);
    expect(callArg.messages[0].role).toBe('user');
    expect(callArg.messages[0].content).not.toMatch(/You are selecting/);
    // User message should contain the user-facing content (question + pages list).
    expect(callArg.messages[0].content).toContain('q');
    expect(callArg.messages[0].content).toContain('a.md');
  });

  it('logs LLM response length + first 100 chars after each call', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const createMessage = vi.fn();
    createMessage.mockResolvedValue('{"seeds":["a.md"]}');

    await selectSeedsWithLLM('q', [makePageRef('a.md')], makeClient(createMessage), { model: 'gpt-4' });

    const joined = debug.mock.calls.map(c => String(c[0])).join('\n');
    // Should log response length and a non-empty first-100-chars preview.
    expect(joined).toMatch(/\[LLM response\].*Seed selection/);
    expect(joined).toMatch(/length=\d+/);
    expect(joined).toMatch(/first100=/);

    debug.mockRestore();
  });

  // ==========================================================================
  // v1.26.3 PATCH Phase B — typed-output path (createMessageWithOutput).
  //
  // When the client implements `createMessageWithOutput`, the selector
  // passes the Zod schema via `response_format.schema` (Tier 0 wire
  // shape) and prefers `result.output` over `parseJsonResponse(text)`.
  // When the client does NOT implement it (legacy mock / Anthropic /
  // OpenAI / Codex), the fallback path is identical to pre-Phase-B.
  // ==========================================================================
  describe('typed-output path (createMessageWithOutput)', () => {
    it('uses result.output when Tier 0 succeeds (schema on wire)', async () => {
      const createMessageWithOutput = vi.fn().mockResolvedValueOnce({
        text: '{"seeds":["a.md","b.md"]}',
        output: { seeds: ['a.md', 'b.md'] },
        outputMode: 'json_schema',
        finishReason: 'stop',
      });

      const result = await selectSeedsWithLLM(
        'q', [makePageRef('a.md'), makePageRef('b.md'), makePageRef('c.md')],
        makeTypedClient(createMessageWithOutput), { model: 'gpt-4' },
      );

      expect(result.sort()).toEqual(['a.md', 'b.md']);
      // Typed path: the client's createMessageWithOutput was called with
      // the Zod schema on response_format.schema.
      const callArg = createMessageWithOutput.mock.calls[0]?.[0] as {
        response_format?: { type: string; schema?: unknown };
      };
      expect(callArg.response_format?.schema).toBeDefined();
      // No fallback to parseJsonResponse happened (output was populated).
      expect(createMessageWithOutput).toHaveBeenCalledTimes(1);
    });

    it('falls back to parseJsonResponse(text) when Tier 1/2 succeed (output undefined)', async () => {
      // Simulates a Tier 1 (json_object) success: `output` is undefined
      // (no SDK parse), text is parseable JSON — the caller must parse it.
      const createMessageWithOutput = vi.fn().mockResolvedValueOnce({
        text: '{"seeds":["a.md"]}',
        output: undefined,
        outputMode: 'json_object',
        finishReason: 'stop',
      });

      const result = await selectSeedsWithLLM(
        'q', [makePageRef('a.md')],
        makeTypedClient(createMessageWithOutput), { model: 'gpt-4' },
      );

      expect(result).toEqual(['a.md']);
    });

    it('throws on shape mismatch (missing seeds array) — retryable', async () => {
      // Malformed output from a Tier 1/2 path: text parses but seeds is
      // not an array. The helper must throw so withTransientRetry can
      // retry (same contract as the legacy path).
      const createMessageWithOutput = vi.fn()
        .mockResolvedValueOnce({
          text: '{"seeds": "not-an-array"}',
          output: undefined,
          outputMode: 'json_object',
          finishReason: 'stop',
        })
        .mockResolvedValueOnce({
          text: '{"seeds":["a.md"]}',
          output: { seeds: ['a.md'] },
          outputMode: 'json_schema',
          finishReason: 'stop',
        });

      const promise = selectSeedsWithLLM(
        'q', [makePageRef('a.md')],
        makeTypedClient(createMessageWithOutput), { model: 'gpt-4' },
      );
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(result).toEqual(['a.md']);
      expect(createMessageWithOutput).toHaveBeenCalledTimes(2);
    });

    it('falls back to parseJsonResponse(text) when output is undefined and text needs repair', async () => {
      // Simulates the Path 2 fix contract: SDK parse failed on malformed
      // JSON, `output` is undefined, and `text` carries the raw model
      // output. The selector falls back to parseJsonResponse which
      // repairs a *parseable-with-greedy-regex* shape. (Deep repair —
      // unclosed arrays needing an LLM round-trip — is tested at the
      // SDK-client layer; here we pin the "output undefined → text
      // parsing" routing, not parseJsonResponse's repair heuristics.)
      const createMessageWithOutput = vi.fn().mockResolvedValueOnce({
        text: '{"seeds":["a.md"]}',
        output: undefined,
        outputMode: 'json_schema',
        finishReason: 'stop',
      });

      const result = await selectSeedsWithLLM(
        'q', [makePageRef('a.md')],
        makeTypedClient(createMessageWithOutput), { model: 'gpt-4' },
      );

      expect(result).toEqual(['a.md']);
    });
  });
});
