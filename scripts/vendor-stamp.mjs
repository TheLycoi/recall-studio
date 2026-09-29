// The stamp that ties the declarations in .types/llm-wiki to the vendored
// source they were emitted from. `npm run vendor:types` writes it last, after
// tsc succeeds; `npm run build` checks it before its typecheck
// (scripts/vendor-types-guard.mjs). Without it, a vendor bump would leave tsc
// checking WikiLM against old declarations while esbuild bundles new source.
//
// The fingerprint hashes file contents under paths relative to the vendor
// folder, so it does not depend on file times or on where the checkout lives.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const STAMP_NAME = ".vendor-stamp.json";

// Bump when vendor-types.mjs changes what it writes for the same source, so
// declarations made the old way are reported stale. 2: zod imports point at
// zod/v3 (1 was the unstamped output of the first version).
export const DECLARATIONS_FORMAT = 2;

const FIX = "Run `npm run vendor:types`, then build again.";

/** Every .ts file tsc emits declarations from: src/, minus upstream's tests. */
function sourceFiles(srcDir) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "__tests__" && e.name !== "node_modules") walk(p);
      } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
        out.push(p);
      }
    }
  };
  walk(srcDir);
  return out;
}

/**
 * What the declarations for `vendorRoot` would be stamped with now: the
 * vendored manifest version and a SHA-256 over the source list and contents,
 * upstream's tsconfig and package files, and `extraFiles` (the root
 * tsconfig.llm-wiki-types.json).
 */
export function vendorFingerprint({ vendorRoot, extraFiles = [] }) {
  const upstreamVersion = JSON.parse(readFileSync(path.join(vendorRoot, "manifest.json"), "utf8")).version;
  const files = [
    ...sourceFiles(path.join(vendorRoot, "src")),
    ...["tsconfig.json", "package.json", "package-lock.json"].map((f) => path.join(vendorRoot, f)),
    ...extraFiles,
  ];
  const entries = files
    .map((f) => ({ key: path.relative(vendorRoot, f).split(path.sep).join("/"), file: f }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const hash = createHash("sha256");
  for (const { key, file } of entries) {
    hash.update(key).update("\0");
    hash.update(existsSync(file) ? readFileSync(file) : "(absent)").update("\0");
  }
  return { format: DECLARATIONS_FORMAT, upstreamVersion, sourceHash: hash.digest("hex") };
}

export function writeStamp(typesDir, stamp) {
  writeFileSync(path.join(typesDir, STAMP_NAME), JSON.stringify(stamp, null, 2) + "\n");
}

/**
 * Decides whether the declarations in `typesDir` can be used for `vendorRoot`
 * as it is now. Returns `{ status: "current" | "missing" | "stale", message }`;
 * the message for the last two names the one command that fixes it.
 */
export function checkDeclarations({ vendorRoot, typesDir, extraFiles = [] }) {
  const now = vendorFingerprint({ vendorRoot, extraFiles });
  if (!existsSync(typesDir)) {
    return {
      status: "missing",
      message: `The TypeScript declarations for the vendored obsidian-llm-wiki ${now.upstreamVersion} are missing. ${FIX}`,
    };
  }
  let stamp = null;
  try {
    stamp = JSON.parse(readFileSync(path.join(typesDir, STAMP_NAME), "utf8"));
  } catch {
    // No stamp, or an unreadable one: made by an older vendor:types, or cut short.
  }
  if (!stamp || stamp.format !== now.format) {
    return {
      status: "stale",
      message: `The TypeScript declarations for the vendored obsidian-llm-wiki were made by an older version of vendor:types. ${FIX}`,
    };
  }
  if (stamp.upstreamVersion !== now.upstreamVersion || stamp.sourceHash !== now.sourceHash) {
    const what =
      stamp.upstreamVersion !== now.upstreamVersion
        ? `were made for ${stamp.upstreamVersion}, but vendor/llm-wiki is now ${now.upstreamVersion}`
        : `were made before vendor/llm-wiki ${now.upstreamVersion} last changed`;
    return { status: "stale", message: `The TypeScript declarations for the vendored obsidian-llm-wiki ${what}. ${FIX}` };
  }
  return { status: "current", message: `Declarations for the vendored obsidian-llm-wiki ${now.upstreamVersion} are current.` };
}

/**
 * Points every `zod` module specifier in an emitted declaration file at
 * `zod/v3`. Upstream's tsc emits `from 'zod'` against its own zod 3; read by
 * WikiLM's tsc, plain `zod` would be the root zod 4, whose types do not match
 * zod 3's (skipLibCheck would hide the mismatch). The bundle gives vendored
 * code `zod/v3` too (scripts/esbuild-shared.mjs).
 */
export function rewriteZodSpecifiers(text) {
  return text.replace(/(\bfrom\s*|\bimport\s*\(\s*)(['"])zod\2/g, "$1$2zod/v3$2");
}
