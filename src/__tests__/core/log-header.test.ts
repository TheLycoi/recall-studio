// v1.22.2: log.md header i18n — pure-function buildLogHeader
// The first time log.md is created, it gets a header explaining the
// log and pointing to the Operation History Panel for better visualisation.
import { describe, it, expect } from 'vitest';
import { buildLogHeader } from '../../core/log-header';

describe('buildLogHeader (v1.22.2 — log header i18n)', () => {
  it('returns English header by default', () => {
    const h = buildLogHeader('en');
    expect(h).toMatch(/# Wiki Operation Log/);
    expect(h).toMatch(/Operation History/);
  });

  it('returns Chinese header for zh', () => {
    const h = buildLogHeader('zh');
    expect(h).toMatch(/# Wiki 操作日志/);
    expect(h).toMatch(/操作历史/);
  });

  it('every header mentions the View operation history command', () => {
    for (const lang of ['en', 'zh', 'ja', 'ko', 'de', 'fr', 'es', 'pt', 'it', 'zh-Hant']) {
      const h = buildLogHeader(lang);
      expect(h).toMatch(/View operation history|查看操作历史|操作履歴|작업 기록|Betriebsverlauf|historique|historial|histórico|cronologia operazioni|檢視操作歷史/);
    }
  });

  it('falls back to English for unknown language', () => {
    const h = buildLogHeader('xx');
    expect(h).toMatch(/# Wiki Operation Log/);
  });

  it('header is non-empty for all supported locales', () => {
    for (const lang of ['en', 'zh', 'ja', 'ko', 'de', 'fr', 'es', 'pt', 'it', 'zh-Hant']) {
      const h = buildLogHeader(lang);
      expect(h.length).toBeGreaterThan(50);
      expect(h).not.toMatch(/\[missing/);
    }
  });

  it('every header embeds the detection marker for language-agnostic identification', () => {
    // The <!-- llm-wiki-log-header-start --> marker is the structural
    // fingerprint isOldFormatLogHeader() uses to recognise a new-format
    // header. It must be present in every locale's output.
    for (const lang of ['en', 'zh', 'ja', 'ko', 'de', 'fr', 'es', 'pt', 'it', 'zh-Hant']) {
      const h = buildLogHeader(lang);
      expect(h).toMatch(/<!-- llm-wiki-log-header-start -->/);
    }
  });
});
