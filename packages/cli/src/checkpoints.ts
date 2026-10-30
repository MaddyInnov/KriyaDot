// SPDX-License-Identifier: Apache-2.0
// CA-4 / CA-30 client-side checkpoint helpers for the CLI: formatting the
// /rewind list and aggregating a session diff from checkpoint snapshots
// (the fallback when the server's /sessions/:id/diff endpoint is absent).
// Pure functions — the REPL wires them to the API client.

export interface CheckpointLike {
  id: string;
  sessionId: string;
  createdAt: number;
  files: Record<string, string | null>;
  historyLength: number;
  label: string;
}

export interface FileDiffRow {
  path: string;
  status: 'created' | 'modified' | 'deleted' | 'changed';
  added: number;
  removed: number;
  touches: number;
}

/** Line-level +/- counts via LCS over lines (multiset fallback when huge). */
export function diffLineCounts(before: string | null, after: string | null): { added: number; removed: number } {
  const a = before === null || before === '' ? [] : before.split('\n');
  const b = after === null || after === '' ? [] : after.split('\n');
  if (a.length * b.length > 4_000_000) {
    const counts = new Map<string, number>();
    for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
    let common = 0;
    for (const line of b) {
      const n = counts.get(line) ?? 0;
      if (n > 0) {
        common += 1;
        counts.set(line, n - 1);
      }
    }
    return { added: b.length - common, removed: a.length - common };
  }
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const common = dp[0]![0]!;
  return { added: b.length - common, removed: a.length - common };
}

/**
 * Aggregate checkpoints into a per-file diff. `readCurrent` supplies the
 * after-state; when it returns undefined for a path (unknown — e.g. the
 * server diff endpoint is unavailable), the LAST snapshot's successor
 * state is approximated from the next checkpoint touching the file, and
 * the row is marked 'changed' rather than created/modified/deleted.
 */
export function aggregateCheckpointDiff(
  checkpoints: CheckpointLike[],
  readCurrent?: (path: string) => string | null | undefined,
): FileDiffRow[] {
  const ordered = [...checkpoints].sort((x, y) => x.createdAt - y.createdAt);
  const firstBefore = new Map<string, string | null>();
  const lastBefore = new Map<string, string | null>();
  const touches = new Map<string, number>();
  for (const cp of ordered) {
    for (const [path, content] of Object.entries(cp.files)) {
      if (!firstBefore.has(path)) firstBefore.set(path, content);
      lastBefore.set(path, content);
      touches.set(path, (touches.get(path) ?? 0) + 1);
    }
  }
  const rows: FileDiffRow[] = [];
  for (const [path, before] of firstBefore) {
    const current = readCurrent ? readCurrent(path) : undefined;
    if (current !== undefined) {
      if (current === before) continue;
      const { added, removed } = diffLineCounts(before, current);
      rows.push({
        path,
        status: before === null ? 'created' : current === null ? 'deleted' : 'modified',
        added,
        removed,
        touches: touches.get(path) ?? 1,
      });
    } else {
      // No live after-state: compare first vs last snapshot (the file kept
      // changing after the last snapshot, so counts are a lower bound).
      const last = lastBefore.get(path) ?? null;
      if (last === before) {
        // Single touch, unknown outcome — still a change worth listing.
        rows.push({ path, status: 'changed', added: 0, removed: 0, touches: touches.get(path) ?? 1 });
        continue;
      }
      const { added, removed } = diffLineCounts(before, last);
      rows.push({ path, status: 'changed', added, removed, touches: touches.get(path) ?? 1 });
    }
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

/** One-line-per-checkpoint list for /rewind (newest first, 1-based). */
export function formatCheckpointList(checkpoints: CheckpointLike[]): string {
  if (checkpoints.length === 0) return 'no checkpoints for this session yet';
  const lines = checkpoints.map((cp, i) => {
    const when = new Date(cp.createdAt).toLocaleTimeString();
    const files = Object.keys(cp.files);
    const shown = files.slice(0, 3).join(', ');
    const more = files.length > 3 ? ` +${files.length - 3} more` : '';
    return `  ${i + 1}. ${when} · ${cp.label} · ${files.length} file(s)${shown ? `: ${shown}${more}` : ''} · id ${cp.id.slice(0, 8)}`;
  });
  return ['checkpoints (newest first) — /rewind <n> [code|conversation|both|summarize]', ...lines].join('\n');
}

/** Per-file review table for /diff. */
export function formatSessionDiff(rows: FileDiffRow[]): string {
  if (rows.length === 0) return 'no file changes recorded for this session';
  const lines = rows.map((r) => `  ${r.path}  +${r.added} -${r.removed}  (${r.status}, ${r.touches} touch${r.touches === 1 ? '' : 'es'})`);
  const added = rows.reduce((n, r) => n + r.added, 0);
  const removed = rows.reduce((n, r) => n + r.removed, 0);
  return [`session changes — ${rows.length} file(s), +${added} -${removed}`, ...lines].join('\n');
}
