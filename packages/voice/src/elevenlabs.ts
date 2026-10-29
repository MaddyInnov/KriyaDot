// SPDX-License-Identifier: Apache-2.0
// ElevenLabs TTS provider + voice catalog, over the public REST API:
//
//   TTS:     POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}
//            (header xi-api-key; JSON { text, model_id, voice_settings })
//   Catalog: GET  /v1/voices          → voices on the account
//            GET  /v1/shared-voices   → public library search
//
// Key-gated by design: the key is read from ELEVENLABS_API_KEY (or
// passed explicitly) and never logged. All HTTP goes through an
// injectable fetch (opts.fetchFn) so tests stub the network — no test
// may reach api.elevenlabs.io.

import type { VoiceCatalogEntry } from './catalog.js';
import type { TTSProvider, TTSResult, TTSSynthesizeOptions, VoiceFetchFn } from './voice.js';

/** ElevenLabs API base (versioned). */
export const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io/v1';

/** Env var holding the ElevenLabs API key. */
export const ELEVENLABS_API_KEY_ENV_VAR = 'ELEVENLABS_API_KEY';

/** Default synthesis model: high-quality multilingual model. */
export const DEFAULT_ELEVENLABS_MODEL = 'eleven_multilingual_v2';
/** Default voice id (the provider's long-standing default voice). */
export const DEFAULT_ELEVENLABS_VOICE = '21m00Tcm4TlvDq8ikWAM';

export interface ElevenLabsOptions {
  /** API key; falls back to ELEVENLABS_API_KEY in env. Never logged. */
  apiKey?: string;
  /** Override for tests/proxies; defaults to ELEVENLABS_BASE_URL. */
  baseUrl?: string;
  /** Synthesis model id; default 'eleven_multilingual_v2'. */
  modelId?: string;
  /** Default voice id; overridable per call via TTSSynthesizeOptions.voice. */
  voiceId?: string;
  /** Voice settings stability 0–1 (default 0.5). */
  stability?: number;
  /** Voice settings similarity boost 0–1 (default 0.75). */
  similarityBoost?: number;
  /** Env source; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Injectable fetch (tests stub this; defaults to global fetch). */
  fetchFn?: VoiceFetchFn;
}

interface ElevenLabsConfig {
  apiKey: string;
  baseUrl: string;
  modelId: string;
  voiceId: string;
  stability: number;
  similarityBoost: number;
  fetchFn: VoiceFetchFn;
}

function resolveConfig(opts: ElevenLabsOptions): ElevenLabsConfig {
  const env = opts.env ?? process.env;
  const apiKey = opts.apiKey ?? env[ELEVENLABS_API_KEY_ENV_VAR];
  if (!apiKey) {
    throw new Error(
      `elevenlabs voice: missing ${ELEVENLABS_API_KEY_ENV_VAR}. Set the ${ELEVENLABS_API_KEY_ENV_VAR} ` +
        `environment variable (or pass apiKey explicitly), or leave VOICE_TTS_PROVIDER unset to use the mock.`,
    );
  }
  return {
    apiKey,
    baseUrl: (opts.baseUrl ?? ELEVENLABS_BASE_URL).replace(/\/+$/, ''),
    modelId: opts.modelId ?? DEFAULT_ELEVENLABS_MODEL,
    voiceId: opts.voiceId ?? DEFAULT_ELEVENLABS_VOICE,
    stability: opts.stability ?? 0.5,
    similarityBoost: opts.similarityBoost ?? 0.75,
    fetchFn: opts.fetchFn ?? ((url, init) => globalThis.fetch(url, init)),
  };
}

async function elevenLabsRequest(
  cfg: ElevenLabsConfig,
  url: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  const res = await cfg.fetchFn(url, {
    ...init,
    headers: { 'xi-api-key': cfg.apiKey, ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${label} failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`);
  }
  return res;
}

/** Map the synthesize format option onto an ElevenLabs output format. */
export function elevenLabsOutputFormat(format: 'wav' | 'mp3'): { outputFormat: string; mimeType: string } {
  return format === 'wav'
    ? { outputFormat: 'wav_44100', mimeType: 'audio/wav' }
    : { outputFormat: 'mp3_44100_128', mimeType: 'audio/mpeg' };
}

/**
 * ElevenLabs TTS. Key-gated; zero calls happen without
 * ELEVENLABS_API_KEY.
 */
export class ElevenLabsTTSProvider implements TTSProvider {
  readonly name = 'elevenlabs' as const;
  private readonly cfg: ElevenLabsConfig;

  constructor(opts: ElevenLabsOptions = {}) {
    this.cfg = resolveConfig(opts);
  }

  async synthesize(text: string, opts: TTSSynthesizeOptions = {}): Promise<TTSResult> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('elevenlabs TTS: text must be non-empty');
    if (trimmed.length > 5000) throw new Error('elevenlabs TTS: text too long (max 5000 chars)');
    const format = opts.format ?? 'mp3';
    if (format !== 'wav' && format !== 'mp3') {
      throw new Error(`elevenlabs TTS: unsupported format "${format}" (supported: wav, mp3)`);
    }
    const { outputFormat, mimeType } = elevenLabsOutputFormat(format);
    const voiceId = opts.voice ?? this.cfg.voiceId;
    const res = await elevenLabsRequest(
      this.cfg,
      `${this.cfg.baseUrl}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${outputFormat}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: mimeType },
        body: JSON.stringify({
          text: trimmed,
          model_id: this.cfg.modelId,
          voice_settings: {
            stability: this.cfg.stability,
            similarity_boost: this.cfg.similarityBoost,
          },
        }),
      },
      'elevenlabs TTS',
    );
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length === 0) throw new Error('elevenlabs TTS: empty audio response');
    return { audio: buf, mimeType };
  }

  /** Voices on the account (GET /v1/voices). */
  async listVoices(): Promise<VoiceCatalogEntry[]> {
    return listElevenLabsVoices({ apiKey: this.cfg.apiKey, baseUrl: this.cfg.baseUrl, fetchFn: this.cfg.fetchFn });
  }

  /** Public library search (GET /v1/shared-voices). */
  async searchSharedVoices(query: string, pageSize?: number): Promise<VoiceCatalogEntry[]> {
    return searchElevenLabsSharedVoices(
      { apiKey: this.cfg.apiKey, baseUrl: this.cfg.baseUrl, fetchFn: this.cfg.fetchFn },
      { query, pageSize },
    );
  }
}

interface ElevenLabsVoiceRaw {
  voice_id?: unknown;
  name?: unknown;
  category?: unknown;
  description?: unknown;
  preview_url?: unknown;
  labels?: unknown;
}

function stringLabels(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function mapVoice(raw: ElevenLabsVoiceRaw): VoiceCatalogEntry | null {
  if (typeof raw.voice_id !== 'string' || !raw.voice_id) return null;
  return {
    id: raw.voice_id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : raw.voice_id,
    provider: 'elevenlabs',
    description: typeof raw.description === 'string' ? raw.description : undefined,
    previewUrl: typeof raw.preview_url === 'string' ? raw.preview_url : undefined,
    category: typeof raw.category === 'string' ? raw.category : undefined,
    labels: stringLabels(raw.labels),
  };
}

/** List the voices available on the account: GET /v1/voices. */
export async function listElevenLabsVoices(opts: ElevenLabsOptions = {}): Promise<VoiceCatalogEntry[]> {
  const cfg = resolveConfig(opts);
  const res = await elevenLabsRequest(cfg, `${cfg.baseUrl}/voices`, { method: 'GET' }, 'elevenlabs catalog');
  const data = (await res.json()) as { voices?: unknown };
  if (!Array.isArray(data.voices)) throw new Error('elevenlabs catalog: unexpected response shape (missing voices)');
  return data.voices.map((v) => mapVoice(v as ElevenLabsVoiceRaw)).filter((v): v is VoiceCatalogEntry => v !== null);
}

interface ElevenLabsSharedVoiceRaw extends ElevenLabsVoiceRaw {
  accent?: unknown;
  age?: unknown;
  gender?: unknown;
  language?: unknown;
  use_case?: unknown;
}

function mapSharedVoice(raw: ElevenLabsSharedVoiceRaw): VoiceCatalogEntry | null {
  const base = mapVoice(raw);
  if (!base) return null;
  const labels: Record<string, string> = { ...(base.labels ?? {}) };
  for (const key of ['accent', 'age', 'gender', 'use_case'] as const) {
    const v = raw[key];
    if (typeof v === 'string' && v) labels[key === 'use_case' ? 'useCase' : key] = v;
  }
  return {
    ...base,
    category: base.category ?? 'shared',
    labels: Object.keys(labels).length > 0 ? labels : undefined,
    language: typeof raw.language === 'string' ? raw.language : undefined,
  };
}

/**
 * Search the public ElevenLabs voice library: GET /v1/shared-voices.
 * This is the discovery surface behind the voice picker — the account
 * list alone is too small to browse.
 */
export async function searchElevenLabsSharedVoices(
  opts: ElevenLabsOptions = {},
  search: { query?: string; pageSize?: number; language?: string; category?: string } = {},
): Promise<VoiceCatalogEntry[]> {
  const cfg = resolveConfig(opts);
  const params = new URLSearchParams();
  params.set('page_size', String(Math.min(100, Math.max(1, search.pageSize ?? 24))));
  if (search.query?.trim()) params.set('search', search.query.trim());
  if (search.language) params.set('language', search.language);
  if (search.category) params.set('category', search.category);
  const res = await elevenLabsRequest(
    cfg,
    `${cfg.baseUrl}/shared-voices?${params.toString()}`,
    { method: 'GET' },
    'elevenlabs shared-voices',
  );
  const data = (await res.json()) as { voices?: unknown };
  if (!Array.isArray(data.voices)) {
    throw new Error('elevenlabs shared-voices: unexpected response shape (missing voices)');
  }
  return data.voices
    .map((v) => mapSharedVoice(v as ElevenLabsSharedVoiceRaw))
    .filter((v): v is VoiceCatalogEntry => v !== null);
}
