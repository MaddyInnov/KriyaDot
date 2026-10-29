// SPDX-License-Identifier: Apache-2.0
// Session craft: /reply quoting + /context reporting (pure helpers).

import { describe, expect, it } from 'vitest';
import type { IdentifiedMessage } from '@mvp/agent-runtime';
import {
  buildContextReport,
  buildQuotedReply,
  formatContextSummary,
  parseReplyCommand,
  resolveQuotedMessage,
} from '../src/session-craft.js';

const messages: IdentifiedMessage[] = [
  { id: 11, role: 'user', content: 'Deploy the staging build please', ts: '2026-10-29T10:00:00.000Z' },
  { id: 12, role: 'assistant', content: 'Deploying now.\nDone in 40s.', ts: '2026-10-29T10:01:00.000Z' },
  { id: 13, role: 'user', content: 'Thanks!', ts: '2026-10-29T10:02:00.000Z' },
];

describe('/reply parsing + resolution', () => {
  it('parses the command and resolves by #id and by position', () => {
    expect(parseReplyCommand('/reply #12 why so fast?')).toEqual({ ref: '#12', text: 'why so fast?' });
    expect(parseReplyCommand('hello')).toBeNull();
    expect(resolveQuotedMessage(messages, '#12')?.id).toBe(12);
    expect(resolveQuotedMessage(messages, '1')?.id).toBe(11);
    expect(resolveQuotedMessage(messages, '#999')).toBeUndefined();
    expect(resolveQuotedMessage(messages, '99')).toBeUndefined();
  });

  it('wraps the reply with a quote block naming the source message', () => {
    const wrapped = buildQuotedReply(messages, { ref: '#12', text: 'why so fast?' });
    expect(wrapped).toContain('[Replying to message #12 (assistant)]');
    expect(wrapped).toContain('> Deploying now.');
    expect(wrapped).toContain('> Done in 40s.');
    expect(wrapped).toContain('\n\nwhy so fast?');
  });

  it('returns null for unresolvable refs (the route turns that into a 400)', () => {
    expect(buildQuotedReply(messages, { ref: '#42', text: 'x' })).toBeNull();
  });

  it('truncates very long quoted excerpts', () => {
    const long: IdentifiedMessage[] = [
      { id: 5, role: 'assistant', content: 'x'.repeat(5000), ts: '2026-10-29T10:00:00.000Z' },
    ];
    const wrapped = buildQuotedReply(long, { ref: '#5', text: 'ok' })!;
    expect(wrapped.length).toBeLessThan(900);
    expect(wrapped).toContain('…');
  });
});

describe('/context report', () => {
  it('counts roles, estimates tokens, and lists archives', () => {
    const report = buildContextReport('sess-1', 'bot-1', messages, [
      { id: 'arc-1', messageCount: 40, createdAt: '2026-10-29T09:00:00.000Z' },
    ]);
    expect(report.messages).toBe(3);
    expect(report.byRole).toEqual({ user: 2, assistant: 1 });
    expect(report.estimatedHistoryTokens).toBe(Math.round(report.historyChars / 4));
    expect(report.compactionArchives).toHaveLength(1);
    const summary = formatContextSummary(report);
    expect(summary).toContain('3 messages');
    expect(summary).toContain('1 compaction archive');
  });
});
