// SPDX-License-Identifier: Apache-2.0
// Image edit flow + profile-photo person insertion (Muse parity
// audit §4.9, M-2).
//
// Builds on the existing image generation machinery (./openai-images.ts):
// the edit side uses the sibling OpenAI-compatible edits endpoint:
//
//   POST {baseUrl}/images/edits   (multipart: image, mask?, prompt, model)
//     → { "data": [ { "url": "https://…" } | { "b64_json": "…" } ] }
//
// Person insertion ("put me in this picture") is an edit whose primary
// input is the user's stored profile reference photo. Standing rule for
// that photo: its bytes MUST be verified as a real image (magic-byte
// sniff, declared-type agreement, size cap) before they are used as an
// identity reference — a path/extension claim is never trusted.
//
// Config (env only): reuses the images provider's env vars —
//   MEDIA_IMAGES_API_KEY (required for the real editor),
//   MEDIA_IMAGES_BASE_URL, MEDIA_IMAGES_MODEL.
// Without the key, resolveImageEditor() returns the deterministic mock:
// the flow works end to end offline and says so via provider 'mock-edit'.
//
// Zero paid usage in tests: fake multipart fetch only.

import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ValidationError } from '../errors.js';
import type { MediaAsset } from './index.js';
import {
  MEDIA_IMAGES_API_KEY_ENV,
  MEDIA_IMAGES_BASE_URL_ENV,
  MEDIA_IMAGES_MODEL_ENV,
  DEFAULT_IMAGES_BASE_URL,
  DEFAULT_IMAGES_MODEL,
} from './openai-images.js';

// ---------------------------------------------------------------------------
// Image byte verification (shared by the profile-photo rule and M-3)
// ---------------------------------------------------------------------------

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'gif';

export interface VerifiedImage {
  format: ImageFormat;
  mimeType: string;
  byteLength: number;
}

const FORMAT_MIME: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** Profile reference photos are capped at 10 MiB — plenty for a headshot. */
export const MAX_PROFILE_PHOTO_BYTES = 10 * 1024 * 1024;
/** General image-input cap for edit/matching flows. */
export const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;

/** Sniff an image format from magic bytes; undefined when unrecognized. */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // RIFF
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // WEBP
  ) {
    return 'webp';
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && // GIF8
    (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) {
    return 'gif';
  }
  return undefined;
}

/**
 * Verify that `bytes` really are an image: non-empty, under `maxBytes`,
 * magic bytes sniff to a known format, and — when a MIME type is
 * declared — it agrees with the sniffed format. Throws ValidationError
 * with the specific reason otherwise. This is the gate every identity
 * reference and photo input must pass before use.
 */
export function verifyImageBytes(
  bytes: Uint8Array,
  opts: { declaredMimeType?: string; maxBytes?: number; label?: string } = {},
): VerifiedImage {
  const label = opts.label ?? 'image';
  const maxBytes = opts.maxBytes ?? MAX_IMAGE_INPUT_BYTES;
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new ValidationError(`${label}: bytes are empty or not a Uint8Array`);
  }
  if (bytes.length > maxBytes) {
    throw new ValidationError(`${label}: ${(bytes.length / 1024 / 1024).toFixed(1)} MiB exceeds the ${(maxBytes / 1024 / 1024).toFixed(0)} MiB limit`);
  }
  const format = sniffImageFormat(bytes);
  if (!format) {
    throw new ValidationError(`${label}: bytes do not match any known image signature (png/jpeg/webp/gif)`);
  }
  const mimeType = FORMAT_MIME[format];
  if (opts.declaredMimeType && opts.declaredMimeType.toLowerCase() !== mimeType) {
    throw new ValidationError(
      `${label}: declared type "${opts.declaredMimeType}" does not match the actual bytes (${mimeType})`,
    );
  }
  return { format, mimeType, byteLength: bytes.length };
}

/**
 * Verify a profile reference photo under the stricter profile rules
 * (10 MiB cap). Use this — not the general verifier — for any bytes
 * that will act as the user's identity reference.
 */
export function verifyProfilePhoto(bytes: Uint8Array, declaredMimeType?: string): VerifiedImage {
  return verifyImageBytes(bytes, { declaredMimeType, maxBytes: MAX_PROFILE_PHOTO_BYTES, label: 'profile photo' });
}

/** Read a profile photo from disk and verify its bytes before use. */
export async function readVerifiedProfilePhoto(path: string): Promise<{ bytes: Buffer; verified: VerifiedImage }> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (err) {
    throw new ValidationError(`profile photo could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { bytes, verified: verifyProfilePhoto(bytes) };
}

// ---------------------------------------------------------------------------
// Image editor providers
// ---------------------------------------------------------------------------

export interface ImageEditRequest {
  /** Source image bytes (verified inside the flow before any provider call). */
  image: Uint8Array;
  prompt: string;
  /** Optional mask bytes (PNG with transparency marking the edit region). */
  mask?: Uint8Array;
}

export interface PersonInsertionRequest {
  /** The scene to place the person into: a prompt describing a new scene … */
  scenePrompt?: string;
  /** … or an existing scene image to edit. Exactly one of the two. */
  sceneImage?: Uint8Array;
  /** The user's profile reference photo bytes (verified before use). */
  profilePhoto: Uint8Array;
  /** Extra direction, e.g. "standing on the left, festival clothing". */
  prompt?: string;
}

export interface ImageEditor {
  readonly name: string;
  editImage(req: ImageEditRequest): Promise<MediaAsset>;
  insertPerson(req: PersonInsertionRequest): Promise<MediaAsset>;
}

function validateEditPrompt(prompt: string): string {
  const p = (prompt ?? '').trim();
  if (!p) throw new ValidationError('image edit "prompt" must be a non-empty string');
  if (p.length > 2000) throw new ValidationError('image edit "prompt" must be at most 2000 characters');
  return p;
}

/** Multipart fetch shape: like fetch, but the body may be FormData. */
export type ImageEditFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: FormData },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export interface OpenAIImageEditProviderOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetchFn?: ImageEditFetch;
  name?: string;
}

const EXT_FOR: Record<ImageFormat, string> = { png: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif' };

/**
 * Real editor over the OpenAI-compatible images/edits endpoint.
 * Person insertion sends the profile photo as the primary image input
 * (identity reference) plus the scene image when one is supplied, with
 * a composed prompt; providers without multi-image support still get a
 * well-formed single-image edit driven by the identity reference.
 */
export class OpenAIImageEditProvider implements ImageEditor {
  readonly name: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchFn: ImageEditFetch;

  constructor(opts: OpenAIImageEditProviderOptions) {
    if (!opts.apiKey || !opts.apiKey.trim()) {
      throw new ValidationError('OpenAIImageEditProvider requires a non-empty apiKey');
    }
    this.apiKey = opts.apiKey.trim();
    this.baseUrl = (opts.baseUrl ?? DEFAULT_IMAGES_BASE_URL).replace(/\/+$/, '');
    this.model = opts.model ?? DEFAULT_IMAGES_MODEL;
    this.name = opts.name ?? 'openai-image-edit';
    this.fetchFn =
      opts.fetchFn ??
      ((async (url: string, init: { method: string; headers: Record<string, string>; body: FormData }) => {
        const res = await fetch(url, init);
        return { ok: res.ok, status: res.status, json: () => res.json() as Promise<unknown>, text: () => res.text() };
      }) as ImageEditFetch);
  }

  private async postEdit(parts: { images: { bytes: Uint8Array; verified: VerifiedImage; field: string }[]; mask?: Uint8Array; prompt: string }): Promise<MediaAsset> {
    const form = new FormData();
    for (const part of parts.images) {
      const copy = new Uint8Array(part.bytes);
      form.append(part.field, new Blob([copy.buffer as ArrayBuffer], { type: part.verified.mimeType }), `image.${EXT_FOR[part.verified.format]}`);
    }
    if (parts.mask) {
      const maskCopy = new Uint8Array(parts.mask);
      form.append('mask', new Blob([maskCopy.buffer as ArrayBuffer], { type: 'image/png' }), 'mask.png');
    }
    form.append('model', this.model);
    form.append('prompt', parts.prompt);
    form.append('n', '1');
    let res: Awaited<ReturnType<ImageEditFetch>>;
    try {
      res = await this.fetchFn(`${this.baseUrl}/images/edits`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: form,
      });
    } catch (err) {
      throw new Error(`image edit request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`image edit failed with HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    }
    const payload = (await res.json()) as { data?: { url?: unknown; b64_json?: unknown }[] } | null;
    const item = payload?.data?.[0];
    const id = randomUUID();
    if (item && typeof item.url === 'string' && item.url) {
      return { id, kind: 'image', prompt: parts.prompt, url: item.url, mimeType: 'image/png', byteLength: 0, provider: this.name };
    }
    if (item && typeof item.b64_json === 'string' && item.b64_json) {
      return {
        id,
        kind: 'image',
        prompt: parts.prompt,
        url: `data:image/png;base64,${item.b64_json}`,
        mimeType: 'image/png',
        byteLength: Buffer.from(item.b64_json, 'base64').length,
        provider: this.name,
      };
    }
    throw new Error('image edit returned no image (empty data array)');
  }

  async editImage(req: ImageEditRequest): Promise<MediaAsset> {
    const prompt = validateEditPrompt(req.prompt);
    const verified = verifyImageBytes(req.image, { label: 'edit source image' });
    if (req.mask) verifyImageBytes(req.mask, { label: 'edit mask' });
    return this.postEdit({ images: [{ bytes: req.image, verified, field: 'image' }], mask: req.mask, prompt });
  }

  async insertPerson(req: PersonInsertionRequest): Promise<MediaAsset> {
    // Identity reference: verified under the strict profile rules FIRST.
    const profile = verifyProfilePhoto(req.profilePhoto);
    const hasScenePrompt = typeof req.scenePrompt === 'string' && req.scenePrompt.trim().length > 0;
    const hasSceneImage = req.sceneImage instanceof Uint8Array && req.sceneImage.length > 0;
    if (hasScenePrompt === hasSceneImage) {
      throw new ValidationError('insertPerson requires exactly one of "scenePrompt" or "sceneImage"');
    }
    const direction = (req.prompt ?? '').trim();
    const sceneText = hasScenePrompt
      ? `Scene: ${(req.scenePrompt as string).trim()}.`
      : 'Place the person naturally into the accompanying scene image, matching its lighting and perspective.';
    const prompt = validateEditPrompt(
      `Insert the person from the reference photo into the scene, preserving their face and identity. ${sceneText}${direction ? ` ${direction}` : ''}`,
    );
    const images: { bytes: Uint8Array; verified: VerifiedImage; field: string }[] = [
      { bytes: req.profilePhoto, verified: profile, field: 'image' },
    ];
    if (hasSceneImage) {
      images.push({ bytes: req.sceneImage!, verified: verifyImageBytes(req.sceneImage!, { label: 'scene image' }), field: 'image' });
    }
    return this.postEdit({ images, prompt });
  }
}

/** Deterministic offline editor: fixture PNG out, inputs still verified. */
export class MockImageEditProvider implements ImageEditor {
  readonly name = 'mock-edit';
  private static FIXTURE_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  private asset(prompt: string): MediaAsset {
    const id = randomUUID();
    return {
      id,
      kind: 'image',
      prompt,
      url: `mock://media/edit/${id}.png`,
      mimeType: 'image/png',
      byteLength: MockImageEditProvider.FIXTURE_PNG.length,
      provider: this.name,
    };
  }

  async editImage(req: ImageEditRequest): Promise<MediaAsset> {
    validateEditPrompt(req.prompt);
    verifyImageBytes(req.image, { label: 'edit source image' });
    if (req.mask) verifyImageBytes(req.mask, { label: 'edit mask' });
    return this.asset(req.prompt.trim());
  }

  async insertPerson(req: PersonInsertionRequest): Promise<MediaAsset> {
    verifyProfilePhoto(req.profilePhoto);
    const hasScenePrompt = typeof req.scenePrompt === 'string' && req.scenePrompt.trim().length > 0;
    const hasSceneImage = req.sceneImage instanceof Uint8Array && req.sceneImage.length > 0;
    if (hasScenePrompt === hasSceneImage) {
      throw new ValidationError('insertPerson requires exactly one of "scenePrompt" or "sceneImage"');
    }
    if (hasSceneImage) verifyImageBytes(req.sceneImage!, { label: 'scene image' });
    return this.asset((req.scenePrompt ?? req.prompt ?? 'person insertion').trim());
  }
}

/** Real editor when MEDIA_IMAGES_API_KEY is set, else the mock editor. */
export function openAIImageEditProviderFromEnv(
  env: Record<string, string | undefined>,
  fetchFn?: ImageEditFetch,
): OpenAIImageEditProvider | undefined {
  const apiKey = env[MEDIA_IMAGES_API_KEY_ENV];
  if (!apiKey || !apiKey.trim()) return undefined;
  return new OpenAIImageEditProvider({
    apiKey,
    ...(env[MEDIA_IMAGES_BASE_URL_ENV] ? { baseUrl: env[MEDIA_IMAGES_BASE_URL_ENV] } : {}),
    ...(env[MEDIA_IMAGES_MODEL_ENV] ? { model: env[MEDIA_IMAGES_MODEL_ENV] } : {}),
    ...(fetchFn ? { fetchFn } : {}),
  });
}

export function resolveImageEditor(
  env: Record<string, string | undefined> = process.env,
  fetchFn?: ImageEditFetch,
): ImageEditor {
  return openAIImageEditProviderFromEnv(env, fetchFn) ?? new MockImageEditProvider();
}

// ---------------------------------------------------------------------------
// Packaged flows
// ---------------------------------------------------------------------------

/** Edit an image from raw bytes. Bytes are verified before the provider runs. */
export async function editImageFlow(editor: ImageEditor, req: ImageEditRequest): Promise<MediaAsset> {
  verifyImageBytes(req.image, { label: 'edit source image' });
  return editor.editImage(req);
}

/**
 * Place the user into a picture from their profile reference photo.
 * The profile bytes pass verifyProfilePhoto() before anything else —
 * unverified bytes never reach a provider as an identity reference.
 */
export async function insertUserIntoPicture(editor: ImageEditor, req: PersonInsertionRequest): Promise<MediaAsset> {
  verifyProfilePhoto(req.profilePhoto);
  return editor.insertPerson(req);
}
