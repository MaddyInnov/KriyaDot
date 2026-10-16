// SPDX-License-Identifier: Apache-2.0
// Voice-call REST routes + WebSocket upgrade (Codync parity: realtime
// voice calls).
//
// REST (mounted at /api/voice by index.ts):
//   GET  /call-providers → { providers: [{id,label,configured,hint}] }
//   POST /calls {botId, sttProvider?, ttsProvider?} → 201 {callId, wsPath, …}
//   GET  /calls/:id → call summary (turns, no audio)
//   POST /calls/:id/end → { ok: true }
//
// WebSocket: GET /api/voice/calls/ws?callId=… (upgrade, handled in
// index.ts's upgrade switch — same minimal text-frame socket as the
// computer view / remote screen).
//
// Wire protocol (JSON text frames):
//   client → server: {t:'utterance', audio: base64, mimeType?} | {t:'end'}
//   server → client: {t:'call_started',…} | {t:'transcript', text}
//     | {t:'reply', text} | {t:'audio', data, mimeType}
//     | {t:'approval_required', approvalId, tool}
//     | {t:'turn_done'} | {t:'error', detail} | {t:'call_ended'}
//
// Auth: the local API trust model applies (same as /api/voice/stt|tts —
// the Tauri webview and LAN clients call the sidecar directly). No key
// material ever crosses this socket.

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { acceptRawWsSocket } from './computer-view.js';
import { VoiceCallService } from './voice-call.js';

export const VOICE_CALL_WS_PATH = '/api/voice/calls/ws';

export interface VoiceCallRouteDeps {
  service: VoiceCallService;
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function errStatus(err: unknown): number {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' && s >= 400 && s < 600 ? s : 500;
}

export function createVoiceCallRouter(deps: VoiceCallRouteDeps): Router {
  const { service } = deps;
  const router = Router();

  router.get('/call-providers', (_req: Request, res: Response) => {
    res.json({ providers: service.listProviders() });
  });

  router.post('/calls', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { botId?: unknown; sttProvider?: unknown; ttsProvider?: unknown };
      if (typeof body.botId !== 'string' || !body.botId.trim()) {
        res.status(400).json({ error: '"botId" is required' });
        return;
      }
      const call = service.startCall({
        botId: body.botId.trim(),
        sttProvider: body.sttProvider as string | undefined,
        ttsProvider: body.ttsProvider as string | undefined,
      });
      res.status(201).json({
        callId: call.id,
        botId: call.botId,
        botName: call.botName,
        stt: call.stt,
        tts: call.tts,
        wsPath: `${VOICE_CALL_WS_PATH}?callId=${encodeURIComponent(call.id)}`,
      });
    } catch (err) {
      res.status(errStatus(err)).json({ error: errMessage(err, 'failed to start call') });
    }
  });

  router.get('/calls/:id', (req: Request, res: Response) => {
    const call = service.getCall(req.params.id);
    if (!call) {
      res.status(404).json({ error: 'unknown call' });
      return;
    }
    res.json(service.summarize(call));
  });

  router.post('/calls/:id/end', (req: Request, res: Response) => {
    const ok = service.endCall(req.params.id);
    res.json({ ok });
  });

  return router;
}

/** Wire a single utterance through the service and fan the result out as frames. */
export async function handleVoiceUtterance(
  service: VoiceCallService,
  callId: string,
  audio: Uint8Array,
  mimeType: string,
  send: (frame: Record<string, unknown>) => void,
): Promise<void> {
  let result;
  try {
    result = await service.processUtterance(callId, audio, mimeType);
  } catch (err) {
    send({ t: 'error', detail: errStatus(err) >= 500 ? 'utterance failed' : errMessage(err, 'utterance failed') });
    return;
  }
  if (result.skipped) {
    send({ t: 'turn_done', skipped: true });
    return;
  }
  send({ t: 'transcript', text: result.transcript });
  if (result.approvalId) {
    send({ t: 'approval_required', approvalId: result.approvalId });
  }
  send({ t: 'reply', text: result.replyText });
  send({ t: 'audio', data: result.audioBase64, mimeType: result.mimeType });
  send({ t: 'turn_done' });
}

export function createVoiceCallUpgrade(deps: VoiceCallRouteDeps): {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
} {
  const { service } = deps;
  return {
    handleUpgrade(req: IncomingMessage, socket: Duplex, _head: Buffer): void {
      const url = new URL(req.url ?? VOICE_CALL_WS_PATH, 'http://localhost');
      const callId = url.searchParams.get('callId') ?? '';
      const call = callId ? service.getCall(callId) : undefined;

      const reject = (detail: string): void => {
        const sock = acceptRawWsSocket(req, socket);
        if (sock) {
          try {
            sock.sendText(JSON.stringify({ t: 'error', detail }));
            sock.close(4401);
          } catch {
            // ignore
          }
        }
      };

      if (!call) {
        reject('unknown_call');
        return;
      }
      if (call.endedAt) {
        reject('call_ended');
        return;
      }
      const sock = acceptRawWsSocket(req, socket);
      if (!sock) return;
      const send = (frame: Record<string, unknown>): void => {
        try {
          sock.sendText(JSON.stringify(frame));
        } catch {
          // client gone; the turn still completes server-side
        }
      };
      let busy = false;
      send({
        t: 'call_started',
        callId: call.id,
        botId: call.botId,
        botName: call.botName,
        stt: call.stt,
        tts: call.tts,
      });
      sock.onMessage((text: string) => {
        let msg: { t?: unknown; audio?: unknown; mimeType?: unknown };
        try {
          msg = JSON.parse(text) as typeof msg;
        } catch {
          send({ t: 'error', detail: 'malformed frame' });
          return;
        }
        if (msg.t === 'end') {
          service.endCall(call.id);
          send({ t: 'call_ended' });
          sock.close(1000);
          return;
        }
        if (msg.t === 'utterance') {
          if (busy) {
            send({ t: 'error', detail: 'turn already in progress' });
            return;
          }
          if (typeof msg.audio !== 'string' || msg.audio.length === 0) {
            send({ t: 'error', detail: '"audio" must be a non-empty base64 string' });
            return;
          }
          let bytes: Uint8Array;
          try {
            bytes = new Uint8Array(Buffer.from(msg.audio, 'base64'));
          } catch {
            send({ t: 'error', detail: 'invalid base64 audio' });
            return;
          }
          if (bytes.length === 0) {
            send({ t: 'error', detail: 'audio decoded to zero bytes' });
            return;
          }
          busy = true;
          const mimeType = typeof msg.mimeType === 'string' && msg.mimeType ? msg.mimeType : 'audio/webm';
          void handleVoiceUtterance(service, call.id, bytes, mimeType, send).finally(() => {
            busy = false;
          });
          return;
        }
        send({ t: 'error', detail: `unknown frame type "${String(msg.t)}"` });
      });
      sock.onClose(() => {
        service.endCall(call.id);
      });
    },
  };
}
