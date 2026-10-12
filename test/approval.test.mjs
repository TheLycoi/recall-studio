// Run with: npm test  (reads the sources as text)
//
// The approval gate is a property of the whole plugin, not one function, so it
// is pinned with source scan across files:
//   - `approved` is written by exactly one file: the inbox view, behind an
//     explicit Approve action. No generator, store or migration path may write
//     it, or a card could become exportable without the reviewer's consent.
//   - the export funnel in main.ts is a strict equality allowlist on
//     "approved", not a denylist that would let drafts through.
//   - nothing approves existing pending cards on load.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const srcFiles = readdirSync("src").filter((n) => n.endsWith(".ts"));
const read = (f) => readFileSync(`src/${f}`, "utf8");

test("only the explicit export acceptance helper writes approved", () => {
  const writers = srcFiles.filter((f) => /status\s*=\s*"approved"/.test(read(f)));
  assert.deepEqual(writers, ["cardActions.ts"], `approved is written by ${writers.join(", ")}`);
});

test("the export funnel requires explicit acceptance", () => {
  const main = read("main.ts");
  assert.match(main, /exportCandidates\(list, ids\)/);
  assert.match(main, /withExportAcceptance\(items/);
  const view = read("inboxView.ts");
  assert.doesNotMatch(view, /text: "(?:Approve|Unapprove)/);
  assert.doesNotMatch(view, /case "a":/);
  assert.doesNotMatch(view, /else if \(c\.critiqueRan\)/);
});

test("neither the generator nor the store ever approves a card", () => {
  for (const f of ["generator.ts", "store.ts", "inboxData.ts"]) {
    assert.equal(/status\s*=\s*"approved"/.test(read(f)), false, f);
  }
});

test("a rewrite and a manual edit both invalidate an approval", () => {
  // The approved wording is the stored wording; any change to it returns the
  // card to draft so it must be approved again before it exports.
  const view = read("inboxView.ts");
  assert.match(view, /c\.status === "flagged" \|\| c\.status === "approved"\) c\.status = "pending"/);
  const invalidations = view.match(/status === "approved"\) c\.status = "pending"/g) ?? [];
  assert.ok(invalidations.length >= 2, "edit and rewrite must each invalidate an approval");
});
