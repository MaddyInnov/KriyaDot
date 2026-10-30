// SPDX-License-Identifier: Apache-2.0
// FL-10 — Intake completion: zip unpacking + HEIC/AVIF handling.
//
// Zip: archives uploaded as chat attachments / workspace drops can be
// listed and extracted into the workspace. Extraction is defensive:
//   - entry paths are normalized and confined (absolute paths, drive
//     letters, backslash tricks and `..` segments are rejected outright;
//     the final write path still goes through confineFile, so symlink
//     escapes are caught too);
//   - caps: ≤500 entries, ≤20MB per file, ≤100MB total uncompressed,
//     ≤50MB compressed input. Anything over a cap aborts the whole
//     extraction (no partial unpack masquerading as success).
// Uses fflate (already a dependency of @mvp/api) — no new deps.
//
// HEIC/AVIF: there is NO suitable decoder in the repo's dependency tree
// (no sharp, no ImageMagick bindings; @napi-rs/canvas is present only as
// a transitive dependency and its image decoder does not support HEIC or
// AVIF). Per the build rules no heavy native dependency was added.
// Instead intake DETECTS these containers from their ISOBMFF `ftyp`
// brands and fails with a clear, actionable UnsupportedImageFormatError.
// JPEG/PNG/GIF/WebP pass through unchanged; a real conversion hook
// (tryCanvasConvert) is attempted only when a decoder is available and
// reports success, so wiring sharp later upgrades this path in place.

import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { unzipSync } from 'fflate';
import { confineFile } from './files.js';

export const MAX_ZIP_COMPRESSED_BYTES = 50 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 500;
export const MAX_ZIP_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_ZIP_TOTAL_BYTES = 100 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Zip
// ---------------------------------------------------------------------------

export interface ZipEntryInfo {
  name: string;
  size: number;
  isDir: boolean;
}

export class UnsafeZipEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeZipEntryError';
  }
}

/** Normalize a zip entry name to a safe workspace-relative posix path, or throw. */
export function sanitizeZipEntryName(raw: string): string {
  if (typeof raw !== 'string' || !raw) throw new UnsafeZipEntryError('zip entry with an empty name');
  // Zip entries use '/', but hostile archives smuggle '\' — treat it as a separator too.
  const normalized = raw.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')) {
    throw new UnsafeZipEntryError(`zip entry uses an absolute path: "${raw}"`);
  }
  const parts = normalized.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length === 0) throw new UnsafeZipEntryError(`zip entry has no usable path: "${raw}"`);
  if (parts.some((p) => p === '..')) {
    throw new UnsafeZipEntryError(`zip entry escapes the target directory: "${raw}"`);
  }
  if (parts.some((p) => p.includes('\0'))) {
    throw new UnsafeZipEntryError(`zip entry contains a NUL byte: "${raw}"`);
  }
  return parts.join('/');
}

export function listZipEntries(data: Uint8Array): ZipEntryInfo[] {
  if (data.byteLength > MAX_ZIP_COMPRESSED_BYTES) {
    throw new Error(`zip archive exceeds the ${MAX_ZIP_COMPRESSED_BYTES / 1024 / 1024}MB intake cap`);
  }
  const files = unzipSync(data);
  return Object.entries(files).map(([name, bytes]) => ({
    name,
    size: bytes.byteLength,
    isDir: name.endsWith('/'),
  }));
}

export interface ZipExtractResult {
  extracted: string[];
  skipped: string[];
  totalBytes: number;
}

/**
 * Extract a zip archive into `workspaceRoot` (optionally under `subdir`).
 * All-or-nothing on cap/traversal violations: validation of every entry
 * happens before the first byte is written.
 */
export function extractZipToWorkspace(
  data: Uint8Array,
  workspaceRoot: string,
  opts: { subdir?: string } = {},
): ZipExtractResult {
  if (data.byteLength > MAX_ZIP_COMPRESSED_BYTES) {
    throw new Error(`zip archive exceeds the ${MAX_ZIP_COMPRESSED_BYTES / 1024 / 1024}MB intake cap`);
  }
  const files = unzipSync(data);
  const names = Object.keys(files);
  if (names.length > MAX_ZIP_ENTRIES) {
    throw new Error(`zip archive has ${names.length} entries (cap ${MAX_ZIP_ENTRIES})`);
  }
  const subdir = opts.subdir ? sanitizeZipEntryName(opts.subdir) : '';
  // Pass 1: validate everything before writing anything.
  const plan: Array<{ rel: string; bytes: Uint8Array }> = [];
  const skipped: string[] = [];
  let total = 0;
  for (const name of names) {
    if (name.endsWith('/')) continue; // directory entry
    const safe = sanitizeZipEntryName(name); // throws on traversal
    const bytes = files[name];
    if (bytes.byteLength > MAX_ZIP_FILE_BYTES) {
      throw new Error(`zip entry "${name}" exceeds the ${MAX_ZIP_FILE_BYTES / 1024 / 1024}MB per-file cap`);
    }
    total += bytes.byteLength;
    if (total > MAX_ZIP_TOTAL_BYTES) {
      throw new Error(`zip archive exceeds the ${MAX_ZIP_TOTAL_BYTES / 1024 / 1024}MB total uncompressed cap`);
    }
    const rel = subdir ? `${subdir}/${safe}` : safe;
    // Confinement check now (symlink-aware) so a hostile workspace layout
    // fails the whole extraction, not half of it.
    confineFile(workspaceRoot, rel);
    plan.push({ rel, bytes });
  }
  // Pass 2: write.
  const extracted: string[] = [];
  for (const { rel, bytes } of plan) {
    const abs = confineFile(workspaceRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
    extracted.push(rel);
  }
  return { extracted, skipped, totalBytes: total };
}

export function isZipArchive(data: Uint8Array): boolean {
  return data.byteLength >= 4 && data[0] === 0x50 && data[1] === 0x4b && (data[2] === 0x03 || data[2] === 0x05 || data[2] === 0x07);
}

// ---------------------------------------------------------------------------
// HEIC / AVIF detection + intake decision
// ---------------------------------------------------------------------------

export type ImageContainerFormat = 'heic' | 'avif' | 'jpeg' | 'png' | 'gif' | 'webp' | 'unknown';

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'mif2', 'msf1']);
const AVIF_BRANDS = new Set(['avif', 'avis', 'avci']);

/** Sniff an image container from magic bytes (ISOBMFF ftyp brands for HEIC/AVIF). */
export function detectImageContainer(data: Uint8Array): ImageContainerFormat {
  if (data.byteLength >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  if (
    data.byteLength >= 8 &&
    data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
    data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a
  ) {
    return 'png';
  }
  if (data.byteLength >= 6) {
    const sig = String.fromCharCode(data[0], data[1], data[2], data[3], data[4], data[5]);
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'gif';
  }
  if (
    data.byteLength >= 12 &&
    String.fromCharCode(data[0], data[1], data[2], data[3]) === 'RIFF' &&
    String.fromCharCode(data[8], data[9], data[10], data[11]) === 'WEBP'
  ) {
    return 'webp';
  }
  // ISOBMFF: bytes 4..8 are 'ftyp', bytes 8..12 are the major brand.
  if (data.byteLength >= 12 && String.fromCharCode(data[4], data[5], data[6], data[7]) === 'ftyp') {
    const brand = String.fromCharCode(data[8], data[9], data[10], data[11]).trim().toLowerCase();
    if (HEIC_BRANDS.has(brand)) return 'heic';
    if (AVIF_BRANDS.has(brand)) return 'avif';
  }
  return 'unknown';
}

export class UnsupportedImageFormatError extends Error {
  readonly format: ImageContainerFormat;
  constructor(format: ImageContainerFormat) {
    super(
      `${format.toUpperCase()} images are not supported by this build: no HEIC/AVIF decoder is available ` +
        '(sharp/ImageMagick are not installed). Convert the image to PNG or JPEG first — on iPhone: ' +
        'Settings → Camera → Formats → "Most Compatible", or share/export the photo as JPEG — then upload again.',
    );
    this.name = 'UnsupportedImageFormatError';
    this.format = format;
    (this as Error & { code?: string }).code = 'UNSUPPORTED_IMAGE_FORMAT';
  }
}

export function isUnsupportedImageFormatError(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === 'UNSUPPORTED_IMAGE_FORMAT';
}

export interface ImageIntakeResult {
  format: ImageContainerFormat;
  /** Output bytes (converted when a decoder managed it, else the original bytes). */
  data: Uint8Array;
  /** True when the bytes were re-encoded (HEIC/AVIF → PNG) by an available decoder. */
  converted: boolean;
  outputFormat?: 'png' | 'jpeg';
}

/**
 * Optional real conversion via @napi-rs/canvas when it happens to be in
 * the tree AND can decode the input. Returns null when unavailable or the
 * format is undecodable (the HEIC/AVIF case today) — never throws.
 */
let canvasModulePromise: Promise<unknown> | null = null;
/**
 * Process-level verdict on whether the opportunistic decoder can handle
 * HEIC/AVIF at all. One failed/timed-out decode settles it for the process:
 * the decoder in this tree cannot read these formats, so later uploads
 * fail fast with guidance instead of re-probing a hanging decoder.
 */
let canvasHeicAvifCapable: boolean | null = null;

async function tryCanvasConvert(data: Uint8Array): Promise<ImageIntakeResult | null> {
  try {
    // Dynamic import: canvas is a transitive dep, not a declared one, so a
    // static import would break installs where it is pruned. The probe is
    // time-boxed: a decoder that hangs on a malformed file must not wedge
    // intake — timing out is treated as "no decoder available".
    canvasModulePromise ??= import('@napi-rs/canvas');
    const canvas = (await Promise.race([
      canvasModulePromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('canvas probe timeout')), 3000).unref?.()),
    ])) as unknown as {
      loadImage?: (buf: Buffer) => Promise<{ width: number; height: number }>;
      createCanvas?: (w: number, h: number) => {
        getContext: (kind: '2d') => { drawImage: (img: unknown, x: number, y: number) => void };
        encode: (kind: 'png') => Promise<Buffer>;
      };
    };
    if (!canvas.loadImage || !canvas.createCanvas) return null;
    const img = await Promise.race([
      canvas.loadImage(Buffer.from(data)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('canvas decode timeout')), 3000).unref?.()),
    ]);
    if (!img || !img.width || !img.height) return null;
    const surface = canvas.createCanvas(img.width, img.height);
    const ctx = surface.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const png = await surface.encode('png');
    return { format: detectImageContainer(data), data: new Uint8Array(png), converted: true, outputFormat: 'png' };
  } catch {
    return null;
  }
}

/**
 * Intake decision for one image upload. Supported containers pass through;
 * HEIC/AVIF attempt conversion and otherwise throw
 * UnsupportedImageFormatError with user-facing guidance.
 */
export async function intakeImage(data: Uint8Array, fileName = ''): Promise<ImageIntakeResult> {
  const format = detectImageContainer(data);
  const byExt = /\.hei[cf]$/i.test(fileName) ? 'heic' : /\.avif$/i.test(fileName) ? 'avif' : format;
  const effective = format === 'unknown' ? byExt : format;
  if (effective === 'heic' || effective === 'avif') {
    if (canvasHeicAvifCapable !== false) {
      const converted = await tryCanvasConvert(data);
      if (converted) {
        canvasHeicAvifCapable = true;
        return { ...converted, format: effective };
      }
      canvasHeicAvifCapable = false;
    }
    throw new UnsupportedImageFormatError(effective);
  }
  return { format: effective, data, converted: false };
}

// ---------------------------------------------------------------------------
// Routes — mount on a router at /api/files (paths are /intake…)
// ---------------------------------------------------------------------------

export interface FileIntakeDeps {
  workspaceRoot: string | (() => string);
}

export function registerFileIntakeRoutes(router: Router, deps: FileIntakeDeps): void {
  const root = (): string => (typeof deps.workspaceRoot === 'function' ? deps.workspaceRoot() : deps.workspaceRoot);

  // List a zip's entries without extracting. Body: { data: base64 }.
  router.post('/intake/zip/list', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { data?: unknown };
      if (typeof body.data !== 'string' || !body.data) {
        res.status(400).json({ error: '"data" (base64 zip) is required' });
        return;
      }
      const data = new Uint8Array(Buffer.from(body.data, 'base64'));
      if (!isZipArchive(data)) {
        res.status(400).json({ error: 'payload is not a zip archive' });
        return;
      }
      res.json({ ok: true, entries: listZipEntries(data) });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'failed to list zip';
      res.status(err instanceof UnsafeZipEntryError ? 400 : 400).json({ error: message });
    }
  });

  // Extract a zip into the workspace. Body: { data: base64, subdir? }.
  router.post('/intake/zip/extract', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { data?: unknown; subdir?: unknown };
      if (typeof body.data !== 'string' || !body.data) {
        res.status(400).json({ error: '"data" (base64 zip) is required' });
        return;
      }
      const data = new Uint8Array(Buffer.from(body.data, 'base64'));
      if (!isZipArchive(data)) {
        res.status(400).json({ error: 'payload is not a zip archive' });
        return;
      }
      const result = extractZipToWorkspace(data, root(), {
        subdir: typeof body.subdir === 'string' ? body.subdir : undefined,
      });
      res.status(201).json({ ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'failed to extract zip';
      res.status(err instanceof UnsafeZipEntryError || /escapes/.test(message) ? 400 : 400).json({ error: message });
    }
  });

  // Image intake check: reports the detected format, converts HEIC/AVIF
  // when a decoder exists, else 415 with conversion guidance.
  router.post('/intake/image', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { data?: unknown; name?: unknown };
      if (typeof body.data !== 'string' || !body.data) {
        res.status(400).json({ error: '"data" (base64 image) is required' });
        return;
      }
      const data = new Uint8Array(Buffer.from(body.data, 'base64'));
      const result = await intakeImage(data, typeof body.name === 'string' ? body.name : '');
      res.json({
        ok: true,
        format: result.format,
        converted: result.converted,
        outputFormat: result.outputFormat,
        size: result.data.byteLength,
        data: result.converted ? Buffer.from(result.data).toString('base64') : undefined,
      });
    } catch (err) {
      if (isUnsupportedImageFormatError(err)) {
        res.status(415).json({ error: err instanceof Error ? err.message : 'unsupported image format' });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : 'failed image intake' });
    }
  });
}
