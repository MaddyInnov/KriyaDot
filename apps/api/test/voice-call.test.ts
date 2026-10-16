// SPDX-License-Identifier: Apache-2.0
// Realtime voice-call tests: service lifecycle, provider resolution, the
// utterance turn loop, REST routes, and the WebSocket frame protocol.
//
// Zero paid usage: all providers are the zero-cost mocks; the bot turn is
// an injected fake. No test may reach api.groq.com / api.openai.com.

import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BotConfig } from '@mvp/agent-runtime';
import {
  VoiceCallService,
  isVoiceProviderConfigured,
  listVoiceCallProviders,
  resolveVoiceApiKey,
  MAX_UTTERANCE_BYTES,
} from '../src/voice-call.js';
import { createVoiceCallRouter, createVoiceCallUpgrade, MAX_UTTERANCE_B64 } from '../src/voice-call-routes.js';
import { validateVoiceSettings } from '../src/bot-roster-routes.js';

const bot = (over: Partial<BotConfig> = {}): BotConfig =>
  ({
    id: 'bot_voice',
    name: 'Voice Bot',
    description: 'test bot',
    systemPrompt: 'You are a test bot.',
    provider: 'groq',
    model: 'test-model',
    skills: [],
    tools: [],
    mcpServers: [],
    ...over,
  }) as BotConfig;

function makeService(opts: {
  bots?: BotConfig[];
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  brain?: (transcript: string) => string;
  approvals?: string[];
} = {}) {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'voice-call-test-'));
  const brain = opts.brain ?? ((t: string) => `echo: ${t}`);
  const svc = new VoiceCallService({
    dataDir,
    env: opts.env ?? {},
    findBot: (id) => (opts.bots ?? [bot()]).find((b) => b.id === id),
    runBotTurn: async ({ message, onText, onApproval }) => {
      onText(brain(message));
      for (const a of opts.approvals ?? []) onApproval(a, 'write_file');
    },
    audit: () => {},
  });
  return { svc, dataDir };
}

describe('resolveVoiceApiKey / provider configuration', () => {
  it('mock is always configured', () => {
    const { dataDir } = makeService();
    expect(isVoiceProviderConfigured('mock', dataDir, {})).toBe(true);
  });

  it('groq/openai are unconfigured without keys', () => {
    const { dataDir } = makeService();
    expect(isVoiceProviderConfigured('groq', dataDir, {})).toBe(false);
    expect(isVoiceProviderConfigured('openai', dataDir, {})).toBe(false);
  });

  it('resolves keys from env', () => {
    const { dataDir } = makeService();
    expect(resolveVoiceApiKey('groq', dataDir, { GROQ_API_KEY: 'gsk-x' })).toBe('gsk-x');
    expect(resolveVoiceApiKey('openai', dataDir, { OPENAI_API_KEY: 'sk-x' })).toBe('sk-x');
  });

  it('listVoiceCallProviders reports configured flags with hints', () => {
    const { dataDir } = makeService();
    const list = listVoiceCallProviders(dataDir, { GROQ_API_KEY: 'gsk-x' });
    const groq = list.find((p) => p.id === 'groq');
    const openai = list.find((p) => p.id === 'openai');
    const mock = list.find((p) => p.id === 'mock');
    expect(mock?.configured).toBe(true);
    expect(groq?.configured).toBe(true);
    expect(groq?.hint).toBeUndefined();
    expect(openai?.configured).toBe(false);
    expect(openai?.hint).toContain('OPENAI_API_KEY');
  });
});

describe('VoiceCallService lifecycle', () => {
  it('starts a call with mock providers by default', () => {
    const { svc } = makeService();
    const call = svc.startCall({ botId: 'bot_voice' });
    expect(call.id).toMatch(/^vcall_/);
    expect(call.stt).toBe('mock');
    expect(call.tts).toBe('mock');
    expect(call.botId).toBe('bot_voice');
    expect(call.turns).toEqual([]);
  });

  it('honours per-bot voice settings', () => {
    const { svc } = makeService({
      bots: [bot({ voice: { sttProvider: 'mock', ttsProvider: 'mock', ttsVoice: 'alloy', autoVad: true, vadSensitivity: 7 } })],
      env: { GROQ_API_KEY: 'gsk-x' },
    });
    const call = svc.startCall({ botId: 'bot_voice' });
    expect(call.stt).toBe('mock');
    expect(call.tts).toBe('mock');
  });

  it('rejects unknown bots with 404', () => {
    const { svc } = makeService();
    expect(() => svc.startCall({ botId: 'nope' })).toThrowError(expect.objectContaining({ status: 404 }));
  });

  it('rejects unknown provider ids', () => {
    const { svc } = makeService();
    expect(() => svc.startCall({ botId: 'bot_voice', sttProvider: 'elevenlabs' })).toThrow(/unknown voice provider/);
  });

  it('rejects key-gated providers with no key (400, no session)', () => {
    const { svc } = makeService();
    expect(() => svc.startCall({ botId: 'bot_voice', sttProvider: 'groq' })).toThrowError(
      expect.objectContaining({ status: 400 }),
    );
    expect(svc.getCall('anything')).toBeUndefined();
  });

  it('ends calls idempotently', () => {
    const { svc } = makeService();
    const call = svc.startCall({ botId: 'bot_voice' });
    expect(svc.endCall(call.id)).toBe(true);
    expect(svc.endCall(call.id)).toBe(false);
    expect(svc.endCall('nope')).toBe(false);
  });
});

describe('VoiceCallService.processUtterance', () => {
  it('runs STT → brain → TTS and records the turn', async () => {
    const { svc } = makeService();
    const call = svc.startCall({ botId: 'bot_voice' });
    const res = await svc.processUtterance(call.id, new Uint8Array([1, 2, 3, 4, 5]));
    expect(res.skipped).toBe(false);
    expect(res.transcript).toContain('hello from the mock microphone');
    expect(res.replyText).toContain('echo:');
    expect(res.audioBase64.length).toBeGreaterThan(0);
    expect(res.mimeType).toBe('audio/wav');
    expect(svc.getCall(call.id)?.turns).toHaveLength(1);
  });

  it('relays approval events from the bot turn', async () => {
    const { svc } = makeService({ approvals: ['appr_1'] });
    const call = svc.startCall({ botId: 'bot_voice' });
    const res = await svc.processUtterance(call.id, new Uint8Array([9, 9, 9]));
    expect(res.approvalId).toBe('appr_1');
    expect(res.skipped).toBe(false);
  });

  it('rejects unknown calls (404), ended calls (410), empty and oversized audio', async () => {
    const { svc } = makeService();
    await expect(svc.processUtterance('nope', new Uint8Array([1]))).rejects.toMatchObject({ status: 404 });
    const call = svc.startCall({ botId: 'bot_voice' });
    svc.endCall(call.id);
    await expect(svc.processUtterance(call.id, new Uint8Array([1]))).rejects.toMatchObject({ status: 410 });
    const call2 = svc.startCall({ botId: 'bot_voice' });
    await expect(svc.processUtterance(call2.id, new Uint8Array(0))).rejects.toMatchObject({ status: 400 });
    await expect(svc.processUtterance(call2.id, new Uint8Array(MAX_UTTERANCE_BYTES + 1))).rejects.toMatchObject({
      status: 413,
    });
  });
});

describe('validateVoiceSettings', () => {
  it('accepts a full valid voice block', () => {
    const { voice, errors } = validateVoiceSettings(
      { sttProvider: 'groq', ttsProvider: 'openai', ttsVoice: 'shimmer', autoVad: true, vadSensitivity: 8 },
      'bots[0].voice',
    );
    expect(errors).toEqual([]);
    expect(voice).toEqual({
      sttProvider: 'groq',
      ttsProvider: 'openai',
      ttsVoice: 'shimmer',
      autoVad: true,
      vadSensitivity: 8,
    });
  });

  it('rejects bad provider ids, voices, and sensitivity ranges', () => {
    const r = validateVoiceSettings(
      { sttProvider: 'elevenlabs', ttsVoice: '', vadSensitivity: 99, autoVad: 'yes' },
      'bots[0].voice',
    );
    expect(r.errors.length).toBeGreaterThanOrEqual(4);
    expect(r.errors.join(' ')).toContain('sttProvider');
  });

  it('rejects non-objects', () => {
    expect(validateVoiceSettings('yes', 'w').errors).toHaveLength(1);
  });
});

describe('voice-call REST routes', () => {
  let server: ReturnType<typeof createServer> | null = null;
  let base = '';

  beforeEach(async () => {
    const { svc } = makeService();
    const app = express();
    app.use(express.json());
    app.use('/api/voice', createVoiceCallRouter({ service: svc }));
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    // closeAllConnections drops lingering WS sockets so close() resolves.
    try {
      (server as unknown as { closeAllConnections?: () => void } | null)?.closeAllConnections?.();
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  it('GET /call-providers lists providers with configured flags', async () => {
    const res = await fetch(`${base}/api/voice/call-providers`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: Array<{ id: string; configured: boolean }> };
    expect(body.providers.map((p) => p.id)).toEqual(['mock', 'groq', 'openai']);
    expect(body.providers.find((p) => p.id === 'mock')?.configured).toBe(true);
  });

  it('POST /calls validates botId and starts a session', async () => {
    const bad = await fetch(`${base}/api/voice/calls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);
    const missing = await fetch(`${base}/api/voice/calls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botId: 'ghost' }),
    });
    expect(missing.status).toBe(404);
    const ok = await fetch(`${base}/api/voice/calls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botId: 'bot_voice' }),
    });
    expect(ok.status).toBe(201);
    const body = (await ok.json()) as { callId: string; wsPath: string; stt: string };
    expect(body.callId).toMatch(/^vcall_/);
    expect(body.wsPath).toContain('/api/voice/calls/ws?callId=');
    expect(body.stt).toBe('mock');

    const summary = await fetch(`${base}/api/voice/calls/${body.callId}`);
    expect(summary.status).toBe(200);
    const end = await fetch(`${base}/api/voice/calls/${body.callId}/end`, { method: 'POST' });
    expect(end.status).toBe(200);
  });
});

describe('voice-call WebSocket protocol', () => {
  let server: ReturnType<typeof createServer> | null = null;
  let base = '';
  const WS_TOKEN = 'test-loopback-token-abc123';

  beforeEach(async () => {
    const { svc } = makeService();
    const upgrade = createVoiceCallUpgrade({ service: svc, loopbackToken: WS_TOKEN });
    const app = express();
    app.use(express.json());
    app.use('/api/voice', createVoiceCallRouter({ service: svc }));
    server = createServer(app);
    server.on('upgrade', (req, socket, head) => {
      const path = req.url?.split('?')[0];
      if (path === '/api/voice/calls/ws') upgrade.handleUpgrade(req, socket, head);
      else socket.destroy();
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    try {
      (server as unknown as { closeAllConnections?: () => void } | null)?.closeAllConnections?.();
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  async function startCall(): Promise<string> {
    const res = await fetch(`${base}/api/voice/calls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botId: 'bot_voice' }),
    });
    const body = (await res.json()) as { callId: string };
    return body.callId;
  }

  function connect(
    callId: string,
    token: string | null = WS_TOKEN,
  ): Promise<{ ws: WebSocket; frames: Array<Record<string, unknown>> }> {
    return new Promise((resolve, reject) => {
      const qs = `callId=${encodeURIComponent(callId)}${token === null ? '' : `&token=${encodeURIComponent(token)}`}`;
      const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/api/voice/calls/ws?${qs}`);
      const frames: Array<Record<string, unknown>> = [];
      const timer = setTimeout(() => reject(new Error('no call_started frame')), 5000);
      ws.onmessage = (ev) => {
        const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
        frames.push(frame);
        if (frame.t === 'call_started') {
          clearTimeout(timer);
          resolve({ ws, frames });
        } else if (frame.t === 'error') {
          // Server rejected the upgrade (unknown call etc.): the socket
          // closes right after — fail fast instead of waiting for timeout.
          clearTimeout(timer);
          setTimeout(() => reject(new Error(`rejected: ${String(frame.detail)}`)), 300);
        }
      };
      ws.onclose = () => {
        clearTimeout(timer);
        reject(new Error('ws closed before call_started'));
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('ws error'));
      };
    });
  }

  function waitFor(
    frames: Array<Record<string, unknown>>,
    t: string,
    timeoutMs = 15000,
    afterIndex = 0,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = () => {
        const found = frames.find((f, i) => i >= afterIndex && f.t === t);
        if (found) {
          resolve(found);
          return;
        }
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`timed out waiting for frame "${t}"`));
          return;
        }
        setTimeout(poll, 25);
      };
      poll();
    });
  }

  it('rejects unknown call ids', async () => {
    await expect(connect('vcall_nope')).rejects.toThrow();
  });

  it('rejects the WS upgrade without a valid ?token= (4401 unauthorized)', async () => {
    const callId = await startCall();
    async function tryConnect(token: string | null): Promise<{ detail: string; code: number }> {
      return new Promise((resolve) => {
        const qs = `callId=${encodeURIComponent(callId)}${token === null ? '' : `&token=${encodeURIComponent(token)}`}`;
        const w = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/api/voice/calls/ws?${qs}`);
        let detail = '';
        w.onmessage = (ev) => {
          const f = JSON.parse(String(ev.data)) as { t?: string; detail?: string };
          if (f.t === 'error') detail = String(f.detail ?? '');
        };
        w.onclose = (ev) => resolve({ detail, code: (ev as unknown as { code?: number }).code ?? -1 });
        setTimeout(() => resolve({ detail, code: -1 }), 5000);
      });
    }
    for (const bad of [null, 'wrong-token']) {
      const r = await tryConnect(bad);
      expect(r.detail).toBe('unauthorized');
      expect(r.code).toBe(4401);
    }
    // The call is still usable with the right token afterwards.
    const { ws, frames } = await connect(callId, WS_TOKEN);
    expect(frames[0]!.t).toBe('call_started');
    ws.close();
  });

  it('accepts a one-time ?ticket= on the WS upgrade', async () => {
    const { issueWsTicket } = await import('../src/loopback-auth.js');
    const callId = await startCall();
    const ticket = issueWsTicket();
    const qs = `callId=${encodeURIComponent(callId)}&ticket=${encodeURIComponent(ticket)}`;
    const { ws, frames } = await new Promise<{ ws: WebSocket; frames: Array<Record<string, unknown>> }>(
      (resolve, reject) => {
        const w = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/api/voice/calls/ws?${qs}`);
        const fr: Array<Record<string, unknown>> = [];
        const timer = setTimeout(() => reject(new Error('no call_started')), 5000);
        w.onmessage = (ev) => {
          const f = JSON.parse(String(ev.data)) as Record<string, unknown>;
          fr.push(f);
          if (f.t === 'call_started') {
            clearTimeout(timer);
            resolve({ ws: w, frames: fr });
          } else if (f.t === 'error') {
            clearTimeout(timer);
            reject(new Error(`rejected: ${String(f.detail)}`));
          }
        };
        w.onerror = () => {
          clearTimeout(timer);
          reject(new Error('ws error'));
        };
      },
    );
    expect(frames[0]!.t).toBe('call_started');
    ws.close();
  });

  it('runs a full utterance round trip over WS frames', async () => {
    const callId = await startCall();
    const { ws, frames } = await connect(callId);
    const audio = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).toString('base64');
    ws.send(JSON.stringify({ t: 'utterance', audio, mimeType: 'audio/webm' }));

    const transcript = await waitFor(frames, 'transcript');
    expect(String(transcript.text)).toContain('hello from the mock microphone');
    const reply = await waitFor(frames, 'reply');
    expect(String(reply.text)).toContain('echo:');
    const audioFrame = await waitFor(frames, 'audio');
    expect(typeof audioFrame.data).toBe('string');
    expect(String(audioFrame.data).length).toBeGreaterThan(0);
    expect(audioFrame.mimeType).toBe('audio/wav');
    await waitFor(frames, 'turn_done');

    ws.send(JSON.stringify({ t: 'end' }));
    await waitFor(frames, 'call_ended');
    ws.close();
  });

  it('rejects malformed and unknown frames without killing the session', async () => {
    const callId = await startCall();
    const { ws, frames } = await connect(callId);
    ws.send('not json{{{');
    const err1 = await waitFor(frames, 'error');
    expect(err1.detail).toBe('malformed frame');
    const afterFirst = frames.length;
    ws.send(JSON.stringify({ t: 'teleport' }));
    const err2 = await waitFor(frames, 'error', 15000, afterFirst);
    expect(String(err2.detail)).toContain('unknown frame type');
    // Session still usable.
    ws.send(JSON.stringify({ t: 'utterance', audio: Buffer.from([1, 2]).toString('base64') }));
    await waitFor(frames, 'turn_done');
    ws.close();
  });

  it('rejects oversized utterance audio by base64 string length before decoding (H4)', async () => {
    const callId = await startCall();
    const { ws, frames } = await connect(callId);
    // MAX_UTTERANCE_B64+1 chars would decode to more than the 10MB service
    // limit; the route must refuse it without ever decoding.
    const huge = 'a'.repeat(MAX_UTTERANCE_B64 + 1);
    const before = frames.length;
    ws.send(JSON.stringify({ t: 'utterance', audio: huge }));
    const err = await waitFor(frames, 'error', 15000, before);
    expect(String(err.detail)).toContain('audio too large');
    // Session still usable after the rejection (defense-in-depth intact).
    ws.send(JSON.stringify({ t: 'utterance', audio: Buffer.from([1, 2]).toString('base64') }));
    await waitFor(frames, 'turn_done', 15000, before);
    ws.close();
  });
});
