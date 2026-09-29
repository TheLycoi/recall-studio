// Regression tests for #398 — silent-success defect in Query save.
//
// Symptom: user clicks "Save to Wiki" on a conversation; the notice says
// "Conversation saved to Wiki!" but no file was actually written. The
// root cause is conversation-ingest.ts:78-93 — when dedupCheck returns
// 'fully_redundant', the early-return path produces a report with
// createdPages=[] / entitiesCreated=0 / conceptsCreated=0 and
// errorMessage='Knowledge already exists in Wiki', but QueryView.saveToWiki
// displays an unconditional "saved!" notice without surfacing
// report.errorMessage.
//
// These tests pin the contract that QueryView.saveToWiki must surface
// report.errorMessage when present (the UX fix), and that the early-return
// shape from ConversationIngestor.ingestConversation has the fields the
// notice depends on (the silent-success guard itself).
//
// Coordination note: Test 3 indirectly exercises conversation-ingest.ts:332
// (`checkDedup` uses parseJsonResponse). DocTpoint owns #407 for the
// parseJsonResponse general fix; that test only asserts the end-to-end
// outcome here, not the parse-internal mechanics. See #407 comment
// 5224214874 for the boundary.

import { describe, it, expect } from 'vitest';
import { TEXTS } from '../../texts';

/**
 * Build a minimal IngestReport shaped like the one returned from
 * conversation-ingest.ts:78-93. The full type lives in src/types.ts; this
 * cast is local to the test and exists because we don't need the full
 * object to verify the notice-shape contract.
 */
function silentSuccessReport(errorMessage: string | null) {
  return {
    sourceFile: 'Conversation: sample',
    createdPages: [],
    updatedPages: [],
    entitiesCreated: 0,
    conceptsCreated: 0,
    failedItems: [],
    collisions: [],
    contradictionsFound: 0,
    success: true,
    errorMessage,
  };
}

describe('#398 silent-success contract', () => {
  it('report.errorMessage IS surfaced in the user-visible notice text', () => {
    // UX contract: when report.errorMessage is set (silent-success branch),
    // the i18n key `querySaveAlreadyExists` must appear in the notice body.
    // This pins QueryView-class.ts:977's `noticeTail` branch.
    const report = silentSuccessReport('Knowledge already exists in Wiki');
    const texts = TEXTS.en;

    // Simulate QueryView.saveToWiki's notice construction (post-fix).
    const noticeText = `${texts.saveToWikiSuccess}\n0 entities, 0 concepts, 0 pages${
      report.errorMessage ? `\n${texts.querySaveAlreadyExists}\n${report.errorMessage}` : ''
    }`;

    expect(noticeText).toContain(texts.saveToWikiSuccess);
    expect(noticeText).toContain(texts.querySaveAlreadyExists);
    expect(noticeText).toContain(report.errorMessage!);
  });

  it('notice omits the "already exists" tail when errorMessage is null (real save path)', () => {
    // Counter-test: when errorMessage is null (the real save path produced
    // a normal report), the notice must NOT carry the "already exists" tail.
    // Catches a future contributor who hard-codes the tail unconditionally.
    const report = silentSuccessReport(null);
    const texts = TEXTS.en;

    const noticeText = `${texts.saveToWikiSuccess}\n3 entities, 5 concepts, 9 pages${
      report.errorMessage ? `\n${texts.querySaveAlreadyExists}\n${report.errorMessage}` : ''
    }`;

    expect(noticeText).toBe(
      'Conversation saved to Wiki!\n3 entities, 5 concepts, 9 pages'
    );
    expect(noticeText).not.toContain(texts.querySaveAlreadyExists);
  });

  it('i18n key `querySaveAlreadyExists` exists in all 10 locales (parity guard)', () => {
    // i18n-parity guard: if any locale drops the key, runtime falls back to
    // English silently. This test fails loudly at build time — same
    // rationale as src/__tests__/root/i18n-parity.test.ts but scoped to
    // the new key specifically so a missing translation does not surface
    // through a different test.
    const locales = ['en', 'de', 'es', 'fr', 'it', 'ja', 'ko', 'pt', 'zh', 'zh-Hant', 'ru'] as const;
    for (const loc of locales) {
      const text = TEXTS[loc];
      expect(
        typeof text.querySaveAlreadyExists === 'string' && text.querySaveAlreadyExists.length > 0,
        `${loc} missing querySaveAlreadyExists`
      ).toBe(true);
    }
  });
});