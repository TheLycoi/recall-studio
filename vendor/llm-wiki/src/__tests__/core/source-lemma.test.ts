// patch 16 — the source note's own lemma must get a node, but only when it is
// genuinely missing and genuinely wanted. Every case here is drawn from a real
// vault observation, noted next to the assertion.
import { describe, it, expect } from 'vitest';
import {
  isLemmaExtracted,
  decideSourceLemma,
} from '../../core/source-lemma';
import { slugKeys } from '../../core/slug';

describe('slugKeys (imported from core/slug — Issue #366 regression guard)', () => {
  // Regression: PR #357 originally re-implemented slugKeys locally without
  // threading the `turkishFold` opt-in, which would have re-introduced the
  // duplicate-page bug Issue #366 fixed. source-lemma.ts must use the canonical
  // version. Compare keys between Turkish-folded inputs to confirm they share
  // at least one common slug.
  it('folds Turkish İ→i so İnsülin and insülin share a comparison key', () => {
    const a = slugKeys('İnsülin', [], { turkishFold: true });
    const b = slugKeys('insülin', [], { turkishFold: true });
    const intersection = [...a].filter(k => b.has(k));
    expect(intersection.length).toBeGreaterThan(0);
  });

  it('without Turkish fold, the same inputs yield distinct keys', () => {
    const a = slugKeys('İnsülin');
    const b = slugKeys('insülin');
    expect(a.has('insülin')).toBe(false);
    expect(b.has('insülin')).toBe(true);
  });
});

describe('isLemmaExtracted', () => {
  it('matches an extracted item by name across space/dash spelling', () => {
    // The vault writes `Silent-Inflammation`; the note is titled with a space.
    const keys = slugKeys('Silent Inflammation');
    expect(isLemmaExtracted(keys, [{ name: 'Silent-Inflammation' }])).toBe(true);
  });

  it('matches via an alias the extraction pre-generated', () => {
    const keys = slugKeys('CoQ10');
    expect(isLemmaExtracted(keys, [{ name: 'Coenzym Q10', aliases: ['CoQ10'] }])).toBe(true);
  });

  it('does not match a merely related item', () => {
    // Klotho vs alpha-Klotho: the b1 run produced the latter and not the former.
    const keys = slugKeys('Klotho');
    expect(isLemmaExtracted(keys, [
      { name: 'alpha-Klotho' },
      { name: 'beta-Klotho' },
    ])).toBe(false);
  });

  it('is false for an empty extraction list', () => {
    expect(isLemmaExtracted(slugKeys('Klotho'), [])).toBe(false);
  });
});

describe('decideSourceLemma', () => {
  it('adds the lemma when the extraction missed it', () => {
    // The observed b1 case: alpha-/beta-Klotho extracted, Klotho itself not.
    expect(decideSourceLemma({
      sourceTitle: 'Klotho',
      entities: [{ name: 'alpha-Klotho' }, { name: 'beta-Klotho' }],
      concepts: [{ name: 'Phosphathaushalt' }],
    })).toEqual({ action: 'add', name: 'Klotho' });
  });

  it('skips when the lemma is already among the entities', () => {
    expect(decideSourceLemma({
      sourceTitle: 'Papain',
      entities: [{ name: 'Papain' }],
      concepts: [],
    })).toEqual({ action: 'skip', reason: 'already-extracted' });
  });

  it('skips when the lemma is already among the concepts', () => {
    expect(decideSourceLemma({
      sourceTitle: 'Silent Inflammation',
      entities: [],
      concepts: [{ name: 'Silent-Inflammation' }],
    })).toEqual({ action: 'skip', reason: 'already-extracted' });
  });

  it('skips when no title is available', () => {
    expect(decideSourceLemma({
      sourceTitle: '   ',
      entities: [],
      concepts: [],
    })).toEqual({ action: 'skip', reason: 'no-title' });
  });

  it('matches through a curated note alias, so no duplicate is added', () => {
    // `Notizen/LAMA-LABA.md` carries the alias `LAMA/LABA`; the slug of that
    // alias drops the slash, so the extracted `LAMALABA` is the same lemma.
    expect(decideSourceLemma({
      sourceTitle: 'LAMA-LABA',
      sourceAliases: ['LAMA/LABA'],
      entities: [{ name: 'LAMALABA' }],
      concepts: [],
    })).toEqual({ action: 'skip', reason: 'already-extracted' });
  });

  it('adds nothing for a vault with an extracted lemma and no aliases', () => {
    expect(decideSourceLemma({
      sourceTitle: 'Rutosid',
      entities: [{ name: 'Rutosid' }],
      concepts: [],
    })).toEqual({ action: 'skip', reason: 'already-extracted' });
  });
});