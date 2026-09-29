/**
 * dedupPages — drop exact-string duplicates from a page-path list while
 * preserving first-occurrence order.
 *
 * Used to dedup `analysis.created_pages` before assembling the IngestReport
 * so a duplicate surface-form (e.g. two "intelligent-xtraction-and-processing"
 * entries from one batch) does not inflate the report count or the "Created"
 * listing.
 *
 * Extracted from WikiEngine (2026-07-19) as part of v1.25.1 Phase C-PR1.
 *
 * Why this lives in its own file: both WikiEngine (the legacy call site) and
 * LogWriter (extracted in the same PR) call it. The helper has zero state,
 * so a separate file is the natural split boundary.
 */

export function dedupPages(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * Record a page as updated by this run, once. `updated_pages` is filled from
 * three places — the entity branch, the concept branch and the related-page
 * branch — and one page legitimately passes two of them in the same run: it is
 * extracted as an entity or concept *and* listed as a related page. Holding the
 * list distinct where it is filled keeps every reader correct, including the
 * cancelled and failed paths that hand `updated_pages` straight to `onDone`.
 */
export function recordUpdatedPage(analysis: { updated_pages: string[] }, path: string): void {
  if (!analysis.updated_pages.includes(path)) analysis.updated_pages.push(path);
}
