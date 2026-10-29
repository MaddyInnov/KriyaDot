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
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { createAgentCliProvider, parseAgentProviderId } from './agent-cli.js';
import { createCopilotAcpProvider } from './acp-engines.js';
import { createNativeCliDriver } from './cli-driver.js';
import { BedrockProvider } from './bedrock.js';
import { VertexProvider } from './vertex.js';

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
    return new MockProvider([
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
    ]);
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
    // ACP engines (W9): GitHub Copilot CLI speaks ACP, not a native
    // streaming protocol — route it to the ACP-backed provider first.
    const acpProvider = createCopilotAcpProvider(providerId);
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
  // Local providers (Ollama, managed llama.cpp): no API key, ever. Skip the key requirement.
  if (preset.local) {
    if (preset.api === 'ollama') {
      return new OllamaProvider();
    }
    if (preset.api === 'llamacpp') {
      return new LlamaCppProvider();
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
