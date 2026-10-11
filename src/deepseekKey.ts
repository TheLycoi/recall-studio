import { execFileSync } from "child_process";

/**
 * The DeepSeek API key, resolved in order: the plugin setting, the
 * DEEPSEEK_API_KEY environment variable, then the macOS keychain under two
 * service names.
 *
 * The keychain matters because this vault syncs through iCloud: a key typed
 * into the settings tab lands in data.json and is replicated in plaintext to
 * every device and backup. A key kept in the keychain never touches the vault.
 *
 * A key value is never logged or included in an error message.
 *
 * Pure enough to unit-test: `readKeychain` is injected, so the test never
 * touches `security` (test/deepseek.test.mjs bundles this file standalone).
 */
export const KEYCHAIN_SERVICES = ["Recall DeepSeek API key", "DEEPSEEK_API_KEY"];

export type KeySource = "settings" | "environment" | "keychain" | "none";

/** Runs `security find-generic-password -s <service> -w`; undefined when there is no such item. */
export function readKeychain(service: string): string | undefined {
  if (typeof process === "undefined" || process.platform !== "darwin") return undefined;
  try {
    const out = execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

let cache: { value: string; at: number } | null = null;
const CACHE_MS = 5 * 60 * 1000;

/** Forget the cached keychain value; called when the reader changes the key. */
export function forgetCachedKey(): void {
  cache = null;
}

/**
 * Resolve the key. `env` and `lookup` are injectable so the test can drive
 * every branch without a keychain or an environment variable.
 */
export function resolveDeepSeekKey(
  settingsKey: string,
  env: NodeJS.ProcessEnv = typeof process !== "undefined" ? process.env : {},
  lookup: (service: string) => string | undefined = readKeychain,
  now: number = Date.now(),
): { key: string; source: KeySource } {
  if (settingsKey.trim()) return { key: settingsKey.trim(), source: "settings" };
  const fromEnv = env.DEEPSEEK_API_KEY;
  if (fromEnv && fromEnv.trim()) return { key: fromEnv.trim(), source: "environment" };
  if (cache && now - cache.at < CACHE_MS) return { key: cache.value, source: "keychain" };
  for (const s of KEYCHAIN_SERVICES) {
    const v = lookup(s);
    if (v && v.trim()) {
      cache = { value: v.trim(), at: now };
      return { key: v.trim(), source: "keychain" };
    }
  }
  return { key: "", source: "none" };
}
