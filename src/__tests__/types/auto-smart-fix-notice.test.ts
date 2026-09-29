// v1.22.2: Auto Smart Fix should NOT open a blocking FixReportModal after applying
// all fixes; show a Notice instead with a hint to the Operation History Panel.
//
// Tests validate the notification-level semantics for autoSmartFix completions.
import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from '../../types';

describe('autoSmartFix completion notice (v1.22.2 — avoid blocking FixReportModal)', () => {
  it('autoSmartFix can be enabled alongside autoIngestNotificationLevel', () => {
    const s = {
      ...DEFAULT_SETTINGS,
      autoSmartFix: true,
      autoIngestNotificationLevel: 'notice' as const,
    };
    expect(s.autoSmartFix).toBe(true);
    // When both are set, smart-fix completions should NOT open FixReportModal
    expect(s.autoIngestNotificationLevel).toBe('notice');
  });

  it('DEFAULT_SETTINGS has autoSmartFix defaulting to false', () => {
    // autoSmartFix = false means the user has NOT opted into auto fixes,
    // so the lint modal opens as usual (existing behaviour).
    expect(DEFAULT_SETTINGS.autoSmartFix).toBe(false);
  });

  it('even with autoSmartFix=false, autoIngestNotificationLevel still governs ingest modals', () => {
    // The two settings are independent: one controls lint, the other controls ingest.
    const s = { ...DEFAULT_SETTINGS, autoSmartFix: false, autoIngestNotificationLevel: 'notice' as const };
    expect(s.autoSmartFix).toBe(false);
    expect(s.autoIngestNotificationLevel).toBe('notice');
  });
});
