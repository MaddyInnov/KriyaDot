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
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  CLI_IDENTITY_DECLARATIONS,
  extractSemver,
  getCachedIdentity,
  getCliPathPin,
  firstPrintedLine,
  matchIdentity,
  outputMatchesReject,
  redactCliSecrets,
  redactedFirstLine,
  setCachedIdentity,
  statForCache,
  clearIdentityCache,
} from './cli-identity.js';

// NOTE: the cli-identity helpers (declarations, pins, safe matching,
// redaction) are exported from the package root via cli-identity.js
// (see index.ts) — they are intentionally not re-exported here, so the
// root surface has exactly one source per name.

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
  /**
   * A8: per-bridge user-pinned CLI paths (explicit per-call overrides).
   * When a bridge has no entry here, the pin registry / env mirror in
   * cli-identity.ts is consulted at resolve time.
   */
  cliPathPins?: Partial<Record<CliBridgeId, string>>;
  /** A8: single-call pin override for the bridge being resolved. */
  pinnedPath?: string;
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

function detectOne(
  id: CliBridgeId,
  homeDir: string,
  pathDirs: string[],
  platform: NodeJS.Platform,
  opts: DetectOptions = {},
): BridgeDetection {
  const spec = BRIDGE_PATHS[id];
  let cliPresent = executableOnPath(spec.cli, pathDirs, platform);
  if (!cliPresent) {
    // A8: a user-pinned CLI path counts for detection even when the CLI
    // is not on PATH at all — the pin is how the user told us where it is.
    const pin = effectiveCliPin(id, opts);
    if (pin && pinnedCliCandidates(pin, platform).length > 0) cliPresent = true;
  }
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
  return (Object.keys(BRIDGE_PATHS) as CliBridgeId[]).map((id) => detectOne(id, homeDir, pathDirs, platform, opts));
}

export function detectCliBridge(id: CliBridgeId, opts: DetectOptions = {}): BridgeDetection {
  const homeDir = opts.homeDir ?? defaultHomeDir();
  const pathDirs = effectiveCliPathDirs(opts);
  const platform = opts.platform ?? process.platform;
  return detectOne(id, homeDir, pathDirs, platform, opts);
}

// ---------------------------------------------------------------------------
// User-pinned CLI paths (A8 §5). A pin is a per-bridge location hint the
// user sets in Settings → Providers. It is read at resolve time (the
// registry in cli-identity.ts, fed by the API's persisted settings), so
// changing it applies live with no restart. A pin is NOT a trust grant:
// the pinned binary goes through the same identity probe, and if it fails
// — or doesn't exist — resolution reports that plainly instead of
// silently falling back to auto-detection.
// ---------------------------------------------------------------------------

/** The effective pin for a bridge under these options, if any. */
export function effectiveCliPin(id: CliBridgeId, opts: DetectOptions = {}): string | undefined {
  return getCliPathPin(id, { override: opts.pinnedPath ?? opts.cliPathPins?.[id] });
}

/**
 * On-disk files a pinned path can mean, in resolution order. The pin
 * itself wins when it exists; on win32 a pin typed without an extension
 * also tries the standard `.exe` / `.cmd` / `.bat` forms in that exact
 * location (pins accept Windows paths verbatim — no separator rewriting).
 */
export function pinnedCliCandidates(pin: string, platform: NodeJS.Platform = process.platform): string[] {
  if (cliPathExists(pin, platform)) return [pin];
  if (platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(pin)) {
    const found: string[] = [];
    for (const ext of WIN32_CLI_EXTS) {
      const candidate = `${pin}${ext}`;
      if (cliPathExists(candidate, platform)) found.push(candidate);
    }
    return found;
  }
  return [];
}

// ---------------------------------------------------------------------------
// CLI identity verification. A file named `codex` on PATH is not
// necessarily OpenAI's Codex CLI — other tools ship same-named commands
// (a Python package's `codex` crashed with an import traceback in the
// field). Before KriyaDot spawns a candidate or reports a bridge as
// connectable, the candidate must answer `--version` like the real tool.
// The patterns are DECLARED data (cli-identity.ts, A8 §1) consumed via
// linear, length-capped matchers — never raw regexes over untrusted
// output (A8 §3). Probes are cached per file by (path + size + mtime)
// so repeated checks do not re-spawn the binary (A8 §2).
// ---------------------------------------------------------------------------

export interface CliIdentityResult {
  ok: boolean;
  /** Semver extracted from the version output, when present. */
  version?: string;
  /** Plain-language guess at what a rejected candidate actually is. */
  looksLike?: string;
  /**
   * The candidate's first printed line, secrets redacted and capped —
   * set on refusals so the user can see what actually answered (A8 §4).
   */
  firstLine?: string;
}

/** Test helper: drop cached identity probes. */
export function resetCliIdentityCache(): void {
  clearIdentityCache();
}

function describeCandidate(executablePath: string, output: string, rejected: boolean): string | undefined {
  if (rejected || /site-packages/i.test(executablePath) || /python/i.test(executablePath)) {
    return 'a Python program';
  }
  return undefined;
}

/**
 * Probe one candidate executable: does it answer like the real CLI?
 * Runs the declared probe args (plus the declared help fallback where
 * one exists) with a short timeout. Results are cached by
 * (absolute path + file size + mtime): an unchanged file is never
 * re-spawned; a replaced or touched file always re-probes.
 */
export function probeCliIdentity(
  id: CliBridgeId,
  executablePath: string,
  opts: { platform?: NodeJS.Platform; timeoutMs?: number } = {},
): CliIdentityResult {
  const stat = statForCache(executablePath);
  if (stat) {
    const cached = getCachedIdentity<CliIdentityResult>(executablePath, stat.size, stat.mtimeMs);
    if (cached) return cached;
  }

  const decl = CLI_IDENTITY_DECLARATIONS[id];
  const timeoutMs = opts.timeoutMs ?? 5000;
  const versionRun = runCliSync(executablePath, decl.versionArgs, { platform: opts.platform, timeoutMs });
  const rejected = outputMatchesReject(versionRun.output, decl.rejectIfOutputContains);
  let result: CliIdentityResult;
  if (rejected) {
    result = {
      ok: false,
      looksLike: describeCandidate(executablePath, versionRun.output, true),
      firstLine: redactedFirstLine(versionRun.output),
    };
  } else if (matchIdentity(decl.versionMatch, versionRun.output)) {
    const version = extractSemver(firstPrintedLine(versionRun.output));
    result = { ok: true, ...(version ? { version } : {}) };
  } else if (decl.helpArgs && decl.helpMatch) {
    const helpRun = runCliSync(executablePath, decl.helpArgs, { platform: opts.platform, timeoutMs });
    const helpRejected = outputMatchesReject(helpRun.output, decl.rejectIfOutputContains);
    result =
      !helpRejected && matchIdentity(decl.helpMatch, helpRun.output)
        ? { ok: true }
        : {
            ok: false,
            looksLike: describeCandidate(executablePath, helpRun.output, helpRejected),
            firstLine: redactedFirstLine(versionRun.output) || redactedFirstLine(helpRun.output),
          };
  } else {
    result = {
      ok: false,
      looksLike: describeCandidate(executablePath, versionRun.output, false),
      firstLine: redactedFirstLine(versionRun.output),
    };
  }
  if (stat) setCachedIdentity(executablePath, stat.size, stat.mtimeMs, result);
  return result;
}

/** A8: outcome of resolving a user-pinned CLI path. */
export interface PinnedCliResolution {
  /** The pin exactly as the user set it. */
  path: string;
  status: 'verified' | 'not-found' | 'identity-failed';
  /** The on-disk file the pin resolved to, when one exists. */
  resolvedPath?: string;
  /** Verified version string (status 'verified' only, when captured). */
  version?: string;
  looksLike?: string;
  /** Redacted first printed line (status 'identity-failed', when printed). */
  firstLine?: string;
}

export interface VerifiedCliResolution {
  /** Absolute path of the first candidate that passed the identity probe. */
  path?: string;
  /** The verified CLI's version string, when the probe captured one. */
  version?: string;
  /** Every on-disk candidate, in resolution order. */
  candidates: string[];
  /** When candidates exist but none is the real CLI: the first namesake. */
  namesake?: { path: string; looksLike?: string; firstLine?: string };
  /** A8: set whenever a user pin was in effect for this resolution. */
  pinned?: PinnedCliResolution;
}

/**
 * Resolve a bridge CLI to a VERIFIED executable.
 * - With a user pin in effect: the pin is the ONLY location considered.
 *   It still must pass identity; a missing or wrong-identity pinned file
 *   resolves to `pinned` (never to a PATH fallback), so the failure is
 *   surfaced plainly instead of being silently papered over.
 * - Without a pin: enumerate every same-named PATH candidate in order
 *   and return the first that answers like the real tool. A wrong-identity
 *   namesake earlier on PATH never shadows a real CLI later on PATH, and
 *   a namesake alone resolves to `namesake`, never to `path`.
 */
export function resolveVerifiedCliExecutable(
  id: CliBridgeId,
  opts: DetectOptions & { timeoutMs?: number } = {},
): VerifiedCliResolution {
  const pin = effectiveCliPin(id, opts);
  if (pin) {
    const platform = opts.platform ?? process.platform;
    const pinnedFiles = pinnedCliCandidates(pin, platform);
    if (pinnedFiles.length === 0) {
      return { candidates: [], pinned: { path: pin, status: 'not-found' } };
    }
    let firstFailure: CliIdentityResult | undefined;
    let firstFailureFile: string | undefined;
    for (const file of pinnedFiles) {
      const probe = probeCliIdentity(id, file, { platform: opts.platform, timeoutMs: opts.timeoutMs });
      if (probe.ok) {
        return {
          path: file,
          ...(probe.version ? { version: probe.version } : {}),
          candidates: pinnedFiles,
          pinned: { path: pin, status: 'verified', resolvedPath: file, ...(probe.version ? { version: probe.version } : {}) },
        };
      }
      firstFailure ??= probe;
      firstFailureFile ??= file;
    }
    return {
      candidates: pinnedFiles,
      ...(firstFailureFile
        ? {
            namesake: {
              path: firstFailureFile,
              ...(firstFailure?.looksLike ? { looksLike: firstFailure.looksLike } : {}),
              ...(firstFailure?.firstLine ? { firstLine: firstFailure.firstLine } : {}),
            },
          }
        : {}),
      pinned: {
        path: pin,
        status: 'identity-failed',
        ...(firstFailureFile ? { resolvedPath: firstFailureFile } : {}),
        ...(firstFailure?.looksLike ? { looksLike: firstFailure.looksLike } : {}),
        ...(firstFailure?.firstLine ? { firstLine: firstFailure.firstLine } : {}),
      },
    };
  }
  const candidates = enumerateCliCandidates(BRIDGE_PATHS[id].cli, opts);
  let namesake: VerifiedCliResolution['namesake'];
  for (const candidate of candidates) {
    const probe = probeCliIdentity(id, candidate, { platform: opts.platform, timeoutMs: opts.timeoutMs });
    if (probe.ok) {
      return { path: candidate, ...(probe.version ? { version: probe.version } : {}), candidates };
    }
    namesake ??= {
      path: candidate,
      ...(probe.looksLike ? { looksLike: probe.looksLike } : {}),
      ...(probe.firstLine ? { firstLine: probe.firstLine } : {}),
    };
  }
  return { candidates, ...(namesake ? { namesake } : {}) };
}

/** The plain-words sentence for "a program with this name exists, but it is not the real CLI". */
export function bridgeNamesakeMessage(
  id: CliBridgeId,
  namesake: { path: string; looksLike?: string; firstLine?: string },
): string {
  const meta = CLI_BRIDGE_META[id];
  const name = BRIDGE_PATHS[id].cli;
  return (
    `Found a program named "${name}" on this machine, but it isn't ${meta.label}` +
    `${namesake.looksLike ? ` — it appears to be ${namesake.looksLike}` : ''}. ` +
    `${namesake.firstLine ? `It printed: "${namesake.firstLine}". ` : ''}` +
    `Install the real ${meta.label} (${meta.installCommand}), then sign in with \`${meta.signInCommand}\`.`
  );
}

/** The plain-words sentence for a pinned CLI path that cannot be used (A8 §5). */
export function bridgePinnedMessage(id: CliBridgeId, pinned: PinnedCliResolution): string {
  const meta = CLI_BRIDGE_META[id];
  if (pinned.status === 'verified') return `Using your pinned ${meta.label} at ${pinned.path}.`;
  if (pinned.status === 'not-found') {
    return (
      `Your pinned ${meta.label} path "${pinned.path}" doesn't point to a file on this machine. ` +
      `Fix the path in Settings → Providers, or clear it to go back to auto-detection.`
    );
  }
  return (
    `Your pinned ${meta.label} path "${pinned.path}" was found, but the program there isn't ${meta.label}` +
    `${pinned.looksLike ? ` — it appears to be ${pinned.looksLike}` : ''}. ` +
    `${pinned.firstLine ? `It printed: "${pinned.firstLine}". ` : ''}` +
    `A pinned path is only a location hint — it still has to be the real CLI. ` +
    `Fix the path, or clear it in Settings → Providers to go back to auto-detection.`
  );
}

/** The single failure sentence for a resolution: pinned failures speak first. */
export function bridgeResolutionFailureMessage(id: CliBridgeId, resolution: VerifiedCliResolution): string {
  if (resolution.pinned && resolution.pinned.status !== 'verified') {
    return bridgePinnedMessage(id, resolution.pinned);
  }
  if (resolution.namesake) return bridgeNamesakeMessage(id, resolution.namesake);
  const meta = CLI_BRIDGE_META[id];
  return (
    `${meta.label} is not installed or not on PATH. ` +
    `Install it (${meta.installCommand}) and sign in (\`${meta.signInCommand}\`) — KriyaDot uses the CLI's own login.`
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
  // A8 §4: a quoted line never leaves with credential-shaped text intact.
  const redacted = redactCliSecrets(pick);
  const clipped = redacted.length > 180 ? `${redacted.slice(0, 177)}…` : redacted;
  const summary = `${head}: ${clipped}`;
  return summary.length > maxChars ? `${summary.slice(0, maxChars - 1)}…` : summary;
}

/** Run a CLI probe synchronously; never throws. Output is stdout+stderr combined. */
export function runCliSync(
  executablePath: string,
  args: string[],
  opts: { platform?: NodeJS.Platform; timeoutMs?: number; env?: Record<string, string> } = {},
): { code: number | null; output: string } {
  const cmd = buildCliSpawnCommand(executablePath, args, opts.platform);
  try {
    const out = execFileSync(cmd.file, cmd.args, {
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // A6: per-account probes run under the account's config-dir env
      // (merged over the process env, exactly like a turn spawn).
      ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
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

/**
 * A6: consent-free shape probe for ONE credential file at an explicit
 * path — the per-account variant of bridgeHasUsableToken (an account's
 * credential file lives inside its own config dir, not under the machine
 * home). Boolean only — never returns token bytes.
 */
export function bridgeHasUsableTokenAtPath(id: CliBridgeId, credentialsPath: string): boolean {
  const parsed = readJsonFile(credentialsPath);
  if (parsed === undefined) return false;
  if (id === 'claude') return claudeTokenFromFile(parsed) !== undefined;
  if (id === 'opencode') return opencodeTokenFromFile(parsed) !== undefined;
  return codexTokenFromFile(parsed) !== undefined;
}

/**
 * A6: consent-gated token load from an explicit credential file path —
 * the per-account variant of loadBridgeToken. Memory-only, never logged
 * or persisted, exactly like the machine-default loader.
 */
export function loadBridgeTokenAtPath(id: CliBridgeId, credentialsPath: string): string | undefined {
  if (!isBridgeConnected(id)) return undefined;
  const parsed = readJsonFile(credentialsPath);
  if (parsed === undefined) return undefined;
  if (id === 'claude') return claudeTokenFromFile(parsed);
  if (id === 'opencode') return opencodeTokenFromFile(parsed);
  return codexTokenFromFile(parsed);
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
  | 'cli-missing'
  /** A8: a user-pinned CLI path is set but missing or not the real CLI. */
  | 'pinned-cli-invalid';

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
  // sufficient; don't pay (or risk) a CLI probe for it. A8 exception: when
  // the user has pinned a CLI path, a broken pin is reported plainly even
  // here — silently ignoring an explicit pin would hide a misconfiguration.
  if (tokenUsable && id === 'claude' && !effectiveCliPin(id, opts)) return { ok: true };
  const resolution = resolveVerifiedCliExecutable(id, opts);
  const pinnedFailure =
    resolution.pinned && resolution.pinned.status !== 'verified' ? resolution.pinned : undefined;

  if (tokenUsable) {
    if (resolution.path) return { ok: true };
    if (pinnedFailure) {
      return { ok: false, code: 'pinned-cli-invalid', reason: bridgePinnedMessage(id, pinnedFailure) };
    }
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

  if (pinnedFailure) {
    return { ok: false, code: 'pinned-cli-invalid', reason: bridgePinnedMessage(id, pinnedFailure) };
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
const bridgeModelsCache = new Map<
  CliBridgeId,
  { at: number; models: Array<{ id: string; name: string }>; resolvedPath?: string }
>();
const BRIDGE_MODELS_TTL_MS = 5 * 60_000;
const BRIDGE_MODELS_EMPTY_TTL_MS = 30_000;

export function resetBridgeModelsCache(): void {
  bridgeModelsCache.clear();
}

export function getBridgeModels(id: CliBridgeId, opts: DetectOptions = {}): Array<{ id: string; name: string }> {
  const spec = BRIDGE_PATHS[id];
  if (!spec) return [];
  if (id !== 'codex' && id !== 'opencode') return [];
  // Resolve first (identity probes are cached per file, so this is cheap):
  // the model cache is only valid for the SAME resolved binary — an A8 pin
  // change or a PATH change must not serve the previous binary's models.
  const resolution = resolveVerifiedCliExecutable(id, opts);
  const cached = bridgeModelsCache.get(id);
  if (cached && cached.resolvedPath === resolution.path) {
    const ttl = cached.models.length > 0 ? BRIDGE_MODELS_TTL_MS : BRIDGE_MODELS_EMPTY_TTL_MS;
    if (Date.now() - cached.at < ttl) return cached.models;
  }
  if (!resolution.path) {
    bridgeModelsCache.set(id, { at: Date.now(), models: [], resolvedPath: undefined });
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
    bridgeModelsCache.set(id, { at: Date.now(), models, resolvedPath: resolution.path });
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
  bridgeModelsCache.set(id, { at: Date.now(), models, resolvedPath: resolution.path });
  return models;
}
