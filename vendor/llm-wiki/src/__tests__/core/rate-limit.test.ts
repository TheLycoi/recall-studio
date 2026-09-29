import { describe, it, expect } from 'vitest';
import { detectRateLimitFailures, formatRateLimitNotice, isRateLimitFailure } from '../../core/rate-limit';

// v1.26.0 Batch 7 + CR-3 fix: isRateLimitFailure accepts either a
// plain string (original contract) or a structured item with a `type`
// discriminator. parse-failure items must NEVER be classified as
// rate-limit regardless of free-text reason. This is the regression
// guard that lets the dedup-phase Batch 7 push tag parse-failures
// safely without risk of future prose-string drift colliding with
// the rate-limit regex.
describe('isRateLimitFailure — CR-3 structured form', () => {
  it('plain string form: matches "throttl"', () => {
    expect(isRateLimitFailure('request was throttled')).toBe(true);
  });

  it('plain string form: matches "429"', () => {
    expect(isRateLimitFailure('HTTP 429')).toBe(true);
  });

  it('plain string form: matches "rate limit"', () => {
    expect(isRateLimitFailure('rate limit exceeded')).toBe(true);
  });

  it('plain string form: matches "too many requests"', () => {
    expect(isRateLimitFailure('too many requests')).toBe(true);
  });

  it('plain string form: does NOT match unrelated text', () => {
    expect(isRateLimitFailure('parse-failure: response present but JSON unparseable or truncated')).toBe(false);
    expect(isRateLimitFailure('connection reset')).toBe(false);
  });

  it('structured form with type=parse-failure: NEVER rate-limit (CR-3 fix)', () => {
    // The discriminator is the source of truth. The free-text reason
    // could mention "throttl" or "rate limit" by accident — the
    // discriminator wins. This is the exact failure mode the CR-3
    // fix prevents.
    expect(isRateLimitFailure({ type: 'parse-failure', reason: 'request was throttled' })).toBe(false);
    expect(isRateLimitFailure({ type: 'parse-failure', reason: 'rate limit exceeded' })).toBe(false);
    expect(isRateLimitFailure({ type: 'parse-failure', reason: 'parse-failure: response was throttled mid-flight' })).toBe(false);
  });

  it('structured form without type falls back to prose match', () => {
    expect(isRateLimitFailure({ reason: 'request was throttled' })).toBe(true);
    expect(isRateLimitFailure({ reason: 'parse-failure: ...' })).toBe(false);
  });

  it('structured form with type=undefined falls back to prose match', () => {
    expect(isRateLimitFailure({ type: undefined, reason: '429' })).toBe(true);
  });

  it('accepts undefined reason (returns false)', () => {
    expect(isRateLimitFailure(undefined)).toBe(false);
  });
});
describe('detectRateLimitFailures', () => {
  it('returns null when no rate limit failures', () => {
    const result = detectRateLimitFailures(
      [{ name: 'page1', reason: 'timeout' }],
      3, 300
    );
    expect(result).toBeNull();
  });

  it('detects 429 status code', () => {
    const result = detectRateLimitFailures(
      [{ name: 'page1', reason: 'HTTP 429 error' }],
      3, 300
    );
    expect(result).not.toBeNull();
    expect(result?.count).toBe(1);
  });

  it('detects "too many requests" pattern', () => {
    const result = detectRateLimitFailures(
      [{ name: 'page1', reason: 'too many requests from provider' }],
      3, 300
    );
    expect(result).not.toBeNull();
  });

  it('detects "throttl" pattern', () => {
    const result = detectRateLimitFailures(
      [{ name: 'page1', reason: 'request was throttled' }],
      3, 300
    );
    expect(result).not.toBeNull();
  });

  it('suggests lower concurrency', () => {
    const result = detectRateLimitFailures(
      [{ name: 'p1', reason: '429' }, { name: 'p2', reason: '429' }],
      3, 300
    );
    expect(result?.suggestedConcurrency).toBe(2);
  });

  it('suggests min concurrency of 1', () => {
    const result = detectRateLimitFailures(
      [{ name: 'p1', reason: '429 too many requests' }],
      1, 300
    );
    expect(result?.suggestedConcurrency).toBe(1);
  });

  it('suggests increased delay', () => {
    const result = detectRateLimitFailures(
      [{ name: 'p1', reason: '429' }],
      3, 300
    );
    expect(result?.suggestedDelay).toBe(600);
  });

  it('suggests min delay of 500ms when current is very low', () => {
    const result = detectRateLimitFailures(
      [{ name: 'p1', reason: '429' }],
      3, 50
    );
    expect(result?.suggestedDelay).toBe(500);
  });

  // v1.26.0 Batch 7 + CR-3 fix (PR #411 simplify review 2026-08-05):
  // the `type: 'parse-failure'` discriminator MUST be honored by
  // `detectRateLimitFailures` in production, not just by
  // `isRateLimitFailure` directly. Before this test, the
  // structured-form branch was only reachable when callers passed the
  // full item — `detectRateLimitFailures` itself was passing
  // `f.reason` (string) only, so the discriminator never reached the
  // predicate in the dedup-phase call path.
  it('does NOT classify a type=parse-failure item as rate-limit (CR-3 wiring)', () => {
    // Even though the free-text reason mentions "throttl" (which the
    // prose regex would match), the type discriminator wins. The
    // dedup-phase Batch 7 commits push exactly this shape.
    const result = detectRateLimitFailures(
      [{ name: 'batch-1', type: 'parse-failure', reason: 'parse-failure: response was throttled mid-flight' }],
      3, 300,
    );
    expect(result).toBeNull();
  });

  it('still classifies a plain-prose "throttled" reason without type', () => {
    // The non-discriminated path stays intact for callers that don't
    // tag their failure kind (url-fallback, transient-retry, etc.).
    const result = detectRateLimitFailures(
      [{ name: 'p1', reason: 'request was throttled' }],
      3, 300,
    );
    expect(result?.count).toBe(1);
  });
});

describe('formatRateLimitNotice', () => {
  it('uses template from EN texts', () => {
    const result = formatRateLimitNotice(
      { count: 3, rateLimitNames: ['a', 'b', 'c'], suggestedConcurrency: 2, suggestedDelay: 600 },
      'en',
    );
    expect(result).toContain('3');
    expect(result).toContain('2');
    expect(result).toContain('600');
  });

  it('falls back to EN for unknown language', () => {
    const result = formatRateLimitNotice(
      { count: 2, rateLimitNames: ['page1', 'page2'], suggestedConcurrency: 1, suggestedDelay: 500 },
      'xx',
    );
    expect(result).toContain('2');
    expect(result).toContain('1');
    expect(result).toContain('500');
  });
});

