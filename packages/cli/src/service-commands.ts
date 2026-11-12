// SPDX-License-Identifier: Apache-2.0
// `kriyadot doctor` and `kriyadot service …` command implementations
// (A14). Split from commands.ts like bridge-commands.ts / tap-commands.ts
// so the operations surface stays unit-testable with the fake API.
import { flagBool, flagString } from './args.js';
import type { ParsedArgs } from './args.js';
import type { CommandDeps } from './commands.js';
import { configDir } from './config.js';
import { EXIT_ERROR } from './exits.js';
import { ServiceInstallManager, type ServiceSpec } from './service.js';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

/** Mirror of apps/api doctor.ts DoctorReport (the wire contract). */
export interface DoctorReportShape {
  at: number;
  overall: 'ok' | 'warn' | 'fail';
  exitCode: 0 | 1;
  counts: { ok: number; warn: number; fail: number };
  checks: Array<{
    id: string;
    label: string;
    status: 'ok' | 'warn' | 'fail';
    detail: string;
    fix?: string;
  }>;
}

function out(deps: CommandDeps, s: string): void {
  deps.stdout.write(s);
}

function printJson(deps: CommandDeps, value: unknown): void {
  out(deps, `${JSON.stringify(value, null, 2)}\n`);
}

/** Render a doctor report in plain words, one line per check. */
export function renderDoctorReport(report: DoctorReportShape): string {
  const lines = report.checks.map((c) => {
    const head = `${c.status.toUpperCase().padEnd(4)}  ${c.label} — ${c.detail}`;
    return c.fix && c.status !== 'ok' ? `${head}\n      Fix: ${c.fix}` : head;
  });
  lines.push(
    `Result: ${report.overall.toUpperCase()} — ${report.counts.fail} failing, ${report.counts.warn} warning(s), ${report.counts.ok} ok.`,
  );
  return lines.join('\n');
}

/**
 * `kriyadot doctor [--json]` — fetch the server's doctor report and
 * render it. Exit 1 exactly when the report contains a FAIL (warnings
 * never fail). When the server is unreachable, doctor still answers:
 * one FAIL line for reachability itself, exit 1.
 */
export async function runDoctorCommand(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  const json = p.global.format === 'json' || flagBool(p.flags, 'json');
  let report: DoctorReportShape;
  try {
    const res = await deps.api.request<{ ok: boolean; report: DoctorReportShape }>('/doctor');
    report = res.report;
  } catch (err) {
    report = {
      at: Date.now(),
      overall: 'fail',
      exitCode: 1,
      counts: { ok: 0, warn: 0, fail: 1 },
      checks: [
        {
          id: 'server-reachable',
          label: 'Server reachable',
          status: 'fail',
          detail: `Cannot reach the KriyaDot server at ${deps.cfg.apiUrl}: ${err instanceof Error ? err.message : String(err)}`,
          fix: 'Start the server (kriyadot serve, the desktop app, or your OS service), then run doctor again — the remaining checks run inside the server.',
        },
      ],
    };
  }
  if (json) {
    printJson(deps, report);
  } else {
    out(deps, `KriyaDot doctor — ${new Date(report.at).toISOString()}\n`);
    out(deps, `${renderDoctorReport(report)}\n`);
  }
  return report.exitCode === 1 ? EXIT_ERROR : 0;
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

/**
 * Build the service spec from flags. Default: the unit runs this CLI's
 * own `serve` verb via the `kriyadot` executable name. --exec points at
 * a standalone server binary instead (then only --port is appended,
 * plus any explicit --args).
 */
export function serviceSpecFromFlags(p: ParsedArgs): ServiceSpec {
  const exec = flagString(p.flags, 'exec') ?? process.env.KRIYADOT_EXEC_PATH;
  const port = flagString(p.flags, 'port');
  const extra = flagString(p.flags, 'args');
  const execArgs: string[] = [];
  if (!exec) execArgs.push('serve');
  if (port) execArgs.push('--port', port);
  if (extra) execArgs.push(...extra.split(/\s+/).filter(Boolean));
  const dataDir = flagString(p.flags, 'data-dir') ?? process.env.DATA_DIR;
  return {
    execPath: exec ?? 'kriyadot',
    execArgs,
    ...(dataDir ? { dataDir } : {}),
  };
}

function makeManager(): ServiceInstallManager {
  return new ServiceInstallManager({
    homeDir: homedir(),
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    configDir: configDir(),
  });
}

function printPlan(deps: CommandDeps, plan: ReturnType<ServiceInstallManager['plan']>, verb: string): void {
  out(deps, `Would ${verb} this service definition file:\n  ${plan.filePath}\n\n${plan.contents}\n`);
}

function printCommandResults(deps: CommandDeps, results: Array<{ argv: string[]; ok: boolean; detail: string }>): void {
  for (const r of results) {
    out(deps, `  ${r.ok ? 'ran' : 'FAILED'}: ${r.argv.join(' ')} — ${r.detail}\n`);
    if (!r.ok) {
      out(deps, '    (the definition file state above is still accurate; run the command manually on the target machine if this host cannot)\n');
    }
  }
}

/**
 * `kriyadot service install|uninstall|status` — DEFAULT IS DRY-RUN for
 * install/uninstall: print exactly what would be written/registered
 * and change nothing. A real change requires --apply.
 */
export async function runServiceCommand(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  const manager = makeManager();
  const spec = serviceSpecFromFlags(p);
  const json = p.global.format === 'json';
  const dryRun = !flagBool(p.flags, 'apply');

  if (p.subcommand === 'status') {
    const status = manager.status(spec);
    if (json) {
      printJson(deps, { ok: true, ...status, platform: process.platform });
      return 0;
    }
    out(
      deps,
      status.installed
        ? `Service definition present at ${status.filePath}${status.current ? ' (matches the current spec)' : ' (STALE — contents differ from the current spec; re-run install to refresh)'}.\n`
        : `No service definition at ${status.filePath} — not installed. Install with: kriyadot service install (dry-run) then --apply.\n`,
    );
    return 0;
  }

  if (p.subcommand === 'install') {
    const plan = manager.plan(spec);
    if (dryRun) {
      if (json) {
        printJson(deps, { ok: true, dryRun: true, plan });
        return 0;
      }
      printPlan(deps, plan, 'write');
      out(deps, 'Would then run:\n');
      for (const argv of plan.commands) out(deps, `  ${argv.join(' ')}\n`);
      out(deps, '\nDry run — nothing was written or registered. Re-run with --apply to install.\n');
      return 0;
    }
    const result = manager.install(spec);
    if (json) {
      printJson(deps, { ok: true, dryRun: false, filePath: plan.filePath, commandResults: result.commandResults });
      return 0;
    }
    out(deps, `Wrote ${plan.filePath}.\nRegistration commands:\n`);
    printCommandResults(deps, result.commandResults);
    return 0;
  }

  if (p.subcommand === 'uninstall') {
    const plan = manager.plan(spec);
    if (dryRun) {
      if (json) {
        printJson(deps, { ok: true, dryRun: true, plan });
        return 0;
      }
      out(deps, 'Would first run:\n');
      for (const argv of plan.removeCommands) out(deps, `  ${argv.join(' ')}\n`);
      out(deps, `Would then remove exactly this file:\n  ${plan.filePath}\n`);
      out(deps, '\nDry run — nothing was removed or deregistered. Re-run with --apply to uninstall.\n');
      return 0;
    }
    const result = manager.uninstall(spec);
    if (json) {
      printJson(deps, { ok: true, dryRun: false, removed: result.removed, commandResults: result.commandResults });
      return 0;
    }
    out(deps, `Deregistration commands:\n`);
    printCommandResults(deps, result.commandResults);
    out(deps, result.removed ? `Removed ${plan.filePath}.\n` : `No file at ${plan.filePath} — nothing to remove.\n`);
    return 0;
  }

  deps.stderr.write('Usage: kriyadot service <install|uninstall|status> [--apply] [--exec <path>] [--port <n>]\n');
  return EXIT_ERROR;
}
