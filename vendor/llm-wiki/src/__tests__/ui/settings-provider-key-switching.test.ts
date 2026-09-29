/**
 * v1.25.7 PATCH regression test for the "API key self-restore" bug.
 *
 * Bug: when switching LLM providers in the Settings tab, any key the user
 * typed into the API Key input was silently overwritten by the stale
 * SecretStorage value from the previously-active provider on every
 * `tab.display()` re-render. Two independent causes were fixed:
 *
 *   1. provider-section.ts input initial value (now `resolveInitialApiKey`):
 *      `tempSettings.apiKey` non-empty wins over SecretStorage. Without
 *      this, every re-render painted the OLD provider's key over the
 *      freshly-typed value.
 *   2. resolveProviderApiKey gained an optional `pendingKey` parameter
 *      that wins over SecretStorage. Wired into Fetch Models /
 *      Test Connection / createLLMClient so the freshly-typed key
 *      reaches the wire.
 *
 * This file pins both contracts by calling the production helpers
 * directly (no mirror, no drift risk).
 */

import { describe, it, expect } from 'vitest';
import {
  resolveProviderApiKey,
  resolveInitialApiKey,
} from '../../llm-sdk/provider-api-key-resolver';
import type { ProviderSecretStorage } from '../../llm-sdk/provider-secret-store';

const SETTINGS = { apiKey: '', providerApiKeySecretId: 'karpathywiki-provider-api-key' };

function backendWith(raw?: string): ProviderSecretStorage {
  const values = new Map<string, string>();
  if (raw !== undefined) values.set('karpathywiki-provider-api-key', raw);
  return {
    getSecret: (id) => values.get(id) ?? null,
    setSecret: (id, value) => { values.set(id, value); },
  };
}

describe('v1.25.7 PATCH: resolveInitialApiKey input precedence', () => {
  it('prefers tempSettings.apiKey over SecretStorage (typed key survives re-render)', () => {
    expect(
      resolveInitialApiKey(
        { apiKey: 'sk-cp-minimax-xxx', providerApiKeySecretId: SETTINGS.providerApiKeySecretId },
        backendWith('sk-deepseek-old'),
      ),
    ).toBe('sk-cp-minimax-xxx');
  });

  it('falls back to SecretStorage when tempSettings.apiKey is empty', () => {
    expect(
      resolveInitialApiKey(
        { apiKey: '', providerApiKeySecretId: SETTINGS.providerApiKeySecretId },
        backendWith('sk-stored'),
      ),
    ).toBe('sk-stored');
  });

  it('falls back to SecretStorage when tempSettings.apiKey is whitespace-only', () => {
    expect(
      resolveInitialApiKey(
        { apiKey: '   ', providerApiKeySecretId: SETTINGS.providerApiKeySecretId },
        backendWith('sk-stored'),
      ),
    ).toBe('sk-stored');
  });

  it('returns empty string when both sources are empty', () => {
    expect(
      resolveInitialApiKey(
        { apiKey: '', providerApiKeySecretId: SETTINGS.providerApiKeySecretId },
        backendWith(),
      ),
    ).toBe('');
  });

  it('returns empty string when secretStorage is null and tempSettings.apiKey is empty', () => {
    expect(
      resolveInitialApiKey(
        { apiKey: '', providerApiKeySecretId: SETTINGS.providerApiKeySecretId },
        null,
      ),
    ).toBe('');
  });

  it('trims whitespace from tempSettings.apiKey', () => {
    expect(
      resolveInitialApiKey(
        { apiKey: '  sk-cp-new  ', providerApiKeySecretId: SETTINGS.providerApiKeySecretId },
        backendWith('sk-stored'),
      ),
    ).toBe('sk-cp-new');
  });

  it('survives SecretStorage.getSecret throw (locked keychain)', () => {
    const broken: ProviderSecretStorage = {
      getSecret: () => { throw new Error('keychain locked'); },
      setSecret: () => {},
    };
    expect(
      resolveInitialApiKey(
        { apiKey: '', providerApiKeySecretId: SETTINGS.providerApiKeySecretId },
        broken,
      ),
    ).toBe('');
  });
});

describe('v1.25.7 PATCH: resolveProviderApiKey pendingKey precedence', () => {
  it('returns typed key (pendingKey wins over SecretStorage)', () => {
    expect(
      resolveProviderApiKey(SETTINGS, backendWith('sk-stored'), 'sk-typed'),
    ).toBe('sk-typed');
  });

  it('returns typed key when pendingKey is set even with valid SecretStorage', () => {
    // The scenario the bug describes: switch from deepseek to minimax,
    // type new key. SecretStorage still has the deepseek key.
    expect(
      resolveProviderApiKey(SETTINGS, backendWith('sk-deepseek-stale'), 'sk-minimax-new'),
    ).toBe('sk-minimax-new');
  });

  it('falls through to SecretStorage when pendingKey is empty (no pending edit)', () => {
    expect(
      resolveProviderApiKey(SETTINGS, backendWith('sk-stored'), ''),
    ).toBe('sk-stored');
  });

  it('end-to-end: switch provider + type new key → request uses new key', () => {
    // Mirror the full UI sequence:
    //   1. User switches provider from deepseek to minimax
    //   2. SecretStorage still has the deepseek key (last flush)
    //   3. User types new key into input
    //   4. Re-render triggered (display())
    //   5. Input value should be the typed key, not the stored key
    const stored = 'sk-deepseek-old';
    const typed = 'sk-cp-minimax-xxx';
    const inputValue = resolveInitialApiKey(
      { apiKey: typed, providerApiKeySecretId: SETTINGS.providerApiKeySecretId },
      backendWith(stored),
    );
    expect(inputValue).toBe(typed);

    //   6. User clicks Fetch Models — resolver should use typed key
    const effectiveApiKey = resolveProviderApiKey(SETTINGS, backendWith(stored), typed);
    expect(effectiveApiKey).toBe(typed);
  });
});