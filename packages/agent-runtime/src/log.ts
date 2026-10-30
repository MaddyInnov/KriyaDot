// SPDX-License-Identifier: Apache-2.0
/**
 * Runtime log-level control (Octomind parity #181, runtime side).
 *
 * Before this module the runtime had structured log records but NO
 * level control at any layer: the API has its own admin surface
 * (apps/api/src/log-level.ts, GET/PUT /admin/log-level) and the CLI has
 * its own (packages/cli/src/log.ts, `config set logLevel` +
 * KRIYADOT_LOG_LEVEL). This module is the runtime's counterpart so
 * library code can emit level-gated structured records that follow the
 * same vocabulary:
 *
 *  - Levels: debug < info < warn < error < silent (same set as the CLI).
 *  - Bootstrap: KRIYADOT_LOG_LEVEL env var, else 'info'. An unknown env
 *    value falls back to 'info' (never throws at import time).
 *  - setLogLevel() changes the level at runtime and THROWS on an
 *    unknown level (fail-visible for programmatic callers / the API
 *    toggle surface).
 *  - createLogger(scope) returns a logger whose methods check the
 *    CURRENT level at call time, so a runtime toggle takes effect
 *    without recreating loggers. Records are single-line JSON:
 *    {ts, level, scope, msg, ...fields}. The sink is injectable for
 *    tests; the default sink writes to stderr (stdout stays clean for
 *    ACP/JSONL protocol traffic).
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 50 };

export function isLogLevel(v: unknown): v is LogLevel {
  return typeof v === 'string' && (LOG_LEVELS as readonly string[]).includes(v);
}

/** Parse an unknown value into a level; null when it is not a level. */
export function parseLogLevel(v: unknown): LogLevel | null {
  if (typeof v !== 'string') return null;
  const lower = v.toLowerCase();
  return isLogLevel(lower) ? (lower as LogLevel) : null;
}

let current: LogLevel = parseLogLevel(process.env.KRIYADOT_LOG_LEVEL) ?? 'info';

/** The runtime's current log level. */
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

/** True when a record at `level` passes the current threshold. */
export function shouldLog(level: LogLevel): boolean {
  return RANK[level] >= RANK[current];
}

export type LogSink = (line: string) => void;

const defaultSink: LogSink = (line) => {
  process.stderr.write(`${line}\n`);
};

export interface RuntimeLogger {
  readonly scope: string;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * A scoped structured logger honouring the CURRENT runtime level at
 * call time. `sink` is injectable for tests; defaults to stderr.
 */
export function createLogger(scope: string, sink: LogSink = defaultSink): RuntimeLogger {
  const emit = (level: LogLevel) => (message: string, fields?: Record<string, unknown>): void => {
    if (!shouldLog(level)) return;
    sink(JSON.stringify({ ts: new Date().toISOString(), level, scope, msg: message, ...(fields ?? {}) }));
  };
  return {
    scope,
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
  };
}
