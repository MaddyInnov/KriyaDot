// SPDX-License-Identifier: Apache-2.0
// Chatterbox TTS provider: talks to a self-hosted Chatterbox-compatible
// HTTP server (the user runs the model on their own machine/network —
// there is no hosted API key to buy):
//
//   TTS:     POST {base}/tts   JSON { text, voice?, format?,
//            exaggeration?, cfg_weight? } → raw audio bytes, or a JSON
//            body { audio_base64, mime_type? } from servers that wrap
//   Catalog: GET  {base}/voices → [{ id, name, … }] or { voices: [...] }
//
// Configured by CHATTERBOX_BASE_URL (e.g. http://127.0.0.1:8000). An
// optional bearer key (CHATTERBOX_API_KEY) is sent when present, for
// servers fronted by an authenticated proxy. All HTTP goes through an
// injectable fetch so tests stub everything.

import type { VoiceCatalogEntry } from './catalog.js';
import type { TTSProvider, TTSResult, TTSSynthesizeOptions, VoiceFetchFn } from './voice.js';

/** Env var holding the self-hosted server base URL. */
export const CHATTERBOX_BASE_URL_ENV_VAR = 'CHATTERBOX_BASE_URL';
/** Optional env var holding a bearer key for the server/proxy. */
export const CHATTERBOX_API_KEY_ENV_VAR = 'CHATTERBOX_API_KEY';

export interface ChatterboxOptions {
  /** Server base URL; falls back to CHATTERBOX_BASE_URL in env. */
  baseUrl?: string;
  /** Optional bearer key; falls back to CHATTERBOX_API_KEY in env. */
  apiKey?: string;
  /** Default voice id; overridable per call. */
  voiceId?: string;
  /** Expressiveness 0–1 passthrough, when the server supports it. */
  exaggeration?: number;
  /** Guidance weight passthrough, when the server supports it. */
  cfgWeight?: number;
  /** Env source; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Injectable fetch (tests stub this; defaults to global fetch). */
  fetchFn?: VoiceFetchFn;
}

interface ChatterboxConfig {
  baseUrl: string;
  apiKey?: string;
  voiceId?: string;
  exaggeration?: number;
  cfgWeight?: number;
  fetchFn: VoiceFetchFn;
}

function resolveConfig(opts: ChatterboxOptions): ChatterboxConfig {
  const env = opts.env ?? process.env;
  const baseUrl = opts.baseUrl ?? env[CHATTERBOX_BASE_URL_ENV_VAR];
  if (!baseUrl) {
    throw new Error(
      `chatterbox voice: missing ${CHATTERBOX_BASE_URL_ENV_VAR}. Point it at your self-hosted ` +
        `Chatterbox server (e.g. http://127.0.0.1:8000), or leave VOICE_TTS_PROVIDER unset to use the mock.`,
    );
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey: opts.apiKey ?? env[CHATTERBOX_API_KEY_ENV_VAR],
    voiceId: opts.voiceId,
    exaggeration: opts.exaggeration,
    cfgWeight: opts.cfgWeight,
    fetchFn: opts.fetchFn ?? ((url, init) => globalThis.fetch(url, init)),
  };
}

function authHeaders(cfg: ChatterboxConfig): Record<string, string> {
  return cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};
}

async function chatterboxRequest(
  cfg: ChatterboxConfig,
  url: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  const res = await cfg.fetchFn(url, {
    ...init,
    headers: { ...authHeaders(cfg), ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${label} failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`);
  }
  return res;
}

/**
 * Chatterbox TTS against a self-hosted server. Configured by base URL;
 * zero calls happen without CHATTERBOX_BASE_URL.
 */
export class ChatterboxTTSProvider implements TTSProvider {
  readonly name = 'chatterbox' as const;
  private readonly cfg: ChatterboxConfig;

  constructor(opts: ChatterboxOptions = {}) {
    this.cfg = resolveConfig(opts);
  }

  async synthesize(text: string, opts: TTSSynthesizeOptions = {}): Promise<TTSResult> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('chatterbox TTS: text must be non-empty');
    if (trimmed.length > 5000) throw new Error('chatterbox TTS: text too long (max 5000 chars)');
    const format = opts.format ?? 'wav';
    if (format !== 'wav' && format !== 'mp3') {
      throw new Error(`chatterbox TTS: unsupported format "${format}" (supported: wav, mp3)`);
    }
    const body: Record<string, unknown> = { text: trimmed, format };
    const voice = opts.voice ?? this.cfg.voiceId;
    if (voice) body.voice = voice;
    if (this.cfg.exaggeration !== undefined) body.exaggeration = this.cfg.exaggeration;
    if (this.cfg.cfgWeight !== undefined) body.cfg_weight = this.cfg.cfgWeight;
    const res = await chatterboxRequest(
      this.cfg,
      `${this.cfg.baseUrl}/tts`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      'chatterbox TTS',
    );
    const contentType = res.headers.get('Content-Type') ?? '';
    // Some servers wrap the audio as JSON base64 instead of raw bytes.
    if (contentType.includes('application/json')) {
      const data = (await res.json()) as { audio_base64?: unknown; audioBase64?: unknown; mime_type?: unknown; mimeType?: unknown };
      const b64 = typeof data.audio_base64 === 'string' ? data.audio_base64 : data.audioBase64;
      if (typeof b64 !== 'string' || !b64) throw new Error('chatterbox TTS: unexpected JSON response (missing audio_base64)');
      const audio = new Uint8Array(Buffer.from(b64, 'base64'));
      if (audio.length === 0) throw new Error('chatterbox TTS: empty audio response');
      const mime = typeof data.mime_type === 'string' ? data.mime_type : data.mimeType;
      return { audio, mimeType: typeof mime === 'string' && mime ? mime : 'audio/wav' };
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length === 0) throw new Error('chatterbox TTS: empty audio response');
    return {
      audio: buf,
      mimeType: contentType.startsWith('audio/') ? contentType.split(';')[0]!.trim() : format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
    };
  }
}

/**
 * List voices served by the self-hosted server: GET /voices. Servers
 * without a voices endpoint (404) yield an empty catalog rather than an
 * error — synthesis can still work with a voice id typed by hand.
 */
export async function listChatterboxVoices(opts: ChatterboxOptions = {}): Promise<VoiceCatalogEntry[]> {
  const cfg = resolveConfig(opts);
  const res = await cfg.fetchFn(`${cfg.baseUrl}/voices`, { method: 'GET', headers: { ...authHeaders(cfg) } });
  if (res.status === 404) return [];
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`chatterbox catalog failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`);
  }
  const data = (await res.json()) as unknown;
  const list: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray((data as { voices?: unknown }).voices)
      ? ((data as { voices: unknown[] }).voices as unknown[])
      : [];
  const entries: VoiceCatalogEntry[] = [];
  for (const raw of list) {
    if (typeof raw === 'string' && raw) {
      entries.push({ id: raw, name: raw, provider: 'chatterbox' });
      continue;
    }
    if (typeof raw !== 'object' || raw === null) continue;
    const v = raw as { id?: unknown; voice_id?: unknown; name?: unknown; description?: unknown; language?: unknown };
    const id = typeof v.id === 'string' ? v.id : typeof v.voice_id === 'string' ? v.voice_id : '';
    if (!id) continue;
    entries.push({
      id,
      name: typeof v.name === 'string' && v.name ? v.name : id,
      provider: 'chatterbox',
      description: typeof v.description === 'string' ? v.description : undefined,
      language: typeof v.language === 'string' ? v.language : undefined,
    });
  }
  return entries;
}
