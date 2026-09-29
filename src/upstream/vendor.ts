// The one door from WikiLM into the vendored obsidian-llm-wiki source
// (vendor/llm-wiki, Apache-2.0, unmodified). WikiLM code imports upstream only
// from here, so the list below is the whole surface WikiLM depends on.
//
// `@llm-wiki/*` resolves two ways. esbuild bundles it from
// vendor/llm-wiki/src/* (scripts/esbuild-shared.mjs). TypeScript reads it from
// the declarations `npm run vendor:types` emits with upstream's own pinned
// compiler, because upstream's source is not written for WikiLM's strict
// settings or its TypeScript version. Run `npm run vendor:types` once after
// `npm ci` and again whenever vendor/llm-wiki changes.
//
// Vendored code gets zod 3 (scripts/esbuild-shared.mjs); any zod schema WikiLM hands to upstream must be built from `zod/v3`, not WikiLM's own zod 4.
import upstreamManifest from "../../vendor/llm-wiki/manifest.json";

export { WikiEngine } from "@llm-wiki/wiki/wiki-engine";
export { SchemaManager } from "@llm-wiki/schema/schema-manager";
export { DEFAULT_SETTINGS as UPSTREAM_DEFAULT_SETTINGS } from "@llm-wiki/types";
export { selectPprSeeds } from "@llm-wiki/wiki/query-engine/pipeline/select-seeds";
export { loadRelevantPagesForQuery } from "@llm-wiki/wiki/query-engine/pipeline/load-pages";

export type {
  LLMWikiSettings,
  LLMClient as UpstreamLLMClient,
  LLMFinishReason as UpstreamFinishReason,
  IngestReport,
  IngestOptions,
} from "@llm-wiki/types";
export type { SeedSelectionResult } from "@llm-wiki/wiki/query-engine/pipeline/select-seeds";

/** The upstream release vendored under vendor/llm-wiki, read from its manifest at build time. */
export const UPSTREAM_VERSION: string = upstreamManifest.version;
