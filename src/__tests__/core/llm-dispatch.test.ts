// core/llm-dispatch tests
//
// Covers the central typed-output / legacy dispatch guard added by the
// v1.26.3 PATCH expanded-scope follow-up (simplify #1).

import { describe, it, expect, vi } from 'vitest';
import { callLlm } from '../../core/llm-dispatch';

describe('callLlm — typed-output / legacy dispatch', () => {
  it('uses createMessageWithOutput when the client implements it', async () => {
    const createMessageWithOutput = vi.fn().mockResolvedValue({
      text: '{"ok":true}',
      output: { ok: true },
      outputMode: 'json_schema',
      finishReason: 'stop',
    });
    const createMessage = vi.fn();
    const result = await callLlm(
      { createMessage, createMessageWithOutput } as never,
      { model: 'm', messages: [] } as never,
    );
    expect(createMessageWithOutput).toHaveBeenCalledTimes(1);
    expect(createMessage).not.toHaveBeenCalled();
    expect(result).toBe('{"ok":true}');
  });

  it('falls back to createMessage when createMessageWithOutput is missing', async () => {
    const createMessage = vi.fn().mockResolvedValue('{"ok":true}');
    const result = await callLlm(
      { createMessage } as never,
      { model: 'm', messages: [] } as never,
    );
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(result).toBe('{"ok":true}');
  });

  it('forwards args verbatim to whichever method is selected', async () => {
    const createMessageWithOutput = vi.fn().mockResolvedValue({
      text: 'x',
      outputMode: 'text_prompt',
      finishReason: 'stop',
    });
    const args = {
      model: 'm',
      max_tokens: 100,
      messages: [{ role: 'user' as const, content: 'hi' }],
      response_format: { type: 'json_object' as const, schema: { parse: vi.fn() } as never },
      task: 'extract' as const,
    };
    await callLlm(
      { createMessage: vi.fn(), createMessageWithOutput } as never,
      args as never,
    );
    expect(createMessageWithOutput).toHaveBeenCalledWith(args);
  });
});