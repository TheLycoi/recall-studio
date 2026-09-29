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
import {
  hashTree,
  parseChangeList,
  checkProvenance,
  checkTree,
} from "../scripts/vendor-manifest.mjs";

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

/** A temporary vendor tree holding `files`, with a manifest taken of it as it stands. */
function fixture(files) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "wikilm-vendor-test-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
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
  assert.ok(!Number.isNaN(Date.parse(manifest.generated)), "generated is a date");
  assert.ok(Object.keys(manifest.files).length > 0);
  for (const [rel, sha] of Object.entries(manifest.files)) {
    assert.match(sha, /^[0-9a-f]{64}$/, rel);
    assert.ok(!rel.split("/").includes("node_modules"), `${rel} is under node_modules`);
  }
});

test("1. a file that differs from the manifest fails unless the change list names it", () => {
  const { root, manifest } = fixture(BASE);
  assert.deepEqual(checkTree(root, manifest, EMPTY_CHANGES), [], "an untouched tree passes");

  fs.writeFileSync(path.join(root, "src/main.ts"), "export const a = 2;\n");
  const changed = checkTree(root, manifest, EMPTY_CHANGES);
  assert.equal(changed.length, 1);
  assert.match(changed[0], /src\/main\.ts/);

  fs.writeFileSync(path.join(root, "src/main.ts"), "// Modified by WikiLM on 2026-09-29: a is 2.\nexport const a = 2;\n");
  assert.deepEqual(checkTree(root, manifest, changes(["src/main.ts", "2026-09-29", "a is 2"])), []);
});

test("1. a file added to the tree fails unless the change list names it", () => {
  const { root, manifest } = fixture(BASE);
  fs.writeFileSync(path.join(root, "src/extra.ts"), "// Modified by WikiLM on 2026-09-29: new.\n");
  const added = checkTree(root, manifest, EMPTY_CHANGES);
  assert.equal(added.length, 1);
  assert.match(added[0], /src\/extra\.ts/);
  assert.deepEqual(checkTree(root, manifest, changes(["src/extra.ts", "2026-09-29", "new"])), []);
});

test("1. node_modules is never part of the tree", () => {
  const { root, manifest } = fixture(BASE);
  fs.mkdirSync(path.join(root, "node_modules/x"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules/x/index.js"), "module.exports = 1;\n");
  fs.mkdirSync(path.join(root, "tools/node_modules/y"), { recursive: true });
  fs.writeFileSync(path.join(root, "tools/node_modules/y/index.js"), "module.exports = 2;\n");
  assert.deepEqual(Object.keys(hashTree(root)).sort(), Object.keys(BASE).sort());
  assert.deepEqual(checkTree(root, manifest, EMPTY_CHANGES), []);
});

test("2. a file in the change list must carry the marker line for its kind", () => {
  const { root, manifest } = fixture(BASE);
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

test("2. the marker must start its line", () => {
  const { root, manifest } = fixture(BASE);
  fs.writeFileSync(path.join(root, "src/main.ts"), "export const a = 2; // Modified by WikiLM on 2026-09-29\n");
  const problems = checkTree(root, manifest, changes(["src/main.ts", "2026-09-29", "a is 2"]));
  assert.equal(problems.length, 1);
});

test("3. a file in the manifest but missing from disk fails unless its removal is recorded", () => {
  const { root, manifest } = fixture(BASE);
  fs.rmSync(path.join(root, "src/main.ts"));
  const missing = checkTree(root, manifest, EMPTY_CHANGES);
  assert.equal(missing.length, 1);
  assert.match(missing[0], /src\/main\.ts/);

  // Listing it as modified is not recording its removal.
  const asModified = checkTree(root, manifest, changes(["src/main.ts", "2026-09-29", "rewritten"]));
  assert.ok(asModified.some((p) => /src\/main\.ts: in the manifest but missing/.test(p)), asModified.join("\n"));
  assert.deepEqual(checkTree(root, manifest, changes(["src/main.ts", "2026-09-29", "Removed: WikiLM has its own"])), []);
});

test("3. a file recorded as removed must be gone", () => {
  const { root, manifest } = fixture(BASE);
  assert.equal(checkTree(root, manifest, changes(["src/main.ts", "2026-09-29", "Removed: unused"])).length, 1);
});

test("4. LICENSE and NOTICE must match the manifest and may never be in the change list", () => {
  const { root, manifest } = fixture(BASE);
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
