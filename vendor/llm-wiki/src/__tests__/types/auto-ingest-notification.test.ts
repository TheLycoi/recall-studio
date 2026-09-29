// v1.22.2: autoIngestNotificationLevel — watch-mode auto-ingest should not
// block UX with a modal. When set to 'notice' (default), only a transient
// Notice is shown with a hint to the Operation History Panel.
import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from '../../types';

describe('autoIngestNotificationLevel (v1.22.2 — avoid blocking modal in auto mode)', () => {
  it('defaults to "notice" so watch-mode auto-ingest does NOT block', () => {
    expect(DEFAULT_SETTINGS.autoIngestNotificationLevel).toBe('notice');
  });

  it('accepts "modal" as a valid value for users who want the old behaviour', () => {
    const s = { ...DEFAULT_SETTINGS, autoIngestNotificationLevel: 'modal' as const };
    expect(s.autoIngestNotificationLevel).toBe('modal');
  });

  it('accepts "notice" as a valid value', () => {
    const s = { ...DEFAULT_SETTINGS, autoIngestNotificationLevel: 'notice' as const };
    expect(s.autoIngestNotificationLevel).toBe('notice');
  });

  it('DEFAULT_SETTINGS has all expected auto-maintenance fields', () => {
    // Ensure the new field sits next to the existing auto-maintenance settings
    expect(DEFAULT_SETTINGS).toHaveProperty('autoWatchMode');
    expect(DEFAULT_SETTINGS).toHaveProperty('autoSmartFix');
    expect(DEFAULT_SETTINGS).toHaveProperty('autoIngestNotificationLevel');
  });
});
