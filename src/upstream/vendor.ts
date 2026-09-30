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
// What upstream's folder ingest (main-commands/ingest-commands.ts) decides
// before it calls the engine: which files count as sources, and which already
// have their sources/ page. A file inside the wiki folder or the config folder
// is never offered as a source by upstream's pickers (isExcludedFromSourcePicker).
export { COMPATIBLE_SOURCE_EXTENSIONS as UPSTREAM_SOURCE_EXTENSIONS } from "@llm-wiki/constants";
export { isExcludedFromSourcePicker, isInFolderScope } from "@llm-wiki/core/folder-scope";
export { pageBelongsToNote } from "@llm-wiki/core/ingest-state";
export { slugify } from "@llm-wiki/core/slug";
// Upstream's lint: the scan, its report modal (LintReportModal, which the
// controller opens itself) and every fix runner behind the modal's buttons.
export { runLintWiki } from "@llm-wiki/wiki/lint/controller";

export type {
  LLMWikiSettings,
  LLMClient as UpstreamLLMClient,
  LLMFinishReason as UpstreamFinishReason,
  IngestReport,
  IngestOptions,
} from "@llm-wiki/types";
export type { LintContext } from "@llm-wiki/wiki/lint/controller";
export type { SchemaTask } from "@llm-wiki/schema/schema-manager";

/** The upstream release vendored under vendor/llm-wiki, read from its manifest at build time. */
export const UPSTREAM_VERSION: string = upstreamManifest.version;
