/**
 * Which provider and model a piece of work runs on.
 *
 * One provider serves everything unless the reader ticks "Use different
 * models for lint, query and digest"; then each of those three roles may
 * name its own provider and model, or say "default" and follow the main
 * choice. Card writing, critique, quizzes and highlighting always follow the
 * main choice: nobody asked for more knobs there.
 *
 * Pure: no `obsidian` import; test/modelRoles.test.mjs bundles it standalone.
 */
import type { ProviderName } from "./backend";

export type ModelRole = "lint" | "query" | "digest";

export interface RoleChoice {
  /** "default" follows the main provider and model. */
  provider: ProviderName | "default";
  /** Empty means the provider's own configured model. */
  model: string;
}

export interface RoleSettings {
  provider: ProviderName;
  model: string;
  geminiModel: string;
  codexModel: string;
  claudeCliModel: string;
  rolesEnabled: boolean;
  roles: Record<ModelRole, RoleChoice>;
}

export const DEFAULT_ROLES: Record<ModelRole, RoleChoice> = {
  lint: { provider: "default", model: "" },
  query: { provider: "default", model: "" },
  digest: { provider: "default", model: "" },
};

/** The model the settings hold for a provider. */
export function providerModel(s: RoleSettings, provider: ProviderName): string {
  switch (provider) {
    case "gemini":
      return s.geminiModel;
    case "codex":
      return s.codexModel;
    case "claudecli":
      return s.claudeCliModel;
    default:
      return s.model;
  }
}

/** The provider and model a role runs on: the role's own when enabled and set, else the main choice. */
export function resolveRole(s: RoleSettings, role: ModelRole | undefined): { provider: ProviderName; model: string } {
  const main = { provider: s.provider, model: providerModel(s, s.provider) };
  if (!role || !s.rolesEnabled) return main;
  const choice = s.roles?.[role];
  if (!choice || choice.provider === "default") return main;
  return { provider: choice.provider, model: choice.model.trim() || providerModel(s, choice.provider) };
}

/** Claude Code has no model-listing call; these are the aliases its CLI accepts. */
export const CLAUDE_CLI_MODELS = ["sonnet", "opus", "haiku", "fable"];

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

/** Model ids from Gemini's `GET /v1beta/models`: only those that answer `generateContent`, `models/` prefix dropped. */
export function readGeminiModels(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const models = (body as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  const out: string[] = [];
  for (const m of models as Array<Record<string, unknown>>) {
    const name = typeof m?.name === "string" ? m.name.replace(/^models\//, "") : "";
    const methods = Array.isArray(m?.supportedGenerationMethods) ? (m.supportedGenerationMethods as unknown[]) : [];
    if (name && methods.includes("generateContent")) out.push(name);
  }
  return out;
}
