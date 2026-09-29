import { describe, it, expect } from 'vitest';
import { fillEmptyPage } from '../../../wiki/lint/fill-empty-page';
import type { EngineContext } from '../../../types';
import { localDateStamp } from '../../../core/format';

// Issue #388 at the fill path. Unlike page creation, a real page exists here —
// so the model's `created:` does not invent a date, it overwrites a true one.

const PAGE = 'wiki/entities/Osteopontin.md';
const ON_DISK =
  '---\ntype: entity\ncreated: 2026-07-30\nupdated: 2026-07-30\ntags: [other]\n---\n\n# Osteopontin\n';

function makeCtx(llmReply: string) {
  const files = new Map<string, string>([[PAGE, ON_DISK]]);
  const ctx = {
    app: { vault: { getMarkdownFiles: () => [] } },
    settings: { wikiFolder: 'wiki', wikiLanguage: 'en', language: 'en', disableThinking: false },
    getClient: () => ({ createMessage: async () => llmReply }),
    tryReadFile: async (path: string) => files.get(path) ?? null,
    createOrUpdateFile: async (path: string, content: string) => { files.set(path, content); },
    getSchemaContext: async () => undefined,
    getSectionLabels: () => ({ section_description: 'Description' }),
  } as unknown as EngineContext;
  return { ctx, files };
}

describe('fillEmptyPage — created: provenance (Issue #388)', () => {
  it('keeps the date from the file on disk when the model writes another one', async () => {
    const { ctx, files } = makeCtx(
      '---\ntype: entity\ncreated: 2024-11-03\nupdated: 2024-11-03\ntags: [other]\n---\n\n' +
      '## Description\n\nOsteopontin is a phosphoprotein of the bone matrix and a marker ' +
      'of vascular calcification, discussed here at enough length to clear the substantive ' +
      'content threshold that the fill path applies before writing.\n'
    );

    await fillEmptyPage(ctx, PAGE);

    const written = files.get(PAGE)!;
    const today = localDateStamp();
    expect(written).toContain('created: 2026-07-30');
    expect(written).not.toContain('2024-11-03');
    expect(written).toContain(`updated: ${today}`);
  });
});
