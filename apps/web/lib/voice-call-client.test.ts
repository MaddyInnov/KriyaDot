// SPDX-License-Identifier: Apache-2.0
// VoiceCallClient tests with a fake WebSocket: frame fan-out, utterance
// sending, and the start/end lifecycle. fetch is stubbed; no network.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VoiceCallClient,
  type CallClientEvent,
  type VoiceCallSocket,
} from './voice-call-client';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllGlobals();
});

function stubFetch(handler: (url: string, init?: RequestInit) => unknown): void {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    // Auth bootstrap: every authed request awaits this first.
    const body = u.includes('/api/auth/bootstrap') ? { token: 'test-token' } : handler(u, init);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

interface FakeSocket extends VoiceCallSocket {
  sent: string[];
  receive(frame: Record<string, unknown>): void;
  triggerClose(): void;
}

function makeFakeSocket(): FakeSocket {
  const sock: FakeSocket = {
    sent: [],
    onmessage: null,
    onclose: null,
    onerror: null,
    send(d: string) {
      sock.sent.push(d);
    },
    close() {
      sock.triggerClose();
    },
    receive(frame: Record<string, unknown>) {
      sock.onmessage?.({ data: JSON.stringify(frame) });
    },
    triggerClose() {
      sock.onclose?.();
    },
  };
  return sock;
}

function startHarness() {
  const events: CallClientEvent[] = [];
  const sockets: FakeSocket[] = [];
  const client = new VoiceCallClient(
    (e) => events.push(e),
    (url: string) => {
      expect(url).toContain('/api/voice/calls/ws?callId=');
      const s = makeFakeSocket();
      sockets.push(s);
      // Async connect, like a real socket.
      setTimeout(() => s.receive({ t: 'call_started', stt: 'mock', tts: 'mock' }), 0);
      return s;
    },
  );
  stubFetch((url) => {
    expect(url).toContain('/api/voice/calls');
    return { callId: 'vcall_test1', wsPath: '/api/voice/calls/ws?callId=vcall_test1', stt: 'mock', tts: 'mock' };
  });
  return { client, events, sockets };
}

describe('VoiceCallClient', () => {
  it('starts a session, connects the socket, and emits connected', async () => {
    const { client, events, sockets } = startHarness();
    await client.start('bot_1');
    expect(client.activeCallId).toBe('vcall_test1');
    expect(sockets).toHaveLength(1);
    expect(events).toContainEqual({ type: 'connected', stt: 'mock', tts: 'mock' });
  });

  it('fans out transcript/reply/audio/turn_done frames in order', async () => {
    const { client, events, sockets } = startHarness();
    await client.start('bot_1');
    const sock = sockets[0];
    sock.receive({ t: 'transcript', text: 'hello bot' });
    sock.receive({ t: 'reply', text: 'hello human' });
    sock.receive({ t: 'audio', data: 'QUJD', mimeType: 'audio/wav' });
    sock.receive({ t: 'turn_done' });
    expect(events).toContainEqual({ type: 'transcript', text: 'hello bot' });
    expect(events).toContainEqual({ type: 'reply', text: 'hello human' });
    expect(events).toContainEqual({ type: 'audio', data: 'QUJD', mimeType: 'audio/wav' });
    expect(events).toContainEqual({ type: 'turn_done', skipped: false });
    expect(client.activeCallId).toBe('vcall_test1');
  });

  it('relays approval_required frames', async () => {
    const { client, events, sockets } = startHarness();
    await client.start('bot_1');
    sockets[0].receive({ t: 'approval_required', approvalId: 'appr_9' });
    expect(events).toContainEqual({ type: 'approval_required', approvalId: 'appr_9' });
  });

  it('sends utterances as JSON frames and ends the call', async () => {
    const { client, events, sockets } = startHarness();
    await client.start('bot_1');
    client.sendUtterance('QUJD', 'audio/webm');
    const sent = JSON.parse(sockets[0].sent[0]) as Record<string, unknown>;
    expect(sent.t).toBe('utterance');
    expect(sent.audio).toBe('QUJD');
    expect(sent.mimeType).toBe('audio/webm');
    await client.end();
    expect(client.activeCallId).toBeNull();
    expect(events).toContainEqual({ type: 'ended' });
  });

  it('throws when sending with no active call', () => {
    const events: CallClientEvent[] = [];
    const client = new VoiceCallClient((e) => events.push(e), () => makeFakeSocket());
    expect(() => client.sendUtterance('QQ==')).toThrow(/no active call/);
  });

  it('surfaces server errors as events', async () => {
    const { client, events, sockets } = startHarness();
    await client.start('bot_1');
    sockets[0].receive({ t: 'error', detail: 'utterance too large' });
    expect(events).toContainEqual({ type: 'error', detail: 'utterance too large' });
  });
});

describe('getVoiceCallProviders', () => {
  it('returns the provider list', async () => {
    const { getVoiceCallProviders } = await import('./voice-call-client');
    stubFetch(() => ({
      providers: [
        { id: 'mock', label: 'Mock (offline)', configured: true },
        { id: 'groq', label: 'Groq', configured: false, hint: 'add key' },
      ],
    }));
    const list = await getVoiceCallProviders();
    expect(list).toHaveLength(2);
    expect(list[1].configured).toBe(false);
  });
});
