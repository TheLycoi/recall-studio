// npm run vendor:types — emits TypeScript declarations for the vendored
// obsidian-llm-wiki source into .types/llm-wiki (git-ignored), using upstream's
// own pinned TypeScript and tsconfig (via tsconfig.llm-wiki-types.json).
// WikiLM's root tsconfig maps `@llm-wiki/*` to these declarations, so WikiLM's
// stricter, newer compiler reads upstream's types without checking upstream's
// source. Run it after `npm ci` and whenever vendor/llm-wiki changes;
// `npm run build` refuses to typecheck until it has (scripts/vendor-types-guard.mjs).
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DECLARATIONS_PATHS, ROOT, runOrExit, VENDOR_CI, VENDOR_ROOT } from "./vendor-common.mjs";
import { rewriteZodSpecifiers, vendorFingerprint, writeStamp } from "./vendor-stamp.mjs";

const OUT = DECLARATIONS_PATHS.typesDir;

function readVersion(pkgJson) {
  return existsSync(pkgJson) ? JSON.parse(readFileSync(pkgJson, "utf8")).version : null;
}

// Install upstream's dependencies unless its pinned TypeScript is already there.
const pinned = JSON.parse(readFileSync(path.join(VENDOR_ROOT, "package.json"), "utf8")).devDependencies.typescript;
const installed = readVersion(path.join(VENDOR_ROOT, "node_modules", "typescript", "package.json"));
if (installed !== pinned) runOrExit("vendor:types", ...VENDOR_CI, VENDOR_ROOT);

// Fingerprint the input before compiling it, so the stamp describes what tsc read.
const stamp = vendorFingerprint(DECLARATIONS_PATHS);

// A stale declaration for a file upstream has since removed would otherwise
// linger and still resolve.
rmSync(OUT, { recursive: true, force: true });
runOrExit("vendor:types", "npx", ["--no", "--", "tsc", "-p", path.join(ROOT, "tsconfig.llm-wiki-types.json")], VENDOR_ROOT);

// The bundle gives vendored code zod 3 from the root package's `zod/v3`
// (scripts/esbuild-shared.mjs); make the declarations say the same.
let rewritten = 0;
for (const e of readdirSync(OUT, { recursive: true, withFileTypes: true })) {
  if (!e.isFile() || !e.name.endsWith(".d.ts")) continue;
  const file = path.join(e.parentPath, e.name);
  const before = readFileSync(file, "utf8");
  const after = rewriteZodSpecifiers(before);
  if (after !== before) {
    writeFileSync(file, after);
    rewritten++;
  }
}

// Written last: a run cut short leaves no stamp, and the build guard reports it.
writeStamp(OUT, stamp);
console.log(
  `\n[vendor:types] declarations for ${stamp.upstreamVersion} written to ${path.relative(ROOT, OUT)} with TypeScript ${pinned}` +
    ` (zod imports pointed at zod/v3 in ${rewritten} files)`,
);
