// SPDX-License-Identifier: Apache-2.0
// OS service install for the standalone KriyaDot server (A14, Timon
// parity programme): generators for a systemd USER unit (Linux), a
// launchd plist (macOS), and a Windows scheduled-task definition, plus
// a small manager that writes/removes exactly those artefacts.
//
// WHY A SEPARATE MODULE FROM autostart.ts (apps/api)
//   Open-at-login (W12d) starts the DESKTOP app when the user logs in.
//   This is the headless counterpart: run the standalone SERVER as an
//   OS service on the user's own machine/VPS (hosting is parked and
//   local-first — there is no KriyaDot-operated fleet to enrol). The
//   generators are pure functions so their output is asserted byte-for-
//   byte in tests; the manager is the only part that touches the disk.
//
// SAFETY POSTURE
//   - The CLI command defaults to --dry-run: it prints the exact file
//     (path + contents) and the exact registration commands, and
//     changes nothing. A real install needs the explicit --apply flag.
//   - Install writes ONLY this service's unit/plist/task file;
//     uninstall removes exactly that file (plus the OS deregistration
//     command). Nothing else on the machine is touched.
//   - Registration commands (systemctl/launchctl/schtasks) are
//     best-effort: their results are reported per command, and a host
//     that cannot run them (e.g. a container with no user bus) still
//     gets the file written, with the manual command printed — the
//     manager never pretends a registration happened when it did not.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const SERVICE_UNIT_NAME = 'kriyadot.service';
export const SERVICE_LAUNCHD_LABEL = 'com.kriyadot.server';
export const SERVICE_TASK_NAME = 'KriyaDot Server';
export const SERVICE_DESCRIPTION = 'KriyaDot server (managed by `kriyadot service install`)';

export interface ServiceSpec {
  /** Executable the service runs (the standalone server binary, or the kriyadot CLI). */
  execPath: string;
  /** Arguments for the executable (e.g. ['serve', '--port', '4000']). */
  execArgs: string[];
  /** Optional DATA_DIR the service should use (rendered as an env entry). */
  dataDir?: string;
}

export interface ServicePlan {
  platform: string;
  /** Absolute path of the unit/plist/task file. */
  filePath: string;
  /** Exact file contents that install would write. */
  contents: string;
  /** Registration commands install would run after writing the file. */
  commands: string[][];
  /** Deregistration commands uninstall runs before removing the file. */
  removeCommands: string[][];
}

export interface CommandResult {
  argv: string[];
  ok: boolean;
  detail: string;
}

export interface ServiceManagerDeps {
  platform?: string;
  homeDir?: string;
  /** Linux: $XDG_CONFIG_HOME (systemd user units live under it). */
  xdgConfigHome?: string;
  /** Directory holding the Windows task XML (the CLI config dir). */
  configDir?: string;
  /** Injectable command runner (tests fake systemctl/launchctl/schtasks). */
  runCommand?: (argv: string[]) => CommandResult;
  /** macOS uid for launchctl gui/<uid> (defaults to process.getuid). */
  uid?: number;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Quote one token for a systemd Exec= line / Environment= entry. */
function systemdQuote(s: string): string {
  if (!/[\s"\\]/.test(s)) return s;
  return `"${s.replace(/(["\\])/g, '\\$1')}"`;
}

// ---------------------------------------------------------------------------
// Generators (pure — asserted byte-for-byte in tests)
// ---------------------------------------------------------------------------

export function renderSystemdUserUnit(spec: ServiceSpec): string {
  const exec = [spec.execPath, ...spec.execArgs].map(systemdQuote).join(' ');
  const lines = [
    '# KriyaDot server — managed by `kriyadot service install`.',
    '# Re-run that command to change this unit; `kriyadot service uninstall` removes it.',
    '[Unit]',
    'Description=KriyaDot server',
    'After=network.target',
    'Wants=network.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${exec}`,
    'Restart=on-failure',
    'RestartSec=5',
  ];
  if (spec.dataDir) lines.push(`Environment=DATA_DIR=${systemdQuote(spec.dataDir)}`);
  lines.push('', '[Install]', 'WantedBy=default.target', '');
  return lines.join('\n');
}

export function renderLaunchdPlist(spec: ServiceSpec): string {
  const programArgs = [spec.execPath, ...spec.execArgs]
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join('\n');
  const env = spec.dataDir
    ? [
        '  <key>EnvironmentVariables</key>',
        '  <dict>',
        '    <key>DATA_DIR</key>',
        `    <string>${escapeXml(spec.dataDir)}</string>`,
        '  </dict>',
      ]
    : [];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${SERVICE_LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    programArgs,
    '  </array>',
    ...env,
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function renderWindowsTaskXml(spec: ServiceSpec): string {
  // NOTE: a scheduled task has no per-task env block in this XML shape;
  // a dataDir override on Windows is passed via --args instead (the
  // server's DATA_DIR env is a deployment-level setting there).
  const args = spec.execArgs.map((a) => (/\s/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(' ');
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>${escapeXml(SERVICE_DESCRIPTION)}</Description>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Settings>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <RestartOnFailure>',
    '      <Interval>PT1M</Interval>',
    '      <Count>3</Count>',
    '    </RestartOnFailure>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${escapeXml(spec.execPath)}</Command>`,
    ...(args ? [`      <Arguments>${escapeXml(args)}</Arguments>`] : []),
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

/** Render the service definition for a platform ('linux'|'darwin'|'win32'). */
export function renderServiceDefinition(platform: string, spec: ServiceSpec): string {
  if (platform === 'darwin') return renderLaunchdPlist(spec);
  if (platform === 'win32') return renderWindowsTaskXml(spec);
  return renderSystemdUserUnit(spec);
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

function defaultRunCommand(argv: string[]): CommandResult {
  try {
    const res = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8', timeout: 15_000 });
    if (res.error) return { argv, ok: false, detail: res.error.message };
    const tail = `${res.stderr ?? ''}`.trim().split('\n').pop() ?? '';
    return {
      argv,
      ok: res.status === 0,
      detail: res.status === 0 ? 'ok' : `exit ${res.status}${tail ? `: ${tail}` : ''}`,
    };
  } catch (err) {
    return { argv, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export class ServiceInstallManager {
  private readonly platform: string;
  private readonly homeDir: string;
  private readonly xdgConfigHome?: string;
  private readonly configDir: string;
  private readonly runCommand: (argv: string[]) => CommandResult;
  private readonly uid: number;

  constructor(deps: ServiceManagerDeps = {}) {
    this.platform = deps.platform ?? process.platform;
    this.homeDir = deps.homeDir ?? homedir();
    this.xdgConfigHome = deps.xdgConfigHome;
    this.configDir = deps.configDir ?? join(this.homeDir, '.kriyadot');
    this.runCommand = deps.runCommand ?? defaultRunCommand;
    this.uid = deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 501);
  }

  /** Absolute path of this service's definition file on this platform. */
  filePath(): string {
    if (this.platform === 'darwin') {
      return join(this.homeDir, 'Library', 'LaunchAgents', `${SERVICE_LAUNCHD_LABEL}.plist`);
    }
    if (this.platform === 'win32') {
      return join(this.configDir, 'service', 'kriyadot-task.xml');
    }
    const xdg = this.xdgConfigHome && this.xdgConfigHome.startsWith('/')
      ? this.xdgConfigHome
      : join(this.homeDir, '.config');
    return join(xdg, 'systemd', 'user', SERVICE_UNIT_NAME);
  }

  /** What install WOULD do — pure; the dry-run output is built from this. */
  plan(spec: ServiceSpec): ServicePlan {
    const filePath = this.filePath();
    const contents = renderServiceDefinition(this.platform, spec);
    let commands: string[][] = [];
    let removeCommands: string[][] = [];
    if (this.platform === 'darwin') {
      commands = [['launchctl', 'bootstrap', `gui/${this.uid}`, filePath]];
      removeCommands = [['launchctl', 'bootout', `gui/${this.uid}/${SERVICE_LAUNCHD_LABEL}`]];
    } else if (this.platform === 'win32') {
      commands = [['schtasks', '/Create', '/TN', SERVICE_TASK_NAME, '/XML', filePath, '/F']];
      removeCommands = [['schtasks', '/Delete', '/TN', SERVICE_TASK_NAME, '/F']];
    } else {
      commands = [
        ['systemctl', '--user', 'daemon-reload'],
        ['systemctl', '--user', 'enable', '--now', SERVICE_UNIT_NAME],
      ];
      removeCommands = [
        ['systemctl', '--user', 'disable', '--now', SERVICE_UNIT_NAME],
        ['systemctl', '--user', 'daemon-reload'],
      ];
    }
    return { platform: this.platform, filePath, contents, commands, removeCommands };
  }

  status(spec: ServiceSpec): { installed: boolean; current: boolean; filePath: string } {
    const filePath = this.filePath();
    if (!existsSync(filePath)) return { installed: false, current: false, filePath };
    let current = false;
    try {
      current = readFileSync(filePath, 'utf8') === renderServiceDefinition(this.platform, spec);
    } catch {
      current = false;
    }
    return { installed: true, current, filePath };
  }

  /** Write the definition file (atomically) and run registration commands best-effort. */
  install(spec: ServiceSpec): { plan: ServicePlan; commandResults: CommandResult[] } {
    const plan = this.plan(spec);
    mkdirSync(dirname(plan.filePath), { recursive: true });
    const tmp = `${plan.filePath}.tmp-${process.pid}`;
    writeFileSync(tmp, plan.contents, 'utf8');
    renameSync(tmp, plan.filePath);
    const commandResults = plan.commands.map((argv) => this.runCommand(argv));
    return { plan, commandResults };
  }

  /** Deregister (best-effort) and remove exactly this service's file. */
  uninstall(spec: ServiceSpec): { plan: ServicePlan; removed: boolean; commandResults: CommandResult[] } {
    const plan = this.plan(spec);
    const commandResults = plan.removeCommands.map((argv) => this.runCommand(argv));
    let removed = false;
    try {
      unlinkSync(plan.filePath);
      removed = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return { plan, removed, commandResults };
  }
}
