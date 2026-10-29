// SPDX-License-Identifier: Apache-2.0
// Vision input pipeline (§2.12 #128): hand-rolled JPEG/PNG dimension +
// EXIF orientation parsing and the vision-fallback routing decision.
// Fixtures are constructed byte-by-byte — no image codec involved.

import { describe, expect, it } from 'vitest';
import {
  decideVisionRoute,
  modelSupportsVision,
  parseImageMetadata,
} from '../src/vision-pipeline.js';

/** Minimal JPEG: SOI, APP1 Exif (orientation), SOF0 (dims), SOS. */
function jpegBytes(width: number, height: number, orientation?: number): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  if (orientation !== undefined) {
    // APP1: len, "Exif\0\0", TIFF LE header, IFD0 with one entry (0x0112).
    const tiff: number[] = [
      0x49, 0x49, 42, 0, 8, 0, 0, 0, // II, 42, IFD0 offset 8
      1, 0, // one entry
      0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, // tag, SHORT, count 1, value
      0, 0, 0, 0, // next IFD
    ];
    const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const len = app1.length + 2;
    parts.push(0xff, 0xe1, (len >> 8) & 0xff, len & 0xff, ...app1);
  }
  // SOF0: len 17, precision 8, height, width, components...
  parts.push(
    0xff, 0xc0, 0, 17, 8,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
  );
  parts.push(0xff, 0xda);
  return new Uint8Array(parts);
}

/** Minimal PNG: signature, IHDR, optional eXIf chunk, IEND. */
function pngBytes(width: number, height: number, orientation?: number): Uint8Array {
  const out: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const chunk = (type: string, data: number[]): void => {
    out.push((data.length >> 24) & 0xff, (data.length >> 16) & 0xff, (data.length >> 8) & 0xff, data.length & 0xff);
    for (const c of type) out.push(c.charCodeAt(0));
    out.push(...data, 0, 0, 0, 0); // CRC ignored by the parser
  };
  chunk('IHDR', [
    (width >> 24) & 0xff, (width >> 16) & 0xff, (width >> 8) & 0xff, width & 0xff,
    (height >> 24) & 0xff, (height >> 16) & 0xff, (height >> 8) & 0xff, height & 0xff,
    8, 2, 0, 0, 0,
  ]);
  if (orientation !== undefined) {
    chunk('eXIf', [
      0x49, 0x49, 42, 0, 8, 0, 0, 0,
      1, 0,
      0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0,
      0, 0, 0, 0,
    ]);
  }
  chunk('IEND', []);
  return new Uint8Array(out);
}

describe('parseImageMetadata', () => {
  it('parses JPEG dimensions and EXIF orientation', () => {
    const meta = parseImageMetadata(jpegBytes(4032, 3024, 6));
    expect(meta).toMatchObject({ format: 'jpeg', width: 4032, height: 3024, orientation: 6 });
    expect(meta.needsDownscale).toBe(false);
  });

  it('flags oversized images as needing downscale', () => {
    expect(parseImageMetadata(jpegBytes(8000, 100)).needsDownscale).toBe(true);
  });

  it('parses PNG dimensions and eXIf orientation', () => {
    const meta = parseImageMetadata(pngBytes(640, 480, 3));
    expect(meta).toMatchObject({ format: 'png', width: 640, height: 480, orientation: 3 });
  });

  it('handles PNG/JPEG without EXIF and garbage input', () => {
    expect(parseImageMetadata(pngBytes(10, 10)).orientation).toBeUndefined();
    expect(parseImageMetadata(jpegBytes(10, 10)).orientation).toBeUndefined();
    expect(parseImageMetadata(new Uint8Array([1, 2, 3]))).toMatchObject({
      format: 'unknown',
      width: null,
      height: null,
    });
  });
});

describe('vision routing', () => {
  it('recognizes common vision models', () => {
    expect(modelSupportsVision('openai', 'gpt-4o')).toBe(true);
    expect(modelSupportsVision('anthropic', 'claude-sonnet-4-5')).toBe(true);
    expect(modelSupportsVision('groq', 'llama-3.3-70b-versatile')).toBe(false);
  });

  it('no image → primary unchanged', () => {
    expect(
      decideVisionRoute({ hasImageAttachment: false, provider: 'groq', model: 'llama-3.3-70b-versatile', visionModel: 'gpt-4o' }),
    ).toMatchObject({ upgraded: false, reason: 'no-image', model: 'llama-3.3-70b-versatile' });
  });

  it('image + vision primary → unchanged', () => {
    expect(
      decideVisionRoute({ hasImageAttachment: true, provider: 'openai', model: 'gpt-4o', visionModel: 'x' }),
    ).toMatchObject({ upgraded: false, reason: 'primary-is-vision' });
  });

  it('image + non-vision primary + fallback → upgraded (same provider)', () => {
    expect(
      decideVisionRoute({
        hasImageAttachment: true,
        provider: 'groq',
        model: 'llama-3.3-70b-versatile',
        visionModel: 'llama-3.2-90b-vision-preview',
      }),
    ).toEqual({
      provider: 'groq',
      model: 'llama-3.2-90b-vision-preview',
      upgraded: true,
      reason: 'vision-fallback',
    });
  });

  it('fallback may name another provider as provider/model', () => {
    expect(
      decideVisionRoute({
        hasImageAttachment: true,
        provider: 'groq',
        model: 'llama-3.3-70b-versatile',
        visionModel: 'openai/gpt-4o',
      }),
    ).toMatchObject({ provider: 'openai', model: 'gpt-4o', upgraded: true });
  });

  it('image + non-vision primary + no fallback → unchanged with honest reason', () => {
    expect(
      decideVisionRoute({ hasImageAttachment: true, provider: 'groq', model: 'llama-3.3-70b-versatile' }),
    ).toMatchObject({ upgraded: false, reason: 'no-fallback-configured' });
  });

  it('an injected capability resolver wins over the heuristic list', () => {
    const decision = decideVisionRoute({
      hasImageAttachment: true,
      provider: 'custom',
      model: 'my-model',
      visionModel: 'other-vision',
      capabilityFor: () => true,
    });
    expect(decision.upgraded).toBe(false);
  });
});
