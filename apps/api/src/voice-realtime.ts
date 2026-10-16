// SPDX-License-Identifier: Apache-2.0
// Native realtime (speech-to-speech) voice calls (OpenMausBot parity P0 #9).
//
// This sits ALONGSIDE the existing sequential voice-call system
// (voice-call.ts: record → STT → bot turn → TTS per utterance). The
// realtime engine is full-duplex:
//
//   client mic ──PCM16 16kHz chunks──▶ server VAD ──segment──▶ STT
//        │                                         │
//        │  barge-in ◀── VAD speechstart ───────────┘
//        ▼
//   bot turn (streaming tokens) ──sentence──▶ TTS ──audio──▶ client
//
// Two engines:
//   1. 'chunked' (default): provider-agnostic, works with mock/groq/openai
//      REST STT+TTS. Barge-in is implemented by aborting the in-flight bot
//      turn and invalidating in-flight TTS audio.
//   2. 'openai-realtime': true speech-to-speech via the OpenAI Realtime API
//      (server-side proxy — the key never reaches the client). Native
//      server VAD + barge-in from OpenAI.
//
// Echo suppression (honest limitation): full acoustic echo cancellation
// server-side is infeasible; we mitigate by (a) requiring the client to
// use getUserMedia echoCancellation, and (b) a stricter VAD gate for
// barge-in (minSpeechMs 250 vs 120) so the tail of the bot's own audio
// doesn't false-trigger. The server never feeds its own output back into
// STT — there is no loop by construction.

import { randomUUID } from 'node:crypto';
import {
  OpenAIRealtimeBridge,
  REALTIME_SAMPLE_RATE as OPENAI_RT_RATE,
  type RealtimeBridgeEvent,
} from '@mvp/voice';
import type { STTProvider, TTSProvider } from '@mvp/voice';
import type { BotConfig } from '@mvp/agent-runtime';
import {
  buildVoiceProviders,
  isVoiceProviderConfigured,
  resolveVoiceApiKey,
  type RunBotTurnFn,
  type VoiceCallProviderId,
} from './voice-call.js';

/** Client → server PCM: 16kHz mono 16-bit. */
export const REALTIME_SAMPLE_RATE = 16000;
/** Hard cap on a realtime call: 15 minutes (auto-end). */
export const REALTIME_MAX_CALL_MS = 15 * 60 * 1000;
/** Per-turn budget (STT + bot turn + TTS). */
export const REALTIME_TURN_TIMEOUT_MS = 120_000;
/** Force-finalize a capture segment after 60s of continuous speech. */
export const REALTIME_MAX_SEGMENT_MS = 60_000;
/** Pre-decode cap on an inbound audio frame (base64 string). */
export const REALTIME_MAX_FRAME_B64 = 256 * 1024;
/** Spoken replies are truncated to this many chars (latency + cost). */
export const REALTIME_MAX_REPLY_CHARS = 1200;

export type RealtimeEngine = 'chunked' | 'openai-realtime';
export type RealtimePath = 'chunked-rest' | 'openai-realtime-passthrough';

export const REALTIME_ENGINES: RealtimeEngine[] = ['chunked', 'openai-realtime'];

/** Rough, documented cost estimates (USD). Groq/mock are $0. */
export const REALTIME_USD = {
  sttPerSec: { mock: 0, groq: 0, openai: 0.0001 } as Record<VoiceCallProviderId, number>,
  ttsPerChar: { mock: 0, groq: 0, openai: 0.000015 } as Record<VoiceCallProviderId, number>,
  /** OpenAI realtime audio ≈ $0.06/min in+out; we use $0.001/s as a rough blended estimate. */
  realtimePerSec: 0.001,
};

// ---------------------------------------------------------------------------
// Server-side VAD (energy + zero-crossing), ported from the client-side
// apps/web/lib/vad.ts logic but operating on PCM16 Int16Array chunks with
// explicit millisecond timing instead of a 30fps assumption.
// ---------------------------------------------------------------------------

export interface ServerVadOptions {
  /** 1–10 sensitivity; default 5. */
  sensitivity?: number;
  /** ms of trailing silence before speechend; default 700. */
  hangoverMs?: number;
  /** ms of speech before speechstart; default 120. */
  minSpeechMs?: number;
}

export type ServerVadEvent = 'speechstart' | 'speechend';

/** Map 1–10 sensitivity to an RMS threshold (same curve as the web VAD). */
export function sensitivityToThreshold(sensitivity: number): number {
  const s = Math.min(10, Math.max(1, Math.round(sensitivity)));
  return 0.068 - s * 0.006;
}

/** RMS energy of PCM16 samples, normalized to [-1, 1]. */
export function pcm16Energy(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

/** Zero-crossing rate: fraction of sign changes. Near 0 for pure tones/hum. */
export function pcm16ZeroCrossingRate(samples: Int16Array): number {
  if (samples.length < 2) return 0;
  let crossings = 0;
  let prev = samples[0] >= 0;
  for (let i = 1; i < samples.length; i++) {
    const cur = samples[i] >= 0;
    if (cur !== prev) crossings++;
    prev = cur;
  }
  return crossings / (samples.length - 1);
}

export class ServerVad {
  private readonly threshold: number;
  private readonly hangoverMs: number;
  private readonly minSpeechMs: number;
  private speaking = false;
  private speechMs = 0;
  private silenceMs = 0;

  constructor(opts: ServerVadOptions = {}) {
    this.threshold = sensitivityToThreshold(opts.sensitivity ?? 5);
    this.hangoverMs = opts.hangoverMs ?? 700;
    this.minSpeechMs = opts.minSpeechMs ?? 120;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /**
   * Feed one PCM16 @16kHz chunk; returns any transitions. A chunk counts as
   * speech when energy clears the threshold AND the zero-crossing rate is
   * not degenerate (rejects pure tones / mains hum).
   */
  feed(samples: Int16Array): ServerVadEvent[] {
    const events: ServerVadEvent[] = [];
    const chunkMs = (samples.length / REALTIME_SAMPLE_RATE) * 1000;
    const energy = pcm16Energy(samples);
    const zcr = pcm16ZeroCrossingRate(samples);
    const active = energy >= this.threshold && zcr >= 0.004;
    if (active) {
      this.silenceMs = 0;
      this.speechMs += chunkMs;
      if (!this.speaking && this.speechMs >= this.minSpeechMs) {
        this.speaking = true;
        events.push('speechstart');
      }
    } else {
      this.speechMs = 0;
      if (this.speaking) {
        this.silenceMs += chunkMs;
        if (this.silenceMs >= this.hangoverMs) {
          this.speaking = false;
          this.silenceMs = 0;
          events.push('speechend');
        }
      }
    }
    return events;
  }

  reset(): void {
    this.speaking = false;
    this.speechMs = 0;
    this.silenceMs = 0;
  }
}

/** Build a synthetic PCM16 chunk: sine tone at `amplitude`, or silence. */
export function synthPcm16(length: number, amplitude: number, freqHz = 440): Int16Array {
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * freqHz * i) / REALTIME_SAMPLE_RATE));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------

/** Wrap raw PCM16 mono samples in a minimal WAV container (for Whisper REST). */
export function pcm16ToWav(samples: Int16Array, sampleRate = REALTIME_SAMPLE_RATE): Uint8Array {
  const dataLen = samples.length * 2;
  const out = new Uint8Array(44 + dataLen);
  const view = new DataView(out.buffer);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataLen, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
  return out;
}

/**
 * Split streamed text into complete sentences for sentence-by-sentence TTS.
 * Heuristic (abbreviations like "Dr." may split early); the remainder is
 * returned for the next chunk.
 */
export function extractSentences(text: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = text;
  const endRe = /[.!?…]["'”’)]?(\s|$)/g;
  let scanned = 0; // chars of `rest` already confirmed as non-boundary
  for (;;) {
    endRe.lastIndex = scanned;
    const m = endRe.exec(rest);
    if (!m) break;
    const end = m.index + m[0].length;
    if (m.index - scanned >= 8) {
      sentences.push(rest.slice(0, end).trim());
      rest = rest.slice(end);
      scanned = 0;
    } else {
      // Too short to be a sentence ("Hi.", "e.g.") — skip this
      // punctuation and keep scanning; it stays in `rest`.
      scanned = end;
    }
  }
  return { sentences, rest };
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface RealtimeUsage {
  sttSec: number;
  ttsChars: number;
  llmChars: number;
  audioSec: number;
  /** Rough estimate — voice only, see REALTIME_USD. */
  usdApprox: number;
}

export interface RealtimeTurn {
  id: string;
  at: number;
  transcript: string;
  replyText: string;
  bargeIns: number;
  latencyMs?: number;
}

export interface RealtimeCallSession {
  id: string;
  botId: string;
  botName: string;
  engine: RealtimeEngine;
  path: RealtimePath;
  /** Chunked-engine provider ids (usage accounting). */
  stt: VoiceCallProviderId;
  tts: VoiceCallProviderId;
  /** Chat session id for the bot turn loop. */
  chatSessionId: string;
  createdAt: number;
  endedAt?: number;
  endReason?: string;
  turns: RealtimeTurn[];
  usage: RealtimeUsage;
}

export interface RealtimeEngineStatus {
  id: RealtimeEngine;
  label: string;
  path: RealtimePath;
  available: boolean;
  hint?: string;
}

export function listRealtimeEngines(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): RealtimeEngineStatus[] {
  const openaiKey = isVoiceProviderConfigured('openai', dataDir, env);
  return [
    {
      id: 'chunked',
      label: 'Chunked (STT → bot → TTS, any provider)',
      path: 'chunked-rest',
      available: true,
    },
    {
      id: 'openai-realtime',
      label: 'OpenAI Realtime (native speech-to-speech)',
      path: 'openai-realtime-passthrough',
      available: openaiKey,
      hint: openaiKey ? undefined : 'Needs the OpenAI key (vault secret "voice_openai_api_key" or OPENAI_API_KEY).',
    },
  ];
}

export interface RealtimeBridgeLike {
  onEvent: (e: RealtimeBridgeEvent) => void;
  connect(): Promise<void>;
  appendAudio(pcm16k: Int16Array): void;
  cancelResponse(): void;
  close(): void;
}

export interface RealtimeServiceDeps {
  dataDir: string;
  findBot: (botId: string) => BotConfig | undefined;
  runBotTurn: RunBotTurnFn;
  audit: (action: string, fields: Record<string, unknown>) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Injectable bridge factory (tests). */
  createBridge?: (opts: { apiKey: string; instructions: string; voice?: string }) => RealtimeBridgeLike;
  /** Max call duration override (tests). */
  maxCallMs?: number;
}

export interface StartRealtimeOptions {
  botId: string;
  engine?: string;
  sttProvider?: string;
  ttsProvider?: string;
}

function normalizeEngine(raw: unknown): RealtimeEngine {
  if (typeof raw === 'string') {
    const e = raw.toLowerCase() as RealtimeEngine;
    if ((REALTIME_ENGINES as readonly string[]).includes(e)) return e;
    throw new Error(`unknown realtime engine "${raw}" (expected chunked|openai-realtime)`);
  }
  return 'chunked';
}

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

type SessionState = 'listening' | 'capturing' | 'transcribing' | 'responding' | 'speaking';

/**
 * One live realtime call. The WS route constructs this, attaches a frame
 * sender, and feeds base64 PCM16 chunks. All async turn work is guarded by
 * a generation token so barge-in/end cleanly invalidates in-flight work.
 */
export class RealtimeCall {
  private readonly svc: RealtimeVoiceService;
  private readonly call: RealtimeCallSession;
  private readonly bot: BotConfig;
  private readonly providers: { stt: STTProvider; tts: TTSProvider } | null;
  private send: (frame: Record<string, unknown>) => void = () => {};
  private attached = false;

  private state: SessionState = 'listening';
  private readonly vad = new ServerVad();
  /** Stricter VAD for barge-in (echo guard): needs 250ms of speech. */
  private readonly bargeVad = new ServerVad({ minSpeechMs: 250 });
  /** Rolling pre-roll so a barge-in segment starts at the interruption. */
  private readonly preRoll: Int16Array[] = [];
  private segment: Int16Array[] = [];
  private segmentMs = 0;
  private turnAbort: AbortController | null = null;
  private gen = 0;
  private currentTurn: RealtimeTurn | null = null;
  private speechEndAt = 0;
  private bridge: Omit<RealtimeBridgeLike, 'connect'> | null = null;
  private ended = false;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private usageTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    svc: RealtimeVoiceService,
    call: RealtimeCallSession,
    bot: BotConfig,
    providers: { stt: STTProvider; tts: TTSProvider } | null,
  ) {
    this.svc = svc;
    this.call = call;
    this.bot = bot;
    this.providers = providers;
  }

  get session(): RealtimeCallSession {
    return this.call;
  }

  /** Attach the client frame sender (called once by the WS route). */
  attach(send: (frame: Record<string, unknown>) => void): void {
    this.send = send;
    this.attached = true;
    this.send({
      t: 'realtime_started',
      callId: this.call.id,
      botId: this.call.botId,
      botName: this.call.botName,
      engine: this.call.engine,
      path: this.call.path,
      sampleRate: this.call.engine === 'openai-realtime' ? OPENAI_RT_RATE : REALTIME_SAMPLE_RATE,
      maxCallMs: this.svc.maxCallMs,
    });
    this.armTimers();
  }

  private armTimers(): void {
    const remaining = this.svc.maxCallMs - (this.svc.now() - this.call.createdAt);
    this.endTimer = setTimeout(() => {
      this.end('max_duration');
      this.send({ t: 'call_ended', reason: 'max_duration' });
    }, Math.max(1000, remaining));
    // Usage heartbeat every 10s so the cost ticker stays live.
    this.usageTimer = setInterval(() => {
      if (!this.ended) this.send({ t: 'usage', ...this.call.usage });
    }, 10_000);
    this.usageTimer.unref?.();
    this.endTimer.unref?.();
  }

  /** Feed one base64 PCM16 @16kHz chunk from the client. */
  feedAudioChunk(base64: string): void {
    if (this.ended) return;
    if (typeof base64 !== 'string' || base64.length === 0 || base64.length > REALTIME_MAX_FRAME_B64) {
      return; // route validates and reports; here we just ignore
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(Buffer.from(base64, 'base64'));
    } catch {
      return;
    }
    if (bytes.length === 0 || bytes.length % 2 !== 0) return;
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);

    if (this.call.engine === 'openai-realtime') {
      this.bridge?.appendAudio(pcm);
      // Local VAD still tracks for UI speech indicators.
      for (const ev of this.vad.feed(pcm)) {
        this.send({ t: ev === 'speechstart' ? 'speech_started' : 'speech_stopped' });
      }
      this.call.usage.audioSec += pcm.length / REALTIME_SAMPLE_RATE;
      return;
    }

    // Chunked engine: full-duplex state machine.
    this.call.usage.audioSec += pcm.length / REALTIME_SAMPLE_RATE;
    this.pushPreRoll(pcm);
    // Barge-in applies while the bot is working OR mid-transcription —
    // otherwise user speech during STT would be swallowed silently.
    const botActive =
      this.state === 'transcribing' || this.state === 'responding' || this.state === 'speaking';
    const vad = botActive ? this.bargeVad : this.vad;
    for (const ev of vad.feed(pcm)) {
      if (ev === 'speechstart') this.onSpeechStart(botActive);
      else this.onSpeechEnd();
    }
    if (this.state === 'capturing') {
      this.segment.push(pcm);
      this.segmentMs += (pcm.length / REALTIME_SAMPLE_RATE) * 1000;
      if (this.segmentMs >= REALTIME_MAX_SEGMENT_MS) {
        // Force-finalize very long monologues.
        this.onSpeechEnd();
        this.vad.reset();
      }
    }
  }

  private pushPreRoll(pcm: Int16Array): void {
    this.preRoll.push(pcm);
    // Keep ~1s of pre-roll (16kHz → 16000 samples).
    let total = 0;
    for (const c of this.preRoll) total += c.length;
    while (total > REALTIME_SAMPLE_RATE && this.preRoll.length > 1) {
      total -= this.preRoll.shift()!.length;
    }
  }

  private concat(chunks: Int16Array[]): Int16Array {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Int16Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  private onSpeechStart(botActive: boolean): void {
    if (this.ended) return;
    if (botActive) {
      this.bargeIn();
      return;
    }
    if (this.state === 'listening') {
      this.state = 'capturing';
      this.segment = [...this.preRoll];
      this.segmentMs = 0;
      for (const c of this.segment) this.segmentMs += (c.length / REALTIME_SAMPLE_RATE) * 1000;
      this.send({ t: 'speech_started' });
    }
  }

  private onSpeechEnd(): void {
    if (this.ended) return;
    if (this.state !== 'capturing') {
      if (this.state === 'listening') this.send({ t: 'speech_stopped' });
      return;
    }
    this.send({ t: 'speech_stopped' });
    this.speechEndAt = this.svc.now();
    const pcm = this.concat(this.segment);
    this.segment = [];
    this.segmentMs = 0;
    this.state = 'transcribing';
    void this.runChunkedTurn(pcm);
  }

  /** Barge-in: user interrupted the bot. Abort the turn, stop audio, listen. */
  private bargeIn(): void {
    const gen = ++this.gen;
    this.turnAbort?.abort();
    this.turnAbort = null;
    if (this.currentTurn) {
      this.currentTurn.bargeIns++;
      // Record the interrupted turn so the transcript shows it honestly.
      this.call.turns.push(this.currentTurn);
      this.currentTurn = null;
    }
    this.send({ t: 'barge_in', gen });
    this.vad.reset();
    this.bargeVad.reset();
    // Seed the new capture with pre-roll so the interruption isn't clipped.
    this.state = 'capturing';
    this.segment = [...this.preRoll];
    this.segmentMs = 0;
    for (const c of this.segment) this.segmentMs += (c.length / REALTIME_SAMPLE_RATE) * 1000;
    this.send({ t: 'speech_started', bargeIn: true });
    void this.svc.auditSafe('voice.realtime_barge_in', { callId: this.call.id });
  }

  private async runChunkedTurn(segmentPcm: Int16Array): Promise<void> {
    const gen = ++this.gen;
    const alive = () => gen === this.gen && !this.ended;
    const providers = this.providers;
    if (!providers) {
      this.state = 'listening';
      return;
    }
    const turn: RealtimeTurn = {
      id: `vrt_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
      at: this.svc.now(),
      transcript: '',
      replyText: '',
      bargeIns: 0,
    };
    this.currentTurn = turn;
    const controller = new AbortController();
    this.turnAbort = controller;
    const timeout = setTimeout(() => controller.abort(), REALTIME_TURN_TIMEOUT_MS);
    try {
      const audioSec = segmentPcm.length / REALTIME_SAMPLE_RATE;
      const wav = pcm16ToWav(segmentPcm);
      const sttRes = await providers.stt.transcribe(wav, { mimeType: 'audio/wav', language: 'en' });
      if (!alive()) return;
      this.call.usage.sttSec += audioSec;
      this.call.usage.usdApprox += audioSec * REALTIME_USD.sttPerSec[this.call.stt];
      const transcript = sttRes.text.trim();
      if (!transcript) {
        this.currentTurn = null;
        this.state = 'listening';
        this.send({ t: 'turn_done', skipped: true });
        return;
      }
      turn.transcript = transcript;
      this.send({ t: 'transcript', text: transcript });

      // Bot turn with streaming tokens → sentence-chunked TTS.
      this.state = 'responding';
      let buffer = '';
      let replyText = '';
      let ttsSeq = 0;
      let firstAudioAt = 0;
      const speakSentence = async (sentence: string): Promise<void> => {
        if (!alive() || !sentence.trim()) return;
        ttsSeq++;
        const mySeq = ttsSeq;
        this.state = 'speaking';
        try {
          const ttsRes = await providers.tts.synthesize(sentence, {
            voice: this.bot.voice?.ttsVoice || undefined,
            language: 'en',
          });
          if (!alive()) return; // barge-in or end invalidated this audio
          this.call.usage.ttsChars += sentence.length;
          this.call.usage.usdApprox += sentence.length * REALTIME_USD.ttsPerChar[this.call.tts];
          if (!firstAudioAt) {
            firstAudioAt = this.svc.now();
            turn.latencyMs = firstAudioAt - this.speechEndAt;
            this.send({ t: 'latency', ms: turn.latencyMs });
          }
          this.send({
            t: 'audio',
            seq: mySeq,
            turnId: turn.id,
            data: Buffer.from(ttsRes.audio).toString('base64'),
            mimeType: ttsRes.mimeType,
            sentence,
          });
        } catch (err) {
          if (alive()) this.send({ t: 'error', detail: 'tts failed mid-turn' });
        }
      };

      let approvalId: string | undefined;
      await this.svc.deps.runBotTurn({
        bot: this.bot,
        message: transcript,
        sessionId: this.call.chatSessionId,
        signal: controller.signal,
        onText: (chunk) => {
          if (!alive()) return;
          replyText += chunk;
          this.call.usage.llmChars += chunk.length;
          buffer += chunk;
          // Stream sentence-by-sentence; don't await (keeps tokens flowing).
          const { sentences, rest } = extractSentences(buffer);
          buffer = rest;
          for (const s of sentences) void speakSentence(s);
        },
        onApproval: (id, tool) => {
          approvalId = approvalId ?? id;
          if (alive()) this.send({ t: 'approval_required', approvalId: id, tool });
        },
      });
      if (!alive()) return;
      // Flush any remainder (truncate long tails for latency/cost).
      const tail = buffer.trim().slice(0, REALTIME_MAX_REPLY_CHARS);
      if (tail) await speakSentence(tail);
      if (!alive()) return; // barge-in may have recorded this turn already
      turn.replyText = replyText.slice(0, REALTIME_MAX_REPLY_CHARS);
      this.call.turns.push(turn);
      this.currentTurn = null;
      this.state = 'listening';
      this.send({ t: 'turn_done', latencyMs: turn.latencyMs ?? null });
      this.send({ t: 'usage', ...this.call.usage });
    } catch (err) {
      if (!alive()) return;
      this.currentTurn = null;
      this.state = 'listening';
      const aborted = controller.signal.aborted;
      this.send({ t: 'error', detail: aborted ? 'turn aborted' : 'turn failed' });
      this.send({ t: 'turn_done', failed: true });
    } finally {
      clearTimeout(timeout);
      if (this.turnAbort === controller) this.turnAbort = null;
    }
  }

  /** Passthrough engine: translate bridge events into KriyaDot frames. */
  attachBridge(bridge: Omit<RealtimeBridgeLike, 'connect'>): void {
    this.bridge = bridge;
    bridge.onEvent = (e) => this.onBridgeEvent(e);
  }

  private onBridgeEvent(e: RealtimeBridgeEvent): void {
    if (this.ended) return;
    switch (e.type) {
      case 'session_ready':
        break;
      case 'user_speech_started':
        this.send({ t: 'barge_in', source: 'openai-vad' });
        this.send({ t: 'speech_started' });
        break;
      case 'user_speech_stopped':
        this.send({ t: 'speech_stopped' });
        break;
      case 'user_transcript':
        this.pushPassthroughTurn(e.text, '');
        this.send({ t: 'transcript', text: e.text });
        break;
      case 'assistant_transcript_delta':
        this.send({ t: 'reply_delta', text: e.text });
        break;
      case 'assistant_audio_delta':
        this.send({ t: 'audio', pcm16: true, sampleRate: e.sampleRate, data: e.pcm16Base64 });
        break;
      case 'assistant_turn_done': {
        const last = this.call.turns[this.call.turns.length - 1];
        if (last) last.replyText = e.transcript;
        this.send({ t: 'turn_done' });
        break;
      }
      case 'error':
        this.send({ t: 'error', detail: e.detail });
        break;
    }
  }

  private pushPassthroughTurn(transcript: string, replyText: string): void {
    this.call.turns.push({
      id: `vrt_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
      at: this.svc.now(),
      transcript,
      replyText,
      bargeIns: 0,
    });
  }

  end(reason = 'client'): void {
    if (this.ended) return;
    this.ended = true;
    this.gen++;
    this.turnAbort?.abort();
    this.turnAbort = null;
    try {
      this.bridge?.close();
    } catch {
      // ignore
    }
    if (this.endTimer) clearTimeout(this.endTimer);
    if (this.usageTimer) clearInterval(this.usageTimer);
    this.svc.endCall(this.call.id, reason);
  }
}

/**
 * RealtimeVoiceService: owns realtime call records and mints RealtimeCall
 * instances. Injectable (clock, bridge factory) so tests run fully mocked
 * with zero network and zero paid usage.
 */
export class RealtimeVoiceService {
  private readonly calls = new Map<string, RealtimeCallSession>();
  private readonly liveCalls = new Map<string, RealtimeCall>();
  readonly deps: RealtimeServiceDeps;
  readonly maxCallMs: number;

  constructor(deps: RealtimeServiceDeps) {
    this.deps = deps;
    this.maxCallMs = deps.maxCallMs ?? REALTIME_MAX_CALL_MS;
  }

  now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  auditSafe(action: string, fields: Record<string, unknown>): void {
    try {
      this.deps.audit(action, fields);
    } catch {
      // audit must never break calls
    }
  }

  listEngines(): RealtimeEngineStatus[] {
    return listRealtimeEngines(this.deps.dataDir, this.deps.env);
  }

  getCall(callId: string): RealtimeCallSession | undefined {
    return this.calls.get(callId);
  }

  /**
   * Start a realtime call. For 'openai-realtime' the bridge connects here
   * (fail-fast: bad key → 502 before any client audio flows).
   */
  async startRealtimeCall(opts: StartRealtimeOptions): Promise<{
    call: RealtimeCallSession;
    live: RealtimeCall;
  }> {
    const { findBot, dataDir, env } = this.deps;
    const bot = findBot(opts.botId);
    if (!bot) fail(404, `unknown bot "${opts.botId}"`);
    const engine = normalizeEngine(opts.engine ?? (bot as { realtimeEngine?: unknown }).realtimeEngine ?? 'chunked');

    let providers: { stt: STTProvider; tts: TTSProvider } | null = null;
    let sttId: VoiceCallProviderId = 'mock';
    let ttsId: VoiceCallProviderId = 'mock';
    if (engine === 'chunked') {
      const voice = bot.voice ?? {};
      sttId = (opts.sttProvider as VoiceCallProviderId | undefined) ?? (voice.sttProvider as VoiceCallProviderId | undefined) ?? 'mock';
      ttsId = (opts.ttsProvider as VoiceCallProviderId | undefined) ?? (voice.ttsProvider as VoiceCallProviderId | undefined) ?? 'mock';
      for (const id of [sttId, ttsId]) {
        if (!isVoiceProviderConfigured(id, dataDir, env)) {
          fail(400, `voice provider "${id}" is not configured (no API key)`);
        }
      }
      providers = buildVoiceProviders(sttId, ttsId, dataDir, env);
    } else {
      const key = resolveVoiceApiKey('openai', dataDir, env);
      if (!key) fail(400, 'openai-realtime needs the OpenAI key (vault secret "voice_openai_api_key" or OPENAI_API_KEY)');
    }

    const now = this.now();
    const call: RealtimeCallSession = {
      id: `vrt_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      botId: bot.id,
      botName: bot.name,
      engine,
      path: engine === 'openai-realtime' ? 'openai-realtime-passthrough' : 'chunked-rest',
      stt: sttId,
      tts: ttsId,
      chatSessionId: `vrt_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      createdAt: now,
      turns: [],
      usage: { sttSec: 0, ttsChars: 0, llmChars: 0, audioSec: 0, usdApprox: 0 },
    };

    const live = new RealtimeCall(this, call, bot, providers);

    if (engine === 'openai-realtime') {
      const key = resolveVoiceApiKey('openai', dataDir, env) as string;
      const factory =
        this.deps.createBridge ??
        ((o: { apiKey: string; instructions: string; voice?: string }): RealtimeBridgeLike =>
          new OpenAIRealtimeBridge(o));
      const bridge = factory({
        apiKey: key,
        instructions: bot.systemPrompt || `You are ${bot.name}, a helpful voice assistant. Keep spoken replies short.`,
        voice: typeof bot.voice?.ttsVoice === 'string' && bot.voice.ttsVoice ? bot.voice.ttsVoice : 'alloy',
      });
      try {
        await bridge.connect();
      } catch (err) {
        fail(502, `openai realtime connect failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      live.attachBridge(bridge);
    }

    this.calls.set(call.id, call);
    this.liveCalls.set(call.id, live);
    this.auditSafe('voice.realtime_started', { botId: bot.id, engine, path: call.path });
    return { call, live };
  }

  /**
   * Return the live state machine for a call id (WS upgrade path).
   * Null when unknown or ended.
   */
  attachLive(callId: string): RealtimeCall | null {
    const call = this.calls.get(callId);
    if (!call || call.endedAt) return null;
    return this.liveCalls.get(callId) ?? null;
  }

  /** End a call; idempotent. */
  endCall(callId: string, reason = 'client'): boolean {
    const call = this.calls.get(callId);
    if (!call || call.endedAt) return false;
    call.endedAt = this.now();
    call.endReason = reason;
    // Rough passthrough cost: blended audio seconds × estimate.
    if (call.engine === 'openai-realtime') {
      call.usage.usdApprox += call.usage.audioSec * REALTIME_USD.realtimePerSec;
    }
    this.liveCalls.delete(callId);
    this.auditSafe('voice.realtime_ended', {
      callId,
      botId: call.botId,
      engine: call.engine,
      turns: call.turns.length,
      reason,
      durationMs: call.endedAt - call.createdAt,
    });
    return true;
  }

  summarize(call: RealtimeCallSession): Record<string, unknown> {
    return {
      callId: call.id,
      botId: call.botId,
      botName: call.botName,
      engine: call.engine,
      path: call.path,
      stt: call.stt,
      tts: call.tts,
      createdAt: call.createdAt,
      endedAt: call.endedAt ?? null,
      endReason: call.endReason ?? null,
      usage: call.usage,
      turns: call.turns.map((t) => ({
        id: t.id,
        at: t.at,
        transcript: t.transcript,
        replyText: t.replyText,
        bargeIns: t.bargeIns,
        latencyMs: t.latencyMs ?? null,
      })),
    };
  }
}
