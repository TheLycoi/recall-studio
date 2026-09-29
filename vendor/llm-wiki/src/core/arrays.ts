import { parseFrontmatter } from './frontmatter';

export function extractSourceTags(content: string): string[] {
  const fm = parseFrontmatter(content);
  if (!fm) return [];
  const raw = fm.tags;
  if (Array.isArray(raw)) {
    return raw.map(t => String(t).trim()).filter(t => t.length > 0);
  }
  return [];
}

// Coerce a potentially non-array value to an array.
export function coerceToArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }
  return [];
}
