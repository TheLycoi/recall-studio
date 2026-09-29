// Records the provenance of the vendored obsidian-llm-wiki tree.
//
// Usage: node scripts/vendor-manifest.mjs --tag <tag>
//
// Writes vendor/llm-wiki.manifest.json: the upstream repository, the tag, the
// upstream commit, the squash commit it was read from, that commit's date, and
// the sha256 of every file in upstream's tree.
//
// The manifest is taken from git, never from the working tree. `git subtree
// add --squash` and `git subtree pull --squash` each make a squash commit
// whose tree is upstream's tree exactly and whose message ends with the
// trailers `git-subtree-dir: vendor/llm-wiki` and `git-subtree-split: <the
// upstream commit>`. The latest such commit reachable from HEAD is the one
// read. So regenerating the manifest records upstream's bytes whatever the
// working tree holds, and it cannot absorb an edit WikiLM made to a vendored
// file. test/vendorProvenance.test.mjs holds the working tree to it.
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

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

/** Runs git in `cwd` and returns its output. The vendored tree is several megabytes, hence the buffer. */
function git(cwd, args, options = {}) {
  return execFileSync("git", args, { cwd, maxBuffer: 1 << 30, ...options });
}

/** An object with `entries` as its own properties, sorted by key. Every key, `__proto__` included, becomes a file. */
function sortedObject(entries) {
  return Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * `{ "<path relative to root, / separated>": "<sha256 hex>" }` for every file
 * under root, sorted by path. `root` must be inside a git working tree. The
 * files are the ones git lists there: tracked files that are still on disk,
 * plus untracked files that no ignore rule matches. A file that git ignores
 * but tracks is still listed, so no name can hide a file git would commit.
 */
export function hashTree(root) {
  const listed = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."], { encoding: "utf8" });
  const out = new Map();
  for (const rel of new Set(listed.split("\0").filter(Boolean))) {
    const full = path.join(root, rel);
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch (e) {
      if (e.code === "ENOENT") continue; // tracked but deleted: the check reports it missing
      throw e;
    }
    // Git stores a symbolic link as its target, so hash the target the same way.
    if (stat.isSymbolicLink()) out.set(rel, sha256(fs.readlinkSync(full)));
    else if (stat.isFile()) out.set(rel, sha256(fs.readFileSync(full)));
  }
  return sortedObject(out);
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
  // Maps, not `in` on plain objects: a file named `constructor` or `__proto__`
  // must be looked up as a file, not found on Object.prototype.
  const manifest = new Map(Object.entries(manifestFiles));
  const actual = new Map(Object.entries(actualFiles));
  const problems = [];
  for (const name of PROTECTED) {
    if (changes.modified.has(name) || changes.removed.has(name)) {
      problems.push(`${name}: upstream's ${name} may never appear in the change list`);
    }
    if (!manifest.has(name)) problems.push(`${name}: not recorded in the manifest`);
    else if (!actual.has(name)) problems.push(`${name}: missing from the vendored tree`);
    else if (actual.get(name) !== manifest.get(name)) problems.push(`${name}: differs from upstream's ${name}`);
  }
  for (const [rel, sha] of actual) {
    if (PROTECTED.includes(rel)) continue;
    if (changes.removed.has(rel)) {
      problems.push(`${rel}: recorded as removed in the change list but still present`);
    } else if (changes.modified.has(rel)) {
      if (!hasMarker(rel, readText(rel))) {
        problems.push(`${rel}: listed in the change list but has no line starting "${markerFor(rel)}"`);
      }
    } else if (!manifest.has(rel)) {
      problems.push(`${rel}: not in the manifest and not listed in the change list`);
    } else if (sha !== manifest.get(rel)) {
      problems.push(`${rel}: differs from the manifest and is not listed in the change list`);
    }
  }
  for (const rel of manifest.keys()) {
    if (PROTECTED.includes(rel) || actual.has(rel)) continue;
    if (!changes.removed.has(rel)) problems.push(`${rel}: in the manifest but missing, and its removal is not recorded`);
  }
  for (const rel of changes.modified) {
    if (!PROTECTED.includes(rel) && !actual.has(rel)) {
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

/**
 * The latest squash commit for `prefix` reachable from HEAD, and the upstream
 * commit it holds: `{ squash, commit }`.
 *
 * A squash commit carries the trailers `git-subtree-dir: <prefix>` and
 * `git-subtree-split: <upstream commit>`. The merge commit that `git subtree
 * add` makes carries both too, plus `git-subtree-mainline:`, and its split
 * trailer names the squash commit rather than upstream's, so commits with a
 * mainline trailer are passed over. Git parses the trailers itself.
 */
export function subtreeSquash(prefix = VENDOR_DIR, cwd = process.cwd()) {
  const trailer = (key) => `%(trailers:key=${key},valueonly,separator=%x20)`;
  const format = ["%H", trailer("git-subtree-dir"), trailer("git-subtree-mainline"), trailer("git-subtree-split")].join("%x00");
  const log = git(cwd, ["log", "--date-order", `--format=${format}%x00`, "--fixed-strings", `--grep=git-subtree-dir: ${prefix}`, "HEAD"], {
    encoding: "utf8",
  });
  const fields = log.split("\0");
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const [hash, dir, mainline, split] = fields.slice(i, i + 4).map((f) => f.trim());
    if (dir === prefix && !mainline && /^[0-9a-f]{40}$/.test(split)) return { squash: hash, commit: split };
  }
  throw new Error(`No git subtree squash commit for ${prefix} is reachable from HEAD`);
}

/**
 * `{ "<path>": "<sha256 hex>" }` for every file in the tree of `commit`,
 * sorted by path, read from git's object store. For a squash commit that tree
 * is upstream's, so the paths are relative to the vendored directory.
 */
export function hashCommitTree(commit, cwd = process.cwd()) {
  const entries = git(cwd, ["ls-tree", "-r", "-z", "--full-tree", commit], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta, rel] = [line.slice(0, line.indexOf("\t")), line.slice(line.indexOf("\t") + 1)];
      const [mode, type, object] = meta.split(" ");
      if (type !== "blob") throw new Error(`${rel}: a ${type} (mode ${mode}) in ${commit}; only files are expected`);
      return { rel, object };
    });
  // One `git cat-file --batch` for all blobs: each answer is "<object> blob <size>\n<content>\n".
  const batch = git(cwd, ["cat-file", "--batch"], { input: entries.map((e) => e.object).join("\n") + "\n" });
  const out = new Map();
  let at = 0;
  for (const { rel, object } of entries) {
    const eol = batch.indexOf(10, at);
    const [got, type, size] = batch.subarray(at, eol).toString("utf8").split(" ");
    if (got !== object || type !== "blob") throw new Error(`git cat-file answered ${got} ${type} for ${object} (${rel})`);
    const start = eol + 1;
    out.set(rel, sha256(batch.subarray(start, start + Number(size))));
    at = start + Number(size) + 1;
  }
  return sortedObject(out);
}

/**
 * The manifest for the latest squash import of `prefix`, computed from git
 * alone. `generated` is the squash commit's commit date, so the same import
 * always gives the same manifest, byte for byte.
 */
export function buildManifest({ tag, prefix = VENDOR_DIR, cwd = process.cwd() }) {
  const { squash, commit } = subtreeSquash(prefix, cwd);
  const seconds = Number(git(cwd, ["show", "-s", "--format=%ct", squash], { encoding: "utf8" }).trim());
  const generated = new Date(seconds * 1000).toISOString();
  return { upstream: UPSTREAM, tag, commit, squash, generated, files: hashCommitTree(squash, cwd) };
}

export function writeManifest(tag, cwd = process.cwd()) {
  const manifest = buildManifest({ tag, cwd });
  fs.writeFileSync(path.join(cwd, MANIFEST_PATH), JSON.stringify(manifest, null, 2) + "\n");
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
  console.log(
    `Wrote ${MANIFEST_PATH}: ${Object.keys(manifest.files).length} files, ${tag} (${manifest.commit}), from squash commit ${manifest.squash}`,
  );
}
