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

// ---------------------------------------------------------------------------
// Semantic misuse hints (#58 closure)
//
// Name-typo hints above only fire for tools that DO NOT exist. These
// rules fire on SUCCESSFUL-but-wrong calls: the call ran, but its
// argument shape makes clear a dedicated tool would have done the job
// better (and more safely — dedicated tools are workspace-confined and
// governance-visible, shell pipelines are not). Rules are deliberately
// conservative: each fires only on an unambiguous pattern, and
// ordinary shell use (builds, tests, git, pipelines, scripts) matches
// nothing. Pure + deterministic; the runtime (parent integration) and
// the built-in run_command append the hint to the tool result.
// ---------------------------------------------------------------------------

export interface SemanticHintInput {
  /** Tool that was called, e.g. 'run_command'. */
  toolName: string;
  /** Arguments the model passed. */
  args: Record<string, unknown>;
  /** Error text when the call failed (error-class rules). */
  error?: string;
  /** Result value when the call succeeded (result-shape rules). */
  result?: unknown;
}

interface SemanticRule {
  id: string;
  test: (input: SemanticHintInput) => boolean;
  hint: string;
}

function shellCommand(input: SemanticHintInput): string {
  if (input.toolName !== 'run_command') return '';
  const cmd = input.args.command ?? input.args.cmd;
  return typeof cmd === 'string' ? cmd.trim() : '';
}

/** True for a single simple command: no pipes, sequencing, or substitution. */
function isSimpleCommand(cmd: string): boolean {
  return !/[|;&`$()]/.test(cmd) && !cmd.includes('&&') && !cmd.includes('\n');
}

const SEMANTIC_RULES: readonly SemanticRule[] = [
  {
    id: 'shell-cat-read',
    test: (i) => {
      const cmd = shellCommand(i);
      // `cat file`, `head -n 5 file`, `tail file` as a lone command.
      // `tail -f` (log following) is excluded: read_file cannot stream.
      if (/^tail\s/.test(cmd) && /(?:^|\s)(?:-f|--follow)(?:\s|$)/.test(cmd)) return false;
      return isSimpleCommand(cmd) && /^(?:sudo\s+)?(?:cat|head|tail|less|more)\s+\S/.test(cmd);
    },
    hint: 'Hint: reading a file with a shell command bypasses the workspace-confined reader — use the read_file tool instead (it also supports hashed line identifiers for exact edits).',
  },
  {
    id: 'shell-grep-search',
    test: (i) => {
      const cmd = shellCommand(i);
      return isSimpleCommand(cmd) && /^(?:sudo\s+)?(?:grep|rg|ack|ag)\s+\S/.test(cmd);
    },
    hint: 'Hint: searching file contents with a shell command bypasses the dedicated search tools — use the grep tool (or search_code_semantic for meaning-based search) instead.',
  },
  {
    id: 'shell-find-glob',
    test: (i) => {
      const cmd = shellCommand(i);
      // Only a glob-pattern -name search (the glob tool's job). Plain
      // `-name node_modules` prune idioms do not fire.
      return (
        isSimpleCommand(cmd) &&
        /^find\s+\S+/.test(cmd) &&
        /\s-name\s+["']?[^"'\s]*[*?][^"'\s]*["']?/.test(cmd)
      );
    },
    hint: 'Hint: finding files with `find -name` bypasses the dedicated file finder — use the glob tool instead.',
  },
  {
    id: 'shell-sed-edit',
    test: (i) => {
      const cmd = shellCommand(i);
      // In-place sed is an edit, wherever it appears in the command.
      return /(?:^|[;&|]\s*)(?:sudo\s+)?sed\s+(?:-\S*i\S*\s|--in-place)/.test(cmd);
    },
    hint: 'Hint: editing a file in place with sed is fragile and unreviewable — use the edit tool instead (exact-text or hashed range mode), so the change is verified before it lands.',
  },
  {
    id: 'shell-heredoc-write',
    test: (i) => {
      const cmd = shellCommand(i);
      if (!cmd) return false;
      // Heredoc redirected to a file (either `<<EOF > f` or the usual
      // `> f <<EOF` order), `echo … > file`, or tee to a file.
      const heredocWrite =
        /<<\s*['"]?[A-Za-z_]\w*['"]?/.test(cmd) && /(?:^|\s)>\s*\S+/.test(cmd);
      const echoWrite = isSimpleCommand(cmd) && /^(?:echo|printf)\s+[\s\S]*\s>\s*\S+$/.test(cmd);
      const teeWrite = /(?:^|[|]\s*)tee\s+(?:-\S+\s+)*\S+/.test(cmd);
      return heredocWrite || echoWrite || teeWrite;
    },
    hint: 'Hint: writing a file through the shell (heredoc/redirect/tee) bypasses the workspace-confined writer — use the write_file tool instead.',
  },
  {
    id: 'shell-curl-fetch',
    test: (i) => {
      const cmd = shellCommand(i);
      return isSimpleCommand(cmd) && /^(?:sudo\s+)?(?:curl|wget)\s+(?:-\S+\s+)*https?:\/\/\S/.test(cmd);
    },
    hint: 'Hint: fetching a URL with curl/wget bypasses the SSRF-checked fetcher — use the web_fetch tool instead.',
  },
  {
    id: 'fetch-on-search-engine',
    test: (i) => {
      if (i.toolName !== 'web_fetch') return false;
      const url = typeof i.args.url === 'string' ? i.args.url : '';
      const query = typeof i.args.query === 'string' ? i.args.query : '';
      if (query && !url) return true; // called with a search query, not a URL
      try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./, '');
        const isSearchHost =
          (host === 'google.com' || host.endsWith('.google.com') || host === 'bing.com' || host === 'duckduckgo.com') &&
          (u.pathname.includes('search') || u.searchParams.has('q'));
        return isSearchHost;
      } catch {
        return false;
      }
    },
    hint: 'Hint: that looks like a search, not a page fetch — use the web_search tool to search, then web_fetch a specific result URL.',
  },
  {
    id: 'search-with-url',
    test: (i) => {
      if (i.toolName !== 'web_search') return false;
      const q = typeof i.args.query === 'string' ? i.args.query.trim() : '';
      return /^https?:\/\/\S+$/.test(q);
    },
    hint: 'Hint: that query is a direct URL — use the web_fetch tool to read the page instead of web_search.',
  },
  {
    id: 'edit-stale-content',
    test: (i) => {
      if (i.toolName !== 'edit') return false;
      const err = i.error ?? '';
      return /oldText not found/i.test(err);
    },
    hint: 'Hint: the edit failed because the file content differs from what you expected — re-read it with read_file (hashed lines) and use edit range mode with the boundary hashes so a stale edit fails safely instead of guessing.',
  },
];

/** All semantic rule ids (exported for tests/coverage checks). */
export const SEMANTIC_HINT_RULE_IDS: readonly string[] = SEMANTIC_RULES.map((r) => r.id);

/**
 * The semantic misuse hint for one tool call, or '' when no
 * conservative rule matches. At most one hint is returned (the first
 * matching rule) so guidance stays focused.
 */
export function semanticMisuseHint(input: SemanticHintInput): string {
  for (const rule of SEMANTIC_RULES) {
    try {
      if (rule.test(input)) return rule.hint;
    } catch {
      // A malformed input shape must never break result handling.
    }
  }
  return '';
}

/**
 * Append the semantic hint (when one fires) to a tool result:
 * strings get a suffix line; plain objects get a `hint` field; every
 * other shape is returned unchanged. Parent/runtime integration: wrap
 * executed tool results with this before serializing them to the
 * model — the built-in run_command already does so for its own calls.
 */
export function withSemanticHint<T>(input: SemanticHintInput, result: T): T {
  const hint = semanticMisuseHint({ ...input, result });
  if (!hint) return result;
  if (typeof result === 'string') return (result + (result.endsWith('\n') ? '' : '\n') + hint) as T;
  if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>), hint } as T;
  }
  return result;
}
