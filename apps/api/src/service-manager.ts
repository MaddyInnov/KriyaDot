// SPDX-License-Identifier: Apache-2.0
// Service manager (Octop #5/#178): install the KriyaDot API server as an
// OS service — systemd user unit (Linux), launchd agent (macOS), or a
// Windows service via sc.exe.
//
// All file/command effects sit behind injectable fs/runner seams so tests
// are hermetic: on a platform whose service tool is absent (e.g. sc.exe on
// Linux CI), install still GENERATES the command plan and reports it
// instead of executing it. Installing/starting a system service is
// approval/audit territory: the routes require the API's normal auth (the
// parent mounts them behind it) and call the injected audit fn for every
// mutating operation.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SERVICE_NAME = 'kriyadot';
export const SERVICE_LABEL = 'com.kriyadot.api';

export type ServicePlatform = 'linux' | 'darwin' | 'win32';
export type ServiceRunner = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface ServiceFs {
  writeFile(p: string, content: string): void;
  readFile(p: string): string | null;
  remove(p: string): void;
  exists(p: string): boolean;
  mkdirp(p: string): void;
}

export interface ServiceManagerDeps {
  platform?: string;
  homeDir?: string;
  execPath?: string;
  execArgs?: string[];
  workingDir?: string;
  runner?: ServiceRunner;
  fsImpl?: ServiceFs;
  /** Which probe: tests stub tool availability (systemctl/launchctl/sc). */
  hasTool?: (cmd: string) => boolean;
}

export interface ServiceStatus {
  platform: string;
  supported: boolean;
  installed: boolean;
  running: boolean | null;
  unitPath: string | null;
  detail: string;
}

export interface ServiceActionResult {
  ok: boolean;
  action: string;
  /** Commands that were run (or, in plan mode, would be run). */
  commands: Array<{ cmd: string; args: string[] }>;
  planOnly: boolean;
  unitPath?: string;
  unitContent?: string;
  detail?: string;
}

const defaultFs: ServiceFs = {
  writeFile(p, content) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content, { mode: 0o644 }); },
  readFile(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
  remove(p) { try { fs.rmSync(p, { force: true }); } catch { /* ignore */ } },
  exists(p) { return fs.existsSync(p); },
  mkdirp(p) { fs.mkdirSync(p, { recursive: true }); },
};

function defaultRunner(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    import('node:child_process').then(({ execFile }) => {
      execFile(cmd, args, { timeout: 20_000 }, (err, stdout, stderr) => {
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: err ? ((err as { code?: number }).code ?? 1) : 0 });
      });
    }).catch(() => resolve({ stdout: '', stderr: 'spawn failed', code: 1 }));
  });
}

function defaultHasTool(cmd: string): boolean {
  try {
    const { execFileSync } = process.getBuiltinModule('node:child_process') as typeof import('node:child_process');
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Render the service definition file for a platform. Pure. */
export function renderServiceDefinition(input: {
  platform: string; execPath: string; execArgs?: string[]; workingDir?: string;
}): { unitPath: string; content: string } | null {
  const args = input.execArgs ?? [];
  if (input.platform === 'linux') {
    const exec = [input.execPath, ...args].join(' ');
    return {
      unitPath: `~/.config/systemd/user/${SERVICE_NAME}.service`,
      content: [
        '[Unit]', 'Description=KriyaDot API server', 'After=network.target', '',
        '[Service]', `ExecStart=${exec}`,
        ...(input.workingDir ? [`WorkingDirectory=${input.workingDir}`] : []),
        'Restart=on-failure', 'RestartSec=5', '',
        '[Install]', 'WantedBy=default.target', '',
      ].join('\n'),
    };
  }
  if (input.platform === 'darwin') {
    const programArgs = [input.execPath, ...args].map((a) => `    <string>${escapeXml(a)}</string>`).join('\n');
    return {
      unitPath: `~/Library/LaunchAgents/${SERVICE_LABEL}.plist`,
      content: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">', '<dict>',
        '  <key>Label</key>', `  <string>${SERVICE_LABEL}</string>`,
        '  <key>ProgramArguments</key>', '  <array>', programArgs, '  </array>',
        ...(input.workingDir ? ['  <key>WorkingDirectory</key>', `  <string>${escapeXml(input.workingDir)}</string>`] : []),
        '  <key>RunAtLoad</key>', '  <true/>',
        '  <key>KeepAlive</key>', '  <true/>',
        '</dict>', '</plist>', '',
      ].join('\n'),
    };
  }
  return null; // win32 has no definition file; sc.exe creates the service.
}

export class ServiceManager {
  private readonly platform: string;
  private readonly homeDir: string;
  private readonly execPath: string;
  private readonly execArgs: string[];
  private readonly workingDir?: string;
  private readonly runner: ServiceRunner;
  private readonly fsImpl: ServiceFs;
  private readonly hasTool: (cmd: string) => boolean;

  constructor(deps: ServiceManagerDeps = {}) {
    this.platform = deps.platform ?? process.platform;
    this.homeDir = deps.homeDir ?? os.homedir();
    this.execPath = deps.execPath ?? process.execPath;
    this.execArgs = deps.execArgs ?? process.argv.slice(1, 2);
    this.workingDir = deps.workingDir;
    this.runner = deps.runner ?? defaultRunner;
    this.fsImpl = deps.fsImpl ?? defaultFs;
    this.hasTool = deps.hasTool ?? defaultHasTool;
  }

  get supported(): boolean {
    return this.platform === 'linux' || this.platform === 'darwin' || this.platform === 'win32';
  }

  private get tool(): string {
    return this.platform === 'linux' ? 'systemctl' : this.platform === 'darwin' ? 'launchctl' : 'sc.exe';
  }

  unitPath(): string | null {
    if (this.platform === 'linux') return path.join(this.homeDir, '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
    if (this.platform === 'darwin') return path.join(this.homeDir, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
    return null;
  }

  /** The command plan for an action on this platform. Pure. */
  commandsFor(action: 'install' | 'start' | 'stop' | 'uninstall'): Array<{ cmd: string; args: string[] }> {
    const unit = this.unitPath();
    if (this.platform === 'linux') {
      switch (action) {
        case 'install': return [{ cmd: 'systemctl', args: ['--user', 'daemon-reload'] }, { cmd: 'systemctl', args: ['--user', 'enable', SERVICE_NAME] }];
        case 'start': return [{ cmd: 'systemctl', args: ['--user', 'start', SERVICE_NAME] }];
        case 'stop': return [{ cmd: 'systemctl', args: ['--user', 'stop', SERVICE_NAME] }];
        case 'uninstall': return [{ cmd: 'systemctl', args: ['--user', 'disable', '--now', SERVICE_NAME] }, { cmd: 'systemctl', args: ['--user', 'daemon-reload'] }];
      }
    }
    if (this.platform === 'darwin' && unit) {
      switch (action) {
        case 'install': return [{ cmd: 'launchctl', args: ['load', '-w', unit] }];
        case 'start': return [{ cmd: 'launchctl', args: ['start', SERVICE_LABEL] }];
        case 'stop': return [{ cmd: 'launchctl', args: ['stop', SERVICE_LABEL] }];
        case 'uninstall': return [{ cmd: 'launchctl', args: ['unload', '-w', unit] }];
      }
    }
    if (this.platform === 'win32') {
      const binPath = `"${this.execPath}" ${this.execArgs.join(' ')}`.trim();
      switch (action) {
        case 'install': return [{ cmd: 'sc.exe', args: ['create', 'KriyaDot', `binPath= ${binPath}`, 'start= auto'] }];
        case 'start': return [{ cmd: 'sc.exe', args: ['start', 'KriyaDot'] }];
        case 'stop': return [{ cmd: 'sc.exe', args: ['stop', 'KriyaDot'] }];
        case 'uninstall': return [{ cmd: 'sc.exe', args: ['stop', 'KriyaDot'] }, { cmd: 'sc.exe', args: ['delete', 'KriyaDot'] }];
      }
    }
    return [];
  }

  private async runPlan(action: 'install' | 'start' | 'stop' | 'uninstall'): Promise<ServiceActionResult> {
    const commands = this.commandsFor(action);
    const planOnly = !this.hasTool(this.tool);
    if (!planOnly) {
      for (const c of commands) {
        const r = await this.runner(c.cmd, c.args);
        if (r.code !== 0 && action !== 'uninstall') {
          return { ok: false, action, commands, planOnly, detail: `${c.cmd} exited ${r.code}: ${(r.stderr || r.stdout).slice(0, 200)}` };
        }
      }
    }
    return { ok: true, action, commands, planOnly, ...(planOnly ? { detail: `${this.tool} not available on this machine — command plan generated only, nothing was executed` } : {}) };
  }

  async install(): Promise<ServiceActionResult> {
    if (!this.supported) return { ok: false, action: 'install', commands: [], planOnly: true, detail: `unsupported platform "${this.platform}"` };
    const unit = this.unitPath();
    const rendered = renderServiceDefinition({ platform: this.platform, execPath: this.execPath, execArgs: this.execArgs, workingDir: this.workingDir });
    if (unit && rendered) {
      this.fsImpl.mkdirp(path.dirname(unit));
      this.fsImpl.writeFile(unit, rendered.content);
    }
    const result = await this.runPlan('install');
    return { ...result, ...(unit ? { unitPath: unit } : {}), ...(rendered ? { unitContent: rendered.content } : {}) };
  }

  async start(): Promise<ServiceActionResult> { return this.runPlan('start'); }
  async stop(): Promise<ServiceActionResult> { return this.runPlan('stop'); }

  async uninstall(): Promise<ServiceActionResult> {
    const result = await this.runPlan('uninstall');
    const unit = this.unitPath();
    if (unit && this.fsImpl.exists(unit)) this.fsImpl.remove(unit);
    return { ...result, ...(unit ? { unitPath: unit } : {}) };
  }

  async status(): Promise<ServiceStatus> {
    const unit = this.unitPath();
    const installed = this.platform === 'win32' ? false : unit !== null && this.fsImpl.exists(unit);
    if (!this.supported) return { platform: this.platform, supported: false, installed: false, running: null, unitPath: unit, detail: 'unsupported platform' };
    if (!this.hasTool(this.tool)) {
      return { platform: this.platform, supported: true, installed, running: null, unitPath: unit, detail: `${this.tool} not available — cannot probe live state` };
    }
    try {
      if (this.platform === 'linux') {
        const r = await this.runner('systemctl', ['--user', 'is-active', SERVICE_NAME]);
        const active = r.stdout.trim();
        return { platform: this.platform, supported: true, installed: installed || active !== 'inactive', running: active === 'active', unitPath: unit, detail: active || 'unknown' };
      }
      if (this.platform === 'darwin') {
        const r = await this.runner('launchctl', ['list', SERVICE_LABEL]);
        const running = r.code === 0 && /"PID"\s*=/.test(r.stdout);
        return { platform: this.platform, supported: true, installed: installed || r.code === 0, running: r.code === 0 ? running : false, unitPath: unit, detail: r.code === 0 ? 'loaded' : 'not loaded' };
      }
      const r = await this.runner('sc.exe', ['query', 'KriyaDot']);
      const running = /RUNNING/.test(r.stdout);
      return { platform: this.platform, supported: true, installed: r.code === 0, running: r.code === 0 ? running : false, unitPath: unit, detail: (r.stdout.match(/STATE\s*:\s*\d+\s+(\w+)/)?.[1] ?? 'unknown') };
    } catch (err) {
      return { platform: this.platform, supported: true, installed, running: null, unitPath: unit, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ---- Routes -----------------------------------------------------------------

import express, { type Request, type Response, type Router } from 'express';

export interface ServiceManagerRouteDeps {
  manager: ServiceManager;
  audit?: (action: string, fields: { actor?: string; toolName?: string; detail?: unknown }) => void;
  actor?: (req: Request) => string;
}

/**
 * Router factory — parent mounts it behind the API's normal auth, e.g.
 *   app.use('/api/service', createServiceManagerRouter({ manager, audit }))
 * Routes: GET /status; POST /install|start|stop|uninstall (all audited).
 */
export function createServiceManagerRouter(deps: ServiceManagerRouteDeps): Router {
  const router = express.Router();
  const audit = (req: Request, action: string, detail: unknown): void => {
    try { deps.audit?.(`service.${action}`, { actor: deps.actor?.(req) ?? 'user', toolName: 'service-manager', detail }); } catch { /* audit never breaks the route */ }
  };
  router.get('/status', async (_req: Request, res: Response) => {
    res.json({ ok: true, status: await deps.manager.status() });
  });
  for (const action of ['install', 'start', 'stop', 'uninstall'] as const) {
    router.post(`/${action}`, async (req: Request, res: Response) => {
      const result = await deps.manager[action]();
      audit(req, action, { ok: result.ok, planOnly: result.planOnly, unitPath: result.unitPath });
      res.status(result.ok ? 200 : 500).json({ ok: result.ok, result });
    });
  }
  return router;
}
