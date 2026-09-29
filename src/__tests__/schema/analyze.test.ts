// Tests for runSchemaAnalyze (ROADMAP v1.17.0 P1 #1).
//
// Background: Suggest Schema Updates was the only remaining "lint cancel path"
// not wired in v1.16.3. Both call sites (command palette + Lint Report
// Modal) bypassed startLintOperation/endLintOperation, so the status bar's
// "click to cancel" did nothing during schema analysis.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Notice } from 'obsidian';
import { runSchemaAnalyze, type SchemaAnalyzeCtx } from '../../schema/analyze';

const NoticeMock = Notice as unknown as {
  instances: Array<{ message: string }>;
};

type CtxOverrides = {
  schemaManagerResult?: unknown;
  schemaManagerError?: Error;
  llmClientPresent?: boolean;
  requireLLMReadyReturn?: boolean;
  initialAbortState?: boolean;
  /** v1.22.0 #97: lint analysis context to pass to suggestSchemaUpdate. */
  lintAnalysisContext?: string;
};

type CtxWithMocks = SchemaAnalyzeCtx & {
  wikiEngine: {
    startLintOperation: ReturnType<typeof vi.fn>;
    endLintOperation: ReturnType<typeof vi.fn>;
  };
  schemaManager: {
    suggestSchemaUpdate: ReturnType<typeof vi.fn>;
  };
};

const makeCtx = (overrides: CtxOverrides = {}): CtxWithMocks => {
  const start = vi.fn(() => ({ aborted: overrides.initialAbortState ?? false }));
  const end = vi.fn();
  const schemaManager = {
    suggestSchemaUpdate: vi.fn(async () => {
      if (overrides.schemaManagerError) throw overrides.schemaManagerError;
      return overrides.schemaManagerResult ?? null;
    }),
  };
  return {
    settings: { language: 'en' },
    requireLLMReady: vi.fn(() => overrides.requireLLMReadyReturn ?? true),
    llmClient: overrides.llmClientPresent === false ? null : { createMessage: vi.fn() },
    wikiEngine: { startLintOperation: start, endLintOperation: end },
    schemaManager,
    // v1.22.0 #97: optional lint analysis context for the prompt
    lintAnalysisContext: overrides.lintAnalysisContext,
  };
};

describe('runSchemaAnalyze — cancel wiring (ROADMAP v1.17.0 P1 #1)', () => {
  beforeEach(() => {
    NoticeMock.instances.length = 0;
  });

  it('calls startLintOperation and endLintOperation around the LLM call', async () => {
    const ctx = makeCtx({ schemaManagerResult: { changes_needed: false, suggestions: '' } });

    await runSchemaAnalyze(ctx);

    expect(ctx.wikiEngine.startLintOperation).toHaveBeenCalledTimes(1);
    expect(ctx.wikiEngine.endLintOperation).toHaveBeenCalledTimes(1);
    const startOrder = ctx.wikiEngine.startLintOperation.mock.invocationCallOrder[0];
    const endOrder = ctx.wikiEngine.endLintOperation.mock.invocationCallOrder[0];
    expect(startOrder).toBeLessThan(endOrder);
  });

  it('shows "schema suggestions generated" when result.changes_needed is true', async () => {
    const ctx = makeCtx({ schemaManagerResult: { changes_needed: true, suggestions: 'add Foo' } });

    await runSchemaAnalyze(ctx);

    const messages = NoticeMock.instances.map((n) => n.message);
    expect(messages).toContain('Analyzing Wiki and generating schema suggestions...');
    expect(messages).toContain('Schema suggestions generated, see wiki/schema/suggestions.md');
  });

  it('shows "no schema updates needed" when result.changes_needed is false', async () => {
    const ctx = makeCtx({ schemaManagerResult: { changes_needed: false, suggestions: '' } });

    await runSchemaAnalyze(ctx);

    const messages = NoticeMock.instances.map((n) => n.message);
    expect(messages).toContain('No schema updates needed.');
    expect(messages).not.toContain('Schema suggestions generated, see wiki/schema/suggestions.md');
  });

  it('suppresses result Notice when signal was aborted before LLM returned', async () => {
    const ctx = makeCtx({
      schemaManagerResult: { changes_needed: true, suggestions: 'should not be shown' },
      initialAbortState: true,
    });

    await runSchemaAnalyze(ctx);

    const messages = NoticeMock.instances.map((n) => n.message);
    expect(messages).not.toContain('Schema suggestions generated, see wiki/schema/suggestions.md');
    expect(messages).not.toContain('No schema updates needed.');
    expect(ctx.wikiEngine.endLintOperation).toHaveBeenCalledTimes(1);
  });

  it('suppresses error Notice on user-initiated cancel (signal.aborted)', async () => {
    const ctx = makeCtx({
      schemaManagerError: new Error('LLM request aborted'),
      initialAbortState: true,
    });

    await runSchemaAnalyze(ctx);

    const messages = NoticeMock.instances.map((n) => n.message);
    expect(messages).not.toContain('Schema suggestion failed: LLM request aborted');
    expect(ctx.wikiEngine.endLintOperation).toHaveBeenCalledTimes(1);
  });

  it('shows error Notice when LLM fails and signal was NOT aborted', async () => {
    const ctx = makeCtx({ schemaManagerError: new Error('Network timeout') });

    await runSchemaAnalyze(ctx);

    const messages = NoticeMock.instances.map((n) => n.message);
    expect(messages).toContain('Schema suggestion failed: Network timeout');
    expect(ctx.wikiEngine.endLintOperation).toHaveBeenCalledTimes(1);
  });

  it('returns early (no startLintOperation) when requireLLMReady fails', async () => {
    const ctx = makeCtx({ requireLLMReadyReturn: false });

    await runSchemaAnalyze(ctx);

    expect(ctx.wikiEngine.startLintOperation).toHaveBeenCalledTimes(0);
    expect(ctx.wikiEngine.endLintOperation).toHaveBeenCalledTimes(0);
  });

  it('shows errorNoApiKey Notice and returns early when llmClient is null', async () => {
    const ctx = makeCtx({ llmClientPresent: false });

    await runSchemaAnalyze(ctx);

    const messages = NoticeMock.instances.map((n) => n.message);
    expect(messages).toContain('Please configure API Key first');
    expect(ctx.wikiEngine.startLintOperation).toHaveBeenCalledTimes(0);
  });

  it('always calls endLintOperation in finally even when schemaManager throws', async () => {
    const ctx = makeCtx({ schemaManagerError: new Error('boom') });

    await runSchemaAnalyze(ctx);

    expect(ctx.wikiEngine.endLintOperation).toHaveBeenCalledTimes(1);
  });

  // v1.22.0 #97: lintAnalysisContext is forwarded to suggestSchemaUpdate
  // so the LLM receives real lint analysis data (orphan counts, dead
  // links, etc.) instead of the hardcoded string 'Wiki lint analysis'.
  it('forwards lintAnalysisContext to suggestSchemaUpdate as the context string', async () => {
    const ctx = makeCtx({
      schemaManagerResult: { changes_needed: false, suggestions: '' },
      lintAnalysisContext: 'Lint report: 3 orphan pages, 5 dead links, 2 contradictions found.',
    });

    await runSchemaAnalyze(ctx);

    expect(ctx.schemaManager.suggestSchemaUpdate).toHaveBeenCalledTimes(1);
    expect(ctx.schemaManager.suggestSchemaUpdate).toHaveBeenCalledWith(
      'Lint report: 3 orphan pages, 5 dead links, 2 contradictions found.'
    );
  });

  it('falls back to "Wiki lint analysis" when lintAnalysisContext is undefined', async () => {
    const ctx = makeCtx({
      schemaManagerResult: { changes_needed: false, suggestions: '' },
      // lintAnalysisContext intentionally omitted
    });

    await runSchemaAnalyze(ctx);

    expect(ctx.schemaManager.suggestSchemaUpdate).toHaveBeenCalledWith('Wiki lint analysis');
  });
});

// v1.22.0 #97: when the LLM decides no schema changes are needed, we
// still want the user to see *why* — popping a Modal with the LLM's
// rationale + Regenerate/Cancel buttons. The legacy behavior of just
// flashing a Notice and forgetting about it left the user wondering
// "what did the LLM think? was it useful?". Now they can read the
// suggestion text in-context and either Regenerate (re-prompt) or
// Cancel (close).
describe('runSchemaAnalyze — no-changes path opens diff Modal (#97)', () => {
  beforeEach(() => {
    NoticeMock.instances.length = 0;
  });

  it('invokes openSchemaDiffModal when changes_needed is false', async () => {
    // Simulate the LLM returning a no-op decision. The Modal should
    // still open so the user can read the LLM's rationale.
    const openSchemaDiffModal = vi.fn(async () => {});
    const ctx: CtxWithMocks = Object.assign(makeCtx({
      schemaManagerResult: { changes_needed: false, suggestions: 'Schema is fine as-is.' },
    }), { openSchemaDiffModal });

    await runSchemaAnalyze(ctx);

    expect(openSchemaDiffModal).toHaveBeenCalledTimes(1);
    expect(openSchemaDiffModal).toHaveBeenCalledWith(
      expect.objectContaining({ changes_needed: false, suggestions: 'Schema is fine as-is.' })
    );
  });

  it('does NOT flash the "no updates needed" Notice when Modal opens for no-changes', async () => {
    // The Modal replaces the Notice. The user is in the Modal now;
    // a redundant Notice would be noise.
    const openSchemaDiffModal = vi.fn(async () => {});
    const ctx: CtxWithMocks = Object.assign(makeCtx({
      schemaManagerResult: { changes_needed: false, suggestions: 'Schema is fine.' },
    }), { openSchemaDiffModal });

    await runSchemaAnalyze(ctx);

    const messages = NoticeMock.instances.map((n) => n.message);
    expect(messages).not.toContain('No schema updates needed.');
  });

  it('invokes openSchemaDiffModal when changes_needed is true and new_schema_body is present', async () => {
    // Sanity: the original changes_needed=true path still opens the Modal.
    const openSchemaDiffModal = vi.fn(async () => {});
    const ctx: CtxWithMocks = Object.assign(makeCtx({
      schemaManagerResult: { changes_needed: true, newSchemaBody: 'new body', suggestions: 'x' },
    }), { openSchemaDiffModal });

    await runSchemaAnalyze(ctx);

    expect(openSchemaDiffModal).toHaveBeenCalledTimes(1);
  });

  it('falls back to Notice when openSchemaDiffModal is not provided (legacy callers)', async () => {
    // Backward-compat: callers that don't pass openSchemaDiffModal
    // (e.g. a future test or a downstream script) get the legacy
    // Notice-based flow.
    const ctx = makeCtx({ schemaManagerResult: { changes_needed: false, suggestions: 'fine' } });
    // Explicitly do NOT add openSchemaDiffModal.

    await runSchemaAnalyze(ctx);

    const messages = NoticeMock.instances.map((n) => n.message);
    expect(messages).toContain('No schema updates needed.');
  });
});
