// SPDX-License-Identifier: Apache-2.0
/**
 * Per-engine homes (ENGINES pack, OpenMausBot parity): engine processes
 * spawned for a bot get an ISOLATED home directory
 * (<dataDir>/engine-homes/<botId>/<engineId>) so two bots on the same
 * engine never share the CLI's config/session/credential state unless
 * the user opts into a shared home per bot (`sharedEngineHome: true`).
 *
 * This module is pure env shaping — it never spawns, never reads files,
 * and never touches credential bytes. The spawn sites (AcpClient,
 * NativeCliDriver, ACP engine providers) merge the returned overrides
 * into the child environment.
 *
 * Safety: bot/engine ids are sanitized to a single safe path segment, so
 * a hostile id can never escape the engine-homes root via `..` or
 * separators.
 */

import { join } from 'node:path';

/** Sanitize an id into one safe path segment (letters, digits, dot, dash, underscore). */
export function sanitizeHomeSegment(id: string): string {
  const cleaned = String(id ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^\.+/, '')
    .replace(/^-+/, '')
    .slice(0, 80);
  return cleaned || 'default';
}

/** Isolated home dir for one (bot, engine) pair under the data dir. */
export function engineHomeDir(dataDir: string, botId: string, engineId: string): string {
  return join(dataDir, 'engine-homes', sanitizeHomeSegment(botId), sanitizeHomeSegment(engineId));
}

export interface EngineSpawnEnvInput {
  /** Base environment to start from (usually the scrubbed process env). */
  baseEnv: Record<string, string>;
  dataDir: string;
  botId: string;
  engineId: string;
  /** Shared-home opt-out: when true, no HOME override is applied. */
  sharedHome?: boolean;
  /** Platform override for tests (defaults to process.platform). */
  platform?: NodeJS.Platform;
}

export interface EngineSpawnEnv {
  /** The full environment for the child (base + overrides applied). */
  env: Record<string, string>;
  /** The isolated home that was applied, or null when sharedHome is on. */
  homeDir: string | null;
  /** Just the override keys (for logging/tests — values are paths, never secrets). */
  overrides: Record<string, string>;
}

/**
 * Shape the spawn environment for an engine process. On POSIX the CLI
 * finds its state via HOME; on Windows via USERPROFILE (+ HOMEDRIVE /
 * HOMEPATH for tools that compose them). Both are pointed at the
 * isolated home. Nothing else in the environment changes.
 */
export function buildEngineSpawnEnv(input: EngineSpawnEnvInput): EngineSpawnEnv {
  const base = { ...input.baseEnv };
  if (input.sharedHome) {
    return { env: base, homeDir: null, overrides: {} };
  }
  const home = engineHomeDir(input.dataDir, input.botId, input.engineId);
  const platform = input.platform ?? process.platform;
  const overrides: Record<string, string> = {};
  if (platform === 'win32') {
    overrides.USERPROFILE = home;
    // HOMEDRIVE/HOMEPATH only make sense for drive-absolute homes; the
    // dataDir-derived home is absolute on the host, so derive them when
    // the path carries a drive letter and drop them otherwise.
    const drive = /^([A-Za-z]:)(.*)$/.exec(home);
    if (drive) {
      overrides.HOMEDRIVE = drive[1];
      overrides.HOMEPATH = drive[2] || '\\';
    }
    overrides.HOME = home;
  } else {
    overrides.HOME = home;
  }
  return { env: { ...base, ...overrides }, homeDir: home, overrides };
}
