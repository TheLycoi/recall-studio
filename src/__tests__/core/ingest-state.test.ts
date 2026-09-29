// ingest-state.test.ts — the disk answer the file picker shows (#598)
//
// Two decisions live in core/ingest-state.ts, and both were found by
// looking at a bug rather than by design:
//
//   pageBelongsToNote  is the ownership check #595 got wrong. It is
//                      shared with `isAlreadyIngested` on purpose — the
//                      picker displaying its own answer to the same
//                      question is how the two would drift apart again.
//   noteHasDrifted     is the `contentHash` comparison scanSourceDrift
//                      (#577) makes, narrowed to one note, which makes
//                      it undecidable on multi-source pages.
//
// Pure: no vault, no DOM. The caller reads the files.

import { describe, it, expect } from 'vitest';
import { pageBelongsToNote, noteHasDrifted } from '../../core/ingest-state';
import { hashBody } from '../../core/source-requirements';
import { extractBody } from '../../core/frontmatter';

const NOTE = 'Notizen/Butyrat.md';

function page(fm: string, body = 'Summary.'): string {
  return `---\n${fm}\n---\n\n${body}\n`;
}

function note(body: string): string {
  return `---\ntags:\n  - Thema/Mikrobiom\n---\n\n${body}\n`;
}

describe('pageBelongsToNote', () => {
  it('falls back to existence when the page has no frontmatter', () => {
    // Pre-#164 pages prove nothing about ownership. Absence of
    // evidence is not proof of a different owner.
    expect(pageBelongsToNote('# Butyrat\n\nSummary.\n', NOTE)).toBe(true);
  });

  it('falls back to existence when no origin field is present', () => {
    expect(pageBelongsToNote(page('type: source'), NOTE)).toBe(true);
  });

  it('accepts the canonical scalar source_file', () => {
    expect(pageBelongsToNote(page(`source_file: ${NOTE}`), NOTE)).toBe(true);
  });

  it('accepts a source_file written as a wikilink', () => {
    expect(pageBelongsToNote(page(`source_file: "[[${NOTE}]]"`), NOTE)).toBe(true);
  });

  it('rejects a slug collision — same page name, different origin', () => {
    // Two notes in different folders can share a basename and therefore
    // a slug. The second one does not own the first one's page.
    expect(pageBelongsToNote(page('source_file: Frontier/Butyrat.md'), NOTE)).toBe(false);
  });

  it('reads the note out of a sources: list when there is no scalar', () => {
    expect(pageBelongsToNote(page(`sources:\n  - "[[${NOTE}]]"`), NOTE)).toBe(true);
  });

  it('is not fooled by a sources: list of page links (the #595 case)', () => {
    // `sources:` holds `[[sources/X]]` links by contract (#81 normalizer),
    // so the note path is the one shape it cannot contain. Reading it
    // alone made every extended page report "not ingested".
    const fm = `sources:\n  - "[[sources/butyrat]]"\n  - "[[sources/scfa]]"`;
    expect(pageBelongsToNote(page(fm), NOTE)).toBe(false);
  });

  it('accepts the scalar even when the list names other pages', () => {
    const fm = `source_file: ${NOTE}\nsources:\n  - "[[sources/scfa]]"`;
    expect(pageBelongsToNote(page(fm), NOTE)).toBe(true);
  });
});

describe('noteHasDrifted', () => {
  const body = 'Butyrat entsteht bei der Fermentation von Ballaststoffen.';
  const stored = hashBody(extractBody(note(body)));

  it('reports no drift when the stored hash still matches', () => {
    const p = page(`source_file: ${NOTE}\ncontentHash: ${stored}`);
    expect(noteHasDrifted(p, note(body))).toBe(false);
  });

  it('reports drift when the note body changed', () => {
    const p = page(`source_file: ${NOTE}\ncontentHash: ${stored}`);
    expect(noteHasDrifted(p, note(body + ' Und im Dickdarm resorbiert.'))).toBe(true);
  });

  it('ignores frontmatter-only edits — the hash covers the body', () => {
    const p = page(`source_file: ${NOTE}\ncontentHash: ${stored}`);
    const retagged = `---\ntags:\n  - Sorte/Molekuel\n---\n\n${body}\n`;
    expect(noteHasDrifted(p, retagged)).toBe(false);
  });

  it('stays silent on a page with no contentHash (pre-#164)', () => {
    const p = page(`source_file: ${NOTE}`);
    expect(noteHasDrifted(p, note('anything at all'))).toBe(false);
  });

  it('stays silent on a multi-source page — the one hash names one writer', () => {
    // The page carries ONE hash, belonging to whichever note wrote it
    // last. A mismatch cannot be told apart from "a different origin
    // wrote it last", so claiming drift would mark most origins of
    // every merged page.
    const fm = `source_file: ${NOTE}\nsources:\n  - "[[sources/scfa]]"\ncontentHash: ${stored}`;
    expect(noteHasDrifted(page(fm), note('a completely different body'))).toBe(false);
  });

  it('stays silent when the page has no frontmatter at all', () => {
    expect(noteHasDrifted('# Butyrat\n', note('anything'))).toBe(false);
  });
});
