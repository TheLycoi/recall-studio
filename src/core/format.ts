/**
 * Format a byte count as a short human-readable string (e.g. "1.2MB", "456KB",
 * "789B"). Pure function — used by log-writer (ingest log metrics) and the
 * history-modal (ingest metric cards).
 *
 * Centralized here in v1.25.1 Phase C-PR1 cleanup after code-review flagged
 * a byte-identical duplicate in src/ui/history-modal/render-state.ts.
 */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

/**
 * Today's calendar date in the user's local time zone, as `YYYY-MM-DD`.
 *
 * `new Date().toISOString().slice(0, 10)` yields the UTC date, which in any
 * zone east of UTC is still *yesterday* for the first hours after local
 * midnight (until 08:00 in UTC+8, 02:00 in CEST). Every date stamp the plugin
 * writes into the vault — `created:` / `updated:` frontmatter, the ingest
 * log's `## [date time]` header, contradiction records — is read by a human
 * in local time, so it must be built from local components.
 */
export function localDateStamp(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
