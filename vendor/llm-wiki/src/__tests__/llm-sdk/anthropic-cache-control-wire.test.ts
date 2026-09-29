/**
 * Issue #493 / Issue #449 follow-up — wire-level assertions.
 *
 * Every other test for `cacheBreakpoint` runs against a mocked `generateText`
 * and therefore asserts the shape we hand the SDK, not the shape the SDK puts
 * on the wire. Those two came apart once already: a `cache_control` marker sat
 * on a part that the SDK core drops, and a part-level assertion could not see
 * it. This file deliberately does NOT mock `ai` — it drives the real
 * `@ai-sdk/anthropic` adapter through a stub `fetch` and reads the request body
 * that would have gone to the API.
 */
import { describe, it, expect } from 'vitest';
import { AnthropicSdkClient } from '../../llm-sdk/anthropic-sdk-client';

/** Minimal well-formed Anthropic non-streaming response. */
function anthropicOk(): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** Runs one createMessage against a stub fetch and returns the parsed body. */
async function captureWireBody(cacheBreakpoint: number | undefined, text: string) {
  let captured: Record<string, unknown> | undefined;
  const stubFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body));
    return anthropicOk();
  }) as unknown as typeof fetch;

  const client = new AnthropicSdkClient({ apiKey: 'test-key', fetch: stubFetch as never });
  await client.createMessage({
    model: 'claude-sonnet-4-5',
    max_tokens: 16,
    messages: [{ role: 'user', content: text }],
    ...(cacheBreakpoint === undefined ? {} : { cacheBreakpoint }),
  } as never);

  if (!captured) throw new Error('stub fetch was never called');
  return captured as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
}

const PREFIX = 'STATIC PREFIX — the part that is identical for every note. ';
const SUFFIX = 'VARYING NOTE BODY';

describe('Issue #449/#493: cache_control on the wire, not just on the part we hand the SDK', () => {
  it('puts cache_control on the first of two user text blocks for a non-zero offset', async () => {
    const body = await captureWireBody(PREFIX.length, PREFIX + SUFFIX);
    const blocks = body.messages[0].content;

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'text', text: PREFIX, cache_control: { type: 'ephemeral' } });
    expect(blocks[1]).toMatchObject({ type: 'text', text: SUFFIX });
    expect(blocks[1].cache_control).toBeUndefined();
  });

  it('ships no cache_control at all when the offset is 0 — the marker cannot survive an empty prefix', async () => {
    const body = await captureWireBody(0, PREFIX + SUFFIX);
    const serialized = JSON.stringify(body);

    // The documented reason for the guard in buildMessagesWithCacheControl:
    // an empty prefix part carries the marker into a block the SDK core drops,
    // so the whole body ships uncached with nothing to signal it. The guard
    // makes the code stop constructing that part; the wire outcome (no marker)
    // is the same either way, which is exactly why a part-level test is blind
    // here and this assertion is worth having.
    expect(serialized).not.toContain('cache_control');
    expect(body.messages[0].content).toHaveLength(1);
    expect(body.messages[0].content[0]).toMatchObject({ type: 'text', text: PREFIX + SUFFIX });
  });

  it('leaves the message as a single block when no cacheBreakpoint is given', async () => {
    const body = await captureWireBody(undefined, PREFIX + SUFFIX);

    expect(JSON.stringify(body)).not.toContain('cache_control');
    expect(body.messages[0].content).toHaveLength(1);
  });

  it('measures the offset in UTF-16 code units, not bytes', async () => {
    const nonAscii = 'Ü'.repeat(42); // 42 code units, 84 UTF-8 bytes
    const body = await captureWireBody(nonAscii.length, nonAscii + SUFFIX);
    const blocks = body.messages[0].content;

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ text: nonAscii, cache_control: { type: 'ephemeral' } });
    expect(blocks[1]).toMatchObject({ text: SUFFIX });
  });
});
