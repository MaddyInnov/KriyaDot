// SPDX-License-Identifier: Apache-2.0
/**
 * Built-in ACP engine presets (W9 engines pack).
 *
 * Some coding-agent CLIs are not driven through a native streaming driver
 * (cli-driver.ts) but through the Agent Client Protocol: the CLI runs as a
 * stdio ACP agent and KriyaDot speaks to it with the existing ACP machinery
 * (acp.ts `AcpClient`, acp-sessions.ts `AcpSessionManager`). This module is
 * the preset registry for those engines — binary name, ACP spawn args,
 * sign-in wiring — so a bot can select one anywhere the other CLI engines
 * are selected:
 *
 * - Bot engine selection: provider id `agent/copilot/<model>` is routed by
 *   factory.ts to `CopilotAcpProvider` (below), exactly like
 *   `agent/claude-code/<model>` routes to the native driver.
 * - ACP panel: `acpEngineSessionOptions()` turns a preset into the
 *   `AcpCreateOptions` the session manager consumes, so the panel can offer
 *   "GitHub Copilot CLI" instead of a raw command line.
 * - Bot ACP config: `BotConfig.acp.engine` names a preset;
 *   `acpOptionsFromBot()` (acp.ts) resolves it to the preset's command/args.
 *
 * GitHub Copilot CLI is the preset added by this pack. Its ACP mode is
 * started with `copilot --acp` (stdio). Authentication is the CLI's own
 * GitHub login — KriyaDot never implements OAuth for it and never reads its
 * tokens; sign-in STATUS is reported through cli-auth.ts (id `copilot`),
 * which probes the GitHub CLI credential file's shape only.
 *
 * Security contract (same as the other CLI surfaces):
 * - Children are spawned WITHOUT a shell (argv arrays) by AcpClient, which
 *   also scrubs provider API keys from the child environment.
 * - Agent output is external/untrusted and is prefixed as such.
 * - No credentials are read, logged, or returned by this module.
 */

import { AcpClient, registerAcpEngineResolver } from '../acp.js';
import type { AcpCreateOptions, AcpSession, AcpSessionManager } from '../acp-sessions.js';
import type { ChatMessage, LLMProvider, ModelInfo, TokenUsage, ToolDefinition } from '../types.js';
import { flattenMessagesForCli, untrustedCliPrefix } from './agent-cli.js';
import { loadAgentRegistry, whichSync } from './agent-detect.js';
import type { CliAuthId } from './cli-auth.js';
import { CliLazyMcpBridge, isMcpToolName } from './cli-lazy-mcp.js';

export interface AcpEnginePreset {
  /** Engine id, e.g. 'copilot'. Used in `agent/<id>/<model>` and `acp.engine`. */
  id: string;
  name: string;
  /** Executable name resolved via PATH. */
  command: string;
  /** argv that starts the CLI's stdio ACP agent mode (no shell). */
  acpArgs: string[];
  /** cli-auth.ts id used for sign-in status / in-app login, when supported. */
  authId?: CliAuthId;
  /** Model labels offered for this engine in pickers (ACP agents pick their own model server-side; these are labels). */
  models: Array<{ id: string; name: string; default?: boolean }>;
  notes: string;
}

const presets = new Map<string, AcpEnginePreset>();

/** Register (or override) an ACP engine preset. Hosts use this to pin flag sets. */
export function registerAcpEnginePreset(preset: AcpEnginePreset): void {
  presets.set(preset.id, preset);
}

function define(preset: AcpEnginePreset): void {
  presets.set(preset.id, preset);
}

define({
  id: 'copilot',
  name: 'GitHub Copilot CLI',
  command: 'copilot',
  acpArgs: ['--acp'],
  authId: 'copilot',
  models: [
    { id: 'default', name: 'Copilot default model', default: true },
    { id: 'gpt-5', name: 'GPT-5 (via Copilot)' },
    { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5 (via Copilot)' },
  ],
  notes:
    'GitHub Copilot CLI in ACP agent mode (`copilot --acp`, stdio). Auth is the CLI\'s own ' +
    'GitHub login (checked via Settings → Providers → Sign in, id "copilot"); KriyaDot never ' +
    'sees GitHub credentials. The model label is advisory — the Copilot agent selects its ' +
    'serving model under the user\'s Copilot subscription.',
});

define({
  id: 'opencode',
  name: 'OpenCode (ACP)',
  command: 'opencode',
  acpArgs: ['acp'],
  authId: 'opencode',
  models: [{ id: 'default', name: 'OpenCode default model', default: true }],
  notes: 'OpenCode in ACP mode (`opencode acp`, stdio). Auth is the CLI\'s own login.',
});

// Let acpOptionsFromBot() resolve { acp: { engine: 'copilot' } } bot configs
// against this registry (registered here to avoid a circular import).
registerAcpEngineResolver((engineId) => {
  const preset = presets.get(engineId);
  return preset ? { command: preset.command, args: [...preset.acpArgs] } : undefined;
});

export function listAcpEnginePresets(): AcpEnginePreset[] {
  return [...presets.values()];
}

export function getAcpEnginePreset(id: string): AcpEnginePreset | undefined {
  return presets.get(id);
}

export function isAcpEngineId(id: string): boolean {
  return presets.has(id);
}

/** argv for one ACP agent spawn of this engine (a fresh array per call). */
export function buildAcpEngineArgs(preset: AcpEnginePreset): string[] {
  return [...preset.acpArgs];
}

export interface AcpEngineDetection {
  id: string;
  name: string;
  command: string;
  installed: boolean;
  /** Absolute binary path when found (from the agent registry scan). */
  path: string | null;
  acpCompatible: boolean;
}

/**
 * Detect ACP engines via the data-driven agent registry (agent-registry.json
 * + PATH lookup in agent-detect.ts). The Copilot entry already lives there
 * (`copilot`, acpCompatible: true); this joins it with the engine presets.
 */
export function detectAcpEngines(): AcpEngineDetection[] {
  const registry = loadAgentRegistry();
  return listAcpEnginePresets().map((preset) => {
    const entry = registry.find((e) => e.id === preset.id);
    const bins = entry?.bins ?? [preset.command];
    let found: string | null = null;
    for (const bin of bins) {
      found = whichSync(bin);
      if (found) break;
    }
    return {
      id: preset.id,
      name: preset.name,
      command: preset.command,
      installed: found !== null,
      path: found,
      acpCompatible: entry?.acpCompatible ?? true,
    };
  });
}

export interface AcpEngineSessionOptions {
  cwd: string;
  label?: string;
  /** Override the executable (tests / non-PATH installs), mirroring NativeCliDriverOptions.command. */
  command?: string;
  /** Override the spawn args entirely (tests use this to point at a mock ACP stdio process). */
  args?: string[];
}

/** Turn an engine preset into AcpSessionManager.createSession() options. */
export function acpEngineSessionOptions(engineId: string, opts: AcpEngineSessionOptions): AcpCreateOptions {
  const preset = getAcpEnginePreset(engineId);
  if (!preset) {
    const known = listAcpEnginePresets().map((p) => p.id).join(', ');
    throw new Error(`Unknown ACP engine "${engineId}". Known ACP engines: ${known}.`);
  }
  return {
    command: opts.command ?? preset.command,
    args: opts.args ?? buildAcpEngineArgs(preset),
    cwd: opts.cwd,
    ...(opts.label ? { label: opts.label } : { label: preset.name }),
  };
}

/** Create + connect an ACP session running the given engine preset. */
export async function createAcpEngineSession(
  manager: AcpSessionManager,
  engineId: string,
  opts: AcpEngineSessionOptions,
): Promise<AcpSession> {
  return manager.createSession(acpEngineSessionOptions(engineId, opts));
}

// ---------------------------------------------------------------------------
// Copilot ACP provider: `agent/copilot/<model>` as an LLMProvider.
// ---------------------------------------------------------------------------

/** Minimal client surface the provider needs (AcpClient satisfies it). */
export interface AcpEngineClient {
  connect(): Promise<{ agentName: string }>;
  promptStream(
    text: string,
    opts?: { sessionId?: string; timeoutMs?: number; onChunk?: (chunk: string) => void },
  ): Promise<{ text: string }>;
  isConnected(): boolean;
  close(): void;
}

export interface CopilotAcpProviderOptions {
  model: string;
  /** Working directory for the ACP agent. Required by AcpClient (L4); the provider defaults it explicitly to the host workspace via process.cwd() when the factory does not supply one. */
  cwd?: string;
  /** Override the executable (tests / non-PATH installs). */
  command?: string;
  /** Override the spawn args (tests point this at a mock ACP stdio process). */
  args?: string[];
  /** Test seam: build the ACP client. Defaults to a real AcpClient. */
  createClient?: (opts: { command: string; args: string[]; cwd: string }) => AcpEngineClient;
  timeoutMs?: number;
}

const COPILOT_DEFAULT_TIMEOUT_MS = 600_000;

/**
 * LLMProvider backed by GitHub Copilot CLI over ACP. One ACP process is
 * kept per provider instance and reused across turns (the ACP session id is
 * the provider instance's own fixed id; the agent keeps its context).
 * `chat()` returns `toolCalls: []` — the agent executes its own tools in
 * its own process, exactly like the native CLI drivers.
 */
export class CopilotAcpProvider implements LLMProvider {
  readonly providerId: string;
  private readonly model: string;
  private readonly cwd: string;
  private readonly command: string;
  private readonly args: string[];
  private readonly createClient: NonNullable<CopilotAcpProviderOptions['createClient']>;
  private readonly timeoutMs: number;
  private client: AcpEngineClient | null = null;
  private connecting: Promise<AcpEngineClient> | null = null;
  private lazyMcpBridge: CliLazyMcpBridge | null = null;
  private lazyMcpKey = '';

  /** The lazy MCP bridge for this ACP bot (null until a turn carries MCP tools). */
  getLazyMcpBridge(): CliLazyMcpBridge | null {
    return this.lazyMcpBridge;
  }

  /** Host-driven search between turns: loads matching MCP tools for the next turn. */
  searchMcpTools(query: string): ReturnType<CliLazyMcpBridge['searchTools']> {
    if (!this.lazyMcpBridge) return [];
    return this.lazyMcpBridge.searchTools(query);
  }

  private lazyMcpPromptSection(tools: ToolDefinition[]): string {
    const mcpTools = tools.filter((t) => isMcpToolName(t.name));
    if (mcpTools.length === 0) return '';
    const key = mcpTools.map((t) => t.name).sort().join('');
    if (!this.lazyMcpBridge || key !== this.lazyMcpKey) {
      this.lazyMcpBridge = new CliLazyMcpBridge(mcpTools);
      this.lazyMcpKey = key;
    }
    return this.lazyMcpBridge.promptSection();
  }

  constructor(opts: CopilotAcpProviderOptions) {
    const preset = getAcpEnginePreset('copilot')!;
    this.model = opts.model || 'default';
    this.cwd = opts.cwd ?? process.cwd();
    this.command = opts.command ?? preset.command;
    this.args = opts.args ?? buildAcpEngineArgs(preset);
    this.timeoutMs = opts.timeoutMs ?? COPILOT_DEFAULT_TIMEOUT_MS;
    this.createClient =
      opts.createClient ??
      ((o) => new AcpClient({ command: o.command, args: o.args, cwd: o.cwd }) as AcpEngineClient);
    this.providerId = `agent/copilot/${this.model}`;
  }

  private async ensureClient(): Promise<AcpEngineClient> {
    if (this.client?.isConnected()) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = this.createClient({ command: this.command, args: [...this.args], cwd: this.cwd });
      await client.connect();
      this.client = client;
      return client;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts: {
      model: string;
      onToken?: (t: string) => void;
      signal?: AbortSignal;
    },
  ): Promise<{ content: string; toolCalls: []; usage: TokenUsage }> {
    if (opts.signal?.aborted) throw new Error('Copilot ACP turn aborted before start.');
    // Lazy MCP (W9): same bridge as the native CLI drivers — lightweight
    // directory in the prompt, full schemas only for loaded tools.
    const lazySection = this.lazyMcpPromptSection(tools);
    const basePrompt = flattenMessagesForCli(messages);
    const prompt = lazySection ? `${basePrompt}\n\n${lazySection}` : basePrompt;
    const client = await this.ensureClient();
    const prefix = untrustedCliPrefix('copilot');
    if (opts.onToken) opts.onToken(`${prefix}\n`);
    let result: { text: string };
    try {
      result = await client.promptStream(prompt, {
        timeoutMs: this.timeoutMs,
        onChunk: (chunk) => opts.onToken?.(chunk),
      });
    } catch (err) {
      // A dead ACP process must not poison later turns — drop it so the
      // next chat() reconnects cleanly.
      try {
        client.close();
      } catch {
        // ignore
      }
      if (this.client === client) this.client = null;
      throw err;
    }
    const marked = `${prefix}\n${result.text}`;
    // Usage is metered by the user's Copilot subscription, not by KriyaDot.
    return { content: marked, toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }

  async listModels(): Promise<ModelInfo[]> {
    const preset = getAcpEnginePreset('copilot')!;
    return preset.models.map((m) => ({ id: m.id, name: m.name }));
  }

  /** Close the underlying ACP process (host shutdown). */
  close(): void {
    try {
      this.client?.close();
    } catch {
      // ignore
    }
    this.client = null;
  }
}

/**
 * Build a CopilotAcpProvider for `agent/copilot/<model>`. Returns null for
 * non-Copilot ids. Throws on a malformed id, mirroring the native driver
 * factory's behavior.
 */
export function createCopilotAcpProvider(
  providerId: string,
  opts: Omit<CopilotAcpProviderOptions, 'model'> = {},
): CopilotAcpProvider | null {
  if (!providerId.startsWith('agent/')) return null;
  const rest = providerId.slice('agent/'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const cliId = rest.slice(0, slash);
  if (cliId !== 'copilot') return null;
  const model = rest.slice(slash + 1);
  if (!model) {
    throw new Error(`Invalid agent-CLI provider id "${providerId}": expected "agent/copilot/<model>".`);
  }
  return new CopilotAcpProvider({ ...opts, model });
}
