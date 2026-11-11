// Run with: npm test  (bundles src/commandTable.ts first, then reads README.md
// as text). The README is documentation, so nothing here can fail at runtime,
// which is exactly why it rots. These assertions turn that rot into a red
// test: a command the palette registers and the README never names, an alias
// it never documents, or a missing Network and data section.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let table;
const readme = readFileSync("README.md", "utf8");

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

test('README describes the authoring workflow and discloses retired prompt inputs', () => {
  assert.match(readme, /one editable shared writing method/i);
  assert.match(readme, /legacy.*(?:rules|rule).*files.*(?:ignored|not read)/i);
  assert.match(readme, /(?:not proof of truth|not truth verification)/i);
  assert.match(readme, /(?:no hidden global prompts|does not use global standing instructions)/i);
  for (const command of ['Open the card rules note', 'Review card rule suggestions']) assert.ok(!readme.includes(command));
  assert.doesNotMatch(readme, /Verify sits beside Export|editor's separate draft Check/);
});

test('README documents current prompt editing and omits retired Learn installation', () => {
  assert.doesNotMatch(readme, /scripts\/install-learnharness|\*\*Open Learn\*\*|\| Open Learn \|/);
  assert.doesNotMatch(readme, /Writing customization is limited to/);
  assert.match(readme, /Settings.*Recall Studio.*System prompts.*Open prompt/);
  for (const name of ['Shared writing method', 'Reader prompt', 'Writer prompt', 'Grader prompt']) assert.ok(readme.includes(name));
});

test("the README has a Network and data section", () => {
  // What leaves the machine is the first question a stranger installing the
  // plugin asks; the answer has to stay in the README, under this heading.
  assert.match(readme, /^## Network and data$/m, "README has no '## Network and data' heading");
});
