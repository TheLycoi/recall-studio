/**
 * Upstream's wiki engine, built from WikiLM's settings and run on WikiLM's
 * model backends.
 *
 * The host constructs obsidian-llm-wiki's `WikiEngine` and `SchemaManager`
 * and nothing else of upstream's plugin: no `AutoMaintainManager` (its file
 * watcher, scheduled lint and startup fixes all write to the vault without
 * the reader asking), no settings tab, no views, no commands. Building the
 * engine writes nothing; the first write happens when the reader starts an
 * ingest, which creates the wiki folders and upstream's schema note if they
 * are missing (WikiEngine.ensureWikiStructure).
 */
import type { ProviderName } from "../backend";
import type WikiLmPlugin from "../main";
import { resolveRole } from "../modelRoles";
import type { WikiLmSettings } from "../settings";
import { createUpstreamClient } from "./llmAdapter";
import { SchemaManager, UPSTREAM_DEFAULT_SETTINGS, WikiEngine, type LLMWikiSettings, type UpstreamLLMClient } from "./vendor";

/**
 * Upstream's single wiki folder, from WikiLM's concepts folder: its parent.
 * Upstream derives `concepts/`, `entities/` and `sources/` under that one
 * folder, so WikiLM's separate entities folder is not consulted. A concepts
 * folder at the vault root has no parent; upstream's own default, "wiki", is
 * used then, because upstream builds every path as `${wikiFolder}/...` and an
 * empty folder would give paths no vault file has.
 */
export function upstreamWikiFolder(conceptsFolder: string): string {
  const clean = conceptsFolder.trim().replace(/\/+$/, "");
  const cut = clean.lastIndexOf("/");
  const parent = cut > 0 ? clean.slice(0, cut) : "";
  return parent || UPSTREAM_DEFAULT_SETTINGS.wikiFolder;
}

/**
 * Upstream's settings for WikiLM's reader. Pure. Starts from upstream's
 * defaults and sets only what WikiLM decides; nothing is copied from the
 * input except the wiki folder and the role models, so an upstream key that
 * found its way into WikiLM's settings cannot switch anything on.
 */
export function upstreamSettings(s: WikiLmSettings): LLMWikiSettings {
  const digest = resolveRole(s, "digest").model;
  return {
    ...UPSTREAM_DEFAULT_SETTINGS,
    // Upstream's defaults hold arrays; copies, so nothing upstream does to
    // one of them reaches the shared default.
    availableModels: [],
    openAICodexModels: [],
    queryHistory: [],

    wikiFolder: upstreamWikiFolder(s.wikiConceptsFolder),
    language: "en",

    // Not one of upstream's providers. The adapter (src/upstream/llmAdapter.ts)
    // serves every model call, and a provider outside upstream's native-PDF
    // list makes its PDF converter refuse before it builds a file part the
    // backends could not send. No key is stored.
    provider: "wikilm",
    apiKey: "",
    // The adapter picks the model from WikiLM's roles and ignores these;
    // upstream writes `model` into its ingest log, so it names the real one.
    model: digest,
    ingestModel: digest,
    queryModel: resolveRole(s, "query").model,
    lintModel: resolveRole(s, "lint").model,

    // Every write upstream can make without the reader asking, off. The
    // host never builds AutoMaintainManager, which is what reads the first
    // six; they are set anyway so the settings say what the host does.
    autoWatchSources: false,
    autoWatchMode: "notify",
    watchedFolders: [],
    periodicLint: "off",
    startupCheck: false,
    startupCheckNoticeLevel: "silent",
    createWelcomeNote: false,
    // Read by upstream's lint controller: a lint never applies fixes by itself.
    autoSmartFix: false,
    // Read by the engine's PDF path: no Markdown copy beside a source PDF, and
    // no upload to MinerU's online converter.
    writePdfMarkdownToVault: false,
    markdownConversionBackend: "native",
    forcePdfSupport: false,
  };
}

interface Built {
  engine: WikiEngine;
  schema: SchemaManager;
  settings: LLMWikiSettings;
}

/**
 * Owns one upstream engine for the plugin's lifetime, built on first use.
 *
 * Each `engine()` call brings the engine up to date with WikiLM's settings:
 * the same instance takes new settings in place, and a moved wiki folder
 * builds a new engine, because its index, log and graph helpers keep the
 * folder they were built with. A running ingest is never touched.
 */
export class UpstreamHost {
  private built: Built | null = null;
  private readonly ingestClient: UpstreamLLMClient;
  private readonly seedClient: UpstreamLLMClient;

  constructor(private readonly plugin: WikiLmPlugin) {
    const settings = () => plugin.settings;
    const backends = (provider: ProviderName) => plugin.llm.backendFor(provider);
    this.ingestClient = createUpstreamClient(settings, backends);
    this.seedClient = createUpstreamClient(settings, backends, { untagged: "query" });
  }

  engine(): WikiEngine {
    const b = this.built;
    if (b?.engine.isIngesting()) return b.engine;
    const next = upstreamSettings(this.plugin.settings);
    if (b && b.settings.wikiFolder === next.wikiFolder) {
      if (JSON.stringify(b.settings) !== JSON.stringify(next)) {
        b.engine.updateSettings(next);
        b.schema.updateSettings(next);
        b.settings = next;
      }
      return b.engine;
    }
    const getClient = () => this.ingestClient;
    const schema = new SchemaManager(this.plugin.app, next, getClient);
    // The fifth argument is upstream's write hook, which its own plugin wires
    // to AutoMaintainManager.watchWrite. There is no watcher here.
    const engine = new WikiEngine(this.plugin.app, next, getClient, schema, () => {});
    this.built = { engine, schema, settings: next };
    return engine;
  }

  /**
   * A client for upstream's seed selection (`selectPprSeeds`), whose model
   * calls carry no task label: they run on WikiLM's query role.
   */
  queryClient(): UpstreamLLMClient {
    return this.seedClient;
  }

  /** Stops a running ingest and drops the engine; the next `engine()` call builds afresh. */
  dispose(): void {
    const b = this.built;
    this.built = null;
    if (b?.engine.isIngesting()) b.engine.cancelIngestion();
  }
}
