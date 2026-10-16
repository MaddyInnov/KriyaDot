// SPDX-License-Identifier: Apache-2.0
// Realtime voice calls with bots (Codync parity).
//
// Architecture: the server owns the turn loop — STT → real bot turn via the
// agent runtime → TTS — and streams progress over a WebSocket as JSON text
// frames (the repo's minimal WS implementation only supports text frames,
// so audio rides as base64). This keeps the transport provider-agnostic:
// any STT/TTS pair from @mvp/voice plugs in, including the zero-cost mock
// (default) and the key-gated Groq / OpenAI REST providers.
//
// BYOK key resolution (server-side only, never logged or sent to clients):
//   1. vault secret `voice_<provider>_api_key` (namespace 'default-user')
//   2. env GROQ_API_KEY / OPENAI_API_KEY
//
// Turn-taking is push-to-talk or client-side VAD (see apps/web/lib/vad.ts);
// the server treats each utterance as one turn. If the bot's turn raises an
// approval card, the approval is relayed immediately and the turn continues
// through the normal Approvals-inbox flow (the runtime blocks on the
// decision); the caller hears the reply once the user decides.

import { randomUUID } from 'node:crypto';
import {
  GroqSTTProvider,
  GroqTTSProvider,
  MockSTTProvider,
  MockTTSProvider,
  OpenAISTTProvider,
  OpenAITTSProvider,
  type STTProvider,
  type TTSProvider,
} from '@mvp/voice';
import { SecureVault } from '@mvp/vault';
import type { BotConfig } from '@mvp/agent-runtime';

/** Voice providers the call service can select. 'mock' is zero-cost. */
export const VOICE_CALL_PROVIDERS = ['mock', 'groq', 'openai'] as const;
export type VoiceCallProviderId = (typeof VOICE_CALL_PROVIDERS)[number];

export const VOICE_PROVIDER_LABELS: Record<VoiceCallProviderId, string> = {
  mock: 'Mock (offline)',
  groq: 'Groq (Whisper + PlayAI)',
  openai: 'OpenAI (Whisper + TTS)',
};

/** Max inbound utterance: 10 MB of audio. */
export const MAX_UTTERANCE_BYTES = 10 * 1024 * 1024;
/** Hard cap on call duration: 30 minutes. */
export const MAX_CALL_MS = 30 * 60 * 1000;
/** Per-utterance budget (STT + bot turn + TTS). */
export const UTTERANCE_TIMEOUT_MS = 120_000;
/** Reply text is truncated to this before TTS (latency + cost guard). */
export const MAX_REPLY_CHARS_FOR_TTS = 2000;

function vaultSecretName(provider: VoiceCallProviderId): string {
  return `voice_${provider}_api_key`;
}

function envVarFor(provider: VoiceCallProviderId): string | null {
  if (provider === 'groq') return 'GROQ_API_KEY';
  if (provider === 'openai') return 'OPENAI_API_KEY';
  return null;
}

/**
 * Resolve a provider API key: vault first, then env. Returns undefined when
 * unconfigured. Server-side only — the key is never logged or returned to
 * clients; callers only learn whether a provider is *configured*.
 */
export function resolveVoiceApiKey(
  provider: VoiceCallProviderId,
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (provider === 'mock') return 'mock';
  try {
    const vault = new SecureVault(dataDir, 'default-user', 'voice-call');
    const secret = vault.get(vaultSecretName(provider));
    const value = secret?.value?.trim();
    if (value) return value;
  } catch {
    // Vault unreadable (fresh install, tests) → fall through to env.
  }
  const envVar = envVarFor(provider);
  const fromEnv = envVar ? env[envVar]?.trim() : '';
  return fromEnv || undefined;
}

/** Whether a provider can be used right now (mock: always). */
export function isVoiceProviderConfigured(
  provider: VoiceCallProviderId,
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveVoiceApiKey(provider, dataDir, env) !== undefined;
}

export interface VoiceCallProviderStatus {
  id: VoiceCallProviderId;
  label: string;
  configured: boolean;
  /** Why it is not usable, when !configured. */
  hint?: string;
}

export function listVoiceCallProviders(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): VoiceCallProviderStatus[] {
  return VOICE_CALL_PROVIDERS.map((id) => {
    const configured = isVoiceProviderConfigured(id, dataDir, env);
    return {
      id,
      label: VOICE_PROVIDER_LABELS[id],
      configured,
      hint: configured
        ? undefined
        : id === 'mock'
          ? undefined
          : `Add the ${envVarFor(id)} key (vault secret "${vaultSecretName(id)}" or env ${envVarFor(id)}) to enable.`,
    };
  });
}

/** Build the concrete @mvp/voice providers for a call. Throws when a key-gated provider has no key. */
export function buildVoiceProviders(
  sttId: VoiceCallProviderId,
  ttsId: VoiceCallProviderId,
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): { stt: STTProvider; tts: TTSProvider } {
  const buildStt = (id: VoiceCallProviderId): STTProvider => {
    if (id === 'mock') return new MockSTTProvider();
    const key = resolveVoiceApiKey(id, dataDir, env);
    if (!key) throw new Error(`voice STT provider "${id}" is not configured (no API key)`);
    if (id === 'groq') return new GroqSTTProvider({ apiKey: key });
    return new OpenAISTTProvider({ apiKey: key });
  };
  const buildTts = (id: VoiceCallProviderId): TTSProvider => {
    if (id === 'mock') return new MockTTSProvider();
    const key = resolveVoiceApiKey(id, dataDir, env);
    if (!key) throw new Error(`voice TTS provider "${id}" is not configured (no API key)`);
    if (id === 'groq') return new GroqTTSProvider({ apiKey: key });
    return new OpenAITTSProvider({ apiKey: key });
  };
  return { stt: buildStt(sttId), tts: buildTts(ttsId) };
}

export interface VoiceCallTurn {
  id: string;
  at: number;
  transcript: string;
  replyText: string;
  replyAudioBytes: number;
  approvalId?: string;
}

export interface VoiceCallSession {
  id: string;
  botId: string;
  botName: string;
  /** Chat session id: the call is one continuous conversation. */
  sessionId: string;
  stt: VoiceCallProviderId;
  tts: VoiceCallProviderId;
  createdAt: number;
  endedAt?: number;
  turns: VoiceCallTurn[];
}

export interface RunBotTurnFn {
  (opts: {
    bot: BotConfig;
    message: string;
    sessionId: string;
    signal: AbortSignal;
    onText: (chunk: string) => void;
    onApproval: (approvalId: string, toolName: string) => void;
  }): Promise<void>;
}

export interface VoiceCallServiceDeps {
  dataDir: string;
  findBot: (botId: string) => BotConfig | undefined;
  runBotTurn: RunBotTurnFn;
  audit: (action: string, fields: Record<string, unknown>) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export interface StartCallOptions {
  botId: string;
  sttProvider?: string;
  ttsProvider?: string;
}

export interface UtteranceResult {
  transcript: string;
  replyText: string;
  /** base64 audio; empty string when skipped (no speech detected). */
  audioBase64: string;
  mimeType: string;
  skipped: boolean;
  approvalId?: string;
}

function normalizeProviderId(raw: unknown, fallback: VoiceCallProviderId): VoiceCallProviderId {
  if (typeof raw === 'string') {
    const id = raw.toLowerCase() as VoiceCallProviderId;
    if ((VOICE_CALL_PROVIDERS as readonly string[]).includes(id)) return id;
    throw new Error(`unknown voice provider "${raw}" (expected one of ${VOICE_CALL_PROVIDERS.join('|')})`);
  }
  return fallback;
}

/**
 * VoiceCallService: owns call sessions and the per-utterance turn loop.
 * Injectable (providers, clock, bot-turn runner) so tests run fully mocked
 * with zero network and zero paid usage.
 */
export class VoiceCallService {
  private readonly calls = new Map<string, VoiceCallSession>();
  /**
   * MEDIUM fix: one driving client per call. A second WS client attaching
   * to the same callId is rejected (call_busy) — two clients must never
   * drive the same turn loop concurrently.
   */
  private readonly attachedClients = new Set<string>();
  private readonly deps: VoiceCallServiceDeps;

  constructor(deps: VoiceCallServiceDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  listProviders(): VoiceCallProviderStatus[] {
    return listVoiceCallProviders(this.deps.dataDir, this.deps.env);
  }

  getCall(callId: string): VoiceCallSession | undefined {
    return this.calls.get(callId);
  }

  /** Start a call: validates the bot, resolves providers, mints the session. */
  startCall(opts: StartCallOptions): VoiceCallSession {
    const { findBot, dataDir, env, audit } = this.deps;
    const bot = findBot(opts.botId);
    if (!bot) throw Object.assign(new Error(`unknown bot "${opts.botId}"`), { status: 404 });
    const voice = bot.voice ?? {};
    const sttId = normalizeProviderId(opts.sttProvider ?? voice.sttProvider, 'mock');
    const ttsId = normalizeProviderId(opts.ttsProvider ?? voice.ttsProvider, 'mock');
    // Fail fast on unconfigured key-gated providers (clear 400, no session).
    for (const id of [sttId, ttsId]) {
      if (!isVoiceProviderConfigured(id, dataDir, env)) {
        throw Object.assign(new Error(`voice provider "${id}" is not configured (no API key)`), {
          status: 400,
        });
      }
    }
    const now = this.now();
    const call: VoiceCallSession = {
      id: `vcall_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      botId: bot.id,
      botName: bot.name,
      sessionId: `vcall_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      stt: sttId,
      tts: ttsId,
      createdAt: now,
      turns: [],
    };
    this.calls.set(call.id, call);
    try {
      audit('voice.call_started', { botId: bot.id, stt: sttId, tts: ttsId });
    } catch {
      // Audit must never break calls.
    }
    return call;
  }

  /** End a call; idempotent. */
  endCall(callId: string): boolean {
    const call = this.calls.get(callId);
    if (!call || call.endedAt) return false;
    call.endedAt = this.now();
    this.attachedClients.delete(callId);
    try {
      this.deps.audit('voice.call_ended', {
        botId: call.botId,
        turns: call.turns.length,
        durationMs: call.endedAt - call.createdAt,
      });
    } catch {
      // ignore
    }
    return true;
  }

  /**
   * Claim the driving-client slot for a call. Returns false when another
   * client already holds it (the caller must reject with call_busy).
   * The slot is released by detachClient() or automatically by endCall().
   */
  attachClient(callId: string): boolean {
    const call = this.calls.get(callId);
    if (!call || call.endedAt) return false;
    if (this.attachedClients.has(callId)) return false;
    this.attachedClients.add(callId);
    return true;
  }

  /** Release the driving-client slot (e.g. WS closed without ending the call). */
  detachClient(callId: string): void {
    this.attachedClients.delete(callId);
  }

  /** Whether a client currently holds the driving slot for the call. */
  isClientAttached(callId: string): boolean {
    return this.attachedClients.has(callId);
  }

  /**
   * Process one utterance: STT → real bot turn → TTS. Returns the transcript,
   * reply text and base64 audio for the WS frame fan-out. Never throws for
   * empty transcripts (returns skipped: true); throws on oversized audio,
   * unknown/ended calls, expired calls, or provider failures.
   */
  async processUtterance(
    callId: string,
    audio: Uint8Array,
    mimeType = 'audio/webm',
  ): Promise<UtteranceResult> {
    const call = this.calls.get(callId);
    if (!call) throw Object.assign(new Error('unknown call'), { status: 404 });
    if (call.endedAt) throw Object.assign(new Error('call has ended'), { status: 410 });
    if (this.now() - call.createdAt > MAX_CALL_MS) {
      this.endCall(callId);
      throw Object.assign(new Error('call exceeded the 30-minute limit'), { status: 410 });
    }
    if (!(audio instanceof Uint8Array) || audio.length === 0) {
      throw Object.assign(new Error('audio must be a non-empty byte array'), { status: 400 });
    }
    if (audio.length > MAX_UTTERANCE_BYTES) {
      throw Object.assign(new Error('utterance too large (max 10MB)'), { status: 413 });
    }
    const bot = this.deps.findBot(call.botId);
    if (!bot) throw Object.assign(new Error('bot no longer exists'), { status: 410 });

    const { stt, tts } = buildVoiceProviders(call.stt, call.tts, this.deps.dataDir, this.deps.env);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UTTERANCE_TIMEOUT_MS);
    try {
      const sttRes = await stt.transcribe(audio, { mimeType });
      const transcript = sttRes.text.trim();
      if (!transcript) {
        return { transcript: '', replyText: '', audioBase64: '', mimeType: '', skipped: true };
      }
      let replyText = '';
      let approvalId: string | undefined;
      await this.deps.runBotTurn({
        bot,
        message: transcript,
        sessionId: call.sessionId,
        signal: controller.signal,
        onText: (chunk) => {
          replyText += chunk;
        },
        onApproval: (id) => {
          approvalId = approvalId ?? id;
        },
      });
      replyText = replyText.trim();
      if (!replyText) {
        return { transcript, replyText: '', audioBase64: '', mimeType: '', skipped: true };
      }
      const ttsText = replyText.slice(0, MAX_REPLY_CHARS_FOR_TTS);
      const ttsRes = await tts.synthesize(ttsText, {
        voice: bot.voice?.ttsVoice || undefined,
        language: 'en',
      });
      const turn: VoiceCallTurn = {
        id: `vct_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
        at: this.now(),
        transcript,
        replyText,
        replyAudioBytes: ttsRes.audio.length,
        approvalId,
      };
      call.turns.push(turn);
      return {
        transcript,
        replyText,
        audioBase64: Buffer.from(ttsRes.audio).toString('base64'),
        mimeType: ttsRes.mimeType,
        skipped: false,
        approvalId,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Summaries for the REST API (no audio bytes). */
  summarize(call: VoiceCallSession): Record<string, unknown> {
    return {
      callId: call.id,
      botId: call.botId,
      botName: call.botName,
      stt: call.stt,
      tts: call.tts,
      createdAt: call.createdAt,
      endedAt: call.endedAt ?? null,
      turns: call.turns.map((t) => ({
        id: t.id,
        at: t.at,
        transcript: t.transcript,
        replyText: t.replyText,
        approvalId: t.approvalId ?? null,
      })),
    };
  }
}
