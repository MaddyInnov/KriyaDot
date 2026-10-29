// SPDX-License-Identifier: Apache-2.0
// Vision input pipeline (§2.12 #128): image attachment metadata + the
// vision auto-upgrade routing decision.
//
// Two pieces:
//   1. parseImageMetadata(bytes) — dimensions + EXIF orientation parsed
//      by hand (no image codec in the tree): JPEG (SOF markers + APP1
//      Exif orientation), PNG (IHDR + eXIf chunk orientation), GIF and
//      WebP dimensions. Produces { format, width, height, orientation,
//      needsDownscale } for attachment metadata.
//   2. decideVisionRoute(...) — when an image is attached and the bot's
//      model is not vision-capable, route the turn to the bot's
//      configured vision fallback (modelOptions.visionModel) when set.
//
// HONEST LIMIT: there is no image codec (sharp/canvas) in the dependency
// tree and new deps are out of scope, so this pipeline does NOT rescale
// pixels. `needsDownscale` is reported as metadata for the UI/host; the
// bytes are passed through unchanged.

/** EXIF orientation values 1-8 (1 = normal). Undefined when absent. */
export interface ImageAttachmentMetadata {
  format: 'jpeg' | 'png' | 'gif' | 'webp' | 'unknown';
  width: number | null;
  height: number | null;
  /** EXIF orientation (1-8) when the file carries one. */
  orientation?: number;
  /** True when width or height exceeds MAX_IMAGE_DIMENSION. */
  needsDownscale: boolean;
}

export const MAX_IMAGE_DIMENSION = 4096;
export const MAX_IMAGE_BYTES_FOR_VISION = 20 * 1024 * 1024;

function u16be(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}
function u16le(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function u32be(b: Uint8Array, o: number): number {
  return b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
}
function u32le(b: Uint8Array, o: number): number {
  return b[o] + (b[o + 1] << 8) + (b[o + 2] << 16) + b[o + 3] * 0x1000000;
}

/** Read EXIF orientation (tag 0x0112) from a TIFF header at `tiffStart`. */
function exifOrientation(b: Uint8Array, tiffStart: number): number | undefined {
  try {
    if (tiffStart + 8 > b.length) return undefined;
    const le = b[tiffStart] === 0x49 && b[tiffStart + 1] === 0x49; // "II"
    const be = b[tiffStart] === 0x4d && b[tiffStart + 1] === 0x4d; // "MM"
    if (!le && !be) return undefined;
    const u16 = le ? u16le : u16be;
    const u32 = le ? u32le : u32be;
    if (u16(b, tiffStart + 2) !== 42) return undefined;
    const ifd0 = tiffStart + u32(b, tiffStart + 4);
    if (ifd0 + 2 > b.length) return undefined;
    const count = u16(b, ifd0);
    for (let i = 0; i < count; i++) {
      const entry = ifd0 + 2 + i * 12;
      if (entry + 12 > b.length) break;
      if (u16(b, entry) === 0x0112) {
        const value = u16(b, entry + 8);
        return value >= 1 && value <= 8 ? value : undefined;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function parseJpeg(b: Uint8Array): ImageAttachmentMetadata {
  let width: number | null = null;
  let height: number | null = null;
  let orientation: number | undefined;
  let o = 2; // skip SOI
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) break;
    const marker = b[o + 1];
    const len = u16be(b, o + 2);
    if (len < 2) break;
    // SOF0/SOF1/SOF2 carry dimensions.
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      height = u16be(b, o + 5);
      width = u16be(b, o + 7);
    }
    // APP1 with "Exif\0\0" header carries the TIFF block.
    if (
      marker === 0xe1 &&
      o + 10 <= b.length &&
      b[o + 4] === 0x45 && // E
      b[o + 5] === 0x78 && // x
      b[o + 6] === 0x69 && // i
      b[o + 7] === 0x66 // f
    ) {
      orientation = exifOrientation(b, o + 10);
    }
    if (marker === 0xda) break; // SOS: scan data follows
    o += 2 + len;
  }
  return finish('jpeg', width, height, orientation);
}

function parsePng(b: Uint8Array): ImageAttachmentMetadata {
  let width: number | null = null;
  let height: number | null = null;
  let orientation: number | undefined;
  let o = 8; // signature
  while (o + 12 <= b.length) {
    const len = u32be(b, o);
    const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    const dataStart = o + 8;
    if (dataStart + len > b.length + 4) break;
    if (type === 'IHDR' && len >= 8) {
      width = u32be(b, dataStart);
      height = u32be(b, dataStart + 4);
    } else if (type === 'eXIf') {
      // PNG eXIf chunk holds a raw TIFF header (no "Exif\0\0" prefix).
      orientation = exifOrientation(b, dataStart);
    }
    if (type === 'IEND') break;
    o = dataStart + len + 4; // data + CRC
  }
  return finish('png', width, height, orientation);
}

function finish(
  format: ImageAttachmentMetadata['format'],
  width: number | null,
  height: number | null,
  orientation?: number,
): ImageAttachmentMetadata {
  return {
    format,
    width,
    height,
    ...(orientation !== undefined ? { orientation } : {}),
    needsDownscale:
      (width !== null && width > MAX_IMAGE_DIMENSION) ||
      (height !== null && height > MAX_IMAGE_DIMENSION),
  };
}

/** Parse image dimensions + EXIF orientation from raw bytes. Never throws. */
export function parseImageMetadata(input: Uint8Array): ImageAttachmentMetadata {
  const b = input;
  try {
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xd8) return parseJpeg(b);
    if (
      b.length >= 8 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
    ) {
      return parsePng(b);
    }
    if (b.length >= 10 && String.fromCharCode(...b.subarray(0, 6)).startsWith('GIF8')) {
      return finish('gif', u16le(b, 6), u16le(b, 8));
    }
    if (
      b.length >= 30 &&
      String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' &&
      String.fromCharCode(...b.subarray(8, 12)) === 'WEBP'
    ) {
      const chunk = String.fromCharCode(...b.subarray(12, 16));
      if (chunk === 'VP8X') {
        const width = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
        const height = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
        return finish('webp', width, height);
      }
      if (chunk === 'VP8L') {
        const bits = u32le(b, 21);
        return finish('webp', 1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff));
      }
      if (chunk === 'VP8 ') {
        return finish('webp', u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
      }
      return finish('webp', null, null);
    }
    return finish('unknown', null, null);
  } catch {
    return finish('unknown', null, null);
  }
}

// ---------------------------------------------------------------------------
// Vision capability + routing decision
// ---------------------------------------------------------------------------

/**
 * Model-id fragments known to be vision-capable. The provider catalog
 * (providers/catalog.ts) carries no capability flags today, so this
 * heuristic list is the default; hosts with better data can inject
 * `capabilityFor` into decideVisionRoute.
 */
const VISION_MODEL_PATTERNS: RegExp[] = [
  /gpt-4o/,
  /gpt-4-turbo/,
  /gpt-5/,
  /claude-(3|4|opus|sonnet|haiku)/,
  /gemini/,
  /llama-3\.2.*vision/,
  /llama-4/,
  /qwen2?[-.]?vl/,
  /qwen3[-.]?vl/,
  /pixtral/,
  /llava/,
  /moondream/,
  /grok-4/,
  /grok-2-vision/,
  /vision/,
];

export function modelSupportsVision(provider: string, model: string): boolean {
  const id = `${provider}/${model}`.toLowerCase();
  return VISION_MODEL_PATTERNS.some((re) => re.test(id) || re.test(model.toLowerCase()));
}

export interface VisionRouteDecision {
  /** Effective provider/model for the turn. */
  provider: string;
  model: string;
  /** True when the turn was upgraded to the vision fallback model. */
  upgraded: boolean;
  reason: 'no-image' | 'primary-is-vision' | 'vision-fallback' | 'no-fallback-configured';
}

/**
 * Decide the effective model for a turn. Only upgrades when ALL hold:
 * the turn has an image attachment, the primary model is not
 * vision-capable, and modelOptions.visionModel is configured.
 * visionModel may be "model" (same provider) or "provider/model".
 */
export function decideVisionRoute(args: {
  hasImageAttachment: boolean;
  provider: string;
  model: string;
  visionModel?: string;
  /** Optional capability override (e.g. from catalog flags when they land). */
  capabilityFor?: (provider: string, model: string) => boolean;
}): VisionRouteDecision {
  const capable = args.capabilityFor ?? modelSupportsVision;
  if (!args.hasImageAttachment) {
    return { provider: args.provider, model: args.model, upgraded: false, reason: 'no-image' };
  }
  if (capable(args.provider, args.model)) {
    return { provider: args.provider, model: args.model, upgraded: false, reason: 'primary-is-vision' };
  }
  const fallback = args.visionModel?.trim();
  if (!fallback) {
    return { provider: args.provider, model: args.model, upgraded: false, reason: 'no-fallback-configured' };
  }
  const slash = fallback.indexOf('/');
  if (slash > 0) {
    return {
      provider: fallback.slice(0, slash),
      model: fallback.slice(slash + 1),
      upgraded: true,
      reason: 'vision-fallback',
    };
  }
  return { provider: args.provider, model: fallback, upgraded: true, reason: 'vision-fallback' };
}
