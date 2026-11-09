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

import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
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
  /** Platform override (tests). Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** win32 APPDATA override (tests). Defaults to process.env.APPDATA. */
  appDataDir?: string;
}

/** Plain-language per-CLI facts used in user-facing state and error copy. */
export const CLI_BRIDGE_META: Record<
  CliBridgeId,
  { label: string; signInCommand: string; installCommand: string }
> = {
  claude: {
    label: 'Claude Code',
    signInCommand: 'claude auth login',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
  },
  codex: {
    label: 'Codex CLI',
    signInCommand: 'codex login',
    installCommand: 'npm install -g @openai/codex',
  },
  opencode: {
    label: 'OpenCode CLI',
    signInCommand: 'opencode auth login',
    installCommand: 'npm install -g opencode-ai',
  },
};

function defaultHomeDir(): string {
  // Honor $HOME explicitly so tests (and containers) can point detection at
  // a temp dir on every platform. os.homedir() only honors $HOME on POSIX —
  // on Windows it reads USERPROFILE, which lets the real ~/.codex login leak
  // into hermetic tests. On win32 only accept drive-absolute paths so a
  // POSIX-style $HOME from MSYS/git-bash (e.g. "/c/Users/x") never produces
  // a garbage join — those fall back to homedir().
  const override = process.env.HOME;
  if (override && override.length > 0) {
    if (process.platform !== 'win32') return override;
    if (/^[a-zA-Z]:[\\/]/.test(override) || override.startsWith('\\\\')) return override;
  }
  return homedir();
}

function defaultPathDirs(): string[] {
  return (process.env.PATH ?? '').split(delimiter).filter((d) => d.length > 0);
}

// ---------------------------------------------------------------------------
// CLI executable resolution (shared by detection, identity probing, and
// every spawn site). Windows rules that matter here:
// - A name resolves to several candidate files (.exe / .cmd / .bat / bare),
//   and PATH can hold MORE THAN ONE program with the same name — including
//   unrelated namesakes (a Python package also ships a `codex` command).
//   Resolution therefore enumerates ALL candidates in order; identity is
//   verified separately (probeCliIdentity) before anything spawns one.
// - Windows has no execute bit: existence (F_OK) is the only portable
//   check. X_OK is not meaningful there and some runtimes report EACCES
//   for it on ordinary files, which silently hid installed CLIs from the
//   packaged (Bun-compiled) sidecar. POSIX keeps the real X_OK check.
// - GUI-launched processes can hold a stale PATH, so on win32 the two
//   documented install locations are probed even when PATH lacks them:
//   %USERPROFILE%\.local\bin (native installers) and %APPDATA%\npm
//   (npm global shims). Detection-only: nothing is read but existence.
// ---------------------------------------------------------------------------

const WIN32_CLI_EXTS = ['.exe', '.cmd', '.bat'] as const;

/** File names a bare command can resolve to, in resolution order. */
export function cliExecutableNames(name: string, platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? [...WIN32_CLI_EXTS.map((e) => `${name}${e}`), name] : [name];
}

function cliPathExists(p: string, platform: NodeJS.Platform): boolean {
  try {
    accessSync(p, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** PATH dirs to scan: the explicit override, else process PATH (+ win32 install dirs). */
export function effectiveCliPathDirs(opts: DetectOptions = {}): string[] {
  if (opts.pathDirs) return opts.pathDirs;
  const platform = opts.platform ?? process.platform;
  const dirs = defaultPathDirs();
  if (platform === 'win32') {
    const home = opts.homeDir ?? defaultHomeDir();
    const extras = [
      join(home, '.local', 'bin'),
      join(opts.appDataDir ?? process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm'),
    ];
    for (const extra of extras) {
      if (!dirs.some((d) => d.toLowerCase() === extra.toLowerCase())) dirs.push(extra);
    }
  }
  return dirs;
}

/** Every on-disk candidate for a command name, in resolution order. */
export function enumerateCliCandidates(name: string, opts: DetectOptions = {}): string[] {
  const platform = opts.platform ?? process.platform;
  const found: string[] = [];
  const seen = new Set<string>();
  for (const dir of effectiveCliPathDirs(opts)) {
    for (const candidate of cliExecutableNames(name, platform)) {
      const full = join(dir, candidate);
      const key = platform === 'win32' ? full.toLowerCase() : full;
      if (seen.has(key)) continue;
      if (cliPathExists(full, platform)) {
        seen.add(key);
        found.push(full);
      }
    }
  }
  return found;
}

/** First on-disk candidate for a command name (fs-only, NO identity check). */
export function resolveCliExecutable(name: string, opts: DetectOptions = {}): string | undefined {
  return enumerateCliCandidates(name, opts)[0];
}

function executableOnPath(name: string, pathDirs: string[], platform: NodeJS.Platform): boolean {
  for (const dir of pathDirs) {
    for (const candidate of cliExecutableNames(name, platform)) {
      if (cliPathExists(join(dir, candidate), platform)) return true;
    }
  }
  return false;
}

const BRIDGE_PATHS: Record<CliBridgeId, { cli: string; credentialsRel: string }> = {
  claude: { cli: 'claude', credentialsRel: join('.claude', '.credentials.json') },
  codex: { cli: 'codex', credentialsRel: join('.codex', 'auth.json') },
  opencode: { cli: 'opencode', credentialsRel: join('.local', 'share', 'opencode', 'auth.json') },
};

function detectOne(id: CliBridgeId, homeDir: string, pathDirs: string[], platform: NodeJS.Platform): BridgeDetection {
  const spec = BRIDGE_PATHS[id];
  const cliPresent = executableOnPath(spec.cli, pathDirs, platform);
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
 * files. Pure detection — reads no credential bytes. NOTE: `cliPresent`
 * is a NAME match only; a same-named unrelated program also counts here.
 * Anything that would SPAWN the candidate must use
 * resolveVerifiedCliExecutable() instead.
 */
export function detectCliBridges(opts: DetectOptions = {}): BridgeDetection[] {
  const homeDir = opts.homeDir ?? defaultHomeDir();
  const pathDirs = effectiveCliPathDirs(opts);
  const platform = opts.platform ?? process.platform;
  return (Object.keys(BRIDGE_PATHS) as CliBridgeId[]).map((id) => detectOne(id, homeDir, pathDirs, platform));
}

export function detectCliBridge(id: CliBridgeId, opts: DetectOptions = {}): BridgeDetection {
  const homeDir = opts.homeDir ?? defaultHomeDir();
  const pathDirs = effectiveCliPathDirs(opts);
  const platform = opts.platform ?? process.platform;
  return detectOne(id, homeDir, pathDirs, platform);
}

// ---------------------------------------------------------------------------
// CLI identity verification. A file named `codex` on PATH is not
// necessarily OpenAI's Codex CLI — other tools ship same-named commands
// (a Python package's `codex` crashed with an import traceback in the
// field). Before KriyaDot spawns a candidate or reports a bridge as
// connectable, the candidate must answer `--version` like the real tool.
// Probes are cached per path+mtime so repeated checks are free.
// ---------------------------------------------------------------------------

interface CliIdentitySpec {
  versionArgs: string[];
  /** Anchored against the first non-empty output line. */
  versionPattern: RegExp;
  /** Fallback probe when --version output is uninformative (opencode prints a bare semver). */
  helpArgs?: string[];
  helpPattern?: RegExp;
}

const CLI_IDENTITY: Record<CliBridgeId, CliIdentitySpec> = {
  // Real output: "2.1.316 (Claude Code)".
  claude: { versionArgs: ['--version'], versionPattern: /claude code/i },
  // Real output: "codex-cli 0.142.0". Anchored: a namesake's crash output
  // mentions "codex" in file paths, so an unanchored match is not enough.
  codex: { versionArgs: ['--version'], versionPattern: /^codex-cli\b/i },
  // Real --version prints a bare semver ("1.0.119"); --help names the tool.
  opencode: {
    versionArgs: ['--version'],
    versionPattern: /^\d+\.\d+\.\d+/,
    helpArgs: ['--help'],
    helpPattern: /opencode/i,
  },
};

const PYTHON_TRACEBACK_RE = /Traceback \(most recent call last\)|ModuleNotFoundError|ImportError/i;

export interface CliIdentityResult {
  ok: boolean;
  /** Semver extracted from the version output, when present. */
  version?: string;
  /** Plain-language guess at what a rejected candidate actually is. */
  looksLike?: string;
}

const identityCache = new Map<string, { mtimeMs: number; result: CliIdentityResult }>();

/** Test helper: drop cached identity probes. */
export function resetCliIdentityCache(): void {
  identityCache.clear();
}

function describeCandidate(executablePath: string, output: string): string | undefined {
  if (PYTHON_TRACEBACK_RE.test(output) || /site-packages/i.test(executablePath) || /python/i.test(executablePath)) {
    return 'a Python program';
  }
  return undefined;
}

/**
 * Probe one candidate executable: does it answer like the real CLI?
 * Runs `<exe> --version` (plus `--help` where the spec defines one) with a
 * short timeout. Results are cached by path + file mtime.
 */
export function probeCliIdentity(
  id: CliBridgeId,
  executablePath: string,
  opts: { platform?: NodeJS.Platform; timeoutMs?: number } = {},
): CliIdentityResult {
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(executablePath).mtimeMs;
  } catch {
    // stat failed — probe anyway, skip the cache.
  }
  const cacheKey = executablePath;
  const cached = identityCache.get(cacheKey);
  if (cached && mtimeMs >= 0 && cached.mtimeMs === mtimeMs) return cached.result;

  const spec = CLI_IDENTITY[id];
  const timeoutMs = opts.timeoutMs ?? 5000;
  const versionRun = runCliSync(executablePath, spec.versionArgs, { platform: opts.platform, timeoutMs });
  const firstLine = versionRun.output.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  let result: CliIdentityResult;
  if (PYTHON_TRACEBACK_RE.test(versionRun.output)) {
    result = { ok: false, looksLike: describeCandidate(executablePath, versionRun.output) };
  } else if (spec.versionPattern.test(firstLine)) {
    const version = /\d+\.\d+\.\d+(?:[-.+\w]*)?/.exec(firstLine)?.[0];
    result = { ok: true, ...(version ? { version } : {}) };
  } else if (spec.helpArgs && spec.helpPattern) {
    const helpRun = runCliSync(executablePath, spec.helpArgs, { platform: opts.platform, timeoutMs });
    result = spec.helpPattern.test(helpRun.output)
      ? { ok: true }
      : { ok: false, looksLike: describeCandidate(executablePath, helpRun.output) };
  } else {
    result = { ok: false, looksLike: describeCandidate(executablePath, versionRun.output) };
  }
  if (mtimeMs >= 0) identityCache.set(cacheKey, { mtimeMs, result });
  return result;
}

export interface VerifiedCliResolution {
  /** Absolute path of the first candidate that passed the identity probe. */
  path?: string;
  /** The verified CLI's version string, when the probe captured one. */
  version?: string;
  /** Every on-disk candidate, in resolution order. */
  candidates: string[];
  /** When candidates exist but none is the real CLI: the first namesake. */
  namesake?: { path: string; looksLike?: string };
}

/**
 * Resolve a bridge CLI to a VERIFIED executable: enumerate every same-named
 * candidate in order and return the first that answers like the real tool.
 * A wrong-identity namesake earlier on PATH never shadows a real CLI later
 * on PATH, and a namesake alone resolves to `namesake`, never to `path`.
 */
export function resolveVerifiedCliExecutable(
  id: CliBridgeId,
  opts: DetectOptions & { timeoutMs?: number } = {},
): VerifiedCliResolution {
  const candidates = enumerateCliCandidates(BRIDGE_PATHS[id].cli, opts);
  let namesake: VerifiedCliResolution['namesake'];
  for (const candidate of candidates) {
    const probe = probeCliIdentity(id, candidate, { platform: opts.platform, timeoutMs: opts.timeoutMs });
    if (probe.ok) {
      return { path: candidate, ...(probe.version ? { version: probe.version } : {}), candidates };
    }
    namesake ??= { path: candidate, ...(probe.looksLike ? { looksLike: probe.looksLike } : {}) };
  }
  return { candidates, ...(namesake ? { namesake } : {}) };
}

/** The plain-words sentence for "a program with this name exists, but it is not the real CLI". */
export function bridgeNamesakeMessage(id: CliBridgeId, namesake: { path: string; looksLike?: string }): string {
  const meta = CLI_BRIDGE_META[id];
  const name = BRIDGE_PATHS[id].cli;
  return (
    `Found a program named "${name}" on this machine, but it isn't ${meta.label}` +
    `${namesake.looksLike ? ` — it appears to be ${namesake.looksLike}` : ''}. ` +
    `Install the real ${meta.label} (${meta.installCommand}), then sign in with \`${meta.signInCommand}\`.`
  );
}

// ---------------------------------------------------------------------------
// Spawning CLIs, including the Windows batch-shim rule: CreateProcess
// cannot execute .cmd/.bat files directly (npm-installed CLIs are .cmd
// shims). Two forms, by arg trust:
// - buildCliSpawnCommand: for PROBE calls whose args are fixed literals
//   from this codebase (version/help/status/model listings) — cmd.exe
//   /d /s /c with the documented quoted-path form.
// - spawnCliProcess: for TURN spawns whose args include user text (the
//   prompt). Those go through Node's supported batch path (shell: true),
//   which applies Node's own argument escaping; args are never joined
//   into a command string by hand.
// ---------------------------------------------------------------------------

export function buildCliSpawnCommand(
  executablePath: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(executablePath)) {
    const tail = args.length > 0 ? ` ${args.join(' ')}` : '';
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"${executablePath}"${tail}`] };
  }
  return { file: executablePath, args };
}

export function spawnCliProcess(
  command: string,
  args: string[],
  opts: {
    stdio?: 'pipe' | ['ignore', 'pipe', 'pipe'] | ['pipe', 'pipe', 'pipe'];
    env?: Record<string, string>;
    timeout?: number;
    platform?: NodeJS.Platform;
  } = {},
): ChildProcess {
  const platform = opts.platform ?? process.platform;
  const isBatch = platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  return spawn(command, args, {
    stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...(isBatch ? { shell: true } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.timeout ? { timeout: opts.timeout } : {}),
  });
}

/**
 * Summarize a failed CLI run into ONE plain sentence for user surfaces.
 * Raw stderr can be a multi-KB stack trace (a Python namesake dumped its
 * whole traceback into a chat card in the field) — that must never reach
 * the UI verbatim. The summary keeps the exit description plus the single
 * most meaningful line: exception/error lines win (a traceback's final
 * line names the actual error), scaffolding lines (`File "..."`, bare
 * `Traceback ...`) are dropped, and the result is hard-capped.
 */
export function summarizeCliFailure(opts: {
  cliLabel: string;
  /** e.g. 'exited with code 1' or 'was killed by signal SIGKILL'. */
  how: string;
  stderr?: string;
  maxChars?: number;
}): string {
  const maxChars = opts.maxChars ?? 260;
  const raw = (opts.stderr ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !/^Traceback \(most recent call last\)/.test(l))
    .filter((l) => !/^File\s+"/.test(l));
  const errorLine = [...lines].reverse().find((l) => /error|exception|failed|denied|unauthorized|not logged in/i.test(l));
  const pick = errorLine ?? lines[lines.length - 1];
  const head = `${opts.cliLabel} ${opts.how}`;
  if (!pick) return `${head} and produced no error output.`;
  const clipped = pick.length > 180 ? `${pick.slice(0, 177)}…` : pick;
  const summary = `${head}: ${clipped}`;
  return summary.length > maxChars ? `${summary.slice(0, maxChars - 1)}…` : summary;
}

/** Run a CLI probe synchronously; never throws. Output is stdout+stderr combined. */
export function runCliSync(
  executablePath: string,
  args: string[],
  opts: { platform?: NodeJS.Platform; timeoutMs?: number } = {},
): { code: number | null; output: string } {
  const cmd = buildCliSpawnCommand(executablePath, args, opts.platform);
  try {
    const out = execFileSync(cmd.file, cmd.args, {
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output: typeof out === 'string' ? out : '' };
  } catch (err) {
    const e = err as { status?: unknown; stdout?: unknown; stderr?: unknown };
    const stdout = typeof e.stdout === 'string' ? e.stdout : '';
    const stderr = typeof e.stderr === 'string' ? e.stderr : '';
    return { code: typeof e.status === 'number' ? e.status : null, output: `${stdout}${stderr}` };
  }
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
 * Consent-free probe: does the CLI's credential file exist AND parse to a
 * usable token shape? Returns a boolean only — never the token. Used by the
 * in-app sign-in flow (login completion polling) and sign-in status checks,
 * which must not require (or grant) bridge consent.
 */
export function bridgeHasUsableToken(id: CliBridgeId, homeDir?: string): boolean {
  const home = homeDir ?? defaultHomeDir();
  const parsed = readJsonFile(join(home, BRIDGE_PATHS[id].credentialsRel));
  if (parsed === undefined) return false;
  if (id === 'claude') return claudeTokenFromFile(parsed) !== undefined;
  if (id === 'opencode') return opencodeTokenFromFile(parsed) !== undefined;
  return codexTokenFromFile(parsed) !== undefined;
}

function numberField(obj: unknown, path: string[]): number | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'number' && Number.isFinite(cur) ? cur : undefined;
}

/**
 * Consent-free probe: when the credential file carries an expiry timestamp,
 * return it as ms-since-epoch. Undefined when unknown (no expiry field, or
 * no credential file). Never returns token bytes.
 */
export function bridgeTokenExpiry(id: CliBridgeId, homeDir?: string): number | undefined {
  const home = homeDir ?? defaultHomeDir();
  const parsed = readJsonFile(join(home, BRIDGE_PATHS[id].credentialsRel));
  if (parsed === undefined || typeof parsed !== 'object' || parsed === null) return undefined;
  const raw =
    numberField(parsed, ['claudeAiOauth', 'expiresAt']) ??
    numberField(parsed, ['claudeAiOauth', 'expires_at']) ??
    numberField(parsed, ['tokens', 'expires_at']) ??
    numberField(parsed, ['expiresAt']) ??
    numberField(parsed, ['expires_at']);
  if (raw === undefined) return undefined;
  // Heuristic: values below 1e12 are seconds, not milliseconds.
  return raw < 1e12 ? raw * 1000 : raw;
}

/** Fields that look like secrets — never surfaced as an account hint. */
const SECRETISH_KEY_RE = /token|secret|api[-_]?key|password|credential|bearer/i;
/** Values that look like tokens — never surfaced as an account hint. */
const TOKENISH_VALUE_RE = /^(sk-ant-|sk-|xox|ghp_|gho_|Bearer\s|eyJ[A-Za-z0-9_-]{10,})/;

function safeAccountHint(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (v.length === 0 || v.length > 120) return undefined;
  if (TOKENISH_VALUE_RE.test(v)) return undefined;
  return v;
}

/**
 * Consent-free probe: best-effort non-secret account identity ("signed in as
 * X") for the sign-in status UI. Reads only clearly-labeled identity fields
 * (email/username/login); anything secret-shaped is refused. Undefined when
 * the CLI doesn't expose an identity (common — most CLI credential files
 * carry only tokens).
 */
export function bridgeAccountHint(id: CliBridgeId, homeDir?: string): string | undefined {
  const home = homeDir ?? defaultHomeDir();
  if (id === 'claude') {
    // ~/.claude.json carries the account profile next to the real
    // credentials in ~/.claude/.credentials.json (which we do NOT mine for
    // identity — it is token-shaped throughout). The address lives under
    // `oauthAccount.emailAddress`; a few top-level aliases exist in older
    // versions.
    const cfg = readJsonFile(join(home, '.claude.json'));
    if (cfg && typeof cfg === 'object') {
      const obj = cfg as Record<string, unknown>;
      const oauth = obj['oauthAccount'];
      if (oauth && typeof oauth === 'object') {
        const oa = oauth as Record<string, unknown>;
        for (const key of ['emailAddress', 'email']) {
          const hint = safeAccountHint(oa[key]);
          if (hint) return hint;
        }
      }
      for (const key of ['email', 'userEmail', 'username', 'user', 'login', 'accountEmail']) {
        if (SECRETISH_KEY_RE.test(key)) continue;
        const hint = safeAccountHint(obj[key]);
        if (hint) return hint;
      }
    }
    return undefined;
  }
  if (id === 'codex') {
    // Codex identity comes from `codex login status` (handled by cli-auth);
    // auth.json is token-shaped throughout — do not mine it.
    return undefined;
  }
  return undefined;
}

/**
 * Load the Claude bridge token from an ACCOUNT PROFILE's config dir
 * (ENGINES pack, multiple Claude accounts): the profile selects WHICH
 * credential dir the bridge reads at request time
 * (<configDir>/.credentials.json, CLAUDE_CONFIG_DIR layout). Same rules
 * as loadBridgeToken: consent-gated, memory-only, never persisted or
 * logged. Claude bridge only — other bridges have one login location.
 */
export function loadBridgeTokenForClaudeProfile(configDir: string): string | undefined {
  if (!isBridgeConnected('claude')) return undefined;
  const parsed = readJsonFile(join(configDir, '.credentials.json'));
  if (parsed === undefined) return undefined;
  return claudeTokenFromFile(parsed);
}

/** Consent-free shape probe for a profile's credential file (boolean only). */
export function claudeProfileHasUsableToken(configDir: string): boolean {
  const parsed = readJsonFile(join(configDir, '.credentials.json'));
  if (parsed === undefined) return false;
  return claudeTokenFromFile(parsed) !== undefined;
}

/** Machine-readable reason a bridge cannot connect, for UI state rendering. */
export type BridgeConnectFailureCode =
  | 'not-installed'
  | 'not-signed-in'
  | 'token-unusable'
  | 'namesake-cli'
  | 'cli-missing';

export interface BridgeConnectableResult {
  ok: boolean;
  reason?: string;
  code?: BridgeConnectFailureCode;
}

/**
 * Validate that a bridge can actually be connected right now. Used by the
 * Connect endpoint so a stale detection fails with a clear, actionable
 * message instead of a bare failure. Rules:
 * - A usable stored login is required (shape probe only — no consent is
 *   recorded and no token bytes leave this module).
 * - Claude chats run over HTTPS with the stored token, so a usable login
 *   is sufficient on its own.
 * - Codex / OpenCode chats RUN THROUGH the CLI binary, so the binary must
 *   also resolve to the REAL CLI (identity-verified): a same-named
 *   unrelated program, or no binary at all, is not connectable — reporting
 *   success there produced turns that crashed inside a stranger's tool.
 */
export function bridgeConnectable(id: CliBridgeId, opts: DetectOptions = {}): BridgeConnectableResult {
  const meta = CLI_BRIDGE_META[id];
  const detection = detectCliBridge(id, opts);
  const tokenUsable = detection.credentialsPresent && bridgeHasUsableToken(id, opts.homeDir);
  // Claude's bridge talks HTTPS with the stored token — a usable login is
  // sufficient; don't pay (or risk) a CLI probe for it.
  if (tokenUsable && id === 'claude') return { ok: true };
  const resolution = resolveVerifiedCliExecutable(id, opts);

  if (tokenUsable) {
    if (resolution.path) return { ok: true };
    if (resolution.namesake) {
      return {
        ok: false,
        code: 'namesake-cli',
        reason:
          `${bridgeNamesakeMessage(id, resolution.namesake)} ` +
          `Your stored login was found, but this bridge runs through the CLI itself, so it can't be used until the real one is installed.`,
      };
    }
    return {
      ok: false,
      code: 'cli-missing',
      reason:
        `A stored ${meta.label} login was found, but the ${BRIDGE_PATHS[id].cli} program itself wasn't found on this machine. ` +
        `Install it (${meta.installCommand}) — your existing login will then work as-is.`,
    };
  }

  if (resolution.path) {
    if (detection.credentialsPresent) {
      return {
        ok: false,
        code: 'token-unusable',
        reason:
          `A ${meta.label} login file exists, but it doesn't hold a usable sign-in — it may be expired or left over from an older version. ` +
          `Run \`${meta.signInCommand}\` in a terminal to sign in again, then press Connect again.`,
      };
    }
    return {
      ok: false,
      code: 'not-signed-in',
      reason:
        `${meta.label} is installed, but you're not signed in yet — there's no stored login to reuse. ` +
        `Use "Sign in to ${meta.label}" here, or open a terminal and run \`${meta.signInCommand}\`, finish signing in, then press Connect again.`,
    };
  }

  if (resolution.namesake) {
    return { ok: false, code: 'namesake-cli', reason: bridgeNamesakeMessage(id, resolution.namesake) };
  }

  if (detection.credentialsPresent) {
    // A login FILE exists but holds nothing usable, and no usable CLI
    // was found either — the honest state is the broken login, not
    // "not installed" (the file's presence proves an install existed).
    return {
      ok: false,
      code: 'token-unusable',
      reason:
        `A ${meta.label} login file exists, but it doesn't hold a usable sign-in — it may be expired or left over from an older version. ` +
        `Run \`${meta.signInCommand}\` in a terminal to sign in again, then press Connect again.`,
    };
  }

  return {
    ok: false,
    code: 'not-installed',
    reason:
      `No ${meta.label} installation or login was found on this machine. ` +
      `Install it (${meta.installCommand}), sign in once (\`${meta.signInCommand}\`), then press Connect.`,
  };
}

/**
 * Get available models by shelling out to the CLI.
 * For codex: `codex debug models` lists available models.
 * For claude: not yet implemented (returns empty).
 * For opencode: `opencode models` lists available models.
 * The executable is identity-verified first — a same-named unrelated
 * program is never spawned. Returns empty array on failure (caller falls
 * back to catalog).
 */
// Model lists are cached: listing spawns the CLI (seconds on a cold
// machine) and the picker asks on every providers refresh. A non-empty
// list is trusted for 5 minutes; an empty/failed one only 30s, so a CLI
// fixed in the meantime shows up quickly without hammering a broken one.
const bridgeModelsCache = new Map<CliBridgeId, { at: number; models: Array<{ id: string; name: string }> }>();
const BRIDGE_MODELS_TTL_MS = 5 * 60_000;
const BRIDGE_MODELS_EMPTY_TTL_MS = 30_000;

export function resetBridgeModelsCache(): void {
  bridgeModelsCache.clear();
}

export function getBridgeModels(id: CliBridgeId, opts: DetectOptions = {}): Array<{ id: string; name: string }> {
  const spec = BRIDGE_PATHS[id];
  if (!spec) return [];
  if (id !== 'codex' && id !== 'opencode') return [];
  const cached = bridgeModelsCache.get(id);
  if (cached) {
    const ttl = cached.models.length > 0 ? BRIDGE_MODELS_TTL_MS : BRIDGE_MODELS_EMPTY_TTL_MS;
    if (Date.now() - cached.at < ttl) return cached.models;
  }
  const resolution = resolveVerifiedCliExecutable(id, opts);
  if (!resolution.path) {
    bridgeModelsCache.set(id, { at: Date.now(), models: [] });
    return [];
  }

  const args = id === 'codex' ? ['debug', 'models'] : ['models'];
  const { output } = runCliSync(resolution.path, args, { platform: opts.platform, timeoutMs: 10000 });

  const models: Array<{ id: string; name: string }> = [];
  if (id === 'codex') {
    // Parse the output - it lists models, one per line or in a table.
    // Try to extract model IDs (lines containing gpt-, o1, o3, o4).
    for (const line of output.split('\n')) {
      const match = line.match(/\b(gpt-[\w.-]+|o\d[\w.-]*)\b/i);
      if (match) {
        const modelId = match[1].toLowerCase();
        if (!models.some((m) => m.id === modelId)) {
          models.push({ id: modelId, name: modelId });
        }
      }
    }
    bridgeModelsCache.set(id, { at: Date.now(), models });
    return models;
  }
  // opencode: lines of provider/model ids.
  for (const line of output.split('\n')) {
    const match = line.match(/\b([\w-]+\/[\w.-]+)\b/);
    if (match) {
      const modelId = match[1];
      if (!models.some((m) => m.id === modelId)) {
        models.push({ id: modelId, name: modelId });
      }
    }
  }
  bridgeModelsCache.set(id, { at: Date.now(), models });
  return models;
}
