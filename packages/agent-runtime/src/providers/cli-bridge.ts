// SPDX-License-Identifier: Apache-2.0
// Subscription/CLI bridge (MausBot parity): let the user run bots on their
// EXISTING Claude / ChatGPT subscriptions via locally installed CLIs — no API
// key needed.
//
// Security contract (hard rules):
// - Detection is pure: PATH + credential-file existence checks only. No
//   credential bytes are read during detection.
// - Credential files are read ONLY after the user explicitly grants consent
//   (the Connect button in the Providers UI -> POST /providers/bridges/:id/connect).
// - Tokens live in process memory only. They are NEVER written to disk, logs,
//   the audit trail, or API responses. "Disconnect" (or a process restart)
//   drops them immediately.
// - This module never pools, shares, or proxies anyone else's credentials:
//   it only reuses the single local user's own CLI logins, on their machine,
//   with their explicit consent.

import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export type CliBridgeId = 'claude' | 'codex' | 'opencode';

export interface BridgeDetection {
  id: CliBridgeId;
  /** A `claude` / `codex` executable was found on PATH. */
  cliPresent: boolean;
  /** The CLI's credential file exists (~/.claude/.credentials.json, ~/.codex/auth.json). */
  credentialsPresent: boolean;
  /** Either signal above: the bridge can plausibly be connected. */
  detected: boolean;
}

export interface DetectOptions {
  homeDir?: string;
  /** Defaults to process.env.PATH split on the platform delimiter. */
  pathDirs?: string[];
}

function defaultHomeDir(): string {
  // os.homedir() honors $HOME on POSIX, so tests can point it at a temp dir.
  return homedir();
}

function defaultPathDirs(): string[] {
  return (process.env.PATH ?? '').split(delimiter).filter((d) => d.length > 0);
}

function executableOnPath(name: string, pathDirs: string[]): boolean {
  const candidates = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const dir of pathDirs) {
    for (const candidate of candidates) {
      try {
        accessSync(join(dir, candidate), constants.X_OK);
        return true;
      } catch {
        // not here — keep looking
      }
    }
  }
  return false;
}

const BRIDGE_PATHS: Record<CliBridgeId, { cli: string; credentialsRel: string }> = {
  claude: { cli: 'claude', credentialsRel: join('.claude', '.credentials.json') },
  codex: { cli: 'codex', credentialsRel: join('.codex', 'auth.json') },
  opencode: { cli: 'opencode', credentialsRel: join('.local', 'share', 'opencode', 'auth.json') },
};

function detectOne(id: CliBridgeId, homeDir: string, pathDirs: string[]): BridgeDetection {
  const spec = BRIDGE_PATHS[id];
  const cliPresent = executableOnPath(spec.cli, pathDirs);
  let credentialsPresent = false;
  try {
    credentialsPresent = existsSync(join(homeDir, spec.credentialsRel));
  } catch {
    credentialsPresent = false;
  }
  return { id, cliPresent, credentialsPresent, detected: cliPresent || credentialsPresent };
}

/**
 * Detect locally installed Claude Code / Codex CLIs and their credential
 * files. Pure detection — reads no credential bytes.
 */
export function detectCliBridges(opts: DetectOptions = {}): BridgeDetection[] {
  const homeDir = opts.homeDir ?? defaultHomeDir();
  const pathDirs = opts.pathDirs ?? defaultPathDirs();
  return (Object.keys(BRIDGE_PATHS) as CliBridgeId[]).map((id) => detectOne(id, homeDir, pathDirs));
}

export function detectCliBridge(id: CliBridgeId, opts: DetectOptions = {}): BridgeDetection {
  const homeDir = opts.homeDir ?? defaultHomeDir();
  const pathDirs = opts.pathDirs ?? defaultPathDirs();
  return detectOne(id, homeDir, pathDirs);
}

// ---------------------------------------------------------------------------
// Consent store (in-memory only; a restart clears it).
// ---------------------------------------------------------------------------

const connectedBridges = new Set<CliBridgeId>();

/** Record the user's explicit consent to use a bridge's stored credentials. */
export function grantBridgeConsent(id: CliBridgeId): void {
  connectedBridges.add(id);
}

/** Revoke consent. Any in-memory token derived from it is dropped by callers. */
export function revokeBridgeConsent(id: CliBridgeId): void {
  connectedBridges.delete(id);
}

export function isBridgeConnected(id: CliBridgeId): boolean {
  return connectedBridges.has(id);
}

/** Test helper: clear all consent state. */
export function resetBridgeConsent(): void {
  connectedBridges.clear();
}

// ---------------------------------------------------------------------------
// Credential loading (consent-gated, memory-only).
// ---------------------------------------------------------------------------

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function stringField(obj: unknown, path: string[]): string | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'string' && cur.length > 0 ? cur : undefined;
}

/**
 * Extract the bearer token from a Claude Code credentials file.
 * Known shape: { "claudeAiOauth": { "accessToken": "sk-ant-oat01-…" } }.
 * Shapes evolve; unknown layouts return undefined rather than guessing.
 */
function claudeTokenFromFile(parsed: unknown): string | undefined {
  return stringField(parsed, ['claudeAiOauth', 'accessToken']) ?? stringField(parsed, ['accessToken']);
}

/**
 * Extract the token from a Codex CLI auth file. Known shapes:
 * { "OPENAI_API_KEY": "…" } and { "tokens": { "access_token": "…" } }.
 */
function codexTokenFromFile(parsed: unknown): string | undefined {
  return (
    stringField(parsed, ['OPENAI_API_KEY']) ??
    stringField(parsed, ['tokens', 'access_token']) ??
    stringField(parsed, ['access_token']) ??
    stringField(parsed, ['accessToken'])
  );
}

/**
 * Extract a token from an OpenCode CLI auth file
 * (~/.local/share/opencode/auth.json). The file maps provider names to
 * credential objects, e.g. { "opencode": { "api_key": "…" }, "anthropic": { "api_key": "…" } }.
 * We prefer the "opencode" provider's key, falling back to the first usable
 * api_key found. OAuth blobs are returned as-is (caller decides the scheme).
 */
function opencodeTokenFromFile(parsed: unknown): string | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  // Prefer the native opencode provider entry.
  const preferred = obj['opencode'];
  if (typeof preferred === 'object' && preferred !== null) {
    const p = preferred as Record<string, unknown>;
    const key =
      (typeof p['api_key'] === 'string' && p['api_key']) ||
      (typeof p['apiKey'] === 'string' && p['apiKey']) ||
      (typeof p['access_token'] === 'string' && p['access_token']) ||
      undefined;
    if (key) return key;
  }
  // Fallback: first api_key under any provider entry.
  for (const v of Object.values(obj)) {
    if (typeof v === 'object' && v !== null) {
      const p = v as Record<string, unknown>;
      const key =
        (typeof p['api_key'] === 'string' && p['api_key']) ||
        (typeof p['apiKey'] === 'string' && p['apiKey']) ||
        undefined;
      if (key) return key;
    }
  }
  return undefined;
}

/**
 * Load the bridge's bearer token from the CLI's stored credentials.
 * Returns undefined unless the user granted consent AND a token is readable.
 * The token is returned in memory only — callers must never persist or log it.
 */
export function loadBridgeToken(id: CliBridgeId, homeDir?: string): string | undefined {
  if (!isBridgeConnected(id)) return undefined;
  const home = homeDir ?? defaultHomeDir();
  const parsed = readJsonFile(join(home, BRIDGE_PATHS[id].credentialsRel));
  if (parsed === undefined) return undefined;
  if (id === 'claude') return claudeTokenFromFile(parsed);
  if (id === 'opencode') return opencodeTokenFromFile(parsed);
  return codexTokenFromFile(parsed);
}

/**
 * Validate that a bridge can actually be connected right now: detected and a
 * token is readable from its credential file. Used by the Connect endpoint so
 * a stale detection (CLI uninstalled since boot) fails with a clear message.
 */
export function bridgeConnectable(id: CliBridgeId, opts: DetectOptions = {}): { ok: boolean; reason?: string } {
  const detection = detectCliBridge(id, opts);
  if (!detection.detected) {
    const label = id === 'claude' ? 'Claude Code' : id === 'opencode' ? 'OpenCode CLI' : 'Codex CLI';
    return { ok: false, reason: `No ${label} installation or credential file found on this machine.` };
  }
  if (!detection.credentialsPresent) {
    return { ok: false, reason: 'CLI found, but no stored login. Sign in once in the CLI first, then connect.' };
  }
  // Temporarily bypass the consent gate for the readability probe: we check
  // the file parses to a token shape without recording consent.
  const wasConnected = isBridgeConnected(id);
  if (!wasConnected) grantBridgeConsent(id);
  try {
    const token = loadBridgeToken(id, opts.homeDir);
    if (!token) {
      return { ok: false, reason: 'Credential file found but no usable token inside. Re-login in the CLI and try again.' };
    }
    return { ok: true };
  } finally {
    if (!wasConnected) revokeBridgeConsent(id);
  }
}

/**
 * Get available models by shelling out to the CLI.
 * For codex: `codex debug models` lists available models.
 * For claude: not yet implemented (returns empty).
 * For opencode: `opencode models` lists available models.
 * Returns empty array on failure (caller falls back to catalog).
 */
export function getBridgeModels(id: CliBridgeId): Array<{ id: string; name: string }> {
  const spec = BRIDGE_PATHS[id];
  if (!spec) return [];
  
  try {
    let output: string;
    
    if (id === 'codex') {
      output = execFileSync('codex', ['debug', 'models'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      // Parse the output - it lists models, one per line or in a table
      // Try to extract model IDs (lines containing gpt-, o1, o3, o4)
      const models: Array<{ id: string; name: string }> = [];
      const lines = output.split('\n');
      for (const line of lines) {
        // Match common OpenAI model patterns
        const match = line.match(/\b(gpt-[\w.-]+|o\d[\w.-]*)\b/i);
        if (match) {
          const modelId = match[1].toLowerCase();
          // Avoid duplicates
          if (!models.some(m => m.id === modelId)) {
            models.push({ id: modelId, name: modelId });
          }
        }
      }
      return models;
    }
    
    if (id === 'opencode') {
      output = execFileSync('opencode', ['models'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      // Similar parsing
      const models: Array<{ id: string; name: string }> = [];
      const lines = output.split('\n');
      for (const line of lines) {
        const match = line.match(/\b([\w-]+\/[\w.-]+)\b/);
        if (match) {
          const modelId = match[1];
          if (!models.some(m => m.id === modelId)) {
            models.push({ id: modelId, name: modelId });
          }
        }
      }
      return models;
    }
    
    return [];
  } catch {
    return [];
  }
}
