// Unit tests for page-factory/contradiction-gates.ts — the two gates an
// item-level contradiction passes before it becomes a record.

import { describe, it, expect } from 'vitest';
import {
  normalizeStatement,
  statementOnPage,
  verifySourceStance,
  type SourceStanceContext,
} from '../../../wiki/page-factory/contradiction-gates';
import type { LLMWikiSettings, LLMClient } from '../../../types';

const PAGE = `## Description
In der Behandlung der COPD kann [[N-Acetylcystein|NAC]] die Häufigkeit von Exazerbationen (IRR 0,76–0,81) sowie die Symptomatik reduzieren^[1].

## Related
- [[Glutathion]]
`;

describe('statementOnPage — gate 1', () => {
  it('finds a verbatim sentence', () => {
    expect(statementOnPage('In der Behandlung der COPD kann NAC die Häufigkeit von Exazerbationen (IRR 0,76–0,81) sowie die Symptomatik reduzieren.', PAGE)).toBe('exact');
  });

  it('matches through link markup, footnote markers and emphasis', () => {
    expect(normalizeStatement('kann [[N-Acetylcystein|NAC]] die **Häufigkeit**^[1]')).toBe('kann nac die häufigkeit');
    expect(statementOnPage('kann NAC die Häufigkeit von Exazerbationen', PAGE)).toBe('exact');
  });

  it('accepts a six-word run when the model trims or joins the sentence', () => {
    expect(statementOnPage('Laut Seite kann NAC die Häufigkeit von Exazerbationen deutlich senken', PAGE)).toBe('partial');
  });

  it('rejects a sentence that is not on the page, and an empty quote', () => {
    expect(statementOnPage('NAC senkt die Exazerbationsrate signifikant und zuverlässig.', PAGE)).toBe('none');
    expect(statementOnPage('', PAGE)).toBe('none');
    expect(statementOnPage(undefined, PAGE)).toBe('none');
  });
});

function ctxWith(response: string | (() => Promise<string>)): SourceStanceContext & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    settings: { wikiFolder: 'wiki', wikiLanguage: 'en', disableThinking: false } as LLMWikiSettings,
    getClient: () => ({
      createMessage: async (req: { messages: Array<{ content: string }> }) => {
        prompts.push(req.messages[0].content);
        return typeof response === 'function' ? response() : response;
      },
    }) as unknown as LLMClient,
  };
}

const EXCERPT = 'Es gibt aber eine Gegenposition: Ein 2019-Paper argumentiert, CCO sei nicht der primäre Photoakzeptor. Die meisten Übersichten halten an CCO fest.';

describe('verifySourceStance — gate 2', () => {
  it('no with a one-word evidence is unverified — a word the excerpt contains is not a sentence', async () => {
    const ctx = ctxWith(JSON.stringify({ holds: 'no', evidence: 'CCO' }));
    const v = await verifySourceStance(ctx, { pageName: 'ATP', claim: 'x', sourceExcerpt: EXCERPT });
    expect(v.holds).toBe('unverified');
  });

  it('folds NFD and NFC to the same evidence', async () => {
    const decomposed = 'Die meisten U\u0308bersichten halten an CCO fest.';
    const ctx = ctxWith(JSON.stringify({ holds: 'no', evidence: decomposed }));
    const v = await verifySourceStance(ctx, { pageName: 'ATP', claim: 'x', sourceExcerpt: EXCERPT });
    expect(v.holds).toBe('no');
  });

  it('yes: the source holds the claim', async () => {
    const ctx = ctxWith(JSON.stringify({ holds: 'yes', evidence: 'Die meisten Übersichten halten an CCO fest.' }));
    const v = await verifySourceStance(ctx, { pageName: 'ATP', claim: 'Übersichten halten an CCO fest', sourceExcerpt: EXCERPT });
    expect(v.holds).toBe('yes');
    // The call carries only excerpt and claim — no page content.
    expect(ctx.prompts[0]).toContain(EXCERPT);
    expect(ctx.prompts[0]).toContain('Übersichten halten an CCO fest');
    expect(ctx.prompts[0]).toContain('Does the source itself hold this claim');
  });

  it('no, with the evidence sentence found in the excerpt', async () => {
    const ctx = ctxWith(JSON.stringify({ holds: 'no', evidence: 'Ein 2019-Paper argumentiert, CCO sei nicht der primäre Photoakzeptor.' }));
    const v = await verifySourceStance(ctx, { pageName: 'ATP', claim: 'CCO ist nicht der primäre Photoakzeptor', sourceExcerpt: EXCERPT });
    expect(v.holds).toBe('no');
  });

  it('a "no" whose evidence is not in the excerpt is unverified — the item stays', async () => {
    const ctx = ctxWith(JSON.stringify({ holds: 'no', evidence: 'Critics have long doubted this.' }));
    const v = await verifySourceStance(ctx, { pageName: 'ATP', claim: 'x', sourceExcerpt: EXCERPT });
    expect(v.holds).toBe('unverified');
  });

  it('no excerpt → unverified without a call', async () => {
    const ctx = ctxWith('should not be called');
    const v = await verifySourceStance(ctx, { pageName: 'ATP', claim: 'x', sourceExcerpt: '   ' });
    expect(v.holds).toBe('unverified');
    expect(ctx.prompts).toHaveLength(0);
  });

  it('a failing call is unverified, never a throw', async () => {
    const ctx = ctxWith(async () => { throw new Error('boom'); });
    const orig = console.warn; console.warn = () => {};
    try {
      const v = await verifySourceStance(ctx, { pageName: 'ATP', claim: 'x', sourceExcerpt: EXCERPT });
      expect(v.holds).toBe('unverified');
    } finally { console.warn = orig; }
  });

  it('renders the source summary when a context is given', async () => {
    const ctx = ctxWith(JSON.stringify({ holds: 'yes', evidence: '' }));
    await verifySourceStance(ctx, { pageName: 'ATP', claim: 'x', sourceExcerpt: EXCERPT, sourceContext: { sourceTitle: 'Rotlicht', summary: 'A note about PBM.', sourcePath: 'n.md' } });
    expect(ctx.prompts[0]).toContain('**What the source document as a whole is about:**\nA note about PBM.');
  });
});
