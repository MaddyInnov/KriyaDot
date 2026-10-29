// SPDX-License-Identifier: Apache-2.0
/**
 * Custom ACP engines (ENGINES pack): user-defined ACP engines — a label,
 * a binary path/command, args, and env — stored in settings and offered
 * alongside the built-in presets for bot selection.
 *
 * - Validation is fail-closed: ids are slugs, commands are single
 *   executables (no shell strings), env keys are plain identifiers and
 *   env values must never carry provider API keys for OTHER providers
 *   (a custom engine gets its own login, in its own terminal).
 * - Model discovery runs an ACP probe against the binary: `initialize`
 *   then `session/new`, reading the advertised `model` config option —
 *   the same discovery the built-in fleet uses. The probe spawns WITHOUT
 *   a shell, sends no prompt, and always kills the child.
 * - `mergeCustomAcpEngines()` is the registry merge the host uses to
 *   present presets + customs as one selectable list.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { AcpEnginePreset } from './acp-engines.js';

export interface CustomAcpEngine {
  /** Slug id, prefixed `custom-` when stored (see normalizeCustomEngineId). */
  id: string;
  /** Human label shown in pickers. */
  label: string;
  /** Executable (PATH name or absolute path). Never a shell string. */
  command: string;
  /** argv for ACP mode (no shell). */
  args: string[];
  /** Extra env for the child (its own config only — never foreign keys). */
  env?: Record<string, string>;
}

const CUSTOM_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Env keys that would hand a custom engine another provider's billing. */
const FOREIGN_KEY_RE = /^(OPENAI|ANTHROPIC|GOOGLE|GEMINI|XAI|MISTRAL|META|DEEPSEEK|GROQ|OPENROUTER)_API_KEY$/;

export function normalizeCustomEngineId(raw: string): string {
  const slug = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('custom engine id is required');
  return slug.startsWith('custom-') ? slug : `custom-${slug}`;
}

/** Validate + normalize a custom engine definition (throws readable errors). */
export function validateCustomAcpEngine(input: unknown): CustomAcpEngine {
  if (typeof input !== 'object' || input === null) throw new Error('custom engine must be an object');
  const o = input as Record<string, unknown>;
  const id = normalizeCustomEngineId(typeof o.id === 'string' ? o.id : '');
  if (!CUSTOM_ID_RE.test(id)) throw new Error(`invalid custom engine id "${id}"`);
  const label = typeof o.label === 'string' ? o.label.trim().slice(0, 80) : '';
  if (!label) throw new Error('custom engine label is required');
  const command = typeof o.command === 'string' ? o.command.trim() : '';
  if (!command) throw new Error('custom engine command is required');
  if (/\s/.test(command)) {
    throw new Error('custom engine command must be a single executable (put flags in args, not the command)');
  }
  if (command.length > 500) throw new Error('custom engine command is too long');
  const argsRaw = Array.isArray(o.args) ? o.args : [];
  const args = argsRaw.map((a) => {
    if (typeof a !== 'string') throw new Error('custom engine args must be strings');
    if (a.length > 500) throw new Error('custom engine arg is too long');
    return a;
  }).slice(0, 32);
  let env: Record<string, string> | undefined;
  if (o.env !== undefined) {
    if (typeof o.env !== 'object' || o.env === null || Array.isArray(o.env)) {
      throw new Error('custom engine env must be an object');
    }
    env = {};
    for (const [k, v] of Object.entries(o.env as Record<string, unknown>)) {
      if (!ENV_KEY_RE.test(k)) throw new Error(`invalid env key "${k}"`);
      if (FOREIGN_KEY_RE.test(k)) {
        throw new Error(`env key "${k}" is refused: a custom engine must use its own login, never another provider's key`);
      }
      if (typeof v !== 'string' || v.length > 2000) throw new Error(`env value for "${k}" must be a string (max 2000 chars)`);
      env[k] = v;
    }
    if (Object.keys(env).length === 0) env = undefined;
  }
  return { id, label, command, args, ...(env ? { env } : {}) };
}

/** Turn a custom engine into a preset-shaped entry for bot selection. */
export function customEngineToPreset(engine: CustomAcpEngine): AcpEnginePreset {
  return {
    id: engine.id,
    name: engine.label,
    command: engine.command,
    acpArgs: [...engine.args],
    models: [{ id: 'default', name: `${engine.label} default model`, default: true }],
    notes: `Custom ACP engine "${engine.label}" (user-defined: ${engine.command} ${engine.args.join(' ')}). Auth is the CLI's own login.`,
    ...(engine.env ? { env: { ...engine.env } } : {}),
    modelDiscovery: 'acp-config',
  };
}

export interface SelectableEngine extends AcpEnginePreset {
  custom: boolean;
}

/**
 * Registry merge (exported for parent wiring): built-in presets first,
 * then validated customs. A custom id colliding with a built-in preset
 * id is SKIPPED (built-ins win — a settings entry must never shadow a
 * shipped engine).
 */
export function mergeCustomAcpEngines(
  presets: readonly AcpEnginePreset[],
  customs: readonly CustomAcpEngine[],
): SelectableEngine[] {
  const out: SelectableEngine[] = presets.map((p) => ({ ...p, custom: false }));
  const seen = new Set(out.map((p) => p.id));
  for (const c of customs) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({ ...customEngineToPreset(c), custom: true });
  }
  return out;
}

// ---------------------------------------------------------------------------
// ACP model-discovery probe.
// ---------------------------------------------------------------------------

export type AcpProbeSpawnFn = (
  command: string,
  args: string[],
  opts: { env: Record<string, string> },
) => {
  child: ChildProcess;
  stdout?: NodeJS.ReadableStream | null;
  stdin?: NodeJS.WritableStream | null;
};

function defaultProbeSpawn(command: string, args: string[], opts: { env: Record<string, string> }): ReturnType<AcpProbeSpawnFn> {
  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: opts.env,
  });
  return { child, stdout: child.stdout, stdin: child.stdin };
}

export interface DiscoveredAcpModel {
  id: string;
  name: string;
}

export interface AcpProbeResult {
  agentName: string;
  models: DiscoveredAcpModel[];
}

/** Extract model options from a session/new result's configOptions (groups descend). */
export function modelsFromSessionConfig(configOptions: unknown): DiscoveredAcpModel[] {
  if (!Array.isArray(configOptions)) return [];
  const modelOption = configOptions.find(
    (o) => typeof o === 'object' && o !== null && (o as Record<string, unknown>).id === 'model',
  ) as Record<string, unknown> | undefined;
  if (!modelOption) return [];
  const out: DiscoveredAcpModel[] = [];
  const seen = new Set<string>();
  const visit = (entries: unknown): void => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (Array.isArray(e.options)) {
        visit(e.options);
        continue;
      }
      const value = typeof e.value === 'string' ? e.value : '';
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push({ id: value, name: typeof e.name === 'string' && e.name.trim() ? e.name.trim() : value });
    }
  };
  visit(modelOption.options);
  return out;
}

/**
 * Probe a custom engine binary for its ACP identity + advertised models.
 * Spawns the binary (no shell), runs initialize + session/new, and kills
 * the child. Rejects with a readable error on spawn/protocol failure or
 * timeout. `spawnFn` is the test seam (stub binaries in tests).
 */
export function probeCustomAcpEngine(
  engine: CustomAcpEngine,
  opts: {
    cwd: string;
    timeoutMs?: number;
    spawnFn?: AcpProbeSpawnFn;
    baseEnv?: Record<string, string>;
  },
): Promise<AcpProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const spawnFn = opts.spawnFn ?? defaultProbeSpawn;
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.baseEnv ?? process.env)) {
    if (v === undefined) continue;
    if (/API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k)) continue;
    baseEnv[k] = v;
  }
  const env = { ...baseEnv, ...(engine.env ?? {}) };
  return new Promise<AcpProbeResult>((resolvePromise, rejectPromise) => {
    let handle: ReturnType<AcpProbeSpawnFn>;
    try {
      handle = spawnFn(engine.command, [...engine.args], { env });
    } catch (err) {
      rejectPromise(new Error(`Could not start "${engine.command}": ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    const { child, stdout, stdin } = handle;
    let settled = false;
    let buffer = '';
    let nextId = 1;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        // already dead
      }
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => rejectPromise(new Error(`ACP probe of "${engine.command}" timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    const request = (method: string, params: Record<string, unknown>): Promise<unknown> =>
      new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, { resolve: res, reject: rej });
        try {
          stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        } catch (err) {
          pending.delete(id);
          rej(err instanceof Error ? err : new Error(String(err)));
        }
      });
    stdout?.on('data', (d: Buffer) => {
      buffer += d.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          continue;
        }
        if (typeof msg.id !== 'number') continue;
        const p = pending.get(msg.id);
        if (!p) continue;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`ACP error: ${msg.error.message ?? 'unknown'}`));
        else p.resolve(msg.result);
      }
    });
    child.on('error', (err) => {
      finish(() => rejectPromise(new Error(`Could not start "${engine.command}": ${err.message}`)));
    });
    void (async () => {
      try {
        const init = (await request('initialize', {
          protocolVersion: 1,
          clientInfo: { name: 'kriyadot-probe', version: '0.1.0' },
        })) as { agentInfo?: { name?: string } } | undefined;
        const agentName = init?.agentInfo?.name ?? 'unknown';
        let models: DiscoveredAcpModel[] = [];
        try {
          const session = (await request('session/new', { cwd: opts.cwd, mcpServers: [] })) as
            | { configOptions?: unknown }
            | undefined;
          models = modelsFromSessionConfig(session?.configOptions);
        } catch {
          // An agent that answers initialize but not session/new is still
          // a working ACP engine — it just advertises no models.
          models = [];
        }
        finish(() => resolvePromise({ agentName, models }));
      } catch (err) {
        finish(() => rejectPromise(err instanceof Error ? err : new Error(String(err))));
      }
    })();
  });
}
