// SPDX-License-Identifier: Apache-2.0
// Realtime (speech-to-speech) voice-call routes (OpenMausBot parity P0 #9).
//
// REST (mounted at /api/voice/realtime by routes.ts):
//   GET  /engines → [{id,label,path,available,hint}]
//   POST /calls {botId, engine?, sttProvider?, ttsProvider?}
//        → 201 {callId, wsPath, engine, path, sampleRate}
//   GET  /calls/:id → call summary (usage + turns, no audio)
//   POST /calls/:id/end → { ok: true }
//
// WebSocket: GET /api/voice/realtime/ws?callId=… (upgrade, handled in
// index.ts's upgrade switch — same minimal text-frame socket as the
// sequential voice calls).
//
// Wire protocol (JSON text frames):
//   client → server: {t:'audio', data: base64 PCM16 16kHz mono} | {t:'end'}
//   server → client: {t:'realtime_started', callId, engine, path, sampleRate, maxCallMs}
//     | {t:'speech_started'} | {t:'speech_stopped'}
//     | {t:'transcript', text}            (finalized user utterance)
//     | {t:'reply_delta', text}           (passthrough engine only)
//     | {t:'audio', seq?, data, mimeType?}            (chunked: sentence WAV/MP3)
//     | {t:'audio', pcm16:true, sampleRate, data}     (passthrough: raw PCM16)
//     | {t:'barge_in'}                    (stop playback immediately)
//     | {t:'latency', ms}                 (speech-end → first audio)
//     | {t:'usage', sttSec, ttsChars, llmChars, audioSec, usdApprox}
//     | {t:'approval_required', approvalId, tool}
//     | {t:'turn_done'} | {t:'error', detail} | {t:'call_ended', reason?}
//
// Auth: loopback token in the query string, same as /api/voice/calls/ws.
// No key material ever crosses this socket.

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { acceptRawWsSocket } from './computer-view.js';
import { validateWsQueryToken } from './loopback-auth.js';
import {
  REALTIME_MAX_FRAME_B64,
  REALTIME_SAMPLE_RATE,
  RealtimeVoiceService,
} from './voice-realtime.js';
import { REALTIME_SAMPLE_RATE as OPENAI_REALTIME_SAMPLE_RATE } from '@mvp/voice';

export const REALTIME_WS_PATH = '/api/voice/realtime/ws';

export interface RealtimeRouteDeps {
  service: RealtimeVoiceService;
}

export interface RealtimeUpgradeDeps extends RealtimeRouteDeps {
  /** Per-boot loopback bearer token (index.ts). */
  loopbackToken: string;
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function errStatus(err: unknown): number {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' && s >= 400 && s < 600 ? s : 500;
}

export function createRealtimeVoiceRouter(deps: RealtimeRouteDeps): Router {
  const { service } = deps;
  const router = Router();

  router.get('/engines', (_req: Request, res: Response) => {
    res.json({ engines: service.listEngines() });
  });

  router.post('/calls', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as {
        botId?: unknown;
        engine?: unknown;
        sttProvider?: unknown;
        ttsProvider?: unknown;
      };
      if (typeof body.botId !== 'string' || !body.botId.trim()) {
        res.status(400).json({ error: '"botId" is required' });
        return;
      }
      const { call } = await service.startRealtimeCall({
        botId: body.botId.trim(),
        engine: body.engine as string | undefined,
        sttProvider: body.sttProvider as string | undefined,
        ttsProvider: body.ttsProvider as string | undefined,
      });
      res.status(201).json({
        callId: call.id,
        botId: call.botId,
        botName: call.botName,
        engine: call.engine,
        path: call.path,
        sampleRate: call.engine === 'openai-realtime' ? OPENAI_REALTIME_SAMPLE_RATE : REALTIME_SAMPLE_RATE,
        wsPath: `${REALTIME_WS_PATH}?callId=${encodeURIComponent(call.id)}`,
      });
    } catch (err) {
      res.status(errStatus(err)).json({ error: errMessage(err, 'failed to start realtime call') });
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

export function createRealtimeVoiceUpgrade(deps: RealtimeUpgradeDeps): {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
} {
  const { service, loopbackToken } = deps;
  return {
    handleUpgrade(req: IncomingMessage, socket: Duplex, _head: Buffer): void {
      // NOTE: req.url carries the credential (?token= / ?ticket=) — never log it.
      const url = new URL(req.url ?? REALTIME_WS_PATH, 'http://localhost');
      const callId = url.searchParams.get('callId') ?? '';

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

      // Auth first: don't leak call-id existence to unauthenticated probers.
      if (!validateWsQueryToken(url.searchParams, loopbackToken)) {
        reject('unauthorized');
        return;
      }

      const call = callId ? service.getCall(callId) : undefined;
      if (!call) {
        reject('unknown_call');
        return;
      }
      if (call.endedAt) {
        reject('call_ended');
        return;
      }

      // Mint a fresh live session per socket (one socket per call).
      // The service record was created at REST start; the live state
      // machine is re-created here so a reconnect gets a clean VAD.
      const live = service.attachLive(call.id);
      if (!live) {
        reject('call_ended');
        return;
      }
      const sock = acceptRawWsSocket(req, socket);
      if (!sock) return;
      const send = (frame: Record<string, unknown>): void => {
        try {
          sock.sendText(JSON.stringify(frame));
        } catch {
          // client gone
        }
      };
      // MEDIUM fix: reject a second client on the same call (call_busy)
      // instead of letting it hijack the frame sender.
      if (!live.attach(send)) {
        reject('call_busy');
        return;
      }

      sock.onMessage((text: string) => {
        let msg: { t?: unknown; data?: unknown };
        try {
          msg = JSON.parse(text) as typeof msg;
        } catch {
          send({ t: 'error', detail: 'malformed frame' });
          return;
        }
        if (msg.t === 'end') {
          live.end('client');
          send({ t: 'call_ended', reason: 'client' });
          sock.close(1000);
          return;
        }
        if (msg.t === 'audio') {
          if (typeof msg.data !== 'string' || msg.data.length === 0) {
            send({ t: 'error', detail: '"data" must be a non-empty base64 string' });
            return;
          }
          if (msg.data.length > REALTIME_MAX_FRAME_B64) {
            send({ t: 'error', detail: 'audio frame too large' });
            return;
          }
          live.feedAudioChunk(msg.data);
          return;
        }
        send({ t: 'error', detail: `unknown frame type "${String(msg.t)}"` });
      });
      sock.onClose(() => {
        live.detach();
        live.end('socket_close');
      });
    },
  };
}
