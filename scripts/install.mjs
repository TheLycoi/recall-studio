// Copies the built plugin into the vault's .obsidian/plugins/recall folder.
// Nothing else in that folder is touched: data.json there holds the reader's
// settings and keys.
// Usage: node scripts/install.mjs <vault-path>   (or set RECALL_VAULT)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What is installed, relative to the repository root, and the name it takes in
 * the plugin folder.
 */
export const INSTALLED_FILES = [
  { from: "main.js", to: "main.js" },
  { from: "manifest.json", to: "manifest.json" },
  { from: "styles.css", to: "styles.css" },
];

/**
 * Copies INSTALLED_FILES from `srcDir` into `<vault>/.obsidian/plugins/recall`
 * and returns that folder. Every source is checked first, so a missing file
 * copies nothing rather than leaving a half-installed plugin.
 */
export function install(vault, srcDir = ".") {
  const missing = INSTALLED_FILES.filter((f) => !fs.existsSync(path.join(srcDir, f.from))).map((f) => f.from);
  if (missing.length) throw new Error(`Cannot install, missing: ${missing.join(", ")}`);
  const dest = path.join(vault, ".obsidian", "plugins", "recall");
  fs.mkdirSync(dest, { recursive: true });
  for (const f of INSTALLED_FILES) {
    fs.copyFileSync(path.join(srcDir, f.from), path.join(dest, f.to));
  }
  return dest;
}

// Installs only when run as a script, never when a test imports this module.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const vault = process.argv[2] ?? process.env.RECALL_VAULT;
  if (!vault) {
    console.error("Usage: node scripts/install.mjs <vault-path>   (or set RECALL_VAULT)");
    process.exit(2);
  }
  const dest = install(vault);
  console.log(`Installed Recall into ${dest}`);
}
