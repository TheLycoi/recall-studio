// typed-output migration tests for schema-manager (Commit 7).
//
// SchemaManager.suggestSchemaUpdate is the only LLM call site in
// src/schema/. The migration: prefer createMessageWithOutput when the client
// supports it; falls back to createMessage on legacy clients. The schema on
// the wire is SchemaSuggestionLLMSchema ({changes_needed?, new_schema_body?,
// suggestions?}). parseSchemaSuggestion (synchronous) still strips frontmatter
// + extracts body post-parse, so the caller-side logic is unchanged.

import { describe, it, expect, vi } from 'vitest';
import { SchemaManager } from '../../schema/schema-manager';
import { SchemaSuggestionLLMSchema } from '../../llm-sdk/output-schemas';

function makeSchemaManager(client: unknown): SchemaManager {
  // SchemaManager constructor: (app, settings, getLLMClient). The client is
  // resolved lazily via the getLLMClient callback, so we capture our test
  // client in closure. The app mock must support vault.getAbstractFileByPath
  // (used by loadSchema) + vault.read + vault.adapter for the schema path.
  const schemaContent = '# Schema\n\n## Entity Page Template\n\nBody';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => (path.includes('schema/config') ? { path } : null),
      read: async () => schemaContent,
      adapter: { read: async () => schemaContent, readToString: async () => schemaContent },
      getMarkdownFiles: () => [],
    },
  } as never;
  const settings = {
    provider: 'mock',
    model: 'mock-model',
    language: 'en',
    wikiLanguage: 'English',
    wikiFolder: 'wiki',
    disableThinking: false,
    maxTokensPerCall: 0,
    extractionTemperature: undefined,
  } as unknown as import('../../types').LLMWikiSettings;
  return new SchemaManager(app, settings, () => client as never);
}

const validSuggestionJson = JSON.stringify({
  changes_needed: true,
  new_schema_body: '---\n---\n\n# New Schema\n',
  suggestions: 'Add tag',
});

describe('SchemaManager.suggestSchemaUpdate — typed-output migration (#443 expanded scope)', () => {
  it('passes SchemaSuggestionLLMSchema on the wire via response_format.schema (legacy client)', async () => {
    const createMessage = vi.fn(async () => validSuggestionJson);
    const client = { createMessage };
    const mgr = makeSchemaManager(client);

    try {
      await mgr.suggestSchemaUpdate('analysis-context');
    } catch (e) {
      // Surface the error to the test console so the cause is visible.
      // eslint-disable-next-line no-console
      console.error('suggestSchemaUpdate threw:', e);
    }

    expect(createMessage).toHaveBeenCalled();
    const calls = createMessage.mock.calls as unknown as Array<[unknown]>;
    const args = calls[0]?.[0] as { response_format?: { schema?: unknown } };
    expect(args.response_format?.schema).toBe(SchemaSuggestionLLMSchema);
  });

  it('uses createMessageWithOutput when the client implements it (Tier 0 path)', async () => {
    const createMessageWithOutput = vi.fn(async () => ({
      text: validSuggestionJson,
      output: { changes_needed: true, new_schema_body: '---\n---\n\n# New Schema\n', suggestions: 'Add tag' },
      outputMode: 'json_schema',
      finishReason: 'stop',
    }));
    const createMessage = vi.fn();
    const client = { createMessage, createMessageWithOutput };
    const mgr = makeSchemaManager(client);

    try {
      await mgr.suggestSchemaUpdate('analysis-context');
    } catch {
      // ignore downstream stub failures
    }

    expect(createMessageWithOutput).toHaveBeenCalled();
    expect(createMessage).not.toHaveBeenCalled();
    const calls = createMessageWithOutput.mock.calls as unknown as Array<[unknown]>;
    const args = calls[0]?.[0] as { response_format?: { schema?: unknown } };
    expect(args.response_format?.schema).toBe(SchemaSuggestionLLMSchema);
  });

  it('falls back to createMessage when the client lacks createMessageWithOutput', async () => {
    const createMessage = vi.fn(async () => validSuggestionJson);
    const client = { createMessage };
    // Confirm the legacy client shape (no createMessageWithOutput)
    expect((client as unknown as { createMessageWithOutput?: unknown }).createMessageWithOutput).toBeUndefined();
    const mgr = makeSchemaManager(client);

    try {
      await mgr.suggestSchemaUpdate('analysis-context');
    } catch {
      // ignore downstream stub failures
    }

    expect(createMessage).toHaveBeenCalled();
  });
});