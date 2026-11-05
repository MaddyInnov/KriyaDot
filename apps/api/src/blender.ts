// SPDX-License-Identifier: Apache-2.0
// Blender bridge + local desktop apps (KriyaDot W2).
//
// Agent tools, registered into the shared tool registry by the host:
//
//   blender_status     — read-only detection (installed? path, version,
//                        running?) — auto-allowed.
//   blender_open_file  — open a .blend file in the Blender GUI.
//                        MUTATING → require-approval.
//   blender_run_script — run a Python script in headless Blender
//                        (--background --python … --python-exit-code 1).
//                        MUTATING → require-approval.
//   blender_render     — headless still/animation render.
//                        MUTATING → require-approval.
//
// Plus a read model for the desktop's local apps:
//
//   listLocalApps(probe)            — Blender (full detection) + WhatsApp,
//                                     VS Code, Spotify, Slack, Discord,
//                                     Word, Excel, PowerPoint.
//   registerLocalAppRoutes(router, deps)
//                                   — GET /local-apps → { apps }
//
// Trust model (never weakened):
//   - Every process invocation is an argv array through execFile/spawn —
//     no shell anywhere, so a hostile path or script name cannot inject
//     commands. Production execution goes through BlenderProcessRunner;
//     tests inject fakes, so tests never launch a real Blender.
//   - Files the tools touch (.blend / .py / render output) must resolve
//     inside one of the host-configured workspace roots
//     (assertWorkspacePath) — the bridge cannot be used to open or execute
//     arbitrary files elsewhere on the machine.
//   - The mutating tools are approval-gated via blenderToolPolicies(),
//     mirroring composioToolPolicies(); blender_status is read-only.
//   - Detection never throws: a missing/undetectable Blender reports
//     installed:false, and the mutating tools fail with the clear error
//     "Blender is not installed on this computer".

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import express from 'express';
import type { BotPolicyRule, ToolContext, ToolDefinition } from '@mvp/agent-runtime';
import { APP_ALIASES } from '@mvp/agent-runtime/dist/tools/computer-apps.js';
import type { AppConfig } from './config.js';
import { principalMiddleware, type PrincipalContext } from './principal.js';

// ---------------------------------------------------------------------------
// Process + filesystem probes (injectable; tests never spawn real processes)
// ---------------------------------------------------------------------------

export type BlenderPlatform = 'win32' | 'darwin' | 'linux';

export function currentBlenderPlatform(): BlenderPlatform {
  const p = process.platform;
  return p === 'win32' || p === 'darwin' ? p : 'linux';
}

/** One process execution result. Non-zero exits resolve; they do not throw. */
export interface BlenderProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Process abstraction for everything Blender-related. Implementations must
 * execute an argv array directly (no shell). `which` is optional: when a
 * runner cannot provide it, detection falls back to scanning PATH dirs
 * through BlenderProbeFs.
 */
export interface BlenderProcessRunner {
  run(argv: string[], opts: { timeoutMs: number; cwd?: string }): Promise<BlenderProcessResult>;
  which?(name: string): Promise<string | undefined>;
}

/** Hard cap on captured child output (bytes) in the production runner. */
const MAX_CAPTURE_BYTES = 1024 * 1024;

/**
 * Production runner: node:child_process execFile with an argv array ONLY
 * (no shell), a timeout (execFile kills the child on timeout), and an
 * output byte cap (maxBuffer). Non-zero exits resolve with their code so
 * callers can report them; only spawn-level failures collapse to code 1
 * with the reason appended to stderr.
 */
export class ExecFileBlenderRunner implements BlenderProcessRunner {
  async run(argv: string[], opts: { timeoutMs: number; cwd?: string }): Promise<BlenderProcessResult> {
    const program = argv[0];
    if (typeof program !== 'string' || program.length === 0) {
      throw new Error('BlenderProcessRunner.run: argv[0] (program) is required');
    }
    const args = argv.slice(1);
    return new Promise<BlenderProcessResult>((resolvePromise) => {
      execFile(
        program,
        args,
        {
          timeout: opts.timeoutMs,
          cwd: opts.cwd,
          maxBuffer: MAX_CAPTURE_BYTES,
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          const out = typeof stdout === 'string' ? stdout : String(stdout ?? '');
          const errText = typeof stderr === 'string' ? stderr : String(stderr ?? '');
          if (!err) {
            resolvePromise({ code: 0, stdout: out, stderr: errText });
            return;
          }
          const code = typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1;
          const killed = (err as { killed?: boolean }).killed === true;
          const note = killed
            ? `\n[blender] process killed (timeout after ${opts.timeoutMs}ms or output cap reached)`
            : '';
          resolvePromise({ code, stdout: out, stderr: errText + note });
        },
      );
    });
  }

  async which(name: string): Promise<string | undefined> {
    const dirs = (process.env.PATH ?? '').split(delimiter).filter((d) => d.length > 0);
    const candidates = process.platform === 'win32' ? [name, `${name}.exe`] : [name];
    for (const dir of dirs) {
      for (const candidate of candidates) {
        const full = join(dir, candidate);
        try {
          if (existsSync(full)) return full;
        } catch {
          // Unreadable PATH entry — keep scanning.
        }
      }
    }
    return undefined;
  }
}

/**
 * Filesystem probe used by detection. Injected in tests so detection can
 * be exercised against a fictional machine without touching the real disk.
 */
export interface BlenderProbeFs {
  exists(path: string): boolean;
  /** Directories on the PATH, in order. */
  pathDirs(): string[];
  homeDir(): string;
}

/** Production probe: the real filesystem / environment. */
export class NodeBlenderProbeFs implements BlenderProbeFs {
  exists(path: string): boolean {
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  }

  pathDirs(): string[] {
    return (process.env.PATH ?? '').split(delimiter).filter((d) => d.length > 0);
  }

  homeDir(): string {
    return homedir();
  }
}

export function createNodeBlenderProbeFs(): BlenderProbeFs {
  return new NodeBlenderProbeFs();
}

/** Detached GUI launcher for blender_open_file (injectable; tests record calls). */
export type BlenderDetachedLauncher = (argv: string[]) => Promise<void>;

/**
 * Default detached launcher: spawn detached + unref (fire-and-forget),
 * the same pattern as ChildProcessAppLauncher in agent-runtime — the API
 * process never waits on the Blender GUI.
 */
export async function defaultLaunchDetached(argv: string[]): Promise<void> {
  const program = argv[0];
  if (typeof program !== 'string' || program.length === 0) {
    throw new Error('launchDetached: argv[0] (program) is required');
  }
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(program, argv.slice(1), {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', (err) => reject(err));
    child.on('spawn', () => {
      child.unref();
      resolvePromise();
    });
  });
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface BlenderDetection {
  installed: boolean;
  /** Absolute path to the Blender executable, when found. */
  path?: string;
  /** Parsed from `blender --version` (first line), e.g. "4.2.1". */
  version?: string;
  /** Best-effort: is a Blender process running? Omitted when unknown. */
  running?: boolean;
  /** Honest note about how detection went (misses, partial results). */
  detectionNote?: string;
}

/** Parse the version out of `blender --version` output ("Blender 4.2.1"). */
export function parseBlenderVersion(text: string): string | undefined {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /Blender\s+(\d+\.\d+\.\d+)/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

function pathJoinFor(platform: BlenderPlatform, dir: string, name: string): string {
  return platform === 'win32' ? `${dir.replace(/[\\/]+$/, '')}\\${name}` : join(dir, name);
}

/**
 * Standard install locations checked after PATH, per platform. Kept
 * deliberately simple (fixed candidates, probed with fs.exists) — no
 * directory globbing.
 */
export function blenderCommonLocations(platform: BlenderPlatform, probeFs: BlenderProbeFs): string[] {
  const home = probeFs.homeDir();
  if (platform === 'win32') {
    const versioned = ['4.5', '4.4', '4.3', '4.2', '4.1', '4.0', '3.6', '3.3'].map(
      (v) => `C:\\Program Files\\Blender Foundation\\Blender ${v}\\blender.exe`,
    );
    return [
      'C:\\Program Files\\Blender Foundation\\blender.exe',
      ...versioned,
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Blender\\blender.exe',
      `${home}\\AppData\\Local\\Programs\\Blender\\blender.exe`,
    ];
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Blender.app/Contents/MacOS/Blender',
      `${home}/Applications/Blender.app/Contents/MacOS/Blender`,
    ];
  }
  return [
    '/usr/bin/blender',
    '/usr/local/bin/blender',
    '/snap/bin/blender',
    pathJoinFor(platform, home, '.local/bin/blender'),
  ];
}

/** PATH lookup: runner.which() first, then a probe-fs scan of PATH dirs. */
async function findBlenderOnPath(
  runner: BlenderProcessRunner,
  platform: BlenderPlatform,
  probeFs: BlenderProbeFs,
): Promise<string | undefined> {
  if (typeof runner.which === 'function') {
    try {
      const hit = await runner.which('blender');
      if (hit) return hit;
    } catch {
      // Fall through to the PATH dir scan.
    }
  }
  const names = platform === 'win32' ? ['blender.exe', 'blender'] : ['blender'];
  for (const dir of probeFs.pathDirs()) {
    for (const name of names) {
      const candidate = pathJoinFor(platform, dir, name);
      if (probeFs.exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Best-effort "is Blender running?" — undefined when it cannot be told. */
async function detectBlenderRunning(
  runner: BlenderProcessRunner,
  platform: BlenderPlatform,
): Promise<boolean | undefined> {
  try {
    if (platform === 'win32') {
      const res = await runner.run(['tasklist', '/FI', 'IMAGENAME eq blender.exe'], { timeoutMs: 10_000 });
      if (res.code !== 0) return undefined;
      return /blender\.exe/i.test(res.stdout);
    }
    const res = await runner.run(['pgrep', '-x', 'blender'], { timeoutMs: 10_000 });
    if (res.code === 0) return true;
    if (res.code === 1) return false; // pgrep: no processes matched
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Detect Blender on this machine. Strategy: PATH first, then the common
 * install locations; version from `--version`; running state best-effort.
 * NEVER throws — any failure degrades to installed:false / omitted fields
 * with a detectionNote.
 */
export async function detectBlender(
  runner: BlenderProcessRunner,
  platform: BlenderPlatform = currentBlenderPlatform(),
  probeFs: BlenderProbeFs = createNodeBlenderProbeFs(),
): Promise<BlenderDetection> {
  try {
    let blenderPath = await findBlenderOnPath(runner, platform, probeFs).catch(() => undefined);
    if (!blenderPath) {
      for (const candidate of blenderCommonLocations(platform, probeFs)) {
        if (probeFs.exists(candidate)) {
          blenderPath = candidate;
          break;
        }
      }
    }
    if (!blenderPath) {
      return {
        installed: false,
        detectionNote:
          'Blender was not found on the PATH or in the standard install locations for this platform.',
      };
    }

    let version: string | undefined;
    try {
      const res = await runner.run([blenderPath, '--version'], { timeoutMs: 15_000 });
      version = parseBlenderVersion(res.stdout) ?? parseBlenderVersion(res.stderr);
    } catch {
      version = undefined;
    }

    const running = await detectBlenderRunning(runner, platform);

    const result: BlenderDetection = { installed: true, path: blenderPath };
    if (version) result.version = version;
    if (running !== undefined) result.running = running;
    if (!version) {
      result.detectionNote = 'Found Blender but could not read its version (`blender --version` failed).';
    }
    return result;
  } catch (err) {
    return {
      installed: false,
      detectionNote: `Blender detection failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Workspace path safety
// ---------------------------------------------------------------------------

function normalizedRoots(workspaceRoots: string[]): string[] {
  const roots = (workspaceRoots ?? []).map((r) => (typeof r === 'string' && r ? resolve(r) : '')).filter(Boolean);
  if (roots.length === 0) {
    throw new Error('no workspace roots are configured for the Blender tools');
  }
  return roots;
}

function isInsideRoots(resolved: string, roots: string[]): boolean {
  return roots.some((root) => resolved === root || resolved.startsWith(root + sep));
}

/**
 * Resolve `p` (absolute, or relative to the first workspace root) and
 * require it to live inside one of `workspaceRoots`. When
 * `allowedExtensions` is given (e.g. ['.blend']), the file extension must
 * match one of them. Returns the resolved absolute path; throws a clear
 * error otherwise.
 */
export function assertWorkspacePath(
  p: string,
  workspaceRoots: string[],
  allowedExtensions?: readonly string[],
): string {
  if (typeof p !== 'string' || p.trim().length === 0) {
    throw new Error('"path" must be a non-empty string');
  }
  const roots = normalizedRoots(workspaceRoots);
  const resolved = isAbsolute(p) ? resolve(p) : resolve(roots[0]!, p);
  if (!isInsideRoots(resolved, roots)) {
    throw new Error(`Path "${p}" is outside the workspace (allowed roots: ${roots.join(', ')})`);
  }
  if (allowedExtensions && allowedExtensions.length > 0) {
    const allowed = allowedExtensions.map((e) => (e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`));
    const ext = extname(resolved).toLowerCase();
    if (!allowed.includes(ext)) {
      throw new Error(`Path "${p}" must have extension ${allowed.join(' or ')} (got "${ext || '(none)'}")`);
    }
  }
  return resolved;
}

/**
 * Validate a Blender `--render-output` prefix: Blender appends the frame
 * number + extension to it, so the prefix itself need not exist — but its
 * DIRECTORY must resolve inside a workspace root. Returns the resolved
 * prefix.
 */
export function assertWorkspaceOutputPath(outputPath: string, workspaceRoots: string[]): string {
  if (typeof outputPath !== 'string' || outputPath.trim().length === 0) {
    throw new Error('"outputPath" must be a non-empty string');
  }
  const roots = normalizedRoots(workspaceRoots);
  const resolved = isAbsolute(outputPath) ? resolve(outputPath) : resolve(roots[0]!, outputPath);
  const dir = dirname(resolved);
  if (!isInsideRoots(dir, roots)) {
    throw new Error(`Render output path "${outputPath}" is outside the workspace (allowed roots: ${roots.join(', ')})`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Agent tools
// ---------------------------------------------------------------------------

export const BLENDER_STATUS_TOOL = 'blender_status';
export const BLENDER_OPEN_FILE_TOOL = 'blender_open_file';
export const BLENDER_RUN_SCRIPT_TOOL = 'blender_run_script';
export const BLENDER_RENDER_TOOL = 'blender_render';

export const BLENDER_TOOL_NAMES = [
  BLENDER_STATUS_TOOL,
  BLENDER_OPEN_FILE_TOOL,
  BLENDER_RUN_SCRIPT_TOOL,
  BLENDER_RENDER_TOOL,
] as const;

export const BLENDER_NOT_INSTALLED_ERROR = 'Blender is not installed on this computer';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MIN_TIMEOUT_MS = 1000;
const MAX_OUTPUT_CHARS = 8000;

export interface BlenderToolHostOptions {
  /**
   * Workspace roots the tools may touch. REQUIRED for the file/script/
   * render tools (the host wires these — typically
   * `[config.workspaceDir]` plus any per-bot workspace roots). Relative
   * tool arguments resolve against the first root.
   */
  workspaceRoots: string[];
  /** Process runner. Defaults to ExecFileBlenderRunner; tests inject fakes. */
  runner?: BlenderProcessRunner;
  /** Filesystem probe for detection. Defaults to the node probe. */
  probeFs?: BlenderProbeFs;
  /** Override process.platform (tests). */
  platform?: BlenderPlatform;
  /** Detached GUI launcher for blender_open_file (tests inject a recorder). */
  launchDetached?: BlenderDetachedLauncher;
  /** Timeout for run_script/render in ms. Default 10 min, clamped to [1s, 30 min]. */
  timeoutMs?: number;
}

interface ResolvedBlenderDeps {
  runner: BlenderProcessRunner;
  probeFs: BlenderProbeFs;
  platform: BlenderPlatform;
  launchDetached: BlenderDetachedLauncher;
  timeoutMs: number;
}

function resolveDeps(opts: BlenderToolHostOptions): ResolvedBlenderDeps {
  return {
    runner: opts.runner ?? new ExecFileBlenderRunner(),
    probeFs: opts.probeFs ?? createNodeBlenderProbeFs(),
    platform: opts.platform ?? currentBlenderPlatform(),
    launchDetached: opts.launchDetached ?? defaultLaunchDetached,
    timeoutMs: clampTimeoutMs(opts.timeoutMs),
  };
}

export function clampTimeoutMs(ms: number | undefined): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(ms), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

function truncateOutput(text: string, maxChars = MAX_OUTPUT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

async function requireBlender(deps: ResolvedBlenderDeps): Promise<BlenderDetection & { path: string }> {
  const detection = await detectBlender(deps.runner, deps.platform, deps.probeFs);
  if (!detection.installed || !detection.path) {
    throw new Error(BLENDER_NOT_INSTALLED_ERROR);
  }
  return detection as BlenderDetection & { path: string };
}

function requiredStringArg(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new Error(`"${name}" is required`);
  }
  return v;
}

function optionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new Error(`"${name}" must be a non-empty string when provided`);
  }
  return v;
}

/**
 * Governance policy rules the host should install (mirrors
 * composioToolPolicies(): first match wins). Status is read-only → allow;
 * opening files, running scripts and rendering change state → approval.
 */
export function blenderToolPolicies(): BotPolicyRule[] {
  return [
    {
      id: 'blender-status-allow',
      toolPattern: '^blender_status$',
      effect: 'allow',
      reason: 'Read-only Blender detection; no state changes.',
    },
    {
      id: 'blender-open-file-approval',
      toolPattern: '^blender_open_file$',
      effect: 'require-approval',
      reason: 'Opening a file launches the Blender GUI on this computer; require human approval.',
    },
    {
      id: 'blender-run-script-approval',
      toolPattern: '^blender_run_script$',
      effect: 'require-approval',
      reason: 'Running a Python script in Blender executes code on this computer; require human approval.',
    },
    {
      id: 'blender-render-approval',
      toolPattern: '^blender_render$',
      effect: 'require-approval',
      reason: 'Rendering writes files and runs Blender on this computer; require human approval.',
    },
  ];
}

export function createBlenderStatusTool(opts: BlenderToolHostOptions): ToolDefinition {
  const deps = resolveDeps(opts);
  return {
    name: BLENDER_STATUS_TOOL,
    description:
      'Check whether Blender is installed on this computer, and if so its path, version, and whether it is running. Read-only.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    handler: async (_args, _ctx: ToolContext) => {
      const detection = await detectBlender(deps.runner, deps.platform, deps.probeFs);
      return { ...detection };
    },
  };
}

export function createBlenderOpenFileTool(opts: BlenderToolHostOptions): ToolDefinition {
  const deps = resolveDeps(opts);
  return {
    name: BLENDER_OPEN_FILE_TOOL,
    mutating: true,
    description:
      'Open a .blend file in the Blender GUI on this computer. The file must be inside the workspace. ' +
      'MUTATING: requires human approval via governance.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to the .blend file (absolute, or relative to the workspace root).' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    handler: async (args, _ctx: ToolContext) => {
      const file = requiredStringArg(args, 'file');
      const resolved = assertWorkspacePath(file, opts.workspaceRoots, ['.blend']);
      const detection = await requireBlender(deps);
      await deps.launchDetached([detection.path, resolved]);
      return {
        opened: true,
        file: resolved,
        blenderPath: detection.path,
        artifacts: [{ kind: 'file', path: resolved }],
      };
    },
  };
}

export function createBlenderRunScriptTool(opts: BlenderToolHostOptions): ToolDefinition {
  const deps = resolveDeps(opts);
  return {
    name: BLENDER_RUN_SCRIPT_TOOL,
    mutating: true,
    description:
      'Run a Python script (.py, inside the workspace) in headless Blender, optionally against a .blend file. ' +
      'Returns the exit code and capped stdout/stderr. MUTATING: requires human approval via governance.',
    parameters: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'Path to the .py script (absolute, or relative to the workspace root).' },
        blendFile: { type: 'string', description: 'Optional .blend file to open before running the script.' },
      },
      required: ['script'],
      additionalProperties: false,
    },
    handler: async (args, _ctx: ToolContext) => {
      const script = requiredStringArg(args, 'script');
      const blendFile = optionalStringArg(args, 'blendFile');
      const scriptResolved = assertWorkspacePath(script, opts.workspaceRoots, ['.py']);
      const blendResolved = blendFile ? assertWorkspacePath(blendFile, opts.workspaceRoots, ['.blend']) : undefined;
      const detection = await requireBlender(deps);
      const argv = [
        detection.path,
        '--background',
        ...(blendResolved ? [blendResolved] : []),
        '--python',
        scriptResolved,
        '--python-exit-code',
        '1',
      ];
      const startedAt = Date.now();
      const res = await deps.runner.run(argv, { timeoutMs: deps.timeoutMs });
      const durationMs = Date.now() - startedAt;
      const stdout = truncateOutput(res.stdout);
      const stderr = truncateOutput(res.stderr);
      return {
        ok: res.code === 0,
        code: res.code,
        stdout: stdout.text,
        stderr: stderr.text,
        ...(stdout.truncated ? { stdoutTruncated: true } : {}),
        ...(stderr.truncated ? { stderrTruncated: true } : {}),
        durationMs,
        script: scriptResolved,
        ...(blendResolved ? { blendFile: blendResolved } : {}),
        artifacts: [{ kind: 'file', path: scriptResolved }],
      };
    },
  };
}

export function createBlenderRenderTool(opts: BlenderToolHostOptions): ToolDefinition {
  const deps = resolveDeps(opts);
  return {
    name: BLENDER_RENDER_TOOL,
    mutating: true,
    description:
      'Render a .blend file headlessly: one frame (default frame 1) or a full animation. ' +
      'outputPath is a Blender render-output PREFIX inside the workspace (Blender appends the frame number + extension). ' +
      'MUTATING: requires human approval via governance.',
    parameters: {
      type: 'object',
      properties: {
        blendFile: { type: 'string', description: 'Path to the .blend file (absolute, or relative to the workspace root).' },
        outputPath: { type: 'string', description: 'Render-output prefix; its directory must be inside the workspace.' },
        frame: { type: 'number', description: 'Frame to render for a still (default 1). Ignored for animations.' },
        animation: { type: 'boolean', description: 'Render the full animation instead of a single frame.' },
      },
      required: ['blendFile', 'outputPath'],
      additionalProperties: false,
    },
    handler: async (args, _ctx: ToolContext) => {
      const blendFile = requiredStringArg(args, 'blendFile');
      const outputPath = requiredStringArg(args, 'outputPath');
      const animation = args['animation'] === true;
      const frameRaw = args['frame'];
      if (frameRaw !== undefined && (typeof frameRaw !== 'number' || !Number.isInteger(frameRaw) || frameRaw < 0)) {
        throw new Error('"frame" must be a non-negative integer when provided');
      }
      const frame = typeof frameRaw === 'number' ? frameRaw : 1;
      const blendResolved = assertWorkspacePath(blendFile, opts.workspaceRoots, ['.blend']);
      const outputResolved = assertWorkspaceOutputPath(outputPath, opts.workspaceRoots);
      const detection = await requireBlender(deps);
      const argv = [
        detection.path,
        '--background',
        blendResolved,
        '--render-output',
        outputResolved,
        ...(animation ? ['--render-anim'] : ['--render-frame', String(frame)]),
      ];
      const startedAt = Date.now();
      const res = await deps.runner.run(argv, { timeoutMs: deps.timeoutMs });
      const durationMs = Date.now() - startedAt;
      const stdout = truncateOutput(res.stdout);
      const stderr = truncateOutput(res.stderr);
      // Blender appends the zero-padded frame number and the scene's image
      // extension to the prefix; .png is the default/factory extension.
      const expectedStill = `${outputResolved}${String(frame).padStart(4, '0')}.png`;
      const outputs = animation ? [outputResolved] : [expectedStill];
      const outputNote = animation
        ? 'Animation frames are written next to the render-output prefix with frame numbers and the scene image extension appended.'
        : 'Blender appends the 4-digit frame number and the scene image extension to the render-output prefix (expected path shown with the default .png extension).';
      return {
        ok: res.code === 0,
        code: res.code,
        outputs,
        outputPrefix: outputResolved,
        outputNote,
        stdout: stdout.text,
        stderr: stderr.text,
        ...(stdout.truncated ? { stdoutTruncated: true } : {}),
        ...(stderr.truncated ? { stderrTruncated: true } : {}),
        durationMs,
        blendFile: blendResolved,
        artifacts: outputs.map((p) => ({ kind: 'file', path: p })),
      };
    },
  };
}

/** Build the four Blender ToolDefinitions. */
export function createBlenderTools(opts: BlenderToolHostOptions): ToolDefinition[] {
  return [
    createBlenderStatusTool(opts),
    createBlenderOpenFileTool(opts),
    createBlenderRunScriptTool(opts),
    createBlenderRenderTool(opts),
  ];
}

/**
 * Register the Blender bridge tools into a tool registry. Throws on name
 * collision, mirroring registerComposioTools.
 */
export function registerBlenderTools(
  registry: Map<string, ToolDefinition>,
  opts: BlenderToolHostOptions,
): void {
  for (const tool of createBlenderTools(opts)) {
    if (registry.has(tool.name)) {
      throw new Error(`tool name collision: "${tool.name}" is already registered`);
    }
    registry.set(tool.name, tool);
  }
}

// ---------------------------------------------------------------------------
// Local apps read model
// ---------------------------------------------------------------------------

export interface LocalAppInfo {
  /** Stable app key, e.g. "blender", "vscode". */
  key: string;
  /** Display name, e.g. "Blender", "Visual Studio Code". */
  name: string;
  installed: boolean;
  /** Version, when detection could read one (Blender only today). */
  version?: string;
  /** Whether the app appears to be running, when detectable. */
  running?: string | boolean | undefined;
  /** Honest note when detection is partial or best-effort. */
  detectionNote?: string;
  /** Name to pass to computer_open_app to launch this app. */
  openName: string;
}

/** Everything listLocalApps needs to probe the machine (injectable). */
export interface LocalAppsProbe {
  runner: BlenderProcessRunner;
  probeFs: BlenderProbeFs;
  platform: BlenderPlatform;
}

export function createDefaultLocalAppsProbe(overrides: Partial<LocalAppsProbe> = {}): LocalAppsProbe {
  return {
    runner: overrides.runner ?? new ExecFileBlenderRunner(),
    probeFs: overrides.probeFs ?? createNodeBlenderProbeFs(),
    platform: overrides.platform ?? currentBlenderPlatform(),
  };
}

interface LocalAppCatalogEntry {
  key: string;
  name: string;
  openName: string;
}

const LOCAL_APP_CATALOG: readonly LocalAppCatalogEntry[] = [
  { key: 'blender', name: 'Blender', openName: 'blender' },
  { key: 'whatsapp', name: 'WhatsApp', openName: 'whatsapp' },
  { key: 'vscode', name: 'Visual Studio Code', openName: 'vscode' },
  { key: 'spotify', name: 'Spotify', openName: 'spotify' },
  { key: 'slack', name: 'Slack', openName: 'slack' },
  { key: 'discord', name: 'Discord', openName: 'discord' },
  { key: 'word', name: 'Microsoft Word', openName: 'word' },
  { key: 'excel', name: 'Microsoft Excel', openName: 'excel' },
  { key: 'powerpoint', name: 'Microsoft PowerPoint', openName: 'powerpoint' },
];

const BEST_EFFORT_NOTE =
  'Detection is best-effort on this platform; a bot can still try to open it.';

/** Extra fixed install locations for the generic (non-Blender) apps. */
function genericAppLocations(
  key: string,
  platform: BlenderPlatform,
  probeFs: BlenderProbeFs,
): { absolute: string[]; pathNames: string[] } {
  const alias = APP_ALIASES[key];
  const home = probeFs.homeDir();
  const absolute: string[] = [];
  const pathNames: string[] = [];
  if (platform === 'win32') {
    pathNames.push(...(alias?.exes ?? []));
    if (key === 'vscode') absolute.push(`${home}\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe`);
    if (key === 'word') absolute.push('C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE');
    if (key === 'excel') absolute.push('C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE');
    if (key === 'powerpoint') absolute.push('C:\\Program Files\\Microsoft Office\\root\\Office16\\POWERPNT.EXE');
  } else if (platform === 'darwin') {
    for (const macName of alias?.macNames ?? []) {
      absolute.push(`/Applications/${macName}.app`);
    }
  } else {
    const linuxNames = alias?.linuxNames ?? [];
    pathNames.push(...linuxNames);
    for (const name of linuxNames) {
      absolute.push(`/usr/bin/${name}`, `/usr/local/bin/${name}`, `/snap/bin/${name}`);
    }
  }
  return { absolute, pathNames };
}

function detectGenericApp(
  entry: LocalAppCatalogEntry,
  probe: LocalAppsProbe,
): { installed: boolean; detectionNote?: string } {
  const alias = APP_ALIASES[entry.key];
  const hasPlatformTarget =
    probe.platform === 'win32'
      ? Boolean(alias?.exes?.length)
      : probe.platform === 'darwin'
        ? Boolean(alias?.macNames?.length)
        : Boolean(alias?.linuxNames?.length);
  const { absolute, pathNames } = genericAppLocations(entry.key, probe.platform, probe.probeFs);
  let installed = absolute.some((p) => probe.probeFs.exists(p));
  if (!installed && pathNames.length > 0) {
    const dirs = probe.probeFs.pathDirs();
    installed = pathNames.some((name) =>
      dirs.some((dir) => probe.probeFs.exists(pathJoinFor(probe.platform, dir, name))),
    );
  }
  if (installed) return { installed: true };
  if (!hasPlatformTarget) {
    return {
      installed: false,
      detectionNote: `No native ${probe.platform} install is known for ${entry.name}. ${BEST_EFFORT_NOTE}`,
    };
  }
  // Not found by the probes — but PATH/app-folder checks miss Store apps
  // and non-standard installs, so stay honest rather than claiming absence.
  return { installed: false, detectionNote: BEST_EFFORT_NOTE };
}

/**
 * List the well-known local desktop apps with best-effort install
 * detection. Blender gets the full detection (version + running); the
 * rest are binary-presence checks over APP_ALIASES + PATH/common
 * locations. Never throws for a single app's detection failure.
 */
export async function listLocalApps(probe: LocalAppsProbe): Promise<LocalAppInfo[]> {
  const apps: LocalAppInfo[] = [];
  for (const entry of LOCAL_APP_CATALOG) {
    if (entry.key === 'blender') {
      const detection = await detectBlender(probe.runner, probe.platform, probe.probeFs);
      const info: LocalAppInfo = {
        key: entry.key,
        name: entry.name,
        installed: detection.installed,
        openName: entry.openName,
      };
      if (detection.version) info.version = detection.version;
      if (detection.running !== undefined) info.running = detection.running;
      if (detection.detectionNote) info.detectionNote = detection.detectionNote;
      apps.push(info);
      continue;
    }
    let detected: { installed: boolean; detectionNote?: string };
    try {
      detected = detectGenericApp(entry, probe);
    } catch {
      detected = { installed: false, detectionNote: BEST_EFFORT_NOTE };
    }
    const info: LocalAppInfo = {
      key: entry.key,
      name: entry.name,
      installed: detected.installed,
      openName: entry.openName,
    };
    if (detected.detectionNote) info.detectionNote = detected.detectionNote;
    apps.push(info);
  }
  return apps;
}

// ---------------------------------------------------------------------------
// Routes: GET /local-apps
// ---------------------------------------------------------------------------

export interface LocalAppRoutesDeps {
  config: AppConfig;
  /** Full injectable probe (tests). Wins over the partial overrides below. */
  probe?: LocalAppsProbe;
  runner?: BlenderProcessRunner;
  probeFs?: BlenderProbeFs;
  platform?: BlenderPlatform;
  /**
   * Optional tenancy auth: when a loopbackToken and/or jwtSecret is
   * supplied, the route sits behind principalMiddleware (the composio.ts
   * pattern, PrincipalContext { dataDir, loopbackToken, jwtSecret }).
   * When omitted, the route relies on the host's loopback auth like the
   * computer-surface routes do — the coordinator wires it inside the
   * already-authenticated /api router.
   */
  loopbackToken?: string;
  jwtSecret?: string;
}

/**
 * Register GET /local-apps → { apps: LocalAppInfo[] } on the router passed
 * in (relative path → /api/local-apps when the host mounts it under /api).
 */
export function registerLocalAppRoutes(router: express.Router, deps: LocalAppRoutesDeps): void {
  const probe =
    deps.probe ??
    createDefaultLocalAppsProbe({
      runner: deps.runner,
      probeFs: deps.probeFs,
      platform: deps.platform,
    });

  const guards: express.RequestHandler[] = [];
  if (deps.loopbackToken !== undefined || deps.jwtSecret !== undefined) {
    const pctx: PrincipalContext = {
      dataDir: deps.config.dataDir,
      loopbackToken: deps.loopbackToken,
      jwtSecret: deps.jwtSecret,
    };
    guards.push(principalMiddleware(pctx));
  }

  router.get('/local-apps', ...guards, async (_req, res) => {
    try {
      const apps = await listLocalApps(probe);
      res.json({ apps });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'Failed to list local apps', detail: message });
    }
  });
}
