// Updates the vendored obsidian-llm-wiki to an upstream tag.
//
// Usage: node scripts/vendor-update.mjs <tag> [--dry-run]
//
// 1. Refuses unless the working tree is clean (git status --porcelain is empty).
// 2. Pulls the tag into vendor/llm-wiki as a squashed subtree merge from the
//    `llmwiki` remote.
// 3. Regenerates vendor/llm-wiki.manifest.json from the squash commit the pull
//    made, so it records upstream's new content.
// 4. Prints the files in vendor/llm-wiki.CHANGES.md that the pull touched:
//    WikiLM's modifications to those files need checking against upstream's.
//
// --dry-run prints the commands and runs none of them.
//
// The manifest is read from git's squash commit, not from disk, so a file in
// the change list keeps upstream's content in the manifest and WikiLM's merged
// content on disk. Review those files, and their marker lines, before
// committing.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { CHANGES_PATH, VENDOR_DIR, parseChangeList, writeManifest } from "./vendor-manifest.mjs";

const REMOTE = "llmwiki";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const tag = args.find((a) => !a.startsWith("--"));
if (!tag || !/^[\w.-]+$/.test(tag)) {
  console.error("Usage: node scripts/vendor-update.mjs <tag> [--dry-run]");
  process.exit(2);
}

const git = (...a) => execFileSync("git", a, { encoding: "utf8" });
const show = (argv) => console.log(`$ ${argv.join(" ")}`);

const statusCmd = ["git", "status", "--porcelain"];
const headCmd = ["git", "rev-parse", "HEAD"];
const pullCmd = ["git", "subtree", "pull", `--prefix=${VENDOR_DIR}`, REMOTE, `refs/tags/${tag}`, "--squash"];
const manifestCmd = ["node", "scripts/vendor-manifest.mjs", "--tag", tag];
const diffCmd = (before) => ["git", "diff", "--name-only", before, "HEAD", "--", VENDOR_DIR];

if (dryRun) {
  console.log(`Dry run: updating ${VENDOR_DIR} to ${tag} would run:`);
  show(statusCmd);
  console.log("  (refuse if it prints anything)");
  show(headCmd);
  console.log("  (remember it as <before>)");
  show(pullCmd);
  show(manifestCmd);
  show(diffCmd("<before>"));
  console.log(`  (print the files among those that ${CHANGES_PATH} lists)`);
  process.exit(0);
}

const dirty = git(...statusCmd.slice(1));
if (dirty.trim()) {
  console.error("Refusing to update: the working tree is not clean.\n" + dirty);
  process.exit(1);
}
const before = git(...headCmd.slice(1)).trim();

show(pullCmd);
execFileSync(pullCmd[0], pullCmd.slice(1), { stdio: "inherit" });

show(manifestCmd);
const manifest = writeManifest(tag);
console.log(
  `Wrote the manifest: ${Object.keys(manifest.files).length} files, ${tag} (${manifest.commit}), from squash commit ${manifest.squash}`,
);

const touched = new Set(
  git(...diffCmd(before).slice(1)).split("\n").filter(Boolean).map((p) => p.slice(VENDOR_DIR.length + 1)),
);
const listed = parseChangeList(fs.readFileSync(CHANGES_PATH, "utf8"));
const hits = [...listed.modified, ...listed.removed].filter((f) => touched.has(f)).sort();
if (hits.length) {
  console.log(`The pull touched ${hits.length} file(s) in ${CHANGES_PATH}; check WikiLM's changes to them:`);
  for (const f of hits) console.log(`  ${f}`);
} else {
  console.log(`The pull touched no file in ${CHANGES_PATH}.`);
}
