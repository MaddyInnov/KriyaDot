// SPDX-License-Identifier: Apache-2.0
// Bot picker: arrow-key navigation, Enter selects, Esc goes back.
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { BotSummary } from '../api.js';
import type { TuiPalette } from '../themes.js';

interface Props {
  bots: BotSummary[];
  palette: TuiPalette;
  onSelect: (bot: BotSummary) => void;
  onBack: () => void;
}

export function BotsView({ bots, palette, onSelect, onBack }: Props): React.ReactElement {
  const [index, setIndex] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) setIndex((i) => (i - 1 + bots.length) % Math.max(bots.length, 1));
    else if (key.downArrow) setIndex((i) => (i + 1) % Math.max(bots.length, 1));
    else if (key.return && bots[index]) onSelect(bots[index]);
    else if (key.escape) onBack();
  });

  if (bots.length === 0) {
    return (
      <Box paddingX={1}>
        <Text color={palette.dim}>No bots found. Esc to go back.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={palette.dim}>↑/↓ to move · Enter to chat · Esc to go back</Text>
      <Box marginTop={1} flexDirection="column">
        {bots.map((b, i) => (
          <Box key={b.id}>
            <Text backgroundColor={i === index ? palette.select : undefined}>
              <Text color={i === index ? palette.accent : palette.text} bold={i === index}>
                {i === index ? '▸ ' : '  '}
                {b.name}
              </Text>
              <Text color={palette.dim}>  {b.id}{b.model ? ` · ${b.model}` : ''}</Text>
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
