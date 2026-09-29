// Run with: npm test
// scripts/install.mjs copies the built plugin and its licence notices into a
// vault's plugin folder. It is tested against temporary directories only: it
// must copy exactly its own files and leave everything else in the folder
// (data.json holds the reader's settings and keys) untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { install, INSTALLED_FILES } from "../scripts/install.mjs";

function tmp(prefix) {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

function sourceTree() {
  const src = tmp("wikilm-install-src-");
  const files = {
    "main.js": "main",
    "manifest.json": "{}",
    "styles.css": "css",
    NOTICE: "WikiLM notice",
    "LICENSE-APACHE-2.0.txt": "apache",
    "vendor/llm-wiki/NOTICE": "upstream notice",
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), text);
  }
  return src;
}

test("install copies the plugin and the three notices into the plugin folder", () => {
  const src = sourceTree();
  const vault = tmp("wikilm-install-vault-");
  const dest = install(vault, src);
  assert.equal(dest, path.join(vault, ".obsidian", "plugins", "wikilm"));
  const read = (name) => fs.readFileSync(path.join(dest, name), "utf8");
  assert.equal(read("main.js"), "main");
  assert.equal(read("manifest.json"), "{}");
  assert.equal(read("styles.css"), "css");
  assert.equal(read("NOTICE"), "WikiLM notice");
  assert.equal(read("LICENSE-APACHE-2.0.txt"), "apache");
  assert.equal(read("NOTICE-llm-wiki"), "upstream notice");
  assert.deepEqual(fs.readdirSync(dest).sort(), ["LICENSE-APACHE-2.0.txt", "NOTICE", "NOTICE-llm-wiki", "main.js", "manifest.json", "styles.css"]);
  assert.deepEqual(INSTALLED_FILES.map((f) => f.to).sort(), fs.readdirSync(dest).sort());
});

test("install leaves everything else in the plugin folder untouched", () => {
  const src = sourceTree();
  const vault = tmp("wikilm-install-vault-");
  const dest = path.join(vault, ".obsidian", "plugins", "wikilm");
  fs.mkdirSync(path.join(dest, "cache"), { recursive: true });
  fs.writeFileSync(path.join(dest, "data.json"), '{"apiKey":"secret"}');
  fs.writeFileSync(path.join(dest, "cache", "x.json"), "keep");
  install(vault, src);
  assert.equal(fs.readFileSync(path.join(dest, "data.json"), "utf8"), '{"apiKey":"secret"}');
  assert.equal(fs.readFileSync(path.join(dest, "cache", "x.json"), "utf8"), "keep");
});

test("install copies nothing when a source file is missing", () => {
  const src = sourceTree();
  fs.rmSync(path.join(src, "vendor/llm-wiki/NOTICE"));
  const vault = tmp("wikilm-install-vault-");
  assert.throws(() => install(vault, src), /NOTICE/);
  assert.ok(!fs.existsSync(path.join(vault, ".obsidian", "plugins", "wikilm", "main.js")));
});
