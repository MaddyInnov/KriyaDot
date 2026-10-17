// SPDX-License-Identifier: Apache-2.0
// Tests for sessions.ts delete/duplicate (bot context-menu management):
// - deleteSession removes the session, its messages, compactions, worktrees
// - duplicateSession copies everything and titles it "Copy of …"

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../src/sessions.js';

describe('SessionStore delete/duplicate', () => {
  let dir: string;
  let store: SessionStore;
  let sessionId: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sessdd-'));
    store = new SessionStore(join(dir, 'sessions.db'));
    sessionId = store.createSession('bot-a', { title: 'Original' });
    store.appendMessage(sessionId, { role: 'user', content: 'hello' });
    store.appendMessage(sessionId, { role: 'assistant', content: 'hi there' });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('duplicateSession copies messages to a new session id', () => {
    const copyId = store.duplicateSession(sessionId);
    expect(copyId).toBeDefined();
    expect(copyId).not.toBe(sessionId);
    const msgs = store.listThreadMessages(copyId!);
    expect(msgs.map((m) => m.content)).toEqual(['hello', 'hi there']);
    // Original is untouched.
    expect(store.listThreadMessages(sessionId)).toHaveLength(2);
  });

  it('deleteSession removes the session and its messages', () => {
    expect(store.deleteSession(sessionId)).toBe(true);
    expect(store.listThreadMessages(sessionId)).toHaveLength(0);
    expect(store.listSessions({ botId: 'bot-a' }).find((s) => s.id === sessionId)).toBeUndefined();
    expect(store.deleteSession(sessionId)).toBe(false);
  });

  it('duplicateSession returns undefined for an unknown session', () => {
    expect(store.duplicateSession('missing')).toBeUndefined();
  });
});
