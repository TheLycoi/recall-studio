// patch 16 wiring — the pure decision is covered in core/source-lemma.test.ts.
// What is covered here is that `analyzeSource` actually calls it and that the
// added candidate reaches the returned analysis.
//
// This exists because the field smoke test cannot show it: when the extraction
// happens to produce the lemma on its own, "skipped correctly" and "never
// called" leave an identical vault. The code path has to be read, not the diff.

import { describe, it, expect, vi } from 'vitest';
import { createMockContext, createMockFile } from '../__support__/engine-context';
import { SourceAnalyzer } from '../../wiki/source-analyzer';
import { TFile } from 'obsidian';

const NOTE = 'sources/Klotho.md';
const BODY = `---
aliases:
  - alpha-Klotho-Protein
---
Klotho ist ein Transmembranprotein und Ko-Rezeptor für FGF23. Ein Verlust
führt zu vorzeitigem Altern, gestörtem Phosphathaushalt und Gefäßverkalkung.
`;

/** Extraction that misses the note's own lemma — the observed b1 case. */
const EXTRACTION_WITHOUT_LEMMA = JSON.stringify({
  source_title: 'Klotho',
  summary: 'Die Notiz beschreibt Klotho als Regulator des Alterungsprozesses.',
  entities: [
    { name: 'alpha-Klotho', type: 'other', summary: 'Isoform.', mentions_in_source: ['a'] },
    { name: 'FGF23', type: 'other', summary: 'Hormon.', mentions_in_source: ['b'] },
  ],
  concepts: [],
});

/** Same, but the lemma is extracted on its own — the S45 Papain case. */
const EXTRACTION_WITH_LEMMA = JSON.stringify({
  source_title: 'Klotho',
  summary: 'Die Notiz beschreibt Klotho als Regulator des Alterungsprozesses.',
  entities: [
    { name: 'Klotho', type: 'other', summary: 'Protein.', mentions_in_source: ['a'] },
  ],
  concepts: [],
});

const EMPTY_BATCH = JSON.stringify({ entities: [], concepts: [] });
const TYPE_ENTITY = JSON.stringify({ kind: 'entity' });

function analyzerWith(responses: string[], settings?: Partial<Record<string, unknown>>) {
  const { ctx } = createMockContext({
    vaultFiles: { [NOTE]: BODY },
    llmResponses: responses,
    ...(settings ? { settings } : {}),
  } as Parameters<typeof createMockContext>[0]);
  return new SourceAnalyzer(ctx);
}

async function run(analyzer: SourceAnalyzer) {
  // eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast
  return analyzer.analyzeSource(createMockFile(NOTE) as unknown as TFile);
}

describe('SourceAnalyzer — patch 16 lemma guarantee wiring', () => {
  it('adds the note\'s own lemma when the extraction missed it', async () => {
    const result = await run(analyzerWith([
      EXTRACTION_WITHOUT_LEMMA, EMPTY_BATCH, TYPE_ENTITY,
    ]));
    const names = (result?.entities ?? []).map(e => e.name);
    expect(names).toContain('Klotho');
  });

  it('names the added lemma after the file, and gives it the source summary', async () => {
    const result = await run(analyzerWith([
      EXTRACTION_WITHOUT_LEMMA, EMPTY_BATCH, TYPE_ENTITY,
    ]));
    const added = (result?.entities ?? []).find(e => e.name === 'Klotho');
    expect(added?.summary).toBe(result?.summary);
    // No mentions are invented for a candidate the extraction never saw.
    expect(added?.mentions_in_source).toEqual([]);
  });

  it('adds nothing when the extraction already produced the lemma', async () => {
    const result = await run(analyzerWith([EXTRACTION_WITH_LEMMA, EMPTY_BATCH]));
    const klotho = (result?.entities ?? []).filter(e => e.name === 'Klotho');
    expect(klotho).toHaveLength(1);
  });

  it('adds nothing when the type classification is unusable', async () => {
    const result = await run(analyzerWith([
      EXTRACTION_WITHOUT_LEMMA, EMPTY_BATCH, JSON.stringify({ kind: 'werkzeug' }),
    ]));
    const names = (result?.entities ?? []).map(e => e.name);
    expect(names).not.toContain('Klotho');
    expect(result?.concepts.map(c => c.name)).not.toContain('Klotho');
  });

  it('routes a concept answer into the concepts list', async () => {
    const result = await run(analyzerWith([
      EXTRACTION_WITHOUT_LEMMA, EMPTY_BATCH, JSON.stringify({ kind: 'concept' }),
    ]));
    expect((result?.concepts ?? []).map(c => c.name)).toContain('Klotho');
    expect((result?.entities ?? []).map(e => e.name)).not.toContain('Klotho');
  });

  it('respects the custom granularity cap so the added lemma does not exceed it', async () => {
    // P0 #3 regression: extraction-phase cap slice at :602-607 only trims
    // the LLM-extracted lists. The push in ensureSourceLemma used to bypass
    // it, so a user who set customEntityLimit: 1 (with extractionGranularity
    // 'custom') would get 2 entities. This test pins the post-fix behaviour:
    // when the entities list is already at the cap, the lemma push is skipped.
    const result = await run(analyzerWith(
      [EXTRACTION_WITHOUT_LEMMA, EMPTY_BATCH, TYPE_ENTITY],
      { extractionGranularity: 'custom', customEntityLimit: 2 },
    ));
    // EXTRACTION_WITHOUT_LEMMA already produces 2 entities (alpha-Klotho,
    // FGF23); the cap of 2 is hit, so the pushed Klotho is skipped.
    expect((result?.entities ?? []).map(e => e.name)).not.toContain('Klotho');
    expect((result?.entities ?? []).length).toBe(2);
  });

  // domain axis stage 3 (#568): extracted items get their `domains` subset
  // from the model, but the lemma candidate is added after extraction and
  // never passes through that prompt — without a proposal of its own, the
  // note's own page is the one page class born domainless (field finding:
  // entities/Atemmasken). The note's tags describe the note's subject, which
  // is exactly what the lemma page is.
  it('gives the added lemma the source note\'s tags as its domain proposal', async () => {
    const tagged = BODY.replace('aliases:', 'tags:\n  - Thema/Alternsforschung\n  - Sorte/Protein\naliases:');
    const { ctx } = createMockContext({
      vaultFiles: { [NOTE]: tagged },
      llmResponses: [EXTRACTION_WITHOUT_LEMMA, EMPTY_BATCH, TYPE_ENTITY],
    } as Parameters<typeof createMockContext>[0]);
    const result = await new SourceAnalyzer(ctx).analyzeSource(
      // eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast
      createMockFile(NOTE) as unknown as TFile,
    );
    const added = (result?.entities ?? []).find(e => e.name === 'Klotho');
    expect(added?.domains).toEqual(['Thema/Alternsforschung', 'Sorte/Protein']);
  });

  it('adds no domains field when the source note carries no tags', async () => {
    const result = await run(analyzerWith([
      EXTRACTION_WITHOUT_LEMMA, EMPTY_BATCH, TYPE_ENTITY,
    ]));
    const added = (result?.entities ?? []).find(e => e.name === 'Klotho');
    expect(added).toBeDefined();
    expect(added?.domains).toBeUndefined();
  });
});

// === typed-output migration (v1.26.3 PATCH Issue #443 expanded scope) ===
// Commit 3 — lemma-classify uses createMessageWithOutput when the client
// supports it; falls back to createMessage on legacy clients.
describe('SourceAnalyzer.classifyLemmaType — typed-output migration', () => {
  it('passes LemmaClassifyLLMSchema on the wire via response_format.schema (legacy client)', async () => {
    const { ctx } = createMockContext({
      vaultFiles: { [NOTE]: BODY },
      // extraction + lemma-classify both return valid JSON
      llmResponses: [
        EXTRACTION_WITHOUT_LEMMA,
        '{"kind": "entity"}',
      ],
    });
    const client = ctx.getClient()!;
    const spy = vi.spyOn(client, 'createMessage');
    const analyzer = new SourceAnalyzer(ctx);
    // eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast
    await analyzer.analyzeSource(createMockFile(NOTE) as unknown as TFile);
    expect(spy).toHaveBeenCalled();
    // The lemma-classify call must carry the schema
    const lemmaCall = spy.mock.calls.find(
      (c) => (c[0] as { task?: string }).task === 'lemma-classify'
    );
    expect(lemmaCall).toBeDefined();
    const args = lemmaCall![0] as { response_format?: { schema?: unknown } };
    expect(args.response_format?.schema).toBeDefined();
  });

  it('uses createMessageWithOutput for lemma-classify when client supports it', async () => {
    const { ctx } = createMockContext({
      vaultFiles: { [NOTE]: BODY },
      // legacy createMessage NOT used; mock via createMessageWithOutput only
      llmResponses: [],
    });
    const client = ctx.getClient()!;
    let lemmaTaskCalls = 0;
    (client as unknown as { createMessageWithOutput: (params: unknown) => Promise<{ text: string; outputMode?: string }> }).createMessageWithOutput =
      async (params: unknown) => {
        const p = params as { task?: string };
        if (p.task === 'lemma-classify') {
          lemmaTaskCalls++;
          return { text: '{"kind": "entity"}', outputMode: 'json_schema' };
        }
        // extract: return a SourceAnalysis without Klotho so lemma-classify fires
        return { text: EXTRACTION_WITHOUT_LEMMA, outputMode: 'json_schema' };
      };
    const withOutputSpy = vi.spyOn(
      client as unknown as { createMessageWithOutput: (params: unknown) => Promise<unknown> },
      'createMessageWithOutput'
    );
    const legacySpy = vi.spyOn(client, 'createMessage');
    const analyzer = new SourceAnalyzer(ctx);
    // eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast
    await analyzer.analyzeSource(createMockFile(NOTE) as unknown as TFile);
    // lemma-classify went through typed path; extract also typed
    expect(withOutputSpy).toHaveBeenCalled();
    expect(lemmaTaskCalls).toBeGreaterThan(0);
    const lemmaCall = withOutputSpy.mock.calls.find(
      (c) => (c[0] as { task?: string }).task === 'lemma-classify'
    );
    expect(lemmaCall).toBeDefined();
    expect(legacySpy).not.toHaveBeenCalled();
  });

  it('falls back to createMessage when client lacks createMessageWithOutput', async () => {
    const { ctx } = createMockContext({
      vaultFiles: { [NOTE]: BODY },
      // Order: batch 1 (extract) → batch 2 (extract, mostly empty) → lemma-classify.
      // The default mock fallback returns `{"entities":[],...}` for any call past
      // the supplied list, so we explicitly include the lemma-classify answer.
      llmResponses: [
        EXTRACTION_WITHOUT_LEMMA, // idx 0 — batch 1
        '{"entities": [], "concepts": []}', // idx 1 — batch 2 (empty round)
        '{"kind": "entity"}', // idx 2 — lemma-classify
      ],
    });
    const client = ctx.getClient()!;
    expect((client as unknown as { createMessageWithOutput?: unknown }).createMessageWithOutput).toBeUndefined();
    const spy = vi.spyOn(client, 'createMessage');
    const analyzer = new SourceAnalyzer(ctx);
    // eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast
    const result = await analyzer.analyzeSource(createMockFile(NOTE) as unknown as TFile);
    expect(spy).toHaveBeenCalled();
    // Find lemma-classify among the calls
    const lemmaCall = spy.mock.calls.find(
      (c) => (c[0] as { task?: string }).task === 'lemma-classify'
    );
    expect(lemmaCall).toBeDefined();
    // Lemma was extracted via legacy path → entity added
    expect((result?.entities ?? []).some(e => e.name === 'Klotho')).toBe(true);
  });
});
