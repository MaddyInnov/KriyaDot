// SPDX-License-Identifier: Apache-2.0
/**
 * Runtime log-level control (Octomind parity #181).
 *
 * Before this module there was NO log-level control anywhere in the
 * API: no env var, no toggle, structured records were emitted at a
 * fixed implicit level. This module provides:
 *
 *  - a process-wide current level, bootstrapped from
 *    KRIYADOT_LOG_LEVEL (falling back to LOG_LEVEL), default 'info';
 *  - getLogLevel / setLogLevel — setLogLevel validates and is the
 *    runtime toggle the admin endpoint drives;
 *  - shouldLog(level) + createLogger(scope) — a tiny structured logger
 *    (JSON lines to stderr, so stdout stays clean for protocol uses)
 *    that honours the current level at call time. API modules that log
 *    through createLogger gain runtime control for free; modules still
 *    on bare console.* are NOT covered — that gap is documented in the
 *    closure report rather than hidden.
 *  - createLogLevelRouter(): GET/PUT /admin/log-level (the parent
 *    mounts it behind the API's existing admin auth).
 */

import express, { type Router } from 'express';

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export function parseLogLevel(raw: unknown): LogLevel | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(v) ? (v as LogLevel) : null;
}

let current: LogLevel =
  parseLogLevel(process.env.KRIYADOT_LOG_LEVEL) ?? parseLogLevel(process.env.LOG_LEVEL) ?? 'info';

export function getLogLevel(): LogLevel {
  return current;
}

/** Set the runtime level. Throws on an unknown level (fail-visible). */
export function setLogLevel(level: string): LogLevel {
  const parsed = parseLogLevel(level);
  if (!parsed) throw new Error(`unknown log level "${level}" (use: ${LOG_LEVELS.join(', ')})`);
  current = parsed;
  return current;
}

/** Test/bootstrap helper: re-read the environment. */
export function bootstrapLogLevelFromEnv(env: Record<string, string | undefined> = process.env): LogLevel {
  current = parseLogLevel(env.KRIYADOT_LOG_LEVEL) ?? parseLogLevel(env.LOG_LEVEL) ?? 'info';
  return current;
}

export function shouldLog(level: LogLevel): boolean {
  return RANK[level] <= RANK[current];
}

export interface StructuredLogger {
  error(scope: string, message: string, fields?: Record<string, unknown>): void;
  warn(scope: string, message: string, fields?: Record<string, unknown>): void;
  info(scope: string, message: string, fields?: Record<string, unknown>): void;
  debug(scope: string, message: string, fields?: Record<string, unknown>): void;
}

/**
 * Structured logger factory. Emits one JSON object per line:
 * {ts, level, scope, msg, ...fields}. The sink is injectable for tests;
 * the default writes to stderr.
 */
export function createLogger(sink: (line: string) => void = (l) => process.stderr.write(l + '\n')): StructuredLogger {
  const emit = (level: LogLevel) => (scope: string, message: string, fields?: Record<string, unknown>) => {
    if (!shouldLog(level)) return;
    try {
      sink(JSON.stringify({ ts: new Date().toISOString(), level, scope, msg: message, ...(fields ?? {}) }));
    } catch {
      // logging must never break the caller
    }
  };
  return { error: emit('error'), warn: emit('warn'), info: emit('info'), debug: emit('debug') };
}

export const apiLogger: StructuredLogger = createLogger();

/** Admin endpoint: read/set the runtime log level. */
export function createLogLevelRouter(opts: { audit?: (action: string, fields: { detail?: unknown }) => void } = {}): Router {
  const router = express.Router();
  router.get('/admin/log-level', (_req, res) => {
    res.json({ ok: true, level: getLogLevel(), levels: LOG_LEVELS });
  });
  router.put('/admin/log-level', (req, res) => {
    const level = (req.body as { level?: unknown })?.level;
    try {
      const next = setLogLevel(typeof level === 'string' ? level : '');
      opts.audit?.('admin.log_level_set', { detail: { level: next } });
      res.json({ ok: true, level: next });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  return router;
}
