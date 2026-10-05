// The externals and esbuild options the plugin build (esbuild.config.mjs) and
// the tests that bundle src modules share, so a test bundles the way the
// plugin does.
import builtins from "builtin-modules";

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

/** Everything the plugin build sets except entry point, output, banner and minification. */
export function sharedBuildOptions() {
  return {
    bundle: true,
    external: [...EXTERNALS],
    format: "cjs",
    target: "es2022",
    platform: "browser",
  };
}
