import tsparser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
  },
  {
    ignores: [
      "main.js",
      "node_modules/",
      // Test files are excluded from local lint to mirror the Obsidian
      // Bot review pipeline's focus on plugin production code. Note (2026-08-06,
      // v1.26.0 pre-submission finding): the Bot actually scans the WHOLE repo
      // `.ts` tree, not just `main.js` — it reported ~60 Warnings on
      // `tools/llm-wiki-cli/` that local lint cannot see (this config lints only
      // `src/` and the root tsconfig includes only `src/**`). The exclude list
      // below keeps local lint focused on plugin code; tools/ warnings are
      // accepted (structural to a Node CLI; see CLAUDE.md Bot compliance
      // invariant). See [[feedback_obsidian_bot_tools_cli_warnings]].
      // Each entry below has a documented user direction:
      //   - src/**/__tests__/** — test files (Direction v1.25.4)
      //   - src/**/__support__/** — test polyfills (Direction v1.25.4)
      //   - src/**/fixtures/** — fixture wikis (Direction v1.25.4)
      //   - src/**/*.test.ts / src/**/*.spec.ts — top-level test files (Direction v1.25.4)
      "src/**/__tests__/**",
      "src/**/__support__/**",
      "src/**/fixtures/**",
      "src/**/*.test.ts",
      "src/**/*.spec.ts",
    ],
  },
];