// SPDX-License-Identifier: Apache-2.0
// Voice catalog: one normalized shape for "voices a user can pick",
// across providers whose native catalog APIs look nothing alike.
//
//   - ElevenLabs: GET /v1/voices (your voices) and GET /v1/shared-voices
//     (the public library, used when a search query is present)
//   - Fish Audio: GET /model?title=<q> (public model/voice search)
//   - Chatterbox: GET /voices on the self-hosted server (local filter)
//   - OpenAI / Groq: no catalog API — the built-in voice lists are
//     served statically from the provider modules
//   - mock / system: no pickable remote catalog (empty result)
//
// All network access goes through an injectable fetch so tests stub
// everything — no test may reach a real catalog endpoint.

import { listChatterboxVoices, type ChatterboxOptions } from './chatterbox.js';
import {
  listElevenLabsVoices,
  searchElevenLabsSharedVoices,
  type ElevenLabsOptions,
} from './elevenlabs.js';
import { searchFishModels, type FishOptions } from './fish.js';
import { DEFAULT_GROQ_TTS_VOICE } from './groq.js';
import { OPENAI_TTS_VOICES } from './openai.js';
import type { VoiceFetchFn } from './voice.js';

/** One pickable voice, normalized across providers. */
export interface VoiceCatalogEntry {
  /** Provider-scoped voice id — pass this back as the TTS voice. */
  id: string;
  name: string;
  /** Provider id the voice belongs to ('elevenlabs', 'fish', …). */
  provider: string;
  description?: string;
  /** Short audio preview URL, when the provider publishes one. */
  previewUrl?: string;
  /** Cover/avatar image URL, when the provider publishes one. */
  imageUrl?: string;
  category?: string;
  /** Free-form provider labels (accent, age, gender, use case, …). */
  labels?: Record<string, string>;
  language?: string;
}

export interface VoiceCatalogSearchOptions {
  /** Free-text search; empty → the provider's default listing. */
  query?: string;
  /** Preferred language filter (applied locally where the API can't). */
  language?: string;
  /** Page size hint for providers that paginate (default 24, max 100). */
  pageSize?: number;
}

export interface VoiceCatalogClientOptions {
  env?: NodeJS.ProcessEnv;
  fetchFn?: VoiceFetchFn;
  elevenLabs?: ElevenLabsOptions;
  fish?: FishOptions;
  chatterbox?: ChatterboxOptions;
}

/** Providers with a searchable/pickable catalog. */
export const VOICE_CATALOG_PROVIDERS = [
  'elevenlabs',
  'fish',
  'chatterbox',
  'openai',
  'groq',
  'mock',
  'system',
] as const;
export type VoiceCatalogProviderId = (typeof VOICE_CATALOG_PROVIDERS)[number];

function matchesQuery(entry: VoiceCatalogEntry, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const hay = [entry.id, entry.name, entry.description ?? '', entry.category ?? '', entry.language ?? '']
    .join(' ')
    .toLowerCase();
  return hay.includes(needle);
}

function matchesLanguage(entry: VoiceCatalogEntry, lang: string | undefined): boolean {
  if (!lang) return true;
  const want = lang.toLowerCase();
  if (entry.language?.toLowerCase().startsWith(want)) return true;
  const labelLang = entry.labels?.['language'] ?? entry.labels?.['accent_language'];
  return typeof labelLang === 'string' && labelLang.toLowerCase().includes(want);
}

/**
 * Search (or list) the voice catalog for one provider. Throws a clear
 * error for unknown providers and for key-gated providers with no key
 * configured — the API route maps those to 400s.
 */
export async function searchVoiceCatalog(
  provider: string,
  search: VoiceCatalogSearchOptions = {},
  client: VoiceCatalogClientOptions = {},
): Promise<VoiceCatalogEntry[]> {
  const id = provider.trim().toLowerCase();
  const query = search.query?.trim() ?? '';
  const env = client.env;
  const fetchFn = client.fetchFn;
  switch (id) {
    case 'elevenlabs': {
      const opts: ElevenLabsOptions = { ...client.elevenLabs, env, fetchFn };
      const entries = query
        ? await searchElevenLabsSharedVoices(opts, { query, pageSize: search.pageSize, language: search.language })
        : await listElevenLabsVoices(opts);
      return entries.filter((e) => matchesLanguage(e, search.language));
    }
    case 'fish': {
      const opts: FishOptions = { ...client.fish, env, fetchFn };
      return searchFishModels(opts, { query, pageSize: search.pageSize });
    }
    case 'chatterbox': {
      const opts: ChatterboxOptions = { ...client.chatterbox, env, fetchFn };
      const entries = await listChatterboxVoices(opts);
      return entries.filter((e) => matchesQuery(e, query) && matchesLanguage(e, search.language));
    }
    case 'openai':
      return OPENAI_TTS_VOICES.map((voice) => ({
        id: voice,
        name: voice,
        provider: 'openai',
        category: 'built-in',
      })).filter((e) => matchesQuery(e, query));
    case 'groq':
      return [{ id: DEFAULT_GROQ_TTS_VOICE, name: DEFAULT_GROQ_TTS_VOICE, provider: 'groq', category: 'built-in' }].filter(
        (e) => matchesQuery(e, query),
      );
    case 'mock':
    case 'system':
      // No remote catalog: the mock has no voices to pick and system
      // voices depend on the host OS, not on a searchable service.
      return [];
    default:
      throw new Error(
        `unknown voice catalog provider "${provider}" (expected one of ${VOICE_CATALOG_PROVIDERS.join(', ')})`,
      );
  }
}
