// Pure-function tests for section-extractor.ts
//
// Contract (rewritten 2026-06-27 with first-principles i18n review):
//
//   extractSummaryFromPage(body, options): string
//
//   options:
//     descriptionLabel: the localized "Description" section title for this
//                      user's wiki (entity pages). Pulled from
//                      getSectionLabels(settings).description. Examples:
//                      'Description' / '描述' / 'Beschreibung' / etc.
//                      Supports user-customized wikiLanguage via
//                      settings.useCustomWikiLanguage.
//     definitionLabel:  the localized "Definition" section title for this
//                      user's wiki (concept pages). Same source.
//     pageType:        'entity' | 'concept'. Determines which label to look
//                      for FIRST when both exist. If the chosen label is
//                      not present, fall back to the other label.
//     maxChars:        hard cap on returned length. The extractor truncates
//                      at the last sentence boundary within maxChars; if no
//                      boundary fits, hard-truncates and appends '…' (still
//                      within maxChars).
//
//   Behavior:
//   - Match the appropriate `## <label>` header (case-insensitive).
//   - Extract content up to next ## or ### header.
//   - Strip `[[wikilink]]` and `[[#^block-id]]` constructs.
//   - Strip folder prefix from `[[entities/Cardiology]]` → `Cardiology`.
//   - Truncate at last sentence boundary before maxChars.
//   - If neither label matches, return ''.
//
// Why i18n-aware API: previously hardcoded `description|definition` matched
// only English. Per #198 / first-principles review, the right level of
// abstraction is "section labels are caller-supplied" — the caller (query
// engine at P1-5) has settings, settings has wikiLanguage, getSectionLabels
// translates. User-customized wikiLanguage via useCustomWikiLanguage flows
// through unchanged because labels are opaque strings to the extractor.

import { describe, it, expect } from 'vitest';
import { extractSummaryFromPage } from '../../core/section-extractor';

const EN_DESC = 'Description';
const EN_DEF = 'Definition';

// Helper to keep test bodies readable
const sectionBody = (label: string, content: string, after = '## More\nbar') =>
  [`## Basic Information`, 'foo', '', `## ${label}`, content, '', after].join('\n');

describe('extractSummaryFromPage — English baseline', () => {
  it('extracts ## Description for entity page', () => {
    const body = sectionBody(EN_DESC, 'This is the description.');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: EN_DESC,
      definitionLabel: EN_DEF,
      pageType: 'entity',
      maxChars: 1000,
    })).toBe('This is the description.');
  });

  it('extracts ## Definition for concept page', () => {
    const body = sectionBody(EN_DEF, 'A formal definition.');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: EN_DESC,
      definitionLabel: EN_DEF,
      pageType: 'concept',
      maxChars: 1000,
    })).toBe('A formal definition.');
  });

  it('prefers ## Description on a concept page that carries both sections', () => {
    // The concept template writes a one-sentence Definition above the
    // Description that holds the page's substance; the query prompt used to
    // take the sentence and drop the substance (measured 2026-09-04: 183 of
    // 241 concept pages with both sections).
    const body = [
      '## Description',
      'Osteoporosis is multifactorial: vitamin deficiency, inactivity and dysbiosis. Therapy combines D3 + K2 with resistance training.',
      '',
      '## Definition',
      'A disease of reduced bone density.',
      '',
      '## More',
      'bar',
    ].join('\n');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: EN_DESC,
      definitionLabel: EN_DEF,
      pageType: 'concept',
      maxChars: 1000,
    })).toBe('Osteoporosis is multifactorial: vitamin deficiency, inactivity and dysbiosis. Therapy combines D3 + K2 with resistance training.');
  });

  it('returns content up to the next ## header', () => {
    const body = [
      '## Description',
      'First paragraph.',
      '',
      'Second paragraph here.',
      '',
      '## Related',
      'something',
    ].join('\n');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: EN_DESC,
      definitionLabel: EN_DEF,
      pageType: 'entity',
      maxChars: 1000,
    })).toBe('First paragraph.\n\nSecond paragraph here.');
  });

  it('returns content up to the next ### header (sub-header boundary)', () => {
    const body = [
      '## Description',
      'Intro paragraph.',
      '',
      '### Note',
      'side note',
      '',
      '## After',
    ].join('\n');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: EN_DESC,
      definitionLabel: EN_DEF,
      pageType: 'entity',
      maxChars: 1000,
    })).toBe('Intro paragraph.');
  });
});

describe('extractSummaryFromPage — i18n label matching', () => {
  it('matches ## 描述 (Chinese simplified)', () => {
    const body = sectionBody('描述', '中文描述内容。');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: '描述',
      definitionLabel: '定义',
      pageType: 'entity',
      maxChars: 1000,
    })).toBe('中文描述内容。');
  });

  it('matches ## 描述 (Chinese traditional)', () => {
    const body = sectionBody('描述', '繁體中文描述內容。');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: '描述',
      definitionLabel: '定義',
      pageType: 'entity',
      maxChars: 1000,
    })).toBe('繁體中文描述內容。');
  });

  it('matches ## 定義 (Chinese concept)', () => {
    const body = sectionBody('定義', '正式定義在此。');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: '描述',
      definitionLabel: '定義',
      pageType: 'concept',
      maxChars: 1000,
    })).toBe('正式定義在此。');
  });

  it('matches ## 概要 (Japanese)', () => {
    const body = sectionBody('概要', '日本語の概要。');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: '概要',
      definitionLabel: '定義',
      pageType: 'entity',
      maxChars: 1000,
    })).toBe('日本語の概要。');
  });

  it('matches ## 정의 (Korean)', () => {
    const body = sectionBody('정의', '한국어 정의 내용.');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: '설명',
      definitionLabel: '정의',
      pageType: 'concept',
      maxChars: 1000,
    })).toBe('한국어 정의 내용.');
  });

  it('matches ## Beschreibung (German)', () => {
    const body = sectionBody('Beschreibung', 'Deutsche Beschreibung.');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: 'Beschreibung',
      definitionLabel: 'Definition',
      pageType: 'entity',
      maxChars: 1000,
    })).toBe('Deutsche Beschreibung.');
  });

  it('matches ## Définition (French concept)', () => {
    const body = sectionBody('Définition', 'Définition formelle.');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: 'Description',
      definitionLabel: 'Définition',
      pageType: 'concept',
      maxChars: 1000,
    })).toBe('Définition formelle.');
  });

  it('matches ## Descripción (Spanish)', () => {
    const body = sectionBody('Descripción', 'Descripción en español.');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: 'Descripción',
      definitionLabel: 'Definición',
      pageType: 'entity',
      maxChars: 1000,
    })).toBe('Descripción en español.');
  });

  it('matches ## Descrizione (Italian)', () => {
    const body = sectionBody('Descrizione', 'Descrizione italiana.');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: 'Descrizione',
      definitionLabel: 'Definizione',
      pageType: 'entity',
      maxChars: 1000,
    })).toBe('Descrizione italiana.');
  });

  it('matches ## Definição (Portuguese concept)', () => {
    const body = sectionBody('Definição', 'Definição formal.');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: 'Descrição',
      definitionLabel: 'Definição',
      pageType: 'concept',
      maxChars: 1000,
    })).toBe('Definição formal.');
  });
});

describe('extractSummaryFromPage — user-customized label', () => {
  it('matches user-customized wikiLanguage label (e.g. "Summary")', () => {
    // User set wikiLanguage: 'Summary' (via useCustomWikiLanguage: true).
    // The page body uses ## Summary as their preferred section title.
    const body = sectionBody('Summary', 'User-chosen summary text.');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: 'Summary',
      definitionLabel: 'Definition',
      pageType: 'entity',
      maxChars: 1000,
    })).toBe('User-chosen summary text.');
  });

  it('matches a non-English custom label', () => {
    // User customizes wikiLanguage: '概要' (Japanese, but they kept
    // Description's English word). The extractor should still match
    // because labels are caller-supplied.
    const body = sectionBody('概要', 'Custom Japanese label.');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: '概要',
      definitionLabel: '定義',
      pageType: 'entity',
      maxChars: 1000,
    })).toBe('Custom Japanese label.');
  });
});

describe('extractSummaryFromPage — the description is primary for both page types', () => {
  it('entity page with both ## Description and ## Definition uses Description', () => {
    // The generation template gives a concept only a Definition; the merge
    // template writes a Description ("core definition and significance")
    // above it on every multi-source page. The description is where the
    // substance accumulates, so it is primary for both types; the
    // definition is the fallback for a page that has nothing else.
    const body = [
      '## Description',
      'entity desc',
      '',
      '## Definition',
      'concept def',
      '',
      '## After',
    ].join('\n');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: 'Description',
      definitionLabel: 'Definition',
      pageType: 'entity',
      maxChars: 1000,
    })).toBe('entity desc');
  });

  it('concept page with both ## Description and ## Definition uses Description too', () => {
    const body = [
      '## Description',
      'entity desc',
      '',
      '## Definition',
      'concept def',
      '',
      '## After',
    ].join('\n');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: 'Description',
      definitionLabel: 'Definition',
      pageType: 'concept',
      maxChars: 1000,
    })).toBe('entity desc');
  });

  it('falls back to other label when pageType label is missing', () => {
    // Concept page with only ## Description (no ## Definition). The
    // extractor should fall back to ## Description rather than return ''.
    const body = [
      '## Description',
      'shared description.',
      '',
      '## After',
    ].join('\n');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: 'Description',
      definitionLabel: 'Definition',
      pageType: 'concept',
      maxChars: 1000,
    })).toBe('shared description.');
  });

  it('returns empty string when neither label is present', () => {
    const body = [
      '## Basic Information',
      'foo',
      '',
      '## More',
      'bar',
    ].join('\n');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: 'Description',
      definitionLabel: 'Definition',
      pageType: 'entity',
      maxChars: 1000,
    })).toBe('');
  });
});

describe('extractSummaryFromPage — case-insensitive label matching', () => {
  it('matches lowercase label when caller passes lowercase', () => {
    // getSectionLabels returns canonical case; user pages might use
    // mixed case. The extractor must match case-insensitively because
    // markdown convention is forgiving.
    const body = sectionBody('description', 'lowercase header.');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: 'Description',
      definitionLabel: 'Definition',
      pageType: 'entity',
      maxChars: 1000,
    })).toBe('lowercase header.');
  });

  it('matches uppercase label when caller passes canonical', () => {
    const body = sectionBody('DEFINITION', 'uppercase header.');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: 'Description',
      definitionLabel: 'Definition',
      pageType: 'concept',
      maxChars: 1000,
    })).toBe('uppercase header.');
  });

  it('matches Chinese label exactly (no case folding for CJK)', () => {
    const body = sectionBody('描述', '内容。');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: '描述',
      definitionLabel: '定义',
      pageType: 'entity',
      maxChars: 1000,
    })).toBe('内容。');
  });
});

describe('extractSummaryFromPage — wikilink cleaning', () => {
  it('strips [[wikilink]] syntax to display text', () => {
    const body = sectionBody('Description', 'See [[Cardiology]] for context.');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: 'Description',
      definitionLabel: 'Definition',
      pageType: 'entity',
      maxChars: 1000,
    })).toBe('See Cardiology for context.');
  });

  it('strips [[wikilink|alias]] keeping alias text', () => {
    const body = sectionBody('Definition', 'A [[Heart|cardiac muscle]] is essential.');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: 'Description',
      definitionLabel: 'Definition',
      pageType: 'concept',
      maxChars: 1000,
    })).toBe('A cardiac muscle is essential.');
  });

  it('strips [[entities/slug]] and [[sources/slug]] to bare slug', () => {
    const body = sectionBody('Description',
      'Compare [[entities/Cardiology]] with [[sources/Clinical Guidelines 2024]].');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: 'Description',
      definitionLabel: 'Definition',
      pageType: 'entity',
      maxChars: 1000,
    })).toBe('Compare Cardiology with Clinical Guidelines 2024.');
  });

  it('strips pure-anchor [[#^block-id]] (no target text)', () => {
    const body = sectionBody('Description', 'Important point[[#^note1]].');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: 'Description',
      definitionLabel: 'Definition',
      pageType: 'entity',
      maxChars: 1000,
    })).toBe('Important point.');
  });
});

describe('extractSummaryFromPage — truncation at sentence boundary', () => {
  it('does not truncate when content fits within maxChars', () => {
    const body = sectionBody('Description', 'Short text.');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: 'Description',
      definitionLabel: 'Definition',
      pageType: 'entity',
      maxChars: 1000,
    })).toBe('Short text.');
  });

  it('truncates at last sentence boundary within maxChars', () => {
    const body = sectionBody('Description',
      'First sentence here. Second sentence follows. Third sentence is too long and would push us over.');
    const result = extractSummaryFromPage(body, {
      descriptionLabel: 'Description',
      definitionLabel: 'Definition',
      pageType: 'entity',
      maxChars: 50,
    });
    expect(result).toBe('First sentence here. Second sentence follows.');
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it('hard-truncates and appends ellipsis when no sentence boundary fits', () => {
    // No period in the first 200 chars. We hard-truncate at
    // maxChars - 1 to make room for '…' (UTF-8 1 char).
    const body = sectionBody('Description', 'x'.repeat(500));
    const result = extractSummaryFromPage(body, {
      descriptionLabel: 'Description',
      definitionLabel: 'Definition',
      pageType: 'entity',
      maxChars: 200,
    });
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.endsWith('…')).toBe(true);
  });

  it('truncates at last sentence boundary within maxChars (preserves more content)', () => {
    // Two sentences, both fit within maxChars=200. The extractor picks
    // the LAST sentence boundary (the one closer to maxChars) so callers
    // get the most content possible within their budget.
    const body = sectionBody('Description', `${'A'.repeat(100)}. ${'B'.repeat(50)}.`);
    const result = extractSummaryFromPage(body, {
      descriptionLabel: 'Description',
      definitionLabel: 'Definition',
      pageType: 'entity',
      maxChars: 200,
    });
    // Last sentence ends at pos 153 ("AAA...A. BBB...B."). Both sentences
    // fit, so we keep the whole thing rather than truncating at the
    // first sentence end.
    expect(result).toBe('A'.repeat(100) + '. ' + 'B'.repeat(50) + '.');
    expect(result).toMatch(/[.!?]$/);
    expect(result.length).toBeLessThanOrEqual(200);
  });
});

describe('extractSummaryFromPage — body leading frontmatter tolerance', () => {
  it('skips YAML frontmatter at top of body', () => {
    const body = [
      '---',
      'title: foo',
      '---',
      '',
      '## Description',
      'works.',
      '',
      '## More',
    ].join('\n');
    expect(extractSummaryFromPage(body, {
      descriptionLabel: 'Description',
      definitionLabel: 'Definition',
      pageType: 'entity',
      maxChars: 1000,
    })).toBe('works.');
  });
});

describe('extractSummaryFromPage — empty body safety', () => {
  it('returns empty string for empty body', () => {
    expect(extractSummaryFromPage('', {
      descriptionLabel: 'Description',
      definitionLabel: 'Definition',
      pageType: 'entity',
      maxChars: 1000,
    })).toBe('');
  });

  it('returns empty string for body without any headers', () => {
    expect(extractSummaryFromPage('just a paragraph', {
      descriptionLabel: 'Description',
      definitionLabel: 'Definition',
      pageType: 'entity',
      maxChars: 1000,
    })).toBe('');
  });
});