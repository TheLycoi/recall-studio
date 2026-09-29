// esbuild options shared by the plugin build (esbuild.config.mjs) and the tests
// that bundle modules reaching the vendored obsidian-llm-wiki source. Keeping
// them in one place means a test bundles upstream the way the plugin does.
import path from "node:path";
import { fileURLToPath } from "node:url";
import builtins from "builtin-modules";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VENDOR_ROOT = path.join(ROOT, "vendor", "llm-wiki");
const VENDOR_SRC = path.join(VENDOR_ROOT, "src");

// Node built-ins, bare and `node:`-prefixed. builtin-modules already lists the
// prefixed names; adding them again here keeps the prefixed forms external
// whatever that package chooses to list.
const nodeBuiltins = [...new Set([...builtins, ...builtins.filter((m) => !m.startsWith("node:")).map((m) => `node:${m}`)])];

export const EXTERNALS = [
  "obsidian",
  "electron",
  "@codemirror/autocomplete",
  "@codemirror/collab",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/lint",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr",
  ...nodeBuiltins,
];

/**
 * Maps `@llm-wiki/<path>` to `vendor/llm-wiki/src/<path>`, the esbuild half of
 * the alias whose TypeScript half (root tsconfig.json `paths`) points at the
 * declarations `npm run vendor:types` emits.
 *
 * It also resolves every bare import made by a vendored source file from the
 * repository root, not from vendor/llm-wiki/node_modules. That folder exists
 * only after `npm run vendor:check` or `vendor:types` has installed upstream's
 * own dependencies, and without this the bundle would silently pick up a
 * second copy of zod or ai whenever it happened to be there.
 */
export function llmWikiVendorPlugin() {
  return {
    name: "llm-wiki-vendor",
    setup(b) {
      b.onResolve({ filter: /^@llm-wiki\// }, (args) =>
        b.resolve(`./${args.path.slice("@llm-wiki/".length)}`, { kind: args.kind, resolveDir: VENDOR_SRC }),
      );
      b.onResolve({ filter: /^[^./]/ }, (args) => {
        if (args.pluginData?.llmWikiFromRoot) return undefined;
        if (!args.importer.startsWith(VENDOR_SRC + path.sep)) return undefined;
        return b.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: ROOT,
          pluginData: { llmWikiFromRoot: true },
        });
      });
    },
  };
}

/** Everything the plugin build sets except entry point, output, banner and minification. */
export function sharedBuildOptions() {
  return {
    bundle: true,
    external: [...EXTERNALS],
    format: "cjs",
    target: "es2022",
    platform: "browser",
    // Upstream loads `node:module` with `await import(...)` (loopback-flow.ts).
    // Left as a native dynamic import of an external module in the CommonJS
    // bundle Obsidian loads, the renderer tries to fetch it as a URL; upstream's
    // ROADMAP lists a user hitting "Failed to fetch dynamically imported
    // module" at that line (#665, cause unconfirmed there). With this off,
    // esbuild rewrites every `import()` into a lazy `require`, which the
    // plugin's CommonJS context provides.
    supported: { "dynamic-import": false },
    treeShaking: true,
    plugins: [llmWikiVendorPlugin()],
  };
}
