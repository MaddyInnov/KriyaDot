// SPDX-License-Identifier: Apache-2.0
// M-5 assembly tests: pure/unit coverage with a recording fake runner,
// plus one integration test against the real ffmpeg binary using tiny
// synthetic lavfi clips (generated locally, a fraction of a second
// each — no downloads, no paid services).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ValidationError } from '../errors.js';
import {
  assembleClips,
  validateClipList,
  buildConcatListContent,
  escapeConcatPath,
  buildNormalizeArgs,
  buildConcatArgs,
  nodeFfmpegRunner,
  type FfmpegRunner,
} from './assembly.js';

describe('assembly planning (unit, fake runner)', () => {
  it('validates the clip list: at least 2 clips, video extensions only', () => {
    expect(validateClipList(['a.mp4', 'b.webm'])).toEqual(['a.mp4', 'b.webm']);
    expect(() => validateClipList(['only.mp4'])).toThrow(ValidationError);
    expect(() => validateClipList(['a.mp4', 'notes.txt'])).toThrow(ValidationError);
    expect(() => validateClipList(['a.mp4', '  '])).toThrow(ValidationError);
  });

  it('escapes concat-list paths safely', () => {
    expect(escapeConcatPath('/tmp/plain.mp4')).toBe("'/tmp/plain.mp4'");
    expect(escapeConcatPath("/tmp/it's.mp4")).toBe("'/tmp/it'\\''s.mp4'");
    expect(buildConcatListContent(['/a.mp4', '/b.mp4'])).toBe("file '/a.mp4'\nfile '/b.mp4'\n");
  });

  it('normalize args pin canvas, fps, pixel format; concat args re-encode to mp4', () => {
    const args = buildNormalizeArgs('in.mov', 'out.mp4', { width: 640, height: 360, fps: 24 });
    const joined = args.join(' ');
    expect(joined).toContain('scale=640:360');
    expect(joined).toContain('fps=24');
    expect(joined).toContain('format=yuv420p');
    expect(joined).toContain('libx264');
    const silent = buildNormalizeArgs('in.mov', 'out.mp4', { width: 640, height: 360, fps: 24 }, false);
    expect(silent.join(' ')).toContain('anullsrc');
    const concat = buildConcatArgs('list.txt', 'final.mp4', '4M');
    expect(concat).toContain('concat');
    expect(concat[concat.length - 1]).toBe('final.mp4');
  });

  it('assembleClips drives normalize × N then one concat, honoring clip order', async () => {
    const calls: string[][] = [];
    const fake: FfmpegRunner = async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '' };
    };
    const workDir = await mkdtemp(join(tmpdir(), 'assembly-unit-'));
    try {
      const result = await assembleClips(['/v/first.mp4', '/v/second.mp4', '/v/third.mp4'], '/v/final.mp4', {
        runner: fake,
        workDir,
        width: 320,
        height: 240,
        fps: 15,
      });
      expect(result).toMatchObject({ outputPath: '/v/final.mp4', clipCount: 3, width: 320, height: 240, fps: 15 });
      // 3 normalize runs (audio attempt succeeds on the fake) + 1 concat.
      expect(calls).toHaveLength(4);
      expect(calls[0]).toContain('/v/first.mp4');
      expect(calls[1]).toContain('/v/second.mp4');
      expect(calls[2]).toContain('/v/third.mp4');
      expect(calls[3]).toContain('concat');
      expect(calls[3][calls[3].length - 1]).toBe('/v/final.mp4');
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('rejects a non-mp4 output path and bad dimensions before running ffmpeg', async () => {
    const fake: FfmpegRunner = async () => ({ stdout: '', stderr: '' });
    await expect(assembleClips(['a.mp4', 'b.mp4'], 'out.webm', { runner: fake })).rejects.toThrow(ValidationError);
    await expect(assembleClips(['a.mp4', 'b.mp4'], 'out.mp4', { runner: fake, width: 4 })).rejects.toThrow(ValidationError);
    await expect(assembleClips(['a.mp4'], 'out.mp4', { runner: fake })).rejects.toThrow(ValidationError);
  });
});

function ffprobeDuration(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
      (err, stdout) => (err ? reject(err) : resolve(Number.parseFloat(String(stdout).trim()))),
    );
  });
}

function hasFfmpeg(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-version'], (err) => resolve(!err));
  });
}

describe('assembly integration (real ffmpeg, synthetic clips)', () => {
  let dir = '';
  let ffmpegAvailable = false;

  beforeAll(async () => {
    ffmpegAvailable = await hasFfmpeg();
    if (!ffmpegAvailable) return;
    dir = await mkdtemp(join(tmpdir(), 'assembly-it-'));
    // Two tiny synthetic clips with DIFFERENT sizes/fps and no audio —
    // assembly must normalize them onto one canvas and add silent audio.
    await nodeFfmpegRunner(['-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x48:r=10:d=0.4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'a.mp4')]);
    await nodeFfmpegRunner(['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=48x64:r=20:d=0.4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'b.mp4')]);
  }, 60_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('stitches two generated clips into one playable mp4 of summed duration', async () => {
    if (!ffmpegAvailable) return; // environment without ffmpeg: unit coverage above still applies
    const out = join(dir, 'joined.mp4');
    const result = await assembleClips([join(dir, 'a.mp4'), join(dir, 'b.mp4')], out, { width: 64, height: 64, fps: 10 });
    expect(result.clipCount).toBe(2);
    const info = await stat(out);
    expect(info.size).toBeGreaterThan(1000);
    const duration = await ffprobeDuration(out);
    expect(duration).toBeGreaterThan(0.6); // ~0.4 + ~0.4, allowing encoder padding
    expect(duration).toBeLessThan(1.6);
  }, 60_000);
});
