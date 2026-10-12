// Run with: npm test  (reads the manifest, the package file and the sources as text)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const versions = JSON.parse(readFileSync("versions.json", "utf8"));

test("the plugin is Review Inbox 0.1.0", () => {
  assert.equal(manifest.id, "review-inbox");
  assert.equal(manifest.name, "Review Inbox");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.minAppVersion, "1.7.2");
  assert.equal(manifest.isDesktopOnly, true);
  assert.equal(pkg.version, "0.1.0");
  assert.deepEqual(versions, { "0.1.0": "1.7.2" });
});

test("the plugin id is distinct from the Recall plugin, so settings and data are not overwritten", () => {
  assert.notEqual(manifest.id, "recall");
  assert.notEqual(pkg.name, "obsidian-recall");
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

test("Review Inbox keeps its files in a folder of its own, not the Recall folder", () => {
  const paths = readFileSync("src/paths.ts", "utf8");
  assert.match(paths, /DEFAULT_RULES_FOLDER = "Review Inbox"/);
  assert.equal(/DEFAULT_SPACED_FOLDER/.test(paths), false, "the Spaced Repetition folder must be gone");
});

test("the sidebar view has its own type, so Review Inbox and Recall can share a vault", () => {
  assert.match(readFileSync("src/inboxView.ts", "utf8"), /VIEW_TYPE_INBOX = "review-inbox"/);
});

test("Review Inbox has no quiz, dashboard, statistics or scheduler surface", () => {
  const src = readdirSync("src").filter((n) => n.endsWith(".ts"));
  for (const f of src) {
    const text = readFileSync(`src/${f}`, "utf8");
    // Real symbols, not prose: a comment saying "there is no dashboard" is
    // fine; a registered dashboard or quiz view is not.
    assert.equal(/QuizPanel|VIEW_TYPE_QUIZ|QuizView|VIEW_TYPE_DASHBOARD|DashboardView|StatisticsView/.test(text), false, f);
  }
  // The removed surfaces are gone as files, not merely unregistered.
  for (const gone of ["src/quizPanel.ts", "src/quizPages.ts", "src/chatCommands.ts", "src/spaced.ts"]) {
    assert.equal(existsSync(gone), false, gone);
  }
});
