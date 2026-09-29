import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: true,
    setupFiles: './src/__tests__/__support__/setup.ts',
    // Issue #85 v2: Allow the 'obsidian' module to be mocked (per-file or
    // global setup). Without this, vite externalizes 'obsidian' before
    // vi.mock can intercept, causing "Failed to resolve import 'obsidian'"
    // under the jsdom test environment.
    server: {
      deps: {
        inline: ['obsidian'],
      },
    },
  },
});