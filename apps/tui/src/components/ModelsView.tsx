// SPDX-License-Identifier: Apache-2.0
// Model list: read-only catalog; Enter switches the current bot's model.
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { KriyaDotApi, ModelInfo } from '../api.js';
import type { TuiPalette } from '../themes.js';

interface Props {
  api: KriyaDotApi;
  palette: TuiPalette;
  currentModel?: string;
  onSelect: (modelId: string) => void;
  onBack: () => void;
}

export function ModelsView({ api, palette, currentModel, onSelect, onBack }: Props): React.ReactElement {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [error, setError] = useState('');
  const [index, setIndex] = useState(0);

  useEffect(() => {
    let alive = true;
    void api
      .listModels()
      .then((m) => alive && setModels(m))
      .catch((err: Error) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, [api]);

  useInput((input, key) => {
    if (!models || models.length === 0) {
      if (key.escape) onBack();
      return;
    }
    if (key.upArrow) setIndex((i) => (i - 1 + models.length) % models.length);
    else if (key.downArrow) setIndex((i) => (i + 1) % models.length);
    else if (key.return) onSelect(models[index].id);
    else if (key.escape) onBack();
  });

  if (error) return <Box paddingX={1}><Text color={palette.red}>⚠ {error}</Text></Box>;
  if (!models) return <Box paddingX={1}><Text color={palette.dim}>Loading models…</Text></Box>;
  if (models.length === 0) return <Box paddingX={1}><Text color={palette.dim}>No models available. Esc to go back.</Text></Box>;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={palette.dim}>↑/↓ to move · Enter to switch model · Esc to go back</Text>
      <Box marginTop={1} flexDirection="column">
        {models.map((m, i) => (
          <Box key={`${m.providerId}/${m.id}`}>
            <Text backgroundColor={i === index ? palette.select : undefined}>
              <Text color={i === index ? palette.accent : palette.text} bold={i === index}>
                {i === index ? '▸ ' : '  '}
                {m.id}
              </Text>
              <Text color={palette.dim}>  {m.providerId}{m.free ? ' · free' : ''}{currentModel === m.id ? ' · current' : ''}</Text>
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
