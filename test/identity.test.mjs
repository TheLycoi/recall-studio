// Run with: npm test  (reads the manifest, the package file and the sources as text)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const versions = JSON.parse(readFileSync("versions.json", "utf8"));

test("the plugin is Recall 0.3.0", () => {
  assert.equal(manifest.id, "recall");
  assert.equal(manifest.name, "Recall");
  assert.equal(manifest.version, "0.3.0");
  assert.equal(manifest.minAppVersion, "1.7.2");
  assert.equal(manifest.isDesktopOnly, true);
  assert.equal(pkg.version, "0.3.0");
  assert.deepEqual(versions, { "0.1.0": "1.7.2", "0.2.0": "1.7.2", "0.3.0": "1.7.2" });
});

test("the manifest names all three providers", () => {
  // The store listing is what a reader picks a plugin from; a provider the
  // description does not mention reads as one the plugin does not have.
  for (const name of ["Codex", "DeepSeek", "opencode"]) {
    assert.ok(manifest.description.includes(name), `manifest does not name ${name}`);
  }
});

test("nothing the reader sees says WikiLM", () => {
  for (const f of readdirSync("src").filter((n) => n.endsWith(".ts"))) {
    const text = readFileSync(`src/${f}`, "utf8");
    assert.equal(/WikiLM|WikiLm|WIKILM/.test(text), false, f);
  }
  assert.equal(/WikiLM/.test(JSON.stringify(manifest)), false);
});

test("the sidebar view has its own type, so Recall and WikiLM can share a vault", () => {
  assert.match(readFileSync("src/inboxView.ts", "utf8"), /VIEW_TYPE_INBOX = "recall-inbox"/);
});
