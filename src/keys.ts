import { execFileSync } from "child_process";

/**
 * API key resolution, in order: the plugin setting, the ANTHROPIC_API_KEY
 * environment variable, then the macOS keychain under two service names.
 *
 * The keychain matters here because this vault syncs through iCloud: a key
 * typed into the settings tab lands in data.json and is replicated in
 * plaintext to every device and backup. A key kept in the keychain never
 * touches the vault. Carried over from Loopback's key handling.
 *
 * A key value is never logged or included in an error message.
 */
export const KEYCHAIN_SERVICES = ["Recall Anthropic API key", "ANTHROPIC_API_KEY"];

let cache: { value: string; at: number } | null = null;
const CACHE_MS = 5 * 60 * 1000;

function readKeychain(service: string): string | undefined {
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

export type KeySource = "settings" | "environment" | "keychain" | "none";

export function resolveApiKey(settingsKey: string): { key: string; source: KeySource } {
  if (settingsKey.trim()) return { key: settingsKey.trim(), source: "settings" };
  const env = typeof process !== "undefined" ? process.env.ANTHROPIC_API_KEY : undefined;
  if (env) return { key: env, source: "environment" };
  if (cache && Date.now() - cache.at < CACHE_MS) return { key: cache.value, source: "keychain" };
  for (const s of KEYCHAIN_SERVICES) {
    const v = readKeychain(s);
    if (v) {
      cache = { value: v, at: Date.now() };
      return { key: v, source: "keychain" };
    }
  }
  return { key: "", source: "none" };
}

