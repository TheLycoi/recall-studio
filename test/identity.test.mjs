// Run with: npm test  (reads the manifest, the package file and the sources as text)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const versions = JSON.parse(readFileSync("versions.json", "utf8"));

test("Recall Studio 0.1.21 preserves the Review Inbox identity", () => {
  assert.equal(manifest.id, "review-inbox");
  assert.equal(manifest.name, "Recall Studio");
  assert.equal(pkg.name, "review-inbox");
  assert.equal(manifest.version, "0.1.21");
  assert.equal(manifest.minAppVersion, "1.7.2");
  assert.equal(manifest.isDesktopOnly, true);
  assert.equal(pkg.version, "0.1.21");
  assert.equal(lock.version, "0.1.21");
  assert.equal(lock.packages[""].version, "0.1.21");
  assert.deepEqual(versions, { "0.1.0": "1.7.2", "0.1.1": "1.7.2", "0.1.2": "1.7.2", "0.1.3": "1.7.2", "0.1.4": "1.7.2", "0.1.5": "1.7.2", "0.1.6": "1.7.2", "0.1.8": "1.7.2", "0.1.9": "1.7.2", "0.1.10": "1.7.2", "0.1.11": "1.7.2", "0.1.12": "1.7.2", "0.1.13": "1.7.2", "0.1.14": "1.7.2", "0.1.15": "1.7.2", "0.1.16": "1.7.2", "0.1.17": "1.7.2", "0.1.18": "1.7.2", "0.1.19": "1.7.2", "0.1.20": "1.7.2", "0.1.21": "1.7.2" });
});

test("the runtime Zod pin includes the GHSA-mrhx-c7xc-m3w5 patch", () => {
  assert.equal(pkg.dependencies.zod, "4.6.6");
  assert.equal(lock.packages[""].dependencies.zod, "4.6.6");
  assert.equal(lock.packages["node_modules/zod"].version, "4.6.6");
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

test("Quiz stays embedded without a dashboard, statistics or scheduler surface", () => {
  const src = readdirSync("src").filter((n) => n.endsWith(".ts"));
  for (const f of src) {
    const text = readFileSync(`src/${f}`, "utf8");
    // Quiz is embedded in Inbox, never registered as a second view.
    assert.equal(/QuizPanel|VIEW_TYPE_QUIZ|VIEW_TYPE_DASHBOARD|DashboardView|StatisticsView/.test(text), false, f);
  }
  // The removed surfaces are gone as files, not merely unregistered.
  for (const gone of ["src/quizPanel.ts", "src/quizPages.ts", "src/chatCommands.ts", "src/spaced.ts"]) {
    assert.equal(existsSync(gone), false, gone);
  }
});

/**
 * Every string literal in a source file, so a comment never counts as
 * user-facing text. Handles `//` and block comments and escaped quotes; regex
 * literals are not modelled, which is fine because the strings they hold are
 * not messages the reader reads.
 */
function stringLiterals(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let buf = "";
      while (j < n && src[j] !== c) {
        if (src[j] === "\\") {
          buf += src[j + 1] ?? "";
          j += 2;
          continue;
        }
        buf += src[j];
        j++;
      }
      out.push(buf);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

test("no string the reader can see still calls the plugin Recall", () => {
  // Internal names (RecallPlugin, RECALL_COMMANDS), the opencode agent id and
  // comments keep their legacy names on purpose. What must say Review Inbox is a
  // string literal the reader reads: a Notice, a ribbon tooltip, a settings
  // description, an error. The one compatibility exception is the legacy
  // keychain service name, which must keep working for a key already saved
  // under it, so that exact phrase is excused.
  const offenders = [];
  for (const f of readdirSync("src").filter((n) => n.endsWith(".ts"))) {
    for (const lit of stringLiterals(readFileSync(`src/${f}`, "utf8"))) {
      if (f === "settings.ts" && lit === "Recall data folder") continue; // The data-path label is not a plugin identity change.
      if (/\bRecall\b/.test(lit.replaceAll("Recall Studio", "").replaceAll("Recall DeepSeek API key", ""))) {
        offenders.push(`${f}: ${JSON.stringify(lit)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `user-facing strings still say Recall:\n${offenders.join("\n")}`);
});

test("the focusable inbox container keeps a visible keyboard focus ring", () => {
  // inboxView.onOpen sets tabIndex = 0 so the j/k keys reach the container; its
  // `outline: none` must be paired with a :focus-visible ring or keyboard focus
  // on the inbox is invisible.
  const rule = /\.wikilm-notebook:focus-visible\s*\{([^}]*)\}/.exec(readFileSync("styles.css", "utf8"));
  assert.ok(rule, "the focusable inbox container has no :focus-visible ring");
  assert.match(rule[1], /outline:\s*[^;]*var\(/, "the ring must draw a visible outline");
  assert.match(rule[1], /--interactive-accent/, "the ring should use the theme's accent colour");
});
