/**
 * Strip a leading "# " (H1) from a markdown title and promote all subsequent
 * "#" headings down by one level (H1 → H2, H2 → H3, etc.).
 */
export function nestReportUnderParent(report: string): string {
  const lines = report.split('\n');
  let h1Stripped = false;
  const out: string[] = [];
  for (const line of lines) {
    const m = /^(#+)\s/.exec(line);
    if (m) {
      if (!h1Stripped && m[1].length === 1) {
        h1Stripped = true;
        continue;
      }
      out.push('#' + line);
      h1Stripped = true;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

export function truncateListForDisplay<T>(
  items: T[],
  formatItem: (item: T, index: number) => string,
  visibleCap = 20,
  moreTemplate = (n: number) => `- ... ${n} more`
): { modalReport: string; logReport: string } {
  const all = items.map(formatItem).join('\n');
  if (items.length <= visibleCap) {
    return { modalReport: all, logReport: all };
  }
  const visible = items.slice(0, visibleCap).map(formatItem).join('\n');
  return {
    modalReport: visible + '\n' + moreTemplate(items.length - visibleCap),
    logReport: all,
  };
}

// Truncate mentions to a reasonable token budget for merge/create prompts.
export function truncateMentions(
  mentions: string[] | undefined,
  maxChars = 500,
  sourcePath?: string
): string {
  if (!mentions || mentions.length === 0) return '';
  let result = '';
  if (sourcePath) {
    const leftPath = sourcePath.replace(/\.md$/, '');
    const displayName = leftPath.split('/').pop() || leftPath;
    for (const m of mentions) {
      const line = `- ${m} — [[${leftPath}|${displayName}]]`;
      if (result.length + line.length + 1 > maxChars) {
        if (result.length > 0) break;
        const head = Math.max(0, maxChars - ` — [[${leftPath}|${displayName}]]`.length - 3);
        return `- ${m.substring(0, head)}... — [[${leftPath}|${displayName}]]`;
      }
      result += (result ? '\n' : '') + line;
    }
    return result;
  }
  for (const m of mentions) {
    const line = `- ${m}`;
    if (result.length + line.length + 1 > maxChars) {
      if (result.length > 0) break;
      return `- ${m.substring(0, Math.max(0, maxChars - 3))}...`;
    }
    result += (result ? '\n' : '') + line;
  }
  return result;
}
