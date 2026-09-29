import { describe, it, expect } from 'vitest';
import { truncateListForDisplay, truncateMentions, nestReportUnderParent } from '../../core/report';
describe('truncateMentions', () => {
  it('returns empty string for undefined or empty input', () => {
    expect(truncateMentions(undefined)).toBe('');
    expect(truncateMentions([])).toBe('');
  });

  it('formats each mention as footnote-style line with source link', () => {
    const result = truncateMentions(['老子是道家创始人。'], 500, 'sources/史记_司马迁.md');
    expect(result).toBe('- 老子是道家创始人。 — [[sources/史记_司马迁|史记_司马迁]]');
  });

  it('uses plain list when no source is provided', () => {
    const result = truncateMentions(['test quote']);
    expect(result).toBe('- test quote');
  });

  it('joins multiple mentions with newlines', () => {
    const result = truncateMentions(['first', 'second'], 500, 'sources/test.md');
    expect(result).toContain('- first — [[sources/test|test]]');
    expect(result).toContain('- second — [[sources/test|test]]');
    expect(result.split('\n')).toHaveLength(2);
  });

  it('truncates first mention when it exceeds maxChars', () => {
    const longQuote = 'A'.repeat(1000);
    const result = truncateMentions([longQuote], 100, 'sources/x.md');
    // The link itself takes ~30 chars; we allow a small overshoot for the ellipsis
    expect(result.length).toBeLessThanOrEqual(110);
    expect(result).toContain('[[sources/x|x]]');
    expect(result).toContain('...');
  });

  it('stops adding mentions when adding next would exceed maxChars', () => {
    const result = truncateMentions(['quote1', 'quote2', 'quote3'], 50, 'sources/s.md');
    // 50-char budget; first entry takes ~30 chars; subsequent entries would push over
    const lines = result.split('\n');
    expect(lines.length).toBeLessThan(3);
  });

  it('strips .md from left path of wiki link', () => {
    const result = truncateMentions(['q'], 500, 'sources/史记_〔汉〕司马迁.md');
    // The LEFT path (before |) is the path without .md; RIGHT is display name (also without .md)
    expect(result).toContain('[[sources/史记_〔汉〕司马迁|史记_〔汉〕司马迁]]');
    expect(result).not.toContain('.md|');
  });
});

describe('lint report log splitting: fullReport vs fullReportForLog', () => {
  it('fullReportForLog contains all entries (no >20 truncation) while fullReport truncates', () => {
    // Issue: lint report > 20 dead links was truncated to "... 857 more" in BOTH
    // the modal AND the persisted log.md. Log should keep the full enumeration.
    // The fix: separate the truncated (Modal) report from the full (log) report.
    const deadLinks = Array.from({ length: 25 }, (_, i) => ({ source: `[[src${i}]]`, target: `[[missing${i}]]` }));

    const { modalReport, logReport } = truncateListForDisplay(
      deadLinks,
      (dl) => `- ${dl.source} → ${dl.target}`,
      20,
      (n) => `- ... ${n} more`
    );

    // Modal: 20 entries + 1 summary line
    expect(modalReport.split('\n')).toHaveLength(21);
    expect(modalReport).toContain('5 more');          // 25 - 20 = 5
    expect(modalReport).toContain('[[src0]]');
    expect(modalReport).toContain('[[src19]]');
    expect(modalReport).not.toContain('[[src20]]');    // truncated

    // Log: complete
    expect(logReport.split('\n')).toHaveLength(25);
    expect(logReport).not.toContain('more');
    expect(logReport).toContain('[[src24]]');            // last entry present
  });

  it('returns identical content when items.length <= visibleCap', () => {
    const items = [1, 2, 3];
    const { modalReport, logReport } = truncateListForDisplay(
      items,
      (n) => `item ${n}`,
      20
    );
    expect(modalReport).toBe('item 1\nitem 2\nitem 3');
    expect(logReport).toBe(modalReport);
  });
});

describe('nestReportUnderParent', () => {
  it('strips the leading H1 and promotes remaining headings by one level', () => {
    // Issue: log.md wrapped a sub-report (H1) inside a H2 heading, which renders
    // oddly in Obsidian. Fix: strip the sub-report's H1 and promote its other
    // headings so it nests cleanly.
    const input = '# Wiki Lint Report\n\n> Summary text\n\n## 断链（程序检测）\n\n- a\n- b\n\n### Detail\n\ntext';
    const out = nestReportUnderParent(input);
    expect(out).not.toMatch(/^# /m);
    expect(out).toContain('## 断链（程序检测）');  // H2 → H3
    expect(out).toContain('### Detail');            // H3 → H4
    expect(out).toContain('> Summary text');        // blockquote preserved
  });

  it('leaves content with no headings unchanged', () => {
    const input = 'just some text\nno headings here';
    expect(nestReportUnderParent(input)).toBe(input);
  });

  it('handles H1-only input by returning empty content (parent already provides title)', () => {
    const input = '# Just a title';
    expect(nestReportUnderParent(input)).toBe('');
  });
});

