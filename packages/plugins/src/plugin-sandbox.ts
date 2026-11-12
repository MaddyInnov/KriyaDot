// SPDX-License-Identifier: Apache-2.0
// Kernel sandbox for executable plugin children — closes QA OPEN-2
// ("plugin child processes are not filesystem/network sandboxed").
//
// WHY THIS EXISTS
// Before this module, `permissions.network` / filesystem expectations in
// plugin.json were DECLARATIVE ONLY: rpc.ts spawned the child as the host
// OS user, so a plugin declaring `network:false, env:[]` could still read
// the host's `.api-token` and open sockets (live-confirmed in
// QA-REPORT-2026-10-30 §9, OPEN-2). Environment scrubbing already worked
// (buildPluginEnv); filesystem and network confinement did not exist.
//
// WHAT THIS MODULE DOES
// Every executable plugin invocation is spawned through the OS kernel
// sandbox, configured from the plugin's DECLARED permissions:
//   - Linux: a small Landlock helper (C source embedded below, compiled
//     on demand like agent-runtime's sandbox-kernel helper) restricts
//     the child BEFORE exec: filesystem handled-access is deny-by-default
//     (no rule for `/`), read+execute is granted only on the runtime
//     allowlist (see RUNTIME_READ_ROOTS + the host runtime's install
//     root), full access on the plugin's own directory, read-only on
//     `permissions.fs.read` paths, full access on `permissions.fs.write`
//     paths. Nothing else on disk is readable or writable — including
//     the host's data directory, other plugins' directories, and $HOME.
//   - Network: when the plugin declares `network` != true, the helper
//     additionally (a) moves the child into a fresh network namespace
//     (root: CLONE_NEWNET; unprivileged: CLONE_NEWUSER|CLONE_NEWNET with
//     an identity uid/gid map) so NO IP traffic is possible at all, and
//     (b) on Landlock ABI >= 4 also handles NET_BIND_TCP/NET_CONNECT_TCP
//     with no allow rules, denying TCP even if the namespace could not
//     be created. If neither mechanism is available (namespace creation
//     failed AND ABI < 4) the helper refuses to run the child (exit 86)
//     and the spawn fails closed — see FAIL-CLOSED POLICY.
//   - macOS: Seatbelt via `sandbox-exec` with a generated deny-default
//     profile carrying the same policy (buildPluginSeatbeltProfile).
//     NOTE: Seatbelt EXECUTION is unverifiable on the Linux dev host;
//     the profile generator is unit-tested, execution is darwin-gated.
//
// FAIL-CLOSED POLICY (the one unacceptable outcome is the old one:
// restrictive declarations silently unenforced)
//   - Sandbox backend available → it is ALWAYS used, for every plugin.
//   - Backend unavailable → a RESTRICTIVE plugin (anything other than a
//     plugin declaring network:true AND fs read+write of "/") is REFUSED
//     with PluginSandboxUnavailableError. It never runs unconfined.
//   - A maximally permissive plugin (network:true + fs "/" grants) may
//     run unsandboxed ONLY when the host operator explicitly sets
//     KRIYADOT_PLUGIN_ALLOW_UNSANDBOXED=1; the run carries a loud
//     warning in its sandbox report. Default: refused too.
//   - KRIYADOT_PLUGIN_SANDBOX=off disables the sandbox subsystem at the
//     host operator's request; the fail-closed rules above then apply
//     exactly as for an unavailable backend.
//
// HONEST LIMITS — what this sandbox does NOT protect against
//   - The runtime allowlist (RUNTIME_READ_ROOTS: /usr, /lib, /lib64,
//     /bin, /sbin, /etc, /dev, /proc, /sys, plus the host runtime's
//     install root) stays READABLE so the child runtime (Node/Bun) can
//     start at all. World-readable system files under those trees
//     (including /proc/<pid>/cmdline metadata of same-host processes)
//     are therefore visible to plugins. User data does not live there;
//     the host's data dir, $HOME, and sibling plugin dirs are fenced.
//   - If the network namespace cannot be created on an ABI>=4 kernel,
//     TCP is still denied by Landlock, but non-TCP IP traffic (UDP/ICMP)
//     is not filtered by Landlock — a residual, reported as
//     `netns:false` in the sandbox report. On the reference Linux host
//     (ABI 8, namespace creation permitted) netns succeeds and the
//     residual does not apply.
//   - The child still runs as the host OS user (Landlock/Seatbelt are
//     mandatory-access layers on top of DAC, not a uid change): DAC
//     still applies underneath, resource exhaustion (CPU/memory/disk
//     inside its own directory) is bounded only by the RPC timeout
//     kill, and a kernel sandbox is not a defence against kernel
//     exploits. Plugins remain approval-gated at install for this
//     reason — confinement reduces blast radius, it does not make an
//     arbitrary plugin trustworthy.
//   - Unix-domain sockets bound to filesystem paths inside the plugin
//     directory (or a declared write path) still work — they are
//     filesystem objects under the fence, not network access.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { PluginManifest } from './manifest.js';

// ---------------------------------------------------------------------------
// Reporting + errors
// ---------------------------------------------------------------------------

export interface PluginSandboxReport {
  /** True when the child actually ran under kernel confinement. */
  sandboxed: boolean;
  backend: 'landlock' | 'seatbelt' | 'host';
  /** Landlock ABI version (Linux only). */
  abi?: number;
  /** Whether a private network namespace was created (network-deny runs). */
  netns?: boolean;
  /** True when the child's network access was denied by construction. */
  networkDenied: boolean;
  /** Loud warning, present exactly when execution was NOT confined. */
  warning?: string;
}

export const PLUGIN_UNSANDBOXED_WARNING =
  'WARNING: plugin executed UNSANDBOXED on the host — no kernel sandbox backend was available. ' +
  'This was allowed only because the plugin declares maximally permissive permissions and the host ' +
  'operator set KRIYADOT_PLUGIN_ALLOW_UNSANDBOXED=1.';

export class PluginSandboxUnavailableError extends Error {
  constructor(pluginId: string, detail: string) {
    super(
      `plugin "${pluginId}" was NOT run: its declared permissions are restrictive but no kernel ` +
        `sandbox backend is available on this host to enforce them (${detail}). Refusing to run ` +
        `it unconfined. Install a Landlock-capable Linux kernel (ABI >= 1) or macOS Seatbelt, or ` +
        `— for a plugin declaring network:true and filesystem access to "/" only — set ` +
        `KRIYADOT_PLUGIN_ALLOW_UNSANDBOXED=1 to accept unsandboxed execution explicitly.`,
    );
    this.name = 'PluginSandboxUnavailableError';
  }
}

// ---------------------------------------------------------------------------
// Permission interpretation
// ---------------------------------------------------------------------------

/**
 * A plugin is RESTRICTIVE unless it declares itself maximally permissive:
 * network:true AND filesystem read AND write grants of "/". Anything less
 * must be enforced by the sandbox or not run at all.
 */
export function pluginIsRestrictive(manifest: PluginManifest): boolean {
  if (manifest.permissions?.network !== true) return true;
  const fs = manifest.permissions?.fs;
  const broadRead = (fs?.read ?? []).some((p) => p === '/');
  const broadWrite = (fs?.write ?? []).some((p) => p === '/');
  return !(broadRead && broadWrite);
}

/** Host-operator kill switch for the whole sandbox subsystem. */
export function pluginSandboxDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KRIYADOT_PLUGIN_SANDBOX === 'off';
}

/** Explicit host opt-in to the permissive-unsandboxed fallback. */
export function pluginUnsandboxedOptedIn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KRIYADOT_PLUGIN_ALLOW_UNSANDBOXED === '1';
}

// ---------------------------------------------------------------------------
// Landlock helper (Linux) — C source, compiled on demand
// ---------------------------------------------------------------------------
//
// Protocol:
//   plugin-landlock-exec <plugdir> <netflag:0|1> <runtimeRoot|->
//     <nRead> [readPath...] <nWrite> [writePath...] -- <command...>
// Before exec, the helper writes ONE JSON report line to fd 3 (when open):
//   {"backend":"landlock","abi":N,"netns":bool,"netDenied":bool}
// Exit codes: 85 = Landlock unavailable/ruleset failed (fail closed),
// 86 = network cannot be denied on this host (fail closed),
// 127 = exec failed.

const LANDLOCK_HELPER_C = String.raw`
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
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
#define CREATE_VERSION (1U << 0)
#define RULE_PATH 1
#define A_EXEC (1ULL<<0)
#define A_WRITE (1ULL<<1)
#define A_READ (1ULL<<2)
#define A_READDIR (1ULL<<3)
#define A_RMDIR (1ULL<<4)
#define A_RMFILE (1ULL<<5)
#define A_MKCHAR (1ULL<<6)
#define A_MKDIR (1ULL<<7)
#define A_MKREG (1ULL<<8)
#define A_MKSOCK (1ULL<<9)
#define A_MKFIFO (1ULL<<10)
#define A_MKBLOCK (1ULL<<11)
#define A_MKSYM (1ULL<<12)
#define A_REFER (1ULL<<13)
#define A_TRUNC (1ULL<<14)
#define FS_V1 (A_EXEC|A_WRITE|A_READ|A_READDIR|A_RMDIR|A_RMFILE|A_MKCHAR|A_MKDIR|A_MKREG|A_MKSOCK|A_MKFIFO|A_MKBLOCK|A_MKSYM)
#define NET_BIND (1ULL<<0)
#define NET_CONN (1ULL<<1)
#define READ_EXEC (A_EXEC|A_READ|A_READDIR)

struct rs_attr { __u64 handled_fs; __u64 handled_net; };
struct path_attr { __u64 allowed; __s32 parent_fd; } __attribute__((packed));

static int ll_create(struct rs_attr *a, size_t s, __u32 f){ return (int)syscall(__NR_landlock_create_ruleset,a,s,f); }
static int ll_add(int fd,int t,void *a){ return (int)syscall(__NR_landlock_add_rule,fd,t,a,0); }
static int ll_restrict(int fd){ return (int)syscall(__NR_landlock_restrict_self,fd,0); }

static void allow_path(int rs, const char *path, __u64 acc){
  int fd = open(path, O_PATH|O_CLOEXEC);
  if (fd < 0) return; /* absent on this system: skip */
  struct path_attr at; memset(&at,0,sizeof(at)); at.allowed=acc; at.parent_fd=fd;
  ll_add(rs, RULE_PATH, &at);
  close(fd);
}
static int write_file_str(const char *path, const char *content){
  int fd = open(path, O_WRONLY|O_CLOEXEC);
  if (fd < 0) return -1;
  ssize_t r = write(fd, content, strlen(content)); close(fd); return r<0?-1:0;
}
static long parse_count(const char *s){
  char *end = NULL; long v = strtol(s, &end, 10);
  if (end == s || *end != '\0' || v < 0 || v > 256) return -1;
  return v;
}

int main(int argc, char **argv){
  if (argc >= 2 && strcmp(argv[1], "--probe") == 0){
    int abi = ll_create(NULL, 0, CREATE_VERSION);
    if (abi < 0) return 1;
    printf("%d\n", abi);
    return 0;
  }
  if (argc < 7){
    fprintf(stderr, "usage: plugin-landlock-exec <plugdir> <netflag> <runtimeRoot|-> <nRead> [paths] <nWrite> [paths] -- <cmd...>\n");
    return 2;
  }
  const char *plugdir = argv[1];
  int allow_net = strcmp(argv[2], "1") == 0;
  const char *runtime_root = strcmp(argv[3], "-") == 0 ? NULL : argv[3];
  int idx = 4;
  long n_read = parse_count(argv[idx++]);
  if (n_read < 0 || idx + n_read >= argc){ fprintf(stderr, "bad read-path count\n"); return 2; }
  const char **read_paths = (const char **)&argv[idx]; idx += (int)n_read;
  long n_write = parse_count(argv[idx++]);
  if (n_write < 0 || idx + n_write >= argc){ fprintf(stderr, "bad write-path count\n"); return 2; }
  const char **write_paths = (const char **)&argv[idx]; idx += (int)n_write;
  if (strcmp(argv[idx], "--") != 0 || idx + 1 >= argc){ fprintf(stderr, "missing -- or command\n"); return 2; }
  idx++;

  int abi = ll_create(NULL, 0, CREATE_VERSION);
  if (abi < 1){ fprintf(stderr, "landlock unavailable: %s\n", strerror(errno)); return 85; }

  int netns = 0;
  if (!allow_net){
    if (geteuid() == 0){
      if (unshare(CLONE_NEWNET) == 0) netns = 1;
    } else {
      uid_t uid = getuid(); gid_t gid = getgid();
      if (unshare(CLONE_NEWUSER|CLONE_NEWNET) == 0){
        char buf[64];
        write_file_str("/proc/self/setgroups", "deny");
        snprintf(buf, sizeof(buf), "0 %d 1", uid); write_file_str("/proc/self/uid_map", buf);
        snprintf(buf, sizeof(buf), "0 %d 1", gid); write_file_str("/proc/self/gid_map", buf);
        netns = 1;
      }
    }
    if (!netns && abi < 4){
      fprintf(stderr, "cannot deny network: network namespace creation failed and Landlock ABI %d < 4 has no NET rules\n", abi);
      return 86;
    }
  }

  __u64 fs_all = FS_V1 | (abi >= 2 ? A_REFER : 0) | (abi >= 3 ? A_TRUNC : 0);
  struct rs_attr at; memset(&at, 0, sizeof(at));
  at.handled_fs = fs_all;
  if (!allow_net && abi >= 4) at.handled_net = NET_BIND | NET_CONN;
  int rs = ll_create(&at, sizeof(at), 0);
  if (rs < 0){ fprintf(stderr, "landlock create ruleset failed: %s\n", strerror(errno)); return 85; }
  allow_path(rs, plugdir, fs_all);
  const char *rt[] = {"/usr","/lib","/lib64","/bin","/sbin","/etc","/dev","/proc","/sys", NULL};
  for (int i = 0; rt[i]; i++) allow_path(rs, rt[i], READ_EXEC);
  allow_path(rs, "/dev/null", A_READ|A_WRITE);
  allow_path(rs, "/dev/zero", A_READ);
  allow_path(rs, "/dev/urandom", A_READ);
  if (runtime_root && runtime_root[0]) allow_path(rs, runtime_root, READ_EXEC);
  for (long i = 0; i < n_read; i++) allow_path(rs, read_paths[i], READ_EXEC);
  for (long i = 0; i < n_write; i++) allow_path(rs, write_paths[i], fs_all);
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0){ fprintf(stderr, "prctl NO_NEW_PRIVS failed\n"); return 85; }
  if (ll_restrict(rs) != 0){ fprintf(stderr, "landlock restrict failed: %s\n", strerror(errno)); return 85; }
  close(rs);
  char rep[256];
  snprintf(rep, sizeof(rep), "{\"backend\":\"landlock\",\"abi\":%d,\"netns\":%s,\"netDenied\":%s}\n",
           abi, netns ? "true" : "false", allow_net ? "false" : "true");
  ssize_t wr = write(3, rep, strlen(rep)); (void)wr;
  execvp(argv[idx], &argv[idx]);
  fprintf(stderr, "exec failed: %s\n", strerror(errno));
  return 127;
}
`;

/**
 * System trees that stay readable+executable under the fence so the
 * child runtime can start (documented in HONEST LIMITS above).
 */
export const PLUGIN_RUNTIME_READ_ROOTS: readonly string[] = [
  '/usr',
  '/lib',
  '/lib64',
  '/bin',
  '/sbin',
  '/etc',
  '/dev',
  '/proc',
  '/sys',
];

function helperCacheDir(): string {
  const hash = createHash('sha256').update(LANDLOCK_HELPER_C).digest('hex').slice(0, 12);
  return join(tmpdir(), `kriyadot-plugin-landlock-${hash}`);
}

export function pluginLandlockHelperPath(): string {
  return join(helperCacheDir(), 'plugin-landlock-exec');
}

let helperPromise: Promise<string | null> | null = null;

/** Compile the Landlock helper if needed; resolves null when impossible. */
export function ensurePluginLandlockHelper(): Promise<string | null> {
  if (process.platform !== 'linux') return Promise.resolve(null);
  if (helperPromise) return helperPromise;
  helperPromise = (async () => {
    const dir = helperCacheDir();
    const bin = pluginLandlockHelperPath();
    if (existsSync(bin)) return bin;
    try {
      mkdirSync(dir, { recursive: true });
      const src = join(dir, 'plugin-landlock-exec.c');
      writeFileSync(src, LANDLOCK_HELPER_C);
      // Compile to a per-process temp name, then rename into place:
      // parallel first-use processes (e.g. test workers) must never
      // observe a half-linked binary at the final path.
      const tmpOut = `${bin}.tmp-${process.pid}`;
      const cc = spawnSync('cc', ['-O2', '-Wall', '-o', tmpOut, src], { timeout: 30_000 });
      if (cc.error || cc.status !== 0 || !existsSync(tmpOut)) return null;
      try {
        renameSync(tmpOut, bin);
      } catch {
        // Another process won the rename race; its binary is identical
        // (same source hash), so use the path if it now exists.
        if (!existsSync(bin)) return null;
      }
      return bin;
    } catch {
      return null;
    }
  })();
  return helperPromise;
}

/** Test hook: forget the cached compile attempt. */
export function resetPluginLandlockHelperCache(): void {
  helperPromise = null;
}

/** Landlock ABI version via the helper probe (0 = unavailable). */
export async function pluginLandlockAbi(): Promise<number> {
  const bin = await ensurePluginLandlockHelper();
  if (!bin) return 0;
  const probe = (path: string): number => {
    const res = spawnSync(path, ['--probe'], { timeout: 5_000, encoding: 'utf8' });
    if (res.error || res.status !== 0) return 0;
    const abi = Number(String(res.stdout).trim());
    return Number.isFinite(abi) ? abi : 0;
  };
  const abi = probe(bin);
  if (abi >= 1) return abi;
  // A pre-existing binary that fails the probe may be a truncated
  // artifact of an interrupted first compile: rebuild once, re-probe.
  try {
    rmSync(bin, { force: true });
  } catch {
    // ignore — the re-probe below decides
  }
  resetPluginLandlockHelperCache();
  const rebuilt = await ensurePluginLandlockHelper();
  return rebuilt ? probe(rebuilt) : 0;
}

// ---------------------------------------------------------------------------
// Seatbelt (macOS) — deny-default profile with the same policy
// ---------------------------------------------------------------------------

export function seatbeltAvailable(): boolean {
  if (process.platform !== 'darwin') return false;
  const res = spawnSync('which', ['sandbox-exec'], { stdio: 'ignore' });
  return !res.error && res.status === 0;
}

/**
 * Generate the Seatbelt profile for one plugin invocation. Mirrors the
 * Landlock policy: runtime roots + declared read paths readable, plugin
 * dir + declared write paths writable, network denied unless declared.
 * NOTE: generation is unit-tested on Linux; EXECUTION via sandbox-exec
 * remains macOS-gated and unverifiable on a Linux host.
 */
export function buildPluginSeatbeltProfile(opts: {
  pluginDir: string;
  network: boolean;
  readPaths?: string[];
  writePaths?: string[];
  runtimeRoot?: string;
}): string {
  const esc = (p: string): string => p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const readRoots = [
    ...PLUGIN_RUNTIME_READ_ROOTS,
    ...(opts.runtimeRoot ? [opts.runtimeRoot] : []),
    ...(opts.readPaths ?? []),
  ];
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow signal (target self))',
    '(allow file-read-metadata)',
    `(allow file-read* ${readRoots.map((r) => `(subpath "${esc(r)}")`).join(' ')})`,
    `(allow process-exec* ${readRoots.map((r) => `(subpath "${esc(r)}")`).join(' ')})`,
    `(allow file-read* file-write* (subpath "${esc(opts.pluginDir)}"))`,
  ];
  for (const w of opts.writePaths ?? []) {
    lines.push(`(allow file-read* file-write* (subpath "${esc(w)}"))`);
  }
  lines.push(
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero"))',
    opts.network ? '(allow network*)' : '(deny network*)',
    '',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Backend probe + status
// ---------------------------------------------------------------------------

export interface PluginSandboxProbe {
  backend: 'landlock' | 'seatbelt' | null;
  abi: number;
}

let probePromise: Promise<PluginSandboxProbe> | null = null;

/** Which kernel backend can confine plugin children right now (cached). */
export function probePluginSandbox(env: NodeJS.ProcessEnv = process.env): Promise<PluginSandboxProbe> {
  if (probePromise) return probePromise;
  probePromise = (async () => {
    if (pluginSandboxDisabled(env)) return { backend: null, abi: 0 };
    if (process.platform === 'linux') {
      const abi = await pluginLandlockAbi();
      return abi >= 1 ? { backend: 'landlock' as const, abi } : { backend: null, abi: 0 };
    }
    if (process.platform === 'darwin') {
      return seatbeltAvailable() ? { backend: 'seatbelt' as const, abi: 0 } : { backend: null, abi: 0 };
    }
    return { backend: null, abi: 0 };
  })();
  return probePromise;
}

/** Test hook: forget the cached probe. */
export function resetPluginSandboxProbe(): void {
  probePromise = null;
}

/**
 * Synchronous best-effort status for API/UI copy. `backend` names the
 * platform's kernel backend; actual enforcement is probed again at spawn
 * time and fails closed, so copy built on this must say enforcement is
 * per-invocation (see the wording used by the plugin UI).
 */
export function pluginSandboxStatusSync(): {
  platform: string;
  backend: 'landlock' | 'seatbelt' | 'none';
  disabledByHost: boolean;
} {
  const disabledByHost = pluginSandboxDisabled();
  if (disabledByHost) return { platform: process.platform, backend: 'none', disabledByHost };
  if (process.platform === 'linux') return { platform: process.platform, backend: 'landlock', disabledByHost };
  if (process.platform === 'darwin') return { platform: process.platform, backend: 'seatbelt', disabledByHost };
  return { platform: process.platform, backend: 'none', disabledByHost };
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

export interface SpawnPluginChildOptions {
  /** Absolute plugin directory (child cwd + primary fence). */
  dir: string;
  manifest: PluginManifest;
  /** Scrubbed child environment (see buildPluginEnv in rpc.ts). */
  env: NodeJS.ProcessEnv;
  /** Host environment for policy knobs (defaults to process.env). */
  hostEnv?: NodeJS.ProcessEnv;
}

export interface SpawnedPluginChild {
  child: ChildProcess;
  report: PluginSandboxReport;
}

function runtimeRootFor(command: string): string {
  // For the host-runtime script path (command === process.execPath) the
  // install root is two levels up (bin/<runtime> → root). For direct
  // executables the command already lives inside the plugin dir.
  return dirname(dirname(resolve(command)));
}

async function spawnDirect(
  command: string,
  args: string[],
  opts: SpawnPluginChildOptions,
): Promise<SpawnedPluginChild> {
  const child = spawn(command, args, { cwd: opts.dir, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
  return {
    child,
    report: {
      sandboxed: false,
      backend: 'host',
      networkDenied: false,
      warning: PLUGIN_UNSANDBOXED_WARNING,
    },
  };
}

/**
 * Decide the unsandboxed fallback for a spawn that cannot be confined:
 * allowed ONLY for a maximally permissive plugin AND the host opt-in;
 * everything else throws PluginSandboxUnavailableError (fail closed).
 */
async function spawnUnconfinedOrThrow(
  command: string,
  args: string[],
  opts: SpawnPluginChildOptions,
  detail: string,
): Promise<SpawnedPluginChild> {
  const hostEnv = opts.hostEnv ?? process.env;
  if (!pluginIsRestrictive(opts.manifest) && pluginUnsandboxedOptedIn(hostEnv)) {
    console.warn(`[plugins] ${PLUGIN_UNSANDBOXED_WARNING} (plugin "${opts.manifest.id}")`);
    return spawnDirect(command, args, opts);
  }
  throw new PluginSandboxUnavailableError(opts.manifest.id, detail);
}

/**
 * Spawn a plugin child under the kernel sandbox configured from the
 * plugin's declared permissions. Resolves once confinement is confirmed
 * (Landlock: the helper's fd-3 report, written after restrict_self and
 * before exec) so a refused spawn never runs a line of plugin code.
 */
export async function spawnPluginChild(
  command: string,
  args: string[],
  opts: SpawnPluginChildOptions,
): Promise<SpawnedPluginChild> {
  const hostEnv = opts.hostEnv ?? process.env;
  const probe = await probePluginSandbox(hostEnv);
  const network = opts.manifest.permissions?.network === true;
  const readPaths = (opts.manifest.permissions?.fs?.read ?? []).map((p) => resolve(p));
  const writePaths = (opts.manifest.permissions?.fs?.write ?? []).map((p) => resolve(p));
  const pluginDir = resolve(opts.dir);
  // Inside the fence the system temp dir is NOT writable; point TMPDIR
  // into the plugin's own directory so well-behaved children keep a
  // working temp location without widening the fence.
  const childEnv: NodeJS.ProcessEnv = { ...opts.env, TMPDIR: join(pluginDir, '.tmp') };

  if (probe.backend === 'landlock') {
    const bin = await ensurePluginLandlockHelper();
    if (!bin) {
      return spawnUnconfinedOrThrow(command, args, opts, 'Landlock helper could not be compiled (no C compiler?)');
    }
    const helperArgs = [
      pluginDir,
      network ? '1' : '0',
      runtimeRootFor(command),
      String(readPaths.length),
      ...readPaths,
      String(writePaths.length),
      ...writePaths,
      '--',
      command,
      ...args,
    ];
    const child = spawn(bin, helperArgs, {
      cwd: pluginDir,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    // Await the helper's confinement report (fd 3) or its early exit.
    const reportPromise = new Promise<PluginSandboxReport>((resolveReport, rejectReport) => {
      let buf = '';
      let done = false;
      const fd3 = child.stdio[3];
      const finishOk = (r: PluginSandboxReport) => {
        if (done) return;
        done = true;
        resolveReport(r);
      };
      const finishErr = (code: number | null) => {
        if (done) return;
        done = true;
        rejectReport(
          new PluginSandboxUnavailableError(
            opts.manifest.id,
            code === 86
              ? 'network access cannot be denied on this host (namespace creation failed, Landlock ABI < 4)'
              : `Landlock helper exited (${code ?? 'signal'}) before confinement was established`,
          ),
        );
      };
      fd3?.on('data', (d: Buffer) => {
        buf += d.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        try {
          const parsed = JSON.parse(buf.slice(0, nl)) as { abi?: number; netns?: boolean; netDenied?: boolean };
          finishOk({
            sandboxed: true,
            backend: 'landlock',
            ...(typeof parsed.abi === 'number' ? { abi: parsed.abi } : {}),
            ...(typeof parsed.netns === 'boolean' ? { netns: parsed.netns } : {}),
            networkDenied: parsed.netDenied === true,
          });
        } catch {
          finishErr(null);
        }
      });
      child.on('error', () => finishErr(null));
      child.on('close', (code) => {
        // Report arrives before exec, so a close with no report means
        // the helper refused (85/86) or died — fail closed either way.
        finishErr(code);
      });
    });
    try {
      const report = await reportPromise;
      return { child, report };
    } catch (err) {
      // Helper refused: apply the fail-closed policy. Only the explicit
      // permissive+opt-in combination may continue unsandboxed.
      if (!pluginIsRestrictive(opts.manifest) && pluginUnsandboxedOptedIn(hostEnv)) {
        console.warn(`[plugins] ${PLUGIN_UNSANDBOXED_WARNING} (plugin "${opts.manifest.id}")`);
        return spawnDirect(command, args, opts);
      }
      throw err;
    }
  }

  if (probe.backend === 'seatbelt') {
    const scratch = mkdtempSync(join(tmpdir(), 'kriyadot-plugin-seatbelt-'));
    const profilePath = join(scratch, 'profile.sb');
    writeFileSync(
      profilePath,
      buildPluginSeatbeltProfile({
        pluginDir,
        network,
        readPaths,
        writePaths,
        runtimeRoot: runtimeRootFor(command),
      }),
    );
    const child = spawn('sandbox-exec', ['-f', profilePath, command, ...args], {
      cwd: pluginDir,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.on('close', () => rmSync(scratch, { recursive: true, force: true }));
    return {
      child,
      report: { sandboxed: true, backend: 'seatbelt', networkDenied: !network },
    };
  }

  return spawnUnconfinedOrThrow(
    command,
    args,
    opts,
    pluginSandboxDisabled(hostEnv)
      ? 'plugin sandbox disabled by host configuration (KRIYADOT_PLUGIN_SANDBOX=off)'
      : `no Landlock/Seatbelt backend on platform "${process.platform}"`,
  );
}
