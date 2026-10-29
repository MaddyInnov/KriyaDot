// SPDX-License-Identifier: Apache-2.0

/**
 * Tool-misuse hints (Octomind parity — MCP completion pass).
 *
 * When a model calls a tool that does not exist (a hallucinated or
 * mistyped name), a bare "unknown tool" error wastes a full correction
 * round-trip. Appending the closest real names ("did you mean …?")
 * lets the model self-correct in one step. Pure functions, no I/O.
 */

/** Classic Levenshtein edit distance (two-row DP). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_v, i) => i);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/**
 * Up to `max` candidate names similar to `name`, best first. A
 * candidate qualifies when its edit distance is at most a third of the
 * longer string (min 2) OR one is a prefix/substring of the other —
 * tuned so `read_file` suggests `readFile`-style neighbours without
 * spraying unrelated names.
 */
export function suggestSimilarNames(name: string, candidates: Iterable<string>, max = 3): string[] {
  const scored: Array<{ candidate: string; score: number }> = [];
  const needle = name.toLowerCase();
  for (const candidate of candidates) {
    if (candidate === name) continue;
    const hay = candidate.toLowerCase();
    const substringBonus = hay.includes(needle) || needle.includes(hay) ? 0.5 : 0;
    const distance = editDistance(needle, hay);
    const threshold = Math.max(2, Math.floor(Math.max(needle.length, hay.length) / 3));
    if (distance > threshold && substringBonus === 0) continue;
    scored.push({ candidate, score: distance - substringBonus * 10 });
  }
  scored.sort((x, y) => x.score - y.score || x.candidate.localeCompare(y.candidate));
  return scored.slice(0, max).map((s) => s.candidate);
}

/** " Did you mean: a, b?" suffix, or '' when nothing is close. */
export function didYouMeanSuffix(name: string, candidates: Iterable<string>): string {
  const suggestions = suggestSimilarNames(name, candidates);
  return suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : '';
}
