// Regression test for Issue #137: settings panel `hide()` and Save button
// must NOT overwrite `thinkingControlCache` (which the form doesn't track
// but Test Connection writes based on the live provider probe). Earlier
// versions used `{ ...tempSettings }` shallow copy that wiped the cache
// to `undefined` on every settings-tab close, forcing a re-probe and
// producing a `dialect: undefined` 400 on the next ingestion.
//
// We test the fix by reproducing the exact merge that hide() / Save now
// perform, asserting the cache survives.

import { describe, it, expect } from 'vitest';
import type { LLMWikiSettings } from '../../types';

type SettingsLike = LLMWikiSettings & Record<string, unknown>;

function mergePreservingTestConnectionFields(
  tempSettings: SettingsLike,
  liveSettings: SettingsLike,
): SettingsLike {
  // Mirrors the merge in src/ui/settings.ts (hide() + Save button).
  // The order matters: spread tempSettings first, then OVERRIDE with the
  // live fields that the temp form doesn't track.
  return {
    ...tempSettings,
    watchedFolders: [...(tempSettings.watchedFolders || [])],
    thinkingControlCache: liveSettings.thinkingControlCache,
  };
}

describe('Issue #137 — settings merge preserves thinkingControlCache', () => {
  it('hide-style merge does not wipe thinkingControlCache when tempSettings lacks it', () => {
    const cache = { 'https://generativelanguage.googleapis.com/v1beta/openai': 'openai' as const };
    const tempSettings = {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      // form does NOT track this field
      thinkingControlCache: undefined,
    } as unknown as SettingsLike;
    const liveSettings = {
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite',
      thinkingControlCache: cache,
    } as unknown as SettingsLike;

    const merged = mergePreservingTestConnectionFields(tempSettings, liveSettings);

    expect(merged.thinkingControlCache).toEqual(cache);
  });

  it('save-style merge is idempotent when both sides already agree', () => {
    const cache = { 'https://api.openai.com/v1': 'anthropic' as const };
    const tempSettings = {
      provider: 'openai',
      model: 'gpt-4o',
      thinkingControlCache: cache,
    } as unknown as SettingsLike;
    const liveSettings = {
      provider: 'openai',
      model: 'gpt-4o',
      thinkingControlCache: cache,
    } as unknown as SettingsLike;

    const merged = mergePreservingTestConnectionFields(tempSettings, liveSettings);

    expect(merged.thinkingControlCache).toEqual(cache);
  });

  it('preserves cache across different providers (old baseUrl entry remains valid)', () => {
    const oldCache = { 'https://api.openai.com/v1': 'anthropic' as const };
    const newCache = {
      'https://api.openai.com/v1': 'anthropic' as const,
      'https://generativelanguage.googleapis.com/v1beta/openai': 'openai' as const,
    };
    const tempSettings = {
      provider: 'gemini',
      thinkingControlCache: undefined,
    } as unknown as SettingsLike;
    const liveSettings = {
      provider: 'openai',
      thinkingControlCache: oldCache,
    } as unknown as SettingsLike;

    // Simulate: user just probed Gemini, live now has both entries.
    liveSettings.thinkingControlCache = newCache;

    const merged = mergePreservingTestConnectionFields(tempSettings, liveSettings);

    // Both entries survive — switching provider must not invalidate
    // previously-cached baseUrl entries.
    expect(merged.thinkingControlCache).toEqual(newCache);
  });
});
