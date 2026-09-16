// Run with: npm test. Bundles src/vaultFix.ts, which is pure — no `obsidian`
// import — so esbuild can hand it to plain node.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let vf;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wikilm-fix-"));
  const out = path.join(dir, "vaultFix.mjs");
  await build({ entryPoints: ["src/vaultFix.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  vf = await import(pathToFileURL(out).href);
});

const PAGES = () => [
  { path: "wiki/concepts/spaced-repetition.md", title: "spaced-repetition", displayTitle: "Spaced repetition", aliases: ["spacing effect"] },
  { path: "wiki/concepts/mnemonic-medium.md", title: "mnemonic-medium", displayTitle: "Mnemonic medium", aliases: [] },
  { path: "wiki/entities/andy-matuschak.md", title: "andy-matuschak", displayTitle: "Andy Matuschak", aliases: ["Matuschak"] },
];

test("nameKey folds spacing, case and punctuation to one key", () => {
  assert.equal(vf.nameKey("Spaced repetition"), "spaced-repetition");
  assert.equal(vf.nameKey("spaced-repetition"), "spaced-repetition");
  assert.equal(vf.nameKey("Spaced  Repetition"), "spaced-repetition");
  // Characters a filename cannot hold are dropped, not turned into dashes.
  assert.equal(vf.nameKey("Prompts, revisited"), "prompts-revisited");
});

test("a link written in prose finds the slug file", () => {
  // The reported shape: links say "Spaced repetition", the file is a slug.
  const hit = vf.findLinkTarget(PAGES(), "Spaced repetition");
  assert.equal(hit.page.path, "wiki/concepts/spaced-repetition.md");
  assert.equal(hit.ambiguous, false);
  // A folder-qualified target resolves by its basename too.
  assert.equal(vf.findLinkTarget(PAGES(), "concepts/Spaced repetition").page.path, "wiki/concepts/spaced-repetition.md");
});

test("an alias resolves, and an exact title outranks an alias on another page", () => {
  assert.equal(vf.findLinkTarget(PAGES(), "spacing effect").page.path, "wiki/concepts/spaced-repetition.md");
  const pages = [
    { path: "wiki/a.md", title: "borrowed", displayTitle: "Borrowed", aliases: [] },
    { path: "wiki/b.md", title: "other", displayTitle: "Other", aliases: ["borrowed"] },
  ];
  // Tier 1 (exact title) must win over tier 2 (alias) on a different page.
  assert.equal(vf.findLinkTarget(pages, "borrowed").page.path, "wiki/a.md");
});

test("two pages with equal claim are ambiguous, not silently picked", () => {
  const pages = [
    { path: "wiki/concepts/routing.md", title: "routing", displayTitle: "Routing", aliases: [] },
    { path: "wiki/entities/routing.md", title: "Routing", displayTitle: "Routing", aliases: [] },
  ];
  assert.equal(vf.findLinkTarget(pages, "ROUTING").ambiguous, true);
});

test("a target nothing matches returns null", () => {
  assert.equal(vf.findLinkTarget(PAGES(), "Iterative refinement"), null);
});

test("the replacement carries the page's heading, not its filename", () => {
  const page = PAGES()[0];
  assert.equal(vf.buildReplacement(page, "wiki/"), "[[concepts/spaced-repetition|Spaced repetition]]");
});

test("a link the author named keeps that name; only the path changes", () => {
  const body = "See [[Spaced repetition]] and [[Spaced repetition|the spacing effect]].";
  const out = vf.applyLinkFix(body, "Spaced repetition", "[[concepts/spaced-repetition|Spaced repetition]]");
  // First occurrence takes the page's own title, the second keeps the prose.
  assert.equal(
    out,
    "See [[concepts/spaced-repetition|Spaced repetition]] and [[concepts/spaced-repetition|the spacing effect]].",
  );
});

test("an embed stays an embed and an anchor survives", () => {
  const body = "![[Spaced repetition]]\n[[Spaced repetition#Definition]]";
  const out = vf.applyLinkFix(body, "Spaced repetition", "[[concepts/spaced-repetition|Spaced repetition]]");
  assert.ok(out.startsWith("![[concepts/spaced-repetition|Spaced repetition]]"), out);
  assert.ok(out.includes("[[concepts/spaced-repetition#Definition|Spaced repetition]]"), out);
});

test("a different target on the same line is untouched", () => {
  const body = "[[Spaced repetition]] and [[Mnemonic medium]]";
  const out = vf.applyLinkFix(body, "Spaced repetition", "[[concepts/spaced-repetition|Spaced repetition]]");
  assert.ok(out.includes("[[Mnemonic medium]]"), out);
});

test("planLinkFixes separates what can be repaired from what cannot", () => {
  const issues = [
    { id: "dead-link", path: "wiki/concepts/chunking.md", title: "chunking", target: "Spaced repetition" },
    { id: "dead-link", path: "wiki/concepts/chunking.md", title: "chunking", target: "Iterative refinement" },
    { id: "ungrounded-quote", path: "wiki/concepts/chunking.md", title: "chunking", detail: "a quote" },
  ];
  const contents = new Map([["wiki/concepts/chunking.md", "[[Spaced repetition]] [[Iterative refinement]]"]]);
  const plan = vf.planLinkFixes(issues, PAGES(), contents, "wiki/");
  assert.equal(plan.fixable.length, 1);
  assert.equal(plan.fixable[0].toPath, "wiki/concepts/spaced-repetition.md");
  // A page nobody has written is a decision, never an automatic repair.
  assert.equal(plan.unresolved.length, 1);
  assert.equal(plan.unresolved[0].target, "Iterative refinement");
  // Only dead links are considered; a quote finding is not a link fix.
  assert.ok(plan.fixable.every((f) => f.from !== "a quote"));
});

test("a link already pointing at its page is not rewritten forever", () => {
  const issues = [{ id: "dead-link", path: "wiki/n.md", title: "n", target: "concepts/spaced-repetition" }];
  const contents = new Map([["wiki/n.md", "[[concepts/spaced-repetition|Spaced repetition]]"]]);
  const plan = vf.planLinkFixes(issues, PAGES(), contents, "wiki/");
  assert.equal(plan.fixable.length, 0);
});

test("applyFixesToNote applies every fix for one note in one pass", () => {
  const body = "[[Spaced repetition]] and [[Mnemonic medium]]";
  const out = vf.applyFixesToNote(body, [
    { path: "n", from: "Spaced repetition", toPath: "x", to: "[[concepts/spaced-repetition|Spaced repetition]]" },
    { path: "n", from: "Mnemonic medium", toPath: "y", to: "[[concepts/mnemonic-medium|Mnemonic medium]]" },
  ]);
  assert.equal(out, "[[concepts/spaced-repetition|Spaced repetition]] and [[concepts/mnemonic-medium|Mnemonic medium]]");
});
