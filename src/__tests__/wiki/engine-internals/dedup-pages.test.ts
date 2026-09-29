// `updated_pages` is filled from three branches — entity, concept and related
// page — and one page legitimately passes two of them in the same run. Holding
// the list distinct where it is filled is what keeps every reader correct: the
// log, the report count, and the cancelled and failed paths that hand the array
// straight to `onDone` without a dedup of their own.

import { describe, it, expect } from 'vitest';
import { dedupPages, recordUpdatedPage } from '../../../wiki/engine-internals/dedup-pages';

describe('dedupPages', () => {
  it('keeps the first occurrence and the original order', () => {
    expect(dedupPages(['b.md', 'a.md', 'b.md', 'c.md'])).toEqual(['b.md', 'a.md', 'c.md']);
  });
});

describe('recordUpdatedPage', () => {
  it('records a page once, however many branches reach it', () => {
    const analysis = { updated_pages: [] as string[] };
    // Updated as a concept, then listed as a related page in the same run.
    recordUpdatedPage(analysis, 'wiki/concepts/Laktatazidose.md');
    recordUpdatedPage(analysis, 'wiki/concepts/Laktatazidose.md');
    expect(analysis.updated_pages).toEqual(['wiki/concepts/Laktatazidose.md']);
  });

  it('keeps distinct pages and the order they were touched in', () => {
    const analysis = { updated_pages: [] as string[] };
    for (const p of ['wiki/concepts/A.md', 'wiki/entities/B.md', 'wiki/concepts/A.md', 'wiki/concepts/C.md']) {
      recordUpdatedPage(analysis, p);
    }
    expect(analysis.updated_pages).toEqual(['wiki/concepts/A.md', 'wiki/entities/B.md', 'wiki/concepts/C.md']);
  });

  it('leaves entries a caller put there directly alone', () => {
    const analysis = { updated_pages: ['wiki/entities/Existing.md'] };
    recordUpdatedPage(analysis, 'wiki/entities/Existing.md');
    recordUpdatedPage(analysis, 'wiki/entities/New.md');
    expect(analysis.updated_pages).toEqual(['wiki/entities/Existing.md', 'wiki/entities/New.md']);
  });
});
