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

test("a fix says how confident it is: title, alias, slug, or alias-slug", () => {
  const pages = PAGES();
  assert.equal(vf.findLinkTarget(pages, "spaced-repetition").confidence, "title");
  assert.equal(vf.findLinkTarget(pages, "spacing effect").confidence, "alias");
  assert.equal(vf.findLinkTarget(pages, "Spaced repetition").confidence, "slug");
  assert.equal(vf.findLinkTarget(pages, "spacing-effect").confidence, "alias-slug");
});

test("planLinkFixes carries the confidence onto each fix and never invents a page", () => {
  const issues = [
    { id: "dead-link", path: "wiki/x.md", title: "x", target: "Spaced repetition" },
    { id: "dead-link", path: "wiki/x.md", title: "x", target: "Nobody Wrote This" },
  ];
  const contents = new Map([["wiki/x.md", "[[Spaced repetition]] and [[Nobody Wrote This]]"]]);
  const plan = vf.planLinkFixes(issues, PAGES(), contents, "wiki");
  assert.equal(plan.fixable.length, 1);
  assert.equal(plan.fixable[0].confidence, "slug");
  assert.equal(plan.unresolved.length, 1, "an unwritten page is reported, never created");
});

// ---------------------------------------------------- unwrapping dead links
// A link to a page nobody wrote cannot be repaired by pointing it somewhere
// else. Unwrapping keeps the words and drops only the brackets, so the
// sentence still reads and nothing the reader wrote is destroyed.

test("unwrapDeadLink keeps the words the reader wrote and drops the brackets", () => {
  const body = "See [[Iterative refinement]] for more.";
  assert.equal(vf.unwrapDeadLink(body, "Iterative refinement"), "See Iterative refinement for more.");
});

test("unwrapDeadLink prefers the display text the author chose", () => {
  const body = "See [[Iterative refinement|refining it step by step]].";
  assert.equal(vf.unwrapDeadLink(body, "Iterative refinement"), "See refining it step by step.");
});

test("unwrapDeadLink shows a path target by its basename, not its folder", () => {
  const body = "- [[concepts/Orchestrator-Workers Pattern]]";
  assert.equal(vf.unwrapDeadLink(body, "concepts/Orchestrator-Workers Pattern"), "- Orchestrator-Workers Pattern");
});

test("unwrapDeadLink leaves a live link and a different dead one alone", () => {
  const body = "[[Spaced repetition]] and [[Iterative refinement]]";
  const out = vf.unwrapDeadLink(body, "Iterative refinement");
  assert.equal(out, "[[Spaced repetition]] and Iterative refinement");
});

test("unwrapDeadLink removes an embed entirely: unwrapped text is not a figure", () => {
  // `![[X]]` transcludes a note. With no note there is nothing to show, and
  // leaving the bare words behind would read as prose the reader never wrote.
  // The line goes with it, rather than being left blank where a figure was.
  const body = "before\n![[Missing figure]]\nafter";
  assert.equal(vf.unwrapDeadLink(body, "Missing figure"), "before\nafter");
});

test("unwrapDeadLink is idempotent and byte-identical when there is nothing to do", () => {
  const body = "See [[Iterative refinement]] for more.";
  const once = vf.unwrapDeadLink(body, "Iterative refinement");
  assert.equal(vf.unwrapDeadLink(once, "Iterative refinement"), once);
  const clean = "Nothing dead here.";
  assert.equal(vf.unwrapDeadLink(clean, "Iterative refinement"), clean);
});

test("unwrapDeadLink drops an anchor: a heading in a page that does not exist", () => {
  assert.equal(vf.unwrapDeadLink("[[Missing#Definition]]", "Missing"), "Missing");
});

// ------------------------------------- what is prose, and what only looks it
// The link scanner in src/graph.ts reads a note as one string, so it reports a
// `[[Missing]]` written inside a code fence as a dead link like any other. That
// is harmless while the only repair rewrites one link into another, but an
// unwrap deletes the syntax, and syntax inside a fence is the content.

test("unwrapDeadLink leaves a link inside a fenced code block alone", () => {
  const body = "Write it like this:\n\n```\n[[Missing]]\n```\n";
  assert.equal(vf.unwrapDeadLink(body, "Missing"), body);
  // Tildes open a fence too, and a fence may be indented inside a list.
  const tilde = "~~~md\n[[Missing]]\n~~~";
  assert.equal(vf.unwrapDeadLink(tilde, "Missing"), tilde);
});

test("unwrapDeadLink leaves a link inside an inline code span alone", () => {
  const body = "Type `[[Missing]]` to link it.";
  assert.equal(vf.unwrapDeadLink(body, "Missing"), body);
});

test("unwrapDeadLink leaves frontmatter alone: a link property is not prose", () => {
  // `related: "[[X]]"` is a typed property Dataview and Bases query. Stripping
  // the brackets turns a link into a meaningless string.
  const body = '---\nrelated: "[[Missing]]"\n---\n\nSee [[Missing]].';
  assert.equal(vf.unwrapDeadLink(body, "Missing"), '---\nrelated: "[[Missing]]"\n---\n\nSee Missing.');
});

test("unwrapDeadLink still unwraps prose that follows a code block", () => {
  const body = "```\ncode\n```\n\nSee [[Missing]] here.";
  assert.equal(vf.unwrapDeadLink(body, "Missing"), "```\ncode\n```\n\nSee Missing here.");
});

test("a dead embed that is a whole line takes its line with it", () => {
  // Returning "" alone would leave "- " behind, which renders as a stray
  // bullet: a repair that visibly damages the note it claims to tidy.
  assert.equal(vf.unwrapDeadLink("- ![[Missing]]\n- next", "Missing"), "- next");
  assert.equal(vf.unwrapDeadLink("before\n\n![[Missing]]\n\nafter", "Missing"), "before\n\nafter");
  // Inline in a sentence, it is not the line, so only the embed goes.
  assert.equal(vf.unwrapDeadLink("see ![[Missing]] there", "Missing"), "see  there");
});

test("a link target holding regex metacharacters is matched literally", () => {
  // The target is compared as a string, never interpolated into a pattern.
  assert.equal(vf.unwrapDeadLink("[[C++ (lang)]]", "C++ (lang)"), "C++ (lang)");
  assert.equal(vf.unwrapDeadLink("[[a.b*c]]", "a.b*c"), "a.b*c");
});

test("an empty display or basename falls back to the words, never to nothing", () => {
  assert.equal(vf.unwrapDeadLink("x [[Missing|   ]] y", "Missing"), "x Missing y");
  assert.equal(vf.unwrapDeadLink("[[folder/]]", "folder/"), "folder/");
});

// ------------------------------------------- repairs agree on what prose is

test("applyLinkFix leaves a link inside a fence or a code span alone", () => {
  // The two repairs in this file must agree about what prose is. `unwrapDeadLink`
  // already honours the mask; a relink that rewrites the example inside a ```md
  // fence edits documentation while reporting a repair on a link.
  const body = "Docs:\n\n```md\n[[Missing]]\n```\n\ninline `[[Missing]]` too.\n";
  assert.equal(vf.applyLinkFix(body, "Missing", "[[concepts/real|Real]]"), body);
});

test("applyLinkFix leaves a link in the frontmatter alone", () => {
  const body = '---\nrelated: "[[Missing]]"\n---\n\nSee [[Missing]].\n';
  assert.equal(
    vf.applyLinkFix(body, "Missing", "[[concepts/real|Real]]"),
    '---\nrelated: "[[Missing]]"\n---\n\nSee [[concepts/real|Real]].\n',
  );
});

test("applyLinkFix still rewrites prose that follows a code block", () => {
  const body = "```\ncode\n```\n\nSee [[Missing]] here.";
  assert.equal(
    vf.applyLinkFix(body, "Missing", "[[concepts/real|Real]]"),
    "```\ncode\n```\n\nSee [[concepts/real|Real]] here.",
  );
});

// --------------------------------------------------- display text is escaped

test("buildReplacement escapes a heading that itself holds a wikilink", () => {
  // `]]` inside the display text closes the link early, leaving permanently
  // broken markup that no later repair can recognise or undo.
  const page = { path: "wiki/concepts/y.md", title: "y", displayTitle: "See [[Other]]", aliases: [] };
  const rep = vf.buildReplacement(page, "wiki/");
  assert.ok(!/\]\]/.test(rep.slice(2, -2)), `display text still closes the link: ${rep}`);
  // Applying it yields one well-formed link, not a nest of them.
  const out = vf.applyLinkFix("A [[Missing]] b.\n", "Missing", rep);
  assert.equal(out.match(/\[\[/g).length, 1);
  assert.equal(out.match(/\]\]/g).length, 1);
});

test("buildReplacement escapes a pipe in the display text", () => {
  // A second `|` makes Obsidian read everything after it as a further field,
  // so the reader sees a truncated name.
  const page = { path: "wiki/concepts/z.md", title: "z", displayTitle: "A|B", aliases: [] };
  const rep = vf.buildReplacement(page, "wiki/");
  assert.equal(rep.split("|").length, 2, `display text holds a second pipe: ${rep}`);
});

test("buildReplacement leaves an ordinary heading untouched", () => {
  const page = { path: "wiki/concepts/y.md", title: "y", displayTitle: "Spaced repetition", aliases: [] };
  assert.equal(vf.buildReplacement(page, "wiki/"), "[[concepts/y|Spaced repetition]]");
});

// ------------------------------------------------ unwrap: the leftover bullet

test("a dead embed on the last line takes its bullet with it", () => {
  // The comment above the embed branch promises the bullet goes. Without a
  // trailing newline the line is still the whole line, so "- " must not survive.
  assert.equal(vf.unwrapDeadLink("- ![[Missing]]", "Missing"), "");
  assert.equal(vf.unwrapDeadLink("before\n\n- ![[Missing]]", "Missing"), "before\n\n");
  // Inline in a sentence it is not the line, so only the embed goes.
  assert.equal(vf.unwrapDeadLink("see ![[Missing]]", "Missing"), "see ");
});

test("unwrapDeadLink leaves a link in a four-space indented code block alone", () => {
  // An indented code block is a code block. Unwrapping the example inside one
  // is the exact failure the prose mask exists to prevent.
  const body = "Example:\n\n    [[Missing]]\n\nend.\n";
  assert.equal(vf.unwrapDeadLink(body, "Missing"), body);
});

test("an indented continuation line under a list item is still prose", () => {
  // Four spaces under a bullet is a wrapped list item, not a code block, so a
  // dead link there must still be unwrapped.
  const body = "- a point\n    [[Missing]] continues it.\n";
  assert.equal(vf.unwrapDeadLink(body, "Missing"), "- a point\n    Missing continues it.\n");
});
