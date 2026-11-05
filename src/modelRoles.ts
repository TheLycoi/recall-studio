/**
 * The Codex models the settings dropdown offers.
 *
 * Pure: no `obsidian` import (test/modelRoles.test.mjs bundles it standalone).
 */

import type { RecallSettings } from "./settings";

/** Strong retains the existing main model; Cheap never borrows another provider's override. */
export function agentRoute(settings: RecallSettings, role: "strong" | "cheap") {
  const model = settings.provider === "deepseek" ? settings.deepseekModel : settings.provider === "opencode" ? settings.opencodeModel : settings.codexModel;
  const cheap = settings.modelMode === "split" && role === "cheap";
  return {
    model: cheap ? settings.cheapModels?.[settings.provider]?.trim() || model : model,
    effort: cheap ? settings.cheapEffort ?? settings.effort : settings.effort,
  };
}

/** Codex without its cache: the slugs the settings text names. */
export const CODEX_FALLBACK_MODELS = ["gpt-5.5", "gpt-5.6-luna", "gpt-5.6-terra"];

/** The dropdown's entries: what the last Test found, the value in use, and the known names, in that order, once each. */
export function modelOptions(known: string[] | undefined, current: string, fallback: string[] = []): string[] {
  const out: string[] = [];
  for (const m of [...(known ?? []), current, ...fallback]) {
    const v = m.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Model slugs from Codex's `~/.codex/models_cache.json`, or nothing when it cannot be read. */
export function readCodexModels(cacheJson: string | null): string[] {
  if (!cacheJson) return [];
  try {
    const data = JSON.parse(cacheJson) as { models?: unknown };
    const models = Array.isArray(data?.models) ? (data.models as Array<Record<string, unknown>>) : [];
    return models.map((m) => (typeof m?.slug === "string" ? m.slug : "")).filter(Boolean);
  } catch {
    return [];
  }
}
