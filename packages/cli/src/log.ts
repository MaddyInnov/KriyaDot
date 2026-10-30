// SPDX-License-Identifier: Apache-2.0
// CLI log-level control (#181, CLI side): `config set logLevel <level>`
// persists it in the CLI config; KRIYADOT_LOG_LEVEL overrides it for one
// process. Levels gate the CLI's own diagnostic output (session notes,
// daemon heartbeats, elicitation notices) — chat content on stdout is
// never gated. The API/runtime module is another workstream's surface.

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 50 };

export function isLogLevel(v: unknown): v is LogLevel {
  return typeof v === 'string' && (LOG_LEVELS as readonly string[]).includes(v);
}

/** Resolve the effective level: env beats config beats the 'info' default. Invalid values fall back with no throw. */
export function resolveLogLevel(opts: { configLevel?: unknown; env?: string | undefined } = {}): LogLevel {
  const env = opts.env ?? process.env.KRIYADOT_LOG_LEVEL;
  if (isLogLevel(env?.toLowerCase())) return env.toLowerCase() as LogLevel;
  if (isLogLevel(opts.configLevel)) return opts.configLevel;
  return 'info';
}

export function shouldLog(level: LogLevel, threshold: LogLevel): boolean {
  return RANK[level] >= RANK[threshold];
}

export interface CliLogger {
  level: LogLevel;
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** A tiny level-filtered logger writing diagnostics to the given sink (stderr in the real CLI). */
export function createCliLogger(write: (s: string) => void, level: LogLevel): CliLogger {
  const emit = (l: LogLevel) => (msg: string) => {
    if (shouldLog(l, level)) write(msg.endsWith('\n') ? msg : `${msg}\n`);
  };
  return { level, debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}
