// SPDX-License-Identifier: Apache-2.0
// OpenAI Realtime bridge tests: event translation, upsampling, and the
// connect handshake — all against a fake WebSocket. Zero network, zero
// paid usage. The bridge has not been live-fired against api.openai.com.

import { describe, expect, it, vi } from 'vitest';
import {
  OpenAIRealtimeBridge,
  REALTIME_SAMPLE_RATE,
  upsample16kTo24k,
  type RealtimeBridgeEvent,
} from '../src/openai-realtime.js';

interface FakeSocket {
  sent: string[];
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number): void;
  url: string;
  opts: unknown;
}

function makeFakeWs(sockets: FakeSocket[]) {
  return function (url: string, opts: unknown) {
    const sock: FakeSocket = {
      sent: [],
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      url,
      opts,
      send(data: string) {
        sock.sent.push(data);
      },
      close() {
        sock.onclose?.({});
      },
    };
    sockets.push(sock);
    return sock;
  } as unknown as typeof WebSocket;
}

function synth16k(n: number, amp: number): Int16Array {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(amp * 32767 * Math.sin((2 * Math.PI * 440 * i) / 16000));
  return out;
}

describe('upsample16kTo24k', () => {
  it('produces 1.5x samples with interpolated values', () => {
    const up = upsample16kTo24k(synth16k(1600, 0.4));
    expect(up.length).toBe(2400);
    expect(up).toBeInstanceOf(Int16Array);
  });

  it('handles empty input', () => {
    expect(upsample16kTo24k(new Int16Array(0)).length).toBe(0);
  });
});

describe('OpenAIRealtimeBridge', () => {
  it('requires an apiKey', () => {
    expect(() => new OpenAIRealtimeBridge({ apiKey: '' })).toThrow(/apiKey is required/);
  });

  it('connects with auth headers and sends session.update', async () => {
    const sockets: FakeSocket[] = [];
    const events: RealtimeBridgeEvent[] = [];
    const bridge = new OpenAIRealtimeBridge(
      { apiKey: 'k', wsImpl: makeFakeWs(sockets), onEvent: (e) => events.push(e) },
    );
    const p = bridge.connect();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toContain('wss://api.openai.com/v1/realtime');
    expect(sockets[0].url).toContain('model=');
    const headers = (sockets[0].opts as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer k');
    expect(headers['OpenAI-Beta']).toBe('realtime=v1');
    sockets[0].onopen?.({});
    await p;
    const update = JSON.parse(sockets[0].sent[0]) as { type: string; session: Record<string, unknown> };
    expect(update.type).toBe('session.update');
    expect(update.session.input_audio_format).toBe('pcm16');
    expect(update.session.output_audio_format).toBe('pcm16');
    expect(update.session.turn_detection).toEqual({ type: 'server_vad' });
    expect(bridge.connected).toBe(true);
  });

  it('appends audio upsampled to 24kHz', async () => {
    const sockets: FakeSocket[] = [];
    const bridge = new OpenAIRealtimeBridge({ apiKey: 'k', wsImpl: makeFakeWs(sockets) });
    const p = bridge.connect();
    sockets[0].onopen?.({});
    await p;
    bridge.appendAudio(synth16k(1600, 0.3));
    const append = JSON.parse(sockets[0].sent[1]) as { type: string; audio: string };
    expect(append.type).toBe('input_audio_buffer.append');
    // 2400 samples × 2 bytes → 4800 bytes → 6400 base64 chars.
    expect(append.audio.length).toBe(6400);
  });

  it('translates OpenAI events into KriyaDot shapes', async () => {
    const sockets: FakeSocket[] = [];
    const events: RealtimeBridgeEvent[] = [];
    const bridge = new OpenAIRealtimeBridge(
      { apiKey: 'k', wsImpl: makeFakeWs(sockets), onEvent: (e) => events.push(e) },
    );
    const p = bridge.connect();
    sockets[0].onopen?.({});
    await p;
    const sock = sockets[0];
    const emit = (msg: unknown) => sock.onmessage?.({ data: JSON.stringify(msg) });

    emit({ type: 'session.updated' });
    emit({ type: 'input_audio_buffer.speech_started' });
    emit({ type: 'input_audio_buffer.speech_stopped' });
    emit({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'hello bot',
    });
    emit({ type: 'response.audio_transcript.delta', delta: 'hi ' });
    emit({ type: 'response.audio_transcript.delta', delta: 'there' });
    emit({ type: 'response.audio.delta', delta: 'QUJD' });
    emit({ type: 'response.done' });
    emit({ type: 'error', error: { message: 'bad request' } });

    expect(events.map((e) => e.type)).toEqual([
      'session_ready',
      'user_speech_started',
      'user_speech_stopped',
      'user_transcript',
      'assistant_transcript_delta',
      'assistant_transcript_delta',
      'assistant_audio_delta',
      'assistant_turn_done',
      'error',
    ]);
    const audio = events[6] as { pcm16Base64: string; sampleRate: number };
    expect(audio.pcm16Base64).toBe('QUJD');
    expect(audio.sampleRate).toBe(REALTIME_SAMPLE_RATE);
    const done = events[7] as { transcript: string };
    expect(done.transcript).toBe('hi there');
    const err = events[8] as { detail: string };
    expect(err.detail).toBe('bad request');
  });

  it('cancelResponse sends response.cancel; close tears down', async () => {
    const sockets: FakeSocket[] = [];
    const bridge = new OpenAIRealtimeBridge({ apiKey: 'k', wsImpl: makeFakeWs(sockets) });
    const p = bridge.connect();
    sockets[0].onopen?.({});
    await p;
    bridge.cancelResponse();
    expect(JSON.parse(sockets[0].sent[1]).type).toBe('response.cancel');
    bridge.close();
    expect(bridge.connected).toBe(false);
  });

  it('rejects on connect timeout', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const bridge = new OpenAIRealtimeBridge({ apiKey: 'k', wsImpl: makeFakeWs(sockets) });
    const p = bridge.connect();
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(16000);
    await assertion;
    vi.useRealTimers();
  });
});
