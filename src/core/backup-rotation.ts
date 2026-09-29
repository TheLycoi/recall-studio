// v1.22.0 #97: backup rotation for the schema config file.
//
// Before applySchemaSuggestion writes the new body, the current
// wiki/schema/config.md is renamed to wiki/schema/config.md.bak.<iso>.
// We keep at most MAX_BACKUPS recent files; older ones are deleted.
//
// Pure functions only — the caller (apply-suggestion.ts) does the
// actual file operations and feeds the resulting file list back to
// rotateBackups for pruning.

/** How many .bak.<iso> files to retain. Tuned for "3 recent configs"
 *  — enough to recover from one or two bad regenerations, not so many
 *  that the schema directory bloats over months of weekly regenerations.
 *  Test in src/__tests__/core/backup-rotation.test.ts encodes this
 *  number (6 inputs → 3 deletions → 3 kept). */
export const MAX_BACKUPS = 3;

/**
 * Build a safe backup filename from a source path and an ISO timestamp.
 *
 * Colons in the timestamp are replaced with hyphens because:
 *   - Windows filesystems reject `:` in filenames
 *   - Even on macOS/Linux, users may sync the vault via OneDrive /
 *     iCloud / Dropbox — all of which normalize colons
 *
 * The result is `path/to/config.md.bak.YYYY-MM-DDTHH-MM-SS.sssZ`.
 */
export function backupFilename(sourcePath: string, iso: string): string {
  const safeIso = iso.replace(/:/g, '-');
  return `${sourcePath}.bak.${safeIso}`;
}

/**
 * Return the list of paths the caller should delete to enforce the
 * MAX_BACKUPS limit. The caller passes the full list of existing
 * `.bak.<iso>` paths in chronological order (oldest first, by name —
 * ISO timestamps sort lexically correct).
 *
 * If `allPaths.length <= MAX_BACKUPS`, returns `[]`.
 */
export function rotateBackups(allPaths: string[]): string[] {
  if (allPaths.length <= MAX_BACKUPS) return [];
  return allPaths.slice(0, allPaths.length - MAX_BACKUPS);
}
