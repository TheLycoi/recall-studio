// Run with: npm test. Bundles src/anki.ts through the plugin build options with
// a stubbed `obsidian`, then exercises the pure builders: identity tags, the
// search queries, media path safety, the source backlink (including on a Basic
// model with no Extra field) and the exact PDF subpath.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sharedBuildOptions } from "../scripts/esbuild-shared.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function obsidianStub() {
  return {
    name: "obsidian-stub",
    setup(b) {
      b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: ["export const requestUrl = async () => ({ status: 200, json: { result: null, error: null } });", "export const Notice = class {};", "export const normalizePath = (p) => p;"].join("\n"),
        loader: "js",
      }));
    },
  };
}

let a;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "review-inbox-anki-"));
  const out = path.join(dir, "anki.cjs");
  const shared = sharedBuildOptions();
  await build({
    ...shared,
    stdin: { contents: 'export * from "./src/anki.ts";', resolveDir: ROOT, sourcefile: "anki-probe.ts", loader: "ts" },
    outfile: out,
    logLevel: "error",
    external: shared.external.filter((e) => e !== "obsidian"),
    plugins: [obsidianStub()],
  });
  a = createRequire(import.meta.url)(out);
});

const settings = (over = {}) => ({
  includeExtra: true,
  includeSourceTag: true,
  extraTags: "review-inbox",
  basicModel: "Basic",
  basicFrontField: "Front",
  basicBackField: "Back",
  basicExtraField: "Extra",
  clozeModel: "Cloze",
  clozeTextField: "Text",
  clozeExtraField: "Back Extra",
  ...over,
});

const hl = (over = {}) => ({ id: "h1", sourcePath: "wiki/Spacing.md", sourceTitle: "Spacing", title: "Interval", heading: "Spacing", page: null, blockId: null, text: "The gap between reviews is the interval.", ...over });
const qaCard = (over = {}) => ({ id: "c1", kind: "qa", front: "What is the interval?", back: "the gap between reviews", text: "", extra: "", ...over });
const clozeCard = (over = {}) => ({ id: "c2", kind: "cloze", front: "", back: "", text: "The gap is the {{c1::interval}}.", extra: "", ...over });

// ---- identity --------------------------------------------------------------

test("cardIdentityTag is stable and scoped to plugin and vault", () => {
  assert.match(a.cardIdentityTag("Test Vault", "c-abc"), /^review-inbox::[a-f0-9]{64}$/);
  assert.notEqual(a.cardIdentityTag("Vault A", "c-1"), a.cardIdentityTag("Vault B", "c-1"));
  assert.notEqual(a.cardIdentityTag("Vault A", "c-1"), a.cardIdentityTag("Vault A", "c-2"));
  // Same inputs, same tag: identity is what makes a retry idempotent.
  assert.equal(a.cardIdentityTag("Vault A", "c-1"), a.cardIdentityTag("Vault A", "c-1"));
});

test("identityQuery escapes the tag so Anki treats it as literal text", () => {
  assert.equal(a.identityQuery("review-inbox::vault::c-1"), "tag:review-inbox\\:\\:vault\\:\\:c-1");
});

test("escapeAnkiSearch neutralises the search operators", () => {
  assert.equal(a.escapeAnkiSearch("a:b"), "a\\:b");
  assert.equal(a.escapeAnkiSearch("a*b_c"), "a\\*b\\_c");
  assert.equal(a.escapeAnkiSearch('a"b'), 'a\\"b');
});

// ---- media path safety -----------------------------------------------------

test("isSafeMediaPath accepts a vault-relative media file", () => {
  assert.equal(a.isSafeMediaPath("notes/img/pic.png"), true);
  assert.equal(a.isSafeMediaPath("audio/clip.mp3"), true);
});

test("isSafeMediaPath refuses remote URLs, absolute paths, traversal and non-media files", () => {
  assert.equal(a.isSafeMediaPath("https://evil.example/x.png"), false);
  assert.equal(a.isSafeMediaPath("http://x/y.png"), false);
  assert.equal(a.isSafeMediaPath("/etc/passwd.png"), false);
  assert.equal(a.isSafeMediaPath("../secret.png"), false);
  assert.equal(a.isSafeMediaPath("a/../b.png"), false);
  assert.equal(a.isSafeMediaPath("~/x.png"), false);
  assert.equal(a.isSafeMediaPath("notes/readme.txt"), false);
});

// ---- note building ---------------------------------------------------------

test("a Basic card with an Extra field puts the backlink in Extra", () => {
  const n = a.buildNote(qaCard(), hl(), { settings: settings(), vaultName: "V", deck: "D" });
  assert.equal(n.modelName, "Basic");
  assert.match(n.fields.Extra, /Source:/);
  assert.equal(n.fields.Back, "the gap between reviews");
});

test("a Basic card with NO Extra field still carries the source backlink (appended to Back)", () => {
  const n = a.buildNote(qaCard(), hl(), { settings: settings({ basicExtraField: "" }), vaultName: "V", deck: "D" });
  assert.match(n.fields.Back, /the gap between reviews/);
  assert.match(n.fields.Back, /Source:.*Spacing/);
  assert.ok(!("Extra" in n.fields) || n.fields.Extra === undefined);
});

test("a Cloze card with NO Extra field still carries the backlink (appended to Text)", () => {
  const n = a.buildNote(clozeCard(), hl(), { settings: settings({ clozeExtraField: "" }), vaultName: "V", deck: "D" });
  assert.match(n.fields.Text, /\{\{c1::interval\}\}/);
  assert.match(n.fields.Text, /Source:.*Spacing/);
});

test("the source backlink uses the exact PDF++ subpath when the highlight has one", () => {
  const extra = a.buildExtra(hl({ subpath: "page=3&selection=abc" }), { settings: settings(), vaultName: "V", deck: "D" });
  assert.match(extra, /page%3D3/);
  assert.match(extra, /selection%3Dabc/);
});

test("the source backlink falls back to the page, then the block id, then the note", () => {
  assert.match(a.buildExtra(hl({ page: 7 }), { settings: settings(), vaultName: "V", deck: "D" }), /page%3D7/);
  assert.match(a.buildExtra(hl({ blockId: "xyz" }), { settings: settings(), vaultName: "V", deck: "D" }), /%5Exyz/);
  const plain = a.buildExtra(hl(), { settings: settings(), vaultName: "V", deck: "D" });
  assert.doesNotMatch(plain, /%23/);
});

test("buildNote refuses nothing but always tags the source when asked", () => {
  const n = a.buildNote(qaCard(), hl(), { settings: settings(), vaultName: "V", deck: "D" });
  assert.ok(n.tags.includes("source::spacing"));
});
