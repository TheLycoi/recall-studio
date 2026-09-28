// Run with: npm test. Bundles src/fixer.ts with `obsidian` stubbed out: the
// module's vault half (TFile, pdf.js) is never reached by what is tested here,
// which is the readiness check, the kind callback, and the model review's
// orchestration against a fake client.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let fx;
let CancelToken;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wikilm-fixer-"));
  const stub = {
    name: "obsidian-stub",
    setup(b) {
      b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: "module.exports = new Proxy({}, { get: (t, k) => (k === '__esModule' ? false : class {}) });",
        loader: "js",
      }));
    },
  };
  const out = path.join(dir, "fixer.mjs");
  await build({ entryPoints: ["src/fixer.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent", plugins: [stub] });
  fx = await import(pathToFileURL(out).href);
  const cancelOut = path.join(dir, "cancel.mjs");
  await build({ entryPoints: ["src/cancel.ts"], bundle: true, format: "esm", platform: "node", outfile: cancelOut, logLevel: "silent" });
  ({ CancelToken } = await import(pathToFileURL(cancelOut).href));
});

const SETTINGS = {
  provider: "anthropic",
  apiKey: "",
  model: "claude",
  geminiApiKey: "",
  geminiModel: "gemini",
  codexModel: "gpt",
  claudeCliModel: "sonnet",
  rolesEnabled: false,
  roles: { lint: { provider: "default", model: "" }, query: { provider: "default", model: "" }, digest: { provider: "default", model: "" } },
  wikiConceptsFolder: "wiki/concepts",
  wikiEntitiesFolder: "wiki/entities",
};
const none = () => ({ key: "", source: "none" });
const from = (source) => () => ({ key: "k", source });

// ---- providerReady

test("providerReady counts a key the keychain holds, not only the settings field", () => {
  assert.equal(fx.providerReady(SETTINGS, "lint", { anthropic: from("keychain"), gemini: none }), true);
  assert.equal(fx.providerReady(SETTINGS, "lint", { anthropic: none, gemini: from("keychain") }), false, "the gemini key does not ready anthropic");
});

test("providerReady says gemini with no key is not ready, and the CLI providers always are", () => {
  const gemini = { ...SETTINGS, provider: "gemini" };
  assert.equal(fx.providerReady(gemini, "lint", { anthropic: from("settings"), gemini: none }), false);
  assert.equal(fx.providerReady(gemini, "lint", { anthropic: none, gemini: from("environment") }), true);
  for (const provider of ["codex", "claudecli"]) {
    assert.equal(fx.providerReady({ ...SETTINGS, provider }, "lint", { anthropic: none, gemini: none }), true, provider);
  }
});

test("providerReady asks the provider the lint role runs on, not the main one", () => {
  const roles = (provider) => ({ ...SETTINGS.roles, lint: { provider, model: "" } });
  // Main anthropic with no key, lint on codex: ready.
  const onCodex = { ...SETTINGS, rolesEnabled: true, roles: roles("codex") };
  assert.equal(fx.providerReady(onCodex, "lint", { anthropic: none, gemini: none }), true);
  assert.equal(fx.providerReady(onCodex, "query", { anthropic: none, gemini: none }), false, "the query role still follows the main provider");
  // Main codex, lint on gemini with no key: not ready.
  const onGemini = { ...SETTINGS, provider: "codex", rolesEnabled: true, roles: roles("gemini") };
  assert.equal(fx.providerReady(onGemini, "lint", { anthropic: none, gemini: none }), false);
  // Roles switched off: the lint role is the main provider again.
  assert.equal(fx.providerReady({ ...onGemini, rolesEnabled: false }, "lint", { anthropic: none, gemini: none }), true);
});

// ---- the kind callback

const page = (p, front, body = "") => ({ path: p, content: `---\n${front}\n---\n${body}` });

test("reviewKindOf reads both schemas: type: on karpathy pages, class: on class pages", () => {
  const pages = [
    page("wiki/concepts/a.md", "type: concept"),
    page("wiki/entities/b.md", "type: entity"),
    page("classes/X/c.md", "class: HBIO250"),
    page("classes/X/X.md", "type: topic-index\nclass: HBIO250"),
    page("wiki/sources/s.md", "type: source"),
    page("wiki/log.md", "updated: today"),
  ];
  const kindOf = fx.reviewKindOf(fx.pageInfos({ settings: SETTINGS }, pages));
  assert.deepEqual(pages.map((p) => kindOf(p.path)), ["concept", "entity", "concept", "other", "other", "other"]);
  assert.equal(kindOf("wiki/unknown.md"), "other");
});

// ---- the model review

const ALPHA = page("wiki/concepts/a.md", "type: concept", '# Alpha\n\nAlpha is fast. Beta made it.\n\n## Mentions in Source\n\n- "Alpha runs quickly."\n');
const BETA = page("wiki/entities/b.md", "type: entity", "# Beta\n\nA person.\n");
const GAMMA = page("wiki/concepts/c.md", "type: concept", "# Gamma\n\nAnother name for Alpha.\n");
const SOURCE = page("wiki/sources/s.md", "type: source", "# Source\n");
const PAGES = [ALPHA, BETA, GAMMA, SOURCE];
const REPORT = () => ({
  notes: 4,
  units: 1,
  issues: [{ id: "orphan", path: ALPHA.path, title: "a" }],
  candidates: [],
  claims: [{ path: ALPHA.path, title: "a", n: 1, text: "Alpha is fast." }],
});

function fakeLlm(over = {}) {
  const calls = { scanTitles: [], verifyDuplicates: [], reviewPages: [] };
  const llm = {
    async scanTitles(args) {
      calls.scanTitles.push(args);
      return { pairs: [{ a: "Alpha", b: "Gamma", reason: "one is another name for the other" }] };
    },
    async verifyDuplicates(args) {
      calls.verifyDuplicates.push(args);
      return { pairs: args.pairs.map((p) => ({ n: p.n, same: true, reason: "one subject" })) };
    },
    async reviewPages(args) {
      calls.reviewPages.push(args);
      return {
        pages: args.pages.map((p) => ({
          title: p.title,
          kind: p.title === "Alpha" ? { kind: "entity", reason: "reads as a person" } : null,
          claims: p.claims.map((c) => ({ n: c.n, supported: false, by: "", reason: "not stated" })),
          links: p.title === "Alpha" ? [{ target: "Beta", reason: "names Beta" }, { target: "Nowhere", reason: "x" }] : [],
        })),
      };
    },
    ...over,
  };
  return { llm, calls };
}

function run(llm, { pages = PAGES, report = REPORT(), cancel, status = () => {} } = {}) {
  const plugin = { settings: SETTINGS, llm };
  const infos = fx.pageInfos(plugin, pages);
  return fx.runModelReview(plugin, { report, pages, sources: new Map(), prefix: "wiki/" }, infos, status, cancel);
}

test("runModelReview runs the three phases and returns findings, rows and one line", async () => {
  const { llm, calls } = fakeLlm();
  const statuses = [];
  const r = await run(llm, { status: (s) => statuses.push(s) });

  // 2a: the scan saw the concept and entity pages only.
  assert.deepEqual(calls.scanTitles[0].pages.map((p) => p.title), ["Alpha", "Gamma", "Beta"], "by path; the source page is not a subject");
  // 2b: the scan's pair went to the duplicate check and came back confirmed.
  assert.equal(calls.verifyDuplicates.length, 1);
  assert.equal(calls.verifyDuplicates[0].pairs.length, 1);
  // 2c: one page with a finding, one call, the directory sent with it.
  assert.equal(calls.reviewPages.length, 1);
  assert.deepEqual(calls.reviewPages[0].pages.map((p) => p.title), ["Alpha"]);
  assert.ok(statuses.includes("model review: page 1 of 1"), statuses.join(" | "));

  assert.deepEqual(r.issues.map((i) => i.id).sort(), ["duplicate-pages", "missing-link", "unsupported-prose", "wrong-kind"]);
  assert.deepEqual(r.candidates, [], "a confirmed candidate is a finding now, not a candidate");
  assert.deepEqual(r.cleared, []);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.rows.map((f) => `${f.kind} ${f.path}`), [
    "kind wiki/concepts/a.md",
    "cross-link wiki/concepts/a.md",
    "cross-link wiki/concepts/c.md",
    // Alpha is an orphan, so its nomination is applied on Beta, linking back.
    "add-link wiki/entities/b.md",
  ]);
  assert.equal(r.rows.find((f) => f.kind === "kind").enabled, false);
  assert.equal(r.line, "**Model review** — read 1 of 1 page with findings; 4 findings; 1 proposal dropped (1 target not in wiki).");
});

test("a phase that throws is one entry in failed, and the others still run", async () => {
  const { llm, calls } = fakeLlm({
    async scanTitles() {
      throw new Error("boom");
    },
  });
  const r = await run(llm);
  assert.deepEqual(r.failed, ["title scan failed: boom"]);
  assert.equal(calls.verifyDuplicates.length, 0, "no pairs to check without the scan");
  assert.ok(r.issues.some((i) => i.id === "missing-link"), "the page review still ran");
  assert.match(r.line, /; title scan failed: boom\.$/);

  const { llm: llm2 } = fakeLlm({
    async reviewPages() {
      throw new Error("timeout");
    },
  });
  const r2 = await run(llm2);
  assert.deepEqual(r2.failed, ["page review failed: timeout"]);
  assert.ok(r2.issues.some((i) => i.id === "duplicate-pages"), "the duplicate check's finding survives the review failing");
  assert.match(r2.line, /read 0 of 1 page with findings/);
});

test("a cancel stops the page review between batches and says how far it got", async () => {
  const many = Array.from({ length: 7 }, (_, i) => page(`wiki/concepts/p${i}.md`, "type: concept", `# P${i}\n\nText.\n`));
  const report = { notes: 7, units: 0, issues: many.map((p) => ({ id: "orphan", path: p.path, title: p.path })), candidates: [], claims: [] };
  const cancel = new CancelToken();
  cancel.begin("lint");
  const { llm, calls } = fakeLlm({
    async scanTitles() {
      return { pairs: [] };
    },
    async reviewPages(args) {
      calls.reviewPages.push(args);
      cancel.cancel();
      return { pages: [] };
    },
  });
  const statuses = [];
  const r = await run(llm, { pages: many, report, cancel, status: (s) => statuses.push(s) });
  assert.equal(calls.reviewPages.length, 1);
  assert.equal(calls.reviewPages[0].pages.length, 5, "five pages per call");
  assert.deepEqual(r.failed, ["page review stopped after 1 of 2 batches"]);
  assert.match(r.line, /read 5 of 7 pages with findings/);
  assert.ok(statuses.includes("model review: page 1 of 7"));
});

test("a cancel before a phase starts stops it at 0 batches, and later phases say so too", async () => {
  const cancel = new CancelToken();
  cancel.begin("lint");
  cancel.cancel();
  const { llm, calls } = fakeLlm();
  const r = await run(llm, { cancel });
  assert.equal(calls.scanTitles.length + calls.verifyDuplicates.length + calls.reviewPages.length, 0);
  assert.deepEqual(r.failed, ["title scan stopped after 0 of 1 batch", "page review stopped after 0 of 1 batch"]);
});

test("verifyDuplicates returns the pairs it confirmed as findings", async () => {
  const { llm } = fakeLlm();
  const plugin = { settings: SETTINGS, llm };
  const infos = fx.pageInfos(plugin, PAGES);
  const report = { ...REPORT(), candidates: [{ a: ALPHA.path, b: GAMMA.path, pass: "similar", detail: "spelled alike" }] };
  const v = await fx.verifyDuplicates(plugin, infos, report, "wiki/");
  assert.equal(v.confirmed, 1);
  assert.deepEqual(v.issues.map((i) => [i.id, i.path, i.target]), [["duplicate-pages", ALPHA.path, GAMMA.path]]);
  assert.equal(v.rows.length, 2);
});
