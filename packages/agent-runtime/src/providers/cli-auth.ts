// SPDX-License-Identifier: Apache-2.0
/**
 * In-app subscription sign-in for native CLI drivers (OpenMausBot parity
 * P0 #8): start the CLI's own login flow from Settings → Providers, capture
 * the OAuth URL in-app, and detect completion by polling the CLI's credential
 * file — the user never pastes tokens anywhere.
 *
 * Security contract (hard rules):
 * - The login child is spawned from an argv array, never a hand-built
 *   shell string (the one Windows exception: .cmd/.bat shims go through
 *   the shell via spawnCliProcess, which relies on Node's own argument
 *   escaping — the login args are fixed literals anyway). The executable
 *   is identity-verified first: a same-named impostor program is never
 *   spawned. Its stdout is
 *   scanned ONLY for an `https://` URL (the OAuth authorize URL);
 *   everything else is discarded. The buffer is capped and dropped when
 *   the flow ends.
 * - Completion is detected by credential-file SHAPE (a usable token parses),
 *   never by reading token bytes into JS strings that could leak. Status
 *   and login results carry booleans and redacted hints only.
 * - Tokens never appear in logs, errors, audit entries, or API responses.
 * - `codex login --with-api-key` / `--with-access-token` are deliberately
 *   NOT used: this module never handles key material, only the browser
 *   OAuth dance.
 */

import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  BRIDGE_PATHS_ALL,
  bridgeAccountHint,
  bridgeHasUsableToken,
  bridgeHasUsableTokenAtPath,
  bridgeNamesakeMessage,
  bridgePinnedMessage,
  bridgeTokenExpiry,
  CLI_BRIDGE_META,
  resolveCliExecutable,
  resolveVerifiedCliExecutable,
  spawnCliProcess,
  type CliBridgeId,
} from './cli-bridge.js';

/**
 * A6: a non-default bridge account's sign-in context — the account's
 * config-dir env (the login child is spawned under it, so the CLI
 * writes the NEW account's credential file, never the machine
 * default's) plus that account's credential file path (completion is
 * polled there). Built by bridge-accounts.ts consumers; this module
 * stays ignorant of the account registry.
 */
export interface CliAccountContext {
  env?: Record<string, string>;
  credentialsPath?: string;
}

export type CliAuthId =
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'antigravity'
  | 'copilot'
  | 'grok'
  | 'kimi'
  | 'pi'
  | 'hermes';

/**
 * Map the auth-module ids onto the bridge ids (same CLIs). Antigravity
 * has no bridge. A2: Copilot became a bridge (its auth layout below is
 * unchanged — the GitHub hosts.yml shape), joined by grok / kimi / pi /
 * hermes, all declared in their provider manifests.
 */
function toBridgeId(id: CliAuthId): CliBridgeId {
  if (id === 'antigravity') throw new Error(`${id} has no CLI bridge`);
  return id;
}

function isBridgeId(id: CliAuthId): boolean {
  return id !== 'antigravity';
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

/**
 * GitHub Copilot CLI auth layout (W9): Copilot authenticates with the
 * user's GitHub login, shared with the GitHub CLI — credentials live in
 * `~/.config/gh/hosts.yml` (written by `gh auth login` / the Copilot CLI's
 * own first-run login). KriyaDot does NOT implement GitHub OAuth and never
 * returns token bytes: status detection checks only the file's SHAPE (a
 * `user:` and/or `oauth_token:` entry with a value) and surfaces the GitHub
 * username as the account hint.
 */
const COPILOT_CRED_REL = join('.config', 'gh', 'hosts.yml');

export interface CliLoginStatus {
  cliId: CliAuthId;
  /**
   * The REAL CLI was found (identity-verified for the bridge CLIs: a
   * same-named unrelated program does not count as present).
   */
  cliPresent: boolean;
  /** The CLI's credential file exists. */
  credentialsPresent: boolean;
  /** A usable login is present right now. */
  signedIn: boolean;
  /** Best-effort non-secret identity ("you@example.com"). Never a token. */
  accountHint?: string;
  /** True when the stored credential carries a past expiry timestamp. */
  expired?: boolean;
  /**
   * Plain-words warning when a program carries this CLI's name but is not
   * the real CLI (e.g. a Python tool named `codex`). cliPresent is false
   * in that state; this explains why and how to fix it.
   */
  namesakeWarning?: string;
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
  /**
   * Paste-code flows only (Claude Code `claude auth login`): hand the code
   * the user copied from the browser page to the waiting CLI process.
   * Present only when this login accepts a code. The code is written to
   * the child's stdin and never logged or stored.
   */
  submitCode?: (code: string) => void;
}

export interface SpawnHandle {
  child: ChildProcess;
  stdin?: NodeJS.WritableStream | null;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
}

/** Outcome of resolving a CLI name to an executable we may spawn. */
export interface CliResolution {
  /** Absolute path of the verified executable, when one was found. */
  path?: string;
  /** Plain-words namesake warning (a same-named impostor was found instead). */
  namesakeWarning?: string;
}

export interface CliAuthDeps {
  homeDir?: string;
  pathDirs?: string[];
  /** A6: the optional third arg carries a per-account spawn env. */
  spawnFn?: (command: string, args: string[], opts?: { env?: Record<string, string> }) => SpawnHandle;
  fileExists?: (path: string) => boolean;
  fileMtimeMs?: (path: string) => number | undefined;
  readText?: (path: string) => string | undefined;
  /** Platform override (tests). Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** CLI resolution override (tests). Defaults to identity-verified resolution. */
  resolveCli?: (id: CliAuthId) => CliResolution;
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
  copilot: 'copilot',
  grok: 'grok',
  kimi: 'kimi',
  pi: 'pi',
  hermes: 'hermes',
};

/**
 * Args that trigger the CLI's browser-OAuth login. These start the CLI's OWN
 * flow (it prints an authorize URL and waits); KriyaDot only watches.
 * - claude: `claude auth login` — the dedicated sign-in command. It works
 *   on a plain pipe (prints the authorize URL, then reads the code the
 *   page shows back from stdin: a paste-code flow). A bare `claude` starts
 *   the interactive TUI instead, which prints NOTHING on a pipe — that was
 *   the old behaviour and it could never complete in-app.
 * - codex: `codex login` manages login (prints the device/browser URL).
 * - opencode: `opencode auth login` (best-effort; the opencode CLI surface varies).
 * - antigravity: bare `agy` runs the first-run Google sign-in walkthrough;
 *   in a headless session it prints an authorization URL instead of opening
 *   a browser (documented `agy` behavior).
 */
const LOGIN_ARGS: Record<CliAuthId, string[]> = {
  claude: ['auth', 'login'],
  codex: ['login'],
  opencode: ['auth', 'login'],
  antigravity: [],
  // A bare `copilot` run walks through the GitHub login when unauthenticated.
  copilot: [],
  // A2 (declared in each manifest's auth block; banner/args marked
  // assumed there where no binary could be run to confirm them):
  // grok / kimi expose a `login` command in their public docs; Hermes'
  // sign-in lives in its `setup` flow; Pi signs in from its own first
  // run / interactive `/login`, so a bare run is the honest spawn.
  grok: ['login'],
  kimi: ['login'],
  pi: [],
  hermes: ['setup'],
};

/** Command that reports login status without starting a flow (when available). */
const STATUS_COMMAND: Record<CliAuthId, string[] | null> = {
  // `claude auth status` prints JSON ({"loggedIn": true, "email": …}) and
  // exits 1 when signed out — the output is parsed either way.
  claude: ['auth', 'status'],
  // `codex login status` prints "Not logged in" or account info.
  codex: ['login', 'status'],
  opencode: null,
  // No status subcommand; fall back to the ~/.gemini profile shape.
  antigravity: null,
  // No status subcommand; fall back to the gh hosts.yml shape.
  copilot: null,
  // A2 bridges: no verified non-interactive status command — the
  // credential-file shape probe is the sign-in signal (see manifests).
  grok: null,
  kimi: null,
  pi: null,
  hermes: null,
};

const URL_RE = /https?:\/\/[^\s"'<>]+/;
const MAX_STDOUT_BYTES = 64 * 1024;

function defaultHomeDir(): string {
  // Mirrors cli-bridge.ts: on win32 a POSIX-style $HOME (MSYS/git-bash)
  // must not produce a garbage join — fall back to homedir() there.
  const override = process.env.HOME;
  if (override && override.length > 0) {
    if (process.platform !== 'win32') return override;
    if (/^[a-zA-Z]:[\\/]/.test(override) || override.startsWith('\\\\')) return override;
  }
  return homedir();
}

function defaultSpawn(
  command: string,
  args: string[],
  platform: NodeJS.Platform,
  env?: Record<string, string>,
): SpawnHandle {
  // spawnCliProcess applies the Windows batch-shim rule: npm-installed
  // CLIs are .cmd files, which CreateProcess cannot run directly — the
  // spawn goes through the shell with Node's argument escaping. stdin is
  // a pipe so paste-code login flows (Claude Code) can receive the code
  // the user copies from the browser page. A6: a per-account env is
  // merged over the process env (config-dir isolation for the login).
  const child = spawnCliProcess(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    platform,
    ...(env ? { env: { ...process.env, ...env } as Record<string, string> } : {}),
  });
  return { child, stdin: child.stdin, stdout: child.stdout, stderr: child.stderr };
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
  private readonly spawnFn: (command: string, args: string[], opts?: { env?: Record<string, string> }) => SpawnHandle;
  private readonly usingDefaultSpawn: boolean;
  private readonly platform: NodeJS.Platform;
  private readonly resolveCliFn: ((id: CliAuthId) => CliResolution) | undefined;
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
    this.platform = deps.platform ?? process.platform;
    this.usingDefaultSpawn = deps.spawnFn === undefined;
    this.spawnFn =
      deps.spawnFn ?? ((command, args, opts) => defaultSpawn(command, args, this.platform, opts?.env));
    this.resolveCliFn = deps.resolveCli;
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

  /**
   * Resolve a CLI name to a spawnable executable. Bridge CLIs are
   * identity-verified (a same-named impostor resolves to a namesake
   * warning, never to a path); the other CLIs resolve by name on PATH.
   */
  private resolveCli(id: CliAuthId): CliResolution {
    if (this.resolveCliFn) return this.resolveCliFn(id);
    const opts = { homeDir: this.homeDir, pathDirs: this.pathDirs, platform: this.platform };
    if (isBridgeId(id)) {
      const res = resolveVerifiedCliExecutable(toBridgeId(id), opts);
      if (res.path) return { path: res.path };
      // A8: a failed user pin speaks before the generic namesake warning —
      // the user set that path deliberately, so say what is wrong with it.
      if (res.pinned && res.pinned.status !== 'verified') {
        return { namesakeWarning: bridgePinnedMessage(toBridgeId(id), res.pinned) };
      }
      if (res.namesake) return { namesakeWarning: bridgeNamesakeMessage(toBridgeId(id), res.namesake) };
      return {};
    }
    const found = resolveCliExecutable(CLI_COMMANDS[id], opts);
    return found ? { path: found } : {};
  }

  /**
   * The command string handed to spawnFn: the verified absolute path in
   * production (so a real CLI later on PATH wins over a namesake earlier
   * on PATH); the bare name when a caller injected its own spawnFn (test
   * doubles own resolution there).
   */
  private spawnCommand(id: CliAuthId): string {
    if (!this.usingDefaultSpawn) return CLI_COMMANDS[id];
    return this.resolveCli(id).path ?? CLI_COMMANDS[id];
  }

  private credentialsPath(id: CliAuthId, account?: CliAccountContext): string {
    // A6: a non-default bridge account polls ITS OWN credential file.
    if (account?.credentialsPath && isBridgeId(id)) return account.credentialsPath;
    if (id === 'antigravity') return join(this.homeDir, ANTIGRAVITY_CRED_REL);
    // A2: every bridge's credential location comes from its manifest
    // (BRIDGE_PATHS_ALL) — for copilot that is the same ~/.config/gh/
    // hosts.yml this module has always probed (COPILOT_CRED_REL).
    return join(this.homeDir, BRIDGE_PATHS_ALL[toBridgeId(id)].credentialsRel);
  }

  /**
   * Best-effort "usable credential" check. Antigravity keeps OAuth tokens
   * in the OS keyring (unreadable from Node), so file-shape presence of the
   * ACP profile's oauth_creds.json is the signal — documented as heuristic.
   */
  private hasUsableCredential(id: CliAuthId, account?: CliAccountContext): boolean {
    if (account?.credentialsPath && isBridgeId(id)) {
      return bridgeHasUsableTokenAtPath(toBridgeId(id), account.credentialsPath);
    }
    if (id === 'antigravity') return this.fileExists(this.credentialsPath(id));
    if (id === 'copilot') return this.ghHostsHasLogin();
    return bridgeHasUsableToken(toBridgeId(id), this.homeDir);
  }

  /**
   * Copilot/GitHub login shape probe: hosts.yml counts as a usable login
   * when a host entry carries an `oauth_token:` value or a `user:` value.
   * The token value itself is never returned, logged, or stored — this is
   * a boolean shape test over key names only.
   */
  private ghHostsHasLogin(): boolean {
    const text = this.readText(this.credentialsPath('copilot'));
    if (!text) return false;
    return /^\s*(oauth_token|user):\s*\S+/m.test(text);
  }

  /** GitHub username from hosts.yml (`user:` field) — identity only, never a token. */
  private ghAccountHint(): string | undefined {
    const text = this.readText(this.credentialsPath('copilot'));
    if (!text) return undefined;
    const m = /^\s*user:\s*(\S+)\s*$/m.exec(text);
    if (!m) return undefined;
    const hint = redactTokenish(m[1]).slice(0, 120);
    return hint || undefined;
  }

  cliPresent(id: CliAuthId): boolean {
    return this.resolveCli(id).path !== undefined;
  }

  /** Sign-in status. Never returns token bytes. A6: pass a non-default
   *  account's context to probe THAT account (its env + credential file)
   *  independently of the machine default. */
  async getStatus(id: CliAuthId, account?: CliAccountContext): Promise<CliLoginStatus> {
    const resolution = this.resolveCli(id);
    const cliPresent = resolution.path !== undefined;
    const namesakeWarning = resolution.namesakeWarning;
    const credPath = this.credentialsPath(id, account);
    const credentialsPresent = this.fileExists(credPath);

    // Prefer the CLI's own status command when one exists.
    const statusArgs = STATUS_COMMAND[id];
    if (statusArgs && cliPresent) {
      const out = await this.runStatusCommand(id, statusArgs, account);
      if (out !== undefined) {
        if (id === 'claude') {
          const parsed = parseClaudeAuthStatus(out);
          if (parsed) {
            return {
              cliId: id,
              cliPresent,
              credentialsPresent,
              signedIn: parsed.signedIn,
              ...(parsed.accountHint ? { accountHint: parsed.accountHint } : {}),
              ...(namesakeWarning ? { namesakeWarning } : {}),
            };
          }
          // Unparsable output (older CLI?) — fall through to file shape.
        } else {
          const { signedIn, accountHint } = parseCodexLoginStatus(out);
          return { cliId: id, cliPresent, credentialsPresent, signedIn, accountHint, ...(namesakeWarning ? { namesakeWarning } : {}) };
        }
      }
      // Status command failed — fall through to the file-shape probe.
    }

    const signedIn = credentialsPresent && this.hasUsableCredential(id, account);
    let expired: boolean | undefined;
    let accountHint: string | undefined;
    // Antigravity tokens live in the OS keyring — no expiry/hint available.
    // Copilot's hint is the GitHub username from hosts.yml (no expiry data).
    // A6: for a non-default account, no machine-home expiry/hint is read —
    // those describe the machine default's login, not this account's.
    if (signedIn && id === 'copilot') {
      accountHint = this.ghAccountHint();
    } else if (signedIn && isBridgeId(id) && !account?.credentialsPath) {
      const expiry = bridgeTokenExpiry(toBridgeId(id), this.homeDir);
      expired = expiry !== undefined ? expiry <= this.now() : undefined;
      accountHint = bridgeAccountHint(toBridgeId(id), this.homeDir);
    }
    return {
      cliId: id,
      cliPresent,
      credentialsPresent,
      signedIn,
      ...(expired !== undefined ? { expired } : {}),
      ...(accountHint ? { accountHint } : {}),
      ...(namesakeWarning ? { namesakeWarning } : {}),
    };
  }

  private runStatusCommand(id: CliAuthId, args: string[], account?: CliAccountContext): Promise<string | undefined> {
    return new Promise((resolve) => {
      let handle: SpawnHandle;
      try {
        handle = this.spawnFn(this.spawnCommand(id), args, account?.env ? { env: account.env } : undefined);
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
  startLogin(id: CliAuthId, account?: CliAccountContext): ActiveLogin {
    const failedEarly = (reason: string): ActiveLogin => ({
      url: Promise.reject(new Error(reason)),
      done: Promise.resolve({ ok: false, reason }),
      cancel: () => undefined,
    });

    // Preflight resolution. NEVER spawn a namesake: if resolution
    // positively identified the only program carrying this CLI's name as
    // a different tool, say so in plain words instead of running a
    // stranger's binary. (With the default resolution + an injected
    // spawnFn — the unit-test setup — a nonexistent fake PATH yields no
    // candidates and no namesake, so test doubles are unaffected.) A
    // bridge CLI that isn't installed at all also fails fast with the
    // install hint rather than a raw spawn ENOENT (default spawn only:
    // an injected spawnFn owns its own world).
    {
      const resolution = this.resolveCli(id);
      if (resolution.namesakeWarning) return failedEarly(resolution.namesakeWarning);
      if (this.usingDefaultSpawn && !resolution.path && isBridgeId(id)) {
        const meta = CLI_BRIDGE_META[toBridgeId(id)];
        return failedEarly(
          `${meta.label} doesn't seem to be installed on this machine. ` +
            `Install it (${meta.installCommand}), then try signing in again.`,
        );
      }
    }

    const credPath = this.credentialsPath(id, account);
    const beforeMtime = this.fileMtimeMs(credPath);
    const beforeValid = this.hasUsableCredential(id, account);
    const signInHint = isBridgeId(id)
      ? CLI_BRIDGE_META[toBridgeId(id)].signInCommand
      : CLI_COMMANDS[id];

    let handle: SpawnHandle;
    try {
      // A6: the login child runs under the account's config-dir env, so
      // signing into a second account never disturbs the first.
      handle = this.spawnFn(this.spawnCommand(id), LOGIN_ARGS[id], account?.env ? { env: account.env } : undefined);
    } catch (err) {
      const reason = `Could not start the ${CLI_COMMANDS[id]} login: ${err instanceof Error ? err.message : String(err)}`;
      return failedEarly(reason);
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
              `Sign in once in your terminal (\`${signInHint}\`), then retry.`,
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
              `Sign in once in your terminal (\`${signInHint}\`), then retry.`,
          ),
        );
      }
    });

    // Paste-code flow (Claude Code): after the user authorizes in the
    // browser, the page shows a one-time code; the CLI is waiting to read
    // it from stdin. The code is written once, never logged or stored.
    let codeSubmitted = false;
    const submitCode =
      id === 'claude'
        ? (code: string): void => {
            if (codeSubmitted || cancelled) return;
            const trimmed = code.trim();
            if (!trimmed) return;
            codeSubmitted = true;
            try {
              handle.stdin?.write(`${trimmed}\n`);
            } catch {
              // pipe already closed — completion polling will time out honestly
            }
          }
        : undefined;

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
        if (this.hasUsableCredential(id, account) && (beforeMtime === undefined || mtime === undefined || mtime > beforeMtime || !beforeValid)) {
          kill(handle);
          return { ok: true };
        }
      }
      kill(handle);
      if (cancelled) return { ok: false, reason: 'Login cancelled.' };
      // Final check: maybe the user was already signed in and the CLI reused it.
      if (this.hasUsableCredential(id, account)) return { ok: true };
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
      ...(submitCode ? { submitCode } : {}),
    };
  }
}

/**
 * Parse `claude auth status` output: JSON of the shape
 * {"loggedIn": true, "authMethod": "claude.ai", "email": "you@example.com"}.
 * Returns undefined when the output is not that JSON (older CLI builds) so
 * the caller falls back to the credential-file shape probe. The email is
 * surfaced only as a redacted, length-capped account hint.
 */
export function parseClaudeAuthStatus(
  output: string,
): { signedIn: boolean; accountHint?: string } | undefined {
  const text = output.trim();
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.loggedIn !== 'boolean') return undefined;
  if (!obj.loggedIn) return { signedIn: false };
  const rawEmail = typeof obj.email === 'string' ? obj.email : undefined;
  const hint = rawEmail ? redactTokenish(rawEmail).slice(0, 120) : undefined;
  return { signedIn: true, ...(hint ? { accountHint: hint } : {}) };
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
