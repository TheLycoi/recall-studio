// Run with: npm test  (bundles src/commandTable.ts, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let t;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "review-inbox-test-"));
  const out = path.join(dir, "commandTable.mjs");
  await build({ entryPoints: ["src/commandTable.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  t = await import(pathToFileURL(out).href);
});

test("the command table holds Review Inbox's commands and nothing else", () => {
  assert.deepEqual(
    t.COMMAND_TABLE.map((c) => c.id),
    [
      "capture-selection",
      "capture-selection-with-instruction",
      "open-inbox",
      "open-source-history",
      "export-reviewed",
      "capture-markdown-highlights",
      "retry-failed",
    ],
  );
});

test("the palette shows five commands", () => {
  assert.equal(t.paletteCommands(t.COMMAND_TABLE).length, 5);
});

test("no command name or alias is a wiki verb", () => {
  for (const c of t.COMMAND_TABLE) {
    const words = [c.name, ...c.aliases].join(" ").toLowerCase();
    assert.doesNotMatch(words, /digest|lint|ingest|ai highlight|wiki/, c.id);
  }
});

test("there is no quiz or spaced-repetition command", () => {
  // Capture, Inbox and Anki export remain; native study entrypoints are retired.
  for (const gone of ["open-chat", "make-flashcards", "open-quiz", "export-spaced", "open-dashboard", "open-review", "statistics"]) {
    assert.ok(!t.COMMAND_TABLE.some((c) => c.id === gone), `${gone} should not exist`);
  }
});

test("the wiki engine and its notices are gone from the repository", () => {
  for (const gone of ["vendor", "src/upstream", "NOTICE", "LICENSE-APACHE-2.0.txt", "src/topicNote.ts", "src/digest.ts", "src/vaultLint.ts", "src/retrieval.ts"]) {
    assert.equal(existsSync(gone), false, gone);
  }
});
