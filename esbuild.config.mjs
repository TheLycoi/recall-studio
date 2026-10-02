import esbuild from "esbuild";
import process from "process";
import { sharedBuildOptions } from "./scripts/esbuild-shared.mjs";

const banner = `/*
WikiLM for Obsidian. MIT License, Copyright (c) 2026 Conrad Kelonu.
Includes code from obsidian-llm-wiki (Apache-2.0, Copyright 2025-2026 Greener-Dalii);
see NOTICE and LICENSE-APACHE-2.0.txt in the source repository.
Source: https://github.com/TheLycoi/wikipedia-lm
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
