// Records the provenance of the vendored obsidian-llm-wiki tree.
//
// Usage: node scripts/vendor-manifest.mjs --tag <tag>
//
// Writes vendor/llm-wiki.manifest.json: the upstream repository, the tag and
// commit the tree was imported from, when the manifest was generated, and the
// sha256 of every file under vendor/llm-wiki as it stands on disk. Run it only
// straight after importing or updating the subtree, when the tree is exactly
// upstream's; test/vendorProvenance.test.mjs then holds the tree to it.
//
// The commit is read from the `git-subtree-split:` trailer of the latest
// squash commit for vendor/llm-wiki, so it is always the commit git imported.
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const UPSTREAM = "https://github.com/GD4AI/obsidian-llm-wiki";
export const VENDOR_DIR = "vendor/llm-wiki";
export const MANIFEST_PATH = "vendor/llm-wiki.manifest.json";
export const CHANGES_PATH = "vendor/llm-wiki.CHANGES.md";

/** Upstream's licence files. They must match the manifest and may never be listed as changed. */
export const PROTECTED = ["LICENSE", "NOTICE"];

/** Directories and files that are never part of the tree: installed packages and Finder litter. */
const SKIP_DIRS = new Set(["node_modules"]);
const SKIP_FILES = new Set([".DS_Store"]);

/** `{ "<path relative to root, / separated>": "<sha256 hex>" }` for every file under root, sorted by path. */
export function hashTree(root) {
  const out = {};
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full, rel);
      } else if (!SKIP_FILES.has(entry.name)) {
        out[rel] = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      }
    }
  };
  walk(root, "");
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * The paths listed in the change list's table (columns File, Date, Reason),
 * split into files WikiLM modified or added and files it removed. A row whose
 * Reason starts with "Removed" records a removal.
 */
export function parseChangeList(text) {
  const modified = new Set();
  const removed = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    const file = (cells[0] ?? "").replace(/^`|`$/g, "").trim();
    if (!file || file === "File" || /^:?-+:?$/.test(file)) continue;
    const reason = cells[2] ?? "";
    (/^removed\b/i.test(reason) ? removed : modified).add(file);
  }
  return { modified, removed };
}

/** The marker a modified file must carry at the start of a line, by file kind. */
export function markerFor(rel) {
  return /\.(md|markdown|html?)$/i.test(rel) ? "<!-- Modified by WikiLM on " : "// Modified by WikiLM on ";
}

function hasMarker(rel, text) {
  const marker = markerFor(rel);
  return text.split(/\r?\n/).some((line) => line.startsWith(marker));
}

/**
 * Compares a tree with its manifest and change list. Pure: it is given the
 * hashes and a way to read a file's text. Returns one message per problem,
 * so an empty array means the tree is in order.
 *
 * - A file that is not in the manifest, or whose hash differs, must be listed
 *   as modified, and a listed file must carry the marker line for its kind.
 * - A file in the manifest that is gone must be recorded as removed, and a
 *   file recorded as removed must be gone.
 * - LICENSE and NOTICE must be present, recorded in the manifest, identical to
 *   it, and absent from the change list.
 */
export function checkProvenance({ manifestFiles, actualFiles, changes, readText }) {
  const problems = [];
  for (const name of PROTECTED) {
    if (changes.modified.has(name) || changes.removed.has(name)) {
      problems.push(`${name}: upstream's ${name} may never appear in the change list`);
    }
    if (!(name in manifestFiles)) problems.push(`${name}: not recorded in the manifest`);
    else if (!(name in actualFiles)) problems.push(`${name}: missing from the vendored tree`);
    else if (actualFiles[name] !== manifestFiles[name]) problems.push(`${name}: differs from upstream's ${name}`);
  }
  for (const [rel, sha] of Object.entries(actualFiles)) {
    if (PROTECTED.includes(rel)) continue;
    if (changes.removed.has(rel)) {
      problems.push(`${rel}: recorded as removed in the change list but still present`);
    } else if (changes.modified.has(rel)) {
      if (!hasMarker(rel, readText(rel))) {
        problems.push(`${rel}: listed in the change list but has no line starting "${markerFor(rel)}"`);
      }
    } else if (!(rel in manifestFiles)) {
      problems.push(`${rel}: not in the manifest and not listed in the change list`);
    } else if (sha !== manifestFiles[rel]) {
      problems.push(`${rel}: differs from the manifest and is not listed in the change list`);
    }
  }
  for (const rel of Object.keys(manifestFiles)) {
    if (PROTECTED.includes(rel) || rel in actualFiles) continue;
    if (!changes.removed.has(rel)) problems.push(`${rel}: in the manifest but missing, and its removal is not recorded`);
  }
  for (const rel of changes.modified) {
    if (!PROTECTED.includes(rel) && !(rel in actualFiles)) {
      problems.push(`${rel}: listed as modified in the change list but not present`);
    }
  }
  return problems;
}

/** checkProvenance for the tree on disk at `root`. */
export function checkTree(root, manifest, changesText) {
  return checkProvenance({
    manifestFiles: manifest.files,
    actualFiles: hashTree(root),
    changes: parseChangeList(changesText),
    readText: (rel) => fs.readFileSync(path.join(root, rel), "utf8"),
  });
}

/** The upstream commit of the latest squash import of `prefix`, from its git-subtree-split trailer. */
export function subtreeCommit(prefix = VENDOR_DIR) {
  const log = execFileSync("git", ["log", "-1", "--format=%B", `--grep=^git-subtree-dir: ${prefix}$`], { encoding: "utf8" });
  const match = log.match(/^git-subtree-split: ([0-9a-f]{40})$/m);
  if (!match) throw new Error(`No git-subtree-split trailer found for ${prefix}`);
  return match[1];
}

export function buildManifest({ root = VENDOR_DIR, tag, commit, generated = new Date().toISOString() }) {
  return { upstream: UPSTREAM, tag, commit, generated, files: hashTree(root) };
}

export function writeManifest(tag) {
  const manifest = buildManifest({ tag, commit: subtreeCommit() });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const i = process.argv.indexOf("--tag");
  const tag = i > 0 ? process.argv[i + 1] : undefined;
  if (!tag || !/^[\w.-]+$/.test(tag)) {
    console.error("Usage: node scripts/vendor-manifest.mjs --tag <tag>");
    process.exit(2);
  }
  const manifest = writeManifest(tag);
  console.log(`Wrote ${MANIFEST_PATH}: ${Object.keys(manifest.files).length} files, ${tag} (${manifest.commit})`);
}
