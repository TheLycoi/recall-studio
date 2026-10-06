// Run with: npm test
// scripts/install.mjs copies the built plugin into a vault's plugin folder. It
// is tested against temporary directories only: it must copy exactly its own
// files and leave everything else in the folder (data.json holds the reader's
// settings and keys) untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { install, INSTALLED_FILES } from "../scripts/install.mjs";

function tmp(prefix) {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

function sourceTree() {
  const src = tmp("recall-install-src-");
  const files = {
    "main.js": "main",
    "manifest.json": "{}",
    "styles.css": "css",
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), text);
  }
  return src;
}

test("install copies main.js, manifest.json and styles.css into the plugin folder", () => {
  const src = sourceTree();
  const vault = tmp("recall-install-vault-");
  const dest = install(vault, src);
  assert.equal(dest, path.join(vault, ".obsidian", "plugins", "recall"));
  const read = (name) => fs.readFileSync(path.join(dest, name), "utf8");
  assert.equal(read("main.js"), "main");
  assert.equal(read("manifest.json"), "{}");
  assert.equal(read("styles.css"), "css");
  assert.deepEqual(fs.readdirSync(dest).sort(), ["main.js", "manifest.json", "styles.css"]);
  assert.deepEqual(INSTALLED_FILES.map((f) => f.to).sort(), fs.readdirSync(dest).sort());
});

test("install leaves everything else in the plugin folder untouched", () => {
  const src = sourceTree();
  const vault = tmp("recall-install-vault-");
  const dest = path.join(vault, ".obsidian", "plugins", "recall");
  fs.mkdirSync(path.join(dest, "cache"), { recursive: true });
  fs.writeFileSync(path.join(dest, "data.json"), '{"apiKey":"secret"}');
  fs.writeFileSync(path.join(dest, "cache", "x.json"), "keep");
  install(vault, src);
  assert.equal(fs.readFileSync(path.join(dest, "data.json"), "utf8"), '{"apiKey":"secret"}');
  assert.equal(fs.readFileSync(path.join(dest, "cache", "x.json"), "utf8"), "keep");
});

test("install copies nothing when a source file is missing", () => {
  const src = sourceTree();
  fs.rmSync(path.join(src, "styles.css"));
  const vault = tmp("recall-install-vault-");
  assert.throws(() => install(vault, src), /styles\.css/);
  assert.ok(!fs.existsSync(path.join(vault, ".obsidian", "plugins", "recall", "main.js")));
});

test("running the script with no vault argument and no RECALL_VAULT exits 2 and prints Usage", () => {
  const env = { ...process.env };
  delete env.RECALL_VAULT;
  const result = spawnSync(process.execPath, ["scripts/install.mjs"], { encoding: "utf8", env });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
});

test("install copies into the recall plugin folder", () => {
  const vault = mkdtempSync(path.join(tmpdir(), "recall-vault-"));
  const src = mkdtempSync(path.join(tmpdir(), "recall-src-"));
  for (const f of ["main.js", "manifest.json", "styles.css"]) writeFileSync(path.join(src, f), f);
  const dest = install(vault, src);
  assert.equal(dest, path.join(vault, ".obsidian", "plugins", "recall"));
  assert.deepEqual(readdirSync(dest).sort(), ["main.js", "manifest.json", "styles.css"]);
});
