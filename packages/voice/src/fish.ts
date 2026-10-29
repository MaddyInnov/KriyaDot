// SPDX-License-Identifier: Apache-2.0
// Fish Audio TTS provider + model/voice catalog, over the public API:
//
//   TTS:     POST https://api.fish.audio/v1/tts
//            (Authorization: Bearer <key>; JSON { text, reference_id,
//            format, normalize, latency }) → raw audio bytes
//   Catalog: GET  https://api.fish.audio/model?title=<q>&page_size=<n>
//            → { total, items: [{ _id, title, description, … }] }
//
// On Fish, a "voice" is a model: reference_id selects it. There is no
// universal default voice, so the default reference id is optional —
// omit it and the service default applies; set one per provider
// (opts.referenceId) or per call (TTSSynthesizeOptions.voice).
//
// Key-gated by design: FISH_API_KEY is read from env (or passed
// explicitly) and never logged. All HTTP goes through an injectable
// fetch so tests stub everything.

import type { VoiceCatalogEntry } from './catalog.js';
import type { TTSProvider, TTSResult, TTSSynthesizeOptions, VoiceFetchFn } from './voice.js';

/** Fish Audio API base. */
export const FISH_BASE_URL = 'https://api.fish.audio';

/** Env var holding the Fish Audio API key. */
export const FISH_API_KEY_ENV_VAR = 'FISH_API_KEY';

export interface FishOptions {
  /** API key; falls back to FISH_API_KEY in env. Never logged. */
  apiKey?: string;
  /** Override for tests/proxies; defaults to FISH_BASE_URL. */
  baseUrl?: string;
  /** Default voice/model reference id; overridable per call. */
  referenceId?: string;
  /** 'normal' (default) or 'balanced' latency mode. */
  latency?: 'normal' | 'balanced';
  /** Env source; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Injectable fetch (tests stub this; defaults to global fetch). */
  fetchFn?: VoiceFetchFn;
}

interface FishConfig {
  apiKey: string;
  baseUrl: string;
  referenceId?: string;
  latency: 'normal' | 'balanced';
  fetchFn: VoiceFetchFn;
}

function resolveConfig(opts: FishOptions): FishConfig {
  const env = opts.env ?? process.env;
  const apiKey = opts.apiKey ?? env[FISH_API_KEY_ENV_VAR];
  if (!apiKey) {
    throw new Error(
      `fish voice: missing ${FISH_API_KEY_ENV_VAR}. Set the ${FISH_API_KEY_ENV_VAR} ` +
        `environment variable (or pass apiKey explicitly), or leave VOICE_TTS_PROVIDER unset to use the mock.`,
    );
  }
  return {
    apiKey,
    baseUrl: (opts.baseUrl ?? FISH_BASE_URL).replace(/\/+$/, ''),
    referenceId: opts.referenceId,
    latency: opts.latency ?? 'normal',
    fetchFn: opts.fetchFn ?? ((url, init) => globalThis.fetch(url, init)),
  };
}

async function fishRequest(cfg: FishConfig, url: string, init: RequestInit, label: string): Promise<Response> {
  const res = await cfg.fetchFn(url, {
    ...init,
    headers: { Authorization: `Bearer ${cfg.apiKey}`, ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${label} failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`);
  }
  return res;
}

/**
 * Fish Audio TTS. Key-gated; zero calls happen without FISH_API_KEY.
 */
export class FishTTSProvider implements TTSProvider {
  readonly name = 'fish' as const;
  private readonly cfg: FishConfig;

  constructor(opts: FishOptions = {}) {
    this.cfg = resolveConfig(opts);
  }

  async synthesize(text: string, opts: TTSSynthesizeOptions = {}): Promise<TTSResult> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('fish TTS: text must be non-empty');
    if (trimmed.length > 5000) throw new Error('fish TTS: text too long (max 5000 chars)');
    const format = opts.format ?? 'mp3';
    if (format !== 'wav' && format !== 'mp3') {
      throw new Error(`fish TTS: unsupported format "${format}" (supported: wav, mp3)`);
    }
    const referenceId = opts.voice ?? this.cfg.referenceId;
    const body: Record<string, unknown> = {
      text: trimmed,
      format,
      latency: this.cfg.latency,
      normalize: true,
    };
    if (referenceId) body.reference_id = referenceId;
    const res = await fishRequest(
      this.cfg,
      `${this.cfg.baseUrl}/v1/tts`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      'fish TTS',
    );
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length === 0) throw new Error('fish TTS: empty audio response');
    const fromHeader = res.headers.get('Content-Type') ?? '';
    return {
      audio: buf,
      mimeType: fromHeader.startsWith('audio/') ? fromHeader.split(';')[0]!.trim() : format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
    };
  }

  /** Search public voice models (GET /model). */
  async searchModels(query = '', pageSize?: number): Promise<VoiceCatalogEntry[]> {
    return searchFishModels(
      { apiKey: this.cfg.apiKey, baseUrl: this.cfg.baseUrl, fetchFn: this.cfg.fetchFn },
      { query, pageSize },
    );
  }
}

interface FishModelRaw {
  _id?: unknown;
  title?: unknown;
  description?: unknown;
  cover_image?: unknown;
  tags?: unknown;
  type?: unknown;
}

function mapModel(raw: FishModelRaw): VoiceCatalogEntry | null {
  if (typeof raw._id !== 'string' || !raw._id) return null;
  const labels: Record<string, string> = {};
  if (Array.isArray(raw.tags)) {
    const tags = raw.tags.filter((t): t is string => typeof t === 'string' && t.length > 0);
    if (tags.length > 0) labels['tags'] = tags.join(', ');
  }
  return {
    id: raw._id,
    name: typeof raw.title === 'string' && raw.title ? raw.title : raw._id,
    provider: 'fish',
    description: typeof raw.description === 'string' ? raw.description : undefined,
    imageUrl: typeof raw.cover_image === 'string' ? raw.cover_image : undefined,
    category: typeof raw.type === 'string' ? raw.type : undefined,
    labels: Object.keys(labels).length > 0 ? labels : undefined,
  };
}

/**
 * Search Fish Audio voice models: GET /model?title=<q>. An empty query
 * lists the top public models. The API paginates; we take one page.
 */
export async function searchFishModels(
  opts: FishOptions = {},
  search: { query?: string; pageSize?: number; pageNumber?: number } = {},
): Promise<VoiceCatalogEntry[]> {
  const cfg = resolveConfig(opts);
  const params = new URLSearchParams();
  params.set('page_size', String(Math.min(100, Math.max(1, search.pageSize ?? 24))));
  params.set('page_number', String(Math.max(1, search.pageNumber ?? 1)));
  params.set('sort_by', 'task_count');
  if (search.query?.trim()) params.set('title', search.query.trim());
  const res = await fishRequest(cfg, `${cfg.baseUrl}/model?${params.toString()}`, { method: 'GET' }, 'fish catalog');
  const data = (await res.json()) as { items?: unknown };
  if (!Array.isArray(data.items)) throw new Error('fish catalog: unexpected response shape (missing items)');
  return data.items.map((m) => mapModel(m as FishModelRaw)).filter((m): m is VoiceCatalogEntry => m !== null);
}
