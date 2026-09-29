// Run with: npm test. Bundles src/upstream/guardedVault.ts, the vault WikiLM
// hands upstream's engine, through the same esbuild options the plugin build
// uses. `obsidian` is replaced by a stub whose TFile and TFolder are real
// classes; the vault is the in-memory one in test/memoryVault.mjs. The loss
// check is pure and tested directly; the guard is tested through every call
// the engine can make to change or remove a file.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sharedBuildOptions } from "../scripts/esbuild-shared.mjs";
import { memoryVault } from "./memoryVault.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function obsidianStub() {
  return {
    name: "obsidian-stub",
    setup(b) {
      b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: ["export class TAbstractFile {}", "export class TFile extends TAbstractFile {}", "export class TFolder extends TAbstractFile {}"].join("\n"),
        loader: "js",
      }));
    },
  };
}

let g;
let dir;
before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "wikilm-guarded-vault-"));
  const out = path.join(dir, "guard.cjs");
  const shared = sharedBuildOptions();
  await build({
    ...shared,
    stdin: {
      contents: ['export * from "./src/upstream/guardedVault.ts";', 'export { TFile, TFolder } from "obsidian";'].join("\n"),
      resolveDir: ROOT,
      sourcefile: "guarded-vault-probe.ts",
      loader: "ts",
    },
    outfile: out,
    logLevel: "error",
    external: shared.external.filter((e) => e !== "obsidian"),
    plugins: [obsidianStub(), ...shared.plugins],
  });
  g = createRequire(import.meta.url)(out);
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// ---- lostContent -------------------------------------------------------------------

const PDF = "HBIO 250 Lecture 3";
const PAGE = `---
class: HBIO250
updated: 2026-09-01
sources:
  - "[[${PDF}.pdf]]"
---
# Receptors

> [!PDF|yellow] [[${PDF}.pdf#page=4&selection=2,0,33,19&color=yellow|${PDF}, p.4]]
> > Receptors bind a ligand and transduce a signal.

![[${PDF}.pdf#page=7&rect=10,20,300,400|${PDF}, p.7]]

## Definition
Receptors are proteins that bind a ligand. See [the slide](Slides.pdf#page=3).

## Two Properties
Binding and transduction are separate properties.

![[receptor-diagram.png]]

## Related topics
- [[Pharmacology]]
`;

const lines = (text) => g.lostContent(PAGE, text).map((x) => x.line);

test("nothing is lost when prose changes, lines move, headings change case, and frontmatter values change", () => {
  const moved = PAGE.replace("updated: 2026-09-01", "updated: 2026-09-29")
    .replace('  - "[[HBIO 250 Lecture 3.pdf]]"', '  - "[[sources/hbio-250-lecture-3-pdf]]"\n  - "[[sources/lecture]]"\ngeneration_complete: true')
    .replace("Receptors are proteins that bind a ligand.", "Receptors are proteins. They bind a ligand, and antagonists bind without transducing.")
    .replace("## Two Properties", "## two properties   ")
    .replace("> > Receptors bind a ligand and transduce a signal.", "> > Receptors bind a ligand and transduce a signal.   ");
  // The Related topics section moved above Definition.
  const reordered = moved.replace("## Related topics\n- [[Pharmacology]]\n", "").replace("## Definition", "## Related topics\n- [[Pharmacology]]\n\n## Definition");
  assert.deepEqual(g.lostContent(PAGE, reordered), []);
  assert.deepEqual(g.lostContent(PAGE, PAGE + "\n## New Information\nMore.\n"), []);
});

test("a dropped heading of any level is lost", () => {
  assert.deepEqual(lines(PAGE.replace("## Two Properties\n", "")), ["## Two Properties"]);
  assert.deepEqual(lines(PAGE.replace("# Receptors\n", "")), ["# Receptors"]);
  assert.deepEqual(g.lostContent(PAGE, PAGE.replace("## Two Properties", "### Two Properties")).map((x) => x.kind), ["heading"]);
});

test("a dropped blockquote or callout line is lost, even when the rest of its callout stays", () => {
  const lost = g.lostContent(PAGE, PAGE.replace("> > Receptors bind a ligand and transduce a signal.\n", ""));
  assert.deepEqual(
    lost.map((x) => [x.kind, x.line]),
    [["quote", "> > Receptors bind a ligand and transduce a signal."]],
  );
  assert.equal(g.droppedLines(lost), 1);
});

test("a PDF link is compared by its target: page and selection or rect count, the display text does not", () => {
  const relabelled = PAGE.replace(`|${PDF}, p.7]]`, "|p. 7]]");
  assert.deepEqual(g.lostContent(PAGE, relabelled), []);
  // In a callout the whole line is also a quote line, and a quote line is kept as it was.
  assert.deepEqual(
    g.lostContent(PAGE, PAGE.replace(`|${PDF}, p.4]]`, "|p. 4]]")).map((x) => x.kind),
    ["quote"],
  );
  const moved = PAGE.replace("selection=2,0,33,19", "selection=2,0,33,20");
  const lost = g.lostContent(PAGE, moved);
  assert.ok(lost.some((x) => x.kind === "pdf-link" && x.key === `${PDF}.pdf#page=4&selection=2,0,33,19&color=yellow`), JSON.stringify(lost));
  // A Markdown link to a PDF counts too; the line around it is prose.
  const noMd = PAGE.replace(" See [the slide](Slides.pdf#page=3).", "");
  assert.deepEqual(
    g.lostContent(PAGE, noMd).map((x) => [x.kind, x.key]),
    [["pdf-link", "Slides.pdf#page=3"]],
  );
});

test("an embed of any kind is lost when it goes, and a PDF embed is lost as an embed and as a PDF link on one line", () => {
  assert.deepEqual(
    g.lostContent(PAGE, PAGE.replace("![[receptor-diagram.png]]\n", "")).map((x) => x.kind),
    ["embed"],
  );
  const lost = g.lostContent(PAGE, PAGE.replace(`![[${PDF}.pdf#page=7&rect=10,20,300,400|${PDF}, p.7]]\n`, ""));
  assert.deepEqual(lost.map((x) => x.kind).sort(), ["embed", "pdf-link"]);
  assert.equal(g.droppedLines(lost), 1, "one line, however many rules it breaks");
});

test("a dropped frontmatter key is lost; its value may change and new keys may come", () => {
  assert.deepEqual(
    g.lostContent(PAGE, PAGE.replace("class: HBIO250\n", "")).map((x) => [x.kind, x.key]),
    [["frontmatter-key", "class"]],
  );
  const noFrontmatter = PAGE.slice(PAGE.indexOf("# Receptors"));
  assert.deepEqual(g.lostContent(PAGE, noFrontmatter).map((x) => x.key).sort(), ["class", "sources", "updated"]);
});

test("describeLoss names the kinds of line a rewrite would drop", () => {
  const lost = g.lostContent(PAGE, PAGE.replace("## Two Properties\n", "").replace(/^> .*\n/gm, ""));
  assert.equal(g.describeLoss(lost), "3 lines (1 heading, 2 quote lines)");
});

// ---- the guard -----------------------------------------------------------------------

const PLUGIN_DIR = ".obsidian/plugins/wikilm";

function guarded(initial, { exempt = () => false, now } = {}) {
  const { app, files } = memoryVault(initial, g);
  let tick = 0;
  const clock = now ?? (() => new Date(Date.UTC(2026, 8, 29, 12, 0, tick++)));
  const guard = new g.WriteGuard(app, PLUGIN_DIR, exempt, clock);
  guard.begin();
  return { guard, files, vault: guard.app.vault, real: app };
}

const file = (vault, p) => vault.getAbstractFileByPath(p);
const under = (files, suffix) => [...files.keys()].filter((p) => p.startsWith(`${PLUGIN_DIR}/snapshots/`) && p.endsWith(suffix));

test("a rewrite that loses a heading is refused: the page keeps its text, and both texts are saved", async () => {
  const { guard, files, vault } = guarded({ "wiki/concepts/receptors.md": PAGE });
  const proposed = PAGE.replace("## Two Properties\n", "");
  const kept = await vault.process(file(vault, "wiki/concepts/receptors.md"), () => proposed);
  assert.equal(kept, PAGE, "process hands back the text the page keeps");
  assert.equal(files.get("wiki/concepts/receptors.md"), PAGE);
  const [snapshot] = under(files, "/wiki/concepts/receptors.md");
  const [proposal] = under(files, "/wiki/concepts/receptors.proposed.md");
  assert.equal(files.get(snapshot), PAGE);
  assert.equal(files.get(proposal), proposed);
  assert.equal(snapshot, `${guard.runFolder}/wiki/concepts/receptors.md`);
  assert.deepEqual(
    guard.refusals.map((r) => [r.path, r.action, r.dropped, r.proposal]),
    [["wiki/concepts/receptors.md", "rewrite", 1, proposal]],
  );
  assert.ok(guard.isHeld("wiki/concepts/receptors.md"));
});

test("modify, append and the adapter's write, append and process all go through the same check", async () => {
  const drop = (t) => t.replace("## Definition\n", "");
  const { guard, files, vault } = guarded({ "a.md": PAGE, "b.md": PAGE, "c.md": PAGE, "d.md": PAGE, "e.md": PAGE });
  await vault.modify(file(vault, "a.md"), drop(PAGE));
  await vault.adapter.write("b.md", drop(PAGE));
  await vault.adapter.process("c.md", drop);
  await vault.append(file(vault, "d.md"), "\nMore.\n");
  await vault.adapter.append("e.md", "\nMore.\n");
  assert.equal(files.get("a.md"), PAGE);
  assert.equal(files.get("b.md"), PAGE);
  assert.equal(files.get("c.md"), PAGE);
  assert.equal(files.get("d.md"), `${PAGE}\nMore.\n`, "an append loses nothing and is written");
  assert.equal(files.get("e.md"), `${PAGE}\nMore.\n`);
  assert.deepEqual(guard.refusals.map((r) => r.path), ["a.md", "b.md", "c.md"]);
  for (const p of ["d.md", "e.md"]) assert.equal(files.get(under(files, `/${p}`)[0]), PAGE, `${p} was saved before the append`);
});

test("a rewrite that only adds is written, after the old text is saved once for the run", async () => {
  const { guard, files, vault } = guarded({ "wiki/concepts/receptors.md": PAGE });
  const once = PAGE.replace("## Related topics", "An antagonist binds without transducing.\n\n## Related topics");
  await vault.process(file(vault, "wiki/concepts/receptors.md"), () => once);
  await vault.process(file(vault, "wiki/concepts/receptors.md"), (t) => `${t}\n## Mentions in Source\n- a quote\n`);
  assert.equal(files.get("wiki/concepts/receptors.md"), `${once}\n## Mentions in Source\n- a quote\n`);
  const snapshots = under(files, "/wiki/concepts/receptors.md");
  assert.equal(snapshots.length, 1);
  assert.equal(files.get(snapshots[0]), PAGE, "the snapshot is the text the page had before the run");
  assert.deepEqual(guard.refusals, []);
});

test("a later write to a refused page in the same run is held too, so the page keeps exactly its old text", async () => {
  const { guard, files, vault } = guarded({ "wiki/concepts/receptors.md": PAGE });
  await vault.process(file(vault, "wiki/concepts/receptors.md"), () => PAGE.replace("## Two Properties\n", ""));
  // Upstream's markPageComplete stamps a key; its related-page pass rewrites the frontmatter.
  await vault.process(file(vault, "wiki/concepts/receptors.md"), (t) => t.replace("class: HBIO250", "class: HBIO250\ngeneration_complete: true"));
  assert.equal(files.get("wiki/concepts/receptors.md"), PAGE);
  assert.equal(guard.refusals.length, 1);
  assert.equal(guard.refusals[0].held, 1);
  guard.begin();
  assert.ok(!guard.isHeld("wiki/concepts/receptors.md"), "a new run starts with nothing held");
});

test("index.md and log.md in the wiki folder skip the loss check but are still saved", async () => {
  const exempt = (p) => p === "wiki/index.md" || p === "wiki/log.md";
  const { guard, files, vault } = guarded({ "wiki/index.md": "# Index\n\n## Entities\n", "wiki/concepts/x.md": "# X\n" }, { exempt });
  await vault.process(file(vault, "wiki/index.md"), () => "# Wiki Index\n\n## Concepts\n");
  assert.equal(files.get("wiki/index.md"), "# Wiki Index\n\n## Concepts\n");
  assert.equal(files.get(under(files, "/wiki/index.md")[0]), "# Index\n\n## Entities\n");
  await vault.process(file(vault, "wiki/concepts/x.md"), () => "Y\n");
  assert.equal(files.get("wiki/concepts/x.md"), "# X\n", "an ordinary page is still checked");
  assert.deepEqual(guard.refusals.map((r) => r.path), ["wiki/concepts/x.md"]);
});

test("a new file is written normally, and one created in this run is the engine's own: no check, no snapshot", async () => {
  const { guard, files, vault } = guarded({});
  const created = await vault.create("wiki/concepts/new.md", "# New\n\n## Definition\nText.\n");
  assert.equal(created.path, "wiki/concepts/new.md");
  await vault.process(file(vault, "wiki/concepts/new.md"), () => "# New\n\nShorter.\n");
  assert.equal(files.get("wiki/concepts/new.md"), "# New\n\nShorter.\n");
  await vault.adapter.write("wiki/other.md", "x");
  assert.equal(files.get("wiki/other.md"), "x");
  assert.deepEqual(under(files, ".md"), []);
  assert.deepEqual(guard.refusals, []);
  assert.equal(guard.runFolder, null, "nothing was saved, so no run folder was made");
});

test("removing or moving a page that existed before the run is refused and recorded; the engine's own pages may go", async () => {
  const pages = { "wiki/a.md": "# A\n", "wiki/b.md": "# B\n", "wiki/c.md": "# C\n", "wiki/d.md": "# D\n", "wiki/e.md": "# E\n", "wiki/f.md": "# F\n", "wiki/g.md": "# G\n" };
  const { guard, files, vault } = guarded(pages);
  await guard.app.fileManager.trashFile(file(vault, "wiki/a.md"));
  await vault.delete(file(vault, "wiki/b.md"));
  await vault.trash(file(vault, "wiki/c.md"), true);
  await guard.app.fileManager.renameFile(file(vault, "wiki/d.md"), "wiki/entities/d.md");
  await vault.rename(file(vault, "wiki/e.md"), "wiki/e2.md");
  await vault.adapter.remove("wiki/f.md");
  await vault.adapter.rename("wiki/g.md", "wiki/g2.md");
  for (const [p, text] of Object.entries(pages)) assert.equal(files.get(p), text, `${p} is still there`);
  assert.deepEqual(
    guard.refusals.map((r) => [r.path, r.action, r.to ?? null]),
    [
      ["wiki/a.md", "remove", null],
      ["wiki/b.md", "remove", null],
      ["wiki/c.md", "remove", null],
      ["wiki/d.md", "rename", "wiki/entities/d.md"],
      ["wiki/e.md", "rename", "wiki/e2.md"],
      ["wiki/f.md", "remove", null],
      ["wiki/g.md", "rename", "wiki/g2.md"],
    ],
  );

  // The summary page of a cancelled run, which upstream trashes so the note re-ingests.
  await vault.create("wiki/sources/note.md", "# Note\n");
  await guard.app.fileManager.renameFile(file(vault, "wiki/sources/note.md"), "wiki/sources/note-2.md");
  await guard.app.fileManager.trashFile(file(vault, "wiki/sources/note-2.md"));
  assert.equal(files.has("wiki/sources/note.md") || files.has("wiki/sources/note-2.md"), false);
  assert.equal(guard.refusals.length, 7);
});

test("a binary overwrite and an in-place frontmatter edit of an existing page are refused, since neither can be checked", async () => {
  const { guard, files, vault } = guarded({ "wiki/a.md": PAGE, "wiki/b.md": PAGE });
  await vault.modifyBinary(file(vault, "wiki/a.md"), new ArrayBuffer(4));
  await guard.app.fileManager.processFrontMatter(file(vault, "wiki/b.md"), (fm) => {
    delete fm.class;
  });
  assert.equal(files.get("wiki/a.md"), PAGE);
  assert.equal(files.get("wiki/b.md"), PAGE);
  assert.deepEqual(guard.refusals.map((r) => [r.path, r.action]), [
    ["wiki/a.md", "rewrite"],
    ["wiki/b.md", "rewrite"],
  ]);
  assert.ok(guard.refusals.every((r) => r.detail), "each says why in words");
});

test("everything else passes through to the real app", () => {
  const { guard, real } = guarded({ "x.md": "x" });
  assert.equal(guard.app.metadataCache, real.metadataCache);
  assert.equal(guard.app.vault.configDir, ".obsidian");
  assert.equal(guard.app.vault.getAbstractFileByPath("x.md").path, "x.md");
  assert.ok(guard.app.vault.getAbstractFileByPath("x.md") instanceof g.TFile);
});

test("each run saves into its own folder, and only the last 20 runs are kept", async () => {
  const old = {};
  for (let i = 0; i < 22; i++) old[`${PLUGIN_DIR}/snapshots/2026-01-${String(i + 1).padStart(2, "0")}T00-00-00-000Z/wiki/x.md`] = "old";
  const { guard, files, vault } = guarded({ ...old, "wiki/p.md": PAGE, "wiki/q.md": PAGE });
  await vault.process(file(vault, "wiki/p.md"), (t) => `${t}\nmore\n`);
  const first = guard.runFolder;
  assert.match(first, /^\.obsidian\/plugins\/wikilm\/snapshots\/2026-09-29T12-00-\d\d-000Z$/);
  guard.begin();
  await vault.process(file(vault, "wiki/q.md"), (t) => `${t}\nmore\n`);
  assert.notEqual(guard.runFolder, first);
  const runs = [...new Set([...files.keys()].filter((p) => p.startsWith(`${PLUGIN_DIR}/snapshots/`)).map((p) => p.split("/")[4]))].sort();
  assert.equal(runs.length, 20);
  assert.equal(runs.at(-1), guard.runFolder.split("/").pop());
  assert.ok(!runs.includes("2026-01-01T00-00-00-000Z") && !runs.includes("2026-01-04T00-00-00-000Z"), runs.join(" "));
});
