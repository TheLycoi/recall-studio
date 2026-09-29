// Run with: npm test
// The vendored copy of obsidian-llm-wiki under vendor/llm-wiki is Apache-2.0,
// which requires every file WikiLM modifies to say so. These tests hold the
// tree to its manifest (vendor/llm-wiki.manifest.json, the sha256 of every
// file as imported) and its change list (vendor/llm-wiki.CHANGES.md): a file
// that differs from the manifest must be listed and must carry the marker line,
// a file that is gone must be recorded as removed, and upstream's LICENSE and
// NOTICE may never change. The failing cases run against temporary trees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  hashTree,
  parseChangeList,
  checkProvenance,
  checkTree,
  buildManifest,
} from "../scripts/vendor-manifest.mjs";

const MANIFEST_SCRIPT = fileURLToPath(new URL("../scripts/vendor-manifest.mjs", import.meta.url));

const VENDOR = "vendor/llm-wiki";
const MANIFEST = "vendor/llm-wiki.manifest.json";
const CHANGES = "vendor/llm-wiki.CHANGES.md";

const EMPTY_CHANGES = `# Changes

| File | Date | Reason |
| --- | --- | --- |
`;

function changes(...rows) {
  return EMPTY_CHANGES + rows.map((r) => `| \`${r[0]}\` | ${r[1]} | ${r[2]} |\n`).join("");
}

/** Git run in a temporary repository, isolated from the user's own git configuration. */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_MERGE_AUTOEDIT: "no",
  GIT_EDITOR: "true",
};
for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete GIT_ENV[name];

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

/** A temporary directory, removed when the test ends. */
function tempDir(t, name) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), `wikilm-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFiles(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
}

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

/**
 * A temporary vendor tree holding `files`, with a manifest taken of it as it
 * stands. The tree is a git repository with nothing committed, so every file in
 * it is untracked and git lists it unless a .gitignore in the tree says not to.
 */
function fixture(t, files) {
  const root = tempDir(t, "vendor-test");
  git(root, "init", "-q", "-b", "main");
  writeFiles(root, files);
  return { root, manifest: { files: hashTree(root) } };
}

const BASE = {
  LICENSE: "Apache License\n",
  NOTICE: "obsidian-llm-wiki\n",
  "src/main.ts": "export const a = 1;\n",
  "README.md": "# upstream\n",
};

test("the real vendored tree matches its manifest, or is marked in the change list", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const problems = checkTree(VENDOR, manifest, fs.readFileSync(CHANGES, "utf8"));
  assert.deepEqual(problems, []);
});

test("the manifest names its upstream, tag and commit, and lists every file", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  assert.equal(manifest.upstream, "https://github.com/GD4AI/obsidian-llm-wiki");
  assert.match(manifest.tag, /^\S+$/);
  assert.match(manifest.commit, /^[0-9a-f]{40}$/);
  assert.match(manifest.squash, /^[0-9a-f]{40}$/);
  assert.ok(!Number.isNaN(Date.parse(manifest.generated)), "generated is a date");
  assert.ok(Object.keys(manifest.files).length > 0);
  for (const [rel, sha] of Object.entries(manifest.files)) {
    assert.match(sha, /^[0-9a-f]{64}$/, rel);
    assert.ok(!rel.split("/").includes("node_modules"), `${rel} is under node_modules`);
  }
});

test("the committed manifest is exactly what git's latest squash import of vendor/llm-wiki records", () => {
  // The manifest describes upstream's content as git imported it, so it is
  // computed from the squash commit's tree, never from the working tree.
  const committed = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const squash = execFileSync(
    "git",
    ["log", "-1", "--format=%H", "--grep=^git-subtree-split: ", "--grep=^Squashed 'vendor/llm-wiki/' ", "--all-match", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  assert.equal(committed.squash, squash);
  assert.deepEqual(committed, buildManifest({ tag: committed.tag }));
});

/**
 * A temporary WikiLM repository that vendors a temporary upstream repository
 * under vendor/llm-wiki with `git subtree add --squash`, exactly as the real
 * one was imported, with an empty change list committed beside it.
 */
function subtreeRepos(t) {
  const upstream = tempDir(t, "upstream");
  git(upstream, "init", "-q", "-b", "main");
  writeFiles(upstream, { ...BASE, "src/other.ts": "export const b = 1;\n" });
  git(upstream, "add", "-A");
  git(upstream, "commit", "-q", "-m", "Upstream 1.0.0");

  const repo = tempDir(t, "wikilm");
  git(repo, "init", "-q", "-b", "main");
  writeFiles(repo, { "README.md": "# WikiLM\n", [CHANGES]: EMPTY_CHANGES });
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "WikiLM");
  // No -m: git subtree then writes its own trailers into the merge commit as
  // well, and those name the squash commit, not upstream's.
  git(repo, "subtree", "add", "--prefix=vendor/llm-wiki", upstream, "main", "--squash");
  return { upstream, repo };
}

function writeManifestIn(repo, tag) {
  execFileSync(process.execPath, [MANIFEST_SCRIPT, "--tag", tag], { cwd: repo, env: GIT_ENV, encoding: "utf8" });
  return fs.readFileSync(path.join(repo, MANIFEST), "utf8");
}

function checkRepo(repo) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, MANIFEST), "utf8"));
  return checkTree(path.join(repo, VENDOR), manifest, fs.readFileSync(path.join(repo, CHANGES), "utf8"));
}

test("the manifest records upstream's commit and content, and names the squash commit it was taken from", (t) => {
  const { upstream, repo } = subtreeRepos(t);
  const manifest = JSON.parse(writeManifestIn(repo, "1.0.0"));
  assert.equal(manifest.tag, "1.0.0");
  assert.equal(manifest.commit, git(upstream, "rev-parse", "HEAD"));
  assert.equal(manifest.squash, git(repo, "rev-parse", "HEAD^2"), "the squash commit is the add merge's second parent");
  assert.deepEqual(manifest.files, {
    LICENSE: sha256(BASE.LICENSE),
    NOTICE: sha256(BASE.NOTICE),
    "README.md": sha256(BASE["README.md"]),
    "src/main.ts": sha256(BASE["src/main.ts"]),
    "src/other.ts": sha256("export const b = 1;\n"),
  });
  assert.deepEqual(checkRepo(repo), []);
});

test("regenerating the manifest after an unmarked edit changes nothing, and the edit is still reported", (t) => {
  const { repo } = subtreeRepos(t);
  const before = writeManifestIn(repo, "1.0.0");
  fs.writeFileSync(path.join(repo, VENDOR, "src/main.ts"), "export const a = 2;\n");

  assert.equal(writeManifestIn(repo, "1.0.0"), before, "regenerating in a dirty tree");
  const problems = checkRepo(repo);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /^src\/main\.ts: /);

  // Committing the edit does not launder it either.
  git(repo, "commit", "-q", "-am", "Edit upstream without marking it");
  assert.equal(writeManifestIn(repo, "1.0.0"), before, "regenerating after a commit");
  assert.equal(checkRepo(repo).length, 1);
});

test("after a subtree pull the manifest records upstream's new content, not WikiLM's modifications", (t) => {
  const { upstream, repo } = subtreeRepos(t);
  writeManifestIn(repo, "1.0.0");
  const marked = "// Modified by WikiLM on 2026-09-29: b is 2.\nexport const b = 2;\n";
  fs.writeFileSync(path.join(repo, VENDOR, "src/other.ts"), marked);
  fs.writeFileSync(path.join(repo, CHANGES), changes(["src/other.ts", "2026-09-29", "b is 2"]));
  git(repo, "commit", "-q", "-am", "Modify src/other.ts");

  fs.writeFileSync(path.join(upstream, "src/main.ts"), "export const a = 3;\n");
  fs.writeFileSync(path.join(upstream, "src/new.ts"), "export const c = 1;\n");
  git(upstream, "add", "-A");
  git(upstream, "commit", "-q", "-m", "Upstream 1.1.0");
  git(repo, "subtree", "pull", "--prefix=vendor/llm-wiki", upstream, "main", "--squash", "-m", "Update to 1.1.0");

  const manifest = JSON.parse(writeManifestIn(repo, "1.1.0"));
  assert.equal(manifest.commit, git(upstream, "rev-parse", "HEAD"));
  assert.equal(manifest.squash, git(repo, "rev-parse", "HEAD^2"));
  assert.equal(manifest.files["src/other.ts"], sha256("export const b = 1;\n"), "upstream's other.ts, not WikiLM's");
  assert.equal(manifest.files["src/main.ts"], sha256("export const a = 3;\n"));
  assert.equal(manifest.files["src/new.ts"], sha256("export const c = 1;\n"));
  assert.equal(fs.readFileSync(path.join(repo, VENDOR, "src/other.ts"), "utf8"), marked);
  assert.deepEqual(checkRepo(repo), []);
});

test("1. a file that differs from the manifest fails unless the change list names it", (t) => {
  const { root, manifest } = fixture(t, BASE);
  assert.deepEqual(checkTree(root, manifest, EMPTY_CHANGES), [], "an untouched tree passes");

  fs.writeFileSync(path.join(root, "src/main.ts"), "export const a = 2;\n");
  const changed = checkTree(root, manifest, EMPTY_CHANGES);
  assert.equal(changed.length, 1);
  assert.match(changed[0], /src\/main\.ts/);

  fs.writeFileSync(path.join(root, "src/main.ts"), "// Modified by WikiLM on 2026-09-29: a is 2.\nexport const a = 2;\n");
  assert.deepEqual(checkTree(root, manifest, changes(["src/main.ts", "2026-09-29", "a is 2"])), []);
});

test("1. a file added to the tree fails unless the change list names it", (t) => {
  const { root, manifest } = fixture(t, BASE);
  fs.writeFileSync(path.join(root, "src/extra.ts"), "// Modified by WikiLM on 2026-09-29: new.\n");
  const added = checkTree(root, manifest, EMPTY_CHANGES);
  assert.equal(added.length, 1);
  assert.match(added[0], /src\/extra\.ts/);
  assert.deepEqual(checkTree(root, manifest, changes(["src/extra.ts", "2026-09-29", "new"])), []);
});

test("1. the tree is the files git lists: what git ignores is left out", (t) => {
  const { root, manifest } = fixture(t, { ...BASE, ".gitignore": "node_modules/\n.DS_Store\n" });
  writeFiles(root, {
    "node_modules/x/index.js": "module.exports = 1;\n",
    "tools/node_modules/y/index.js": "module.exports = 2;\n",
    "src/.DS_Store": "finder",
  });
  assert.deepEqual(Object.keys(hashTree(root)).sort(), [...Object.keys(BASE), ".gitignore"].sort());
  assert.deepEqual(checkTree(root, manifest, EMPTY_CHANGES), []);

  // A file git tracks is part of the tree even when an ignore rule matches it.
  git(root, "add", "-f", "src/.DS_Store");
  const tracked = checkTree(root, manifest, EMPTY_CHANGES);
  assert.equal(tracked.length, 1, tracked.join("\n"));
  assert.match(tracked[0], /^src\/\.DS_Store: not in the manifest/);
});

test("1. a real file cannot hide behind the name node_modules or .DS_Store", (t) => {
  // With no ignore rule for them, these are files like any other.
  const { root, manifest } = fixture(t, BASE);
  writeFiles(root, { "src/node_modules/x.ts": "export const x = 1;\n", "src/.DS_Store": "x" });
  const problems = checkTree(root, manifest, EMPTY_CHANGES).sort();
  assert.equal(problems.length, 2, problems.join("\n"));
  assert.match(problems[0], /^src\/\.DS_Store: not in the manifest/);
  assert.match(problems[1], /^src\/node_modules\/x\.ts: not in the manifest/);
});

test("1. a file deleted from disk but still tracked by git counts as missing", (t) => {
  const { root, manifest } = fixture(t, BASE);
  git(root, "add", "-A");
  fs.rmSync(path.join(root, "src/main.ts"));
  const problems = checkTree(root, manifest, EMPTY_CHANGES);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /^src\/main\.ts: in the manifest but missing/);
});

test("1. files named after Object.prototype members are checked like any other", (t) => {
  const { root, manifest } = fixture(t, BASE);
  writeFiles(root, { ["__proto__"]: "a", constructor: "b", "src/toString": "c" });
  const added = checkTree(root, manifest, EMPTY_CHANGES).sort();
  assert.deepEqual(added.map((p) => p.split(": ")[0]), ["__proto__", "constructor", "src/toString"]);
  for (const p of added) assert.match(p, /: not in the manifest and not listed in the change list$/);

  // Recorded in the manifest, the same names are compared and reported missing.
  const recorded = JSON.parse(JSON.stringify({ files: hashTree(root) }));
  assert.ok(Object.hasOwn(recorded.files, "__proto__"), "the manifest keeps __proto__ as a file");
  assert.deepEqual(checkTree(root, recorded, EMPTY_CHANGES), []);
  fs.writeFileSync(path.join(root, "__proto__"), "changed");
  fs.rmSync(path.join(root, "constructor"));
  const later = checkTree(root, recorded, EMPTY_CHANGES).sort();
  assert.equal(later.length, 2, later.join("\n"));
  assert.match(later[0], /^__proto__: differs from the manifest/);
  assert.match(later[1], /^constructor: in the manifest but missing/);

  // A manifest without these names does not find them on Object.prototype.
  const bare = checkProvenance({
    manifestFiles: { LICENSE: "1", NOTICE: "2", constructor: "3" },
    actualFiles: { LICENSE: "1", NOTICE: "2", toString: "4" },
    changes: parseChangeList(EMPTY_CHANGES),
    readText: () => "",
  }).sort();
  assert.deepEqual(bare, [
    "constructor: in the manifest but missing, and its removal is not recorded",
    "toString: not in the manifest and not listed in the change list",
  ]);
});

test("2. a file in the change list must carry the marker line for its kind", (t) => {
  const { root, manifest } = fixture(t, BASE);
  const listed = changes(["src/main.ts", "2026-09-29", "a is 2"], ["README.md", "2026-09-29", "note"]);

  fs.writeFileSync(path.join(root, "src/main.ts"), "export const a = 2;\n");
  fs.writeFileSync(path.join(root, "README.md"), "<!-- Modified by WikiLM on 2026-09-29: note. -->\n# upstream\n");
  const unmarked = checkTree(root, manifest, listed);
  assert.equal(unmarked.length, 1);
  assert.match(unmarked[0], /src\/main\.ts/);

  // Markdown takes the HTML comment form; the // form does not count there.
  fs.writeFileSync(path.join(root, "src/main.ts"), "// Modified by WikiLM on 2026-09-29: a is 2.\nexport const a = 2;\n");
  fs.writeFileSync(path.join(root, "README.md"), "// Modified by WikiLM on 2026-09-29: note.\n# upstream\n");
  const wrongForm = checkTree(root, manifest, listed);
  assert.equal(wrongForm.length, 1);
  assert.match(wrongForm[0], /README\.md/);

  fs.writeFileSync(path.join(root, "README.md"), "<!-- Modified by WikiLM on 2026-09-29: note. -->\n# upstream\n");
  assert.deepEqual(checkTree(root, manifest, listed), []);
});

test("2. the marker must start its line", (t) => {
  const { root, manifest } = fixture(t, BASE);
  fs.writeFileSync(path.join(root, "src/main.ts"), "export const a = 2; // Modified by WikiLM on 2026-09-29\n");
  const problems = checkTree(root, manifest, changes(["src/main.ts", "2026-09-29", "a is 2"]));
  assert.equal(problems.length, 1);
});

test("3. a file in the manifest but missing from disk fails unless its removal is recorded", (t) => {
  const { root, manifest } = fixture(t, BASE);
  fs.rmSync(path.join(root, "src/main.ts"));
  const missing = checkTree(root, manifest, EMPTY_CHANGES);
  assert.equal(missing.length, 1);
  assert.match(missing[0], /src\/main\.ts/);

  // Listing it as modified is not recording its removal.
  const asModified = checkTree(root, manifest, changes(["src/main.ts", "2026-09-29", "rewritten"]));
  assert.ok(asModified.some((p) => /src\/main\.ts: in the manifest but missing/.test(p)), asModified.join("\n"));
  assert.deepEqual(checkTree(root, manifest, changes(["src/main.ts", "2026-09-29", "Removed: WikiLM has its own"])), []);
});

test("3. a file recorded as removed must be gone", (t) => {
  const { root, manifest } = fixture(t, BASE);
  assert.equal(checkTree(root, manifest, changes(["src/main.ts", "2026-09-29", "Removed: unused"])).length, 1);
});

test("4. LICENSE and NOTICE must match the manifest and may never be in the change list", (t) => {
  const { root, manifest } = fixture(t, BASE);
  for (const name of ["LICENSE", "NOTICE"]) {
    const file = path.join(root, name);
    const original = fs.readFileSync(file, "utf8");

    assert.ok(checkTree(root, manifest, changes([name, "2026-09-29", "note"])).length > 0, `${name} listed`);

    fs.writeFileSync(file, `// Modified by WikiLM on 2026-09-29: x.\n${original}`);
    assert.ok(checkTree(root, manifest, EMPTY_CHANGES).length > 0, `${name} changed`);
    assert.ok(checkTree(root, manifest, changes([name, "2026-09-29", "x"])).length > 0, `${name} changed and listed`);

    fs.rmSync(file);
    assert.ok(checkTree(root, manifest, changes([name, "2026-09-29", "Removed: x"])).length > 0, `${name} removed`);

    fs.writeFileSync(file, original);
    assert.deepEqual(checkTree(root, manifest, EMPTY_CHANGES), []);
  }
  // A manifest that never recorded them fails too.
  const bare = { files: { ...manifest.files } };
  delete bare.files.LICENSE;
  assert.ok(checkTree(root, bare, changes(["LICENSE", "2026-09-29", "x"])).length > 0);
});

test("4. the real LICENSE and NOTICE exist and match the manifest", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const actual = hashTree(VENDOR);
  for (const name of ["LICENSE", "NOTICE"]) {
    assert.ok(fs.existsSync(path.join(VENDOR, name)), `${name} exists`);
    assert.equal(actual[name], manifest.files[name], `${name} matches the manifest`);
  }
  const listed = parseChangeList(fs.readFileSync(CHANGES, "utf8"));
  assert.ok(!listed.modified.has("LICENSE") && !listed.modified.has("NOTICE"));
  assert.ok(!listed.removed.has("LICENSE") && !listed.removed.has("NOTICE"));
});

test("parseChangeList reads the table and tells removals from modifications", () => {
  const parsed = parseChangeList(changes(["src/a.ts", "2026-09-29", "fix"], ["src/b.ts", "2026-09-30", "removed: unused"]));
  assert.deepEqual([...parsed.modified], ["src/a.ts"]);
  assert.deepEqual([...parsed.removed], ["src/b.ts"]);
  const none = parseChangeList(EMPTY_CHANGES);
  assert.equal(none.modified.size + none.removed.size, 0);
});

test("checkProvenance is pure: it compares hashes it is given", () => {
  const problems = checkProvenance({
    manifestFiles: { LICENSE: "1", NOTICE: "2", "a.ts": "3" },
    actualFiles: { LICENSE: "1", NOTICE: "2", "a.ts": "4" },
    changes: parseChangeList(EMPTY_CHANGES),
    readText: () => "",
  });
  assert.equal(problems.length, 1);
});

test("the root carries a byte copy of upstream's licence", () => {
  assert.ok(fs.readFileSync("LICENSE-APACHE-2.0.txt").equals(fs.readFileSync("vendor/llm-wiki/LICENSE")));
});

test("vendor-update --dry-run prints the commands and runs none of them", () => {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  const out = execFileSync(process.execPath, ["scripts/vendor-update.mjs", "9.9.9", "--dry-run"], { encoding: "utf8" });
  assert.match(out, /git status --porcelain/);
  assert.ok(out.includes("git subtree pull --prefix=vendor/llm-wiki llmwiki refs/tags/9.9.9 --squash"), out);
  assert.match(out, /node scripts\/vendor-manifest\.mjs --tag 9\.9\.9/);
  assert.match(out, /git diff --name-only/);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }), head);
});

test("vendor-update refuses a missing or malformed tag", () => {
  const missing = spawnSync(process.execPath, ["scripts/vendor-update.mjs", "--dry-run"], { encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  const bad = spawnSync(process.execPath, ["scripts/vendor-update.mjs", "1.0;rm", "--dry-run"], { encoding: "utf8" });
  assert.notEqual(bad.status, 0);
});
