// SPDX-License-Identifier: Apache-2.0
// Ink renderer for parsed markdown (#186): headings in accent bold,
// inline code amber, links as accent underlined text + dim URL, fenced
// code blocks token-highlighted via highlight.ts, thinking blocks are
// handled by ChatView (this component renders assistant prose only).
import React from 'react';
import { Box, Text } from 'ink';
import type { TuiPalette } from '../themes.js';
import { parseMarkdown, type InlineSpan } from '../markdown.js';
import { tokenizeCode, type TokenKind } from '../highlight.js';

function tokenColor(kind: TokenKind, palette: TuiPalette): string | undefined {
  switch (kind) {
    case 'keyword':
      return palette.accent;
    case 'string':
      return palette.green;
    case 'number':
      return palette.amber;
    case 'comment':
      return palette.dim;
    default:
      return undefined;
  }
}

function Spans({ spans, palette, baseColor }: { spans: InlineSpan[]; palette: TuiPalette; baseColor?: string }): React.ReactElement {
  return (
    <Text>
      {spans.map((s, i) => {
        switch (s.style) {
          case 'bold':
            return (
              <Text key={i} bold color={baseColor ?? palette.text}>
                {s.text}
              </Text>
            );
          case 'italic':
            return (
              <Text key={i} italic color={baseColor ?? palette.text}>
                {s.text}
              </Text>
            );
          case 'code':
            return (
              <Text key={i} color={palette.amber}>
                {s.text}
              </Text>
            );
          case 'link':
            return (
              <Text key={i}>
                <Text color={palette.accent} underline>
                  {s.text}
                </Text>
                {s.href && s.href !== s.text ? <Text color={palette.dim}> ({s.href})</Text> : null}
              </Text>
            );
          default:
            return (
              <Text key={i} color={baseColor ?? palette.text}>
                {s.text}
              </Text>
            );
        }
      })}
    </Text>
  );
}

export function MarkdownText({ text, palette }: { text: string; palette: TuiPalette }): React.ReactElement {
  const blocks = parseMarkdown(text);
  if (blocks.length === 0) return <Text color={palette.text}>{text}</Text>;
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'heading':
            return (
              <Text key={i} bold color={palette.accent}>
                <Spans spans={b.spans} palette={palette} baseColor={palette.accent} />
              </Text>
            );
          case 'code':
            return (
              <Box key={i} flexDirection="column" borderStyle="single" borderColor={palette.border} paddingX={1}>
                {b.lang ? <Text color={palette.dim}>{b.lang}</Text> : null}
                {b.code.split('\n').map((line, li) => (
                  <Text key={li}>
                    {tokenizeCode(line).map((tok, ti) => (
                      <Text key={ti} color={tokenColor(tok.kind, palette)} italic={tok.kind === 'comment'}>
                        {tok.text}
                      </Text>
                    ))}
                  </Text>
                ))}
              </Box>
            );
          case 'list':
            return (
              <Box key={i} flexDirection="column">
                {b.items.map((item, ii) => (
                  <Text key={ii}>
                    <Text color={palette.accent}>• </Text>
                    <Spans spans={item} palette={palette} />
                  </Text>
                ))}
              </Box>
            );
          case 'quote':
            return (
              <Text key={i}>
                <Text color={palette.dim}>│ </Text>
                <Spans spans={b.spans} palette={palette} baseColor={palette.dim} />
              </Text>
            );
          case 'rule':
            return (
              <Text key={i} color={palette.dim}>
                {'─'.repeat(40)}
              </Text>
            );
          default:
            return <Spans key={i} spans={b.spans} palette={palette} />;
        }
      })}
    </Box>
  );
}
