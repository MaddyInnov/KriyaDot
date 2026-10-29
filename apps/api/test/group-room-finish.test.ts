// SPDX-License-Identifier: Apache-2.0
// Room finish (§1.2 partials): per-participant turn timeout plumbing
// (settings → runner enforcement) and the room bulletin round-trip
// (settings → store → room detail).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BotConfig } from '@mvp/agent-runtime';
import { GroupChatStore } from '../src/group-chats.js';
import {
  resolveRoomSettings,
  sanitizeRoomSettingsPatch,
} from '../src/group-rooms.js';
import { ParticipantTurnTimeoutError, runRoomTurn } from '../src/group-room-turn.js';

function bot(id: string): BotConfig {
  return {
    id,
    name: `Bot ${id}`,
    description: 'd',
    systemPrompt: 'p',
    provider: 'groq',
    model: 'm',
    skills: [],
    tools: [],
    mcpServers: [],
  };
}

describe('settings plumbing for participantTurnTimeoutSec + bulletin', () => {
  it('sanitize accepts valid values, null clears, and rejects out-of-range', () => {
    expect(sanitizeRoomSettingsPatch({ participantTurnTimeoutSec: 120 })).toEqual({
      ok: true,
      patch: { participantTurnTimeoutSec: 120 },
    });
    expect(sanitizeRoomSettingsPatch({ participantTurnTimeoutSec: null })).toEqual({
      ok: true,
      patch: { participantTurnTimeoutSec: null },
    });
    expect(sanitizeRoomSettingsPatch({ participantTurnTimeoutSec: 4 }).ok).toBe(false);
    expect(sanitizeRoomSettingsPatch({ participantTurnTimeoutSec: 3601 }).ok).toBe(false);
    expect(sanitizeRoomSettingsPatch({ bulletin: 'Standup at 9' })).toEqual({
      ok: true,
      patch: { bulletin: 'Standup at 9' },
    });
    expect(sanitizeRoomSettingsPatch({ bulletin: '' })).toEqual({ ok: true, patch: { bulletin: null } });
    expect(sanitizeRoomSettingsPatch({ bulletin: 'x'.repeat(501) }).ok).toBe(false);
  });

  it('store round-trips both fields and resolveRoomSettings surfaces them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'room-finish-'));
    const store = new GroupChatStore(dir);
    const group = store.createGroup('Room', ['bot-a']);
    let row = store.saveRoomSettings(group.id, { participantTurnTimeoutSec: 90, bulletin: 'Be kind' });
    expect(row.participantTurnTimeoutSec).toBe(90);
    expect(row.bulletin).toBe('Be kind');
    const resolved = resolveRoomSettings(row);
    expect(resolved.participantTurnTimeoutSec).toBe(90);
    expect(resolved.bulletin).toBe('Be kind');

    row = store.saveRoomSettings(group.id, { participantTurnTimeoutSec: null, bulletin: null });
    expect(row.participantTurnTimeoutSec).toBeNull();
    expect(row.bulletin).toBeNull();
    expect(resolveRoomSettings(row).bulletin).toBe('');
    store.close();
  });

  it('defaults: no participant cap, empty bulletin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'room-finish-'));
    const store = new GroupChatStore(dir);
    const group = store.createGroup('Room', ['bot-a']);
    const resolved = resolveRoomSettings(store.getRoomSettingsRow(group.id));
    expect(resolved.participantTurnTimeoutSec).toBeNull();
    expect(resolved.bulletin).toBe('');
    store.close();
  });
});

describe('runRoomTurn per-participant timeout enforcement', () => {
  it('a slow member fails with ParticipantTurnTimeoutError and the room continues', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'room-finish-turn-'));
    const store = new GroupChatStore(dir);
    const group = store.createGroup('Room', ['slow-bot', 'fast-bot']);
    store.addMessage(group.id, 'user', 'hello everyone', null);
    const failures: string[] = [];
    const result = await runRoomTurn(group, 'hello everyone', {
      store,
      getBot: (id) => bot(id),
      runMemberTurn: async (b) => {
        if (b.id === 'slow-bot') {
          await new Promise((r) => setTimeout(r, 300));
          return { text: 'slow reply' };
        }
        return { text: 'fast reply' };
      },
      memberTimeoutMs: () => 50,
      onMemberError: ({ bot: b, error }) => {
        failures.push(`${b.id}:${error instanceof Error ? error.name : 'err'}`);
        return null;
      },
    });
    // One failure per round (3 rounds), every one the slow member's.
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures.every((f) => f.botId === 'slow-bot')).toBe(true);
    expect(result.failures[0].error).toContain('per-participant turn timeout');
    expect(failures.every((f) => f === 'slow-bot:ParticipantTurnTimeoutError')).toBe(true);
    expect(result.replies.length).toBeGreaterThan(0);
    expect(result.replies.every((r) => r.botId === 'fast-bot')).toBe(true);
    expect(result.timedOut).toBe(false); // whole-turn timeout untouched
    store.close();
  });

  it('no cap configured → slow members complete normally', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'room-finish-turn-'));
    const store = new GroupChatStore(dir);
    const group = store.createGroup('Room', ['slow-bot']);
    store.addMessage(group.id, 'user', 'hi', null);
    const result = await runRoomTurn(group, 'hi', {
      store,
      getBot: (id) => bot(id),
      runMemberTurn: async () => {
        await new Promise((r) => setTimeout(r, 60));
        return { text: 'done eventually' };
      },
      memberTimeoutMs: () => null,
    });
    expect(result.replies.length).toBeGreaterThan(0);
    expect(result.replies.every((r) => r.text === 'done eventually')).toBe(true);
    expect(result.failures).toHaveLength(0);
    store.close();
  });

  it('ParticipantTurnTimeoutError carries bot + budget', () => {
    const err = new ParticipantTurnTimeoutError('bot-x', 45_000);
    expect(err.botId).toBe('bot-x');
    expect(err.timeoutMs).toBe(45_000);
    expect(err.message).toContain('45s');
  });
});
