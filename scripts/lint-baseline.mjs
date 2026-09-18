// Measure the lint against a real vault, the way the chat panel runs it.
// Usage: node scripts/lint-baseline.mjs "<vault path>" [wikiFolder=wiki]
// Pages are every note under <wikiFolder> except <wikiFolder>/sources; the
// source texts are every other note in the vault plus <wikiFolder>/sources,
// which is what src/chatPanel.ts runVaultLint hands to lintVault.
import { build } from "esbuild";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const vault = process.argv[2];
const wikiFolder = process.argv[3] ?? "wiki";
if (!vault) {
  console.error('usage: node scripts/lint-baseline.mjs "<vault path>" [wikiFolder]');
  process.exit(2);
}

const dir = mkdtempSync(path.join(tmpdir(), "wikilm-baseline-"));
const out = path.join(dir, "vaultLint.mjs");
await build({ entryPoints: ["src/vaultLint.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
const vl = await import(pathToFileURL(out).href);

function walk(d, acc = []) {
  for (const entry of readdirSync(d)) {
    if (entry.startsWith(".")) continue;
    const p = path.join(d, entry);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith(".md")) acc.push(p);
  }
  return acc;
}
const rel = (p) => path.relative(vault, p).split(path.sep).join("/");
const sourcesPrefix = `${wikiFolder}/sources/`;

const pages = walk(path.join(vault, wikiFolder))
  .filter((p) => !rel(p).startsWith(sourcesPrefix))
  .map((p) => ({ path: rel(p), content: readFileSync(p, "utf8") }));

const sources = new Map();
for (const p of walk(vault)) {
  const r = rel(p);
  if (r.startsWith(`${wikiFolder}/`) && !r.startsWith(sourcesPrefix)) continue;
  sources.set(r, readFileSync(p, "utf8"));
}

const report = vl.lintVault(pages, { schema: vl.WIKI_SCHEMA, sources });
const counts = {};
for (const issue of report.issues) counts[issue.id] = (counts[issue.id] ?? 0) + 1;
console.log(JSON.stringify({ notes: report.notes, units: report.units, counts }, null, 2));
