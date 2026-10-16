// SPDX-License-Identifier: Apache-2.0
// Read-only: recent activity from the audit log.
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { AuditEntry, KriyaDotApi } from '../api.js';
import type { TuiPalette } from '../themes.js';

interface Props {
  api: KriyaDotApi;
  palette: TuiPalette;
}

export function ActivityView({ api, palette }: Props): React.ReactElement {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void api
      .listAudit(30)
      .then((e) => alive && setEntries(e))
      .catch((err: Error) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, [api]);

  if (error) return <Box paddingX={1}><Text color={palette.red}>⚠ {error}</Text></Box>;
  if (!entries) return <Box paddingX={1}><Text color={palette.dim}>Loading activity…</Text></Box>;
  if (entries.length === 0) return <Box paddingX={1}><Text color={palette.dim}>No activity yet. Esc to go back.</Text></Box>;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={palette.accent} bold>Recent activity</Text>
      {entries.map((e) => (
        <Text key={e.id}>
          <Text color={palette.dim}>{new Date(e.createdAt).toLocaleString()}  </Text>
          <Text color={palette.text}>{e.action}</Text>
          <Text color={palette.dim}>  · {e.actor}{e.toolName ? ` · ${e.toolName}` : ''}</Text>
        </Text>
      ))}
      <Box marginTop={1}><Text color={palette.dim}>Esc to go back</Text></Box>
    </Box>
  );
}
