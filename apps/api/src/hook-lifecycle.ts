// SPDX-License-Identifier: Apache-2.0
// SCH-14 — Hook lifecycle contract, layered over the Wave-3 hook registry
// (hooks-config.ts script hooks on the agent-runtime HookBus).
//
// The contract every managed hook lives under:
//   1. START DISABLED. Registering a hook never activates it; a human (or
//      an explicit enable call) turns it on.
//   2. DRY-RUN. A hook can be dry-run against a sample payload: the
//      invocation is recorded (event, payload shape, at) and the handler
//      is NOT executed — no side effects, ever. A hook can also be put in
//      dry-run MODE, where live emits are recorded instead of executed.
//   3. TERMINAL AUTO-DISABLE. After `maxConsecutiveFailures` consecutive
//      handler failures (default 3) the hook disables itself terminally:
//      it stays off until a human re-enables it (which resets the
//      failure counter). The disable reason is recorded.
//   4. SECRET SCANNING. Hook configs are scanned at registration; a
//      config carrying what looks like a live credential (API keys,
//      tokens, passwords, private keys) is REFUSED — hooks must reference
//      credentials through the vault, never inline them.
//
// State is this module's own sqlite store (hook-lifecycle.db), following
// the FileLinkService store pattern. The wrapped handler returned by
// `wrap()` is an ordinary agent-runtime HookHandler, so managed hooks
// register on the same HookBus as unmanaged ones.

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Router, type Request, type Response } from 'express';
import { openDb as openSqliteDb } from '@mvp/agent-runtime';
import type { HookEventName, HookHandler } from '@mvp/agent-runtime';
import type { ScriptHookEntry } from './hooks-config.js';
import { LifecycleAuditLog } from './lifecycle-approval.js';

export const DEFAULT_HOOK_MAX_FAILURES = 3;

export type HookLifecycleState = 'disabled' | 'enabled' | 'dry-run' | 'auto-disabled';

export interface ManagedHook {
  id: string;
  name: string;
  events: string[];
  state: HookLifecycleState;
  consecutiveFailures: number;
  totalFailures: number;
  totalRuns: number;
  dryRuns: number;
  lastError?: string;
  lastRunAt?: number;
  autoDisabledAt?: number;
  autoDisableReason?: string;
  createdAt: number;
}

export interface HookSecretFinding {
  /** Where the secret was found, e.g. `command[1]` or `env.API_KEY`. */
  path: string;
  kind: string;
  /** Redacted preview: first 3 chars + length, never the value. */
  redacted: string;
}

const SECRET_PATTERNS: { pattern: RegExp; kind: string }[] = [
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/, kind: 'openai-style-api-key' },
  { pattern: /\bghp_[A-Za-z0-9]{20,}\b/, kind: 'github-token' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/, kind: 'github-token' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, kind: 'aws-access-key' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, kind: 'slack-token' },
  { pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, kind: 'private-key' },
  { pattern: /\bBearer\s+[A-Za-z0-9._-]{16,}\b/i, kind: 'bearer-token' },
  { pattern: /(?:password|passwd|api[_-]?key|secret|token)\s*[:=]\s*["']?[^\s"']{8,}/i, kind: 'inline-credential-assignment' },
];

function redact(value: string): string {
  return `${value.slice(0, 3)}…(${value.length} chars)`;
}

function scanString(value: string, path: string, findings: HookSecretFinding[]): void {
  for (const { pattern, kind } of SECRET_PATTERNS) {
    const match = pattern.exec(value);
    if (match) findings.push({ path, kind, redacted: redact(match[0]) });
  }
}

/**
 * Scan an arbitrary hook config for inline secrets. Recurses into plain
 * objects/arrays; every string leaf is checked. Returns findings (empty
 * = clean). Never throws, never returns secret values.
 */
export function scanHookConfigForSecrets(config: unknown): HookSecretFinding[] {
  const findings: HookSecretFinding[] = [];
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      scanString(value, path, findings);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        scanString(key, path ? `${path}.${key} (key)` : `${key} (key)`, findings);
        walk(v, path ? `${path}.${key}` : key);
      }
    }
  };
  walk(config, '');
  return findings;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS managed_hooks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    events TEXT NOT NULL,
    state TEXT NOT NULL,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    total_failures INTEGER NOT NULL DEFAULT 0,
    total_runs INTEGER NOT NULL DEFAULT 0,
    dry_runs INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_run_at INTEGER,
    auto_disabled_at INTEGER,
    auto_disable_reason TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS hook_dry_run_log (
    id TEXT PRIMARY KEY,
    hook_id TEXT NOT NULL,
    event TEXT NOT NULL,
    payload_preview TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_hook_dry_run_hook ON hook_dry_run_log(hook_id, at);
`;

interface HookRow {
  id: string;
  name: string;
  events: string;
  state: string;
  consecutive_failures: number;
  total_failures: number;
  total_runs: number;
  dry_runs: number;
  last_error: string | null;
  last_run_at: number | null;
  auto_disabled_at: number | null;
  auto_disable_reason: string | null;
  created_at: number;
}

function rowToHook(row: HookRow): ManagedHook {
  return {
    id: row.id,
    name: row.name,
    events: JSON.parse(row.events) as string[],
    state: row.state as HookLifecycleState,
    consecutiveFailures: row.consecutive_failures,
    totalFailures: row.total_failures,
    totalRuns: row.total_runs,
    dryRuns: row.dry_runs,
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.last_run_at != null ? { lastRunAt: row.last_run_at } : {}),
    ...(row.auto_disabled_at != null ? { autoDisabledAt: row.auto_disabled_at } : {}),
    ...(row.auto_disable_reason ? { autoDisableReason: row.auto_disable_reason } : {}),
    createdAt: row.created_at,
  };
}

export class HookRegistrationError extends Error {
  constructor(
    message: string,
    readonly findings: HookSecretFinding[] = [],
  ) {
    super(message);
    this.name = 'HookRegistrationError';
  }
}

export interface HookLifecycleDeps {
  auditLog?: LifecycleAuditLog;
  maxConsecutiveFailures?: number;
  now?: () => number;
}

export class HookLifecycleRegistry {
  private readonly db: DatabaseSync;
  private readonly auditLog?: LifecycleAuditLog;
  private readonly maxFailures: number;
  private readonly nowFn: () => number;

  constructor(dataDir: string, deps: HookLifecycleDeps = {}) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openSqliteDb(join(dataDir, 'hook-lifecycle.db'));
    this.db.exec(SCHEMA);
    this.auditLog = deps.auditLog;
    this.maxFailures = Math.max(1, Math.floor(deps.maxConsecutiveFailures ?? DEFAULT_HOOK_MAX_FAILURES));
    this.nowFn = deps.now ?? (() => Date.now());
  }

  /**
   * Register a hook definition. Starts DISABLED. The config is secret-
   * scanned first: any finding refuses registration (fail-closed).
   */
  register(input: { name: string; events: string[]; config?: unknown }): ManagedHook {
    const findings = scanHookConfigForSecrets(input.config ?? input);
    if (findings.length > 0) {
      throw new HookRegistrationError(
        `hook "${input.name}" refused: config appears to contain inline secret(s) at ${findings
          .map((f) => f.path)
          .join(', ')} — reference credentials through the vault instead`,
        findings,
      );
    }
    const hook: ManagedHook = {
      id: randomUUID(),
      name: input.name.slice(0, 120),
      events: [...new Set(input.events)],
      state: 'disabled',
      consecutiveFailures: 0,
      totalFailures: 0,
      totalRuns: 0,
      dryRuns: 0,
      createdAt: this.nowFn(),
    };
    this.db
      .prepare(
        `INSERT INTO managed_hooks (id, name, events, state, consecutive_failures, total_failures, total_runs, dry_runs, created_at)
         VALUES (?, ?, ?, 'disabled', 0, 0, 0, 0, ?)`,
      )
      .run(hook.id, hook.name, JSON.stringify(hook.events), hook.createdAt);
    this.auditLog?.record('hook.registered', 'api', { hookId: hook.id, name: hook.name, state: 'disabled' });
    return hook;
  }

  /** Register Wave-3 script-hook entries under lifecycle management. */
  registerScriptHooks(entries: ScriptHookEntry[]): ManagedHook[] {
    return entries.map((entry, i) =>
      this.register({
        name: entry.name ?? `script-hook-${i + 1}`,
        events: entry.events,
        config: { command: entry.command, timeoutMs: entry.timeoutMs },
      }),
    );
  }

  get(id: string): ManagedHook | undefined {
    const row = this.db.prepare('SELECT * FROM managed_hooks WHERE id = ?').get(id) as unknown as HookRow | undefined;
    return row ? rowToHook(row) : undefined;
  }

  list(): ManagedHook[] {
    const rows = this.db.prepare('SELECT * FROM managed_hooks ORDER BY created_at ASC').all() as unknown as HookRow[];
    return rows.map(rowToHook);
  }

  /** Enable (from disabled or auto-disabled). Resets the failure streak. */
  enable(id: string): ManagedHook {
    return this.setState(id, 'enabled', { resetFailures: true, clearAutoDisable: true });
  }

  disable(id: string): ManagedHook {
    return this.setState(id, 'disabled');
  }

  /** Dry-run mode: live emits are recorded, handlers are NOT executed. */
  setDryRunMode(id: string, on: boolean): ManagedHook {
    const hook = this.mustGet(id);
    if (hook.state === 'auto-disabled') {
      throw new HookRegistrationError('auto-disabled hooks must be re-enabled before dry-run mode');
    }
    return this.setState(id, on ? 'dry-run' : 'enabled');
  }

  private setState(
    id: string,
    state: HookLifecycleState,
    opts: { resetFailures?: boolean; clearAutoDisable?: boolean } = {},
  ): ManagedHook {
    const hook = this.mustGet(id);
    this.db
      .prepare(
        `UPDATE managed_hooks SET state = ?,
           consecutive_failures = ${opts.resetFailures ? '0' : 'consecutive_failures'},
           auto_disabled_at = ${opts.clearAutoDisable ? 'NULL' : 'auto_disabled_at'},
           auto_disable_reason = ${opts.clearAutoDisable ? 'NULL' : 'auto_disable_reason'}
         WHERE id = ?`,
      )
      .run(state, id);
    this.auditLog?.record(`hook.${state === 'enabled' ? 'enabled' : state === 'disabled' ? 'disabled' : 'state_changed'}`, 'api', {
      hookId: id,
      name: hook.name,
      state,
    });
    return this.mustGet(id);
  }

  private mustGet(id: string): ManagedHook {
    const hook = this.get(id);
    if (!hook) throw new HookRegistrationError(`unknown hook: ${id}`);
    return hook;
  }

  /**
   * Record a dry-run invocation: what WOULD have run, with a bounded
   * payload preview. The handler is never executed on this path.
   */
  dryRun(id: string, event: HookEventName | string, payload: unknown): { hook: ManagedHook; recorded: true } {
    const hook = this.mustGet(id);
    let preview = '';
    try {
      preview = JSON.stringify(payload ?? null).slice(0, 500);
    } catch {
      preview = '[unserializable payload]';
    }
    this.db
      .prepare('INSERT INTO hook_dry_run_log (id, hook_id, event, payload_preview, at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), id, String(event), preview, this.nowFn());
    this.db.prepare('UPDATE managed_hooks SET dry_runs = dry_runs + 1 WHERE id = ?').run(id);
    return { hook: this.mustGet(id), recorded: true };
  }

  dryRunLog(id: string, limit = 20): Array<{ event: string; payloadPreview: string; at: number }> {
    const rows = this.db
      .prepare('SELECT event, payload_preview, at FROM hook_dry_run_log WHERE hook_id = ? ORDER BY at DESC LIMIT ?')
      .all(id, limit) as unknown as Array<{ event: string; payload_preview: string; at: number }>;
    return rows.map((r) => ({ event: r.event, payloadPreview: r.payload_preview, at: r.at }));
  }

  /**
   * Wrap a handler with the lifecycle contract. The returned handler is
   * a drop-in HookHandler for the HookBus:
   *   - disabled / auto-disabled → silent no-op
   *   - dry-run mode → recorded via dryRun(), handler NOT executed
   *   - enabled → executed; failures counted, successes reset the
   *     streak; at the threshold the hook auto-disables terminally.
   * Handler errors are rethrown after bookkeeping so the bus records
   * them exactly as it does for unmanaged hooks.
   */
  wrap<T = unknown>(id: string, handler: HookHandler<T>): HookHandler<T> {
    return async (payload: T) => {
      const hook = this.get(id);
      if (!hook || hook.state === 'disabled' || hook.state === 'auto-disabled') return undefined;
      if (hook.state === 'dry-run') {
        this.dryRun(id, 'dry-run-mode', payload);
        return undefined;
      }
      try {
        const result = await handler(payload);
        this.db
          .prepare(
            'UPDATE managed_hooks SET total_runs = total_runs + 1, consecutive_failures = 0, last_run_at = ? WHERE id = ?',
          )
          .run(this.nowFn(), id);
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const next = hook.consecutiveFailures + 1;
        if (next >= this.maxFailures) {
          this.db
            .prepare(
              `UPDATE managed_hooks SET total_runs = total_runs + 1, total_failures = total_failures + 1,
                 consecutive_failures = ?, last_error = ?, last_run_at = ?,
                 state = 'auto-disabled', auto_disabled_at = ?, auto_disable_reason = ?
               WHERE id = ?`,
            )
            .run(next, message, this.nowFn(), this.nowFn(), `${next} consecutive handler failures (last: ${message})`, id);
          this.auditLog?.record('hook.auto_disabled', 'hook-lifecycle', {
            hookId: id,
            name: hook.name,
            consecutiveFailures: next,
            lastError: message,
          });
        } else {
          this.db
            .prepare(
              `UPDATE managed_hooks SET total_runs = total_runs + 1, total_failures = total_failures + 1,
                 consecutive_failures = ?, last_error = ?, last_run_at = ? WHERE id = ?`,
            )
            .run(next, message, this.nowFn(), id);
        }
        throw err;
      }
    };
  }
}

// ---------------------------------------------------------------------------
// Routes — register-style: mount at /api (paths are /hooks/lifecycle…).
// ---------------------------------------------------------------------------

export function createHookLifecycleRouter(deps: { registry: HookLifecycleRegistry }): Router {
  const router = Router();
  const registry = deps.registry;

  router.get('/hooks/lifecycle', (_req: Request, res: Response) => {
    res.json({ ok: true, hooks: registry.list() });
  });

  router.post('/hooks/lifecycle/:id/enable', (req: Request, res: Response) => {
    try {
      res.json({ ok: true, hook: registry.enable(req.params.id) });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'unknown hook' });
    }
  });

  router.post('/hooks/lifecycle/:id/disable', (req: Request, res: Response) => {
    try {
      res.json({ ok: true, hook: registry.disable(req.params.id) });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'unknown hook' });
    }
  });

  router.post('/hooks/lifecycle/:id/dry-run', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { event?: unknown; payload?: unknown };
      const result = registry.dryRun(
        req.params.id,
        typeof body.event === 'string' ? body.event : 'tool.after',
        body.payload ?? null,
      );
      res.json({ ok: true, ...result, log: registry.dryRunLog(req.params.id, 5) });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'unknown hook' });
    }
  });

  return router;
}
