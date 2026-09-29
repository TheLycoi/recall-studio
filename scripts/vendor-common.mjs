// Helpers shared by scripts/vendor-check.mjs, vendor-types.mjs and vendor-types-guard.mjs.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const VENDOR_ROOT = path.join(ROOT, "vendor", "llm-wiki");

/**
 * Where vendor:types writes the declarations, and what their stamp covers
 * (scripts/vendor-stamp.mjs): the vendor folder plus the config the root
 * adds on top of upstream's tsconfig.
 */
export const DECLARATIONS_PATHS = {
  vendorRoot: VENDOR_ROOT,
  typesDir: path.join(ROOT, ".types", "llm-wiki"),
  extraFiles: [path.join(ROOT, "tsconfig.llm-wiki-types.json")],
};

// Upstream's package-lock.json was written without peer dependencies (it
// builds with pnpm), so a plain `npm ci` refuses it as out of sync with
// package.json: obsidian's peers @codemirror/state and @codemirror/view are
// missing from the lock. `--legacy-peer-deps` reads the lock the way it was
// written and still installs exactly what it pins, into
// vendor/llm-wiki/node_modules, which upstream's .gitignore ignores.
export const VENDOR_CI = ["npm", ["ci", "--legacy-peer-deps"]];

/** Runs one command, echoing it under `tag`; exits the process on failure. */
export function runOrExit(tag, cmd, args, cwd) {
  const line = `${cmd} ${args.join(" ")}`;
  console.log(`\n[${tag}] ${line}  (in ${path.relative(ROOT, cwd) || "."})`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.error) {
    console.error(`[${tag}] could not run ${line}: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`[${tag}] ${line} failed with exit code ${r.status ?? r.signal}`);
    process.exit(r.status || 1);
  }
}
