// SPDX-License-Identifier: Apache-2.0
// M-2 image edit + profile-photo insertion tests. Fake fetch only —
// no network, no keys, no paid usage. Synthetic tiny images only.
import { describe, it, expect } from 'vitest';
import { ValidationError } from '../errors.js';
import {
  sniffImageFormat,
  verifyImageBytes,
  verifyProfilePhoto,
  OpenAIImageEditProvider,
  MockImageEditProvider,
  resolveImageEditor,
  openAIImageEditProviderFromEnv,
  editImageFlow,
  insertUserIntoPicture,
  type ImageEditFetch,
} from './image-edit.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const WEBP = new Uint8Array([...Buffer.from('RIFF'), 0x10, 0, 0, 0, ...Buffer.from('WEBP'), 1, 2]);
const NOT_AN_IMAGE = new Uint8Array([...Buffer.from('this is plain text, not an image')]);

describe('verifyImageBytes / sniffImageFormat (profile-photo byte rule)', () => {
  it('sniffs png/jpeg/webp and verifies honest declarations', () => {
    expect(sniffImageFormat(PNG)).toBe('png');
    expect(sniffImageFormat(JPEG)).toBe('jpeg');
    expect(sniffImageFormat(WEBP)).toBe('webp');
    expect(verifyImageBytes(PNG, { declaredMimeType: 'image/png' }).format).toBe('png');
    expect(verifyProfilePhoto(JPEG).mimeType).toBe('image/jpeg');
  });

  it('rejects non-image bytes, spoofed declarations, and empty input', () => {
    expect(sniffImageFormat(NOT_AN_IMAGE)).toBeUndefined();
    expect(() => verifyImageBytes(NOT_AN_IMAGE)).toThrow(ValidationError);
    expect(() => verifyProfilePhoto(NOT_AN_IMAGE)).toThrow(/do not match any known image signature/);
    expect(() => verifyImageBytes(JPEG, { declaredMimeType: 'image/png' })).toThrow(/does not match the actual bytes/);
    expect(() => verifyImageBytes(new Uint8Array(0))).toThrow(ValidationError);
  });

  it('enforces the profile size cap separately from the general cap', () => {
    const big = new Uint8Array(11 * 1024 * 1024);
    big.set(PNG.subarray(0, 8), 0); // valid PNG magic, oversized body
    expect(() => verifyProfilePhoto(big)).toThrow(/exceeds the 10 MiB limit/);
    expect(verifyImageBytes(big).byteLength).toBe(big.length); // general cap is 20 MiB
  });
});

function fakeEditFetch(payload: unknown, opts: { ok?: boolean; status?: number } = {}) {
  const calls: { url: string; form: FormData }[] = [];
  const fetchFn: ImageEditFetch = async (url, init) => {
    calls.push({ url, form: init.body });
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => payload,
      text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    };
  };
  return { fetchFn, calls };
}

describe('OpenAIImageEditProvider (M-2)', () => {
  it('editImage POSTs multipart to /images/edits with the source image + prompt', async () => {
    const { fetchFn, calls } = fakeEditFetch({ data: [{ url: 'https://cdn.example/edited.png' }] });
    const provider = new OpenAIImageEditProvider({ apiKey: 'ek-test', baseUrl: 'https://img.example/v1/', fetchFn });
    const asset = await provider.editImage({ image: PNG, prompt: 'make it sunset' });
    expect(asset.url).toBe('https://cdn.example/edited.png');
    expect(asset.provider).toBe('openai-image-edit');
    expect(calls[0].url).toBe('https://img.example/v1/images/edits');
    expect(calls[0].form.get('prompt')).toBe('make it sunset');
    const img = calls[0].form.get('image') as Blob;
    expect(img).toBeTruthy();
    expect(img.type).toBe('image/png');
    expect(Buffer.from(await img.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('insertPerson sends the verified profile photo as the identity reference image', async () => {
    const { fetchFn, calls } = fakeEditFetch({ data: [{ b64_json: Buffer.from('out').toString('base64') }] });
    const provider = new OpenAIImageEditProvider({ apiKey: 'k', fetchFn });
    const asset = await provider.insertPerson({
      profilePhoto: JPEG,
      scenePrompt: 'a lighthouse at dawn',
      prompt: 'standing on the rocks',
    });
    expect(asset.byteLength).toBe(3);
    const prompt = String(calls[0].form.get('prompt'));
    expect(prompt).toContain('preserving their face and identity');
    expect(prompt).toContain('a lighthouse at dawn');
    const images = calls[0].form.getAll('image') as Blob[];
    expect(images).toHaveLength(1);
    expect(images[0].type).toBe('image/jpeg');
  });

  it('insertPerson with a scene image sends both images', async () => {
    const { fetchFn, calls } = fakeEditFetch({ data: [{ url: 'https://cdn.example/x.png' }] });
    const provider = new OpenAIImageEditProvider({ apiKey: 'k', fetchFn });
    await provider.insertPerson({ profilePhoto: PNG, sceneImage: WEBP });
    expect(calls[0].form.getAll('image')).toHaveLength(2);
  });

  it('refuses unverified profile bytes and ambiguous scene input before any request', async () => {
    const { fetchFn, calls } = fakeEditFetch({ data: [{ url: 'https://x/y' }] });
    const provider = new OpenAIImageEditProvider({ apiKey: 'k', fetchFn });
    await expect(provider.insertPerson({ profilePhoto: NOT_AN_IMAGE, scenePrompt: 'beach' })).rejects.toThrow(ValidationError);
    await expect(provider.insertPerson({ profilePhoto: PNG })).rejects.toThrow(/exactly one of/);
    await expect(provider.insertPerson({ profilePhoto: PNG, scenePrompt: 'beach', sceneImage: PNG })).rejects.toThrow(/exactly one of/);
    await expect(provider.editImage({ image: NOT_AN_IMAGE, prompt: 'x' })).rejects.toThrow(ValidationError);
    expect(calls).toHaveLength(0); // nothing reached the network seam
  });

  it('HTTP errors surface status without leaking the key', async () => {
    const { fetchFn } = fakeEditFetch('nope', { ok: false, status: 401 });
    const provider = new OpenAIImageEditProvider({ apiKey: 'ek-secret', fetchFn });
    const err = (await provider.editImage({ image: PNG, prompt: 'x' }).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/401/);
    expect(err.message).not.toContain('ek-secret');
  });
});

describe('MockImageEditProvider + packaged flows (M-2)', () => {
  it('mock edit + insertion work offline; the flows verify bytes first', async () => {
    const mock = new MockImageEditProvider();
    const edited = await editImageFlow(mock, { image: PNG, prompt: 'add a hat' });
    expect(edited.provider).toBe('mock-edit');
    expect(edited.url).toMatch(/^mock:\/\/media\/edit\//);
    const inserted = await insertUserIntoPicture(mock, { profilePhoto: PNG, scenePrompt: 'the moon' });
    expect(inserted.kind).toBe('image');
    await expect(editImageFlow(mock, { image: NOT_AN_IMAGE, prompt: 'x' })).rejects.toThrow(ValidationError);
    await expect(insertUserIntoPicture(mock, { profilePhoto: NOT_AN_IMAGE, scenePrompt: 'x' })).rejects.toThrow(ValidationError);
  });

  it('resolveImageEditor: real when keyed, mock otherwise', () => {
    expect(resolveImageEditor({}).name).toBe('mock-edit');
    expect(openAIImageEditProviderFromEnv({})).toBeUndefined();
    const { fetchFn } = fakeEditFetch({ data: [] });
    expect(resolveImageEditor({ MEDIA_IMAGES_API_KEY: 'k' }, fetchFn).name).toBe('openai-image-edit');
  });
});
