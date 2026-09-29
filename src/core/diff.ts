// v1.22.0 #97: pure line-level diff for the Schema diff Modal.
//
// Algorithm: classic LCS (Longest Common Subsequence) dynamic programming.
// Time and space are O(n*m) where n, m are the line counts. The schema body
// is typically < 200 lines (even after the v1.22.0 dynamic tag list
// expansion), so this is fine for the only call site.
//
// Output format: an array of per-line operations, in document order. A
// "modified" line is represented as a `del` followed by an `add` — the UI
// renders them side-by-side in the dual-pane layout (left = red, right =
// green). The two ops are emitted in their natural order: a deletion
// comes before an addition when the new line "replaces" the old one, but
// when a line is purely inserted between two unchanged lines, only an
// `add` appears.

export type DiffOp =
  | { op: 'eq';  line: string }
  | { op: 'add'; line: string }
  | { op: 'del'; line: string };

/**
 * Compute the per-line diff between two texts.
 *
 * Both inputs are split on `\n`. Empty lines are preserved (they're not
 * trimmed away — schema bodies intentionally include blank lines between
 * sections).
 */
export function lineDiff(oldText: string, newText: string): DiffOp[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const n = a.length;
  const m = b.length;

  // dp[i][j] = LCS length of a[0..i) and b[0..j)
  // Use a flat Int32Array for cache locality.
  const dp = new Int32Array((n + 1) * (m + 1));
  const stride = m + 1;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i * stride + j] = dp[(i - 1) * stride + (j - 1)] + 1;
      } else {
        dp[i * stride + j] = Math.max(
          dp[(i - 1) * stride + j],
          dp[i * stride + (j - 1)]
        );
      }
    }
  }

  // Backtrack from (n, m) to build the result in reverse.
  //
  // When a[i-1] != b[j-1] and the LCS through (i-1, j) and (i, j-1) are
  // equal (i.e. the algorithm is indifferent), we PREFER the deletion
  // (vertical move) so the resulting op sequence is [del, add] — the
  // UI renders del on the left, add on the right, side-by-side. Reversing
  // then yields [del, add] in document order, which is what the test
  // expects for a one-line change like "foo" → "bar".
  //
  // The `>` (strict) preference for the deletion branch is what produces
  // [del, add] instead of [add, del].
  const out: DiffOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      out.push({ op: 'eq', line: a[i - 1] ?? '' });
      i--; j--;
    } else if (dp[(i - 1) * stride + j] > dp[i * stride + (j - 1)]) {
      out.push({ op: 'del', line: a[i - 1] ?? '' });
      i--;
    } else {
      out.push({ op: 'add', line: b[j - 1] ?? '' });
      j--;
    }
  }
  while (i > 0) { out.push({ op: 'del', line: a[i - 1] ?? '' }); i--; }
  while (j > 0) { out.push({ op: 'add', line: b[j - 1] ?? '' }); j--; }

  out.reverse();
  return out;
}
function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.split('\n');
}
