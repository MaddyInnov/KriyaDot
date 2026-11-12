// SPDX-License-Identifier: Apache-2.0
// `kriyadot doctor` — one-shot operations health report (A14, Timon
// parity programme).
//
// WHY THIS EXISTS
//   When a self-hosted install misbehaves, the operator's first question
//   is "what is actually wrong on THIS machine?" — is the data dir
//   writable, is that `codex` on PATH the real CLI or a namesake, is the
//   pinned CLI path honoured, is any provider configured, are the PC
//   folder grants sane, does this platform even have a plugin sandbox
//   backend? Before A14 each answer lived in a different subsystem.
//   Doctor runs every one of those checks ONCE, in plain words, one line
//   per check with ok / warn / fail and a fix hint, and exits non-zero
//   when anything FAILS (warnings never fail the run).
//
// DESIGN RULES (deliberate, do not "improve" away)
//   - Doctor REPORTS, it never fixes. No check writes, deletes, repairs,
//     re-probes destructively, or changes a setting. (The one apparent
//     exception — bridge identity probes spawn `--version` — is the
//     existing A8 read-only probe, cached by path+size+mtime.)
//   - Every subsystem check REUSES the machinery that subsystem already
//     ships: the self snapshot is B3's getSelfSnapshot() contract (no
//     re-implemented pressure sampling), bridge lines come from A8's
//     resolveVerifiedCliExecutable + the A2 manifest set (all eight
//     bridges), sign-in state from the A6 file-shape credential probe
//     (no token bytes are read), provider health is CONFIG PRESENCE ONLY
//     from listProviders — doctor makes no provider calls, paid or
//     otherwise. A reachability probe exists only where a subsystem
//     already performs one for free; none was added here.
//   - A check that throws becomes a FAIL line naming the error — doctor
//     itself never crashes halfway through the list.
//   - Thresholds speak the app's one pressure language: disk warn
//     < 1 GB free / fail < 200 MB free, identical to Sentinel and the
//     B3 resource guard.
//
// SURFACES
//   - GET /api/doctor (doctor-routes.ts) returns the report as JSON.
//   - `kriyadot doctor [--json]` (packages/cli) renders the same report
//     and maps fail → exit 1. The report shape below is the contract
//     both consume; the CLI must not re-derive statuses.

import { accessSync, constants, existsSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALL_CLI_BRIDGE_IDS,
  CLI_BRIDGE_META,
  PcAccessStore,
  bridgeHasUsableToken,
  bridgeNamesakeMessage,
  bridgePinnedMessage,
  resolveVerifiedCliExecutable,
  type DetectOptions,
} from '@mvp/agent-runtime';
import { pluginSandboxStatusSync } from '@mvp/plugins';
import { getSelfSnapshot } from './resource-guard-routes.js';
import type { ResourceGuard, SelfSnapshot, SelfSnapshotCounts } from './resource-guard.js';
import { listProviders } from './providers.js';

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  /** One plain-language sentence (or two) describing what was found. */
  detail: string;
  /** What to do about it, when status is warn/fail and a fix exists. */
  fix?: string;
}

export interface DoctorReport {
  at: number;
  overall: DoctorStatus;
  /** Process exit code for the CLI verb: 0 unless any check failed. */
  exitCode: 0 | 1;
  counts: { ok: number; warn: number; fail: number };
  checks: DoctorCheck[];
}

/**
 * Injectable check sections — production defaults are built by
 * defaultDoctorSections(); tests substitute fakes (e.g. a namesake CLI
 * bridge section) without touching the aggregation/exit-code logic.
 */
export interface DoctorSections {
  self: () => DoctorCheck;
  dataDir: () => DoctorCheck;
  bridges: () => DoctorCheck[];
  providers: () => Promise<DoctorCheck[]>;
  pcAccess: () => DoctorCheck;
  sandbox: () => DoctorCheck;
  resourceGuard: () => DoctorCheck;
}

export interface DoctorDeps {
  dataDir: string;
  /** Live host (guard + stores) for the production sections. */
  host?: DoctorHost;
  /** Section overrides — tests substitute fakes per section. */
  sections?: Partial<DoctorSections>;
}

const MB = 1024 * 1024;
const DISK_WARN_FREE = 1024 * MB; // Sentinel/B3 soft floor
const DISK_FAIL_FREE = 200 * MB; // Sentinel/B3 hard floor

function fmtMb(bytes: number): string {
  return bytes >= 1024 * MB ? `${(bytes / (1024 * MB)).toFixed(1)} GB` : `${Math.round(bytes / MB)} MB`;
}

// ---------------------------------------------------------------------------
// Production sections
// ---------------------------------------------------------------------------

function selfCheck(getSnapshot: () => SelfSnapshot): DoctorCheck {
  const snap = getSnapshot();
  const rss = snap.process.rssBytes != null ? fmtMb(snap.process.rssBytes) : 'unknown';
  const counts = snap.counts;
  const parts = [
    `up ${Math.round(snap.uptimeSeconds)}s`,
    `RSS ${rss}`,
    `${counts.activeTurns ?? 0} active turn(s)`,
    `${counts.pendingApprovals ?? 0} pending approval(s)`,
  ];
  if (snap.guard.level === 'hard') {
    return {
      id: 'server-self',
      label: 'Server self',
      status: 'warn',
      detail: `Server is running under hard resource pressure (${parts.join(', ')}).`,
      fix: 'See the resource-guard line below; new optional work is being shed until pressure clears.',
    };
  }
  return { id: 'server-self', label: 'Server self', status: 'ok', detail: `Server process healthy — ${parts.join(', ')}.` };
}

function dataDirCheck(dataDir: string): DoctorCheck {
  const label = 'Data directory';
  if (!existsSync(dataDir)) {
    return {
      id: 'data-dir',
      label,
      status: 'fail',
      detail: `Data directory ${dataDir} does not exist.`,
      fix: 'Start the server once so it can create its data directory, or point DATA_DIR at an existing folder.',
    };
  }
  try {
    accessSync(dataDir, constants.W_OK);
  } catch {
    return {
      id: 'data-dir',
      label,
      status: 'fail',
      detail: `Data directory ${dataDir} is not writable by this process.`,
      fix: 'Fix the folder permissions for the user running KriyaDot, or move DATA_DIR somewhere writable.',
    };
  }
  let free: number | null = null;
  try {
    const st = statfsSync(dataDir);
    free = Number(st.bfree) * Number(st.bsize);
  } catch {
    free = null;
  }
  if (free === null) {
    return { id: 'data-dir', label, status: 'warn', detail: `Data directory ${dataDir} is writable; free disk space could not be measured.` };
  }
  if (free <= DISK_FAIL_FREE) {
    return {
      id: 'data-dir',
      label,
      status: 'fail',
      detail: `Only ${fmtMb(free)} free on the data-dir filesystem — below the ${fmtMb(DISK_FAIL_FREE)} floor.`,
      fix: 'Free disk space now; updates, downloads and the audit database will start failing.',
    };
  }
  if (free <= DISK_WARN_FREE) {
    return {
      id: 'data-dir',
      label,
      status: 'warn',
      detail: `${fmtMb(free)} free on the data-dir filesystem — below the ${fmtMb(DISK_WARN_FREE)} comfort line.`,
      fix: 'Free disk space soon; doctor fails this check under 200 MB free.',
    };
  }
  return { id: 'data-dir', label, status: 'ok', detail: `Writable, ${fmtMb(free)} free on its filesystem.` };
}

/**
 * One line per bridge from the A2 manifest set (all eight). Semantics:
 * a bridge that is simply not installed is OK (bridges are optional);
 * a namesake is a WARN with A8's plain-words refusal; a user PIN that
 * is missing or fails identity is a FAIL (the user configured it
 * explicitly, so silence would hide their mistake); verified-but-not-
 * signed-in is a WARN naming the CLI's own sign-in command.
 */
export function bridgeChecks(detectOpts: DetectOptions = {}): DoctorCheck[] {
  return ALL_CLI_BRIDGE_IDS.map((id) => {
    const meta = CLI_BRIDGE_META[id];
    const label = `Bridge — ${meta.label}`;
    const resolution = resolveVerifiedCliExecutable(id, detectOpts);
    if (resolution.pinned && resolution.pinned.status !== 'verified') {
      return {
        id: `bridge-${id}`,
        label,
        status: 'fail',
        detail: bridgePinnedMessage(id, resolution.pinned),
        fix: 'Fix or clear the pinned CLI path in Settings → Providers.',
      };
    }
    if (resolution.path) {
      const signedIn = bridgeHasUsableToken(id, detectOpts.homeDir);
      const via = resolution.pinned ? ' (via your pinned path)' : '';
      if (signedIn) {
        return {
          id: `bridge-${id}`,
          label,
          status: 'ok',
          detail: `${meta.label} verified at ${resolution.path}${via} and signed in.`,
        };
      }
      return {
        id: `bridge-${id}`,
        label,
        status: 'warn',
        detail: `${meta.label} verified at ${resolution.path}${via}, but no usable sign-in was found for it.`,
        fix: `Sign in with \`${meta.signInCommand}\` in a terminal, then connect the bridge in Settings → Providers.`,
      };
    }
    if (resolution.namesake) {
      return {
        id: `bridge-${id}`,
        label,
        status: 'warn',
        detail: bridgeNamesakeMessage(id, resolution.namesake),
        fix: `Install the real ${meta.label} (${meta.installCommand}), or pin the correct binary in Settings → Providers.`,
      };
    }
    return {
      id: `bridge-${id}`,
      label,
      status: 'ok',
      detail: `${meta.label} is not installed on this machine (optional — only needed if you want this bridge).`,
    };
  });
}

async function providerChecks(dataDir: string): Promise<DoctorCheck[]> {
  const providers = await listProviders(dataDir);
  const configured = providers.filter((p) => p.configured);
  if (configured.length === 0) {
    return [
      {
        id: 'providers',
        label: 'Providers',
        status: 'warn',
        detail: 'No API provider is configured — chat turns have nowhere to go.',
        fix: 'Add a provider API key in Settings → Providers, or connect a CLI bridge above.',
      },
    ];
  }
  const names = configured.map((p) => p.name);
  const shown = names.slice(0, 8).join(', ') + (names.length > 8 ? `, +${names.length - 8} more` : '');
  return [
    {
      id: 'providers',
      label: 'Providers',
      status: 'ok',
      detail: `${configured.length} provider(s) configured: ${shown}. Configuration presence only — doctor made no provider calls.`,
    },
  ];
}

function pcAccessCheck(dataDir: string, store?: PcAccessStore): DoctorCheck {
  const label = 'PC file access grants';
  let grants: Array<{ path: string }> | null = null;
  if (store) {
    grants = store.listGrants();
  } else if (!existsSync(join(dataDir, 'pc-access.db'))) {
    return { id: 'pc-access', label, status: 'ok', detail: 'No folder grants yet — the grant store has not been created, which is normal on a fresh install.' };
  } else {
    // The store file exists, so opening it creates nothing new.
    grants = new PcAccessStore(dataDir).listGrants();
  }
  if (!grants) return { id: 'pc-access', label, status: 'ok', detail: 'Grant store not present.' };
  const missing = grants.filter((g) => !existsSync(g.path));
  if (missing.length > 0) {
    return {
      id: 'pc-access',
      label,
      status: 'warn',
      detail: `${grants.length} folder grant(s) stored; ${missing.length} point at folders that no longer exist (first: ${missing[0]!.path}).`,
      fix: 'Revoke the stale grants in Settings → Permissions → PC file access; they grant nothing while the folder is gone.',
    };
  }
  return { id: 'pc-access', label, status: 'ok', detail: `${grants.length} folder grant(s) stored, all pointing at existing folders.` };
}

function sandboxCheck(): DoctorCheck {
  const label = 'Plugin sandbox';
  const status = pluginSandboxStatusSync();
  if (status.disabledByHost) {
    return {
      id: 'plugin-sandbox',
      label,
      status: 'warn',
      detail: 'The plugin sandbox is disabled by host configuration (KRIYADOT_PLUGIN_SANDBOX=off), so restrictive plugins refuse to run.',
      fix: 'Unset KRIYADOT_PLUGIN_SANDBOX unless you deliberately run without the sandbox; permissive plugins then need KRIYADOT_PLUGIN_ALLOW_UNSANDBOXED=1.',
    };
  }
  if (status.backend === 'landlock') {
    return { id: 'plugin-sandbox', label, status: 'ok', detail: 'Landlock backend available (Linux) — restrictive plugins are kernel-confined to their declared permissions (OPEN-2).' };
  }
  if (status.backend === 'seatbelt') {
    return {
      id: 'plugin-sandbox',
      label,
      status: 'warn',
      detail: 'Seatbelt backend (macOS) — profiles are generated per plugin, but execution is unverified on macOS (OPEN-2 platform caveat).',
    };
  }
  return {
    id: 'plugin-sandbox',
    label,
    status: 'warn',
    detail: `No kernel sandbox backend on ${status.platform} — restrictive plugins refuse to run there rather than running unconfined (OPEN-2 fail-closed caveat).`,
    fix: 'Run executable plugins on Linux (Landlock) for kernel confinement; signature verification still works on every platform.',
  };
}

function resourceGuardCheck(getSnapshot: () => SelfSnapshot): DoctorCheck {
  const label = 'Resource guard';
  const guard = getSnapshot().guard;
  if (!guard.enabled) {
    return {
      id: 'resource-guard',
      label,
      status: 'warn',
      detail: 'The resource guard is disabled — nothing sheds new optional work under memory/lag/disk pressure.',
      fix: 'Re-enable it in Activity → Health, or unset KRIYADOT_RESOURCE_GUARD=0.',
    };
  }
  if (guard.shedding) {
    return {
      id: 'resource-guard',
      label,
      status: 'warn',
      detail: `Currently SHEDDING new optional work (${guard.denialCount} refusal(s) so far)${guard.lastDenial ? `: ${guard.lastDenial.reason}` : ''}.`,
      fix: 'No action needed — shedding clears automatically when pressure drops; in-flight work is never touched.',
    };
  }
  if (guard.level === 'hard' && !guard.shedEnabled) {
    return {
      id: 'resource-guard',
      label,
      status: 'warn',
      detail: 'Hard pressure measured, but shedding is disabled (monitor-only mode), so no work is being refused.',
    };
  }
  return {
    id: 'resource-guard',
    label,
    status: 'ok',
    detail: `Monitoring on, pressure level "${guard.level}"${guard.shedEnabled ? ', shedding armed' : ' (monitor-only)'}.`,
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface DoctorHost {
  dataDir: string;
  guard: ResourceGuard;
  counts?: () => SelfSnapshotCounts;
  pcAccessStore?: PcAccessStore;
  /** Bridge detection overrides (tests: fake PATH/home). */
  detectOpts?: DetectOptions;
}

/** Production sections bound to a live host (guard + stores). */
export function defaultDoctorSections(host: DoctorHost): DoctorSections {
  const getSnapshot = (): SelfSnapshot =>
    getSelfSnapshot({ guard: host.guard, dataDir: host.dataDir, counts: host.counts });
  return {
    self: () => selfCheck(getSnapshot),
    dataDir: () => dataDirCheck(host.dataDir),
    bridges: () => bridgeChecks(host.detectOpts ?? {}),
    providers: () => providerChecks(host.dataDir),
    pcAccess: () => pcAccessCheck(host.dataDir, host.pcAccessStore),
    sandbox: () => sandboxCheck(),
    resourceGuard: () => resourceGuardCheck(getSnapshot),
  };
}

const STATUS_RANK: Record<DoctorStatus, number> = { ok: 0, warn: 1, fail: 2 };

function failedSection(id: string, label: string, err: unknown): DoctorCheck {
  return {
    id,
    label,
    status: 'fail',
    detail: `This check itself failed to run: ${err instanceof Error ? err.message : String(err)}`,
    fix: 'Read the server log for the underlying error, then re-run doctor.',
  };
}

/**
 * Run the full report. Sections run in a fixed, human-sensible order;
 * a throwing section degrades to a FAIL line instead of aborting the
 * report. Exit code is 1 exactly when at least one check failed.
 */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const sections: DoctorSections = {
    ...(deps.host
      ? defaultDoctorSections(deps.host)
      : {
          self: () => {
            throw new Error('no host wired for the self snapshot');
          },
          dataDir: () => dataDirCheck(deps.dataDir),
          bridges: () => bridgeChecks(),
          providers: () => providerChecks(deps.dataDir),
          pcAccess: () => pcAccessCheck(deps.dataDir),
          sandbox: () => sandboxCheck(),
          resourceGuard: () => {
            throw new Error('no host wired for the resource guard');
          },
        }),
    ...(deps.sections ?? {}),
  };
  const checks: DoctorCheck[] = [];
  const push = (id: string, label: string, fn: () => DoctorCheck): void => {
    try {
      checks.push(fn());
    } catch (err) {
      checks.push(failedSection(id, label, err));
    }
  };
  push('server-self', 'Server self', sections.self);
  push('data-dir', 'Data directory', sections.dataDir);
  try {
    checks.push(...sections.bridges());
  } catch (err) {
    checks.push(failedSection('bridges', 'Bridges', err));
  }
  try {
    checks.push(...(await sections.providers()));
  } catch (err) {
    checks.push(failedSection('providers', 'Providers', err));
  }
  push('pc-access', 'PC file access grants', sections.pcAccess);
  push('plugin-sandbox', 'Plugin sandbox', sections.sandbox);
  push('resource-guard', 'Resource guard', sections.resourceGuard);

  const counts = {
    ok: checks.filter((c) => c.status === 'ok').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    fail: checks.filter((c) => c.status === 'fail').length,
  };
  const overall = checks.reduce<DoctorStatus>(
    (worst, c) => (STATUS_RANK[c.status] > STATUS_RANK[worst] ? c.status : worst),
    'ok',
  );
  return { at: Date.now(), overall, exitCode: counts.fail > 0 ? 1 : 0, counts, checks };
}

/** Plain-text rendering (server log / debugging; the CLI renders its own). */
export function formatDoctorReport(report: DoctorReport): string {
  const lines = report.checks.map((c) => {
    const head = `${c.status.toUpperCase().padEnd(4)}  ${c.label} — ${c.detail}`;
    return c.fix && c.status !== 'ok' ? `${head}\n      Fix: ${c.fix}` : head;
  });
  lines.push(
    `Result: ${report.overall.toUpperCase()} — ${report.counts.fail} failing, ${report.counts.warn} warning(s), ${report.counts.ok} ok.`,
  );
  return lines.join('\n');
}
