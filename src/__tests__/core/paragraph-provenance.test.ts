import { describe, it, expect, vi, afterEach } from 'vitest';
import { PARAGRAPH_KEEP_OVERLAP, guardBodyRewrite, preserveSourcedParagraphs } from '../../core/paragraph-provenance';
import { preserveExistingSections } from '../../core/section-header-canonicalizer';

const DE = [
  'Beschreibung', 'Hauptmerkmale', 'Verwandte Konzepte', 'Verwandte Entitäten',
  'Erwähnungen in der Quelle', 'Neue Informationen',
];
const M = 'Erwähnungen in der Quelle';

const P_A = 'Berberin senkt den Nüchternblutzucker über eine Aktivierung der AMPK in Leber und Muskel deutlich. ^[Quelle: [[Berberin]]]';
const P_B = 'Chrom verbessert die Insulinsensitivität der Zielgewebe nur bei nachgewiesenem Mangel messbar. ^[Quelle: [[Chrom]]]';
const P_C = 'Pektine verzögern die Magenentleerung und flachen den postprandialen Glukoseanstieg ab. ^[Quelle: [[entities/Pektine|Pektine]]]';
const PLAIN = 'Insulinresistenz bezeichnet eine verminderte Reaktion des Gewebes auf Insulin.';

const page = (...paras: string[]) =>
  `# Insulinresistenz\n\n## Beschreibung\n${paras.join('\n\n')}\n\n## Hauptmerkmale\n- Merkmal eins\n- Merkmal zwei\n\n## Verwandte Konzepte\n- [[concepts/Adipositas|Adipositas]]`;

describe('preserveSourcedParagraphs (a paragraph another source footnoted may not vanish)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns the rewrite itself when the existing body carries no footnotes', () => {
    const rewrite = page(PLAIN);
    expect(preserveSourcedParagraphs(page(PLAIN, 'Zweiter Absatz ohne Marker.'), rewrite, 'Pektine', DE, M)).toBe(rewrite);
  });

  it('returns the rewrite itself when every footnoted paragraph survived with its footnote', () => {
    const rewrite = page(PLAIN, P_A, P_B);
    expect(preserveSourcedParagraphs(page(PLAIN, P_A, P_B), rewrite, 'Pektine', DE, M)).toBe(rewrite);
  });

  it('puts a paragraph another source dropped back where it stood — after the nearest surviving predecessor', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = preserveSourcedParagraphs(page(PLAIN, P_A, P_B), page(PLAIN, P_A, P_C), 'Pektine', DE, M);
    expect(out).toBe(page(PLAIN, P_A, P_B, P_C));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('restored 1 paragraph'));
  });

  it('anchors on an unfootnoted predecessor too, and on the header when none survived', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // PLAIN survived, the two footnoted paragraphs did not: both come back
    // after PLAIN in their old order, before the model's new paragraph.
    expect(preserveSourcedParagraphs(page(PLAIN, P_A, P_B), page(PLAIN, P_C), 'Pektine', DE, M))
      .toBe(page(PLAIN, P_A, P_B, P_C));
    // Nothing before it survived: it opens the section.
    expect(preserveSourcedParagraphs(page(P_B, PLAIN), page(P_C), 'Pektine', DE, M))
      .toBe(page(P_B, P_C));
  });

  it('lets the source that stated a paragraph rewrite or drop it', () => {
    const rewrite = page(PLAIN, P_A);
    expect(preserveSourcedParagraphs(page(PLAIN, P_A, P_B), rewrite, 'Chrom', DE, M)).toBe(rewrite);
    // Folder prefix, case and Unicode form in the footnote do not hide the ownership.
    expect(preserveSourcedParagraphs(page(PLAIN, P_C), page(PLAIN), 'pektine', DE, M)).toBe(page(PLAIN));
    const nfd = 'Grüner Tee senkt den Nüchternblutzucker bei regelmäßigem Konsum messbar. ^[Quelle: [[Grüner Tee]]]';
    expect(preserveSourcedParagraphs(page(PLAIN, nfd), page(PLAIN), 'Grüner Tee', DE, M)).toBe(page(PLAIN));
  });

  it('re-attaches the footnote to a paragraph the rewrite kept but stripped', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reworded = 'Chrom verbessert die Insulinsensitivität der Zielgewebe messbar, allerdings nur bei nachgewiesenem Mangel.';
    const out = preserveSourcedParagraphs(page(PLAIN, P_B), page(PLAIN, reworded), 'Pektine', DE, M);
    expect(out).toBe(page(PLAIN, `${reworded} ^[Quelle: [[Chrom]]]`));
  });

  it('gives a paragraph fused from two sources both footnotes, once each', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fused = 'Berberin senkt den Nüchternblutzucker über eine Aktivierung der AMPK in Leber und Muskel deutlich, und Chrom verbessert die Insulinsensitivität der Zielgewebe nur bei nachgewiesenem Mangel messbar.';
    const out = preserveSourcedParagraphs(page(PLAIN, P_A, P_B), page(PLAIN, fused), 'Pektine', DE, M);
    expect(out).toContain(`${fused} ^[Quelle: [[Berberin]]] ^[Quelle: [[Chrom]]]`);
    expect(out.match(/\[\[Chrom\]\]/g)).toHaveLength(1);
  });

  it('matches only within the paragraph\'s own section', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The rewrite dropped P_B from the description but carries most of its
    // words as a bullet elsewhere: the bullet is not P_B, and must not
    // inherit its footnote.
    const bullet = '- Chrom verbessert die Insulinsensitivität der Zielgewebe bei Mangel';
    const oldBody = `## Beschreibung\n${PLAIN}\n\n${P_B}\n\n## Hauptmerkmale\n- Merkmal eins`;
    const newBody = `## Beschreibung\n${PLAIN}\n\n## Hauptmerkmale\n- Merkmal eins\n${bullet}`;
    const out = preserveSourcedParagraphs(oldBody, newBody, 'Pektine', DE, M);
    expect(out).toBe(`## Beschreibung\n${PLAIN}\n\n${P_B}\n\n## Hauptmerkmale\n- Merkmal eins\n${bullet}`);
  });

  it('guards list items one by one and puts a bullet back into its list', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const item = '- Senkt den Nüchternblutzucker über eine Aktivierung der AMPK in Leber und Muskel. ^[Quelle: [[Berberin]]]';
    const oldBody = `## Beschreibung\n${PLAIN}\n\n## Hauptmerkmale\n- Merkmal eins\n${item}\n- Merkmal zwei`;
    const newBody = `## Beschreibung\n${PLAIN}\n\n## Hauptmerkmale\n- Merkmal eins\n- Merkmal zwei\n- Merkmal drei`;
    expect(preserveSourcedParagraphs(oldBody, newBody, 'Pektine', DE, M))
      .toBe(`## Beschreibung\n${PLAIN}\n\n## Hauptmerkmale\n- Merkmal eins\n${item}\n- Merkmal zwei\n- Merkmal drei`);
  });

  it('ignores footnotes in the lead and in the Mentions section on either side', () => {
    const quote = `- "Chrom verbessert die Insulinsensitivität der Zielgewebe nur bei nachgewiesenem Mangel messbar" ^[Quelle: [[Chrom]]]`;
    const lead = `# Titel\n\nVorspann mit einer Fußnote am Ende des Satzes. ^[Quelle: [[Chrom]]]\n\n## Beschreibung\n${PLAIN}\n\n## ${M}\n${quote}`;
    // The rewrite still carries the Mentions quote: it is not P_B's survivor and gets no footnote.
    const rewrite = `# Titel\n\n## Beschreibung\n${PLAIN}\n\n## ${M}\n${quote}`;
    expect(preserveSourcedParagraphs(lead, rewrite, 'Pektine', DE, M)).toBe(rewrite);
    const withB = `# Titel\n\n## Beschreibung\n${PLAIN}\n\n${P_B}\n\n## ${M}\n${quote}`;
    expect(preserveSourcedParagraphs(withB, rewrite, 'Pektine', DE, M)).toBe(withB);
  });

  it('composes with the section guard: a collapsed section comes back whole, and nothing is duplicated', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const paras = Array.from({ length: 5 }, (_, i) =>
      `Absatz ${i + 1}: ${'Belegter Inhalt aus einer Quelle. '.repeat(6)}^[Quelle: [[Q${i + 1}]]]`);
    const oldBody = page(...paras);
    const collapsed = page(paras[0]);
    const sectionGuarded = preserveExistingSections(oldBody, collapsed, DE, M);
    const out = preserveSourcedParagraphs(oldBody, sectionGuarded, 'Q9', DE, M);
    expect(out).toBe(sectionGuarded);
    for (const p of paras) expect(out.split(p)).toHaveLength(2);
  });

  it('guardBodyRewrite composes section guard, paragraph guard and H1 in that order', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The reply starts at the first `##` (no H1), drops P_B, and keeps everything else.
    const rewrite = page(PLAIN, P_A, P_C).replace('# Insulinresistenz\n\n', '');
    expect(guardBodyRewrite(page(PLAIN, P_A, P_B), rewrite, 'Pektine', DE, M)).toBe(page(PLAIN, P_A, P_B, P_C));
  });

  it('treats the keep threshold as the boundary between reworded and gone', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Ten words, exactly half of them kept — at the floor, counts as survived.
    const old = 'eins zwei drei vier fünf sechs sieben acht neun zehn ^[Quelle: [[Chrom]]]';
    const half = 'eins zwei drei vier fünf elf zwölf dreizehn vierzehn fünfzehn';
    expect(PARAGRAPH_KEEP_OVERLAP).toBe(0.5);
    const kept = preserveSourcedParagraphs(page(old), page(half), 'Pektine', DE, M);
    expect(kept).toContain(`${half} ^[Quelle: [[Chrom]]]`);
    const less = 'eins zwei drei vier elf zwölf dreizehn vierzehn fünfzehn sechzehn';
    const gone = preserveSourcedParagraphs(page(old), page(less), 'Pektine', DE, M);
    expect(gone).toContain(old);
  });
});
