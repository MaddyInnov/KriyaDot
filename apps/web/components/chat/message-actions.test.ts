// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  buildMessageShareText, canDeleteOwnMessage, canShareMessage,
  messageDeletePath, messageExportFileName, messageExportPath, messageSharePath,
} from './message-actions';

describe('message actions (C-9/C-12)', () => {
  it('share offered for user/assistant only, never tool/system/empty', () => {
    expect(canShareMessage({ role: 'user', content: 'hi' })).toBe(true);
    expect(canShareMessage({ role: 'assistant', content: 'hi' })).toBe(true);
    expect(canShareMessage({ role: 'tool', content: 'trace' })).toBe(false);
    expect(canShareMessage({ role: 'user', content: '  ' })).toBe(false);
  });
  it('delete offered only on own (user) messages', () => {
    expect(canDeleteOwnMessage({ role: 'user', content: 'x' })).toBe(true);
    expect(canDeleteOwnMessage({ role: 'assistant', content: 'x' })).toBe(false);
  });
  it('share text is the verbatim content; file names + paths are stable', () => {
    expect(buildMessageShareText({ role: 'user', content: 'a\nb' })).toBe('a\nb');
    expect(messageExportFileName('sess_123456789', 7, 'markdown')).toBe('message-sess_123-7.md');
    expect(messageSharePath('s 1', 2)).toBe('/api/sessions/s%201/messages/2/share');
    expect(messageExportPath('s1', 2, 'json')).toContain('format=json');
    expect(messageDeletePath('s1', 2)).toBe('/api/sessions/s1/messages/2');
  });
});
