// SPDX-License-Identifier: Apache-2.0

/**
 * Kernel sandbox backends for run_command (Octomind parity): Landlock
 * (Linux) and Seatbelt (macOS), used where the platform allows.
 *
 * Policy (#117 closure — the kernel sandbox is the DEFAULT confinement
 * for local execution when no container backend is configured):
 *   - the whole filesystem is READ + EXECUTE only;
 *   - writes are confined to the bot's workspace directory (threaded
 *     through `SandboxCommandOptions.workspaceDir`; the cwd) and the
 *     system temp dir. With no workspace dir supplied, a fresh per-run
 *     temp directory is the writable root (previous behaviour, kept
 *     for direct/unit callers);
 *   - Landlock (ABI ≤3) cannot filter network syscalls, so network
 *     denial is NOT claimed for Linux; Seatbelt profiles deny network
 *     unless the caller opted in.
 *
 * Landlock needs three syscalls no Node API exposes, so a tiny C
 * helper (source embedded below, original implementation) is compiled
 * on demand with the system C compiler into a cache dir keyed by the
 * source hash, then probed (`--probe` creates a ruleset and reports
 * the ABI). No compiler / no kernel support → the backend reports
 * unavailable and selection falls through. Seatbelt shells out to
 * macOS `sandbox-exec` with a generated profile.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SandboxCommandOptions, SandboxCommandResult } from './sandbox.js';

// ---------------------------------------------------------------------------
// Landlock helper (C, compiled on demand)
// ---------------------------------------------------------------------------

const LANDLOCK_HELPER_C = String.raw`
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>
#include <linux/types.h>

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#endif
#ifndef __NR_landlock_add_rule
#define __NR_landlock_add_rule 445
#endif
#ifndef __NR_landlock_restrict_self
#define __NR_landlock_restrict_self 446
#endif

#define LANDLOCK_CREATE_RULESET_VERSION (1U << 0)
#define LANDLOCK_RULE_PATH_BENEATH 1

/* Access rights (ABI v1 set; stable across ABI versions). */
#define ACC_EXECUTE      (1ULL << 0)
#define ACC_WRITE_FILE   (1ULL << 1)
#define ACC_READ_FILE    (1ULL << 2)
#define ACC_READ_DIR     (1ULL << 3)
#define ACC_REMOVE_DIR   (1ULL << 4)
#define ACC_REMOVE_FILE  (1ULL << 5)
#define ACC_MAKE_CHAR    (1ULL << 6)
#define ACC_MAKE_DIR     (1ULL << 7)
#define ACC_MAKE_REG     (1ULL << 8)
#define ACC_MAKE_SOCK    (1ULL << 9)
#define ACC_MAKE_FIFO    (1ULL << 10)
#define ACC_MAKE_BLOCK   (1ULL << 11)
#define ACC_MAKE_SYM     (1ULL << 12)
#define ACC_REFER        (1ULL << 13)
#define ACC_TRUNCATE     (1ULL << 14)
#define ACC_ALL (ACC_EXECUTE | ACC_WRITE_FILE | ACC_READ_FILE | ACC_READ_DIR | \
                 ACC_REMOVE_DIR | ACC_REMOVE_FILE | ACC_MAKE_CHAR | ACC_MAKE_DIR | \
                 ACC_MAKE_REG | ACC_MAKE_SOCK | ACC_MAKE_FIFO | ACC_MAKE_BLOCK | \
                 ACC_MAKE_SYM | ACC_REFER | ACC_TRUNCATE)
#define ACC_READ_EXEC (ACC_EXECUTE | ACC_READ_FILE | ACC_READ_DIR)

struct landlock_ruleset_attr {
  __u64 handled_access_fs;
};
struct landlock_path_beneath_attr {
  __u64 allowed_access;
  __s32 parent_fd;
} __attribute__((packed));

static int create_ruleset(struct landlock_ruleset_attr *attr, size_t size, __u32 flags) {
  return (int)syscall(__NR_landlock_create_ruleset, attr, size, flags);
}
static int add_rule(int fd, int type, void *attr, __u32 flags) {
  return (int)syscall(__NR_landlock_add_rule, fd, type, attr, flags);
}
static int restrict_self(int fd, __u32 flags) {
  return (int)syscall(__NR_landlock_restrict_self, fd, flags);
}

static void allow_path(int ruleset_fd, const char *path, __u64 access) {
  int dir_fd = open(path, O_PATH | O_CLOEXEC);
  if (dir_fd < 0) return; /* path absent on this system: skip */
  struct landlock_path_beneath_attr attr;
  memset(&attr, 0, sizeof(attr));
  attr.allowed_access = access;
  attr.parent_fd = dir_fd;
  add_rule(ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &attr, 0);
  close(dir_fd);
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "--probe") == 0) {
    int abi = create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < 0) return 1;
    printf("%d\n", abi);
    return 0;
  }
  if (argc < 3) {
    fprintf(stderr, "usage: landlock-exec <workdir> <command...>\n");
    return 2;
  }
  const char *workdir = argv[1];
  struct landlock_ruleset_attr attr;
  memset(&attr, 0, sizeof(attr));
  attr.handled_access_fs = ACC_ALL;
  int abi = create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi >= 2) attr.handled_access_fs |= 0; /* REFER/TRUNCATE already in v1 set above */
  int ruleset_fd = create_ruleset(&attr, sizeof(attr), 0);
  if (ruleset_fd < 0) {
    fprintf(stderr, "landlock unavailable: %s\n", strerror(errno));
    return 1;
  }
  allow_path(ruleset_fd, "/", ACC_READ_EXEC);
  allow_path(ruleset_fd, workdir, ACC_ALL);
  allow_path(ruleset_fd, "/tmp", ACC_ALL);
  allow_path(ruleset_fd, "/dev/null", ACC_READ_FILE | ACC_WRITE_FILE);
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    fprintf(stderr, "prctl NO_NEW_PRIVS failed: %s\n", strerror(errno));
    return 1;
  }
  if (restrict_self(ruleset_fd, 0) != 0) {
    fprintf(stderr, "landlock restrict failed: %s\n", strerror(errno));
    return 1;
  }
  close(ruleset_fd);
  execvp(argv[2], &argv[2]);
  fprintf(stderr, "exec failed: %s\n", strerror(errno));
  return 127;
}
`;

function helperCacheDir(): string {
  const hash = createHash('sha256').update(LANDLOCK_HELPER_C).digest('hex').slice(0, 12);
  return join(tmpdir(), `kriyadot-landlock-${hash}`);
}

export function landlockHelperPath(): string {
  return join(helperCacheDir(), 'landlock-exec');
}

let helperPromise: Promise<string | null> | null = null;

/** Compile the Landlock helper if needed; resolves null when impossible. */
export function ensureLandlockHelper(): Promise<string | null> {
  if (process.platform !== 'linux') return Promise.resolve(null);
  if (helperPromise) return helperPromise;
  helperPromise = (async () => {
    const dir = helperCacheDir();
    const bin = landlockHelperPath();
    if (existsSync(bin)) return bin;
    try {
      mkdirSync(dir, { recursive: true });
      const src = join(dir, 'landlock-exec.c');
      writeFileSync(src, LANDLOCK_HELPER_C);
      const cc = spawnSync('cc', ['-O2', '-Wall', '-o', bin, src], { timeout: 30_000 });
      if (cc.error || cc.status !== 0 || !existsSync(bin)) return null;
      return bin;
    } catch {
      return null;
    }
  })();
  return helperPromise;
}

/** Test hook: forget the cached compile attempt. */
export function resetLandlockHelperCache(): void {
  helperPromise = null;
}

/** Kernel Landlock ABI version (0 = unsupported/unavailable). */
export async function landlockAbiVersion(): Promise<number> {
  const bin = await ensureLandlockHelper();
  if (!bin) return 0;
  const res = spawnSync(bin, ['--probe'], { timeout: 5_000, encoding: 'utf8' });
  if (res.error || res.status !== 0) return 0;
  const abi = Number(String(res.stdout).trim());
  return Number.isFinite(abi) ? abi : 0;
}

/** Sync availability for backend selection: helper already compiled + platform. */
export function landlockHelperReady(): boolean {
  return process.platform === 'linux' && existsSync(landlockHelperPath());
}

// ---------------------------------------------------------------------------
// Seatbelt (macOS)
// ---------------------------------------------------------------------------

export function seatbeltAvailable(): boolean {
  if (process.platform !== 'darwin') return false;
  const res = spawnSync('which', ['sandbox-exec'], { stdio: 'ignore' });
  return !res.error && res.status === 0;
}

/**
 * Filesystem roots readable under Landlock: the helper grants
 * READ+EXECUTE on `/` as a whole, so every root below is readable on
 * Linux. The Seatbelt profile enumerates the same roots explicitly
 * (plus a whole-`/` read rule) so the two backends carry the same
 * read policy — #119 profile parity.
 */
export const KERNEL_READ_ROOTS: readonly string[] = [
  '/usr',
  '/System',
  '/Library',
  '/bin',
  '/sbin',
  '/etc',
  '/private/etc',
  '/dev',
  '/opt',
  '/usr/local',
  '/private',
  '/Users',
  '/Volumes',
];

/**
 * Generate the Seatbelt profile for one run (exported for tests).
 *
 * Parity with the Landlock policy (#119):
 *   - READ: the whole filesystem is readable + executable, mirroring
 *     Landlock's `allow_path("/", READ|EXECUTE)` — expressed both as
 *     the enumerated KERNEL_READ_ROOTS and a whole-`/` read rule, so
 *     no read path Landlock grants is missing on macOS.
 *   - WRITE: confined to the workspace/workdir and the system temp
 *     dirs, plus /dev/null + /dev/zero. Writes under $HOME are
 *     explicitly denied BEFORE the workspace allow rule: Seatbelt
 *     applies the last matching rule, so a workspace inside $HOME
 *     stays writable while the rest of $HOME is write-denied —
 *     exactly Landlock's outcome ($HOME readable, not writable).
 *   - NETWORK: denied unless the caller opted in (Landlock ABI ≤3
 *     cannot filter network; Seatbelt can, and does).
 *
 * NOTE: profile generation is fully tested on Linux; EXECUTION via
 * sandbox-exec remains macOS-gated and unverifiable on a Linux host.
 */
export function buildSeatbeltProfile(
  workdir: string,
  opts: { network?: boolean; homeDir?: string } = {},
): string {
  const esc = (p: string): string => p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const home = opts.homeDir ?? homedir();
  const readRoots = KERNEL_READ_ROOTS.map((r) => `(subpath "${esc(r)}")`).join(' ');
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow signal (target self))',
    '(allow file-read-metadata)',
    // Landlock parity: read + execute across the whole filesystem.
    `(allow file-read* ${readRoots})`,
    '(allow file-read* (subpath "/"))',
    '(allow process-exec* (subpath "/"))',
  ];
  // $HOME write denial comes BEFORE the workspace write allow (last
  // matching rule wins under Seatbelt), so workspaces under $HOME
  // remain writable while the rest of $HOME is write-confined.
  if (home) lines.push(`(deny file-write* (subpath "${esc(home)}"))`);
  lines.push(
    `(allow file-read* file-write* (subpath "${esc(workdir)}") (subpath "/tmp") (subpath "/private/tmp"))`,
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero"))',
    opts.network ? '(allow network*)' : '(deny network*)',
    '',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Shared process runner (timeout + output caps, mirroring the Docker path)
// ---------------------------------------------------------------------------

async function runConfined(
  file: string,
  args: string[],
  cwd: string,
  opts: SandboxCommandOptions & { stdin?: string },
): Promise<SandboxCommandResult> {
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
      ? Math.min(Math.floor(opts.timeoutMs), 3_600_000)
      : 60_000;
  const maxBytes =
    typeof opts.maxOutputBytes === 'number' && opts.maxOutputBytes > 0
      ? Math.floor(opts.maxOutputBytes)
      : 256 * 1024;
  return new Promise<SandboxCommandResult>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (opts.stdin !== undefined) {
      child.stdin?.on('error', () => {});
      child.stdin?.end(opts.stdin);
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      if (outBytes < maxBytes) {
        out.push(d.subarray(0, maxBytes - outBytes));
        outBytes += d.length;
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (errBytes < maxBytes) {
        err.push(d.subarray(0, maxBytes - errBytes));
        errBytes += d.length;
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`sandbox spawn failed: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        exitCode: timedOut ? 124 : (code ?? 1),
        ...(timedOut ? { timedOut: true } : {}),
      });
    });
  });
}

function freshWorkdir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * The kernel backend usable right now, probed asynchronously (the
 * Landlock helper may need compiling on first use). Null when neither
 * Landlock nor Seatbelt can confine a run on this host.
 */
export async function probeKernelBackend(): Promise<'landlock' | 'seatbelt' | null> {
  if (process.platform === 'linux') {
    return (await landlockAbiVersion()) >= 1 ? 'landlock' : null;
  }
  if (process.platform === 'darwin') {
    return seatbeltAvailable() ? 'seatbelt' : null;
  }
  return null;
}

/**
 * Run an argv (no shell) under Landlock: writes confined to
 * `opts.workspaceDir` (the writable root + cwd) when supplied, else a
 * fresh temp cwd; /tmp stays writable either way (helper policy).
 */
export async function runArgvInLandlock(
  argv: string[],
  opts: SandboxCommandOptions & { stdin?: string } = {},
): Promise<SandboxCommandResult> {
  const bin = await ensureLandlockHelper();
  if (!bin) throw new Error('Landlock backend unavailable (no compiler or not Linux)');
  const abi = await landlockAbiVersion();
  if (abi < 1) throw new Error('Landlock is not enabled in this kernel');
  if (argv.length === 0) throw new Error('runArgvInLandlock: empty argv');
  const ownDir = opts.workspaceDir ? null : freshWorkdir('kriyadot-landlock-run-');
  const workdir = opts.workspaceDir ? resolve(opts.workspaceDir) : ownDir!;
  try {
    if (opts.workspaceDir) mkdirSync(workdir, { recursive: true });
    const res = await runConfined(bin, [workdir, ...argv], workdir, opts);
    return { ...res, backend: 'landlock', sandboxed: true };
  } finally {
    if (ownDir) rmSync(ownDir, { recursive: true, force: true });
  }
}

/** Run a shell command under Landlock (workspace-confined per #117). */
export async function runInLandlock(
  cmd: string,
  opts: SandboxCommandOptions = {},
): Promise<SandboxCommandResult> {
  return runArgvInLandlock(['/bin/sh', '-c', cmd], opts);
}

/**
 * Run an argv (no shell) under Seatbelt. The profile is generated for
 * the workspace dir (writable root) but stored in a scratch temp dir
 * so runs never pollute the workspace. macOS-only execution.
 */
export async function runArgvInSeatbelt(
  argv: string[],
  opts: SandboxCommandOptions & { stdin?: string } = {},
): Promise<SandboxCommandResult> {
  if (!seatbeltAvailable()) throw new Error('Seatbelt backend unavailable (needs macOS sandbox-exec)');
  if (argv.length === 0) throw new Error('runArgvInSeatbelt: empty argv');
  const scratch = freshWorkdir('kriyadot-seatbelt-run-');
  const ownWorkdir = opts.workspaceDir ? null : freshWorkdir('kriyadot-seatbelt-ws-');
  const workdir = opts.workspaceDir ? resolve(opts.workspaceDir) : ownWorkdir!;
  const profilePath = join(scratch, 'profile.sb');
  try {
    if (opts.workspaceDir) mkdirSync(workdir, { recursive: true });
    writeFileSync(profilePath, buildSeatbeltProfile(workdir, { network: opts.network === true }));
    const res = await runConfined('sandbox-exec', ['-f', profilePath, ...argv], workdir, opts);
    return { ...res, backend: 'seatbelt', sandboxed: true };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    if (ownWorkdir) rmSync(ownWorkdir, { recursive: true, force: true });
  }
}

/** Run a shell command under Seatbelt (macOS sandbox-exec). */
export async function runInSeatbelt(
  cmd: string,
  opts: SandboxCommandOptions = {},
): Promise<SandboxCommandResult> {
  return runArgvInSeatbelt(['/bin/sh', '-c', cmd], opts);
}

/**
 * Run an argv under whichever kernel backend this host supports
 * (Landlock on Linux, Seatbelt on macOS). Throws when neither is
 * available — callers decide the fallback (host-with-warning or
 * fail-closed in strict mode). Used by local tools (#117c), which are
 * argv executables rather than shell commands.
 */
export async function runArgvConfined(
  argv: string[],
  opts: SandboxCommandOptions & { stdin?: string } = {},
): Promise<SandboxCommandResult & { backend: 'landlock' | 'seatbelt' }> {
  const backend = await probeKernelBackend();
  if (backend === 'landlock') {
    return { ...(await runArgvInLandlock(argv, opts)), backend };
  }
  if (backend === 'seatbelt') {
    return { ...(await runArgvInSeatbelt(argv, opts)), backend };
  }
  throw new Error('No kernel sandbox backend available on this host (Landlock/Seatbelt unavailable)');
}
