// domain axis stage 3 (#568): coverage threshold + domain subset, end to
// end through the engine. The extraction reports per candidate how the source
// treats it and which of the note's tags it carries; the engine drops `named`
// (threshold in code), validates the subset against the note, and the page
// writers carry it: set on a new page, unioned on an existing one.

import { describe, it, expect } from 'vitest';
import { TFile } from 'obsidian';
import { createWikiEngineHarness } from '../__support__/wiki-engine-harness';
import { parseFrontmatter } from '../../core/frontmatter';

const NOTE_PATH = 'Notizen/Zink.md';
const NOTE = `---
tags:
  - Sorte/Mineralstoff
  - Thema/Ernährung
  - Fach/Endokrinologie
---

# Zink

Zink ist ein essentielles Spurenelement. Es wirkt als Kofaktor vieler Enzyme und
beeinflusst das Immunsystem. Der Zinkmangel ist weltweit verbreitet, und Kupfer
konkurriert mit Zink um die Aufnahme.
`;

function noteFile(): TFile {
  return Object.assign(new TFile(), { path: NOTE_PATH, basename: 'Zink', extension: 'md' });
}

const EXTRACTION = JSON.stringify({
  source_title: 'Zink',
  summary: 'Trace element.',
  entities: [
    { name: 'Zink', type: 'other', summary: 'element', mentions_in_source: ['Zink ist ein essentielles Spurenelement.'],
      coverage: 'defined', domains: ['Sorte/Mineralstoff', 'thema/ernährung', 'Thema/Erfunden'], related_entities: ['Kupfer'] },
    { name: 'Kupfer', type: 'other', summary: 'element', mentions_in_source: ['Kupfer konkurriert mit Zink um die Aufnahme.'],
      coverage: 'named', domains: ['Sorte/Mineralstoff'] },
  ],
  concepts: [
    { name: 'Zinkmangel', type: 'phenomenon', summary: 'deficiency', mentions_in_source: ['Der Zinkmangel ist weltweit verbreitet'],
      coverage: 'discussed', domains: [], related_concepts: [] },
    { name: 'Immunsystem', type: 'term', summary: 'system', mentions_in_source: ['beeinflusst das Immunsystem'],
      related_concepts: [] },
  ],
});

function pageOf(h: ReturnType<typeof createWikiEngineHarness>, suffix: string): string | undefined {
  const path = h.writtenPaths.find(p => p.toLowerCase().endsWith(suffix));
  return path ? h.files.get(path) : undefined;
}

describe('WikiEngine.ingestSource — coverage threshold and domain subset (domain axis stage 3, #568)', () => {
  it('drops `named`, keeps the rest, and writes the validated subset on new pages', async () => {
    const h = createWikiEngineHarness({
      files: { [NOTE_PATH]: NOTE },
      llmResponses: [EXTRACTION],
      settings: { wikiLanguage: 'de', watchedFolders: ['Notizen'] },
    });
    await h.engine.ingestSource(noteFile());

    const written = h.writtenPaths.map(p => p.toLowerCase());
    expect(written.some(p => p.endsWith('/zink.md') && p.includes('/entities/'))).toBe(true);
    expect(written.some(p => p.endsWith('/kupfer.md'))).toBe(false);
    expect(written.some(p => p.endsWith('/zinkmangel.md'))).toBe(true);
    expect(written.some(p => p.endsWith('/immunsystem.md'))).toBe(true);

    const gateMsg = h.progressMessages.find(m => m.startsWith('Candidate gate:'));
    expect(gateMsg).toContain('Kupfer (entity, named)');

    // Stufe 4: the validated subset joins the identity value in `tags:` —
    // the note's spelling is written, the invented value is not, and no
    // `domains:` field is born anywhere.
    const zink = parseFrontmatter(pageOf(h, '/entities/zink.md') ?? '') ?? {};
    expect(zink.tags).toEqual(expect.arrayContaining(['Sorte/Mineralstoff', 'Thema/Ernährung']));
    expect(zink.domains).toBeUndefined();
    // Zinkmangel chose [] — no belonging values. Immunsystem omitted the field.
    expect(pageOf(h, '/zinkmangel.md') ?? '').not.toMatch(/^domains:/m);
    expect(pageOf(h, '/immunsystem.md') ?? '').not.toMatch(/^domains:/m);
    // The dropped name left the survivors' related lists, so no link is manufactured.
    const summaryReport = h.reports.at(-1);
    expect(summaryReport?.entitiesCreated).toBe(1);
    expect(summaryReport?.conceptsCreated).toBe(2);
  });

  it('unions the subset into an existing page instead of replacing it', async () => {
    const existing = `---
type: entity
created: 2026-01-01
updated: 2026-01-01
sources:
  - "[[sources/Kupfer]]"
tags:
  - other
domains:
  - "Thema/Bestehend"
---

# Zink

Alte Beschreibung.
`;
    const h = createWikiEngineHarness({
      files: { [NOTE_PATH]: NOTE, 'wiki/entities/Zink.md': existing },
      llmResponses: [EXTRACTION],
      settings: { wikiLanguage: 'de', slugCase: 'preserve', watchedFolders: ['Notizen'] },
    });
    await h.engine.ingestSource(noteFile());
    const zink = parseFrontmatter(h.files.get('wiki/entities/Zink.md') ?? '') ?? {};
    // Stufe 4: the subset unions into `tags:`; the legacy `domains:` stays as it was.
    expect(zink.tags).toEqual(['other', 'Sorte/Mineralstoff', 'Thema/Ernährung']);
    expect(zink.domains).toEqual(['Thema/Bestehend']);
  });

  it('leaves pages untouched when the note has no tags — even if the model invents domains', async () => {
    const h = createWikiEngineHarness({
      files: { [NOTE_PATH]: NOTE.replace(/^---[\s\S]*?---\n\n/, '') },
      llmResponses: [EXTRACTION],
      settings: { wikiLanguage: 'de', watchedFolders: ['Notizen'] },
    });
    await h.engine.ingestSource(noteFile());
    expect(pageOf(h, '/entities/zink.md') ?? '').not.toMatch(/^domains:/m);
  });

  it('applies the coverage threshold even where the deterministic gate is off (no language profile)', async () => {
    const h = createWikiEngineHarness({
      files: { [NOTE_PATH]: NOTE },
      llmResponses: [EXTRACTION],
      settings: { wikiLanguage: 'zh', watchedFolders: ['Notizen'] },
    });
    await h.engine.ingestSource(noteFile());
    expect(h.writtenPaths.map(p => p.toLowerCase()).some(p => p.endsWith('/kupfer.md'))).toBe(false);
    expect(h.progressMessages.find(m => m.startsWith('Candidate gate:'))).toContain('Kupfer (entity, named)');
  });
});
