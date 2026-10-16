// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadBridgeToken } from './cli-bridge.js';

// Statically imported so single-file binaries (bun --compile) carry the
// catalog even though import.meta.url no longer points at a real directory.
// The filesystem copy (shipped next to dist/) still wins when present, so
// editing catalog.json on a dev machine takes effect without a rebuild.
import bundledCatalog from './catalog.json' with { type: 'json' };

export interface ProviderModelPreset {
  id: string;
  name: string;
  default?: boolean;
  contextLength?: number;
  /** True when the model is currently in the provider's free tier/rotation (roster may change; live fetch is authoritative). */
  free?: boolean;
}

export interface ProviderPreset {
  id: string;
  name: string;
  /** Wire protocol driver to use. */
  api: 'openai-compatible' | 'anthropic' | 'ollama' | 'llamacpp';
  /** Base URL of the chat-completions (or messages) API. Empty for BYO presets until the user configures it. */
  baseUrl: string;
  /** Env var holding the user's API key. */
  envKey: string;
  /** Bring-your-own: no pre-configured endpoint or credentials; the user points this at their own access. */
  byo?: boolean;
  /**
   * Local provider (Octop parity): runs on the user's own machine, no API
   * key ever required. Skips the apiKey requirement in createProvider and
   * reports `configured: true` in the provider list.
   */
  local?: boolean;
  /**
   * Subscription/CLI bridge: the API key is the user's own CLI login token,
   * loaded consent-gated from the CLI's credential file at request time
   * (see cli-bridge.ts). Never falls back to env vars or the local key file.
   */
  bridge?: 'claude' | 'codex' | 'opencode';
  /** When true, listModels() is fetched live from the provider. */
  liveModels?: boolean;
  models: ProviderModelPreset[];
  extraHeaders?: Record<string, string>;
  notes?: string;
}

interface CatalogFile {
  providers: Record<string, ProviderPreset>;
}

let cachedCatalog: CatalogFile | null = null;

/** Absolute path of the shipped catalog.json (works from src/ and dist/). */
export function catalogFilePath(): string {
  return fileURLToPath(new URL('./catalog.json', import.meta.url));
}

function loadCatalog(): CatalogFile {
  if (!cachedCatalog) {
    try {
      const raw = readFileSync(catalogFilePath(), 'utf8');
      cachedCatalog = JSON.parse(raw) as CatalogFile;
    } catch {
      // Single-binary build: import.meta.url is virtual, fall back to the
      // bundled copy.
      cachedCatalog = bundledCatalog as CatalogFile;
    }
  }
  return cachedCatalog;
}

/** For tests: drop the cached catalog so a modified file is re-read. */
export function resetCatalogCache(): void {
  cachedCatalog = null;
}

export function listProviderPresets(): ProviderPreset[] {
  const presets = Object.values(loadCatalog().providers);
  if (isDemoMockEnabled()) presets.push(DEMO_PRESET);
  return presets;
}

export function getProviderPreset(id: string): ProviderPreset | undefined {
  if (id === DEMO_PRESET.id && isDemoMockEnabled()) return DEMO_PRESET;
  return loadCatalog().providers[id];
}

/**
 * Demo provider for the video guide and screenshots. Only visible when
 * DEMO_MOCK=1 is set. Streams scripted responses through MockProvider —
 * no API keys, no network calls, zero cost. Never enable in production;
 * the preset is clearly labeled "(mock)" in the UI.
 */
const DEMO_PRESET: ProviderPreset = {
  id: 'demo',
  name: 'Demo (mock — no API key)',
  api: 'openai-compatible',
  baseUrl: 'mock://demo',
  envKey: 'DEMO_MOCK',
  liveModels: false,
  models: [{ id: 'demo-model', name: 'Demo model', default: true }],
};

/** True when the demo mock provider is enabled via DEMO_MOCK=1. */
export function isDemoMockEnabled(): boolean {
  return process.env.DEMO_MOCK === '1';
}

const CUSTOM_ID_PATTERN = /^custom-[a-z0-9][a-z0-9-]*$/;

/** Env var under which a custom provider's key is stored (mirrors the API layer). */
export function customEnvKey(providerId: string): string {
  return `CUSTOM_${providerId.replace(/^custom-/, '').replace(/-/g, '_').toUpperCase()}_API_KEY`;
}

/**
 * Synthesize a BYO preset for a `custom-*` provider id from the local
 * overrides file (written by the Providers settings page). Returns undefined
 * for non-custom ids or when nothing is stored.
 */
export function getCustomProviderPreset(providerId: string): ProviderPreset | undefined {
  if (!CUSTOM_ID_PATTERN.test(providerId)) return undefined;
  const envKey = customEnvKey(providerId);
  const local = readLocalOverrides();
  const baseUrlRaw = local[`${envKey}_BASE_URL`];
  const headersRaw = local[`${envKey}_HEADERS`];
  let extraHeaders: Record<string, string> | undefined;
  if (typeof headersRaw === 'string') {
    try {
      const parsed = JSON.parse(headersRaw) as unknown;
      if (parsed && typeof parsed === 'object') extraHeaders = parsed as Record<string, string>;
    } catch {
      // ignore malformed headers
    }
  }
  return {
    id: providerId,
    name: providerId,
    api: 'openai-compatible',
    baseUrl: typeof baseUrlRaw === 'string' ? baseUrlRaw : '',
    envKey,
    byo: true,
    models: [],
    extraHeaders,
    notes: 'Custom OpenAI-compatible endpoint configured via the Providers settings page.',
  };
}

/** Catalog preset first, synthesized custom preset second. */
function resolvePreset(providerId: string): ProviderPreset | undefined {
  return getProviderPreset(providerId) ?? getCustomProviderPreset(providerId);
}

export function getDefaultModel(providerId: string): string | undefined {
  const preset = getProviderPreset(providerId);
  if (!preset || preset.models.length === 0) return undefined;
  return preset.models.find((m) => m.default)?.id ?? preset.models[0]?.id;
}

/**
 * Path of the local provider overrides file. Written by the API (0600) when a
 * user saves keys/endpoints in the Providers settings page. Overridable via
 * PROVIDERS_FILE (used by tests).
 */
export function providersLocalFilePath(): string {
  if (process.env.PROVIDERS_FILE) return process.env.PROVIDERS_FILE;
  return fileURLToPath(new URL('../../data/providers.local.json', import.meta.url));
}

function readLocalOverrides(): Record<string, unknown> {
  const file = providersLocalFilePath();
  try {
    if (!existsSync(file)) return {};
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Resolve the API key for a provider: env var first, then providers.local.json
 * (keyed by envKey, e.g. { "GROQ_API_KEY": "..." }). Bridge presets
 * (claude-subscription / codex-subscription / opencode-subscription) resolve consent-gated from the
 * user's own CLI login instead — never env, never disk. Never logs the key.
 */
export function resolveApiKey(providerId: string): string | undefined {
  const preset = resolvePreset(providerId);
  if (!preset) return undefined;
  if (preset.bridge) {
    // Consent-gated: undefined until the user clicks Connect in the Providers
    // UI. The token is read from the CLI's credential file at request time and
    // lives in memory only.
    return loadBridgeToken(preset.bridge);
  }
  const fromEnv = process.env[preset.envKey];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const local = readLocalOverrides();
  const fromFile = local[preset.envKey];
  return typeof fromFile === 'string' && fromFile.length > 0 ? fromFile : undefined;
}

/**
 * Resolve the base URL for a provider. BYO presets (e.g. omnirush) ship with
 * an empty baseUrl; the user supplies their own endpoint via the Providers
 * settings page, which the API persists to providers.local.json as
 * "<ENV_KEY>_BASE_URL" (e.g. "OMNIRUSH_API_KEY_BASE_URL").
 */
export function resolveBaseUrl(providerId: string): string {
  const preset = resolvePreset(providerId);
  if (!preset) return '';
  if (preset.baseUrl && preset.baseUrl.length > 0) return preset.baseUrl;
  const local = readLocalOverrides();
  const key = `${preset.envKey}_BASE_URL`;
  const fromFile = local[key];
  return typeof fromFile === 'string' ? fromFile : '';
}

/** Env var consulted by assertModelAllowed. '1' or 'true' (any case) enables the guard. */
export const FREE_MODELS_ONLY_ENV_VAR = 'FREE_MODELS_ONLY';

/**
 * True when the model is free to call:
 * - the catalog preset marks the model `free: true` (e.g. opencode-zen's
 *   pinned free roster; the live /models fetch stays authoritative), or
 * - the model id ends with ':free' (OpenRouter free tier), or
 * - the model id ends with '-free' (Zen free models).
 *
 * Custom (`custom-*`) presets have no catalog models; the suffix rules
 * still apply to them.
 */
export function isFreeModel(providerId: string, modelId: string): boolean {
  const preset = resolvePreset(providerId);
  // Local providers (Ollama): on-machine inference, $0 per token — always free.
  if (preset?.local) return true;
  if (preset?.models.some((m) => m.id === modelId && m.free === true)) return true;
  return modelId.endsWith(':free') || modelId.endsWith('-free');
}

/**
 * Fail-closed guard for the FREE_MODELS_ONLY kill switch. When the env var
 * is '1'/'true' and the model is not free (see isFreeModel), throws an
 * Error naming the model and the guard. No-op when the guard is off or the
 * model is free.
 */
export function assertModelAllowed(providerId: string, modelId: string): void {
  const raw = process.env[FREE_MODELS_ONLY_ENV_VAR];
  const enabled = raw === '1' || (typeof raw === 'string' && raw.toLowerCase() === 'true');
  if (!enabled) return;
  if (isFreeModel(providerId, modelId)) return;
  throw new Error(
    `${FREE_MODELS_ONLY_ENV_VAR} is enabled (${FREE_MODELS_ONLY_ENV_VAR}=${raw}): ` +
      `model "${providerId}/${modelId}" is not a free model, so this run is blocked. ` +
      `Pick a free model (catalog free:true, or an id ending in ":free" / "-free"), ` +
      `or unset ${FREE_MODELS_ONLY_ENV_VAR}.`,
  );
}
