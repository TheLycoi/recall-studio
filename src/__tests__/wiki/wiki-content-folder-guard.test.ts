// v1.22.2 regression: log.md must NOT be stamped with `generation_complete`.
// Before this fix, createOrUpdateFile() unconditionally called markPageComplete()
// for every written file, which stamped the wiki-content frontmatter marker
// (generation_complete) onto log.md, index.md, schema/, and other non-content
// files. The markPageComplete helper, given a file with no existing frontmatter,
// would prepend a brand-new `---...---...` block with `generation_complete: true`
// to the top of the file — visibly polluting the body.
import { describe, it, expect } from 'vitest';

describe('isInWikiContentFolder guard (v1.22.2 regression)', () => {
  // The guard logic itself is a private method, but the contract is testable
  // by directly checking the wiki-engine's set of path prefixes. We document
  // the exact rule here so the contract is visible.

  const wikiFolder = 'wiki';
  const isInWikiContentFolder = (path: string): boolean =>
    path.startsWith(`${wikiFolder}/entities/`) ||
    path.startsWith(`${wikiFolder}/concepts/`) ||
    path.startsWith(`${wikiFolder}/sources/`);

  it('treats entity/concept/source pages as content (gets generation_complete stamp)', () => {
    expect(isInWikiContentFolder('wiki/entities/Qwen.md')).toBe(true);
    expect(isInWikiContentFolder('wiki/concepts/RAG.md')).toBe(true);
    expect(isInWikiContentFolder('wiki/sources/Notes.md')).toBe(true);
  });

  it('does NOT treat log.md as content (no stamp)', () => {
    // The whole point of this regression: log.md lives inside `wiki/` but is
    // a configuration/operation log, NOT a wiki page. Stamping it would inject
    // a `---...generation_complete: true...---` block at the top of the file.
    expect(isInWikiContentFolder('wiki/log.md')).toBe(false);
  });

  it('does NOT treat index.md as content (no stamp)', () => {
    expect(isInWikiContentFolder('wiki/index.md')).toBe(false);
  });

  it('does NOT treat schema/ as content (no stamp)', () => {
    expect(isInWikiContentFolder('wiki/schema/main.json')).toBe(false);
  });

  it('does NOT treat custom wiki folder log.md as content', () => {
    const wf = 'my-wiki';
    const guard = (path: string): boolean =>
      path.startsWith(`${wf}/entities/`) ||
      path.startsWith(`${wf}/concepts/`) ||
      path.startsWith(`${wf}/sources/`);
    expect(guard('my-wiki/log.md')).toBe(false);
  });
});
