// SPDX-License-Identifier: Apache-2.0
// Read-only: bot memory summary.
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { BotSummary, KriyaDotApi } from '../api.js';
import type { TuiPalette } from '../themes.js';

interface Props {
  api: KriyaDotApi;
  bot: BotSummary;
  palette: TuiPalette;
}

const MAX_CHARS = 6000;

export function MemoryView({ api, bot, palette }: Props): React.ReactElement {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void api
      .getBotMemory(bot.id)
      .then((c) => alive && setContent(c))
      .catch((err: Error) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, [api, bot.id]);

  if (error) return <Box paddingX={1}><Text color={palette.red}>⚠ {error}</Text></Box>;
  if (content === null) return <Box paddingX={1}><Text color={palette.dim}>Loading memory…</Text></Box>;

  const shown = content.length > MAX_CHARS ? `${content.slice(0, MAX_CHARS)}\n…(truncated)` : content;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={palette.accent} bold>{bot.name}’s memory</Text>
      <Box marginTop={1}>
        <Text color={palette.text}>{shown || '(empty — nothing remembered yet)'}</Text>
      </Box>
      <Box marginTop={1}><Text color={palette.dim}>Esc to go back</Text></Box>
    </Box>
  );
}
