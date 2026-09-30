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
 *
 * The engine and its schema manager are built on the guarded view of the
 * vault (src/upstream/guardedVault.ts), never on the plugin's own `app`: an
 * existing page is saved before it is overwritten, a rewrite that would drop
 * the reader's headings, quotes, PDF links, embeds or frontmatter keys is
 * refused, and no existing file is removed or moved.
 */
import type { ProviderName } from "../backend";
import type WikiLmPlugin from "../main";
import { resolveRole, type ModelRole } from "../modelRoles";
import type { WikiLmSettings } from "../settings";
import { WriteGuard } from "./guardedVault";
import { createRoleClient, createUpstreamClient, type BackendLookup } from "./llmAdapter";
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
 *
 * The engine and its schema manager ask for their model client on every
 * call. While a lint operation is open on the engine (upstream's
 * startLintOperation, which its lint takes for the scan and for each fix)
 * they are handed the lint role's client; otherwise the ingest client, which
 * picks the role from upstream's task label.
 */
export class UpstreamHost {
  private built: Built | null = null;
  private writeGuard: WriteGuard | null = null;
  private readonly ingestClient: UpstreamLLMClient;
  private readonly roleClients = new Map<ModelRole, UpstreamLLMClient>();
  private readonly settings: () => WikiLmSettings;
  private readonly backends: BackendLookup;

  constructor(private readonly plugin: WikiLmPlugin) {
    this.settings = () => plugin.settings;
    this.backends = (provider: ProviderName) => plugin.llm.backendFor(provider);
    this.ingestClient = createUpstreamClient(this.settings, this.backends);
  }

  /** A client with every call on `role` (src/modelRoles.ts), one per role, read from the settings at call time. */
  clientFor(role: ModelRole): UpstreamLLMClient {
    let client = this.roleClients.get(role);
    if (!client) {
      client = createRoleClient(this.settings, this.backends, role);
      this.roleClients.set(role, client);
    }
    return client;
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
    // Read when a call is made, after `engine` below is assigned.
    const getClient = () => (engine.isLintRunning() ? this.clientFor("lint") : this.ingestClient);
    const app = this.guard.app;
    const schema = new SchemaManager(app, next, getClient);
    // The fifth argument is upstream's write hook, which its own plugin wires
    // to AutoMaintainManager.watchWrite. There is no watcher here.
    const engine = new WikiEngine(app, next, getClient, schema, () => {});
    this.built = { engine, schema, settings: next };
    return engine;
  }

  /** Upstream's schema manager, the one the current engine was built with. */
  schema(): SchemaManager {
    this.engine();
    return (this.built as Built).schema;
  }

  /**
   * The guard every engine write goes through, built on first use. Its
   * snapshots go under the plugin's own folder, out of the reader's notes.
   */
  get guard(): WriteGuard {
    const p = this.plugin;
    this.writeGuard ??= new WriteGuard(p.app, p.manifest.dir ?? `${p.app.vault.configDir}/plugins/wikilm`, (path) => this.rewrittenEachRun(path));
    return this.writeGuard;
  }

  /**
   * Upstream's index and log, which it writes on every run: the index is
   * rebuilt whole from the pages (engine-internals/index-generator.ts) and
   * the log gains an entry and is trimmed when long (log-writer.ts). They hold
   * no text of the reader's, so they skip the loss check; they are still saved.
   */
  rewrittenEachRun(path: string): boolean {
    const wiki = this.built?.settings.wikiFolder;
    return !!wiki && (path === `${wiki}/index.md` || path === `${wiki}/log.md`);
  }

  /** Stops a running ingest and drops the engine; the next `engine()` call builds afresh. */
  dispose(): void {
    const b = this.built;
    this.built = null;
    if (b?.engine.isIngesting()) b.engine.cancelIngestion();
  }
}
