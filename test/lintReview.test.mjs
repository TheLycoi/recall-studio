// Run with: npm test  (bundles src/lintReview.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let lr;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-lreview-"));
  const out = path.join(dir, "lintReview.mjs");
  await build({ entryPoints: ["src/lintReview.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  lr = await import(pathToFileURL(out).href);
});

const note = (p, front, body) => ({ path: p, content: `---\n${front}\n---\n${body}` });
const issue = (id, p) => ({ id, path: p, title: p.replace(/^.*\//, "").replace(/\.md$/, "") });
const report = (issues, claims = []) => ({ notes: 0, units: 0, issues, candidates: [], claims });
// The caller's kind callback, as a karpathy vault would answer it: `type:` decides.
const byType = (pages) => (p) => {
  const t = /^type:\s*(\S+)/m.exec(pages.find((x) => x.path === p)?.content ?? "")?.[1];
  return t === "concept" || t === "entity" ? t : "other";
};

// ---- selectPages

test("selectPages takes pages with a finding or a residue claim, worst finding first, then path", () => {
  const pages = ["wiki/a.md", "wiki/b.md", "wiki/c.md", "wiki/d.md", "wiki/e.md"].map((p) => note(p, "type: concept", "Body."));
  const r = report(
    [issue("empty-note", "wiki/a.md"), issue("dead-link", "wiki/c.md"), issue("ungrounded-quote", "wiki/d.md"), issue("thin-page", "wiki/c.md")],
    [{ path: "wiki/b.md", title: "b", n: 1, text: "A sentence." }],
  );
  const got = lr.selectPages(r, pages);
  assert.deepEqual(got.chosen.map((p) => p.path), ["wiki/d.md", "wiki/c.md", "wiki/a.md", "wiki/b.md"], "e has nothing to review; b has only residue, so it comes after every page with a finding");
  assert.equal(got.skipped, 0);
});

test("selectPages stops at the budget and counts the rest as skipped", () => {
  const pages = ["wiki/a.md", "wiki/b.md", "wiki/c.md"].map((p) => note(p, "type: concept", "x".repeat(40)));
  const r = report(["wiki/a.md", "wiki/b.md", "wiki/c.md"].map((p) => issue("orphan", p)));
  const got = lr.selectPages(r, pages, 85);
  assert.deepEqual(got.chosen.map((p) => p.path), ["wiki/a.md", "wiki/b.md"]);
  assert.equal(got.skipped, 1);
});

test("selectPages with a kind callback leaves out pages the review cannot judge", () => {
  const pages = [note("wiki/sources/s.md", "type: source", "Body."), note("wiki/a.md", "type: entity", "Body.")];
  const r = report([issue("dead-link", "wiki/sources/s.md"), issue("dead-link", "wiki/a.md")]);
  assert.deepEqual(lr.selectPages(r, pages, 60_000, byType(pages)).chosen.map((p) => p.path), ["wiki/a.md"]);
});

test("a class-schema page, with class: and no type:, is selected and reviewed as the kind the callback gives", () => {
  const pages = [note("classes/X/doping.md", "class: HBIO250", "# Doping\n\nProse."), note("classes/X/X.md", "type: topic-index\nclass: HBIO250", "# X")];
  const kindOf = (p) => (p === "classes/X/doping.md" ? "concept" : "other");
  const r = report([issue("orphan", "classes/X/doping.md"), issue("orphan", "classes/X/X.md")]);
  const { chosen } = lr.selectPages(r, pages, 60_000, kindOf);
  assert.deepEqual(chosen.map((p) => p.path), ["classes/X/doping.md"]);
  const inputs = lr.buildReviewInputs(r, chosen, kindOf);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].kind, "concept");
  assert.equal(inputs[0].title, "Doping");
  assert.deepEqual(lr.directoryOf(pages, kindOf), [{ title: "Doping", kind: "concept", aliases: [] }], "a hub is not a page to link to or pair by name");
});

// ---- clampBody

test("clampBody strips frontmatter and returns a short page whole", () => {
  const got = lr.clampBody("---\ntype: concept\n---\n# T\n\nShort body.\n\n## More\nText.");
  assert.equal(got.body, "# T\n\nShort body.\n\n## More\nText.");
  assert.deepEqual(got.omitted, []);
});

test("clampBody drops whole sections from the end and names them", () => {
  const md = `# T\n\n${"a".repeat(50)}\n\n## One\n${"b".repeat(50)}\n\n## Two\n${"c".repeat(50)}\n\n## Three\n${"d".repeat(50)}\n`;
  const got = lr.clampBody(md, 130);
  assert.ok(got.body.length <= 130, String(got.body.length));
  assert.match(got.body, /## One/);
  assert.doesNotMatch(got.body, /## Two|ccc/);
  assert.deepEqual(got.omitted, ["Two", "Three"]);
});

test("clampBody ignores a ## line inside a code fence", () => {
  const md = `# T\n\n\`\`\`\n## not a heading\n${"z".repeat(80)}\n\`\`\`\n\n## Real\n${"r".repeat(80)}`;
  const got = lr.clampBody(md, 120);
  assert.deepEqual(got.omitted, ["Real"]);
});

test("clampBody cuts a page with no ## boundary mid-page and says so", () => {
  const got = lr.clampBody(`# T\n\n${"w ".repeat(100)}`, 60);
  assert.equal(got.body.length, 60);
  assert.deepEqual(got.omitted, ["(cut mid-page)"]);
});

// ---- directoryOf

test("directoryOf names each page by its H1 or basename, with kind and aliases, and caps by entries and characters", () => {
  const pages = [
    note("wiki/concepts/spaced-repetition.md", 'type: concept\naliases: ["SRS", "Spacing"]', "# Spaced repetition\n\nBody."),
    note("wiki/entities/SuperMemo.md", "type: entity", "No heading here."),
  ];
  assert.deepEqual(lr.directoryOf(pages, byType(pages)), [
    { title: "Spaced repetition", kind: "concept", aliases: ["SRS", "Spacing"] },
    { title: "SuperMemo", kind: "entity", aliases: [] },
  ]);
  assert.equal(lr.directoryOf(pages, byType(pages), 1).length, 1);
  assert.equal(lr.directoryOf(pages, byType(pages), 400, 50).length, 1, "the second entry would pass 50 characters");
});

// ---- buildReviewInputs

test("buildReviewInputs assembles what the model sees per page and skips pages of other kinds", () => {
  const a = note("wiki/concepts/a.md", 'type: concept\ntags: [method, term]\naliases: ["Alpha"]', "# A page\n\nProse. [[Other Page]] and [[concepts/b|Bee]].");
  const s = note("wiki/sources/s.md", "type: source", "# S\n\nProse.");
  const r = report([], [{ path: "wiki/concepts/a.md", title: "a", n: 1, text: "Prose sentence one." }, { path: "wiki/sources/s.md", title: "s", n: 1, text: "x" }]);
  assert.deepEqual(lr.buildReviewInputs(r, [a, s], byType([a, s])), [
    {
      title: "A page",
      kind: "concept",
      tags: ["method", "term"],
      aliases: ["Alpha"],
      body: "# A page\n\nProse. [[Other Page]] and [[concepts/b|Bee]].",
      omitted: [],
      claims: [{ n: 1, text: "Prose sentence one." }],
      linked: ["other-page", "b"],
    },
  ]);
});

// ---- verifyReview

const UNITS = { "wiki/concepts/a.md": [{ text: "Spacing improves long‑term retention of vocabulary items in adults" }] };
const units = (p) => UNITS[p] ?? [];
const DIRECTORY = [
  { title: "A page", kind: "concept", aliases: [] },
  { title: "Spaced repetition", kind: "concept", aliases: ["SRS"] },
  { title: "Other Page", kind: "entity", aliases: [] },
];
const BY_KEY = new Map([
  ["a-page", { path: "wiki/concepts/a.md", title: "A page" }],
  ["spaced-repetition", { path: "wiki/concepts/spaced-repetition.md", title: "Spaced repetition" }],
  ["other-page", { path: "wiki/entities/other-page.md", title: "Other Page" }],
]);
const SENT = [
  {
    title: "A page",
    kind: "concept",
    tags: [],
    aliases: [],
    body: "",
    omitted: [],
    claims: [
      { n: 1, text: "Spacing helps adults keep vocabulary." },
      { n: 2, text: "Massed practice fades within weeks." },
      { n: 3, text: "Sleep consolidates memory overnight." },
    ],
    linked: ["other-page"],
  },
];
const verdict = (over) => ({ title: "A page", kind: null, claims: [], links: [], ...over });
const run = (out) => lr.verifyReview(SENT, out, DIRECTORY, BY_KEY, units);

test("a supported claim whose quote is on the page is cleared, folded for case, spacing and curly quotes", () => {
  const got = run([verdict({ claims: [{ n: 1, supported: true, by: "  “Spacing   IMPROVES long‑term retention”", reason: "the key claim" }] })]);
  assert.deepEqual(got.issues, []);
  assert.deepEqual(got.dropped, {});
});

test("a supported claim whose quote is not on the page stays an issue and is counted", () => {
  const got = run([verdict({ claims: [{ n: 1, supported: true, by: "adults keep vocabulary", reason: "" }] })]);
  assert.equal(got.issues.length, 1);
  assert.deepEqual(got.issues[0], { id: "unsupported-prose", path: "wiki/concepts/a.md", title: "a", target: undefined, detail: "Spacing helps adults keep vocabulary." });
  assert.deepEqual(got.dropped, { "quote not on page": 1 });
});

test("a quote over twelve words does not count, even when it is on the page", () => {
  const units13 = () => [{ text: "one two three four five six seven eight nine ten eleven twelve thirteen" }];
  const got = lr.verifyReview(SENT, [verdict({ claims: [{ n: 1, supported: true, by: "one two three four five six seven eight nine ten eleven twelve thirteen", reason: "" }] })], DIRECTORY, BY_KEY, units13);
  assert.equal(got.issues.length, 1);
  assert.deepEqual(got.dropped, { "quote not on page": 1 });
});

test("an unsupported claim is an issue; an unknown claim number is dropped; an unjudged claim stays a candidate", () => {
  const got = run([verdict({ claims: [{ n: 2, supported: false, by: "", reason: "no quote says it" }, { n: 9, supported: false, by: "", reason: "" }] })]);
  assert.deepEqual(got.issues.map((i) => i.detail), ["Massed practice fades within weeks."]);
  assert.deepEqual(got.dropped, { "claim not sent": 1 });
});

test("a verdict for a page that was not sent is dropped whole", () => {
  const got = run([verdict({ title: "Nowhere", claims: [{ n: 1, supported: false, by: "", reason: "" }] })]);
  assert.deepEqual(got.issues, []);
  assert.deepEqual(got.dropped, { "page not sent": 1 });
});

test("a link resolves by title or alias; unknown, self and already-linked targets are dropped with their reason", () => {
  const got = run([
    verdict({
      links: [
        { target: "SRS", reason: "the page is about spacing" },
        { target: "Nonexistent", reason: "" },
        { target: "A page", reason: "" },
        { target: "[[Other Page]]", reason: "" },
      ],
    }),
  ]);
  assert.deepEqual(got.links, [{ path: "wiki/concepts/a.md", targetPath: "wiki/concepts/spaced-repetition.md", targetTitle: "Spaced repetition", reason: "the page is about spacing" }]);
  assert.deepEqual(got.issues, [{ id: "missing-link", path: "wiki/concepts/a.md", title: "a", target: "Spaced repetition", detail: "the page is about spacing" }]);
  assert.deepEqual(got.dropped, { "target not in wiki": 1, "self link": 1, "already linked": 1 });
});

test("a kind verdict is a finding only when it differs from the page's kind", () => {
  const same = run([verdict({ kind: { kind: "concept", reason: "it is a method" } })]);
  assert.deepEqual(same.issues, []);
  assert.deepEqual(same.kinds, []);
  const other = run([verdict({ kind: { kind: "entity", reason: "it names a product" } })]);
  assert.deepEqual(other.kinds, [{ path: "wiki/concepts/a.md", kind: "entity", reason: "it names a product" }]);
  assert.deepEqual(other.issues, [{ id: "wrong-kind", path: "wiki/concepts/a.md", title: "a", detail: "concept → entity: it names a product" }]);
});

test("issues come back worst first", () => {
  const got = run([verdict({ kind: { kind: "entity", reason: "r" }, links: [{ target: "SRS", reason: "r" }], claims: [{ n: 3, supported: false, by: "", reason: "" }] })]);
  assert.deepEqual(got.issues.map((i) => i.id), ["unsupported-prose", "wrong-kind", "missing-link"]);
});

// ---- verifyTitleScan

const TITLE_PATHS = new Map([
  ["Spaced repetition", "wiki/concepts/spaced-repetition.md"],
  ["A page", "wiki/concepts/a.md"],
  ["Other Page", "wiki/entities/other-page.md"],
]);

test("verifyTitleScan resolves both titles by title or alias and emits a title candidate", () => {
  const got = lr.verifyTitleScan({ pairs: [{ a: "SRS", b: "A page", reason: "abbreviation" }] }, DIRECTORY, TITLE_PATHS, new Set());
  assert.deepEqual(got.candidates, [
    { a: "wiki/concepts/a.md", b: "wiki/concepts/spaced-repetition.md", pass: "title", detail: "the model reads the titles as one subject: abbreviation" },
  ]);
  assert.deepEqual(got.dropped, {});
});

test("verifyTitleScan drops unknown titles, self pairs, existing pairs and repeats", () => {
  const existing = new Set([lr.pairKey("wiki/entities/other-page.md", "wiki/concepts/a.md")]);
  const got = lr.verifyTitleScan(
    {
      pairs: [
        { a: "Ghost", b: "A page", reason: "" },
        { a: "SRS", b: "Spaced repetition", reason: "" },
        { a: "A page", b: "Other Page", reason: "" },
        { a: "Spaced repetition", b: "Other Page", reason: "first" },
        { a: "Other Page", b: "SRS", reason: "again" },
      ],
    },
    DIRECTORY,
    TITLE_PATHS,
    existing,
  );
  assert.deepEqual(got.candidates.map((c) => c.detail), ["the model reads the titles as one subject: first"]);
  assert.deepEqual(got.dropped, { "title not in wiki": 1, "self pair": 1, "already paired": 2 });
});

// ---- renderReviewLine

test("renderReviewLine says what was read, found and dropped in one line", () => {
  const line = lr.renderReviewLine({ read: 12, withFindings: 15, skipped: 3, findings: 5, dropped: { "already linked": 1, "target not in wiki": 1 }, failed: [] });
  assert.equal(line, "**Model review** — read 12 of 15 pages with findings (3 over budget); 5 findings; 2 proposals dropped (1 target not in wiki, 1 already linked).");
  const quiet = lr.renderReviewLine({ read: 1, withFindings: 1, skipped: 0, findings: 1, dropped: {}, failed: ["title scan failed: HTTP 500"] });
  assert.equal(quiet, "**Model review** — read 1 of 1 page with findings; 1 finding; title scan failed: HTTP 500.");
});

test("renderReviewLine says why the review did not run", () => {
  assert.equal(lr.renderReviewLine({ read: 0, withFindings: 0, skipped: 0, findings: 0, dropped: {}, failed: [], off: "no provider configured" }), "Model review off: no provider configured");
});

// ---- renderReviewTurn

test("renderReviewTurn leads with the review line and lists the new findings in the report's style", () => {
  const line = "**Model review** — read 1 of 1 page with findings; 1 finding.";
  const issues = [{ id: "missing-link", path: "wiki/concepts/a.md", title: "a", target: "Beta", detail: "names Beta" }];
  const got = lr.renderReviewTurn(report([]), issues, line);
  assert.ok(got.startsWith(line), got);
  assert.ok(!got.includes("**Wiki check**"), "the scan's header is the other turn's");
  assert.match(got, /\*\*Missing link: [^*]+\*\* \(1\)\n- \[\[a\]\] → `Beta`: names Beta/);
  assert.equal(lr.renderReviewTurn(report([]), [], line), line, "no findings: the line alone, not the scan's all-clear");
});
