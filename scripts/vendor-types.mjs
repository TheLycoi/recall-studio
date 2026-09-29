// npm run vendor:types — emits TypeScript declarations for the vendored
// obsidian-llm-wiki source into .types/llm-wiki (git-ignored), using upstream's
// own pinned TypeScript and tsconfig (via tsconfig.llm-wiki-types.json).
// WikiLM's root tsconfig maps `@llm-wiki/*` to these declarations, so WikiLM's
// stricter, newer compiler reads upstream's types without checking upstream's
// source. Run it after `npm ci` and whenever vendor/llm-wiki changes.
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { ROOT, runOrExit, VENDOR_CI, VENDOR_ROOT } from "./vendor-common.mjs";

const OUT = path.join(ROOT, ".types", "llm-wiki");

function readVersion(pkgJson) {
  return existsSync(pkgJson) ? JSON.parse(readFileSync(pkgJson, "utf8")).version : null;
}

// Install upstream's dependencies unless its pinned TypeScript is already there.
const pinned = JSON.parse(readFileSync(path.join(VENDOR_ROOT, "package.json"), "utf8")).devDependencies.typescript;
const installed = readVersion(path.join(VENDOR_ROOT, "node_modules", "typescript", "package.json"));
if (installed !== pinned) runOrExit("vendor:types", ...VENDOR_CI, VENDOR_ROOT);

// A stale declaration for a file upstream has since removed would otherwise
// linger and still resolve.
rmSync(OUT, { recursive: true, force: true });
runOrExit("vendor:types", "npx", ["--no", "--", "tsc", "-p", path.join(ROOT, "tsconfig.llm-wiki-types.json")], VENDOR_ROOT);
console.log(`\n[vendor:types] declarations written to ${path.relative(ROOT, OUT)} with TypeScript ${pinned}`);
