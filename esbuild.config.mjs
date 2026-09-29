import esbuild from "esbuild";
import process from "process";
import { sharedBuildOptions } from "./scripts/esbuild-shared.mjs";

const banner = `/*
Recall — highlight-centric flashcard pipeline for Obsidian.
Bundled with esbuild; source lives in ~/dev/obsidian-recall.
*/
`;

const prod = process.argv[2] === "production";

// Externals, the @llm-wiki alias onto vendor/llm-wiki/src and the
// dynamic-import setting live in scripts/esbuild-shared.mjs, so the tests that
// bundle upstream code use exactly what this build uses.
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
