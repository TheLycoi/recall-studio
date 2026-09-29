// Runs first in `npm run build`, before the typecheck. WikiLM's tsc reads the
// vendored obsidian-llm-wiki through declarations in .types/llm-wiki, which
// are git-ignored and made by `npm run vendor:types`. When they are missing,
// tsc would only say "TS2307: Cannot find module '@llm-wiki/...'"; when they
// are stale, it would check WikiLM against the wrong upstream. This says which
// and what to run, then stops the build.
import { checkDeclarations } from "./vendor-stamp.mjs";
import { DECLARATIONS_PATHS } from "./vendor-common.mjs";

const r = checkDeclarations(DECLARATIONS_PATHS);
if (r.status !== "current") {
  console.error(`\n[build] ${r.message}\n`);
  process.exit(1);
}
