// SPDX-License-Identifier: Apache-2.0
// RealtimeCallClient tests: pure audio helpers, the gapless player with a
// fake AudioContext, and socket orchestration with a fake WebSocket.
// fetch is stubbed; no network, no DOM, no real audio.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RealtimeAudioPlayer,
  RealtimeCallClient,
  base64ToPcm16,
  downsampleToRate,
  floatToPcm16,
  pcm16ToBase64,
  type AudioBufferLike,
  type AudioBufferSourceLike,
  type AudioContextLike,
  type RealtimeClientEvent,
} from './realtime-call-client';
import type { VoiceCallSocket } from './voice-call-client';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllGlobals();
});

function stubFetch(handler: (url: string, init?: RequestInit) => unknown): void {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const body = u.includes('/api/auth/bootstrap') ? { token: 'test-token' } : handler(u, init);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('pure audio helpers', () => {
  it('floatToPcm16 clips and scales', () => {
    const pcm = floatToPcm16(new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]));
    expect(pcm[0]).toBe(0);
    expect(pcm[1]).toBe(16384);
    expect(pcm[2]).toBe(-16384);
    expect(pcm[3]).toBe(32767);
    expect(pcm[4]).toBe(-32768);
    expect(pcm[5]).toBe(32767);
    expect(pcm[6]).toBe(-32768);
  });

  it('downsampleToRate halves 48kHz → 24kHz', () => {
    const input = new Float32Array(480).fill(0.5);
    const out = downsampleToRate(input, 48000, 24000);
    expect(out.length).toBe(240);
    expect(out[0]).toBeCloseTo(0.5, 5);
  });

  it('downsampleToRate passes through when already at/below target', () => {
    const input = new Float32Array([0.1, 0.2]);
    expect(downsampleToRate(input, 16000, 16000)).toBe(input);
  });

  it('pcm16 base64 round-trips', () => {
    const pcm = new Int16Array([0, 1000, -1000, 32767, -32768]);
    const b64 = pcm16ToBase64(pcm);
    const back = base64ToPcm16(b64);
    expect(Array.from(back)).toEqual(Array.from(pcm));
  });
});

// ---------------------------------------------------------------------------
// Fake AudioContext for the player.
// ---------------------------------------------------------------------------

interface FakeSource extends AudioBufferSourceLike {
  startedAt: number | null;
  stopped: boolean;
}

function makeFakeAudioContext(): AudioContextLike & { sources: FakeSource[] } {
  const sources: FakeSource[] = [];
  const ctx: AudioContextLike & { sources: FakeSource[] } = {
    sources,
    sampleRate: 48000,
    currentTime: 10,
    destination: {},
    createBuffer(_channels: number, length: number, sampleRate: number): AudioBufferLike {
      const data = new Float32Array(length);
      return {
        sampleRate,
        length,
        duration: length / sampleRate,
        getChannelData: () => data,
      };
    },
    createBufferSource(): AudioBufferSourceLike {
      const src: FakeSource = {
        buffer: null,
        onended: null,
        startedAt: null,
        stopped: false,
        connect() {},
        start(when?: number) {
          src.startedAt = when ?? 0;
        },
        stop() {
          src.stopped = true;
          src.onended?.();
        },
      };
      sources.push(src);
      return src;
    },
    async decodeAudioData(): Promise<AudioBufferLike> {
      return ctx.createBuffer(1, 480, 48000);
    },
  };
  return ctx;
}

describe('RealtimeAudioPlayer', () => {
  it('schedules PCM16 chunks back-to-back', () => {
    const ctx = makeFakeAudioContext();
    const player = new RealtimeAudioPlayer(ctx);
    const b64 = pcm16ToBase64(new Int16Array(1600).fill(1000));
    player.playPcm16(b64, 16000);
    player.playPcm16(b64, 16000);
    expect(ctx.sources).toHaveLength(2);
    expect(ctx.sources[0].startedAt).toBe(10);
    // 1600 samples @16kHz = 0.1s → second chunk at 10.1.
    expect(ctx.sources[1].startedAt).toBeCloseTo(10.1, 5);
    expect(player.playing).toBe(true);
  });

  it('stopAll halts every source (barge-in)', () => {
    const ctx = makeFakeAudioContext();
    const player = new RealtimeAudioPlayer(ctx);
    const b64 = pcm16ToBase64(new Int16Array(1600).fill(1000));
    player.playPcm16(b64, 16000);
    player.playPcm16(b64, 16000);
    player.stopAll();
    expect(ctx.sources.every((s) => s.stopped)).toBe(true);
    expect(player.playing).toBe(false);
  });

  it('drops audio from a stale turn', async () => {
    const ctx = makeFakeAudioContext();
    const player = new RealtimeAudioPlayer(ctx);
    await player.playEncoded('AAAA', 'turn-1');
    expect(ctx.sources).toHaveLength(1);
    // A newer turn id takes over; the old turn's audio is dropped.
    await player.playEncoded('AAAA', 'turn-2');
    await player.playEncoded('AAAA', 'turn-1');
    expect(ctx.sources).toHaveLength(2);
  });

  it('ignores empty PCM', () => {
    const ctx = makeFakeAudioContext();
    const player = new RealtimeAudioPlayer(ctx);
    player.playPcm16(pcm16ToBase64(new Int16Array(0)), 16000);
    expect(ctx.sources).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fake socket for the client.
// ---------------------------------------------------------------------------

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

function makeClient(
  events: RealtimeClientEvent[],
  sockets: FakeSocket[],
  startedFrame: Record<string, unknown> = {
    t: 'realtime_started',
    engine: 'chunked',
    path: 'chunked-rest',
    sampleRate: 16000,
    maxCallMs: 900000,
  },
): RealtimeCallClient {
  return new RealtimeCallClient(
    (e) => events.push(e),
    () => {
      const sock = makeFakeSocket();
      sockets.push(sock);
      // Async connect, like a real socket.
      setTimeout(() => sock.receive(startedFrame), 0);
      return sock;
    },
  );
}

function stubRealtimeCalls() {
  stubFetch((u) => {
    if (u.includes('/api/voice/realtime/calls')) {
      return {
        callId: 'vrt_1',
        wsPath: '/api/voice/realtime/ws?callId=vrt_1',
        engine: 'chunked',
        path: 'chunked-rest',
        sampleRate: 16000,
      };
    }
    return {};
  });
}

describe('RealtimeCallClient', () => {
  it('starts a session and translates frames', async () => {
    stubRealtimeCalls();
    const events: RealtimeClientEvent[] = [];
    const sockets: FakeSocket[] = [];
    const client = makeClient(events, sockets);
    await client.start('bot_1', { engine: 'chunked' });
    expect(client.activeCallId).toBe('vrt_1');
    expect(sockets).toHaveLength(1);
    const sock = sockets[0];
    expect(events[0]).toMatchObject({ type: 'connected', engine: 'chunked', sampleRate: 16000 });

    sock.receive({ t: 'speech_started' });
    sock.receive({ t: 'barge_in' });
    sock.receive({ t: 'latency', ms: 812 });
    sock.receive({ t: 'usage', sttSec: 1.2, ttsChars: 40, llmChars: 100, audioSec: 5, usdApprox: 0.001 });
    sock.receive({ t: 'audio', seq: 1, turnId: 'vrt_a', data: 'QUJD', mimeType: 'audio/wav' });
    sock.receive({ t: 'turn_done', latencyMs: 812 });
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'connected',
      'speech_started',
      'barge_in',
      'latency',
      'usage',
      'audio',
      'turn_done',
    ]);
    const usage = events[4] as { type: 'usage'; usage: { usdApprox: number } };
    expect(usage.usage.usdApprox).toBe(0.001);

    // PCM chunks go out as base64 audio frames.
    client.sendPcm16(new Int16Array([1, 2, 3]));
    const sent = JSON.parse(sock.sent[0]) as { t: string; data: string };
    expect(sent.t).toBe('audio');
    expect(typeof sent.data).toBe('string');

    await client.end();
    expect(events[events.length - 1].type).toBe('ended');
    const endFrame = sock.sent.map((s) => JSON.parse(s) as { t: string }).find((f) => f.t === 'end');
    expect(endFrame?.t).toBe('end');
  });

  it('surfaces REST failures on start', async () => {
    stubFetch(() => {
      throw new Error('nope');
    });
    const events: RealtimeClientEvent[] = [];
    const sockets: FakeSocket[] = [];
    const client = makeClient(events, sockets);
    await expect(client.start('ghost')).rejects.toThrow();
    expect(events).toEqual([]);
  });

  it('rejects double start', async () => {
    stubRealtimeCalls();
    const events: RealtimeClientEvent[] = [];
    const sockets: FakeSocket[] = [];
    const client = makeClient(events, sockets);
    await client.start('bot_1');
    await expect(client.start('bot_1')).rejects.toThrow(/already in progress/);
    await client.end();
  });
});
