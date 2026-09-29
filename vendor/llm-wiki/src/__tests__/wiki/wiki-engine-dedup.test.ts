// Helper extracted to dedup page paths before reporting (#173 Symptom B).
// Pure: input order is preserved, only exact-string duplicates are collapsed.

import { describe, it, expect } from 'vitest';
import { dedupPages } from '../../wiki/wiki-engine';

describe('dedupPages (#173 Symptom B)', () => {
  it('preserves order and drops exact-string duplicates', () => {
    expect(
      dedupPages([
        'wiki/entities/alpha.md',
        'wiki/entities/beta.md',
        'wiki/entities/alpha.md',
      ])
    ).toEqual(['wiki/entities/alpha.md', 'wiki/entities/beta.md']);
  });

  it('returns an empty array for empty input', () => {
    expect(dedupPages([])).toEqual([]);
  });

  it('returns the same array (deduped) when no duplicates exist', () => {
    expect(dedupPages(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('collapses many identical entries to one', () => {
    expect(dedupPages(['x', 'x', 'x', 'x'])).toEqual(['x']);
  });
});
