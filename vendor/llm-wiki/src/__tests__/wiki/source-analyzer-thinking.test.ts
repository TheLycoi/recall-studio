import { describe, it, expect, vi } from 'vitest';
import { createMockContext, createMockFile } from '../__support__/engine-context';
import { SourceAnalyzer } from '../../wiki/source-analyzer';
import type { LLMClient } from '../../types';
import { TFile } from 'obsidian';

const SOURCE = 'sources/note.md';

// Extraction never consulted the thinking setting, so whatever the server had
// been started with decided it and the setting meant nothing here. It was not
// the only such call site — the lint alias and tag runners and the PDF
// converter still do not pass it — but it is the one covered here.
//
// Sent in the disable direction only, matching every other call site.
// `disableThinking` defaults to false, so a call that asked for reasoning would
// fire on every install that never opened the setting, putting
// `chat_template_kwargs` into every request to every OpenAI-compatible provider
// on the strength of measurements against one local server.

function analyzerFor(settings: { disableThinking?: boolean }) {
  const { ctx } = createMockContext({
    vaultFiles: { [SOURCE]: '# Note\nThe striatum encodes habit formation.' },
    llmResponses: [JSON.stringify({
      source_title: 'Note',
      summary: 'A summary.',
      entities: [{ name: 'Striatum', type: 'other', summary: 'a', mentions_in_source: [] }],
      concepts: [],
    })],
    settings,
  });
  return ctx;
}

async function thinkingSentBy(settings: { disableThinking?: boolean }) {
  const ctx = analyzerFor(settings);
  const spy = vi.spyOn(ctx.getClient()!, 'createMessage');
  // eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast
  await new SourceAnalyzer(ctx).analyzeSource(createMockFile(SOURCE) as unknown as TFile);
  return spy.mock.calls[0][0];
}

describe('SourceAnalyzer — the thinking setting reaches the extraction call', () => {
  it('asks the model not to reason when the user turned it off', async () => {
    expect((await thinkingSentBy({ disableThinking: true })).enableThinking).toBe(false);
  });

  // The default, and the state every install that never opened the setting is
  // in. Asking for thinking here was tried and withdrawn: the field would then
  // travel in every extraction request to every OpenAI-compatible provider,
  // and the evidence that it is harmless comes from one local server.
  //
  // Not written as `disableThinking: undefined` — the settings merge fills the
  // default in, so that state does not exist at runtime and a test asserting it
  // would pass without covering anything.
  it('leaves the server alone when the user has not turned reasoning off', async () => {
    expect(await thinkingSentBy({ disableThinking: false })).not.toHaveProperty('enableThinking');
  });
});

// v1.26.0 Batch 7 follow-up (eucher, PR #411 review comment 2026-08-05):
// the main analysis path honors `disableThinking === true`, but the
// JSON-repair callback at source-analyzer.ts:420 (inside the
// `parseJsonResponse` repair closure) was missing the field entirely.
// A user who enabled `disableThinking` got reasoning back on every
// repair attempt. Same shape of bug as the dedup-phase wiring fix in
// commit F5-A — a call that read the right setting, branched on the
// right condition, and forgot the conditional spread.
//
// v1.26.0 Batch 7 follow-up (DocTpoint PR #411 review 2026-08-05
// 05:38 UTC): eucher's earlier observation that the JSON-repair
// callback at source-analyzer.ts:417 did not propagate
// `disableThinking` is true at the surface. DocTpoint's controlled
// pair on LM Studio / gemma-4-12b, however, showed that MIRRORING
// the parent call's `disableThinking` flag onto repair produces
// structurally valid JSON with wrong content (concepts duplicated
// into entities; `concepts = null`; fields dropped) — silent data
// corruption. Repair needs reasoning budget to understand broken-
// JSON semantics. The per-call policy is: parent analysis honors
// `disableThinking`; repair always allows reasoning (no flag passed);
// short-cap append honors `disableThinking`. Tracked as a v1.26.x
// PATCH item (per-call `thinkingPolicy` enum).
//
// Regression guard: even when the user has `disableThinking: true`,
// the JSON-repair callback MUST NOT pass `enableThinking: false`.
// Without this guard, a future contributor adding a "uniformly
// propagate disableThinking" rule (eucher's surface-level read) would
// re-introduce silent repair corruption.
describe('SourceAnalyzer — repair callback leaves reasoning enabled regardless of disableThinking', () => {
  // Brace-balanced JSON that JSON.parse rejects AND fixCommonJsonIssues
  // does not repair (mirrors the truncation-retry test pattern at line
  // 195). Triggers the repairFn path inside parseJsonResponse.
  // Note: source-analyzer.ts:416 sets repairFn to `undefined` when
  // `finishReason === 'length' && canHalveBatch()` — i.e. on the FIRST
  // truncated batch (initialBatchSize > minBatchSize). To exercise the
  // repair path we report `finishReason: 'stop'` (a non-truncation
  // parse failure) so repairFn is always wired in.
  const MALFORMED_JSON = '{"entities": [oops]}';
  const FIXED_JSON = '{"source_title":"x","summary":"y","entities":[],"concepts":[]}';

  function makeCaptureClient(): { client: LLMClient } {
    const client: LLMClient = {
      createMessage: async (params) => {
        const first = params.messages[0];
        const prompt = typeof first.content === 'string' ? first.content : '';
        if (prompt.startsWith('Fix the following malformed JSON')) {
          return FIXED_JSON;
        }
        // finishReason: 'stop' (not 'length') so source-analyzer's
        // repairFn-gating branch at line 416 wires the repair closure.
        params.onFinish?.({ finishReason: 'stop' });
        return MALFORMED_JSON;
      },
    };
    return { client };
  }

  it('does NOT pass enableThinking on the repair call even when disableThinking is true', async () => {
    const { ctx } = createMockContext({
      vaultFiles: { [SOURCE]: '# Note\nThe striatum encodes habit formation.' },
      settings: { disableThinking: true },
    });
    const { client } = makeCaptureClient();
    ctx.getClient = () => client;
    const spy = vi.spyOn(client, 'createMessage');

    // eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast
    await new SourceAnalyzer(ctx).analyzeSource(createMockFile(SOURCE) as unknown as TFile);

    const repairCall = spy.mock.calls.find(c => {
      const p = c[0].messages[0].content;
      return typeof p === 'string' && p.startsWith('Fix the following malformed JSON');
    });
    expect(repairCall).toBeDefined();
    // Repair must NOT mirror parent's disableThinking — DocTpoint's
    // measurement showed this causes silent data corruption.
    expect(repairCall![0] as Record<string, unknown>).not.toHaveProperty('enableThinking');
  });
});
