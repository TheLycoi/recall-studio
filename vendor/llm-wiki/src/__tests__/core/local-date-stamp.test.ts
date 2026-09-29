import { describe, it, expect } from 'vitest';
import { localDateStamp } from '../../core/format';

describe('localDateStamp', () => {
  it('formats the local calendar date as YYYY-MM-DD with zero padding', () => {
    // Local components — the same wall-clock date in every time zone.
    expect(localDateStamp(new Date(2026, 0, 5, 9, 15))).toBe('2026-01-05');
    expect(localDateStamp(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31');
  });

  it('keeps the local date across the hours where the UTC date still lags', () => {
    // 00:30 local on 3 Sep. In any zone east of UTC toISOString() still says
    // 2 Sep here; the vault's dates are read in local time, so 3 Sep is right.
    const justAfterMidnight = new Date(2026, 8, 3, 0, 30);
    expect(localDateStamp(justAfterMidnight)).toBe('2026-09-03');
  });

  it('defaults to now', () => {
    const now = new Date();
    expect(localDateStamp()).toBe(localDateStamp(now));
  });
});
