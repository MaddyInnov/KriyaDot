// SPDX-License-Identifier: Apache-2.0
// Read-only: workflows + recent runs.
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { KriyaDotApi, WorkflowRunSummary, WorkflowSummary } from '../api.js';
import type { TuiPalette } from '../themes.js';

interface Props {
  api: KriyaDotApi;
  palette: TuiPalette;
}

function statusColor(status: string, palette: TuiPalette): string {
  const s = status.toLowerCase();
  if (s.includes('success') || s.includes('complete') || s === 'done') return palette.green;
  if (s.includes('fail') || s.includes('error')) return palette.red;
  if (s.includes('run')) return palette.amber;
  return palette.dim;
}

export function WorkflowsView({ api, palette }: Props): React.ReactElement {
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [runs, setRuns] = useState<WorkflowRunSummary[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void Promise.all([api.listWorkflows(), api.listWorkflowRuns()])
      .then(([w, r]) => {
        if (!alive) return;
        setWorkflows(w);
        setRuns(r.slice(0, 15));
      })
      .catch((err: Error) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, [api]);

  if (error) return <Box paddingX={1}><Text color={palette.red}>⚠ {error}</Text></Box>;
  if (!workflows || !runs) return <Box paddingX={1}><Text color={palette.dim}>Loading workflows…</Text></Box>;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={palette.accent} bold>Workflows ({workflows.length})</Text>
      {workflows.length === 0 && <Text color={palette.dim}>  none defined</Text>}
      {workflows.map((w) => (
        <Text key={w.id}><Text color={palette.text}>  • {w.name}</Text><Text color={palette.dim}>  {w.id}</Text></Text>
      ))}
      <Box marginTop={1}>
        <Text color={palette.accent} bold>Recent runs</Text>
      </Box>
      {runs.length === 0 && <Text color={palette.dim}>  no runs yet</Text>}
      {runs.map((r) => (
        <Text key={r.id}>
          <Text color={statusColor(r.status, palette)}>  ● </Text>
          <Text color={palette.text}>{r.workflowId}</Text>
          <Text color={palette.dim}>  {r.status}{typeof r.healthScore === 'number' ? ` · health ${r.healthScore}` : ''}  {new Date(r.createdAt).toLocaleString()}</Text>
        </Text>
      ))}
      <Box marginTop={1}><Text color={palette.dim}>Esc to go back</Text></Box>
    </Box>
  );
}
