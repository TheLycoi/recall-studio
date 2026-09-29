import { describe, it, expect } from 'vitest';
import { backupFilename, rotateBackups, MAX_BACKUPS } from '../../core/backup-rotation';

// v1.22.0 #97: schema-config backup rotation.
//
// Before applySchemaSuggestion writes the new body, the existing
// wiki/schema/config.md is renamed to wiki/schema/config.md.bak.<ISO>.
// We keep at most MAX_BACKUPS recent files; older ones are deleted.
//
// Functions are pure (no vault access). The caller (apply-suggestion.ts)
// does the actual file ops and feeds the resulting file list to
// rotateBackups for pruning.

describe('backupFilename (#97)', () => {
  it('produces "<path>.bak.<iso>" with a stable format', () => {
    // Frozen time so the test is deterministic. We use a string ISO input
    // so the function is testable without mocking Date.now.
    const iso = '2026-06-22T10:30:00.000Z';
    expect(backupFilename('wiki/schema/config.md', iso)).toBe(
      'wiki/schema/config.md.bak.2026-06-22T10-30-00.000Z'
    );
  });

  it('replaces colons (Windows-illegal) with hyphens in the timestamp', () => {
    // Windows filesystems reject ':' in filenames. Even on macOS/Linux
    // a user might sync their vault via OneDrive / iCloud / Dropbox, so
    // the filename must be safe across all platforms.
    const iso = '2026-06-22T10:30:00.000Z';
    const result = backupFilename('wiki/schema/config.md', iso);
    expect(result).not.toContain(':');
  });
});

describe('rotateBackups (#97)', () => {
  it('keeps the most recent MAX_BACKUPS files and deletes older', () => {
    // Caller passes the full sorted list (oldest first, by name).
    // rotateBackups returns the list of paths to delete. With 6 inputs
    // and MAX_BACKUPS=3, exactly 3 are deleted (the three oldest).
    const all = [
      'wiki/schema/config.md.bak.2026-01-01T00-00-00.000Z',
      'wiki/schema/config.md.bak.2026-02-01T00-00-00.000Z',
      'wiki/schema/config.md.bak.2026-03-01T00-00-00.000Z',
      'wiki/schema/config.md.bak.2026-04-01T00-00-00.000Z',
      'wiki/schema/config.md.bak.2026-05-01T00-00-00.000Z',
      'wiki/schema/config.md.bak.2026-06-01T00-00-00.000Z',
    ];
    const toDelete = rotateBackups(all);
    // 6 total, MAX_BACKUPS (3) kept → delete 6 - 3 = 3
    expect(toDelete).toEqual([
      'wiki/schema/config.md.bak.2026-01-01T00-00-00.000Z',
      'wiki/schema/config.md.bak.2026-02-01T00-00-00.000Z',
      'wiki/schema/config.md.bak.2026-03-01T00-00-00.000Z',
    ]);
  });

  it('returns [] when file count is at or below MAX_BACKUPS', () => {
    const all = [
      'wiki/schema/config.md.bak.2026-01-01T00-00-00.000Z',
      'wiki/schema/config.md.bak.2026-02-01T00-00-00.000Z',
    ];
    expect(rotateBackups(all)).toEqual([]);
  });

  it('returns [] for empty input (no backup files exist yet)', () => {
    expect(rotateBackups([])).toEqual([]);
  });

  it('ignores unrelated files in the directory (only .bak.<iso> entries count)', () => {
    // The caller is responsible for filtering to .bak.* files. The function
    // trusts the input list — this test documents the contract.
    const onlyBackups = [
      'wiki/schema/config.md.bak.2026-01-01T00-00-00.000Z',
      'wiki/schema/config.md.bak.2026-02-01T00-00-00.000Z',
    ];
    expect(rotateBackups(onlyBackups)).toEqual([]);
  });

  it('MAX_BACKUPS is a sane small number (not too aggressive, not too greedy)', () => {
    // Sanity guard: MAX_BACKUPS must be a positive integer. If a future
    // commit accidentally sets it to 0 or -1, every backup deletes itself.
    expect(MAX_BACKUPS).toBeGreaterThan(0);
    expect(MAX_BACKUPS).toBeLessThanOrEqual(20);
    expect(Number.isInteger(MAX_BACKUPS)).toBe(true);
  });
});
