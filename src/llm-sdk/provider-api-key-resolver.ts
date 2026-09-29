// v1.25.3 #182: small helper that resolves the effective provider API
// key. Reads from Obsidian SecretStorage first (the new authoritative
// source), falls back to `settings.apiKey` for legacy data or test
// environments without a stubbed secretStorage.
//
// Why a helper instead of inline `getSecret(...) ?? settings.apiKey`
// at every call site:
//   - 7+ call sites need the same fallback chain — centralizing
//     avoids drift (one site forgets to trim, one forgets to handle
//     null, etc.)
//   - Tests can mock the helper instead of stubbing app.secretStorage
//     in every fixture
//   - Future migrations (e.g. per-provider secretIds) only need to
//     touch this one file

import type { ProviderSecretStorage } from './provider-secret-store';

/**
 * Minimal settings shape the resolver needs. Avoids pulling the full
 * LLMWikiSettings type so the helper can be reused by callers that
 * only know the relevant subset (tests, isolated modules).
 */
export interface ApiKeySettings {
  apiKey: string;
  providerApiKeySecretId: string;
}

/**
 * Resolve the effective provider API key.
 *
 * Order:
 *   1. pendingKey (optional in-memory buffer). When the user types a new key
 *      into the Settings UI, `tab.tempSettings.apiKey` holds the pending
 *      value until `hide()` flushes it to SecretStorage. Callers that want
 *      to honor a freshly-typed key immediately (e.g. "Fetch Models" /
 *      "Test Connection" buttons) pass it as the 3rd argument so the
 *      user's intent isn't silently overridden by the stale SecretStorage
 *      value left over from the previously-active provider. A
 *      whitespace-only or undefined pendingKey falls through.
 *   2. SecretStorage.getSecret(providerApiKeySecretId) — trimmed,
 *      non-empty → returned as-is.
 *   3. settings.apiKey.trim() — legacy plaintext fallback. After
 *      the v1.25.3 migration this is normally '' but tests and
 *      un-migrated installs still rely on this path.
 *   4. '' — all sources empty; caller treats as "no key configured".
 *
 * @param settings - the LLMWikiSettings-like object (only `apiKey` and
 *   `providerApiKeySecretId` are read).
 * @param secretStorage - the live Obsidian SecretStorage, or null in
 *   environments where it's not available (some unit tests, server-side
 *   fixtures). When null, only the settings.apiKey fallback is used.
 * @param pendingKey - optional in-memory buffer (Settings UI's
 *   `tempSettings.apiKey`). When non-empty (after trim) it wins over
 *   both SecretStorage and settings.apiKey. Pass `undefined` to skip
 *   this tier entirely (backward compatible with pre-#v1.25.7 callers).
 */
export function resolveProviderApiKey(
  settings: ApiKeySettings,
  secretStorage: ProviderSecretStorage | null,
  pendingKey?: string,
): string {
  const pending = pendingKey?.trim();
  if (pending) return pending;
  if (secretStorage !== null) {
    try {
      const raw = secretStorage.getSecret(settings.providerApiKeySecretId);
      if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed.length > 0) return trimmed;
      }
    } catch {
      // Obsidian's SecretStorage can throw on rare platform errors
      // (locked keychain, denied permission). Fall through to the
      // settings.apiKey fallback so the plugin keeps working in a
      // degraded mode rather than crashing loadSettings.
    }
  }
  return (settings.apiKey ?? '').trim();
}

/**
 * Resolve the initial value for the Settings UI's API Key input field.
 *
 * Same precedence as `resolveProviderApiKey` minus the legacy plaintext
 * tier — the Settings UI must NEVER paint the persisted plaintext
 * fallback (it would be a surprise to users who already migrated to
 * SecretStorage). The fallback is `''`, so the input starts blank when
 * nothing is configured.
 *
 * Used by `provider-section.ts` so the input's `setValue` honors the
 * user's freshly-typed key across `tab.display()` re-renders. Without
 * this precedence swap, every Fetch Models / Test Connection / provider
 * dropdown change would clobber the typed value with the stale
 * SecretStorage key from the previously-active provider.
 *
 * @param tempSettings - the Settings UI's in-memory buffer
 *   (typically `tab.tempSettings`). Only `apiKey` and
 *   `providerApiKeySecretId` are read.
 * @param secretStorage - the live Obsidian SecretStorage, or null.
 * @returns the trimmed key to paint into the input, or '' when nothing
 *   is configured.
 */
export function resolveInitialApiKey(
  tempSettings: { apiKey: string; providerApiKeySecretId: string },
  secretStorage: ProviderSecretStorage | null,
): string {
  const pending = tempSettings.apiKey.trim();
  if (pending.length > 0) return pending;
  if (secretStorage === null) return '';
  try {
    const raw = secretStorage.getSecret(tempSettings.providerApiKeySecretId);
    return typeof raw === 'string' ? raw.trim() : '';
  } catch {
    return '';
  }
}