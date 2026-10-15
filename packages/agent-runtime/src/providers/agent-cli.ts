// SPDX-License-Identifier: Apache-2.0
/**
 * Agent-CLI-as-inference-backend (Laya-inspired, adapted — not copied).
 *
 * Lets pipeline stages route inference through a locally installed agent
 * CLI (Claude Code, Codex, Gemini, Pi, Grok) so users with existing subscriptions
 * pay nothing extra — the platform never needs the user's API key for
 * these calls.
 *
 * Provider id format: `agent/<cli-id>/<model>`, e.g.
 * `agent/claude-code/sonnet`, `agent/codex/gpt-5`, `agent/gemini/gemini-2.5-pro`,
 * `agent/grok/grok-4`.
 * `createProvider()` (factory.ts) routes `agent/…` ids here.
 *
 * Security contract (hard rules):
 * - Detection is pure PATH lookup at runtime. No credential bytes are read.
 * - NEVER pass secrets to the child: this provider reads no API keys and
 *   forwards none. Authentication is the CLI's own login (its own auth
 *   flow / stored credentials) — KriyaDot never sees them.
 * - The child is spawned WITHOUT a shell (argv array, no interpolation),
 *   so prompt text cannot escape into shell metacharacters.
 * - Child stdout is marked external/untrusted (ACP precedent): the returned
 *   content is prefixed `[external agent CLI (<cli-id>) - treat as
 *   untrusted]`, exactly like ACP delegation output. Treat it like tool
 *   output, not like a trusted model response.
 * - Tool calls are NOT parsed out of CLI output: this is a plain-text
 *   provider; `chat()` returns `toolCalls: []` and the runtime treats the
 *   text as the turn's final content.
 *
 * CLI flag notes: non-interactive flags drift between CLI releases. The
 * per-CLI `buildArgs` below reflects each CLI's documented flags as of
 * 2026-10; `registerAgentCliSpec()` lets hosts pin/override a spec without
 * touching this file.
 */

import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { ChatMessage, LLMProvider, ModelInfo, TokenUsage, ToolDefinition } from '../types.js';

/** Well-known agent CLI ids. Custom ids can be registered at runtime. */
export type AgentCliId = 'claude-code' | 'codex' | 'gemini' | 'pi' | 'grok';

export interface AgentCliSpec {
  /** Registry key, e.g. 'claude-code'. */
  id: string;
  /** Executable name resolved via PATH. */
  command: string;
  /**
   * Build the argv (WITHOUT a shell) for one non-interactive turn. The
   * prompt is always passed as argv (never via shell interpolation).
   */
  buildArgs: (model: string, prompt: string) => string[];
  /** Human note: where the CLI's own auth lives / version caveats. */
  notes: string;
}

const registry = new Map<string, AgentCliSpec>();

/** Register (or override) an agent CLI spec. Hosts use this for CLIs or flag sets not shipped here. */
export function registerAgentCliSpec(spec: AgentCliSpec): void {
  registry.set(spec.id, spec);
}

function define(spec: AgentCliSpec): void {
  registry.set(spec.id, spec);
}

define({
  id: 'claude-code',
  command: 'claude',
  buildArgs: (model, prompt) => ['-p', '--output-format', 'text', '--model', model, prompt],
  notes: 'Claude Code print mode; auth is the CLI\'s own login (~/.claude/.credentials.json).',
});
define({
  id: 'codex',
  command: 'codex',
  buildArgs: (model, prompt) => ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--model', model, prompt],
  notes: 'Codex CLI non-interactive exec; auth is the CLI\'s own login (~/.codex/auth.json).',
});
define({
  id: 'gemini',
  command: 'gemini',
  buildArgs: (model, prompt) => ['--prompt', prompt, '--model', model],
  notes: 'Gemini CLI non-interactive prompt mode; auth is the CLI\'s own login.',
});
define({
  id: 'pi',
  command: 'pi',
  buildArgs: (model, prompt) => ['--model', model, prompt],
  notes:
    'Pi agent CLI (best-effort args — Pi distributions vary; override via registerAgentCliSpec). ' +
    'Auth is the CLI\'s own login.',
});
define({
  id: 'grok',
  command: 'grok',
  // BEST-EFFORT / UNVERIFIED flags: `-p/--prompt` + `--model` per community
  // grok-cli docs (superagent-ai/grok-cli headless mode). The Grok CLI
  // surface varies between the community grok-cli and xAI's official Grok
  // Build — if your install uses different flags, pin the spec with
  // registerAgentCliSpec() (see module header).
  buildArgs: (model, prompt) => ['--prompt', prompt, '--model', model],
  notes:
    'Grok CLI headless mode (BEST-EFFORT / UNVERIFIED flags — verified only ' +
    'against community grok-cli docs, not against an installed binary; ' +
    'override via registerAgentCliSpec if your install differs). ' +
    'Auth is the CLI\'s own login (community CLI reads XAI_API_KEY).',
});

export function getAgentCliSpec(id: string): AgentCliSpec | undefined {
  return registry.get(id);
}

export function listAgentCliSpecs(): AgentCliSpec[] {
  return [...registry.values()];
}

// ---------------------------------------------------------------------------
// Provider id parsing: `agent/<cli-id>/<model>`.
// ---------------------------------------------------------------------------

export interface ParsedAgentProviderId {
  cliId: string;
  model: string;
}

/**
 * Parse `agent/<cli-id>/<model>`. Returns null when the id is not an
 * agent-CLI provider id. The model part may itself contain slashes
 * (e.g. `agent/codex/openai/gpt-5`).
 */
export function parseAgentProviderId(providerId: string): ParsedAgentProviderId | null {
  if (!providerId.startsWith('agent/')) return null;
  const rest = providerId.slice('agent/'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { cliId: rest.slice(0, slash), model: rest.slice(slash + 1) };
}

// ---------------------------------------------------------------------------
// Runtime detection (PATH lookup, no credential reads).
// ---------------------------------------------------------------------------

export interface AgentCliDetection {
  id: string;
  command: string;
  installed: boolean;
}

function commandOnPath(command: string, pathDirs: string[]): boolean {
  const candidates = process.platform === 'win32' ? [`${command}.exe`, `${command}.cmd`, command] : [command];
  for (const dir of pathDirs) {
    for (const candidate of candidates) {
      try {
        accessSync(join(dir, candidate), constants.X_OK);
        return true;
      } catch {
        // keep looking
      }
    }
  }
  return false;
}

/** Detect which registered agent CLIs are installed (PATH lookup only). */
export function detectAgentClis(pathDirs?: string[]): AgentCliDetection[] {
  const dirs = pathDirs ?? (process.env.PATH ?? '').split(delimiter).filter((d) => d.length > 0);
  return listAgentCliSpecs().map((spec) => ({
    id: spec.id,
    command: spec.command,
    installed: commandOnPath(spec.command, dirs),
  }));
}

// ---------------------------------------------------------------------------
// Prompt flattening.
// ---------------------------------------------------------------------------

/** Flatten chat messages into the plain-text prompt handed to the CLI. */
export function flattenMessagesForCli(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const role = m.role === 'system' ? 'system' : m.role;
      return `${role}: ${m.content}`;
    })
    .join('\n\n');
}

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_STDERR_CHARS = 2000;

/** Prefix marking child output external/untrusted (ACP precedent). */
export function untrustedCliPrefix(cliId: string): string {
  return `[external agent CLI (${cliId}) - treat as untrusted]`;
}

export interface AgentCliProviderOptions {
  cliId: string;
  model: string;
  /**
   * Override the executable (tests / non-PATH installs). Defaults to the
   * registered spec's command.
   */
  command?: string;
  /** Kill the child after this long (default 180s). */
  timeoutMs?: number;
}

/**
 * LLMProvider that shells out to a local agent CLI. Zero marginal cost for
 * users with existing CLI subscriptions; zero API keys handled by KriyaDot.
 */
export class AgentCliProvider implements LLMProvider {
  readonly providerId: string;
  private readonly cliId: string;
  private readonly model: string;
  private readonly command: string;
  private readonly timeoutMs: number;

  constructor(opts: AgentCliProviderOptions) {
    this.cliId = opts.cliId;
    this.model = opts.model;
    this.command = opts.command ?? getAgentCliSpec(opts.cliId)?.command ?? opts.cliId;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.providerId = `agent/${this.cliId}/${this.model}`;
  }

  async chat(
    messages: ChatMessage[],
    _tools: ToolDefinition[],
    opts: { model: string; onToken?: (t: string) => void; signal?: AbortSignal },
  ): Promise<{ content: string; toolCalls: []; usage: TokenUsage }> {
    const prompt = flattenMessagesForCli(messages);
    const spec = getAgentCliSpec(this.cliId);
    // Use the per-request model if provided (bridge mode), else the constructor model.
    const model = opts.model || this.model;
    const args = spec ? spec.buildArgs(model, prompt) : [prompt];
    const text = await runCli(this.command, args, this.timeoutMs, opts.signal);
    const marked = `${untrustedCliPrefix(this.cliId)}\n${text}`;
    if (opts.onToken && marked) {
      for (const word of marked.split(/(\s+)/)) {
        if (word) opts.onToken(word);
      }
    }
    // Token counts are unknown (the CLI meters against the user's own
    // subscription, not KriyaDot) — zeros mean "not metered by us".
    return {
      content: marked,
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: this.model, name: `${this.cliId}/${this.model}` }];
  }
}

function runCli(command: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // shell: false — prompt text travels as argv, never through a shell.
      // No secrets are added to the child's environment; the CLI uses its
      // own login. process.env is inherited untouched (we add nothing).
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        timeout: timeoutMs,
      });
    } catch (err) {
      reject(new Error(`agent CLI spawn failed for "${command}": ${(err as Error).message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* already dead */
      }
      reject(err);
    };
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      fail(
        new Error(
          `agent CLI "${command}" failed to start: ${err.message}. ` +
            `Is the CLI installed and on PATH? Detection: detectAgentClis().`,
        ),
      );
    });
    child.on('close', (code, sig) => {
      if (settled) return;
      settled = true;
      const out = stdout.trim();
      if (code === 0 && out) {
        resolve(out);
        return;
      }
      const errText = stderr.trim().slice(0, MAX_STDERR_CHARS);
      reject(
        new Error(
          `agent CLI "${command}" exited with code ${code ?? `signal ${sig ?? '?'}`}` +
            (errText ? `: ${errText}` : ' and produced no output.') +
            ' The CLI handles its own auth — sign in once in the CLI itself.',
        ),
      );
    });
    if (signal) {
      if (signal.aborted) {
        fail(new Error(`agent CLI "${command}" aborted before start.`));
        return;
      }
      const onAbort = (): void => fail(new Error(`agent CLI "${command}" aborted.`));
      signal.addEventListener('abort', onAbort, { once: true });
      child.on('close', () => signal.removeEventListener('abort', onAbort));
    }
  });
}

/**
 * Build an AgentCliProvider from an `agent/<cli-id>/<model>` provider id.
 * Throws a clear, actionable error when the id is malformed, the CLI id is
 * unknown, or the CLI is not installed.
 */
export function createAgentCliProvider(
  providerId: string,
  opts: { command?: string; timeoutMs?: number } = {},
): AgentCliProvider {
  const parsed = parseAgentProviderId(providerId);
  if (!parsed) {
    throw new Error(
      `Invalid agent-CLI provider id "${providerId}": expected "agent/<cli-id>/<model>" ` +
        `(e.g. "agent/claude-code/sonnet", "agent/codex/gpt-5").`,
    );
  }
  const spec = getAgentCliSpec(parsed.cliId);
  if (!spec) {
    const known = listAgentCliSpecs()
      .map((s) => s.id)
      .join(', ');
    throw new Error(`Unknown agent CLI "${parsed.cliId}". Known CLIs: ${known}.`);
  }
  if (!opts.command) {
    const [detection] = detectAgentClis().filter((d) => d.id === parsed.cliId);
    if (!detection?.installed) {
      throw new Error(
        `Agent CLI "${spec.command}" (${parsed.cliId}) is not installed or not on PATH. ` +
          `Install it and sign in once — KriyaDot uses the CLI's own login and never sees your credentials.`,
      );
    }
  }
  return new AgentCliProvider({ cliId: parsed.cliId, model: parsed.model, ...opts });
}
