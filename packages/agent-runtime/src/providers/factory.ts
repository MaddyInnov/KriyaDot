// SPDX-License-Identifier: Apache-2.0

import type { LLMProvider } from '../types.js';
import { AnthropicProvider } from './anthropic.js';
import {
  getCustomProviderPreset,
  getDefaultModel,
  getProviderPreset,
  isDemoMockEnabled,
  resolveApiKey,
  resolveBaseUrl,
} from './catalog.js';
import { MockProvider } from './mock.js';
import { OllamaProvider } from './ollama.js';
import { LlamaCppProvider } from './llamacpp.js';
import { LmStudioProvider } from './lmstudio.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { createAgentCliProvider, parseAgentProviderId } from './agent-cli.js';
import { createAcpEngineProvider } from './acp-engines.js';
import { createNativeCliDriver } from './cli-driver.js';
import { BedrockProvider } from './bedrock.js';
import { VertexProvider } from './vertex.js';
import { CohereProvider } from './cohere.js';
import { AiHordeProvider } from './aihorde.js';
import { OvAnonymousProvider } from './ovh-anonymous.js';
import { keylessChain, type KeylessLane } from './keyless-stack.js';

/**
 * Build an LLMProvider from a catalog preset — or from a `custom-*` provider
 * configured via the Providers settings page (synthesized BYO preset).
 * Reads the key via resolveApiKey (env var, then providers.local.json); never logs it.
 *
 * `opts.apiKey` (Spaces per-turn key override): when supplied, this key is
 * used instead of the configured one. The value stays in memory for the
 * returned provider's lifetime — never persisted or logged.
 *
 * BYO presets (e.g. omnirush, custom-*) ship with an empty baseUrl. If the user
 * has not configured an endpoint yet, this throws a clear configuration error
 * instead of attempting a request to an empty URL.
 */
export function createProvider(providerId: string, opts?: { apiKey?: string }): LLMProvider {
  // Demo mock provider for the video guide / screenshots (DEMO_MOCK=1 only).
  // Scripted two-step turn: announce a file write, then confirm after the
  // approval-gated tool call completes. Clearly labeled "(mock)" in the UI.
  if (providerId === 'demo' && isDemoMockEnabled()) {
    return new MockProvider(
      [
      {
        content: "I'll create that note for you right now.",
        toolCalls: [
          {
            id: 'call_demo_write_1',
            name: 'write_file',
            args: {
              path: 'demo/hello-from-video.txt',
              content:
                'Hello from the all-in-one AI agent platform!\n\nThis file was written by the demo bot during the video guide recording.\n',
            },
          },
        ],
      },
      {
        content:
          'Done — hello-from-video.txt is written to the workspace. Notice what just happened: the platform paused and asked for your approval before writing the file. That is deny-by-default governance in action — sensitive actions always wait for your OK, right here in the chat.',
        },
      ],
      // Pace the demo stream like a real provider (~45ms/word) so
      // screen recordings and screenshots show genuine streaming.
      { tokenDelayMs: 45 },
    );
  }

  // Agent-CLI inference backend: `agent/<cli-id>/<model>` (e.g.
  // `agent/claude-code/sonnet`). Runs a locally installed agent CLI under
  // the user's own subscription login — zero marginal cost, zero API keys
  // handled by KriyaDot. Auth is the CLI's own; the child is spawned without
  // a shell and its output is marked untrusted (see agent-cli.ts).
  // CLIs with a native driver (claude-code, codex) get streaming, tool
  // observation, permission brokering, and session resume (cli-driver.ts);
  // the rest stay on the one-shot provider.
  if (parseAgentProviderId(providerId)) {
    // ACP engines (W9 + ENGINES fleet): ACP-speaking CLIs (Copilot,
    // OpenCode, Antigravity, Grok, Cursor, Gemini, Kimi, Qwen, Droid,
    // Hermes, Cline, DeepSeek harness) route to the ACP-backed provider
    // first; native-driver CLIs (claude-code, codex) keep their drivers.
    const acpProvider = createAcpEngineProvider(providerId);
    if (acpProvider) return acpProvider;
    return createNativeCliDriver(providerId) ?? createAgentCliProvider(providerId);
  }

  const preset = getProviderPreset(providerId) ?? getCustomProviderPreset(providerId);
  if (!preset) {
    throw new Error(
      `Unknown provider "${providerId}". Provider presets live in src/providers/catalog.json — add one there to support a new endpoint, or use a "custom-*" id via the Providers settings page.`,
    );
  }

  // Cloud-native drivers (Octomind parity): Bedrock (SigV4 + Converse)
  // and Vertex (service-account OAuth2 + OpenAI-compatible endpoint)
  // are configured entirely from the environment — no baseUrl/apiKey
  // from the catalog machinery.
  if (preset.api === 'bedrock') {
    return new BedrockProvider();
  }
  if (preset.api === 'vertex') {
    return new VertexProvider();
  }
  // AI Horde (free-LLM stack): async job API with the official anonymous
  // key as the default — a user key (AIHORDE_API_KEY) only raises queue
  // priority. Never blocked on a missing key.
  if (preset.api === 'aihorde') {
    return new AiHordeProvider({ apiKey: opts?.apiKey ?? resolveApiKey(providerId) });
  }
  // OVHcloud anonymous (free-LLM stack): keyless by design — the driver
  // sends no Authorization header and rotates models on 429.
  if (preset.id === 'ovh-anonymous') {
    return new OvAnonymousProvider();
  }

  const baseUrl = resolveBaseUrl(providerId);
  if (!baseUrl) {    const label = preset.byo ? `${preset.name} is a bring-your-own provider: no endpoint is pre-configured. ` : '';
    throw new Error(
      `${label}Open the Providers settings page and enter an API endpoint (base URL) plus your own ${preset.envKey}, then try again. ` +
        `Never use a shared or pooled key.`,
    );
  }

  // Codex bridge: the ChatGPT OAuth token does not work with api.openai.com
  // (it needs the Codex backend or CLI). Shell out to the `codex` CLI directly,
  // which uses the user's own login. The model is selected per-request via the UI.
  // The native driver (streaming JSONL, tool observation, session resume)
  // is preferred; falls back to the one-shot provider.
  if (preset.bridge === 'codex') {
    const defaultModel = getDefaultModel(preset.id) || 'gpt-5';
    return createNativeCliDriver(`agent/codex/${defaultModel}`) ?? createAgentCliProvider(`agent/codex/${defaultModel}`);
  }

  const apiKey = opts?.apiKey ?? resolveApiKey(providerId);
  // Keyless presets (free-LLM stack: LLM7 anonymous): no API key is sent
  // at all when the user has not supplied one. If the user DID supply a
  // key/token for the lane, fall through to the normal bearer path.
  if (preset.keyless && !apiKey) {
    return new OpenAICompatibleProvider({
      providerId: preset.id,
      baseUrl,
      apiKey: '',
      omitAuthHeader: true,
      extraHeaders: preset.extraHeaders,
      defaultModel: getDefaultModel(preset.id),
    });
  }
  // Local providers (Ollama, managed llama.cpp, LM Studio): no API key,
  // ever. Skip the key requirement. The preset's replyTimeoutMs (ENGINES
  // pack) becomes the provider's default local reply timeout.
  if (preset.local) {
    if (preset.api === 'ollama') {
      return new OllamaProvider({ replyTimeoutMs: preset.replyTimeoutMs });
    }
    if (preset.api === 'llamacpp') {
      return new LlamaCppProvider({ replyTimeoutMs: preset.replyTimeoutMs });
    }
    if (preset.id === 'lmstudio') {
      return new LmStudioProvider({ replyTimeoutMs: preset.replyTimeoutMs });
    }
    // Future local providers fall through to the openai-compatible driver
    // with a dummy key (local endpoints ignore auth).
    return new OpenAICompatibleProvider({
      providerId: preset.id,
      baseUrl,
      apiKey: 'local-no-key-needed',
      extraHeaders: preset.extraHeaders,
      defaultModel: getDefaultModel(preset.id),
    });
  }
  if (!apiKey) {
    if (preset.bridge) {
      const label = preset.bridge === 'claude' ? 'Claude Code' : preset.bridge === 'opencode' ? 'OpenCode' : 'Codex CLI';
      throw new Error(
        `${preset.name} is not connected: click Connect in the Providers settings page to use your ${label} login. ` +
          `The token is read from your CLI's own credential file at request time and never stored.`,
      );
    }
    throw new Error(
      `Missing ${preset.envKey}: set the ${preset.envKey} environment variable or add it via the Providers settings page (stored in providers.local.json, 0600).`,
    );
  }

  if (preset.api === 'cohere') {
    // Cohere's native v2 API is not OpenAI-shaped — dedicated driver.
    return new CohereProvider({ baseUrl, apiKey });
  }
  if (preset.api === 'anthropic') {
    // Subscription bridges authenticate with the user's OAuth token, which the
    // Messages API expects as a Bearer credential (Claude Code wire format),
    // not x-api-key.
    return new AnthropicProvider({
      baseUrl,
      apiKey,
      authStyle: preset.bridge === 'claude' ? 'bearer' : 'api-key',
      // Keep rate-limit snapshots per catalog id (claude-subscription ≠ anthropic).
      providerId: preset.id,
    });
  }
  return new OpenAICompatibleProvider({
    providerId: preset.id,
    baseUrl,
    apiKey,
    extraHeaders: preset.extraHeaders,
    defaultModel: getDefaultModel(preset.id),
  });
}

// ---------------------------------------------------------------------------
// Zero-setup keyless fallback (free-LLM stack)
//
// A fresh install has NO provider keys. Rather than failing the first
// turn with "Missing GROQ_API_KEY", the runtime can fall back to the
// keyless chain (keyless-stack.ts): local Ollama → OVHcloud anonymous →
// LLM7 anonymous → AI Horde (chat-only). The fallback engages ONLY when
// the requested provider cannot be constructed for a *configuration*
// reason (missing key / missing BYO endpoint) — never for unknown
// providers, bridge-not-connected, or runtime errors — and can be
// disabled with KRIYADOT_KEYLESS_FALLBACK=0. It never applies when the
// caller supplied an explicit per-turn key (opts.apiKey).
// ---------------------------------------------------------------------------

export interface KeylessFallbackResolution {
  provider: LLMProvider;
  providerId: string;
  model: string;
  lane: KeylessLane;
}

/** True when `err` is a createProvider configuration-missing failure. */
export function isProviderConfigError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /^Missing [A-Z0-9_]+:/.test(msg) || /enter an API endpoint \(base URL\)/.test(msg);
}

export function keylessFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KRIYADOT_KEYLESS_FALLBACK !== '0';
}

/**
 * First keyless lane that constructs, in chain order (synchronous —
 * construction of every lane is pure). Returns null when the fallback
 * is disabled. NOTE: construction success is not viability for the
 * local lane (Ollama may not be running) — prefer
 * resolveViableKeylessProvider() on async paths.
 */
export function resolveKeylessFallback(opts: { toolUse?: boolean } = {}): KeylessFallbackResolution | null {
  if (!keylessFallbackEnabled()) return null;
  for (const lane of keylessChain({ toolUse: opts.toolUse })) {
    try {
      const provider = createProvider(lane.providerId);
      return { provider, providerId: lane.providerId, model: lane.defaultModel ?? getDefaultModel(lane.providerId) ?? 'default', lane };
    } catch {
      // Lane not constructible in this environment — try the next one.
    }
  }
  return null;
}

/**
 * Chain walk with a viability probe for the local lane: Ollama is
 * skipped when nothing answers on its endpoint (the common fresh-
 * install case on a machine without Ollama), so the turn lands on the
 * OVHcloud anonymous lane instead of dying with ECONNREFUSED. Cloud
 * lanes are not probed (their failure modes surface as ordinary
 * provider errors and the provider-health failover handles repeats).
 */
export async function resolveViableKeylessProvider(
  opts: { toolUse?: boolean; probeTimeoutMs?: number } = {},
): Promise<KeylessFallbackResolution | null> {
  if (!keylessFallbackEnabled()) return null;
  const probeTimeoutMs = opts.probeTimeoutMs ?? 1500;
  for (const lane of keylessChain({ toolUse: opts.toolUse })) {
    let provider: LLMProvider;
    try {
      provider = createProvider(lane.providerId);
    } catch {
      continue;
    }
    if (lane.providerId === 'ollama') {
      // Ollama's listModels swallows connection errors into [] — so
      // viability means "a server answered AND has at least one model
      // pulled" (a model-less Ollama cannot serve the lane's default
      // model either, so skipping it is correct, not just cautious).
      const viable = await Promise.race([
        provider
          .listModels()
          .then((models) => models.length > 0)
          .catch(() => false),
        new Promise<boolean>((res) => setTimeout(() => res(false), probeTimeoutMs)),
      ]);
      if (!viable) continue;
    }
    return { provider, providerId: lane.providerId, model: lane.defaultModel ?? getDefaultModel(lane.providerId) ?? 'default', lane };
  }
  return null;
}

/**
 * createProvider + keyless fallback in one call (synchronous lanes —
 * see resolveViableKeylessProvider for the probed variant). Rethrows
 * the original error when the fallback does not apply.
 */
export function createProviderWithKeylessFallback(
  providerId: string,
  opts?: { apiKey?: string; toolUse?: boolean },
): { provider: LLMProvider; providerId: string; model?: string; fellBack: boolean; lane?: KeylessLane } {
  try {
    return { provider: createProvider(providerId, opts), providerId, fellBack: false };
  } catch (err) {
    if (opts?.apiKey || !isProviderConfigError(err)) throw err;
    const fb = resolveKeylessFallback({ toolUse: opts?.toolUse });
    if (!fb) throw err;
    return { provider: fb.provider, providerId: fb.providerId, model: fb.model, fellBack: true, lane: fb.lane };
  }
}
