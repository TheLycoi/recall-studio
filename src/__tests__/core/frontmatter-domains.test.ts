// Stage 5 (#568): `domains:` is no plugin field at all. The axis writes into
// `tags:`; a user-authored `domains:` is an unknown key like any other and
// rides the #356 passthrough untouched.

import { describe, it, expect } from 'vitest';
import {
  serializeFrontmatter,
  extractPassthroughLines,
  CANONICAL_FRONTMATTER_KEYS,
  mergeFrontmatter,
  mergeFrontmatterArrayField,
  enforceFrontmatterConstraints,
  parseFrontmatter,
} from '../../core/frontmatter';

const DOMAINS = ['Sorte/Mineralstoff', 'Fachgebiet/Hämatologie'];

describe('domains: — canonical key', () => {
  it('is NOT canonical — a user-authored domains: field is a passthrough line', () => {
    expect(CANONICAL_FRONTMATTER_KEYS.has('domains')).toBe(false);
    const content = `---
type: entity
domains:
  - "Sorte/Mineralstoff"
redirect_to: "[[x]]"
---

# Body`;
    expect(extractPassthroughLines(content)).toEqual(['domains:', '  - "Sorte/Mineralstoff"', 'redirect_to: "[[x]]"']);
  });

  it('is never serialized by the canonical writer', () => {
    const block = serializeFrontmatter({
      type: 'entity', created: '2026-01-01', updated: '2026-08-21',
      tags: ['substance'], domains: DOMAINS, reviewed: true, aliases: ['Alt'],
    });
    expect(block).not.toContain('domains');
  });

  it('mergeFrontmatter carries the existing domains across a re-ingest rewrite, once', () => {
    const existing = `---
type: concept
created: 2026-01-01
updated: 2026-01-02
sources:
  - "[[sources/a]]"
tags:
  - "method"
domains:
  - "Fachgebiet/Hämatologie"
---

# Body`;
    const { frontmatter } = mergeFrontmatter(existing, 'sources/b');
    expect(frontmatter.match(/^domains:/gm)?.length).toBe(1);
    expect(frontmatter).toContain('domains:\n  - "Fachgebiet/Hämatologie"');
    expect(frontmatter).toContain('[[sources/b]]');
  });

  it('enforceFrontmatterConstraints keeps block and inline domains, without a duplicate header', () => {
    const block = `---
type: entity
created: 2026-01-01
tags: [substance]
domains:
  - "Sorte/Mineralstoff"
  - "Fachgebiet/Hämatologie"
---

# Body`;
    const outBlock = enforceFrontmatterConstraints(block, 'entity');
    expect(parseFrontmatter(outBlock)?.domains).toEqual(DOMAINS);
    expect(outBlock.match(/^domains:/gm)?.length).toBe(1);

    const inline = `---
type: entity
created: 2026-01-01
tags: [substance]
domains: [Sorte/Mineralstoff, Fachgebiet/Hämatologie]
---

# Body`;
    const outInline = enforceFrontmatterConstraints(inline, 'entity');
    expect(parseFrontmatter(outInline)?.domains).toEqual(DOMAINS);
    expect(outInline.match(/^domains:/gm)?.length).toBe(1);
  });

  it('a page without the field stays without it through every writer (absence is not a signal)', () => {
    const content = `---
type: entity
created: 2026-01-01
tags: [substance]
---

# Body`;
    expect(enforceFrontmatterConstraints(content, 'entity')).not.toContain('domains');
    expect(mergeFrontmatter(content, 'sources/a').frontmatter).not.toContain('domains');
    expect(mergeFrontmatterArrayField(content, 'aliases', ['x'])).not.toContain('domains');
  });
});

// Tag-Achse Stufe 4 (S137): one field — mergeFrontmatter unions the incoming
// belonging subset into `tags:` next to the identity value; an existing
// `domains:` is legacy and stays exactly as it was, never extended.
describe('mergeFrontmatter — incoming belonging values land in tags (Tag-Achse Stufe 4)', () => {
  const PAGE = `---
type: entity
created: 2026-01-01
tags:
  - "Sorte/Mineralstoff"
domains:
  - "Fachgebiet/Hämatologie"
---

# Zink
`;

  it('unions incoming values after the existing tags, deduplicated, and leaves domains untouched', () => {
    const { frontmatter } = mergeFrontmatter(PAGE, 'sources/zink', undefined, ['Thema/Ernährung', 'Sorte/Mineralstoff', 'Fach/Endokrinologie']);
    const fm = parseFrontmatter(frontmatter + '\n\nbody') ?? {};
    expect(fm.tags).toEqual(['Sorte/Mineralstoff', 'Thema/Ernährung', 'Fach/Endokrinologie']);
    expect(fm.domains).toEqual(['Fachgebiet/Hämatologie']);
  });

  // The validator folds (NFC + trim + lowercase); a raw-equality merge here
  // re-admitted what it had just folded away — one value, written twice.
  it('folds spelling variants: a case or spacing variant is not a second value', () => {
    const { frontmatter } = mergeFrontmatter(PAGE, 'sources/zink', undefined, [
      'sorte/mineralstoff',
      ' Thema/Ernährung ',
      'thema/ernährung',
    ]);
    const fm = parseFrontmatter(frontmatter + '\n\nbody') ?? {};
    expect(fm.tags).toEqual(['Sorte/Mineralstoff', 'Thema/Ernährung']);
  });

  it('keeps the existing tags and domains when nothing comes in', () => {
    const { frontmatter } = mergeFrontmatter(PAGE, 'sources/zink');
    expect(parseFrontmatter(frontmatter + '\n\nbody')?.tags).toEqual(['Sorte/Mineralstoff']);
    expect(parseFrontmatter(frontmatter + '\n\nbody')?.domains).toEqual(['Fachgebiet/Hämatologie']);
    const { frontmatter: fm2 } = mergeFrontmatter(PAGE, 'sources/zink', undefined, []);
    expect(parseFrontmatter(fm2 + '\n\nbody')?.tags).toEqual(['Sorte/Mineralstoff']);
  });

  it('never creates a domains field, and a page without one stays without one', () => {
    const bare = '---\ntype: entity\ncreated: 2026-01-01\n---\n\n# Zink\n';
    const { frontmatter } = mergeFrontmatter(bare, 'sources/zink', undefined, ['Thema/Ernährung']);
    expect(parseFrontmatter(frontmatter + '\n\nbody')?.tags).toEqual(['Thema/Ernährung']);
    expect(frontmatter).not.toContain('domains');
  });
});
