// SPDX-License-Identifier: Apache-2.0
// Camera photo capture on the user's OWN computer (Muse parity audit
// §4.14, DV-7). Screen capture already exists (computer view / screenshot
// backends); the missing piece was a still photo from the machine's camera.
//
// Strategy: use the OS camera tools that ship with / are standard on each
// platform — no new native dependency:
//   - Linux:  `fswebcam` when present, else `ffmpeg` (v4l2, /dev/video0).
//   - macOS:  `imagesnap` (widely installed via Homebrew; ships with many
//             setups). If absent the tool reports a clean unavailable error.
//   - Windows: `ffmpeg` with DirectShow (device name configurable; the
//             default "Integrated Camera" matches most laptops).
//
// Everything is injectable (runner + file probe + clock) so tests run with
// zero hardware: a fake runner "captures" by writing fixture bytes.
//
// Governance: a camera photo is a sensitive capture → require-approval via
// cameraCapturePolicyRules(), matching the phone tools' posture. The photo
// lands under <dataDir>/camera-captures/ and the tool returns its path +
// byte size only (no base64 payloads in tool results).

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BotPolicyRule, ToolContext, ToolDefinition } from '@mvp/agent-runtime';
import { PAUSED_MESSAGE } from './system-pause.js';

export function cameraCapturePolicyRules(): BotPolicyRule[] {
  return [
    {
      id: 'camera-capture-approval',
      toolPattern: '^computer_camera_photo$',
      effect: 'require-approval',
      reason:
        'Taking a photo with the user\'s computer camera is a sensitive capture; needs human approval. The approval card names the camera tool that will run.',
    },
  ];
}

export interface CameraCommandPlan {
  command: string;
  args: string[];
  tool: 'fswebcam' | 'ffmpeg-v4l2' | 'imagesnap' | 'ffmpeg-dshow';
}

/** Commands considered, per platform, in preference order. */
export function cameraToolCandidates(platform: string): string[] {
  switch (platform) {
    case 'linux':
      return ['fswebcam', 'ffmpeg'];
    case 'darwin':
      return ['imagesnap'];
    case 'win32':
      return ['ffmpeg'];
    default:
      return [];
  }
}

/**
 * Pure: pick the capture command for a platform given which tools exist.
 * `available` answers "is this executable usable?" (PATH lookup upstream).
 * Returns null when no supported tool is available (honest unavailable).
 */
export function planCameraCommand(
  platform: string,
  available: (cmd: string) => boolean,
  outPath: string,
  opts: { device?: string } = {},
): CameraCommandPlan | null {
  for (const cmd of cameraToolCandidates(platform)) {
    if (!available(cmd)) continue;
    if (platform === 'linux' && cmd === 'fswebcam') {
      return { command: 'fswebcam', args: ['-r', '1280x720', '--no-banner', outPath], tool: 'fswebcam' };
    }
    if (platform === 'linux' && cmd === 'ffmpeg') {
      return {
        command: 'ffmpeg',
        args: ['-y', '-f', 'v4l2', '-i', opts.device ?? '/dev/video0', '-frames:v', '1', outPath],
        tool: 'ffmpeg-v4l2',
      };
    }
    if (platform === 'darwin' && cmd === 'imagesnap') {
      return { command: 'imagesnap', args: ['-w', '0.5', outPath], tool: 'imagesnap' };
    }
    if (platform === 'win32' && cmd === 'ffmpeg') {
      return {
        command: 'ffmpeg',
        args: ['-y', '-f', 'dshow', '-i', `video=${opts.device ?? 'Integrated Camera'}`, '-frames:v', '1', outPath],
        tool: 'ffmpeg-dshow',
      };
    }
  }
  return null;
}

export type CameraRunner = (command: string, args: string[]) => Promise<void>;

export interface CameraCaptureDeps {
  dataDir: string;
  platform?: string;
  device?: string;
  /** Injectable for tests; default shells out via execFile (no shell). */
  runner?: CameraRunner;
  /** Injectable for tests; default probes PATH via `which`/`where` helpers below. */
  isAvailable?: (cmd: string) => boolean;
  fileSize?: (path: string) => number;
  now?: () => number;
}

export interface CameraCaptureResult {
  ok: true;
  path: string;
  bytes: number;
  tool: CameraCommandPlan['tool'];
  capturedAt: number;
}

const defaultRunner: CameraRunner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 30_000, windowsHide: true }, (err) => {
      if (err) reject(new Error(`${command} failed: ${err.message.split('\n')[0]}`));
      else resolve();
    });
  });

/**
 * Default availability probe: synchronous PATH scan. Deliberately simple —
 * the interesting platforms ship these tools in standard bin directories.
 */
export function defaultIsAvailable(cmd: string, platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  const pathVar = env['PATH'] ?? '';
  const dirs = pathVar.split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        if (existsSync(join(dir, cmd + ext))) return true;
      } catch { /* ignore */ }
    }
  }
  return false;
}

export class CameraCaptureService {
  private readonly platform: string;
  private readonly runner: CameraRunner;
  private readonly isAvailable: (cmd: string) => boolean;
  private readonly fileSize: (path: string) => number;
  private readonly now: () => number;

  constructor(private readonly deps: CameraCaptureDeps) {
    this.platform = deps.platform ?? process.platform;
    this.runner = deps.runner ?? defaultRunner;
    this.isAvailable = deps.isAvailable ?? ((cmd) => defaultIsAvailable(cmd, this.platform));
    this.fileSize = deps.fileSize ?? ((p) => statSync(p).size);
    this.now = deps.now ?? (() => Date.now());
  }

  /** Directory photos are written to (created on demand). */
  captureDir(): string {
    return join(this.deps.dataDir, 'camera-captures');
  }

  /** Capture one photo. Throws a clean Error when no camera tool exists or the capture fails. */
  async capture(): Promise<CameraCaptureResult> {
    const dir = this.captureDir();
    mkdirSync(dir, { recursive: true });
    const capturedAt = this.now();
    const outPath = join(dir, `photo-${capturedAt}.jpg`);
    const plan = planCameraCommand(this.platform, this.isAvailable, outPath, { device: this.deps.device });
    if (!plan) {
      const wanted = cameraToolCandidates(this.platform).join(' or ') || 'a supported camera tool';
      throw new Error(
        `no camera capture tool available on this ${this.platform} machine (looked for ${wanted}). ` +
          'Install one (Linux: fswebcam or ffmpeg; macOS: imagesnap; Windows: ffmpeg) and retry.',
      );
    }
    await this.runner(plan.command, plan.args);
    let bytes = 0;
    try {
      bytes = this.fileSize(outPath);
    } catch {
      throw new Error(`camera tool ${plan.command} ran but produced no photo at ${outPath}`);
    }
    if (!bytes || bytes <= 0) throw new Error(`camera tool ${plan.command} produced an empty photo`);
    return { ok: true, path: outPath, bytes, tool: plan.tool, capturedAt };
  }
}

export interface CameraToolDeps {
  service: CameraCaptureService;
  audit?: (action: string, fields: { actor?: string; toolName?: string; detail?: unknown; sessionId?: string }) => void;
  isPaused?: () => boolean;
}

export function createCameraCaptureTools(deps: CameraToolDeps): ToolDefinition[] {
  return [
    {
      name: 'computer_camera_photo',
      description:
        'Take a still photo with the camera of the user\'s own computer (fswebcam/ffmpeg on Linux, imagesnap on macOS, ffmpeg DirectShow on Windows). Returns the saved file path and size. Requires human approval.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      handler: async (_args, ctx: ToolContext) => {
        if (deps.isPaused?.()) throw new Error(`paused: ${PAUSED_MESSAGE}`);
        const result = await deps.service.capture();
        try {
          deps.audit?.('computer.camera_photo', {
            actor: ctx.botId, toolName: 'computer_camera_photo', sessionId: ctx.sessionId,
            detail: { tool: result.tool, bytes: result.bytes },
          });
        } catch { /* audit must never break the tool */ }
        return result;
      },
    } satisfies ToolDefinition,
  ];
}

/** Register the camera tool into a registry (skips collisions). */
export function registerCameraCaptureTools(registry: Map<string, ToolDefinition>, deps: CameraToolDeps): void {
  for (const tool of createCameraCaptureTools(deps)) {
    if (!registry.has(tool.name)) registry.set(tool.name, tool);
  }
}
