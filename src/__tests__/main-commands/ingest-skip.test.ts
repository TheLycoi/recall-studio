// The batch-ingest skip check must answer one question: has THIS note
// already been ingested?
//
// `isAlreadyIngested` locates the summary page by slug and then verifies
// ownership by looking for the note's path in the page's frontmatter. It
// reads `sources:` for that path. But `sources:` is a list of
// `[[sources/X]]` wikilinks by contract — the Issue #81 normalizer removes
// or remaps any `[[Notizen/X.md]]` entry it finds there. The path being
// searched for is therefore the one shape the field can never hold, and
// every summary page that carries a `sources:` list reads as "not
// ingested".
//
// The canonical owner is the scalar `source_file:` written by the
// generation template. `scanSourceDrift` (#577) already resolves ownership
// that way: scalar first, list as a fallback.

import { describe, it, expect } from 'vitest';
import { TFile } from 'obsidian';
import { ingestCommands, type IngestHost } from '../../main-commands/ingest-commands';

const NOTE_PATH = 'Notizen/ATP-Produktion.md';

function note(path = NOTE_PATH): TFile {
  const basename = path.split('/').pop()!.replace(/\.md$/, '');
  return Object.assign(new TFile(), { path, basename, extension: 'md' });
}

/** Minimal host: `isAlreadyIngested` only touches the vault and two settings. */
function host(pages: Record<string, string>): IngestHost {
  return {
    app: {
      vault: {
        getAbstractFileByPath: (p: string) =>
          p in pages ? Object.assign(new TFile(), { path: p }) : null,
        read: async (f: { path: string }) => pages[f.path],
      },
    },
    settings: { wikiFolder: 'wiki', slugCase: 'preserve' },
  } as unknown as IngestHost;
}

const call = (h: IngestHost, f: TFile) =>
  ingestCommands.isAlreadyIngested.call(h, f);

// A real page from the vault. The canonical scalar names the origin note.
// `sources:` names the OTHER notes whose later ingest extended this page —
// the multi-source merge, which also stamps "Erweitert durch: [[sources/X]]"
// into the body. It is by design the one field that never names the origin.
const MULTI_SOURCE_PAGE = `---
type: source
source_file: "[[Notizen/ATP-Produktion.md]]"
contentHash: 11a3-6a586cb9
sources:
  - "[[sources/Coenzym-Q10]]"
  - "[[sources/Magnesium]]"
---

Summary.`;

const SINGLE_SOURCE_PAGE = `---
type: source
source_file: "[[Notizen/ATP-Produktion.md]]"
contentHash: 11a3-6a586cb9
---

Summary.`;

describe('isAlreadyIngested — ownership comes from source_file', () => {
  it('skips a note whose summary page carries a sources: list', async () => {
    const h = host({ 'wiki/sources/ATP-Produktion.md': MULTI_SOURCE_PAGE });
    // Today: false. The note path is compared against `[[sources/…]]`
    // entries and never matches, so the batch re-ingests the note.
    expect(await call(h, note())).toBe(true);
  });

  it('skips a note whose summary page has no sources: list', async () => {
    const h = host({ 'wiki/sources/ATP-Produktion.md': SINGLE_SOURCE_PAGE });
    expect(await call(h, note())).toBe(true);
  });

  it('ingests a note that has no summary page', async () => {
    expect(await call(host({}), note())).toBe(false);
  });

  it('ingests a same-slug note from another folder', async () => {
    // Two notes slugify to one page path. The page belongs to the note
    // named in `source_file:`; the other one has not been ingested.
    // Today: true — the ownership check falls through to `return true`
    // whenever `sources:` is absent, so the second note is silently
    // skipped and never ingested at all.
    const h = host({ 'wiki/sources/ATP-Produktion.md': SINGLE_SOURCE_PAGE });
    expect(await call(h, note('Archiv/ATP-Produktion.md'))).toBe(false);
  });
});
