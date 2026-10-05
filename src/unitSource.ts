/**
 * Where an inbox row built from a missed quiz question points: the exact PDF
 * selection when the passage has one, the wiki page and its section otherwise.
 *
 * Pure: no `obsidian` import (test/unitSource.test.mjs bundles it standalone).
 */
import { renderPdfSubpath } from "./pdflink";
import type { EvidenceUnit } from "./pageIndex";

/** Finds `<pdfBasename>.pdf` as linked from `notePath`, or null when the vault has no such file. */
export type ResolvePdf = (pdfBasename: string, notePath: string) => { path: string } | null;

/** Where an inbox row built from one evidence unit points. */
export interface UnitSource {
  sourcePath: string;
  page: number | null;
  heading: string | null;
  subpath: string | undefined;
}

/**
 * The one PDF-or-page resolution for a unit: a unit backed by a PDF highlight
 * whose file resolves points at the exact PDF++ selection. Anything else points
 * at the page, headed by its title and the section the passage sits under.
 */
export function resolveUnitSource(unit: EvidenceUnit, resolvePdf: ResolvePdf): UnitSource {
  if (unit.pdfBasename && unit.target) {
    const pdf = resolvePdf(unit.pdfBasename, unit.notePath);
    if (pdf) {
      return {
        sourcePath: pdf.path,
        page: unit.page,
        heading: `page ${unit.page}`,
        subpath: renderPdfSubpath(unit.target),
      };
    }
  }
  return {
    sourcePath: unit.notePath,
    page: null,
    heading: unit.section ? `${unit.noteTitle} › ${unit.section}` : unit.noteTitle,
    subpath: undefined,
  };
}
