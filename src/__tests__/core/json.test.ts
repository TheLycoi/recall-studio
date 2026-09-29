import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseJsonResponse, parseJsonResult, isPlaceholderJsonText } from '../../core/json';
describe('parseJsonResponse', () => {
  it('parses valid JSON directly', async () => {
    const result = await parseJsonResponse('{"key": "value"}');
    expect(result).toEqual({ key: 'value' });
  });

  it('parses JSON wrapped in ```json code fence', async () => {
    const result = await parseJsonResponse('```json\n{"key": "value"}\n```');
    expect(result).toEqual({ key: 'value' });
  });

  it('parses JSON wrapped in ```markdown code fence', async () => {
    const result = await parseJsonResponse('```markdown\n{"key": "value"}\n```');
    expect(result).toEqual({ key: 'value' });
  });

  it('parses JSON wrapped in ``` without language tag', async () => {
    const result = await parseJsonResponse('```\n{"key": "value"}\n```');
    expect(result).toEqual({ key: 'value' });
  });

  it('handles double-brace prefill echo ({{)', async () => {
    const result = await parseJsonResponse('{{"key": "value"}');
    expect(result).toEqual({ key: 'value' });
  });

  it('handles newline-separated loose prefill ({)|n)', async () => {
    const result = await parseJsonResponse('{\n{"key": "value"}');
    expect(result).toEqual({ key: 'value' });
  });

  it('handles missing opening brace (prefill stripped)', async () => {
    const result = await parseJsonResponse('"key": "value"}');
    expect(result).toEqual({ key: 'value' });
  });

  it('extracts valid prefix from content with trailing text', async () => {
    const result = await parseJsonResponse('{"key": "value"} extra words here');
    expect(result).toEqual({ key: 'value' });
  });

  it('extracts braced JSON content from surrounding text', async () => {
    const result = await parseJsonResponse('Some preamble text {"key": "value"} and more after');
    expect(result).toEqual({ key: 'value' });
  });

  it('handles trailing comma in objects', async () => {
    const result = await parseJsonResponse('{"a": 1, "b": 2,}');
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('handles trailing comma in arrays', async () => {
    const result = await parseJsonResponse('{"items": [1, 2, 3,]}');
    expect(result).toEqual({ items: [1, 2, 3] });
  });

  // ROADMAP P3 #11: thinking models can output pseudocode JSON inside <think>
  // blocks. extractBalancedJson otherwise grabs the first '{' inside the think
  // block, ignoring the real JSON after </think>.
  it('strips <think> blocks before extracting JSON', async () => {
    const input = '<think>{ "pseudocode": "ignore me" }</think>\n{"real": "json"}';
    const result = await parseJsonResponse(input);
    expect(result).toEqual({ real: 'json' });
  });

  it('strips <thinking> blocks before extracting JSON', async () => {
    const input = '<thinking>{ "pseudocode": "ignore me" }</thinking>\n{"real": "json"}';
    const result = await parseJsonResponse(input);
    expect(result).toEqual({ real: 'json' });
  });

  it('strips multiline <think> blocks with embedded nested braces', async () => {
    const input = `<think>
Let me analyze this carefully.
{ "step": 1, "options": [{ "a": 1 }, { "b": 2 }] }
The answer should be...
</think>
{"answer": "real"}`;
    const result = await parseJsonResponse(input);
    expect(result).toEqual({ answer: 'real' });
  });

  it('returns null for completely invalid input', async () => {
    const result = await parseJsonResponse('not json at all');
    expect(result).toBeNull();
  });

  it('returns null for empty string', async () => {
    const result = await parseJsonResponse('');
    expect(result).toBeNull();
  });

  it('handles nested objects correctly', async () => {
    const result = await parseJsonResponse('{"outer": {"inner": [1, 2, 3]}}');
    expect(result).toEqual({ outer: { inner: [1, 2, 3] } });
  });

  it('uses repairFn callback for malformed but brace-balanced JSON', async () => {
    const repairFn = async (_malformed: string) => '{"repaired": true}';
    const result = await parseJsonResponse('{"a": invalid}', repairFn);
    expect(result).toEqual({ repaired: true });
  });

  it('falls back to null when repairFn returns invalid JSON', async () => {
    const repairFn = async (_malformed: string) => 'still not json';
    const result = await parseJsonResponse('{"a": invalid}', repairFn);
    expect(result).toBeNull();
  });

  it('handles repairFn returning JSON in code fence', async () => {
    const repairFn = async (_malformed: string) => '```json\n{"from_fence": true}\n```';
    const result = await parseJsonResponse('{"a": invalid}', repairFn);
    expect(result).toEqual({ from_fence: true });
  });

  it('parses empty object', async () => {
    const result = await parseJsonResponse('{}');
    expect(result).toEqual({});
  });
});

// isPlaceholderJsonText — the SDK-layer predicate (#443 follow-up). The
// openai-compat client's `createMessageWithOutput` NoObjectGeneratedError
// catch calls this to decide placeholder → text_prompt demotion WITHOUT
// re-running the full parse pipeline. User E2E 2026-08-13 (qwen3.5-9b on
// LM Studio) showed the grammar-constrained placeholder shape varies:
// `{"": ""}` (2026-08-11) and `{"": {}}` / `{"": []}` (2026-08-13). The
// predicate must flag every empty-key / empty-value variant so the SDK
// demote fires, not just the string-shaped one.
describe('isPlaceholderJsonText — empty-value variants (#443 follow-up)', () => {
  it.each([
    ['{"": ""}', 'string value, original shape'],
    ['{"": {}}', 'empty-object value, user E2E 2026-08-13'],
    ['{"": []}', 'empty-array value'],
    ['{"": null}', 'null value'],
  ])('flags %s (%s)', (json) => {
    expect(isPlaceholderJsonText(json)).toBe(true);
  });

  it('does NOT flag a real object with non-empty keys', () => {
    expect(isPlaceholderJsonText('{"name": "community-plugins", "type": "concept"}')).toBe(false);
    expect(isPlaceholderJsonText('{"summary": "real content"}')).toBe(false);
  });
});

// #407 Stage 0. Every test above this line is unchanged and still passes through
// `parseJsonResponse`, which is now a wrapper — that is the identity argument for
// the refactor. What follows pins the two halves the wrapper has to keep apart:
// the new function names the failure, and the old one still collapses all three
// names to `null` with the same operator output as before the split.
describe('parseJsonResult (#407 — the failure gets a name)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports a parsed object as ok', async () => {
    const result = await parseJsonResult('{"key": "value"}');
    expect(result).toEqual({ ok: true, value: { key: 'value' } });
  });

  it('names an empty body `empty`, not a parse failure', async () => {
    const result = await parseJsonResult('   \n  ');
    expect(result).toMatchObject({ ok: false, reason: 'empty', normalized: '' });
  });

  // A response that is nothing but a thinking block is empty for parsing
  // purposes — the reasoning model spent its budget before the JSON.
  it('names a thinking-block-only body `empty`', async () => {
    const result = await parseJsonResult('<think>almost there</think>');
    expect(result).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('names unparseable content `malformed` and carries the normalized text', async () => {
    const result = await parseJsonResult('not json at all');
    expect(result).toMatchObject({
      ok: false,
      reason: 'malformed',
      rawLength: 15,
      normalized: 'not json at all',
    });
  });

  // Synthetic input: no production response is known to reach the parser's own
  // catch, which is exactly why this reason exists. Before #407 the branch
  // logged and returned `null`, so its frequency was unmeasurable — a caller
  // could not tell a crashed parser from a model that answered badly.
  it('names an unexpected throw inside the parser `exception`', async () => {
    const hostile = {
      length: 5,
      trim: () => {
        throw new Error('boom');
      },
    } as unknown as string;

    const result = await parseJsonResult(hostile);
    expect(result).toMatchObject({ ok: false, reason: 'exception', rawLength: 5 });
    expect((result as { error?: unknown }).error).toBeInstanceOf(Error);
  });
});

describe('parseJsonResponse (#407 — the legacy wrapper stays byte-compatible)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('collapses all three failure reasons to null', async () => {
    const hostile = {
      length: 5,
      trim: () => {
        throw new Error('boom');
      },
    } as unknown as string;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await parseJsonResponse('')).toBeNull();
    expect(await parseJsonResponse('not json at all')).toBeNull();
    expect(await parseJsonResponse(hostile)).toBeNull();
  });

  it('keeps the 3-line operator signal on malformed content', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await parseJsonResponse('not json at all');

    expect(errors.mock.calls).toEqual([
      ['JSON parse completely failed (length %d)', 15],
      ['first 200 chars after normalization:', 'not json at all'],
      ['last 200 chars after normalization:', 'not json at all'],
    ]);
  });

  it('keeps the one-line empty-body error, and silences it under silentOnEmpty', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debugs = vi.spyOn(console, 'debug').mockImplementation(() => {});

    await parseJsonResponse('');
    expect(errors.mock.calls).toEqual([
      ['JSON parse completely failed (raw length %d) — empty response from LLM', 0],
    ]);

    errors.mockClear();
    debugs.mockClear();
    await parseJsonResponse('', undefined, { silentOnEmpty: true });
    expect(errors).not.toHaveBeenCalled();
    expect(debugs).toHaveBeenCalledWith(
      'parseJsonResponse: empty body (raw length %d) — silent path',
      0,
    );
  });

  it('still throws EmptyResponseError under throwOnEmpty, with the raw length', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(parseJsonResponse('  ', undefined, { throwOnEmpty: true })).rejects.toMatchObject({
      name: 'EmptyResponseError',
      rawLength: 2,
    });
  });

  // The reason must not leak into the noisy path: an exception is one line, not
  // the three that operators read as "the model sent garbage".
  it('logs an unexpected throw as an exception, not as malformed content', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hostile = {
      length: 5,
      trim: () => {
        throw new Error('boom');
      },
    } as unknown as string;

    await parseJsonResponse(hostile);

    expect(errors.mock.calls).toHaveLength(1);
    expect(errors.mock.calls[0][0]).toBe('parseJsonResponse exception:');
  });
});

