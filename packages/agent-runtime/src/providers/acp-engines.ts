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
  /** Extra environment the engine's ACP mode needs (never secrets). */
  env?: Record<string, string>;
  /**
   * How this engine's live model list is discovered:
   * - 'acp-config': the agent advertises models as the `model` config
   *   option on session/new (the ACP-native path).
   * - 'none': no discovery; the preset's static labels are the catalog.
   */
  modelDiscovery?: 'acp-config' | 'none';
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
  modelDiscovery: 'acp-config',
  notes: 'OpenCode in ACP mode (`opencode acp`, stdio). Auth is the CLI\'s own login.',
});

// ---------------------------------------------------------------------------
// ENGINES fleet (OpenMausBot §1.3 + Octop §2.10): every coding-agent CLI
// whose documented ACP invocation was verified against the vendor CLI's
// own ACP contract gets a working preset below. Invocations are the ACP
// entry points only — per-turn model/effort selection rides the ACP
// `model` config option where the agent advertises one, never argv,
// because several of these CLIs ignore model flags in ACP mode.
//
// Deliberately NOT here (detection-only, see DETECTION_ONLY_ACP_NOTES):
// Pi — its CLI speaks its own stdio JSON-RPC (`pi --mode rpc`), not ACP.
// ---------------------------------------------------------------------------

define({
  id: 'antigravity',
  name: 'Google Antigravity',
  command: 'agy',
  // Google's ACP server is a dedicated stdio binary: it speaks ACP on
  // stdio with NO subcommand/flags (the `agy` install resolves to the
  // managed ACP server build; the IDE CLI itself is not the ACP agent).
  // Auth is the server's own Google OAuth ("oauth-personal"); KriyaDot
  // never sees Google credentials. The default model is communicated via
  // AGY_ACP_DEFAULT_MODEL by hosts that pin one.
  acpArgs: [],
  authId: 'antigravity',
  models: [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', default: true }],
  modelDiscovery: 'acp-config',
  notes:
    'Google Antigravity ACP server (stdio, no args). Google moved personal Gemini ' +
    'subscriptions (free / AI Pro / AI Ultra) from Gemini CLI to Antigravity; sign-in is ' +
    'the server\'s own Google OAuth flow. When the server binary is absent, detection ' +
    'reports not-installed cleanly.',
});

define({
  id: 'grok',
  name: 'Grok Build (ACP)',
  command: 'grok',
  // Grok Build ACP entry: `grok agent stdio` (the official grok CLI's ACP
  // stdio mode, on the grok.com subscription login, not the xAI API key).
  acpArgs: ['agent', 'stdio'],
  models: [
    { id: 'grok-4.7', name: 'Grok 4.7', default: true },
    { id: 'grok-4.6', name: 'Grok 4.6' },
    { id: 'grok-4.5', name: 'Grok 4.5' },
  ],
  modelDiscovery: 'acp-config',
  notes:
    'xAI Grok Build CLI in ACP stdio mode (`grok agent stdio`). Auth is the CLI\'s own ' +
    'grok.com subscription login (~/.grok); KriyaDot never handles xAI keys for this engine.',
});

define({
  id: 'cursor',
  name: 'Cursor Agent (ACP)',
  command: 'cursor-agent',
  // Cursor's ACP mode is `cursor-agent acp`; global flags (--model,
  // --force) precede the subcommand in the full driver — the preset keeps
  // the bare ACP entry and lets the session pick its model over ACP.
  acpArgs: ['acp'],
  models: [
    { id: 'auto', name: 'Auto', default: true },
    { id: 'composer-2.5', name: 'Composer 2.5' },
    { id: 'composer-2.5-fast', name: 'Composer 2.5 Fast' },
    { id: 'gpt-5.3-codex', name: 'Codex 5.3 (via Cursor)' },
  ],
  modelDiscovery: 'acp-config',
  notes:
    'Cursor Agent CLI in ACP mode (`cursor-agent acp`, stdio). Auth is the CLI\'s own ' +
    'Cursor login (`cursor-agent login`) or CURSOR_API_KEY in the CLI\'s own environment.',
});

define({
  id: 'gemini',
  name: 'Gemini CLI (ACP)',
  command: 'gemini',
  acpArgs: ['--acp'],
  models: [{ id: 'default', name: 'Gemini CLI default model', default: true }],
  modelDiscovery: 'acp-config',
  notes:
    'Google Gemini CLI in ACP mode (`gemini --acp`, stdio). Since 2026-06-18 consumer ' +
    'Google tiers route through Antigravity; this preset serves Gemini API key / Vertex / ' +
    'enterprise Code Assist logins. Auth is the CLI\'s own.',
});

define({
  id: 'kimi',
  name: 'Kimi Code (ACP)',
  command: 'kimi',
  // `-m <model>` is a global option that must precede `acp` in the full
  // driver; the preset keeps the bare ACP entry (session picks model).
  acpArgs: ['acp'],
  models: [
    { id: 'kimi-code/k3', name: 'Kimi K3', default: true },
    { id: 'kimi-code/k3-256k', name: 'Kimi K3 256K' },
    { id: 'kimi-code/kimi-for-coding', name: 'Kimi for Coding' },
    { id: 'kimi-code/kimi-for-coding-highspeed', name: 'Kimi for Coding Highspeed' },
  ],
  modelDiscovery: 'acp-config',
  notes:
    'Moonshot Kimi Code CLI in ACP mode (`kimi acp`, stdio) on the Kimi Code subscription ' +
    'login (`kimi login`), not a Moonshot API key. Auth is the CLI\'s own.',
});

define({
  id: 'qwen',
  name: 'Qwen Code (ACP)',
  command: 'qwen',
  acpArgs: ['--acp'],
  models: [{ id: 'default', name: 'Qwen Code default model', default: true }],
  modelDiscovery: 'acp-config',
  notes: 'Qwen Code CLI in ACP mode (`qwen --acp`, stdio). Auth is the CLI\'s own login.',
});

define({
  id: 'droid',
  name: 'Factory Droid (ACP)',
  command: 'droid',
  // Droid's ACP entry is `droid exec -o acp` (streaming JSON-RPC mode);
  // session settings (model, reasoning effort) are set over ACP, not argv.
  acpArgs: ['exec', '-o', 'acp'],
  models: [{ id: 'default', name: 'Droid default model', default: true }],
  modelDiscovery: 'acp-config',
  notes:
    'Factory Droid CLI in ACP mode (`droid exec -o acp`, stdio). Auth is the CLI\'s own ' +
    'Factory login or FACTORY_API_KEY in the CLI\'s own environment.',
});

define({
  id: 'hermes',
  name: 'Hermes Agent (ACP)',
  command: 'hermes',
  acpArgs: ['acp'],
  models: [{ id: 'hermes-default', name: 'Hermes configured default model', default: true }],
  modelDiscovery: 'acp-config',
  notes:
    'Nous Research Hermes Agent in ACP mode (`hermes acp`, stdio). The agent advertises ' +
    'its catalog on session/new; auth is Hermes\' own setup (`hermes setup`).',
});

define({
  id: 'cline',
  name: 'Cline (ACP)',
  command: 'cline',
  // Cline's ACP mode must not self-approve: `--auto-approve false` keeps
  // permission decisions with the ACP broker (KriyaDot's approval cards).
  acpArgs: ['--acp', '--auto-approve', 'false'],
  models: [{ id: 'cline-default', name: 'Cline default (configured)', default: true }],
  modelDiscovery: 'none',
  notes:
    'Cline CLI in ACP mode (`cline --acp --auto-approve false`, stdio). Cline owns its ' +
    'provider/model configuration (`cline auth` in a terminal); the model label is its ' +
    'configured default.',
});

define({
  id: 'deepseek-harness',
  name: 'DeepSeek Harness (dsh, ACP)',
  command: 'dsh',
  // DeepSeek's own harness speaks ACP under its `acp` profile:
  // `dsh --profile acp`. Model + reasoning effort are session config
  // options (see providers/deepseek.ts for the wire shaping).
  acpArgs: ['--profile', 'acp'],
  models: [
    { id: 'deepseek-official/deepseek-v4-flash', name: 'DeepSeek-V4-Flash', default: true },
    { id: 'deepseek-official/deepseek-flash', name: 'DeepSeek-V4.1-Flash' },
    { id: 'deepseek-official/deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
  ],
  modelDiscovery: 'acp-config',
  notes:
    'DeepSeek Harness (`dsh --profile acp`, stdio). No sign-in step: the harness reads ' +
    'DEEPSEEK_API_KEY from its own env/credential store. Model and reasoning effort are ' +
    'ACP session config options.',
});

/**
 * Registry agents that stay DETECTION-ONLY for ACP (no preset), with the
 * reason. Exported so the UI/parent wiring can explain the gap instead of
 * silently omitting the engine.
 */
export const DETECTION_ONLY_ACP_NOTES: Readonly<Record<string, string>> = {
  pi: 'Pi speaks its own stdio JSON-RPC (`pi --mode rpc --no-session`), not ACP; it is driven through its native RPC surface, so no ACP preset is offered.',
  aider: 'Aider has no ACP agent mode.',
  continue: 'Continue CLI has no ACP agent mode.',
  sgpt: 'ShellGPT has no ACP agent mode.',
  mods: 'Mods has no ACP agent mode.',
  llm: 'LLM CLI has no ACP agent mode.',
  ollama: 'Ollama is a model server, not an ACP agent; use the ollama provider instead.',
  fabric: 'Fabric has no ACP agent mode.',
  bolt: 'Bolt CLI has no ACP agent mode.',
  sweep: 'Sweep CLI has no ACP agent mode.',
  crawl: 'Crawl has no ACP agent mode.',
};

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
export function detectAcpEngines(opts: {
  /**
   * Standalone-install preference (ENGINES pack): when a standalone build
   * of the engine is installed under the data dir, its path wins over the
   * PATH copy. Supplied by the API layer (engine-installs.ts) so this
   * module stays free of install state.
   */
  standalonePath?: (engineId: string) => string | null;
} = {}): AcpEngineDetection[] {
  const registry = loadAgentRegistry();
  return listAcpEnginePresets().map((preset) => {
    const entry = registry.find((e) => e.id === preset.id);
    const standalone = opts.standalonePath?.(preset.id) ?? null;
    if (standalone) {
      return {
        id: preset.id,
        name: preset.name,
        command: preset.command,
        installed: true,
        path: standalone,
        acpCompatible: entry?.acpCompatible ?? true,
      };
    }
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
  /** Extra spawn env merged over the preset's own env (e.g. per-engine home overrides). */
  env?: Record<string, string>;
}

/** Turn an engine preset into AcpSessionManager.createSession() options. */
export function acpEngineSessionOptions(engineId: string, opts: AcpEngineSessionOptions): AcpCreateOptions {
  const preset = getAcpEnginePreset(engineId);
  if (!preset) {
    const known = listAcpEnginePresets().map((p) => p.id).join(', ');
    throw new Error(`Unknown ACP engine "${engineId}". Known ACP engines: ${known}.`);
  }
  const env = { ...(preset.env ?? {}), ...(opts.env ?? {}) };
  return {
    command: opts.command ?? preset.command,
    args: opts.args ?? buildAcpEngineArgs(preset),
    cwd: opts.cwd,
    ...(opts.label ? { label: opts.label } : { label: preset.name }),
    ...(Object.keys(env).length > 0 ? { env } : {}),
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
  /** ACP engine preset id this provider drives (default 'copilot'). */
  engineId?: string;
  /** Working directory for the ACP agent. Required by AcpClient (L4); the provider defaults it explicitly to the host workspace via process.cwd() when the factory does not supply one. */
  cwd?: string;
  /** Override the executable (tests / non-PATH installs). */
  command?: string;
  /** Override the spawn args (tests point this at a mock ACP stdio process). */
  args?: string[];
  /** Extra spawn env merged over the preset env (per-engine homes ride here). */
  env?: Record<string, string>;
  /** Test seam: build the ACP client. Defaults to a real AcpClient. */
  createClient?: (opts: { command: string; args: string[]; cwd: string; env?: Record<string, string> }) => AcpEngineClient;
  timeoutMs?: number;
}

const COPILOT_DEFAULT_TIMEOUT_MS = 600_000;

/**
 * LLMProvider backed by an ACP engine CLI (GitHub Copilot by default; any
 * preset via `engineId`). One ACP process is kept per provider instance
 * and reused across turns (the ACP session id is the provider instance's
 * own fixed id; the agent keeps its context).
 * `chat()` returns `toolCalls: []` — the agent executes its own tools in
 * its own process, exactly like the native CLI drivers.
 */
export class CopilotAcpProvider implements LLMProvider {
  readonly providerId: string;
  readonly engineId: string;
  private readonly model: string;
  private readonly cwd: string;
  private readonly command: string;
  private readonly args: string[];
  private readonly env?: Record<string, string>;
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
    const engineId = opts.engineId ?? 'copilot';
    const preset = getAcpEnginePreset(engineId);
    if (!preset) {
      const known = listAcpEnginePresets().map((p) => p.id).join(', ');
      throw new Error(`Unknown ACP engine "${engineId}". Known ACP engines: ${known}.`);
    }
    this.engineId = engineId;
    this.model = opts.model || 'default';
    this.cwd = opts.cwd ?? process.cwd();
    this.command = opts.command ?? preset.command;
    this.args = opts.args ?? buildAcpEngineArgs(preset);
    const env = { ...(preset.env ?? {}), ...(opts.env ?? {}) };
    this.env = Object.keys(env).length > 0 ? env : undefined;
    this.timeoutMs = opts.timeoutMs ?? COPILOT_DEFAULT_TIMEOUT_MS;
    this.createClient =
      opts.createClient ??
      ((o) =>
        new AcpClient({
          command: o.command,
          args: o.args,
          cwd: o.cwd,
          ...(o.env ? { env: o.env } : {}),
        }) as AcpEngineClient);
    this.providerId = `agent/${engineId}/${this.model}`;
  }

  private async ensureClient(): Promise<AcpEngineClient> {
    if (this.client?.isConnected()) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = this.createClient({
        command: this.command,
        args: [...this.args],
        cwd: this.cwd,
        ...(this.env ? { env: this.env } : {}),
      });
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
    if (opts.signal?.aborted) throw new Error(`${this.engineId} ACP turn aborted before start.`);
    // Lazy MCP (W9): same bridge as the native CLI drivers — lightweight
    // directory in the prompt, full schemas only for loaded tools.
    const lazySection = this.lazyMcpPromptSection(tools);
    const basePrompt = flattenMessagesForCli(messages);
    const prompt = lazySection ? `${basePrompt}\n\n${lazySection}` : basePrompt;
    const client = await this.ensureClient();
    const prefix = untrustedCliPrefix(this.engineId);
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
    // Usage is metered by the engine's own subscription/login, not by KriyaDot.
    return { content: marked, toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }

  async listModels(): Promise<ModelInfo[]> {
    const preset = getAcpEnginePreset(this.engineId)!;
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
  opts: Omit<CopilotAcpProviderOptions, 'model' | 'engineId'> = {},
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

/** Generic ACP engine provider (ENGINES fleet): same class, any preset. */
export type AcpEngineProvider = CopilotAcpProvider;

/**
 * Build an ACP-backed provider for `agent/<engine>/<model>` for ANY
 * registered ACP preset (copilot, opencode, antigravity, grok, cursor,
 * gemini, kimi, qwen, droid, hermes, cline, deepseek-harness). Returns
 * null when the id is not an agent id or names no ACP preset (callers
 * fall back to the native/one-shot drivers). Throws on a malformed id.
 */
export function createAcpEngineProvider(
  providerId: string,
  opts: Omit<CopilotAcpProviderOptions, 'model' | 'engineId'> = {},
): CopilotAcpProvider | null {
  if (!providerId.startsWith('agent/')) return null;
  const rest = providerId.slice('agent/'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const cliId = rest.slice(0, slash);
  if (!isAcpEngineId(cliId)) return null;
  const model = rest.slice(slash + 1);
  if (!model) {
    throw new Error(`Invalid agent-CLI provider id "${providerId}": expected "agent/${cliId}/<model>".`);
  }
  return new CopilotAcpProvider({ ...opts, model, engineId: cliId });
}
