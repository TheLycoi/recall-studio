import esbuild from "esbuild";
import process from "process";
import { readFileSync } from "node:fs";
import { sharedBuildOptions } from "./scripts/esbuild-shared.mjs";

const banner = `/*\nReview Inbox for Obsidian.\n${readFileSync(new URL("./LICENSE", import.meta.url), "utf8")}\n${readFileSync(new URL("./NOTICE.txt", import.meta.url), "utf8")}\n*/\n`;

const prod = process.argv[2] === "production";

// Externals live in scripts/esbuild-shared.mjs, so the tests that bundle src
// modules use exactly what this build uses.
const context = await esbuild.context({
  ...sharedBuildOptions(),
  banner: { js: banner },
  entryPoints: ["src/main.ts"],
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  outfile: "main.js",
  minify: prod,
  define: { "process.env.NODE_ENV": prod ? '"production"' : '"development"' },
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
