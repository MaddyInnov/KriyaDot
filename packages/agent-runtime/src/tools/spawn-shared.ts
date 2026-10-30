// SPDX-License-Identifier: Apache-2.0
/**
 * Shared streaming spawn plan for shell commands (Wave 3, CA-13).
 *
 * `run_command` executes through `executeSandboxedCommand` (sandbox.ts),
 * which is a run-to-completion API. Background processes need a live
 * child handle instead, so this module factors the SAME backend
 * selection chain (sandbox.ts `sandboxBackend()`: E2B → Docker →
 * kernel Landlock/Seatbelt → host opt-out/fallback) into a spawn plan:
 * `{ file, args, backend, sandboxed, warning? }` that a caller hands to
 * `child_process.spawn`. The confinement semantics mirror sandbox.ts:
 *
 *   - docker:   `docker run --rm` with the same resource limits and
 *               no-network default as the synchronous Docker path. The
 *               container gets a unique name so kill can reap it.
 *   - landlock: the compiled Landlock helper wraps `sh -c`, workspace
 *               as the writable root (helper policy), /tmp writable.
 *   - seatbelt: `sandbox-exec` with the generated profile for the
 *               workspace (see sandbox-kernel.ts buildSeatbeltProfile).
 *   - host:     plain `sh -c` — ONLY the explicit opt-out or the
 *               documented availability fallback, always carrying the
 *               loud HOST_FALLBACK_WARNING, exactly like sandbox.ts.
 *   - e2b:      a cloud sandbox cannot host a session-long streaming
 *               process through this seam, so the plan THROWS
 *               (fail-closed) instead of silently running unconfined.
 *
 * Governance is unchanged: callers are ordinary ToolDefinitions and
 * flow through the registry's policy evaluation before their handler
 * runs, and the catastrophic-command denylist is checked by the
 * caller (processes.ts) before planning, like run_command does.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HOST_FALLBACK_WARNING, sandboxBackend, type SandboxBackend } from './sandbox.js';
import { buildSeatbeltProfile, landlockHelperPath, landlockHelperReady } from './sandbox-kernel.js';

export type SpawnBackend = SandboxBackend | 'e2b-persistent';

export interface SpawnPlan {
  file: string;
  args: string[];
  /** Backend that will execute the command. */
  backend: SpawnBackend;
  /** False only for unsandboxed host execution. */
  sandboxed: boolean;
  /** Loud warning when execution is NOT confined (host fallback). */
  warning?: string;
  /** Docker container name (docker backend only) for explicit reaping. */
  containerName?: string;
  /** Scratch cleanup callback (seatbelt profile dir). Best-effort. */
  cleanup?: () => void;
}

/** Backends whose execution is fully confined (kernel/Docker/cloud). */
export function isConfinedBackend(backend: string | undefined): boolean {
  return (
    backend === 'docker' ||
    backend === 'landlock' ||
    backend === 'seatbelt' ||
    backend === 'e2b' ||
    backend === 'e2b-persistent'
  );
}

function dockerImage(): string {
  return process.env.SANDBOX_DOCKER_IMAGE?.trim() || 'alpine:latest';
}

/**
 * Build the spawn plan for `command` with `workspaceDir` as cwd /
 * writable root. Synchronous (mirrors sandboxBackend()'s sync probe):
 * when the probe says 'none' because the Landlock helper is not yet
 * compiled, the plan falls back to host WITH the warning — the same
 * availability fallback executeSandboxedCommand documents, surfaced
 * in the plan metadata rather than hidden.
 */
export function planSandboxedSpawn(command: string, workspaceDir: string): SpawnPlan {
  const ws = resolve(workspaceDir);
  const backend = sandboxBackend();
  if (backend === 'e2b') {
    throw new Error(
      'Background processes are not supported on the E2B sandbox backend ' +
        '(a session-long streaming process cannot attach to an ephemeral cloud sandbox). ' +
        'Use run_command for one-shot commands, or select a local backend (Docker/kernel).',
    );
  }
  if (backend === 'docker') {
    const containerName = `kriyadot-bg-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    return {
      file: 'docker',
      args: [
        'run', '--rm', '-i', '--name', containerName,
        '--network', 'none',
        '--memory', '512m', '--memory-swap', '512m',
        '--cpus', '1.0', '--pids-limit', '256',
        '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
        '--workdir', '/tmp',
        dockerImage(), 'sh', '-c', command,
      ],
      backend,
      sandboxed: true,
      containerName,
    };
  }
  if (backend === 'landlock' || (backend === 'none' && landlockHelperReady())) {
    return {
      file: landlockHelperPath(),
      args: [ws, '/bin/sh', '-c', command],
      backend: 'landlock',
      sandboxed: true,
    };
  }
  if (backend === 'seatbelt') {
    const scratch = mkdtempSync(join(tmpdir(), 'kriyadot-bg-seatbelt-'));
    const profilePath = join(scratch, 'profile.sb');
    mkdirSync(ws, { recursive: true });
    writeFileSync(profilePath, buildSeatbeltProfile(ws, { network: false }));
    return {
      file: 'sandbox-exec',
      args: ['-f', profilePath, '/bin/sh', '-c', command],
      backend,
      sandboxed: true,
      cleanup: () => {
        try {
          rmSync(scratch, { recursive: true, force: true });
        } catch { /* best-effort */ }
      },
    };
  }
  // 'host' (explicit opt-out) or 'none' (availability fallback): plain
  // host execution, loudly flagged — never presented as sandboxed.
  return {
    file: 'sh',
    args: ['-c', command],
    backend: 'host',
    sandboxed: false,
    warning: HOST_FALLBACK_WARNING,
  };
}
