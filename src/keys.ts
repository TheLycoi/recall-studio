import { execFileSync } from "child_process";

/**
 * API key resolution, in order: the plugin setting, an environment variable,
 * then the macOS keychain under two service names.
 *
 * The keychain matters here because the vault may sync: a key typed into the
 * settings tab lands in data.json and is replicated in plaintext to every
 * device and backup. A key kept in the keychain never touches the vault.
 * Carried over from an earlier version of this plugin's key handling.
 *
 * A key value is never logged or included in an error message.
 */
export const KEYCHAIN_SERVICES = ["WikiLM Anthropic API key", "ANTHROPIC_API_KEY"];
export const GEMINI_KEYCHAIN_SERVICES = ["WikiLM Gemini API key", "GEMINI_API_KEY"];

/** One cache entry per provider: a Gemini lookup must not return a cached Anthropic key. */
const cache = new Map<string, { value: string; at: number }>();
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

function resolve(settingsKey: string, envVar: string, services: string[]): { key: string; source: KeySource } {
  if (settingsKey.trim()) return { key: settingsKey.trim(), source: "settings" };
  const env = typeof process !== "undefined" ? process.env[envVar] : undefined;
  if (env) return { key: env, source: "environment" };
  const hit = cache.get(envVar);
  if (hit && Date.now() - hit.at < CACHE_MS) return { key: hit.value, source: "keychain" };
  for (const s of services) {
    const v = readKeychain(s);
    if (v) {
      cache.set(envVar, { value: v, at: Date.now() });
      return { key: v, source: "keychain" };
    }
  }
  return { key: "", source: "none" };
}

export function resolveApiKey(settingsKey: string): { key: string; source: KeySource } {
  return resolve(settingsKey, "ANTHROPIC_API_KEY", KEYCHAIN_SERVICES);
}

export function resolveGeminiKey(settingsKey: string): { key: string; source: KeySource } {
  return resolve(settingsKey, "GEMINI_API_KEY", GEMINI_KEYCHAIN_SERVICES);
}
