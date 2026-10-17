// SPDX-License-Identifier: Apache-2.0
// Tests for the chat message length cap (L5): 200k chars, 400 beyond.

import { describe, expect, it } from 'vitest';
import { MAX_CHAT_MESSAGE_CHARS, validateChatMessage } from '../src/routes.js';

describe('chat message validation (L5)', () => {
  it('rejects missing and blank messages', () => {
    expect(validateChatMessage(undefined)).toBe('message is required');
    expect(validateChatMessage(null)).toBe('message is required');
    expect(validateChatMessage('   ')).toBe('message is required');
    expect(validateChatMessage(42)).toBe('message is required');
  });

  it('rejects messages over the cap', () => {
    expect(MAX_CHAT_MESSAGE_CHARS).toBe(200_000);
    expect(validateChatMessage('x'.repeat(200_001))).toMatch(/exceeds 200000/);
  });

  it('accepts normal and boundary-length messages', () => {
    expect(validateChatMessage('hello')).toBeNull();
    expect(validateChatMessage('x'.repeat(200_000))).toBeNull();
  });
});
