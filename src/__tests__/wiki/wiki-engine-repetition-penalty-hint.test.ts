// wiki-engine-repetition-penalty-hint.test.ts
//
// v1.26.3 PATCH (user E2E 2026-08-13): when source analysis fails and the
// user opted into a custom repetitionPenalty, the "Source analysis failed"
// throw appends a localized hint naming the likely cause. These tests pin the
// WIRING at the throw site — buildRepetitionPenaltyHint is unit-tested in
// repetition-penalty-hint.test.ts, but nothing exercised the wiki-engine path
// until now. A future refactor that reads the wrong settings field or drops
// the argument must fail here, not silently.

import { describe, it, expect } from 'vitest';
import { TFile } from 'obsidian'; // mocked in setup.ts
import { createWikiEngineHarness } from '../__support__/wiki-engine-harness';

// Build a TFile-shaped source file object. The engine reads path/basename/extension.
function sourceFile(path = 'sources/fail.md'): TFile {
  const name = path.split('/').pop() || path;
  const dot = name.lastIndexOf('.');
  return Object.assign(new TFile(), {
    path,
    basename: dot > 0 ? name.slice(0, dot) : name,
    extension: dot > 0 ? name.slice(dot + 1) : 'md',
  });
}

// The grammar-constrained placeholder (`{"": ""}`) makes the source-analyzer
// return null: first batch retries once without halving (placeholderRetried),
// the second pass fails again, and isFirstBatch returns null (source-analyzer
// :536-543). Enough copies so any additional LLM call also fails.
const PLACEHOLDER_RESPONSES = ['{"": ""}', '{"": ""}', '{"": ""}', '{"": ""}'];

describe('WikiEngine.ingestSource — repetitionPenalty hint on failure (v1.26.3)', () => {
  it('appends the localized hint when a wire-supporting provider has a custom repetitionPenalty', async () => {
    const h = createWikiEngineHarness({
      files: { 'sources/fail.md': 'real source content' },
      llmResponses: PLACEHOLDER_RESPONSES,
      settings: { repetitionPenalty: 1.5, provider: 'lmstudio', language: 'en' },
    });

    await expect(h.engine.ingestSource(sourceFile('sources/fail.md'))).rejects.toThrow(
      /Repetition penalty of 1\.5/,
    );
  });

  it('omits the hint when repetitionPenalty is unset', async () => {
    const h = createWikiEngineHarness({
      files: { 'sources/fail.md': 'real source content' },
      llmResponses: PLACEHOLDER_RESPONSES,
      settings: { provider: 'lmstudio', language: 'en' },
    });

    const err = await h.engine.ingestSource(sourceFile('sources/fail.md')).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('Source analysis failed');
    expect(message).not.toContain('Repetition penalty');
  });

  it('omits the hint when the provider drops the field (never reached the wire)', async () => {
    // DocTpoint review 2026-08-13 (blocking): deepseek drops repetitionPenalty
    // by design, so hinting "reduce or clear" would misattribute the failure.
    const h = createWikiEngineHarness({
      files: { 'sources/fail.md': 'real source content' },
      llmResponses: PLACEHOLDER_RESPONSES,
      settings: { repetitionPenalty: 1.5, provider: 'deepseek', language: 'en' },
    });

    const err = await h.engine.ingestSource(sourceFile('sources/fail.md')).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('Repetition penalty');
  });
});
