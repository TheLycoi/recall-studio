// Run with: npm test. Bundles src/upstream/host.ts, which builds upstream's
// engine from WikiLM's settings, through the same esbuild options the plugin
// build uses. `obsidian` is replaced by the stub test/upstreamVendor.test.mjs
// uses: every value name in obsidian.d.ts as a plain function. The engine is
// built against a fake vault that records every write, and a fake plugin
// whose backends are never called.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sharedBuildOptions } from "../scripts/esbuild-shared.mjs";
import { memoryVault } from "./memoryVault.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function obsidianStub() {
  const dts = readFileSync(path.join(ROOT, "node_modules/obsidian/obsidian.d.ts"), "utf8");
  const names = new Set();
  const decl = /^export (?:declare )?(?:abstract )?(?:class|function|const|let|var|enum) (\w+)/gm;
  for (const m of dts.matchAll(decl)) names.add(m[1]);
  return {
    name: "obsidian-stub",
    setup(b) {
      b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: [...names].map((n) => `export function ${n}() {}`).join("\n"),
        loader: "js",
      }));
    },
  };
}

let h;
let dir;
before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "wikilm-upstream-host-"));
  const out = path.join(dir, "host.cjs");
  const shared = sharedBuildOptions();
  await build({
    ...shared,
    // Upstream's defaults ride along from the facade, in the same module graph.
    stdin: {
      contents: [
        'export * from "./src/upstream/host.ts";',
        'export { UPSTREAM_DEFAULT_SETTINGS } from "./src/upstream/vendor.ts";',
        // For the in-memory vault: its files are made from the bundle's own TFile.
        'export { TFile, TFolder } from "obsidian";',
      ].join("\n"),
      resolveDir: ROOT,
      sourcefile: "upstream-host-probe.ts",
      loader: "ts",
    },
    outfile: out,
    logLevel: "error",
    external: shared.external.filter((e) => e !== "obsidian"),
    plugins: [obsidianStub(), ...shared.plugins],
  });
  h = createRequire(import.meta.url)(out);
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** The WikiLM settings the host reads, as the reader's vault has them. */
function wikilmSettings(over = {}) {
  return {
    provider: "claudecli",
    model: "claude-api-model",
    geminiModel: "gemini-default",
    codexModel: "codex-default",
    claudeCliModel: "sonnet",
    rolesEnabled: false,
    roles: {
      digest: { provider: "default", model: "" },
      query: { provider: "default", model: "" },
      lint: { provider: "default", model: "" },
    },
    effort: "high",
    topicFolder: "wiki",
    schemaFolder: "wiki/schema",
    wikiConceptsFolder: "wiki/concepts",
    wikiEntitiesFolder: "wiki/entities",
    ...over,
  };
}

/** A vault and file manager that answer reads with nothing and record every call that would change a file. */
function fakeVault() {
  const writes = [];
  const record = (name) => async (...args) => {
    writes.push([name, args[0]?.path ?? args[0]]);
  };
  return {
    writes,
    fileManager: {
      renameFile: record("fileManager.renameFile"),
      trashFile: record("fileManager.trashFile"),
      processFrontMatter: record("fileManager.processFrontMatter"),
    },
    vault: {
      configDir: ".obsidian",
      getName: () => "test",
      getMarkdownFiles: () => [],
      getFiles: () => [],
      getAbstractFileByPath: () => null,
      read: async () => "",
      cachedRead: async () => "",
      create: record("create"),
      createFolder: record("createFolder"),
      modify: record("modify"),
      process: record("process"),
      append: record("append"),
      delete: record("delete"),
      trash: record("trash"),
      rename: record("rename"),
      adapter: {
        exists: async () => false,
        read: async () => "",
        write: record("adapter.write"),
        mkdir: record("adapter.mkdir"),
        remove: record("adapter.remove"),
        append: record("adapter.append"),
      },
    },
  };
}

function fakePlugin(settings = wikilmSettings()) {
  const { vault, fileManager, writes } = fakeVault();
  const backend = {
    name: "claudecli",
    async completeText() {
      throw new Error("no model call is expected in this test");
    },
  };
  return {
    writes,
    plugin: {
      app: { vault, fileManager, metadataCache: { getFileCache: () => null }, workspace: {} },
      manifest: { id: "wikilm", dir: ".obsidian/plugins/wikilm" },
      settings,
      llm: { backendFor: () => backend },
    },
  };
}

// Every flag in upstream's settings that lets it write without the reader
// asking, with the value that keeps it from doing so.
const UNATTENDED_OFF = {
  autoWatchSources: false,
  autoWatchMode: "notify",
  watchedFolders: [],
  periodicLint: "off",
  startupCheck: false,
  startupCheckNoticeLevel: "silent",
  autoSmartFix: false,
  createWelcomeNote: false,
  writePdfMarkdownToVault: false,
  markdownConversionBackend: "native",
  // Upstream's PDF converter (pdf-converter.ts) builds a file part only for a
  // provider in its native-PDF list, or when forced. "wikilm" is in no such
  // list, so the converter refuses before it writes to its cache.
  forcePdfSupport: false,
  provider: "wikilm",
  // Not unattended, but a page written that the reader did not ask for: Fix
  // dead links and Smart Fix All create a stub page for each link they cannot
  // match, and upstream counts every link into a PDF as dead (scanners.ts).
  createStubsForUnresolvableLinks: false,
};

test("upstreamSettings turns off every unattended write, whatever the input carries", () => {
  // A WikiLM data.json never holds these keys, but if one ever did (a merge
  // of the two plugins' settings, a hand edit) it must not reach upstream.
  const hostile = wikilmSettings({
    autoWatchSources: true,
    autoWatchMode: "auto",
    watchedFolders: ["/"],
    periodicLint: "daily",
    startupCheck: true,
    startupCheckNoticeLevel: "visible",
    autoSmartFix: true,
    createWelcomeNote: true,
    writePdfMarkdownToVault: true,
    markdownConversionBackend: "mineru",
    forcePdfSupport: true,
    createStubsForUnresolvableLinks: true,
  });
  // WikiLM's own `provider` key shares upstream's name; "anthropic" is one of
  // upstream's native-PDF providers, so it must not pass through.
  const pdfProvider = wikilmSettings({ provider: "anthropic" });
  for (const input of [wikilmSettings(), hostile, wikilmSettings({ rolesEnabled: true }), pdfProvider]) {
    const out = h.upstreamSettings(input);
    for (const [key, value] of Object.entries(UNATTENDED_OFF)) {
      assert.deepEqual(out[key], value, `${key} is ${JSON.stringify(value)}`);
    }
    assert.equal(out.language, "en");
  }
});

test("upstreamSettings starts from upstream's defaults and does not share their arrays", () => {
  const out = h.upstreamSettings(wikilmSettings());
  for (const key of Object.keys(h.UPSTREAM_DEFAULT_SETTINGS)) {
    assert.ok(key in out, `${key} is present`);
  }
  assert.notEqual(out.watchedFolders, h.UPSTREAM_DEFAULT_SETTINGS.watchedFolders);
  assert.notEqual(out.queryHistory, h.UPSTREAM_DEFAULT_SETTINGS.queryHistory);
});

test("the wiki folder is the parent of WikiLM's concepts folder", () => {
  assert.equal(h.upstreamSettings(wikilmSettings()).wikiFolder, "wiki");
  assert.equal(h.upstreamSettings(wikilmSettings({ wikiConceptsFolder: "Notes/Wiki/concepts/" })).wikiFolder, "Notes/Wiki");
  assert.equal(h.upstreamSettings(wikilmSettings({ wikiConceptsFolder: "  kb/concepts  " })).wikiFolder, "kb");
});

// Upstream builds every path as `${wikiFolder}/entities/...`, so an empty
// wiki folder would give paths no vault file has.
test("a concepts folder at the vault root falls back to upstream's own default wiki folder", () => {
  assert.equal(h.upstreamSettings(wikilmSettings({ wikiConceptsFolder: "concepts" })).wikiFolder, "wiki");
  assert.equal(h.upstreamSettings(wikilmSettings({ wikiConceptsFolder: "" })).wikiFolder, "wiki");
});

test("upstream's per-task model names carry the models WikiLM's roles resolve to", () => {
  const out = h.upstreamSettings(
    wikilmSettings({
      rolesEnabled: true,
      roles: {
        digest: { provider: "codex", model: "gpt-5.5" },
        query: { provider: "gemini", model: "" },
        lint: { provider: "default", model: "" },
      },
    }),
  );
  assert.equal(out.model, "gpt-5.5");
  assert.equal(out.ingestModel, "gpt-5.5");
  assert.equal(out.queryModel, "gemini-default");
  assert.equal(out.lintModel, "sonnet");
});

test("the host builds nothing until asked, and a second engine() call returns the same instance", () => {
  const { plugin: real, writes } = fakePlugin();
  // Every property of the plugin the host reads, in order.
  const read = [];
  const plugin = new Proxy(real, {
    get(target, key, receiver) {
      read.push(String(key));
      return Reflect.get(target, key, receiver);
    },
  });
  const host = new h.UpstreamHost(plugin);
  assert.deepEqual(read, [], "constructing the host reads nothing from the plugin: no app, no settings, no backends");
  const first = host.engine();
  assert.ok(read.includes("app") && read.includes("settings"), `the first engine() call is what reads them: ${read.join(", ")}`);
  const second = host.engine();
  assert.equal(second, first);
  assert.equal(first.settings.wikiFolder, "wiki");
  assert.deepEqual(writes, [], "building the engine wrote nothing to the vault");
});

test("the engine and its schema manager are built on the guarded vault, not on the plugin's own", () => {
  const { plugin } = fakePlugin();
  const host = new h.UpstreamHost(plugin);
  const engine = host.engine();
  assert.notEqual(engine.app, plugin.app);
  assert.equal(engine.app, host.guard.app);
  assert.equal(engine.schemaManager.app, host.guard.app);
  assert.notEqual(engine.app.vault, plugin.app.vault);
});

test("a settings change reaches the same engine; a moved wiki folder builds a new one", () => {
  const { plugin, writes } = fakePlugin();
  const host = new h.UpstreamHost(plugin);
  const first = host.engine();
  plugin.settings = wikilmSettings({ claudeCliModel: "opus" });
  const same = host.engine();
  assert.equal(same, first);
  assert.equal(same.settings.model, "opus");
  plugin.settings = wikilmSettings({ wikiConceptsFolder: "kb/concepts" });
  const moved = host.engine();
  assert.notEqual(moved, first);
  assert.equal(moved.settings.wikiFolder, "kb");
  assert.deepEqual(writes, []);
});

test("the host offers no client for the parked retrieval task", () => {
  const { plugin } = fakePlugin();
  const host = new h.UpstreamHost(plugin);
  assert.equal(host.queryClient, undefined);
  assert.equal(host.seedClient, undefined);
});

test("dispose drops the engine, so the next engine() call builds afresh", () => {
  const { plugin } = fakePlugin();
  const host = new h.UpstreamHost(plugin);
  const first = host.engine();
  host.dispose();
  assert.notEqual(host.engine(), first);
});

test("with concepts at Notes/concepts, the reader's own Notes/index.md is saved and loss-checked; upstream's own index and log are not", async () => {
  const mine = "# My notes\n\n## Courses\n- [[BIO 101]]\n";
  const engineIndex = "# Wiki Index\n\n> Auto-generated.\n\n## Concepts\n";
  const { plugin } = fakePlugin(wikilmSettings({ wikiConceptsFolder: "Notes/concepts", wikiEntitiesFolder: "Notes/entities" }));
  const { app, files } = memoryVault({ "Notes/index.md": mine }, h);
  plugin.app = { ...app, workspace: {} };
  const host = new h.UpstreamHost(plugin);
  assert.equal(host.engine().settings.wikiFolder, "Notes");
  assert.ok(!host.rewrittenEachRun("Notes/index.md", mine), "a reader's index is not upstream's to rewrite unchecked");
  assert.ok(host.rewrittenEachRun("Notes/index.md", engineIndex));
  assert.ok(host.rewrittenEachRun("Notes/log.md", "<!-- llm-wiki-log-header-start -->\n# Wiki Log\n"));
  assert.ok(!host.rewrittenEachRun("Notes/concepts/index.md", engineIndex), "only the wiki folder's own index");

  const guard = host.guard;
  guard.begin("Notes");
  await guard.app.vault.adapter.write("Notes/index.md", engineIndex);
  assert.equal(files.get("Notes/index.md"), mine, "the heading-dropping rewrite is refused");
  assert.equal(files.get(`${guard.runFolder}/Notes/index.md`), mine, "and the reader's index is saved under the plugin folder");
  assert.match(guard.runFolder, /^\.obsidian\/plugins\/wikilm\/snapshots\//);
  assert.deepEqual(guard.refusals.map((r) => r.path), ["Notes/index.md"]);

  // Once upstream's own index is there, it is rebuilt each run without a snapshot.
  files.set("Notes/index.md", engineIndex);
  guard.begin("Notes");
  await guard.app.vault.adapter.write("Notes/index.md", "# Wiki Index\n\n> Auto-generated.\n\n## Entities\n");
  assert.equal(files.get("Notes/index.md"), "# Wiki Index\n\n> Auto-generated.\n\n## Entities\n");
  assert.equal(guard.runFolder, null);
  assert.deepEqual(guard.refusals, []);
});
