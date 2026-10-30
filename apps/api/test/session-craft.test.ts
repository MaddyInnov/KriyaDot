// SPDX-License-Identifier: Apache-2.0
// Session craft: /reply quoting + /context reporting (pure helpers).

import { describe, expect, it } from 'vitest';
import type { IdentifiedMessage } from '@mvp/agent-runtime';
import {
  buildContextReport,
  buildFragmentReply,
  buildQuotedReply,
  formatContextSummary,
  isFragmentReplyMessage,
  parseFragmentReply,
  parseReplyCommand,
  resolveQuotedMessage,
  validateFragmentReply,
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

describe('#37 fragment (selection) replies', () => {
  it('composes the web wire format: marker, selection header, fragment quote, response', () => {
    const out = buildFragmentReply(messages, { ref: '#12', fragment: 'Done in 40s.', text: 'why so fast?' });
    expect(out).not.toBeNull();
    expect(out!.startsWith('<!-- quotedFragment -->\n')).toBe(true);
    expect(out).toContain('[Replying to a selection from message #12 (assistant)]');
    expect(out).toContain('> Done in 40s.');
    expect(out).not.toContain('Deploying now.');
    expect(out).toContain('\n\nwhy so fast?');
    expect(isFragmentReplyMessage(out!)).toBe(true);
  });

  it('is fail-closed: fragments that are not verbatim substrings are rejected', () => {
    expect(buildFragmentReply(messages, { ref: '#12', fragment: 'Done in 41s.', text: 'x' })).toBeNull();
    expect(buildFragmentReply(messages, { ref: '#12', fragment: '   ', text: 'x' })).toBeNull();
    expect(buildFragmentReply(messages, { ref: '#999', fragment: 'Done in 40s.', text: 'x' })).toBeNull();
  });

  it('parses a composed fragment reply back and validates it against history', () => {
    const out = buildFragmentReply(messages, { ref: '2', fragment: 'Deploying now.', text: 'go on' })!;
    const parsed = parseFragmentReply(out);
    expect(parsed).toEqual({ messageId: 12, role: 'assistant', fragment: 'Deploying now.', text: 'go on' });
    expect(validateFragmentReply(messages, out)).toEqual(parsed);
    // Tampered quote (not in the source message) fails validation.
    const tampered = out.replace('Deploying now.', 'Deploying slowly.');
    expect(validateFragmentReply(messages, tampered)).toBeNull();
    // A plain message is not a fragment reply.
    expect(parseFragmentReply('hello')).toBeNull();
    expect(validateFragmentReply(messages, 'hello')).toBeNull();
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
