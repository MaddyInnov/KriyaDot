// SPDX-License-Identifier: Apache-2.0
// Realtime voice-call client: drives the server's /api/voice/calls session
// over the utterance WebSocket (see apps/api/src/voice-call-routes.ts).
//
// Pure orchestration over an injectable WebSocket factory — no DOM, no
// MediaRecorder here, so it unit-tests with a fake socket. The CallPanel
// component owns mic capture + audio playback and calls into this.

import { authedFetch, ensureApiReady, getApiBase } from './api';

export interface VoiceCallProviderInfo {
  id: 'mock' | 'groq' | 'openai';
  label: string;
  configured: boolean;
  hint?: string;
}

export interface VoiceCallTurn {
  id: string;
  at: number;
  transcript: string;
  replyText: string;
  approvalId?: string;
}

export type CallClientEvent =
  | { type: 'connected'; stt: string; tts: string }
  | { type: 'transcript'; text: string }
  | { type: 'reply'; text: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'approval_required'; approvalId: string }
  | { type: 'turn_done'; skipped: boolean }
  | { type: 'error'; detail: string }
  | { type: 'ended' };

export interface VoiceCallSocket {
  send(data: string): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export type SocketFactory = (url: string) => VoiceCallSocket;

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
    throw new Error(`voice call API ${res.status}: ${detail || res.statusText}`);
  }
  return (await res.json()) as T;
}

export async function getVoiceCallProviders(): Promise<VoiceCallProviderInfo[]> {
  const res = await authedFetch('/api/voice/call-providers');
  if (!res.ok) throw new Error(`voice call providers: HTTP ${res.status}`);
  const body = (await res.json()) as { providers: VoiceCallProviderInfo[] };
  return body.providers;
}

let turnSeq = 0;

/**
 * A live voice call: REST session + utterance WebSocket. Events fan out to
 * `onEvent`; the panel renders them and plays audio frames.
 */
export class VoiceCallClient {
  private socket: VoiceCallSocket | null = null;
  private readonly onEvent: (e: CallClientEvent) => void;
  private readonly socketFactory: SocketFactory;
  private callId: string | null = null;
  private turnBuffer: { transcript: string; reply: string; approvalId?: string } | null = null;
  private ended = false;

  constructor(onEvent: (e: CallClientEvent) => void, socketFactory?: SocketFactory) {
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

  /** Start the REST session and connect the utterance socket. */
  async start(botId: string, opts: { sttProvider?: string; ttsProvider?: string } = {}): Promise<void> {
    if (this.callId) throw new Error('call already in progress');
    const session = await postJson<{
      callId: string;
      wsPath: string;
      stt: string;
      tts: string;
    }>('/api/voice/calls', { botId, ...opts });
    this.callId = session.callId;
    // Browsers cannot send headers on a WebSocket upgrade, so the bootstrap
    // token rides as a `token` query param (the server must accept it there).
    const token = await ensureApiReady();
    const sep = session.wsPath.includes('?') ? '&' : '?';
    await this.connect(`${wsBase()}${session.wsPath}${sep}token=${encodeURIComponent(token)}`, session);
  }

  private connect(url: string, session: { stt: string; tts: string }): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = this.socketFactory(url);
      this.socket = socket;
      const timer = setTimeout(() => reject(new Error('voice call: socket connect timed out')), 10000);
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
        this.onEvent({ type: 'error', detail: 'voice call socket error' });
        reject(new Error('voice call: socket error'));
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
      case 'call_started':
        clearTimeout(timer);
        this.onEvent({ type: 'connected', stt: String(frame.stt ?? ''), tts: String(frame.tts ?? '') });
        resolveConnect();
        break;
      case 'transcript':
        this.turnBuffer = { transcript: String(frame.text ?? ''), reply: '' };
        this.onEvent({ type: 'transcript', text: String(frame.text ?? '') });
        break;
      case 'reply':
        if (this.turnBuffer) this.turnBuffer.reply = String(frame.text ?? '');
        this.onEvent({ type: 'reply', text: String(frame.text ?? '') });
        break;
      case 'audio':
        this.onEvent({ type: 'audio', data: String(frame.data ?? ''), mimeType: String(frame.mimeType ?? 'audio/wav') });
        break;
      case 'approval_required':
        if (this.turnBuffer) this.turnBuffer.approvalId = String(frame.approvalId ?? '');
        this.onEvent({ type: 'approval_required', approvalId: String(frame.approvalId ?? '') });
        break;
      case 'turn_done': {
        const buf = this.turnBuffer;
        this.turnBuffer = null;
        this.onEvent({ type: 'turn_done', skipped: Boolean(frame.skipped) || !buf?.transcript });
        break;
      }
      case 'call_ended':
        this.finish();
        break;
      case 'error':
        this.onEvent({ type: 'error', detail: String(frame.detail ?? 'unknown error') });
        break;
      default:
        break;
    }
  }

  /** Send one complete utterance (base64 audio) for the server turn loop. */
  sendUtterance(audioBase64: string, mimeType = 'audio/webm'): void {
    if (!this.socket || !this.callId) throw new Error('no active call');
    this.turnBuffer = null;
    this.socket.send(JSON.stringify({ t: 'utterance', audio: audioBase64, mimeType }));
  }

  /** End the call: notify the server, then close the socket. */
  async end(): Promise<void> {
    const callId = this.callId;
    this.finish();
    if (callId) {
      try {
        await postJson(`/api/voice/calls/${encodeURIComponent(callId)}/end`, {});
      } catch {
        // best effort — the socket close ends the server session anyway
      }
    }
  }

  private finish(): void {
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
    this.onEvent({ type: 'ended' });
  }

  /** Next turn id for transcript bookkeeping (panel-side). */
  static nextTurnId(): string {
    return `wct_${Date.now().toString(36)}_${turnSeq++}`;
  }
}
