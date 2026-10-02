// Run with: npm test  (bundles src/commandTable.ts first, then reads README.md,
// docs/architecture.md and src/llm.ts as text). The docs are documentation, so
// nothing here can fail at runtime, which is exactly why they rot. These
// assertions turn three kinds of rot into a red test: a command the palette
// registers and the README never mentions, a feature the docs describe and the
// source does not have, and a "verbatim" prompt block in docs/architecture.md
// that has drifted from its constant.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let table;
const readme = readFileSync("README.md", "utf8");
// The design log: the verbatim prompt blocks and the settings tables live here.
const architecture = readFileSync("docs/architecture.md", "utf8");
const llmSource = readFileSync("src/llm.ts", "utf8");

before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wikilm-readme-test-"));
  const out = path.join(dir, "commandTable.mjs");
  await build({ entryPoints: ["src/commandTable.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  table = await import(pathToFileURL(out).href);
});

test("every command's palette name appears in the README verbatim", () => {
  for (const c of table.COMMAND_TABLE) {
    assert.ok(readme.includes(c.name), `README does not name the command "${c.name}" (${c.id})`);
  }
});

test("every command's aliases are documented", () => {
  for (const c of table.COMMAND_TABLE) {
    for (const alias of c.aliases) {
      // Aliases are documented as inline code so they cannot be matched by a
      // word that happens to appear in prose: "lint" is a sentence in a dozen
      // places, `lint` is the alias.
      assert.ok(readme.includes(`\`${alias}\``), `README does not document the alias "${alias}" of ${c.id}`);
    }
  }
});

test("the README has a Network and data section", () => {
  // What leaves the machine is the first question a stranger installing the
  // plugin asks; the answer has to stay in the README, under this heading.
  assert.match(readme, /^## Network and data$/m, "README has no '## Network and data' heading");
});

test("the docs describe no feature the source does not have", () => {
  // The verify pass was documented for several releases after it was removed:
  // a prompt block, a settings row, a paragraph and two limitations, none of
  // them reachable from any code path.
  for (const [file, text] of [["README.md", readme], ["docs/architecture.md", architecture]]) {
    assert.ok(!text.includes("VERIFY_SYSTEM"), `${file} still documents the verify pass, which src/ does not have`);
    // The plugin id is wikilm and the settings tab is WikiLM.
    assert.ok(!text.includes("Settings → Recall"), `${file} still points at the old settings tab name`);
  }
  assert.ok(!llmSource.includes("VERIFY_SYSTEM"), "src/llm.ts has a VERIFY_SYSTEM again; the docs assertion above needs revisiting");
});

/**
 * The template-literal body of `const NAME = \`…\`;` in src/llm.ts.
 *
 * The delimiter is a backtick followed by a semicolon at the end of a line.
 * Every one of these constants is a multi-line prompt whose last line is a
 * sentence, so a line ending in "`;" is unambiguous: no prompt body contains
 * one, and every constant in the file ends with one.
 */
function promptBody(name) {
  const re = new RegExp("^(?:export )?const " + name + " = `([\\s\\S]*?)`;$", "m");
  const m = re.exec(llmSource);
  return m ? m[1] : null;
}

/** Every `<details>` block whose summary says "verbatim" and names a *_SYSTEM constant. */
function verbatimBlocks() {
  const lines = architecture.split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^<summary><code>([A-Z_]+_SYSTEM)<\/code>[^<]*verbatim/.exec(lines[i]);
    if (!m) continue;
    let open = i + 1;
    while (open < lines.length && lines[open] !== "```") open++;
    let close = open + 1;
    while (close < lines.length && lines[close] !== "```") close++;
    assert.ok(close < lines.length, `the ${m[1]} block has no closing fence`);
    blocks.push({ name: m[1], text: lines.slice(open + 1, close).join("\n") });
  }
  return blocks;
}

test("docs/architecture.md has a verbatim block for each prompt it claims to quote", () => {
  const blocks = verbatimBlocks();
  assert.ok(blocks.length > 0, "no verbatim prompt blocks found — the summary format changed");
  for (const b of blocks) {
    assert.ok(promptBody(b.name) !== null, `docs/architecture.md quotes ${b.name}, which src/llm.ts does not define`);
  }
});

test("each verbatim block equals its constant in src/llm.ts character for character", () => {
  for (const b of verbatimBlocks()) {
    const body = promptBody(b.name);
    // None of these constants interpolate today, so each one can be pinned
    // exactly. A constant that gains a ${…} would have to be excluded here
    // with a note saying so, because the docs can only quote the source
    // text and not the value it evaluates to.
    assert.ok(!body.includes("${"), `${b.name} now interpolates; exclude it from this assertion and say why`);
    assert.equal(b.text, body, `the ${b.name} block in docs/architecture.md has drifted from src/llm.ts`);
  }
});

test("every Ask setting has a row in the docs/architecture.md settings table", () => {
  const settingsSource = readFileSync("src/settings.ts", "utf8");
  const start = settingsSource.indexOf('.setName("Ask")');
  const end = settingsSource.indexOf('.setName("Question cap per quiz")');
  assert.ok(start >= 0 && end > start, "could not find the Ask section of src/settings.ts");
  const names = [...settingsSource.slice(start, end).matchAll(/\.setName\("([^"]+)"\)/g)].map((m) => m[1]).filter((n) => n !== "Ask");
  assert.ok(names.includes("Filter evidence with the model"), "the Ask section parse found no relevance-filter setting");
  for (const name of names) {
    assert.ok(architecture.includes(`\n| ${name} |`), `the docs/architecture.md settings table has no row for "${name}"`);
  }
});

test("the docs do not describe the Ask send button or route as they were before general-knowledge carding", () => {
  for (const [file, text] of [["README.md", readme], ["docs/architecture.md", architecture]]) {
    assert.ok(!text.includes("An answer with no source has no button"), `${file} still says a sourceless answer has no send button`);
    assert.ok(!text.includes("the most recent answer that has a source"), `${file} still says the typed phrase skips sourceless answers`);
    assert.ok(!text.includes("*notes + keywords*, or *general\nknowledge*"), `${file} still lists general knowledge as a route`);
    assert.ok(!text.includes("plus a count of any citations dropped |"), `${file} grounding-line row predates the unmatched count, route and scope`);
  }
});
