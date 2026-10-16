// SPDX-License-Identifier: Apache-2.0
// Native realtime (speech-to-speech) call client (OpenMausBot parity).
//
// Drives the server's /api/voice/realtime session over the full-duplex
// WebSocket (see apps/api/src/voice-realtime-routes.ts). Pure orchestration
// over injectable sockets — the CallPanel owns mic capture (getUserMedia +
// echoCancellation) and feeds PCM16 chunks via sendPcm16().
//
// Two audio flavors arrive from the server:
//   - chunked engine: sentence WAV/MP3 blobs → RealtimeAudioPlayer decodes
//     and schedules them gaplessly; barge_in stops everything instantly.
//   - openai-realtime passthrough: raw PCM16 @24kHz → played directly.

import { ensureApiReady, getApiBase } from './api';
import type { SocketFactory, VoiceCallSocket } from './voice-call-client';

export interface RealtimeEngineInfo {
  id: 'chunked' | 'openai-realtime';
  label: string;
  path: string;
  available: boolean;
  hint?: string;
}

export interface RealtimeUsage {
  sttSec: number;
  ttsChars: number;
  llmChars: number;
  audioSec: number;
  usdApprox: number;
}

export type RealtimeClientEvent =
  | { type: 'connected'; engine: string; path: string; sampleRate: number; maxCallMs: number }
  | { type: 'speech_started'; bargeIn?: boolean }
  | { type: 'speech_stopped' }
  | { type: 'transcript'; text: string }
  | { type: 'reply_delta'; text: string }
  | {
      type: 'audio';
      seq?: number;
      turnId?: string;
      data: string;
      mimeType?: string;
      pcm16?: boolean;
      sampleRate?: number;
      sentence?: string;
    }
  | { type: 'barge_in' }
  | { type: 'latency'; ms: number }
  | { type: 'usage'; usage: RealtimeUsage }
  | { type: 'approval_required'; approvalId: string; tool?: string }
  | { type: 'turn_done'; latencyMs?: number | null; skipped?: boolean; failed?: boolean }
  | { type: 'error'; detail: string }
  | { type: 'ended'; reason?: string };

function wsBase(): string {
  const api = getApiBase();
  if (api) return api.replace(/^http/, 'ws');
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${window.location.host}`;
  }
  return 'ws://127.0.0.1:4567';
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const { authedFetch } = await import('./api');
  const res = await authedFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      // ignore
    }
    throw new Error(`realtime call API ${res.status}: ${detail || res.statusText}`);
  }
  return (await res.json()) as T;
}

export async function getRealtimeEngines(): Promise<RealtimeEngineInfo[]> {
  const { authedFetch } = await import('./api');
  const res = await authedFetch('/api/voice/realtime/engines');
  if (!res.ok) throw new Error(`realtime engines: HTTP ${res.status}`);
  const body = (await res.json()) as { engines: RealtimeEngineInfo[] };
  return body.engines;
}

// ---------------------------------------------------------------------------
// Pure audio helpers (unit-tested; no DOM).
// ---------------------------------------------------------------------------

/** Float32 [-1,1] → PCM16. */
export function floatToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    out[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
  }
  return out;
}

/**
 * Downsample Float32 audio to `targetRate` by averaging decimation.
 * Used to bring 48kHz mic audio down to the 16kHz the server expects.
 */
export function downsampleToRate(input: Float32Array, inputRate: number, targetRate: number): Float32Array {
  if (inputRate <= targetRate || input.length === 0) return input;
  const ratio = inputRate / targetRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

/** PCM16 → base64 (chunked to avoid stack blowups on large buffers). */
export function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  if (typeof btoa === 'function') return btoa(bin);
  return Buffer.from(bin, 'binary').toString('base64');
}

/** base64 → PCM16. */
export function base64ToPcm16(b64: string): Int16Array {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

// ---------------------------------------------------------------------------
// Audio player: gapless scheduled playback with instant barge-in stop.
// ---------------------------------------------------------------------------

export interface AudioBufferLike {
  readonly sampleRate: number;
  readonly length: number;
  readonly duration: number;
  getChannelData(channel: number): Float32Array;
}

export interface AudioBufferSourceLike {
  buffer: AudioBufferLike | null;
  onended: (() => void) | null;
  connect(dest: unknown): void;
  start(when?: number): void;
  stop(): void;
}

export interface AudioContextLike {
  readonly sampleRate: number;
  readonly currentTime: number;
  readonly destination: unknown;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioBufferSourceLike;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>;
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ab = new ArrayBuffer(bytes.length);
  new Uint8Array(ab).set(bytes);
  return ab;
}

/**
 * Gapless player for realtime call audio. Chunks are scheduled back to
 * back; stopAll() halts every scheduled source immediately (barge-in).
 */
export class RealtimeAudioPlayer {
  private readonly ctx: AudioContextLike;
  private readonly sources = new Set<AudioBufferSourceLike>();
  private nextTime = 0;
  /** Turn whose audio is currently valid; stale turns are dropped. */
  private activeTurnId: string | null = null;

  constructor(ctx: AudioContextLike) {
    this.ctx = ctx;
  }

  private schedule(buf: AudioBufferLike, turnId?: string): void {
    if (turnId !== undefined) this.activeTurnId = turnId;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const when = Math.max(this.ctx.currentTime, this.nextTime);
    this.nextTime = when + buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
    try {
      src.start(when);
    } catch {
      this.sources.delete(src);
    }
  }

  /** Chunked engine: decode a sentence WAV/MP3 blob and schedule it. */
  async playEncoded(dataB64: string, turnId?: string): Promise<void> {
    if (turnId !== undefined && this.activeTurnId !== null && turnId !== this.activeTurnId) return;
    try {
      const buf = await this.ctx.decodeAudioData(base64ToArrayBuffer(dataB64));
      this.schedule(buf, turnId);
    } catch {
      // decode failure shouldn't kill the call
    }
  }

  /** Passthrough engine: schedule raw PCM16 directly. */
  playPcm16(dataB64: string, sampleRate: number, turnId?: string): void {
    if (turnId !== undefined && this.activeTurnId !== null && turnId !== this.activeTurnId) return;
    const pcm = base64ToPcm16(dataB64);
    if (pcm.length === 0) return;
    const buf = this.ctx.createBuffer(1, pcm.length, sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    this.schedule(buf, turnId);
  }

  /** Barge-in / teardown: stop every scheduled source now. */
  stopAll(): void {
    for (const src of this.sources) {
      try {
        src.stop();
      } catch {
        // ignore
      }
    }
    this.sources.clear();
    this.nextTime = 0;
    this.activeTurnId = null;
  }

  get playing(): boolean {
    return this.sources.size > 0;
  }
}

// ---------------------------------------------------------------------------
// Socket orchestration.
// ---------------------------------------------------------------------------

export class RealtimeCallClient {
  private socket: VoiceCallSocket | null = null;
  private readonly onEvent: (e: RealtimeClientEvent) => void;
  private readonly socketFactory: SocketFactory;
  private callId: string | null = null;
  private ended = false;

  constructor(onEvent: (e: RealtimeClientEvent) => void, socketFactory?: SocketFactory) {
    this.onEvent = onEvent;
    this.socketFactory =
      socketFactory ??
      ((url) => {
        const ws = new WebSocket(url);
        let msgHandler: ((ev: { data: unknown }) => void) | null = null;
        let closeHandler: (() => void) | null = null;
        let errHandler: (() => void) | null = null;
        ws.onmessage = (ev) => msgHandler?.({ data: ev.data });
        ws.onclose = () => closeHandler?.();
        ws.onerror = () => errHandler?.();
        const sock: VoiceCallSocket = {
          send: (d) => ws.send(d),
          close: () => ws.close(),
          onmessage: null,
          onclose: null,
          onerror: null,
        };
        Object.defineProperties(sock, {
          onmessage: { get: () => msgHandler, set: (h) => { msgHandler = h; }, enumerable: true },
          onclose: { get: () => closeHandler, set: (h) => { closeHandler = h; }, enumerable: true },
          onerror: { get: () => errHandler, set: (h) => { errHandler = h; }, enumerable: true },
        });
        return sock;
      });
  }

  get activeCallId(): string | null {
    return this.callId;
  }

  /** Start the REST session and connect the full-duplex socket. */
  async start(
    botId: string,
    opts: { engine?: string; sttProvider?: string; ttsProvider?: string } = {},
  ): Promise<void> {
    if (this.callId) throw new Error('call already in progress');
    const session = await postJson<{
      callId: string;
      wsPath: string;
      engine: string;
      path: string;
      sampleRate: number;
    }>('/api/voice/realtime/calls', { botId, ...opts });
    this.callId = session.callId;
    const token = await ensureApiReady();
    const sep = session.wsPath.includes('?') ? '&' : '?';
    await this.connect(`${wsBase()}${session.wsPath}${sep}token=${encodeURIComponent(token)}`);
  }

  private connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = this.socketFactory(url);
      this.socket = socket;
      const timer = setTimeout(() => reject(new Error('realtime call: socket connect timed out')), 10000);
      socket.onmessage = (ev) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
        } catch {
          return;
        }
        this.handleFrame(frame, resolve, timer);
      };
      socket.onerror = () => {
        clearTimeout(timer);
        this.onEvent({ type: 'error', detail: 'realtime call socket error' });
        reject(new Error('realtime call: socket error'));
      };
      socket.onclose = () => {
        clearTimeout(timer);
        if (!this.ended) this.onEvent({ type: 'ended' });
      };
    });
  }

  private handleFrame(
    frame: Record<string, unknown>,
    resolveConnect: () => void,
    timer: ReturnType<typeof setTimeout>,
  ): void {
    switch (frame.t) {
      case 'realtime_started':
        clearTimeout(timer);
        this.onEvent({
          type: 'connected',
          engine: String(frame.engine ?? ''),
          path: String(frame.path ?? ''),
          sampleRate: Number(frame.sampleRate ?? 16000),
          maxCallMs: Number(frame.maxCallMs ?? 0),
        });
        resolveConnect();
        break;
      case 'speech_started':
        this.onEvent({ type: 'speech_started', bargeIn: frame.bargeIn === true });
        break;
      case 'speech_stopped':
        this.onEvent({ type: 'speech_stopped' });
        break;
      case 'transcript':
        this.onEvent({ type: 'transcript', text: String(frame.text ?? '') });
        break;
      case 'reply_delta':
        this.onEvent({ type: 'reply_delta', text: String(frame.text ?? '') });
        break;
      case 'audio':
        this.onEvent({
          type: 'audio',
          seq: typeof frame.seq === 'number' ? frame.seq : undefined,
          turnId: typeof frame.turnId === 'string' ? frame.turnId : undefined,
          data: String(frame.data ?? ''),
          mimeType: typeof frame.mimeType === 'string' ? frame.mimeType : undefined,
          pcm16: frame.pcm16 === true,
          sampleRate: typeof frame.sampleRate === 'number' ? frame.sampleRate : undefined,
          sentence: typeof frame.sentence === 'string' ? frame.sentence : undefined,
        });
        break;
      case 'barge_in':
        this.onEvent({ type: 'barge_in' });
        break;
      case 'latency':
        this.onEvent({ type: 'latency', ms: Number(frame.ms ?? 0) });
        break;
      case 'usage':
        this.onEvent({
          type: 'usage',
          usage: {
            sttSec: Number(frame.sttSec ?? 0),
            ttsChars: Number(frame.ttsChars ?? 0),
            llmChars: Number(frame.llmChars ?? 0),
            audioSec: Number(frame.audioSec ?? 0),
            usdApprox: Number(frame.usdApprox ?? 0),
          },
        });
        break;
      case 'approval_required':
        this.onEvent({
          type: 'approval_required',
          approvalId: String(frame.approvalId ?? ''),
          tool: typeof frame.tool === 'string' ? frame.tool : undefined,
        });
        break;
      case 'turn_done':
        this.onEvent({
          type: 'turn_done',
          latencyMs: typeof frame.latencyMs === 'number' ? frame.latencyMs : null,
          skipped: frame.skipped === true,
          failed: frame.failed === true,
        });
        break;
      case 'call_ended':
        this.finish(String(frame.reason ?? ''));
        break;
      case 'error':
        this.onEvent({ type: 'error', detail: String(frame.detail ?? 'unknown error') });
        break;
      default:
        break;
    }
  }

  /** Stream one PCM16 chunk (16kHz mono) to the server. */
  sendPcm16(pcm: Int16Array): void {
    if (!this.socket || !this.callId) throw new Error('no active call');
    this.socket.send(JSON.stringify({ t: 'audio', data: pcm16ToBase64(pcm) }));
  }

  /** End the call: notify the server, then close the socket. */
  async end(): Promise<void> {
    const callId = this.callId;
    this.finish('');
    if (callId) {
      try {
        await postJson(`/api/voice/realtime/calls/${encodeURIComponent(callId)}/end`, {});
      } catch {
        // best effort — the socket close ends the server session anyway
      }
    }
  }

  private finish(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.callId = null;
    try {
      this.socket?.send(JSON.stringify({ t: 'end' }));
    } catch {
      // ignore
    }
    try {
      this.socket?.close();
    } catch {
      // ignore
    }
    this.socket = null;
    this.onEvent({ type: 'ended', reason });
  }
}
