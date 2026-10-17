// SPDX-License-Identifier: Apache-2.0
/**
 * In-app subscription sign-in for native CLI drivers (OpenMausBot parity
 * P0 #8): start the CLI's own login flow from Settings → Providers, capture
 * the OAuth URL in-app, and detect completion by polling the CLI's credential
 * file — the user never pastes tokens anywhere.
 *
 * Security contract (hard rules):
 * - The login child is spawned WITHOUT a shell. Its stdout is scanned ONLY
 *   for an `https://` URL (the OAuth authorize URL); everything else is
 *   discarded. The buffer is capped and dropped when the flow ends.
 * - Completion is detected by credential-file SHAPE (a usable token parses),
 *   never by reading token bytes into JS strings that could leak. Status
 *   and login results carry booleans and redacted hints only.
 * - Tokens never appear in logs, errors, audit entries, or API responses.
 * - `codex login --with-api-key` / `--with-access-token` are deliberately
 *   NOT used: this module never handles key material, only the browser
 *   OAuth dance.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  bridgeAccountHint,
  bridgeHasUsableToken,
  bridgeTokenExpiry,
  type CliBridgeId,
} from './cli-bridge.js';

export type CliAuthId = 'claude' | 'codex' | 'opencode' | 'antigravity';

/** Map the auth-module ids onto the bridge ids (same CLIs). Antigravity has no bridge. */
function toBridgeId(id: CliAuthId): CliBridgeId {
  if (id === 'antigravity') throw new Error('antigravity has no CLI bridge');
  return id;
}

/**
 * Antigravity (Google's agent IDE/CLI, `agy`) auth layout, from public
 * community sources (the `agy` binary is proprietary; this mirrors the
 * claude/codex in-app pattern against its documented behavior):
 * - First run of bare `agy` walks through a one-time Google sign-in; in a
 *   headless session (SSH / no display) it prints an authorization URL for
 *   a local browser — exactly the URL-capture flow below.
 * - OAuth tokens live in the OS native keyring (unreadable from Node), and
 *   the ACP server profile keeps OAuth state under `~/.gemini/`
 *   (`~/.gemini/antigravity-acp/oauth_creds.json` per community reports).
 * Detection is therefore best-effort file-shape based and labeled as such;
 * sign-in completion falls back to "credential file appeared/changed".
 */
const ANTIGRAVITY_CRED_REL = join('.gemini', 'antigravity-acp', 'oauth_creds.json');

export interface CliLoginStatus {
  cliId: CliAuthId;
  /** The CLI executable was found on PATH. */
  cliPresent: boolean;
  /** The CLI's credential file exists. */
  credentialsPresent: boolean;
  /** A usable login is present right now. */
  signedIn: boolean;
  /** Best-effort non-secret identity ("you@example.com"). Never a token. */
  accountHint?: string;
  /** True when the stored credential carries a past expiry timestamp. */
  expired?: boolean;
}

export interface LoginResult {
  ok: boolean;
  reason?: string;
}

export interface ActiveLogin {
  /** Resolves with the OAuth URL once the CLI prints it (≤ urlTimeoutMs). */
  url: Promise<string>;
  /** Resolves when the credential file becomes valid (or the flow fails). */
  done: Promise<LoginResult>;
  cancel: () => void;
}

export interface SpawnHandle {
  child: ChildProcess;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
}

export interface CliAuthDeps {
  homeDir?: string;
  pathDirs?: string[];
  spawnFn?: (command: string, args: string[]) => SpawnHandle;
  fileExists?: (path: string) => boolean;
  fileMtimeMs?: (path: string) => number | undefined;
  readText?: (path: string) => string | undefined;
  /** How long to wait for the OAuth URL (default 60s). */
  urlTimeoutMs?: number;
  /** How long to poll for credential completion (default 10 min). */
  loginTimeoutMs?: number;
  /** Credential poll interval (default 2s). */
  pollIntervalMs?: number;
  now?: () => number;
}

const CLI_COMMANDS: Record<CliAuthId, string> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  antigravity: 'agy',
};

/**
 * Args that trigger the CLI's browser-OAuth login. These start the CLI's OWN
 * flow (it prints an authorize URL and waits); KriyaDot only watches.
 * - claude: a bare `claude` starts the interactive login when unauthenticated.
 * - codex: `codex login` manages login (prints the device/browser URL).
 * - opencode: `opencode auth login` (best-effort; the opencode CLI surface varies).
 * - antigravity: bare `agy` runs the first-run Google sign-in walkthrough;
 *   in a headless session it prints an authorization URL instead of opening
 *   a browser (documented `agy` behavior).
 */
const LOGIN_ARGS: Record<CliAuthId, string[]> = {
  claude: [],
  codex: ['login'],
  opencode: ['auth', 'login'],
  antigravity: [],
};

/** Command that reports login status without starting a flow (when available). */
const STATUS_COMMAND: Record<CliAuthId, string[] | null> = {
  // No status subcommand; fall back to credential-file shape.
  claude: null,
  // `codex login status` prints "Not logged in" or account info.
  codex: ['login', 'status'],
  opencode: null,
  // No status subcommand; fall back to the ~/.gemini profile shape.
  antigravity: null,
};

const URL_RE = /https?:\/\/[^\s"'<>]+/;
const MAX_STDOUT_BYTES = 64 * 1024;

function defaultHomeDir(): string {
  const override = process.env.HOME;
  if (override && override.length > 0) return override;
  return homedir();
}

function executableOnPath(command: string, pathDirs: string[]): boolean {
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

function defaultSpawn(command: string, args: string[]): SpawnHandle {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return { child, stdout: child.stdout, stderr: child.stderr };
}

/** Redact anything token-shaped before a string leaves this module. */
export function redactTokenish(s: string): string {
  return s
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9]{8,}/g, '[REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
    .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token)["'\s:=]+[A-Za-z0-9._-]{8,}/gi, '$1=[REDACTED]');
}

export class CliAuthManager {
  private readonly homeDir: string;
  private readonly pathDirs: string[];
  private readonly spawnFn: (command: string, args: string[]) => SpawnHandle;
  private readonly fileExists: (path: string) => boolean;
  private readonly fileMtimeMs: (path: string) => number | undefined;
  private readonly readText: (path: string) => string | undefined;
  private readonly urlTimeoutMs: number;
  private readonly loginTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;

  constructor(deps: CliAuthDeps = {}) {
    this.homeDir = deps.homeDir ?? defaultHomeDir();
    this.pathDirs = deps.pathDirs ?? (process.env.PATH ?? '').split(delimiter).filter((d) => d.length > 0);
    this.spawnFn = deps.spawnFn ?? defaultSpawn;
    this.fileExists =
      deps.fileExists ?? ((p) => { try { return existsSync(p); } catch { return false; } });
    this.fileMtimeMs =
      deps.fileMtimeMs ??
      ((p) => { try { return statSync(p).mtimeMs; } catch { return undefined; } });
    this.readText =
      deps.readText ??
      ((p) => { try { return readFileSync(p, 'utf8'); } catch { return undefined; } });
    this.urlTimeoutMs = deps.urlTimeoutMs ?? 60_000;
    this.loginTimeoutMs = deps.loginTimeoutMs ?? 600_000;
    this.pollIntervalMs = deps.pollIntervalMs ?? 2000;
    this.now = deps.now ?? (() => Date.now());
  }

  private credentialsPath(id: CliAuthId): string {
    if (id === 'antigravity') return join(this.homeDir, ANTIGRAVITY_CRED_REL);
    const rel =
      id === 'claude'
        ? join('.claude', '.credentials.json')
        : id === 'codex'
          ? join('.codex', 'auth.json')
          : join('.local', 'share', 'opencode', 'auth.json');
    return join(this.homeDir, rel);
  }

  /**
   * Best-effort "usable credential" check. Antigravity keeps OAuth tokens
   * in the OS keyring (unreadable from Node), so file-shape presence of the
   * ACP profile's oauth_creds.json is the signal — documented as heuristic.
   */
  private hasUsableCredential(id: CliAuthId): boolean {
    if (id === 'antigravity') return this.fileExists(this.credentialsPath(id));
    return bridgeHasUsableToken(toBridgeId(id), this.homeDir);
  }

  cliPresent(id: CliAuthId): boolean {
    return executableOnPath(CLI_COMMANDS[id], this.pathDirs);
  }

  /** Sign-in status. Never returns token bytes. */
  async getStatus(id: CliAuthId): Promise<CliLoginStatus> {
    const cliPresent = this.cliPresent(id);
    const credPath = this.credentialsPath(id);
    const credentialsPresent = this.fileExists(credPath);

    // Prefer the CLI's own status command when one exists.
    const statusArgs = STATUS_COMMAND[id];
    if (statusArgs && cliPresent) {
      const out = await this.runStatusCommand(id, statusArgs);
      if (out !== undefined) {
        const { signedIn, accountHint } = parseCodexLoginStatus(out);
        return { cliId: id, cliPresent, credentialsPresent, signedIn, accountHint };
      }
      // Status command failed — fall through to the file-shape probe.
    }

    const signedIn = credentialsPresent && this.hasUsableCredential(id);
    let expired: boolean | undefined;
    let accountHint: string | undefined;
    // Antigravity tokens live in the OS keyring — no expiry/hint available.
    if (signedIn && id !== 'antigravity') {
      const expiry = bridgeTokenExpiry(toBridgeId(id), this.homeDir);
      expired = expiry !== undefined ? expiry <= this.now() : undefined;
      accountHint = bridgeAccountHint(toBridgeId(id), this.homeDir);
    }
    return { cliId: id, cliPresent, credentialsPresent, signedIn, ...(expired !== undefined ? { expired } : {}), ...(accountHint ? { accountHint } : {}) };
  }

  private runStatusCommand(id: CliAuthId, args: string[]): Promise<string | undefined> {
    return new Promise((resolve) => {
      let handle: SpawnHandle;
      try {
        handle = this.spawnFn(CLI_COMMANDS[id], args);
      } catch {
        resolve(undefined);
        return;
      }
      let out = '';
      const timer = setTimeout(() => {
        try { handle.child.kill('SIGKILL'); } catch { /* dead */ }
        resolve(undefined);
      }, 10_000);
      // NB: `codex login status` prints to stderr, not stdout — read both.
      const onData = (d: Buffer): void => {
        out += d.toString('utf8');
        if (out.length > 8192) out = out.slice(-8192);
      };
      handle.stdout?.on('data', onData);
      handle.stderr?.on('data', onData);
      handle.child.on('error', () => {
        clearTimeout(timer);
        resolve(undefined);
      });
      handle.child.on('close', () => {
        clearTimeout(timer);
        resolve(out);
      });
    });
  }

  /**
   * Start the CLI's login flow. The CLI prints an OAuth URL; we capture it
   * (URL-only — the rest of stdout is discarded) and poll the credential
   * file until the login completes. The user completes auth in their
   * browser; no tokens are ever pasted or displayed.
   */
  startLogin(id: CliAuthId): ActiveLogin {
    const credPath = this.credentialsPath(id);
    const beforeMtime = this.fileMtimeMs(credPath);
    const beforeValid = this.hasUsableCredential(id);

    let handle: SpawnHandle;
    try {
      handle = this.spawnFn(CLI_COMMANDS[id], LOGIN_ARGS[id]);
    } catch (err) {
      const reason = `Could not start the ${CLI_COMMANDS[id]} login: ${err instanceof Error ? err.message : String(err)}`;
      return {
        url: Promise.reject(new Error(reason)),
        done: Promise.resolve({ ok: false, reason }),
        cancel: () => undefined,
      };
    }

    let urlResolve!: (url: string) => void;
    let urlReject!: (err: Error) => void;
    const url = new Promise<string>((resolve, reject) => {
      urlResolve = resolve;
      urlReject = reject;
    });

    let cancelled = false;
    let stdoutBuf = '';
    let urlFound = false;
    const killChild = (h: SpawnHandle): void => {
      try {
        h.child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    };

    const urlTimer = setTimeout(() => {
      if (!urlFound) {
        urlReject(
          new Error(
            `The ${CLI_COMMANDS[id]} login did not print an authorize URL within ${Math.round(this.urlTimeoutMs / 1000)}s. ` +
              `Sign in once in your terminal (${CLI_COMMANDS[id]}), then retry.`,
          ),
        );
        killChild(handle);
      }
    }, this.urlTimeoutMs);

    handle.stdout?.on('data', (d: Buffer) => {
      if (urlFound) return;
      stdoutBuf += d.toString('utf8');
      if (stdoutBuf.length > MAX_STDOUT_BYTES) stdoutBuf = stdoutBuf.slice(-MAX_STDOUT_BYTES);
      const m = URL_RE.exec(stdoutBuf);
      if (m) {
        urlFound = true;
        clearTimeout(urlTimer);
        stdoutBuf = ''; // drop everything but the URL
        urlResolve(m[0]);
      }
    });
    // Swallow stderr quietly — it may contain terminal control chatter.
    handle.stderr?.on('data', () => undefined);
    handle.child.on('error', (err) => {
      clearTimeout(urlTimer);
      if (!urlFound) urlReject(new Error(`Login process failed to start: ${redactTokenish(err.message)}`));
    });
    handle.child.on('close', () => {
      clearTimeout(urlTimer);
      if (!urlFound) {
        urlReject(
          new Error(
            `The ${CLI_COMMANDS[id]} login exited before printing an authorize URL. ` +
              `Sign in once in your terminal (${CLI_COMMANDS[id]}), then retry.`,
          ),
        );
      }
    });

    const kill = killChild;

    const done = (async (): Promise<LoginResult> => {
      try {
        await url; // wait until the URL was captured (or the flow failed early)
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
      const deadline = this.now() + this.loginTimeoutMs;
      while (this.now() < deadline && !cancelled) {
        await new Promise((r) => setTimeout(r, this.pollIntervalMs));
        if (cancelled) break;
        const mtime = this.fileMtimeMs(credPath);
        // Completion = a usable token shape exists AND the file is new or
        // changed since we started (avoids "already logged in" false-positives
        // when the user never completes THIS flow... though an existing valid
        // login also satisfies sign-in — see below).
        if (this.hasUsableCredential(id) && (beforeMtime === undefined || mtime === undefined || mtime > beforeMtime || !beforeValid)) {
          kill(handle);
          return { ok: true };
        }
      }
      kill(handle);
      if (cancelled) return { ok: false, reason: 'Login cancelled.' };
      // Final check: maybe the user was already signed in and the CLI reused it.
      if (this.hasUsableCredential(id)) return { ok: true };
      return {
        ok: false,
        reason: `Login not completed within ${Math.round(this.loginTimeoutMs / 1000 / 60)} minutes. The authorize URL expired — start again for a fresh one.`,
      };
    })();

    return {
      url,
      done,
      cancel: () => {
        cancelled = true;
        clearTimeout(urlTimer);
        stdoutBuf = '';
        kill(handle);
      },
    };
  }
}

/**
 * Parse `codex login status` output. Observed: "Not logged in" when absent.
 * When logged in it prints account lines — the first line is surfaced as a
 * redacted account hint (never token bytes).
 */
export function parseCodexLoginStatus(output: string): { signedIn: boolean; accountHint?: string } {
  const text = output.trim();
  if (!text) return { signedIn: false };
  if (/not logged in/i.test(text)) return { signedIn: false };
  const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const hint = redactTokenish(firstLine).slice(0, 120) || undefined;
  return { signedIn: true, ...(hint ? { accountHint: hint } : {}) };
}
