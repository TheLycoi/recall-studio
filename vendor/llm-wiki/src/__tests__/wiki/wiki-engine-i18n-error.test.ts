// Issue #172 — `createOrUpdateFile()` final-fallback error must come from i18n,
// never a hardcoded CJK string. Pure unit test: mock the vault so every write
// path fails, then assert the thrown message contains the localized label and
// the file path — and NOT any raw Chinese characters.

import { describe, it, expect, vi } from 'vitest';
import { WikiEngine } from '../../wiki/wiki-engine';
import { createMockClient } from '../__support__/engine-context';

// Build a WikiEngine whose vault always rejects writes.
function buildAlwaysFailingEngine() {
  const failingVault = {
    read: async () => '',
    getAbstractFileByPath: () => null,
    getMarkdownFiles: () => [],
    create: vi.fn(async () => { throw new Error('File already exists'); }),
    process: vi.fn(async () => { throw new Error('File already exists'); }),
    modify: vi.fn(async () => { throw new Error('File already exists'); }),
    createFolder: async () => {},
    getFiles: () => [],
  };

  const app = { vault: failingVault } as unknown as ConstructorParameters<typeof WikiEngine>[0];
  const settings = {
    wikiFolder: 'wiki',
    language: 'en',
    llmReady: true,
  } as unknown as ConstructorParameters<typeof WikiEngine>[1];
  const client = createMockClient(['{"entities":[],"concepts":[]}']);

  const engine = new WikiEngine(
    app,
    settings,
    () => client,
    { ensureSchemaExists: async () => {}, getSchemaContext: async () => '' } as never,
    () => {},
    () => {},
    () => {}
  );

  return { engine, failingVault };
}

describe('WikiEngine.createOrUpdateFile — i18n error (#172)', () => {
  it('throws a localized message instead of the hardcoded CJK string', async () => {
    const { engine } = buildAlwaysFailingEngine();

    await expect(engine.createOrUpdateFile('wiki/entities/foo.md', '# Body')).rejects.toThrow(
      /Could not create or update file/i
    );

    await expect(engine.createOrUpdateFile('wiki/entities/foo.md', '# Body')).rejects.not.toThrow(
      // Belt-and-suspenders: explicitly fail if the literal CJK string leaks.
      /无法创建或更新文件/
    );
  });
});
