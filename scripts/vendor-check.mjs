// npm run vendor:check — checks the vendored obsidian-llm-wiki source on its own
// terms: installs upstream's pinned dependencies from its own lockfile,
// typechecks with upstream's TypeScript and tsconfig, builds with upstream's
// esbuild config, and runs upstream's vitest suite. Stops at the first step
// that fails and exits with its code.
//
// No tracked file under vendor/llm-wiki is edited. What gets written there is
// git-ignored by upstream's own .gitignore: node_modules, main.js, and
// tools/dev-instrument/dist (written by one of upstream's tests).
import { runOrExit, VENDOR_CI, VENDOR_ROOT } from "./vendor-common.mjs";

const steps = [
  VENDOR_CI,
  // `--no` stops npx from fetching a package that is not installed locally,
  // so these run upstream's pinned compiler and test runner or fail. The `--`
  // matters: without it npx takes `--noEmit` as an npm option, and tsc then
  // writes a .js file beside every upstream source.
  ["npx", ["--no", "--", "tsc", "--noEmit"]],
  // Upstream's gate builds before it tests (`gate:1` in its package.json), and
  // one of its tests reads the main.js that build writes
  // (openai-codex-loopback-flow.test.ts).
  ["npm", ["run", "build"]],
  ["npx", ["--no", "--", "vitest", "run"]],
];

for (const [cmd, args] of steps) runOrExit("vendor:check", cmd, args, VENDOR_ROOT);
console.log("\n[vendor:check] install, typecheck, build and tests passed");
