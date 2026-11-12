// SPDX-License-Identifier: Apache-2.0
// A14: signed update offers — the manifest gate in front of SelfUpdateManager.
// Valid signature → the offer shows; tampered / unsigned / untrusted-key
// manifests → NO offer (fail closed) plus exactly one rejection callback.
// All fetches are local fakes; zero paid APIs, zero network.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SelfUpdateManager, type ReleaseAsset } from '../src/self-update.js';
import {
  createSignedReleaseManifest,
  generateReleaseKeyPair,
  releaseKeyId,
  resolveUpdateManifestKeys,
  signReleaseManifest,
  UPDATE_MANIFEST_PUBLIC_KEY_B64,
  verifyReleaseManifest,
  RELEASE_MANIFEST_ASSET_NAME,
  RELEASE_MANIFEST_FORMAT,
} from '../src/update-manifest.js';

// Local copies of the self-update.test.ts fixture helpers (importing a
// test file would re-register its suites in this file's run).
const TEST_RELEASE_KEYS = generateReleaseKeyPair();

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function signedManifestFixture(
  tag: string,
  assets: ReleaseAsset[],
  hashes: Record<string, string> = {},
): { asset: ReleaseAsset; text: string; url: string } {
  const url = `https://dl/manifest/${encodeURIComponent(tag)}`;
  const manifest = createSignedReleaseManifest(
    tag,
    assets.map((a) => ({ name: a.name, size: a.size, sha256: hashes[a.name] ?? sha256Hex(`bytes-of-${a.name}`) })),
    TEST_RELEASE_KEYS,
    { createdAt: 1_700_000_000_000 },
  );
  const text = JSON.stringify(manifest);
  return { asset: { name: RELEASE_MANIFEST_ASSET_NAME, size: text.length, browser_download_url: url }, text, url };
}

const ASSET: ReleaseAsset = {
  name: 'KriyaDot_0.1.1_amd64.AppImage',
  size: 8,
  browser_download_url: 'https://dl/appimage',
};

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'update-manifest-a14-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ghRelease(tag: string, assets: ReleaseAsset[]) {
  return {
    tag_name: tag,
    name: `KriyaDot ${tag}`,
    body: 'notes',
    published_at: '2026-10-16T00:00:00Z',
    prerelease: true,
    draft: false,
    html_url: `https://github.com/x/releases/tag/${tag}`,
    assets,
  };
}

interface Harness {
  manager: SelfUpdateManager;
  rejected: Array<{ tag: string; status: string; reason: string }>;
}

/** Manager whose fetch serves one release + (optionally) one manifest text. */
function makeHarness(opts: { release: unknown; manifestText?: string; manifestUrl?: string }): Harness {
  const rejected: Harness['rejected'] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url);
    if (opts.manifestUrl && u === opts.manifestUrl) {
      return {
        ok: true,
        status: 200,
        body: null,
        json: async () => JSON.parse(opts.manifestText ?? '{}'),
        text: async () => opts.manifestText ?? '',
      };
    }
    return { ok: true, status: 200, body: null, json: async () => [opts.release], text: async () => '' };
  }) as unknown as typeof fetch;
  const manager = new SelfUpdateManager({
    dataDir: dir,
    currentVersion: '0.1.0-alpha',
    fetch: fetchImpl,
    platform: 'linux',
    arch: 'x64',
    noAutoCheck: true,
    manifestPublicKeys: [TEST_RELEASE_KEYS.publicKey],
    onManifestRejected: (info) => rejected.push(info),
    exit: () => undefined,
  });
  return { manager, rejected };
}

describe('release manifest sign/verify (A9 conventions)', () => {
  const payload = {
    format: RELEASE_MANIFEST_FORMAT,
    v: 1 as const,
    tag: 'v0.1.1',
    createdAt: 1_700_000_000_000,
    assets: [{ name: ASSET.name, size: ASSET.size, sha256: sha256Hex('bytes') }],
  };

  it('verifies a manifest signed by a trusted key; keyId is the kdkey_ fingerprint', () => {
    const signed = signReleaseManifest(payload, TEST_RELEASE_KEYS);
    expect(signed.keyId).toBe(releaseKeyId(TEST_RELEASE_KEYS.publicKey));
    expect(signed.keyId).toMatch(/^kdkey_[0-9a-f]{16}$/);
    const v = verifyReleaseManifest(signed, [TEST_RELEASE_KEYS.publicKey]);
    expect(v.status).toBe('verified');
    expect(v.payload?.tag).toBe('v0.1.1');
  });

  it('detects tampering (asset entry changed after signing)', () => {
    const signed = signReleaseManifest(payload, TEST_RELEASE_KEYS);
    const tampered = { ...signed, assets: [{ ...payload.assets[0]!, size: 999 }] };
    expect(verifyReleaseManifest(tampered, [TEST_RELEASE_KEYS.publicKey]).status).toBe('invalid');
  });

  it('reports unsigned when the signature block is absent', () => {
    expect(verifyReleaseManifest({ ...payload }, [TEST_RELEASE_KEYS.publicKey]).status).toBe('unsigned');
    expect(verifyReleaseManifest('not json', [TEST_RELEASE_KEYS.publicKey]).status).toBe('invalid');
  });

  it('reports untrusted-key for a genuine signature under an unknown key', () => {
    const stranger = generateReleaseKeyPair();
    const signed = signReleaseManifest(payload, stranger);
    const v = verifyReleaseManifest(signed, [TEST_RELEASE_KEYS.publicKey]);
    expect(v.status).toBe('untrusted-key');
    // …but the same manifest verifies once that key is trusted.
    expect(verifyReleaseManifest(signed, [stranger.publicKey]).status).toBe('verified');
  });

  it('the built-in verification key is the licence/release key of record', () => {
    const keys = resolveUpdateManifestKeys([], {});
    expect(keys).toContain(UPDATE_MANIFEST_PUBLIC_KEY_B64);
    expect(releaseKeyId(UPDATE_MANIFEST_PUBLIC_KEY_B64)).toMatch(/^kdkey_/);
  });
});

describe('SelfUpdateManager manifest gate', () => {
  it('valid signature → the offer shows', async () => {
    const fx = signedManifestFixture('v0.1.1', [ASSET]);
    const { manager, rejected } = makeHarness({
      release: ghRelease('v0.1.1', [ASSET, fx.asset]),
      manifestText: fx.text,
      manifestUrl: fx.url,
    });
    const status = await manager.checkNow();
    expect(status.state).toBe('available');
    expect(status.latest?.tag).toBe('v0.1.1');
    expect(status.manifestStatus).toBe('verified');
    expect(status.blockedOffer).toBeNull();
    expect(rejected).toEqual([]);
  });

  it('unsigned release (no manifest asset) → no offer, one rejection line', async () => {
    const { manager, rejected } = makeHarness({ release: ghRelease('v0.1.1', [ASSET]) });
    const status = await manager.checkNow();
    expect(status.state).toBe('idle');
    expect(status.latest).toBeNull();
    expect(status.manifestStatus).toBe('unsigned');
    expect(status.blockedOffer?.status).toBe('unsigned');
    // Fail closed is quiet for the user: no error state, no scary message.
    expect(status.lastError).toBeNull();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.tag).toBe('v0.1.1');
  });

  it('tampered manifest → no offer', async () => {
    const fx = signedManifestFixture('v0.1.1', [ASSET]);
    const parsed = JSON.parse(fx.text) as { assets: Array<{ size: number }> };
    parsed.assets[0]!.size = 12345; // contents changed after signing
    const { manager, rejected } = makeHarness({
      release: ghRelease('v0.1.1', [ASSET, fx.asset]),
      manifestText: JSON.stringify(parsed),
      manifestUrl: fx.url,
    });
    const status = await manager.checkNow();
    expect(status.state).toBe('idle');
    expect(status.latest).toBeNull();
    expect(rejected).toHaveLength(1);
    expect(['invalid']).toContain(rejected[0]!.status);
  });

  it('manifest signed for a different tag → no offer', async () => {
    const fx = signedManifestFixture('v9.9.9', [ASSET]);
    // Serve the v9.9.9 manifest from the URL the v0.1.1 release points at.
    const asset = { ...fx.asset, browser_download_url: 'https://dl/manifest/v0.1.1' };
    const { manager, rejected } = makeHarness({
      release: ghRelease('v0.1.1', [ASSET, asset]),
      manifestText: fx.text,
      manifestUrl: 'https://dl/manifest/v0.1.1',
    });
    const status = await manager.checkNow();
    expect(status.state).toBe('idle');
    expect(rejected[0]!.status).toBe('invalid');
    expect(rejected[0]!.reason).toMatch(/not the offered release/);
  });

  it('untrusted signing key → no offer', async () => {
    const stranger = generateReleaseKeyPair();
    const manifest = createSignedReleaseManifest(
      'v0.1.1',
      [{ name: ASSET.name, size: ASSET.size, sha256: sha256Hex('x') }],
      stranger,
      { createdAt: 1_700_000_000_000 },
    );
    const text = JSON.stringify(manifest);
    const url = 'https://dl/manifest/v0.1.1';
    const asset = { name: 'kriyadot-release-manifest.json', size: text.length, browser_download_url: url };
    const { manager, rejected } = makeHarness({
      release: ghRelease('v0.1.1', [ASSET, asset]),
      manifestText: text,
      manifestUrl: url,
    });
    const status = await manager.checkNow();
    expect(status.state).toBe('idle');
    expect(status.manifestStatus).toBe('untrusted-key');
    expect(rejected[0]!.status).toBe('untrusted-key');
  });

  it('downloaded bytes that differ from the signed manifest hash are discarded', async () => {
    const payload = Buffer.from('installer-bytes'); // 15 bytes
    const asset: ReleaseAsset = { name: ASSET.name, size: payload.length, browser_download_url: 'https://dl/appimage' };
    // Manifest signs the hash of DIFFERENT bytes (size still agrees, so
    // the offer shows; the download must then fail the signed hash).
    const fx = signedManifestFixture('v0.1.1', [asset], { [asset.name]: sha256Hex('other-bytes') });
    const release = ghRelease('v0.1.1', [asset, fx.asset]);
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u === 'https://dl/appimage') {
        const stream = new ReadableStream({
          start(c) {
            c.enqueue(payload);
            c.close();
          },
        });
        return { ok: true, status: 200, body: stream, json: async () => [], text: async () => '' };
      }
      if (u === fx.url) {
        return { ok: true, status: 200, body: null, json: async () => JSON.parse(fx.text), text: async () => fx.text };
      }
      return { ok: true, status: 200, body: null, json: async () => [release], text: async () => '' };
    }) as unknown as typeof fetch;
    const rejected: unknown[] = [];
    const manager = new SelfUpdateManager({
      dataDir: dir,
      currentVersion: '0.1.0-alpha',
      fetch: fetchImpl,
      platform: 'linux',
      arch: 'x64',
      noAutoCheck: true,
      manifestPublicKeys: [TEST_RELEASE_KEYS.publicKey],
      onManifestRejected: (i) => rejected.push(i),
      exit: () => undefined,
    });
    expect((await manager.checkNow()).state).toBe('available');
    const dl = await manager.download();
    expect(dl.state).toBe('error');
    expect(dl.lastError).toMatch(/signed release manifest/);
  });
});
