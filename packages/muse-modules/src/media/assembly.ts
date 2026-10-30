// SPDX-License-Identifier: Apache-2.0
// Multi-clip video assembly / stitching (Muse parity audit §4.9, M-5).
//
// An ffmpeg-based assembly service: N clips in → one normalized MP4 out.
// Each clip is first normalized (scale + pad to a common canvas, fixed
// fps, yuv420p, silent AAC track synthesized when the clip has no audio
// so concatenation never mixes stream layouts), then the normalized
// clips are joined with the concat demuxer and re-encoded once.
//
// The process seam is injectable (FfmpegRunner) so unit tests run with
// a recording fake; the integration test uses the real ffmpeg binary
// with tiny synthetic lavfi clips — no paid services, no downloads.
//
// Honest limits: transitions are hard cuts (crossfades across arbitrary
// clip lengths are a follow-up); output is always MP4/H.264 + AAC.

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { ValidationError } from '../errors.js';

export interface FfmpegRunResult {
  stdout: string;
  stderr: string;
}

/** Process seam: runs ffmpeg with an argv array (never a shell string). */
export type FfmpegRunner = (args: string[]) => Promise<FfmpegRunResult>;

/** Default runner: the ffmpeg binary on PATH via execFile (no shell). */
export const nodeFfmpegRunner: FfmpegRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`ffmpeg failed (${args[0] ?? ''} …): ${(stderr || err.message).slice(-500)}`));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

export interface AssemblyOptions {
  /** Output canvas. Default 1280×720. */
  width?: number;
  height?: number;
  /** Output frame rate. Default 30. */
  fps?: number;
  /** Video bitrate for the final encode, e.g. '4M'. Default '4M'. */
  videoBitrate?: string;
  /** Injectable runner (tests). Default nodeFfmpegRunner. */
  runner?: FfmpegRunner;
  /** Directory for intermediate normalized clips. Default: a fresh tmp dir (removed afterwards). */
  workDir?: string;
}

export interface AssemblyResult {
  outputPath: string;
  clipCount: number;
  width: number;
  height: number;
  fps: number;
}

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v']);

/** Validate the clip list: ≥2 clips, all plausible video file paths. */
export function validateClipList(clips: string[]): string[] {
  if (!Array.isArray(clips) || clips.length < 2) {
    throw new ValidationError('video assembly requires at least 2 clips');
  }
  if (clips.length > 64) {
    throw new ValidationError('video assembly supports at most 64 clips per job');
  }
  return clips.map((c) => {
    const p = (c ?? '').trim();
    if (!p) throw new ValidationError('video assembly clip paths must be non-empty strings');
    const ext = extname(p).toLowerCase();
    if (!VIDEO_EXTS.has(ext)) {
      throw new ValidationError(`video assembly clip must be one of: mp4, mov, mkv, webm, m4v (got "${ext}" for ${basename(p)})`);
    }
    return p;
  });
}

/** Escape one path for an ffmpeg concat-demuxer list file. */
export function escapeConcatPath(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** Build the concat-demuxer list file content for normalized clips. */
export function buildConcatListContent(paths: string[]): string {
  return paths.map((p) => `file ${escapeConcatPath(p)}`).join('\n') + '\n';
}

/** ffmpeg argv that normalizes one clip to the common canvas/layout. */
export function buildNormalizeArgs(
  input: string,
  output: string,
  opts: Required<Pick<AssemblyOptions, 'width' | 'height' | 'fps'>>,
  withSourceAudio = true,
): string[] {
  const { width, height, fps } = opts;
  const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`;
  if (withSourceAudio) {
    return [
      '-y',
      '-i', input,
      '-filter_complex', `[0:v]${vf}[v];[0:a]aresample=44100,apad[a]`,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'veryfast',
      '-c:a', 'aac', '-shortest',
      output,
    ];
  }
  // No source audio: synthesize a silent stereo track so every
  // normalized clip still has the same stream layout for concat.
  return [
    '-y',
    '-i', input,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-filter_complex', `[0:v]${vf}[v]`,
    '-map', '[v]', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'veryfast',
    '-c:a', 'aac', '-shortest',
    output,
  ];
}

/** Normalize one clip, retrying with a silent track when it has no audio stream. */
async function normalizeClip(
  runner: FfmpegRunner,
  input: string,
  output: string,
  dims: Required<Pick<AssemblyOptions, 'width' | 'height' | 'fps'>>,
): Promise<void> {
  try {
    await runner(buildNormalizeArgs(input, output, dims, true));
  } catch {
    await runner(buildNormalizeArgs(input, output, dims, false));
  }
}

/** ffmpeg argv for the final concat + encode step. */
export function buildConcatArgs(listPath: string, outputPath: string, videoBitrate: string): string[] {
  return [
    '-y',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', videoBitrate,
    '-c:a', 'aac',
    '-movflags', '+faststart',
    outputPath,
  ];
}

/**
 * Assemble `clips` into one MP4 at `outputPath`, in the given order
 * (clip order is significant — the caller sequences the story).
 * Intermediate files go to a temp work dir and are removed afterwards.
 */
export async function assembleClips(clips: string[], outputPath: string, opts: AssemblyOptions = {}): Promise<AssemblyResult> {
  const ordered = validateClipList(clips);
  const out = (outputPath ?? '').trim();
  if (!out || extname(out).toLowerCase() !== '.mp4') {
    throw new ValidationError('video assembly "outputPath" must be a non-empty .mp4 path');
  }
  const width = opts.width ?? 1280;
  const height = opts.height ?? 720;
  const fps = opts.fps ?? 30;
  if (!Number.isInteger(width) || width < 16 || width > 7680 || !Number.isInteger(height) || height < 16 || height > 4320) {
    throw new ValidationError('video assembly width/height must be integers within 16..7680 × 16..4320');
  }
  if (!Number.isInteger(fps) || fps < 1 || fps > 240) {
    throw new ValidationError('video assembly "fps" must be an integer 1..240');
  }
  const runner = opts.runner ?? nodeFfmpegRunner;
  const ownWorkDir = opts.workDir === undefined;
  const workDir = opts.workDir ?? (await mkdtemp(join(tmpdir(), 'kriyadot-assembly-')));
  try {
    const normalized: string[] = [];
    for (let i = 0; i < ordered.length; i++) {
      const target = join(workDir, `clip-${String(i).padStart(3, '0')}.mp4`);
      await normalizeClip(runner, ordered[i], target, { width, height, fps });
      normalized.push(target);
    }
    const listPath = join(workDir, 'concat.txt');
    await writeFile(listPath, buildConcatListContent(normalized), 'utf8');
    await runner(buildConcatArgs(listPath, out, opts.videoBitrate ?? '4M'));
    return { outputPath: out, clipCount: ordered.length, width, height, fps };
  } finally {
    if (ownWorkDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
