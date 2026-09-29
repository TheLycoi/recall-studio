// url-fallback-cross-consumer.test.ts
//
// v1.23.0 P1.5 follow-up: end-to-end verification that the URL
// fallback's resolved baseURL is shared across all LLM business
// paths.
//
// Strategy: test the actual url-fallback module's cache behavior
// with a custom testFn that simulates a mock SDK client. This
// verifies the contract that the SDK clients rely on — they
// all share the same module-level cache via getCachedUrl /
// cacheResolvedUrl.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  resolveBaseUrlWithFallback,
  getCachedUrl,
  cacheResolvedUrl,
  invalidateCache,
} from '../../core/url-fallback';

describe('URL fallback: cross-consumer consistency (module cache)', () => {
  beforeEach(() => {
    invalidateCache();
  });

  it('all consumers share the same resolved URL after fallback', async () => {
    // Simulate the SDK client's probeBaseURL testFn. Maps URL →
    // whether the /messages endpoint works at that URL.
    const probeWorks = vi.fn().mockImplementation(async (baseURL: string) => {
      // Simulate Kimi Coding Plan: /coding/messages → 404 (false),
      // /coding/v1/messages → 200 (true).
      if (baseURL === 'https://api.kimi.com/coding/') {
        return false; // /coding/messages 404
      }
      if (baseURL === 'https://api.kimi.com/coding') {
        return false; // /coding/messages 404 (no trailing slash)
      }
      if (baseURL === 'https://api.kimi.com/coding/v1') {
        return true; // /coding/v1/messages 200
      }
      return false;
    });

    // === Step 1: Test Connection (first call) ===
    // Simulates what createMessage → getProvider does in the SDK
    // client. resolveBaseUrlWithFallback tries the original URL
    // and candidates, picks the first that returns true.
    const resolved1 = await resolveBaseUrlWithFallback({
      baseUrl: 'https://api.kimi.com/coding/',
      testFn: probeWorks,
    });
    expect(resolved1).toBe('https://api.kimi.com/coding/v1');
    expect(getCachedUrl('https://api.kimi.com/coding/')).toBe('https://api.kimi.com/coding/v1');

    // probe was called with 3 candidates: original + stripped + /v1
    expect(probeWorks).toHaveBeenCalledTimes(3);

    // === Step 2: Subsequent call (Ingest / Lint / Query) ===
    // The SDK client calls getCachedUrl first; cache hit → no
    // probe at all. This is the key contract: NO re-resolution
    // for subsequent consumers.
    probeWorks.mockClear();
    const resolved2 = await resolveBaseUrlWithFallback({
      baseUrl: 'https://api.kimi.com/coding/',
      testFn: probeWorks,
    });
    expect(resolved2).toBe('https://api.kimi.com/coding/v1');
    expect(probeWorks).not.toHaveBeenCalled(); // Cache hit, no probe needed
  });

  it('invalidate cache forces re-resolution when settings change', () => {
    cacheResolvedUrl('https://api.kimi.com/coding/', 'https://api.kimi.com/coding/v1');
    expect(getCachedUrl('https://api.kimi.com/coding/')).toBe('https://api.kimi.com/coding/v1');

    // User edits settings → invalidate all → next call must re-probe
    invalidateCache();
    expect(getCachedUrl('https://api.kimi.com/coding/')).toBeUndefined();
  });

  it('multiple baseURLs cached independently (no cross-contamination)', async () => {
    // Two providers in two different user setups, both with wrong URL
    cacheResolvedUrl('https://api.kimi.com/coding/', 'https://api.kimi.com/coding/v1');
    cacheResolvedUrl('https://other.example.com/api/', 'https://other.example.com/api/v1');

    expect(getCachedUrl('https://api.kimi.com/coding/')).toBe('https://api.kimi.com/coding/v1');
    expect(getCachedUrl('https://other.example.com/api/')).toBe('https://other.example.com/api/v1');

    // One of them changes
    invalidateCache('https://api.kimi.com/coding/');
    expect(getCachedUrl('https://api.kimi.com/coding/')).toBeUndefined();
    expect(getCachedUrl('https://other.example.com/api/')).toBe('https://other.example.com/api/v1');
  });
});
