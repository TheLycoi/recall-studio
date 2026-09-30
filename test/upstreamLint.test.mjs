// Run with: npm test. Runs upstream's REAL lint (runLintWiki in
// vendor/llm-wiki/src/wiki/lint/controller.ts), its scan phases and its fix
// runners, through WikiLM's real lint command code (src/upstream/lint.ts), the
// real engine host (src/upstream/host.ts) and the real model adapter
// (src/upstream/llmAdapter.ts), against pages shaped the way WikiLM's digest
// writes them.
//
// What is fake: the vault is an in-memory map (test/memoryVault.mjs),
// `obsidian` is a stub with real TFile/TFolder classes, a recording Notice and
// a Modal that records itself when opened instead of drawing, and the model
// backends are scripts that record the provider and model each call ran on.
// Upstream opens its LintReportModal itself; its buttons call the fix
// callbacks the controller built, so the tests call those same callbacks off
// the recorded modal. Upstream's pauses are cut to zero. No model is called,
// no real vault is touched.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sharedBuildOptions } from "../scripts/esbuild-shared.mjs";
import { memoryVault } from "./memoryVault.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function obsidianStub() {
  const dts = readFileSync(path.join(ROOT, "node_modules/obsidian/obsidian.d.ts"), "utf8");
  const names = new Set();
  const decl = /^export (?:declare )?(?:abstract )?(?:class|function|const|let|var|enum) (\w+)/gm;
  for (const m of dts.matchAll(decl)) names.add(m[1]);
  const special = new Set(["Notice", "Modal", "TFile", "TFolder", "TAbstractFile", "normalizePath"]);
  const plain = [...names].filter((n) => !special.has(n)).map((n) => `export function ${n}() {}`);
  return {
    name: "obsidian-stub",
    setup(b) {
      b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: [
          ...plain,
          "export class Notice { constructor(message, duration) { (globalThis.__notices ??= []).push({ message, duration }); } setMessage() {} hide() {} }",
          "export class Modal { constructor(app) { this.app = app; } open() { (globalThis.__modals ??= []).push(this); } close() {} }",
          "export class TAbstractFile {}",
          "export class TFile extends TAbstractFile {}",
          "export class TFolder extends TAbstractFile { isRoot() { return this.path === '/' || this.path === ''; } }",
          "export function normalizePath(p) { return String(p).replace(/\\\\/g, '/').replace(/\\/+/g, '/').replace(/^\\/|\\/$/g, '') || '/'; }",
        ].join("\n"),
        loader: "js",
      }));
    },
  };
}

let m;
let dir;
const realWindow = globalThis.window;
const quiet = ["debug", "log", "info", "warn", "error"];
const realConsole = Object.fromEntries(quiet.map((k) => [k, console[k]]));
before(async () => {
  // Upstream waits on window.setTimeout between batches.
  globalThis.window = { setTimeout: (fn) => setTimeout(fn, 0), clearTimeout: (h) => clearTimeout(h) };
  // Upstream narrates every step on the console, and logs each refused merge
  // it cannot tell apart from a failure; the assertions read the vault.
  for (const k of quiet) console[k] = () => {};
  dir = mkdtempSync(path.join(tmpdir(), "wikilm-upstream-lint-"));
  const out = path.join(dir, "lint.cjs");
  const shared = sharedBuildOptions();
  await build({
    ...shared,
    stdin: {
      contents: [
        'export * from "./src/upstream/lint.ts";',
        'export { UpstreamHost } from "./src/upstream/host.ts";',
        'export { CancelToken } from "./src/cancel.ts";',
        'export { TFile, TFolder } from "obsidian";',
      ].join("\n"),
      resolveDir: ROOT,
      sourcefile: "upstream-lint-probe.ts",
      loader: "ts",
    },
    outfile: out,
    logLevel: "error",
    external: shared.external.filter((e) => e !== "obsidian"),
    plugins: [obsidianStub(), ...shared.plugins],
  });
  m = createRequire(import.meta.url)(out);
});

after(() => {
  globalThis.window = realWindow;
  Object.assign(console, realConsole);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  globalThis.__notices = [];
  globalThis.__modals = [];
});

const notices = () => globalThis.__notices.map((n) => n.message);

const PLUGIN_DIR = ".obsidian/plugins/wikilm";

// ---- WikiLM around upstream's lint ---------------------------------------------------

/**
 * The reader's settings with model roles on, and lint on a different provider
 * and model from digest and the main provider, so a call that ran on the wrong
 * role shows in what the backends recorded.
 */
function wikilmSettings() {
  return {
    provider: "claudecli",
    model: "claude-api-model",
    geminiModel: "gemini-default",
    codexModel: "codex-default",
    claudeCliModel: "sonnet",
    rolesEnabled: true,
    roles: {
      digest: { provider: "claudecli", model: "opus" },
      query: { provider: "default", model: "" },
      lint: { provider: "codex", model: "gpt-5.5" },
    },
    effort: "high",
    topicFolder: "classes",
    schemaFolder: "wiki/schema",
    exportFolder: "wiki/schema/exports",
    transcriptFolder: "wiki/sources/wispr",
    wikiConceptsFolder: "wiki/concepts",
    wikiEntitiesFolder: "wiki/entities",
  };
}

const LINT_ROLE = { provider: "codex", model: "gpt-5.5" };

/**
 * The reader's plugin: the real host and adapter, with every backend a script.
 * `answer` is handed the prompt the adapter built and returns the model's text;
 * `calls` records the provider and model each call ran on and which prompt it was.
 */
function setup(initial, answer = () => "{}") {
  const { app, files } = memoryVault(initial, m);
  const calls = [];
  const plugin = {
    app,
    manifest: { id: "wikilm", dir: PLUGIN_DIR },
    settings: wikilmSettings(),
    cancel: new m.CancelToken(),
    llm: {
      backendFor: (provider) => ({
        async completeText(req) {
          const kind = promptKind(req.user);
          calls.push({ provider, model: req.model, kind });
          req.onStop?.("end");
          return answer(kind, req);
        },
      }),
    },
  };
  const host = new m.UpstreamHost(plugin);
  plugin.upstreamHost = () => host;
  return { plugin, files, calls };
}

/** Which of upstream's prompts a request is, from the prompt's own opening words (vendor/llm-wiki/src/wiki/prompts). */
function promptKind(user) {
  if (user.includes("suggest alternative names (aliases)")) return "aliases";
  if (user.includes("merging two duplicate pages")) return "merge";
  if (user.includes("Establish backlinks to an orphan page")) return "orphan";
  if (user.includes("dead link repair assistant")) return "dead-link";
  if (user.includes("page expansion assistant")) return "fill";
  if (user.includes("retagging a wiki page")) return "retag";
  if (user.includes("Wiki Schema advisor")) return "schema";
  if (/duplicate/i.test(user)) return "dedup";
  return "other";
}

/** Run the lint command and hand back upstream's report modal. */
async function lint(plugin) {
  await m.lintWithUpstream(plugin);
  const modal = globalThis.__modals.at(-1);
  assert.ok(modal, `upstream opened its report modal; notices: ${notices().join(" | ")}`);
  return modal;
}

/**
 * Press one of the modal's buttons: call the callback it calls, then wait
 * until upstream's fix has ended its lint operation and the writes it fires
 * without awaiting (the engine's generation_complete stamp) have landed.
 */
async function press(plugin, modal, callback) {
  assert.ok(modal.fixCallbacks[callback], `the modal offers ${callback}; counts ${JSON.stringify(modal.counts)}`);
  modal.fixCallbacks[callback]();
  const engine = plugin.upstreamHost().engine();
  for (let i = 0; i < 500 && engine.isLintRunning(); i++) await new Promise((r) => setTimeout(r, 2));
  assert.equal(engine.isLintRunning(), false, "the fix finished");
  await new Promise((r) => setTimeout(r, 20));
}

/**
 * Obsidian's link index as far as upstream's link retargeting reads it
 * (core/link-retarget.ts): each file's wikilinks with their offsets
 * (MetadataCache.getFileCache), and a link resolved to the note whose path or
 * name it gives (getFirstLinkpathDest). The in-memory vault has no index of
 * its own; this one is read from its files when asked.
 */
function linkIndex(app, files) {
  const note = (linkpath) => {
    const want = linkpath.replace(/\.md$/, "");
    const hit = [...files.keys()].find((p) => p.endsWith(".md") && (p.slice(0, -3) === want || p.slice(0, -3).endsWith(`/${want}`)));
    return hit ? { path: hit } : null;
  };
  app.metadataCache.getFirstLinkpathDest = (linkpath) => note(linkpath);
  app.metadataCache.getFileCache = (file) => {
    const text = files.get(file.path) ?? "";
    const links = [...text.matchAll(/(?<!!)\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((x) => ({
      link: x[1],
      original: x[0],
      position: { start: { offset: x.index }, end: { offset: x.index + x[0].length } },
    }));
    return { links, embeds: [] };
  };
}

/** Files saved under the plugin's own folder, by the vault path they keep. */
function saved(files, suffix) {
  return [...files.keys()].filter((p) => p.startsWith(`${PLUGIN_DIR}/`) && p.endsWith(suffix));
}

/** The lines of `before` that are not in `after`, ignoring trailing whitespace. */
function missingLines(before, after) {
  const kept = new Set(after.split("\n").map((l) => l.trimEnd()));
  return before.split("\n").map((l) => l.trimEnd()).filter((l) => l && !kept.has(l));
}

// ---- the reader's pages ----------------------------------------------------------

const PDF = "HBIO 250 Lecture 3";
const QUOTE = `> [!PDF|yellow] [[${PDF}.pdf#page=4&selection=2,0,33,19&color=yellow|${PDF}, p.4]]\n> > Receptors bind a ligand and transduce a signal.`;
const QUOTE_2 = `> [!PDF|yellow] [[${PDF}.pdf#page=5&selection=1,0,12,40&color=yellow|${PDF}, p.5]]\n> > Albumin binds drugs but transduces nothing.`;

function page({ aliases = null, extra = "", body }) {
  const fm = ["---", "type: concept", "class: HBIO250"];
  if (aliases) fm.push("aliases:", ...aliases.map((a) => `  - ${a}`));
  if (extra) fm.push(extra);
  fm.push("---");
  return `${fm.join("\n")}\n${body}`;
}

/** Linked from the other two, with aliases: neither an orphan nor alias-deficient. */
const RECEPTORS = page({
  aliases: ["Receptor"],
  body: `# Receptors

${QUOTE}

## Definition
Receptors are proteins that bind a ligand and pass a signal on into the cell. See [[ligands]] for what binds them.

## Two Properties
Binding and transduction are separate properties of a receptor, and a drug can have one without the other.
`,
});

/** Linked from receptors; no aliases. */
const LIGANDS = page({
  body: `# Ligands

## Definition
A ligand is a molecule that binds a receptor at a specific site. Agonists and antagonists are both ligands of [[receptors]].

## Binding Site
${QUOTE_2}
`,
});

/** Has aliases and links out, but no page links to it: the orphan. */
const ALBUMIN = page({
  aliases: ["Serum albumin"],
  body: `# Albumin

## Definition
Albumin is the main plasma protein. It carries many drugs in the blood and is not one of the [[receptors]].
`,
});

// ---- 1. the scan reports and writes no page --------------------------------------------

test("the scan reports the orphan page and the page missing aliases, and modifies no page", async () => {
  const pages = {
    "wiki/concepts/receptors.md": RECEPTORS,
    "wiki/concepts/ligands.md": LIGANDS,
    "wiki/concepts/albumin.md": ALBUMIN,
  };
  const { plugin, files } = setup(pages);
  const modal = await lint(plugin);
  assert.equal(modal.counts.orphans, 1, JSON.stringify(modal.counts));
  assert.equal(modal.counts.pagesMissingAliases, 1, JSON.stringify(modal.counts));
  assert.match(modal.report, /albumin/);
  assert.match(modal.report, /ligands/);
  for (const [p, text] of Object.entries(pages)) assert.equal(files.get(p), text, `${p} is untouched by the scan`);
  assert.equal(modal.app, plugin.upstreamHost().guard.app, "the modal and the whole lint run on the guarded vault");
  assert.equal(plugin.cancel.active, false, "the scan let go of WikiLM's run token");
  assert.doesNotMatch(notices().join("\n"), /Not updated, to keep what was there/);
});

test("the scan's rewrite of a digest page's PDF `sources:` entry into a sources/ slug is refused, and so is alias completion's copy of it", async () => {
  const digest = LIGANDS.replace("class: HBIO250", `class: HBIO250\nsources:\n  - "[[${PDF}.pdf]]"`);
  const { plugin, files } = setup(
    { "wiki/concepts/receptors.md": RECEPTORS, "wiki/concepts/ligands.md": digest, "wiki/concepts/albumin.md": ALBUMIN },
    (kind) => (kind === "aliases" ? JSON.stringify({ aliases: ["Ligand"] }) : "{}"),
  );
  const modal = await lint(plugin);
  assert.equal(files.get("wiki/concepts/ligands.md"), digest, "upstream's preparation phase did not rewrite the sources entry");
  assert.match(notices().at(-1), /- wiki\/concepts\/ligands\.md: the rewrite would have dropped 1 line \(1 PDF link\)\. The proposed text is saved at [^ ]+ligands\.proposed\.md\./);
  // Preparation keeps its normalised copy of the page (preparation.ts), and
  // alias completion writes from that copy.
  await press(plugin, modal, "onCompleteAliases");
  const now = files.get("wiki/concepts/ligands.md");
  assert.ok(now.includes(`  - "[[${PDF}.pdf]]"`), now);
  assert.doesNotMatch(now, /sources\/hbio-250/);
});

// ---- 2. merge duplicates: the source is never removed ---------------------------------

const RECEPTOR_DUP = page({
  body: `# Receptor

## Definition
A receptor is a protein that binds a ligand and passes a signal on into the cell.
`,
});

/** A pair upstream's dedup phase finds by title, and a model that confirms it. */
function duplicatePair(mergeAnswer) {
  return (kind) => {
    if (kind === "dedup") return JSON.stringify({ is_duplicate: true, duplicates: [{ target: "wiki/concepts/receptors.md", source: "wiki/concepts/receptor.md", reason: "same concept" }] });
    if (kind === "merge") return mergeAnswer;
    if (kind === "aliases") return JSON.stringify({ aliases: ["Ligand"] });
    if (kind === "orphan") return JSON.stringify({ related_pages: [] });
    return "{}";
  };
}

test("Smart Fix All with a duplicate pair: the source is not removed, a lossy merge is refused, and both are reported", async () => {
  const lossy = JSON.stringify({ body: "# Receptors\n\n## Definition\nReceptors bind ligands and pass a signal on.\n", aliases: ["Receptor"] });
  const { plugin, files, calls } = setup(
    { "wiki/concepts/receptors.md": RECEPTORS, "wiki/concepts/receptor.md": RECEPTOR_DUP, "wiki/concepts/ligands.md": LIGANDS },
    duplicatePair(lossy),
  );
  const modal = await lint(plugin);
  assert.ok(modal.counts.duplicates >= 1, `the scan found the pair: ${JSON.stringify(modal.counts)}; calls ${calls.map((c) => c.kind).join(", ")}`);
  await press(plugin, modal, "onFixAll");
  assert.ok(calls.some((c) => c.kind === "merge"), `the merge ran: ${calls.map((c) => c.kind).join(", ")}`);

  assert.ok(files.has("wiki/concepts/receptor.md"), "the source page is not deleted");
  const target = files.get("wiki/concepts/receptors.md");
  assert.deepEqual(missingLines(RECEPTORS, target), [], "the target keeps every line it had");
  for (const kept of ["## Definition", "## Two Properties", QUOTE, `${PDF}.pdf#page=4`]) assert.ok(target.includes(kept), `the target keeps ${kept}`);

  const shown = notices().at(-1);
  assert.match(shown, /Not updated, to keep what was there:/);
  assert.match(shown, /- wiki\/concepts\/receptors\.md: the rewrite would have dropped \d+ lines? \(.*heading.*\)\. The proposed text is saved at \.obsidian\/plugins\/wikilm\/snapshots\/[^ ]+\/wiki\/concepts\/receptors\.proposed\.md\./);
  assert.match(shown, /- wiki\/concepts\/receptor\.md: the engine asked to remove it; it was left in place\./);
  assert.match(shown, /The text each page had before this run is saved in \.obsidian\/plugins\/wikilm\/snapshots\//);
});

test("Merge duplicates with a merge that loses nothing: the target is written, the reader's note outside the wiki is not re-pointed, the source is still not removed", async () => {
  const fused = JSON.stringify({
    body: `# Receptors\n\n${QUOTE}\n\n## Definition\nReceptors are proteins that bind a ligand and pass a signal on into the cell; the same concept is also called a receptor. See [[ligands]] for what binds them.\n\n## Two Properties\nBinding and transduction are separate properties of a receptor, and a drug can have one without the other.\n`,
    aliases: ["Receptor"],
  });
  // A note of the reader's outside the wiki that links the duplicate.
  const classNote = "# HBIO 250\n\nWeek 3 covers each [[receptor]] and its ligands.\n";
  const { plugin, files } = setup(
    { "wiki/concepts/receptors.md": RECEPTORS, "wiki/concepts/receptor.md": RECEPTOR_DUP, "wiki/concepts/ligands.md": LIGANDS, "classes/HBIO250.md": classNote },
    duplicatePair(fused),
  );
  linkIndex(plugin.app, files);
  const modal = await lint(plugin);
  await press(plugin, modal, "onMergeDuplicates");
  // Upstream re-points every link to the source, vault-wide, before it deletes
  // the source (merge-duplicates.ts, retargetLinksToPage); outside the wiki
  // folder that is refused, and so is the delete.
  assert.equal(files.get("classes/HBIO250.md"), classNote);
  const target = files.get("wiki/concepts/receptors.md");
  assert.match(target, /also called a receptor/, "the fused text was written");
  for (const kept of ["## Definition", "## Two Properties", QUOTE, "class: HBIO250"]) assert.ok(target.includes(kept), `the target keeps ${kept}`);
  const [snapshot] = saved(files, "/wiki/concepts/receptors.md");
  assert.equal(files.get(snapshot), RECEPTORS, "the target's old text was saved first");
  assert.ok(files.has("wiki/concepts/receptor.md"), "the source page is not deleted");
  const shown = notices().at(-1);
  assert.match(shown, /Updated \d+ pages?:\n(- .*\n)*- wiki\/concepts\/receptors\.md/);
  assert.match(shown, /- classes\/HBIO250\.md: outside the wiki folder; it was left as it was\./);
  assert.match(shown, /- wiki\/concepts\/receptor\.md: the engine asked to remove it; it was left in place\./);
});

// ---- 3. delete empty stubs: refused ------------------------------------------------------

test("Delete empty stubs on a stub the reader had before the run: refused and reported", async () => {
  const stub = `---\ntype: concept\ncreated: 2026-09-01\nsources:\n  - "[[concepts/receptors]]"\ntags: [term]\nstub: true\n---\n# Agonist\n\n> Stub created by Fix Dead Links — referenced by [[concepts/receptors]]. Will be filled by next ingest of an actual source that defines this entity.\n`;
  const { plugin, files } = setup({
    "wiki/concepts/receptors.md": RECEPTORS,
    "wiki/concepts/ligands.md": LIGANDS,
    "wiki/concepts/agonist.md": stub,
  });
  const modal = await lint(plugin);
  await press(plugin, modal, "onDeleteEmptyStubs");
  assert.equal(files.get("wiki/concepts/agonist.md"), stub, "the stub is still there, as it was");
  assert.match(notices().at(-1), /Not updated, to keep what was there:\n- wiki\/concepts\/agonist\.md: the engine asked to remove it; it was left in place\./);
});

// ---- 4. alias completion ---------------------------------------------------------------

test("alias completion writes the aliases and the page keeps everything else", async () => {
  const { plugin, files } = setup(
    { "wiki/concepts/receptors.md": RECEPTORS, "wiki/concepts/ligands.md": LIGANDS, "wiki/concepts/albumin.md": ALBUMIN },
    (kind) => (kind === "aliases" ? JSON.stringify({ aliases: ["Ligand", "Binding molecule"] }) : "{}"),
  );
  const modal = await lint(plugin);
  await press(plugin, modal, "onCompleteAliases");
  const now = files.get("wiki/concepts/ligands.md");
  assert.match(now, /aliases:\n\s+- "?Ligand"?\n/, now);
  assert.match(now, /Binding molecule/);
  assert.deepEqual(missingLines(LIGANDS, now), [], "every line the page had is still there");
  const [snapshot] = saved(files, "/wiki/concepts/ligands.md");
  assert.equal(files.get(snapshot), LIGANDS, "the old text was saved first");
  assert.doesNotMatch(notices().at(-1), /Not updated, to keep what was there/);
});

test("a lint run writes only inside the wiki folder: an engine write to the reader's class note is refused and reported", async () => {
  const classNote = "# HBIO 250\n\nWeek 3 covers each [[receptors]] and its ligands.\n";
  let plugin;
  const ctx = setup(
    { "wiki/concepts/receptors.md": RECEPTORS, "wiki/concepts/ligands.md": LIGANDS, "wiki/concepts/albumin.md": ALBUMIN, "classes/HBIO250.md": classNote },
    async (kind) => {
      if (kind !== "aliases") return "{}";
      // A runner that reached outside the wiki, as upstream's merge did.
      await plugin.upstreamHost().engine().createOrUpdateFile("classes/HBIO250.md", "# HBIO 250\n\nWeek 3 covers each [[concepts/receptors|receptor]].\n");
      return JSON.stringify({ aliases: ["Ligand"] });
    },
  );
  plugin = ctx.plugin;
  const modal = await lint(plugin);
  await press(plugin, modal, "onCompleteAliases");
  assert.equal(ctx.files.get("classes/HBIO250.md"), classNote);
  assert.match(notices().at(-1), /Not updated, to keep what was there:\n(- .*\n)*- classes\/HBIO250\.md: outside the wiki folder; it was left as it was\./);
});

// ---- 5. every model call runs on the lint role --------------------------------------------

test("every model call a lint makes, the scan's and every fix runner's, runs on WikiLM's lint role", async () => {
  const { plugin, calls } = setup(
    {
      "wiki/concepts/receptors.md": RECEPTORS.replace("See [[ligands]]", "See [[ligands]] and [[agonist-drugs]]"),
      "wiki/concepts/receptor.md": RECEPTOR_DUP,
      "wiki/concepts/ligands.md": LIGANDS,
      "wiki/concepts/albumin.md": ALBUMIN,
      "wiki/concepts/antagonist.md": page({ aliases: ["Blocker"], body: "# Antagonist\n" }),
    },
    (kind) => {
      if (kind === "fill") return "---\ntype: concept\n---\n# Antagonist\n\n## Definition\nAn antagonist binds a receptor without activating it, and blocks agonists from binding.\n";
      if (kind === "dead-link") return JSON.stringify({ action: "create_stub", stub_title: "Agonist drugs", stub_type: "concept" });
      return duplicatePair(JSON.stringify({ body: "# Receptors\n\n## Definition\nShort.\n", aliases: [] }))(kind);
    },
  );
  const modal = await lint(plugin);
  const scanCalls = calls.length;
  await press(plugin, modal, "onFixAll");
  await press(plugin, modal, "onAnalyzeSchema");
  const kinds = new Set(calls.map((c) => c.kind));
  for (const k of ["dedup", "aliases", "merge", "dead-link", "orphan", "fill", "schema"]) assert.ok(kinds.has(k), `a ${k} call was made: ${[...kinds].join(", ")}`);
  assert.ok(scanCalls > 0, "the scan itself called the model");
  for (const c of calls) assert.deepEqual({ provider: c.provider, model: c.model }, LINT_ROLE, `the ${c.kind} call ran on the lint role`);
});

// ---- the other runners, under the guard -----------------------------------------------------

test("Fix dead links creates a stub page and re-points the link, and the page keeps everything else", async () => {
  // No links into a PDF here: upstream counts each of those as dead too (the next test).
  const linking = ALBUMIN.replace("[[receptors]].", "[[receptors]], and not an [[agonist-drugs]] either.");
  const receptors = page({ aliases: ["Receptor"], body: "# Receptors\n\n## Definition\nReceptors are proteins that bind a ligand; [[albumin]] is not one.\n" });
  const { plugin, files } = setup(
    { "wiki/concepts/receptors.md": receptors, "wiki/concepts/albumin.md": linking },
    (kind, req) =>
      kind === "dead-link" && req.user.includes("agonist-drugs")
        ? JSON.stringify({ action: "create_stub", stub_title: "Agonist drugs", stub_type: "concept" })
        : JSON.stringify({ action: "none" }),
  );
  const modal = await lint(plugin);
  await press(plugin, modal, "onFixDeadLinks");
  assert.ok(files.has("wiki/concepts/agonist-drugs.md"), `a stub page was created: ${[...files.keys()].join(", ")}`);
  const now = files.get("wiki/concepts/albumin.md");
  assert.doesNotMatch(now, /\[\[agonist-drugs\]\]/, "the dead link was re-pointed");
  assert.match(now, /\[\[concepts\/agonist-drugs\|Agonist drugs\]\]/, now);
  assert.deepEqual(missingLines(linking, now).filter((l) => !l.includes("agonist-drugs")), [], "nothing else was dropped");
  assert.match(notices().at(-1), /Created 1 page:\n- wiki\/concepts\/agonist-drugs\.md\nUpdated 1 page:\n- wiki\/concepts\/albumin\.md\n/);
  assert.doesNotMatch(notices().at(-1), /Not updated, to keep what was there/);
});

test("upstream counts every link into a PDF as a dead link, even with the PDF in the vault: the callout rewrite is refused, the stub for the PDF is created", async () => {
  // A model answer upstream cannot act on sends it to its own fallback
  // (fix-dead-link.ts): a stub page named after the PDF, and the link re-pointed to it.
  const { plugin, files, calls } = setup({ "wiki/concepts/receptors.md": RECEPTORS, "wiki/concepts/ligands.md": LIGANDS, [`${PDF}.pdf`]: "<binary>" });
  const modal = await lint(plugin);
  assert.match(modal.report, new RegExp(`\\[\\[concepts/receptors\\]\\] → \\*\\*${PDF}\\.pdf\\*\\*`), modal.report);
  await press(plugin, modal, "onFixDeadLinks");
  assert.ok(calls.some((c) => c.kind === "dead-link"), "the fix asked the model about the PDF link");
  assert.equal(files.get("wiki/concepts/receptors.md"), RECEPTORS, "the callout keeps its link into the PDF");
  assert.equal(files.get("wiki/concepts/ligands.md"), LIGANDS);
  assert.match(files.get("wiki/concepts/hbio-250-lecture-3-pdf.md"), /stub: true[\s\S]*# HBIO 250 Lecture 3\.pdf/, "a stub page for the PDF was created");
  const shown = notices().at(-1);
  assert.match(shown, /Created 1 page:\n- wiki\/concepts\/hbio-250-lecture-3-pdf\.md\n/);
  assert.match(shown, /- wiki\/concepts\/receptors\.md: the rewrite would have dropped 1 line \(1 quote line\)\./);
});

test("Link orphans appends a link on a related page, and that page keeps everything else", async () => {
  const { plugin, files } = setup(
    { "wiki/concepts/receptors.md": RECEPTORS, "wiki/concepts/ligands.md": LIGANDS, "wiki/concepts/albumin.md": ALBUMIN },
    (kind) =>
      kind === "orphan"
        ? JSON.stringify({ related_pages: [{ page_path: "concepts/ligands.md", link_text: "Albumin", link_target: "[[concepts/albumin|Albumin]]" }] })
        : "{}",
  );
  const modal = await lint(plugin);
  await press(plugin, modal, "onLinkOrphans");
  const now = files.get("wiki/concepts/ligands.md");
  assert.match(now, /\n- Albumin \[\[concepts\/albumin\|Albumin\]\]$/, now);
  assert.deepEqual(missingLines(LIGANDS, now), [], "every line the page had is still there");
});

test("Expand empty pages fills a page with only a title, and a fill that drops the title is refused", async () => {
  const empty = page({ aliases: ["Blocker"], body: "# Antagonist\n" });
  const run = async (answer) => {
    const { plugin, files } = setup(
      { "wiki/concepts/receptors.md": RECEPTORS, "wiki/concepts/ligands.md": LIGANDS, "wiki/concepts/antagonist.md": empty },
      (kind) => (kind === "fill" ? answer : "{}"),
    );
    const modal = await lint(plugin);
    await press(plugin, modal, "onFillEmptyPages");
    return files.get("wiki/concepts/antagonist.md");
  };
  const kept = await run("---\ntype: concept\nclass: HBIO250\naliases:\n  - Blocker\n---\n# Antagonist\n\n## Definition\nAn antagonist binds a receptor without activating it, and blocks agonists from binding.\n");
  assert.match(kept, /An antagonist binds a receptor/, "a fill that keeps the title is written");
  const refused = await run("---\ntype: concept\n---\nAn antagonist binds a receptor without activating it, and blocks agonists from binding it for a while.\n");
  assert.equal(refused, empty, "a fill that drops the title and frontmatter keys is refused");
  assert.match(notices().at(-1), /- wiki\/concepts\/antagonist\.md: the rewrite would have dropped/);
});

test("Retag violations rewrites the tags value and nothing else", async () => {
  const tagged = RECEPTORS.replace("class: HBIO250", "class: HBIO250\ntags:\n  - not-a-real-tag");
  const { plugin, files } = setup(
    { "wiki/concepts/receptors.md": tagged, "wiki/concepts/ligands.md": LIGANDS },
    (kind) => (kind === "retag" ? JSON.stringify({ tags: ["term"] }) : "{}"),
  );
  const modal = await lint(plugin);
  await press(plugin, modal, "onRetagViolations");
  const now = files.get("wiki/concepts/receptors.md");
  assert.match(now, /tags:\n\s+- "?term"?\n/, now);
  // Upstream re-serialises the frontmatter: the keys are kept, the values quoted.
  assert.deepEqual(missingLines(tagged, now), ["  - not-a-real-tag", "  - Receptor"]);
  assert.match(now, /aliases:\n\s+- "Receptor"\n/);
  assert.equal(now.slice(now.indexOf("# Receptors")), tagged.slice(tagged.indexOf("# Receptors")), "the body is untouched");
});

test("Fix polluted pages: the copy at the clean name is created, the move of the reader's page is refused and reported", async () => {
  const polluted = page({ aliases: ["Kinase"], body: "# Kinases\n\n## Definition\nA kinase moves a phosphate group onto a protein, which switches many receptors on and off. See [[receptors]].\n" });
  const { plugin, files } = setup({
    "wiki/concepts/receptors.md": RECEPTORS,
    "wiki/concepts/ligands.md": LIGANDS,
    "wiki/concepts/concepts·Kinases.md": polluted,
  });
  const modal = await lint(plugin);
  await press(plugin, modal, "onFixPollutedPages");
  assert.equal(files.get("wiki/concepts/concepts·Kinases.md"), polluted, "the reader's page is where it was, as it was");
  // Upstream renames by writing a copy and deleting the old page (fix-polluted-page.ts), so the copy stays.
  assert.match(files.get("wiki/concepts/·Kinases.md") ?? "", /A kinase moves a phosphate group/, "the copy under the clean name was written");
  const shown = notices().at(-1);
  assert.match(shown, /Created 1 page:\n- wiki\/concepts\/·Kinases\.md\n/);
  assert.match(shown, /- wiki\/concepts\/concepts·Kinases\.md: the engine asked to remove it; it was left in place\./);
});

test("Analyze schema appends upstream's suggestion to its suggestions note and changes no schema", async () => {
  const { plugin, files } = setup(
    { "wiki/concepts/receptors.md": RECEPTORS, "wiki/concepts/ligands.md": LIGANDS },
    (kind) => (kind === "schema" ? JSON.stringify({ changes_needed: true, suggestions: "Add a Mechanism section to concept pages.", new_schema_body: "# Schema\n" }) : "{}"),
  );
  const modal = await lint(plugin);
  const schemaBefore = files.get("wiki/schema/config.md");
  await press(plugin, modal, "onAnalyzeSchema");
  assert.match(files.get("wiki/schema/suggestions.md") ?? "", /Add a Mechanism section to concept pages\./);
  assert.equal(files.get("wiki/schema/config.md"), schemaBefore, "the schema note is not changed");
  assert.ok(notices().some((n) => n.includes("wiki/schema/suggestions.md")), notices().join(" | "));
});

// ---- the run around it ------------------------------------------------------------------

test("the lint shows its stage on WikiLM's status bar, and a cancel from there stops it at upstream's next check", async () => {
  const { plugin, calls } = setup({ "wiki/concepts/receptors.md": RECEPTORS, "wiki/concepts/receptor.md": RECEPTOR_DUP, "wiki/concepts/ligands.md": LIGANDS }, duplicatePair("{}"));
  const labels = [];
  const progress = plugin.cancel.progress.bind(plugin.cancel);
  plugin.cancel.progress = (label, owner) => {
    labels.push(label);
    progress(label, owner);
    // The reader clicks the status bar as soon as the lint shows there.
    plugin.cancel.cancel();
  };
  await m.lintWithUpstream(plugin);
  assert.ok(labels.length > 0 && labels[0].length > 0, "upstream's stage reached the status bar");
  assert.deepEqual(calls, [], "the scan stopped before any model call");
  assert.equal(globalThis.__modals.length, 0, "no report modal: the scan stopped");
  assert.ok(notices().includes("Ingestion cancelled"), notices().join(" | "));
  assert.equal(plugin.cancel.active, false, "the lint let go of WikiLM's run token");
  assert.equal(plugin.upstreamHost().engine().isLintRunning(), false);
});

test("a lint does not start while another run holds WikiLM's token, and says why", async () => {
  const { plugin, files } = setup({ "wiki/concepts/receptors.md": RECEPTORS });
  const owner = plugin.cancel.begin("ingesting Lecture");
  await m.lintWithUpstream(plugin);
  assert.equal(globalThis.__modals.length, 0);
  assert.match(notices().at(-1), /another run is still going \(ingesting Lecture\)/);
  assert.equal(files.get("wiki/concepts/receptors.md"), RECEPTORS);
  plugin.cancel.end(owner);
});

test("the settings the lint runs on never turn on upstream's scheduled lint or its automatic Smart Fix", async () => {
  const { plugin } = setup({});
  const s = plugin.upstreamHost().engine().settings;
  assert.equal(s.periodicLint, "off");
  assert.equal(s.autoSmartFix, false);
  assert.equal(s.startupCheck, false);
});
