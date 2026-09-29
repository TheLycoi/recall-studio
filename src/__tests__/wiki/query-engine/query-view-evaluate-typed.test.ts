// QueryView-class evaluateWithLLM typed-output path tests (v1.26.3 PATCH Phase B).
//
// evaluateWithLLM is a private method triggered after a query turn — it asks
// the LLM whether the conversation is worth saving to the wiki ("Suggest Save").
// It is a SEPARATE call from the Query streaming answer path (createMessageStream,
// free text, no response_format) — this migration only touches the JSON
// evaluate call, never the streaming answer.
//
// We construct a minimal QueryView via Object.create (avoids the Obsidian
// ItemView constructor) and call the private method through a cast. The
// SuggestSaveModal class is mocked so `valuable=true` opens a spy instead of
// a real modal.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryView } from '../../../wiki/query-engine/QueryView-class';
import { SuggestSaveModal } from '../../../wiki/query-engine/SuggestSaveModal-class';

// Mock SuggestSaveModal so `new` + `.open()` are observable without a real Modal.
vi.mock('../../../wiki/query-engine/SuggestSaveModal-class', () => ({
  SuggestSaveModal: vi.fn().mockImplementation(function MockSuggestSaveModal(
    _app: unknown,
    _plugin: unknown,
    _history: unknown,
    _reason?: string,
  ) {
    return { open: vi.fn() };
  }),
}));

const MockSuggestSaveModal = vi.mocked(SuggestSaveModal);

/** Create a minimal QueryView instance that only implements the fields
 *  evaluateWithLLM touches. Avoids the Obsidian ItemView constructor.
 *  The plugin object is intentionally loosely typed — evaluateWithLLM
 *  only reads llmClient / settings / wikiEngine.formatConversation and
 *  calls saveSettings. */
function makeView(client: unknown): {
  plugin: {
    llmClient: unknown;
    settings: Record<string, unknown>;
    saveSettings: ReturnType<typeof vi.fn>;
  };
  evaluateWithLLM: () => Promise<void>;
} {
  const plugin = {
    llmClient: client,
    settings: {
      model: 'test-model',
      queryModel: undefined,
      disableThinking: false,
      lastOfferedQueryHash: undefined,
    },
    saveSettings: vi.fn(async () => {}),
    wikiEngine: {
      formatConversation: vi.fn(() => JSON.stringify({ messages: [] })),
    },
  };
  const view = Object.create(QueryView.prototype) as unknown as {
    plugin: typeof plugin;
    app: unknown;
    history: { messages: Array<{ role: 'user' | 'assistant'; content: string }> };
    evaluateWithLLM: () => Promise<void>;
  };
  view.plugin = plugin;
  view.app = {};
  view.history = { messages: [] };
  return view;
}

const typedResult = (output: unknown, text = JSON.stringify(output)) => ({
  text,
  output,
  outputMode: 'json_schema',
  finishReason: 'stop',
});

describe('QueryView evaluateWithLLM — typed-output path (createMessageWithOutput)', () => {
  beforeEach(() => {
    MockSuggestSaveModal.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens SuggestSaveModal when Tier 0 succeeds and valuable=true (schema on wire)', async () => {
    const createMessageWithOutput = vi.fn(async (_p: Record<string, unknown>) => typedResult({ valuable: true, reason: 'has Q&A' }));
    const client = {
      createMessage: vi.fn(),
      createMessageWithOutput,
    };
    const view = makeView(client);
    const saveSettingsSpy = view.plugin.saveSettings;

    await view.evaluateWithLLM();

    expect(saveSettingsSpy).toHaveBeenCalled();
    expect(MockSuggestSaveModal).toHaveBeenCalledTimes(1);
    // Zod schema must travel on the wire.
    const firstCall = createMessageWithOutput.mock.calls[0]?.[0] as { response_format?: { schema?: unknown } } | undefined;
    expect(firstCall?.response_format?.schema).toBeDefined();
  });

  it('does NOT open the modal when valuable=false (Tier 0 success)', async () => {
    const createMessageWithOutput = vi.fn(async () => typedResult({ valuable: false, reason: 'nothing new' }));
    const client = { createMessage: vi.fn(), createMessageWithOutput };
    const view = makeView(client);

    await view.evaluateWithLLM();

    expect(MockSuggestSaveModal).not.toHaveBeenCalled();
    expect(view.plugin.saveSettings).not.toHaveBeenCalled();
  });

  it('falls back to parseJsonResponse(text) when Tier 1/2 succeed (output undefined)', async () => {
    const createMessageWithOutput = vi.fn(async () => ({
      text: JSON.stringify({ valuable: true, reason: 'fallback' }),
      output: undefined,
      outputMode: 'json_object',
      finishReason: 'stop',
    }));
    const client = { createMessage: vi.fn(), createMessageWithOutput };
    const view = makeView(client);

    await view.evaluateWithLLM();

    expect(view.plugin.saveSettings).toHaveBeenCalled();
    expect(MockSuggestSaveModal).toHaveBeenCalledTimes(1);
  });

  it('uses the legacy createMessage path when the client lacks createMessageWithOutput', async () => {
    const createMessage = vi.fn(async () => JSON.stringify({ valuable: true, reason: 'legacy' }));
    const client = { createMessage };
    const view = makeView(client);

    await view.evaluateWithLLM();

    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(view.plugin.saveSettings).toHaveBeenCalled();
  });

  it('does not throw when the LLM call fails (best-effort — skip suggestion)', async () => {
    const createMessageWithOutput = vi.fn(async () => { throw new Error('boom'); });
    const client = { createMessage: vi.fn(), createMessageWithOutput };
    const view = makeView(client);

    await expect(view.evaluateWithLLM()).resolves.toBeUndefined();
  });
});
