// Copies the built plugin and its licence notices into the vault's
// .obsidian/plugins/wikilm folder. Nothing else in that folder is touched:
// data.json there holds the reader's settings and keys.
// Usage: node scripts/install.mjs <vault-path>   (or set WIKILM_VAULT)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What is installed, relative to the repository root, and the name it takes in
 * the plugin folder. The notices travel with main.js because main.js contains
 * code compiled from the vendored Apache-2.0 project.
 */
export const INSTALLED_FILES = [
  { from: "main.js", to: "main.js" },
  { from: "manifest.json", to: "manifest.json" },
  { from: "styles.css", to: "styles.css" },
  { from: "NOTICE", to: "NOTICE" },
  { from: "LICENSE-APACHE-2.0.txt", to: "LICENSE-APACHE-2.0.txt" },
  { from: "vendor/llm-wiki/NOTICE", to: "NOTICE-llm-wiki" },
];

/**
 * Copies INSTALLED_FILES from `srcDir` into `<vault>/.obsidian/plugins/wikilm`
 * and returns that folder. Every source is checked first, so a missing file
 * copies nothing rather than leaving a half-installed plugin.
 */
export function install(vault, srcDir = ".") {
  const missing = INSTALLED_FILES.filter((f) => !fs.existsSync(path.join(srcDir, f.from))).map((f) => f.from);
  if (missing.length) throw new Error(`Cannot install, missing: ${missing.join(", ")}`);
  const dest = path.join(vault, ".obsidian", "plugins", "wikilm");
  fs.mkdirSync(dest, { recursive: true });
  for (const f of INSTALLED_FILES) {
    fs.copyFileSync(path.join(srcDir, f.from), path.join(dest, f.to));
  }
  return dest;
}

// Installs only when run as a script, never when a test imports this module.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const vault = process.argv[2] ?? process.env.WIKILM_VAULT;
  if (!vault) {
    console.error("Usage: node scripts/install.mjs <vault-path>   (or set WIKILM_VAULT)");
    process.exit(2);
  }
  const dest = install(vault);
  console.log(`Installed WikiLM into ${dest}`);
}
