// Copies the built plugin into the vault's .obsidian/plugins/wikilm folder.
// Usage: node scripts/install.mjs [vault-path]
import fs from "node:fs";
import path from "node:path";

const DEFAULT_VAULT =
  "/Users/conradkelonu/Library/Mobile Documents/iCloud~md~obsidian/Documents/projects";
const vault = process.argv[2] ?? DEFAULT_VAULT;
const dest = path.join(vault, ".obsidian", "plugins", "wikilm");
fs.mkdirSync(dest, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) {
  fs.copyFileSync(f, path.join(dest, f));
}
console.log(`Installed WikiLM into ${dest}`);
