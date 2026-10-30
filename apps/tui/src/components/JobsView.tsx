// SPDX-License-Identifier: Apache-2.0
// Job manager panel (#187): lists background jobs from the shared
// JobManager with status + duration; ↑/↓ (or j/k) selects, x cancels a
// running job, p prunes finished jobs. Refreshes on a 1s tick so running
// durations stay live. Esc returns to chat (handled by App).
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { TuiPalette } from '../themes.js';
import { formatJobDuration, type JobManager } from '../jobs.js';

const STATUS_ICON: Record<string, string> = {
  running: '●',
  done: '✓',
  failed: '✕',
  cancelled: '⊘',
};

export function JobsView({ jobs, palette }: { jobs: JobManager; palette: TuiPalette }): React.ReactElement {
  const [, setTick] = useState(0);
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const list = jobs.list();
  const sel = Math.min(selected, Math.max(0, list.length - 1));

  useInput((input, key) => {
    if (key.upArrow || input === 'k') setSelected((s) => Math.max(0, s - 1));
    else if (key.downArrow || input === 'j') setSelected((s) => Math.min(list.length - 1, s + 1));
    else if (input === 'x' && list[sel]) jobs.cancel(list[sel]!.id);
    else if (input === 'p') jobs.prune();
  });

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Text color={palette.accent} bold>
        Background jobs {list.length === 0 ? '' : `(${jobs.running().length} running / ${list.length} total)`}
      </Text>
      {list.length === 0 ? (
        <Text color={palette.dim}>No jobs yet — chat turns register here while they run.</Text>
      ) : (
        list.map((job, i) => (
          <Text key={job.id} color={i === sel ? palette.accent : palette.text}>
            {i === sel ? '› ' : '  '}
            <Text color={job.status === 'running' ? palette.amber : job.status === 'failed' ? palette.red : palette.dim}>
              {STATUS_ICON[job.status] ?? '?'} {job.status}
            </Text>{' '}
            {job.id} · {job.label} · {formatJobDuration(job)}
            {job.error ? <Text color={palette.red}> · {job.error}</Text> : null}
          </Text>
        ))
      )}
      <Text color={palette.dim}>↑/↓ select · x cancel running job · p prune finished · Esc back to chat</Text>
    </Box>
  );
}
