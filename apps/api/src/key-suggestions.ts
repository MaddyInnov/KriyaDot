// SPDX-License-Identifier: Apache-2.0
// Helper key suggestions (§1.7): "the one key that unlocks the most".
//
// Ranks MISSING env keys by how much they would unlock:
//   - every provider-catalog preset whose envKey is absent unlocks that
//     provider and its models;
//   - a fixed set of non-provider surfaces (voice synthesis, keyed web
//     search, messaging channels) unlocks named features.
// Scoring is deterministic: provider keys score 10 + min(modelCount, 10);
// surfaces carry fixed weights (voice 8, search 6, channels 5). Ties break
// by key name so the ranking never shuffles between calls. Keys already
// present are never suggested.
//
//   GET /settings/key-suggestions → { ok, suggestions: [{ key, unlocks, provider?, score }] }
//
// HOST WIRING (index.ts):
//   app.use('/api/settings/key-suggestions', createKeySuggestionsRouter());

import express, { type Router } from 'express';
import { listProviderPresets, type ProviderPreset } from '@mvp/agent-runtime';

export interface KeySuggestion {
  /** Env var to set, e.g. "OPENAI_API_KEY". */
  key: string;
  /** Human-readable features this key unlocks. */
  unlocks: string[];
  /** Provider preset id when this key belongs to a catalog provider. */
  provider?: string;
  /** Deterministic rank score (higher = unlocks more). */
  score: number;
}

export interface KeySurface {
  key: string;
  unlocks: string[];
  weight: number;
}

/** Non-catalog surfaces a single key unlocks (voice / search / channels). */
export const DEFAULT_KEY_SURFACES: readonly KeySurface[] = [
  { key: 'ELEVENLABS_API_KEY', unlocks: ['Voice: ElevenLabs text-to-speech voices'], weight: 8 },
  { key: 'FISH_API_KEY', unlocks: ['Voice: Fish Audio text-to-speech voices'], weight: 8 },
  { key: 'BRAVE_API_KEY', unlocks: ['Web search: Brave provider for web_search (set SEARCH_PROVIDER=brave)'], weight: 6 },
  { key: 'TAVILY_API_KEY', unlocks: ['Web search: Tavily provider for web_search (set SEARCH_PROVIDER=tavily)'], weight: 6 },
  { key: 'TELEGRAM_BOT_TOKEN', unlocks: ['Channel: Telegram messaging gateway'], weight: 5 },
  { key: 'DISCORD_BOT_TOKEN', unlocks: ['Channel: Discord messaging gateway'], weight: 5 },
  { key: 'SLACK_BOT_TOKEN', unlocks: ['Channel: Slack messaging gateway'], weight: 5 },
  { key: 'MQTT_URL', unlocks: ['Channel: MQTT messaging gateway'], weight: 5 },
  { key: 'TICKTICK_ACCESS_TOKEN', unlocks: ['Tool: TickTick task list + create'], weight: 4 },
  { key: 'HIGHLEVEL_API_KEY', unlocks: ['Tool: HighLevel CRM contacts'], weight: 4 },
  { key: 'DIFY_API_KEY', unlocks: ['Tool: Dify app runs (also needs DIFY_API_URL)'], weight: 4 },
];

export interface RankKeySuggestionsInput {
  providers: Array<Pick<ProviderPreset, 'id' | 'name' | 'envKey' | 'local' | 'byo' | 'models'>>;
  env: Record<string, string | undefined>;
  surfaces?: readonly KeySurface[];
}

function present(env: Record<string, string | undefined>, key: string): boolean {
  return typeof env[key] === 'string' && env[key]!.trim() !== '';
}

/** Pure ranking: fixture-friendly, fully deterministic. */
export function rankKeySuggestions(input: RankKeySuggestionsInput): KeySuggestion[] {
  const suggestions: KeySuggestion[] = [];
  const claimed = new Set<string>();

  for (const provider of input.providers) {
    if (!provider.envKey || provider.local) continue; // local providers need no key
    if (present(input.env, provider.envKey)) continue;
    if (claimed.has(provider.envKey)) continue;
    claimed.add(provider.envKey);
    const modelCount = provider.models?.length ?? 0;
    suggestions.push({
      key: provider.envKey,
      provider: provider.id,
      unlocks: [
        `Provider: ${provider.name}`,
        ...(modelCount > 0 ? [`${modelCount} model${modelCount === 1 ? '' : 's'} on ${provider.name}`] : []),
      ],
      score: 10 + Math.min(modelCount, 10),
    });
  }

  for (const surface of input.surfaces ?? DEFAULT_KEY_SURFACES) {
    if (present(input.env, surface.key)) continue;
    if (claimed.has(surface.key)) {
      // A catalog provider already claims this key — merge the unlocks.
      const existing = suggestions.find((s) => s.key === surface.key);
      if (existing) {
        existing.unlocks.push(...surface.unlocks);
        existing.score += surface.weight;
      }
      continue;
    }
    claimed.add(surface.key);
    suggestions.push({ key: surface.key, unlocks: [...surface.unlocks], score: surface.weight });
  }

  suggestions.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  return suggestions;
}

export interface KeySuggestionsRouterDeps {
  getProviders?: () => RankKeySuggestionsInput['providers'];
  getEnv?: () => Record<string, string | undefined>;
  surfaces?: readonly KeySurface[];
}

export function createKeySuggestionsRouter(deps: KeySuggestionsRouterDeps = {}): Router {
  const router = express.Router();
  router.get('/', (_req, res) => {
    const suggestions = rankKeySuggestions({
      providers: deps.getProviders ? deps.getProviders() : listProviderPresets(),
      env: deps.getEnv ? deps.getEnv() : process.env,
      ...(deps.surfaces ? { surfaces: deps.surfaces } : {}),
    });
    res.json({ ok: true, suggestions });
  });
  return router;
}
