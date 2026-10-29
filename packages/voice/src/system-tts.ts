// SPDX-License-Identifier: Apache-2.0
// System TTS provider: speech through the operating system's own
// speech binary — no API key, no network, fully offline:
//
//   macOS   → `say`            (renders AIFF)
//   Linux   → `espeak-ng` / `espeak` / `spd-say` (renders WAV)
//   Windows → PowerShell System.Speech (renders WAV)
//
// The command runner is injectable (opts.runner) so tests never spawn
// a real binary; the default runner renders to a temp file with
// execFile (no shell, so text is never interpreted as commands).
//
// Degradation is clean by design: construction never throws for a
// missing binary. synthesize() throws one clear error naming the
// binary it looked for, and available() reports false — callers can
// fall back to the mock or another provider instead of crashing.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TTSProvider, TTSResult, TTSSynthesizeOptions } from './voice.js';

/** One resolved speech invocation: run `command` with `args`. */
export interface SystemTtsInvocation {
  command: string;
  args: string[];
  mimeType: string;
}

/**
 * Runs a speech invocation and returns the rendered audio bytes.
 * `{output}` inside an arg is a placeholder for a writable file path
 * (the default runner substitutes a temp file; Windows SAPI needs the
 * path inside its script). Injected runners may ignore it.
 */
export type SystemCommandRunner = (invocation: SystemTtsInvocation) => Promise<Uint8Array>;

/** Reports whether a command exists on this machine. */
export type SystemCommandProbe = (command: string) => Promise<boolean>;

/** Candidate speech binaries per platform, in preference order. */
export const SYSTEM_TTS_CANDIDATES: Record<string, readonly string[]> = {
  darwin: ['say'],
  linux: ['espeak-ng', 'espeak', 'spd-say'],
  win32: ['powershell'],
};

export interface SystemTTSOptions {
  /** Platform override (tests); defaults to process.platform. */
  platform?: string;
  /** Explicit speech binary, bypassing the per-platform candidates. */
  command?: string;
  /** Default voice name for the OS synthesizer. */
  voice?: string;
  /** Injectable command runner (tests); defaults to a temp-file runner. */
  runner?: SystemCommandRunner;
  /** Injectable availability probe (tests); defaults to `which`/`where`. */
  probe?: SystemCommandProbe;
}

/** First candidate speech binary for a platform, or null when unsupported. */
export function detectSystemTtsCommand(platform: string = process.platform): string | null {
  return SYSTEM_TTS_CANDIDATES[platform]?.[0] ?? null;
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Build the invocation for one utterance. Pure — the mapping is unit
 * tested per platform without spawning anything.
 */
export function systemTtsInvocation(
  platform: string,
  text: string,
  opts: { voice?: string; command?: string } = {},
): SystemTtsInvocation {
  const command = opts.command ?? detectSystemTtsCommand(platform);
  if (!command) {
    throw new Error(`system TTS: no speech binary is known for platform "${platform}" (supported: darwin, linux, win32)`);
  }
  if (command === 'say') {
    return { command, args: [...(opts.voice ? ['-v', opts.voice] : []), text], mimeType: 'audio/aiff' };
  }
  if (command === 'espeak-ng' || command === 'espeak') {
    return { command, args: [...(opts.voice ? ['-v', opts.voice] : []), text], mimeType: 'audio/wav' };
  }
  if (command === 'spd-say') {
    return { command, args: [text], mimeType: 'audio/wav' };
  }
  if (command === 'powershell') {
    const script =
      `Add-Type -AssemblyName System.Speech; ` +
      `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
      `$s.SetOutputToWaveFile('{output}'); ` +
      (opts.voice ? `$s.SelectVoice('${escapePowerShellSingleQuoted(opts.voice)}'); ` : '') +
      `$s.Speak('${escapePowerShellSingleQuoted(text)}'); $s.Dispose()`;
    return { command, args: ['-NoProfile', '-NonInteractive', '-Command', script], mimeType: 'audio/wav' };
  }
  // Explicit custom command: assume it accepts the text as its last
  // argument and writes audio to the {output} file when given one.
  return { command, args: [text], mimeType: 'audio/wav' };
}

function execFileBuffer(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout as Buffer);
    });
  });
}

/** Default probe: `which <cmd>` (POSIX) / `where <cmd>` (Windows). */
export const defaultSystemCommandProbe: SystemCommandProbe = async (command) => {
  try {
    await execFileBuffer(process.platform === 'win32' ? 'where' : 'which', [command]);
    return true;
  } catch {
    return false;
  }
};

/**
 * Default runner: renders speech to a temp file, reads it back, and
 * cleans up. `spd-say` speaks through speech-dispatcher and cannot
 * render to a file — that case fails with an explicit message rather
 * than returning silence.
 */
export const defaultSystemCommandRunner: SystemCommandRunner = async (invocation) => {
  if (invocation.command === 'spd-say') {
    throw new Error(
      'system TTS: spd-say cannot render audio to a file (it speaks through speech-dispatcher); install espeak-ng for file output',
    );
  }
  const dir = await mkdtemp(join(tmpdir(), 'kriyadot-system-tts-'));
  const ext = invocation.mimeType === 'audio/aiff' ? 'aiff' : 'wav';
  const outPath = join(dir, `speech.${ext}`);
  try {
    let args = invocation.args.map((a) => a.replaceAll('{output}', outPath));
    if (invocation.command === 'say') args = ['-o', outPath, ...args];
    else if (invocation.command === 'espeak-ng' || invocation.command === 'espeak') args = ['-w', outPath, ...args];
    else if (invocation.command !== 'powershell' && !invocation.args.some((a) => a.includes('{output}'))) {
      // Unknown explicit binary: fall back to capturing its stdout.
      const stdout = await execFileBuffer(invocation.command, args);
      if (stdout.length === 0) throw new Error(`system TTS: "${invocation.command}" produced no audio`);
      return new Uint8Array(stdout);
    }
    await execFileBuffer(invocation.command, args);
    const bytes = await readFile(outPath);
    if (bytes.length === 0) throw new Error(`system TTS: "${invocation.command}" produced no audio`);
    return new Uint8Array(bytes);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};

/**
 * OS speech synthesis. Never throws at construction for a missing
 * binary — check available() or let synthesize() surface the clear
 * "not found" error.
 */
export class SystemTTSProvider implements TTSProvider {
  readonly name = 'system' as const;
  private readonly platform: string;
  private readonly commandOverride?: string;
  private readonly defaultVoice?: string;
  private readonly runner: SystemCommandRunner;
  private readonly probe: SystemCommandProbe;
  private readonly hasCustomRunner: boolean;
  private availableCache: Promise<boolean> | null = null;

  constructor(opts: SystemTTSOptions = {}) {
    this.platform = opts.platform ?? process.platform;
    this.commandOverride = opts.command;
    this.defaultVoice = opts.voice;
    this.runner = opts.runner ?? defaultSystemCommandRunner;
    this.probe = opts.probe ?? defaultSystemCommandProbe;
    this.hasCustomRunner = opts.runner !== undefined;
  }

  /** The binary this provider would invoke, or null on unsupported platforms. */
  get command(): string | null {
    return this.commandOverride ?? detectSystemTtsCommand(this.platform);
  }

  /**
   * Whether synthesis can work here. With an injected runner and no
   * injected probe we trust the runner (tests); otherwise the real
   * binary is probed once and cached.
   */
  available(): Promise<boolean> {
    if (!this.availableCache) {
      this.availableCache = (async () => {
        const cmd = this.command;
        if (!cmd) return false;
        if (this.hasCustomRunner && this.probe === defaultSystemCommandProbe) return true;
        try {
          return await this.probe(cmd);
        } catch {
          return false;
        }
      })();
    }
    return this.availableCache;
  }

  async synthesize(text: string, opts: TTSSynthesizeOptions = {}): Promise<TTSResult> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('system TTS: text must be non-empty');
    if (trimmed.length > 5000) throw new Error('system TTS: text too long (max 5000 chars)');
    if (opts.format !== undefined && opts.format !== 'wav' && opts.format !== 'mp3') {
      throw new Error(`system TTS: unsupported format "${opts.format}"`);
    }
    const cmd = this.command;
    if (!cmd) {
      throw new Error(
        `system TTS: no speech binary is known for platform "${this.platform}" — synthesis unavailable (install a provider or pick another TTS provider)`,
      );
    }
    if (!(await this.available())) {
      throw new Error(
        `system TTS: speech binary "${cmd}" was not found on this system — synthesis unavailable (install ${cmd} or pick another TTS provider)`,
      );
    }
    const invocation = systemTtsInvocation(this.platform, trimmed, {
      voice: opts.voice ?? this.defaultVoice,
      command: this.commandOverride,
    });
    const audio = await this.runner(invocation);
    if (!(audio instanceof Uint8Array) || audio.length === 0) {
      throw new Error(`system TTS: "${cmd}" produced no audio`);
    }
    return { audio, mimeType: invocation.mimeType };
  }
}
