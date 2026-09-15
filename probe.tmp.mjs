import { build } from "esbuild";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os";
import path from "node:path"; import { pathToFileURL } from "node:url";
const d = mkdtempSync(path.join(tmpdir(),"p-"));
const o = path.join(d,"vl.mjs");
await build({entryPoints:["src/vaultLint.ts"],bundle:true,format:"esm",platform:"node",outfile:o,logLevel:"silent"});
const vl = await import(pathToFileURL(o).href);
const BASE = "/Users/conradkelonu/Library/Mobile Documents/iCloud~md~obsidian/Documents";
const walk=(dir,out=[])=>{ if(!existsSync(dir))return out; for(const e of readdirSync(dir)){if(e.startsWith('.'))continue;const f=path.join(dir,e);statSync(f).isDirectory()?walk(f,out):e.endsWith('.md')&&out.push(f);}return out;};

for (const [vault, wikiDir] of [["projects","wiki"],["secondbrain","wiki"]]) {
  const V = path.join(BASE, vault);
  const all = walk(V);
  const pages = all.filter(f=>f.includes(`/${wikiDir}/`)).map(f=>({path:path.relative(V,f),content:readFileSync(f,'utf8')}));
  if (pages.length === 0) { console.log(`\n### ${vault}: no wiki pages`); continue; }
  const sources = new Map();
  for (const f of all){const rel=path.relative(V,f); if(rel.startsWith(wikiDir+'/')&&!rel.startsWith(wikiDir+'/sources/'))continue; sources.set(rel, readFileSync(f,'utf8'));}
  const r = vl.lintVault(pages,{schema:vl.WIKI_SCHEMA, sources});
  const by={}; for(const i of r.issues) by[i.id]=(by[i.id]||0)+1;
  console.log(`\n### ${vault} — ${r.notes} pages, ${r.units} quotable passages, ${sources.size} source texts`);
  console.log(JSON.stringify(by));
}
