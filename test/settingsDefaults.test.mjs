// Run with: npm test  (bundles src/settingsDefaults.ts first, then exercises it with node:test)
// The topic folder Ask, Lint and the digest use defaults to `wiki`, the folder
// the ingest engine writes to. An install whose saved settings predate the
// setting keeps `classes` when that folder exists, so nobody loses sight of
// their pages.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let sd;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wikilm-settings-defaults-"));
  const out = path.join(dir, "settingsDefaults.mjs");
  await build({ entryPoints: ["src/settingsDefaults.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  sd = await import(pathToFileURL(out).href);
});

test("the default topic folder is wiki, where ingest writes", () => {
  assert.equal(sd.DEFAULT_TOPIC_FOLDER, "wiki");
});

test("a saved topic folder wins, whatever folders the vault has", () => {
  assert.equal(sd.resolveTopicFolderDefault({ topicFolder: "notes" }, true), "notes");
  assert.equal(sd.resolveTopicFolderDefault({ topicFolder: "notes" }, false), "notes");
});

test("saved settings without a topic folder keep classes when the vault has a classes folder", () => {
  assert.equal(sd.resolveTopicFolderDefault({ markMode: "none" }, true), "classes");
});

test("saved settings without a topic folder and no classes folder get wiki", () => {
  assert.equal(sd.resolveTopicFolderDefault({ markMode: "none" }, false), "wiki");
});

test("a fresh install (nothing saved) gets wiki even if the vault happens to have a classes folder", () => {
  assert.equal(sd.resolveTopicFolderDefault(null, true), "wiki");
  assert.equal(sd.resolveTopicFolderDefault(null, false), "wiki");
});
