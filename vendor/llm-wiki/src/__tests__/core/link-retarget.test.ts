import { describe, it, expect } from 'vitest';
import { retargetLinksToPage } from '../../core/link-retarget';
import { createFakeLinkVault } from '../__support__/link-vault';

const FROM = 'wiki/entities/Osteopontin-2.md';
const TO = 'wiki/entities/Osteopontin.md';

describe('retargetLinksToPage', () => {
  it('rewrites a bare-title link in a note outside the wiki folder', async () => {
    // The measured case: 1762 of 1762 incoming links from user notes were
    // written bare, and the previous rewrite visited wiki files only.
    const fake = createFakeLinkVault({
      [FROM]: '# Osteopontin-2\n',
      [TO]: '# Osteopontin\n',
      'Notizen/Knochenstoffwechsel.md': 'See [[Osteopontin-2]] for the marker.\n',
    });

    const result = await retargetLinksToPage(fake, FROM, TO);

    expect(fake.read('Notizen/Knochenstoffwechsel.md')).toBe('See [[Osteopontin]] for the marker.\n');
    expect(result).toEqual({ filesChanged: 1, linksRewritten: 1, stale: 0 });
  });

  it('leaves a same-named page elsewhere in the vault alone', async () => {
    // Resolve-before-replace: a bare `[[Osteopontin-2]]` next to the note's own
    // Osteopontin-2 addresses that file, not the wiki page being merged. A
    // string match would bend this link to a page it never referenced.
    const fake = createFakeLinkVault({
      [FROM]: '# Osteopontin-2\n',
      [TO]: '# Osteopontin\n',
      'Notizen/Osteopontin-2.md': '# My own note\n',
      'Notizen/Knochenstoffwechsel.md': 'See [[Osteopontin-2]].\n',
    });

    const result = await retargetLinksToPage(fake, FROM, TO);

    expect(fake.read('Notizen/Knochenstoffwechsel.md')).toBe('See [[Osteopontin-2]].\n');
    expect(result).toEqual({ filesChanged: 0, linksRewritten: 0, stale: 0 });
    expect(fake.processed).toEqual([]);
  });

  it('keeps the link shape: a folder-prefixed link stays folder-prefixed', async () => {
    const fake = createFakeLinkVault({
      [FROM]: '# Osteopontin-2\n',
      [TO]: '# Osteopontin\n',
      'wiki/concepts/Knochenumbau.md': 'Regulated by [[entities/Osteopontin-2]].\n',
      'Notizen/Knochenstoffwechsel.md': 'See [[Osteopontin-2]].\n',
    });

    await retargetLinksToPage(fake, FROM, TO);

    expect(fake.read('wiki/concepts/Knochenumbau.md')).toBe('Regulated by [[entities/Osteopontin]].\n');
    expect(fake.read('Notizen/Knochenstoffwechsel.md')).toBe('See [[Osteopontin]].\n');
  });

  it('preserves display text, subpath and the embed marker', async () => {
    const fake = createFakeLinkVault({
      [FROM]: '# Osteopontin-2\n',
      [TO]: '# Osteopontin\n',
      'Notizen/Knochenstoffwechsel.md':
        'A [[Osteopontin-2|OPN]] and a section [[Osteopontin-2#Funktion]].\n' +
        '![[Osteopontin-2#Funktion|OPN]]\n',
    });

    const result = await retargetLinksToPage(fake, FROM, TO);

    expect(fake.read('Notizen/Knochenstoffwechsel.md')).toBe(
      'A [[Osteopontin|OPN]] and a section [[Osteopontin#Funktion]].\n' +
      '![[Osteopontin#Funktion|OPN]]\n'
    );
    expect(result.linksRewritten).toBe(3);
  });

  it('does not touch a link quoted inside a code block', async () => {
    const fake = createFakeLinkVault({
      [FROM]: '# Osteopontin-2\n',
      [TO]: '# Osteopontin\n',
      'Notizen/Plugin-Notizen.md': 'Example:\n\n```\n[[Osteopontin-2]]\n```\n',
    });

    const result = await retargetLinksToPage(fake, FROM, TO);

    expect(fake.read('Notizen/Plugin-Notizen.md')).toContain('[[Osteopontin-2]]');
    expect(result.linksRewritten).toBe(0);
  });

  it('skips the page being deleted and files without references', async () => {
    const fake = createFakeLinkVault({
      [FROM]: '# Osteopontin-2\n\nSee [[Osteopontin-2]] and [[Osteopontin]].\n',
      [TO]: '# Osteopontin\n',
      'Notizen/Unrelated.md': 'No links here.\n',
    });

    const result = await retargetLinksToPage(fake, FROM, TO);

    expect(fake.read(FROM)).toContain('[[Osteopontin-2]]');
    expect(fake.processed).toEqual([]);
    expect(result).toEqual({ filesChanged: 0, linksRewritten: 0, stale: 0 });
  });

  it('reports a link it could not rewrite instead of splicing on a stale offset', async () => {
    const fake = createFakeLinkVault({
      [FROM]: '# Osteopontin-2\n',
      [TO]: '# Osteopontin\n',
      'Notizen/Knochenstoffwechsel.md': 'See [[Osteopontin-2]].\n',
    });
    // The cache is read first; the file then changes underneath, as it would if
    // the user edited the note between indexing and the merge.
    const cache = fake.metadataCache.getFileCache;
    fake.metadataCache.getFileCache = file => {
      const result = cache({ path: file.path });
      if (file.path === 'Notizen/Knochenstoffwechsel.md') {
        fake.write(file.path, 'Rewritten by hand. See [[Osteopontin-2]].\n');
      }
      return result;
    };

    const result = await retargetLinksToPage(fake, FROM, TO);

    expect(fake.read('Notizen/Knochenstoffwechsel.md')).toBe('Rewritten by hand. See [[Osteopontin-2]].\n');
    expect(result).toEqual({ filesChanged: 0, linksRewritten: 0, stale: 1 });
  });

  it('rewrites several links in one file in a single write', async () => {
    const fake = createFakeLinkVault({
      [FROM]: '# Osteopontin-2\n',
      [TO]: '# Osteopontin\n',
      'Notizen/Knochenstoffwechsel.md': '[[Osteopontin-2]] und [[Osteopontin-2|OPN]] und [[Osteopontin-2]].\n',
    });

    const result = await retargetLinksToPage(fake, FROM, TO);

    expect(fake.read('Notizen/Knochenstoffwechsel.md')).toBe(
      '[[Osteopontin]] und [[Osteopontin|OPN]] und [[Osteopontin]].\n'
    );
    expect(result).toEqual({ filesChanged: 1, linksRewritten: 3, stale: 0 });
    expect(fake.processed).toEqual(['Notizen/Knochenstoffwechsel.md']);
  });

  it('is a no-op when source and target are the same page', async () => {
    const fake = createFakeLinkVault({
      [TO]: '# Osteopontin\n',
      'Notizen/Knochenstoffwechsel.md': 'See [[Osteopontin]].\n',
    });

    const result = await retargetLinksToPage(fake, TO, TO);

    expect(result).toEqual({ filesChanged: 0, linksRewritten: 0, stale: 0 });
    expect(fake.processed).toEqual([]);
  });
});
