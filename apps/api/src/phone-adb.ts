// SPDX-License-Identifier: Apache-2.0
// ADB fallback for remote-phone control (KriyaDot MVP).
//
// When `adb` is on PATH and a device is attached over USB/Wi-Fi, the API
// exposes it as a virtual device (kind: 'adb') in the phone device list.
// Screen:  `adb exec-out screencap -p`  (PNG — served as-is, v1 does MJPEG
// only for the phone-app path).
// Input:   `adb shell input tap|x|y|swipe|text|keyevent`.
//
// Security: the device serial is validated against the CURRENT `adb devices`
// output on every call — never run adb with unsanitized input. When adb is
// absent, the provider degrades gracefully (isAvailable() === false).

import { execFile } from 'node:child_process';
import type { ExecFileOptions } from 'node:child_process';

export interface AdbDevice {
  serial: string;
  state: string;
}

/** Runner injectable for hermetic tests. */
export type AdbRunner = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: Buffer; stderr: Buffer; code: number }>;

function defaultRunner(cmd: string, args: string[]): Promise<{ stdout: Buffer; stderr: Buffer; code: number }> {
  const opts: ExecFileOptions = { encoding: 'buffer', timeout: 15000, maxBuffer: 32 * 1024 * 1024 };
  return new Promise((resolve) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      resolve({
        stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? '')),
        stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(String(stderr ?? '')),
        code: err ? ((err as { code?: number }).code ?? 1) : 0,
      });
    });
  });
}

/** Strict serial: what `adb devices` prints in column 1. */
const SERIAL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export function isValidSerial(serial: unknown): serial is string {
  return typeof serial === 'string' && SERIAL_RE.test(serial);
}

const KEYEVENT_MAP: Record<string, string> = {
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  wake: 'KEYCODE_WAKEUP',
};

export class AdbPhoneProvider {
  private whichCache: boolean | null = null;

  constructor(
    private readonly runner: AdbRunner = defaultRunner,
    private readonly which: (cmd: string) => boolean = defaultWhich,
  ) {}

  /** True when the `adb` binary exists on PATH. Cached after first check. */
  async isAvailable(): Promise<boolean> {
    if (this.whichCache === null) {
      try {
        this.whichCache = this.which('adb');
      } catch {
        this.whichCache = false;
      }
    }
    return this.whichCache;
  }

  async listDevices(): Promise<AdbDevice[]> {
    if (!(await this.isAvailable())) return [];
    const r = await this.runner('adb', ['devices']);
    if (r.code !== 0) return [];
    return parseAdbDevices(r.stdout.toString('utf8'));
  }

  /** Resolve a user-supplied serial against the live device list. */
  async resolveSerial(serial: unknown): Promise<string | null> {
    if (!isValidSerial(serial)) return null;
    const devices = await this.listDevices();
    const found = devices.find((d) => d.serial === serial && d.state === 'device');
    return found ? found.serial : null;
  }

  /** Grab one screen frame (PNG). Returns dims parsed from the PNG IHDR. */
  async grabFrame(serial: string): Promise<{ png: Buffer; w: number; h: number }> {
    const s = await this.resolveSerial(serial);
    if (!s) throw new Error('adb_device_not_found');
    const r = await this.runner('adb', ['-s', s, 'exec-out', 'screencap', '-p']);
    if (r.code !== 0 || r.stdout.length < 100) throw new Error('adb_screencap_failed');
    // exec-out can prepend a stray \r\n on Windows hosts; find the PNG magic.
    const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const idx = r.stdout.indexOf(magic);
    const png = idx >= 0 ? r.stdout.subarray(idx) : r.stdout;
    const dims = parsePngDims(png);
    if (!dims) throw new Error('adb_bad_png');
    return { png, w: dims.w, h: dims.h };
  }

  async tap(serial: string, x01: number, y01: number): Promise<void> {
    const s = await this.resolveSerial(serial);
    if (!s) throw new Error('adb_device_not_found');
    const { w, h } = await this.grabFrameDims(s);
    const x = Math.round(clamp01(x01) * w);
    const y = Math.round(clamp01(y01) * h);
    await this.shellInput(s, ['tap', String(x), String(y)]);
  }

  async swipe(serial: string, x1: number, y1: number, x2: number, y2: number, ms: number): Promise<void> {
    const s = await this.resolveSerial(serial);
    if (!s) throw new Error('adb_device_not_found');
    const { w, h } = await this.grabFrameDims(s);
    const dur = Math.max(50, Math.min(5000, Math.round(ms)));
    await this.shellInput(s, [
      'swipe',
      String(Math.round(clamp01(x1) * w)),
      String(Math.round(clamp01(y1) * h)),
      String(Math.round(clamp01(x2) * w)),
      String(Math.round(clamp01(y2) * h)),
      String(dur),
    ]);
  }

  /** Type text. Conservative encoding: `input text` treats %s as space, so
   *  only alphanumerics pass through, spaces become %s, everything else is
   *  dropped rather than risking shell injection. */
  async text(serial: string, text: string): Promise<void> {
    const s = await this.resolveSerial(serial);
    if (!s) throw new Error('adb_device_not_found');
    if (typeof text !== 'string' || text.length === 0 || text.length > 1024) throw new Error('adb_bad_text');
    let encoded = '';
    for (const ch of text) {
      if (/[A-Za-z0-9]/.test(ch)) encoded += ch;
      else if (ch === ' ') encoded += '%s';
      // else: dropped (no safe mapping through `input text`)
    }
    if (encoded.length === 0) throw new Error('adb_bad_text');
    await this.shellInput(s, ['text', encoded]);
  }

  async key(serial: string, key: 'back' | 'home' | 'wake'): Promise<void> {
    const s = await this.resolveSerial(serial);
    if (!s) throw new Error('adb_device_not_found');
    const code = KEYEVENT_MAP[key];
    if (!code) throw new Error('adb_bad_key');
    await this.shellInput(s, ['keyevent', code]);
  }

  private async shellInput(serial: string, inputArgs: string[]): Promise<void> {
    const r = await this.runner('adb', ['-s', serial, 'shell', 'input', ...inputArgs]);
    if (r.code !== 0) throw new Error(`adb_input_failed: ${r.stderr.toString('utf8').slice(0, 200)}`);
  }

  private async grabFrameDims(serial: string): Promise<{ w: number; h: number }> {
    const r = await this.runner('adb', ['-s', serial, 'shell', 'wm', 'size']);
    const m = /(\d+)\s*x\s*(\d+)/.exec(r.stdout.toString('utf8'));
    if (r.code === 0 && m) return { w: Number(m[1]), h: Number(m[2]) };
    // Fallback: a real frame's dims.
    const f = await this.grabFrame(serial);
    return { w: f.w, h: f.h };
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Parse `adb devices` output into serial/state pairs (skips the header and offline/unauthorized). */
export function parseAdbDevices(out: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  for (const line of out.split('\n')) {
    const m = /^(\S+)\s+(\S+)/.exec(line.trim());
    if (!m || m[1] === 'List') continue;
    if (!isValidSerial(m[1])) continue;
    devices.push({ serial: m[1], state: m[2] });
  }
  return devices;
}

/** Parse PNG IHDR width/height (big-endian u32 at offsets 16/20). */
export function parsePngDims(png: Buffer): { w: number; h: number } | null {
  if (png.length < 24) return null;
  if (png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) return null;
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  if (w < 1 || h < 1 || w > 8192 || h > 8192) return null;
  return { w, h };
}

function defaultWhich(cmd: string): boolean {
  try {
    const { execFileSync } = process.getBuiltinModule('node:child_process') as typeof import('node:child_process');
    const probe = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(probe, [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
