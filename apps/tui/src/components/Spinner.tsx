// SPDX-License-Identifier: Apache-2.0
// Animated spinner (#187): braille frames advanced on an interval while
// mounted. Used for streaming turns and running tools in ChatView.
import React, { useEffect, useState } from 'react';
import { Text } from 'ink';

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

export function Spinner({ color, label }: { color?: string; label?: string }): React.ReactElement {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);
  return (
    <Text color={color}>
      {SPINNER_FRAMES[frame]}
      {label ? ` ${label}` : ''}
    </Text>
  );
}
