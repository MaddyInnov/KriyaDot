// SPDX-License-Identifier: Apache-2.0
// Signed release manifests for self-update offers (A14, Timon parity
// programme) — Ed25519 origin signatures over a canonical asset digest,
// verified BEFORE any update offer (badge / panel state) is shown.
//
// WHY THIS EXISTS
//   Before A14 the self-update path trusted the GitHub releases API
//   response as-is: any response that named a newer tag produced an
//   "update available" badge, and the only integrity check on the
//   downloaded installer was a best-effort SHA-256 sidecar fetched from
//   the same channel. A compromised or spoofed release feed could
//   therefore both FABRICATE an offer and feed it a matching sidecar.
//   A signed manifest closes the offer side of that hole: the release
//   must carry a manifest signed by the release key, and the client
//   verifies the signature against a built-in public key before the
//   offer exists at all. An unsigned, tampered, or unknown-key manifest
//   produces NO offer (fail closed) — the manager records an audit/log
//   line and otherwise behaves exactly as if no newer release existed,
//   because a bad signature is an attack-or-corruption signal, not a
//   user error worth a scary banner.
//
// SIGNING CONVENTIONS — SAME AS A9 / LICENCE (do not invent new ones)
//   Ed25519; public keys are SPKI DER base64; private keys are PKCS8
//   DER base64 — byte-for-byte the conventions of the plugin package
//   signatures (packages/plugins/src/package.ts), the federation
//   identity keys, and enterprise-licence signing
//   (apps/api/src/license.ts, scripts/make-license.mjs). The helpers
//   are re-implemented here rather than imported from @mvp/plugins
//   because agent-runtime must not depend on the plugins package; the
//   WIRE conventions are shared. A key's id is its fingerprint:
//   "kdkey_" + first 16 hex of SHA-256(SPKI DER).
//
// THE BUILT-IN KEY — DEV KEY REALITY, STATED PLAINLY
//   UPDATE_MANIFEST_PUBLIC_KEY_B64 below is the existing KriyaDot
//   release/licence public key of record: the same value embedded for
//   licence verification (LICENSE_PUBLIC_KEY_B64 in
//   apps/api/src/license.ts) and as the plugin trust root. Its private
//   half is held outside this repo (see scripts/make-license.mjs) and
//   is a DEV keypair — rotating to a production keypair remains the
//   standing user gate, exactly like licences. Rotation does not need
//   a code change: KRIYADOT_UPDATE_TRUSTED_KEYS (SPKI base64,
//   comma-separated) and SelfUpdateDeps.manifestPublicKeys add keys.
//   This key signs RELEASE MANIFESTS only. It is unrelated to Windows
//   binary code signing (SSL.com eSigner), which is a separate track.
//
// FORMAT
//   The manifest is a small JSON document published as a release asset
//   named kriyadot-release-manifest.json alongside the installers:
//     { format: "kriyadot-release-manifest", v: 1, tag, createdAt,
//       assets: [{ name, size, sha256 }], keyId, algorithm: "ed25519",
//       signature, publicKey }
//   payloadDigest = SHA-256 over the canonical asset list: the tag on
//   the first line, then assets sorted by name, each contributing
//   "<name>\n<size>\n<sha256>\n". The signature covers
//   "kriyadot-release-manifest-v1\n<keyId>\n<payloadDigest>", so it
//   cannot be transplanted onto another release or another key.
//   Verification NEVER trusts the key presented inside the manifest
//   (the federation rule): a presented key is used only for the
//   cryptographic self-consistency check that yields `untrusted-key`.
//   The verified manifest's per-asset SHA-256 is also enforced by the
//   manager at download time, which upgrades the old best-effort
//   sidecar check to a signed one for the chosen asset.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';

export const RELEASE_MANIFEST_FORMAT = 'kriyadot-release-manifest';
/** Release asset name that carries the signed manifest. */
export const RELEASE_MANIFEST_ASSET_NAME = 'kriyadot-release-manifest.json';

/**
 * Built-in verification key: the KriyaDot release/licence Ed25519
 * public key of record (SPKI DER base64) — the same value as
 * LICENSE_PUBLIC_KEY_B64 (apps/api) and the plugin trust root. DEV
 * keypair; production rotation is a standing user gate (see header).
 */
export const UPDATE_MANIFEST_PUBLIC_KEY_B64 =
  'MCowBQYDK2VwAyEALbdQH9LIHmcj25UvCYmbTeEFH/b23SlKndmsMVorsko=';

const SIGNING_PREFIX = 'kriyadot-release-manifest-v1';

// ---------------------------------------------------------------------------
// Ed25519 helpers (A9/licence conventions: SPKI/PKCS8 DER base64)
// ---------------------------------------------------------------------------

export interface ReleaseKeyPair {
  /** SPKI DER, base64. */
  publicKey: string;
  /** PKCS8 DER, base64. SECRET — never ship inside a manifest. */
  privateKey: string;
  keyId: string;
}

/** Mint a fresh release-signing keypair (operator tooling / tests). */
export function generateReleaseKeyPair(): ReleaseKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  return {
    publicKey: pub,
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    keyId: releaseKeyId(pub),
  };
}

/** Fingerprint id for an SPKI-base64 Ed25519 public key (kdkey_ style). */
export function releaseKeyId(publicKeyB64: string): string {
  return `kdkey_${createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('hex').slice(0, 16)}`;
}

/** True when the value parses as an Ed25519 SPKI public key. */
export function isReleasePublicKey(publicKeyB64: unknown): publicKeyB64 is string {
  if (typeof publicKeyB64 !== 'string' || publicKeyB64.length === 0 || publicKeyB64.length > 256) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

function ed25519Sign(privateKeyB64: string, data: string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  return cryptoSign(null, Buffer.from(data, 'utf8'), key).toString('base64');
}

function ed25519Verify(publicKeyB64: string, data: string, signatureB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    return cryptoVerify(null, Buffer.from(data, 'utf8'), key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Manifest shape, digest, signing
// ---------------------------------------------------------------------------

export interface ReleaseManifestAsset {
  name: string;
  size: number;
  /** Lowercase hex SHA-256 of the asset bytes. */
  sha256: string;
}

export interface ReleaseManifestPayload {
  format: typeof RELEASE_MANIFEST_FORMAT;
  v: 1;
  /** Release tag this manifest describes (must match the GitHub tag). */
  tag: string;
  /** Publisher clock at signing time. Informational only. */
  createdAt: number;
  assets: ReleaseManifestAsset[];
}

export interface SignedReleaseManifest extends ReleaseManifestPayload {
  keyId: string;
  algorithm: 'ed25519';
  /** Base64 Ed25519 signature over the manifest signing string. */
  signature: string;
  /** Signer's public key (SPKI base64). Informational — never a trust root. */
  publicKey: string;
}

/** Canonical payload digest: tag line + assets sorted by name. */
export function computeReleaseManifestDigest(payload: ReleaseManifestPayload): string {
  const hash = createHash('sha256');
  hash.update(`${payload.tag}\n`, 'utf8');
  const sorted = [...payload.assets].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const a of sorted) {
    hash.update(`${a.name}\n${a.size}\n${a.sha256.toLowerCase()}\n`, 'utf8');
  }
  return hash.digest('hex');
}

export function releaseManifestSigningString(keyId: string, payloadDigest: string): string {
  return `${SIGNING_PREFIX}\n${keyId}\n${payloadDigest}`;
}

/** Sign a manifest payload with a release keypair (operator side). */
export function signReleaseManifest(
  payload: ReleaseManifestPayload,
  keyPair: { publicKey: string; privateKey: string },
): SignedReleaseManifest {
  const keyId = releaseKeyId(keyPair.publicKey);
  const digest = computeReleaseManifestDigest(payload);
  return {
    ...payload,
    keyId,
    algorithm: 'ed25519',
    signature: ed25519Sign(keyPair.privateKey, releaseManifestSigningString(keyId, digest)),
    publicKey: keyPair.publicKey,
  };
}

/** Build + sign a manifest for a release in one step (operator side). */
export function createSignedReleaseManifest(
  tag: string,
  assets: ReleaseManifestAsset[],
  keyPair: { publicKey: string; privateKey: string },
  opts: { createdAt?: number } = {},
): SignedReleaseManifest {
  return signReleaseManifest(
    { format: RELEASE_MANIFEST_FORMAT, v: 1, tag, createdAt: opts.createdAt ?? Date.now(), assets },
    keyPair,
  );
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type ReleaseManifestStatus = 'verified' | 'untrusted-key' | 'unsigned' | 'invalid';

export interface ReleaseManifestVerification {
  status: ReleaseManifestStatus;
  keyId?: string;
  /** The verified (or self-consistent) payload, when the shape parsed. */
  payload?: ReleaseManifestPayload;
  /** Human-readable reason for non-verified outcomes. */
  reason?: string;
}

function parseManifest(raw: unknown): SignedReleaseManifest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Partial<SignedReleaseManifest>;
  if (
    m.format !== RELEASE_MANIFEST_FORMAT ||
    m.v !== 1 ||
    m.algorithm !== 'ed25519' ||
    typeof m.tag !== 'string' ||
    !m.tag ||
    typeof m.keyId !== 'string' ||
    typeof m.signature !== 'string' ||
    typeof m.publicKey !== 'string' ||
    !Array.isArray(m.assets)
  ) {
    return null;
  }
  for (const a of m.assets as Array<Partial<ReleaseManifestAsset>>) {
    if (
      !a ||
      typeof a.name !== 'string' ||
      !a.name ||
      typeof a.size !== 'number' ||
      !Number.isFinite(a.size) ||
      a.size < 0 ||
      typeof a.sha256 !== 'string' ||
      !/^[0-9a-fA-F]{64}$/.test(a.sha256)
    ) {
      return null;
    }
  }
  return m as SignedReleaseManifest;
}

/**
 * Verify a parsed manifest document against a trusted key set (SPKI
 * base64). Pure and synchronous. `unsigned` is returned when the
 * document carries no signature block at all; a present-but-broken
 * block is `invalid`; a genuine signature under an unknown key is
 * `untrusted-key`. Only `verified` may produce an update offer.
 */
export function verifyReleaseManifest(
  raw: unknown,
  trustedPublicKeys: readonly string[],
): ReleaseManifestVerification {
  if (typeof raw !== 'object' || raw === null) {
    return { status: 'invalid', reason: 'release manifest is not a JSON object' };
  }
  const m = raw as Partial<SignedReleaseManifest>;
  if (typeof m.signature !== 'string' || typeof m.keyId !== 'string' || typeof m.publicKey !== 'string') {
    return { status: 'unsigned', reason: 'release manifest carries no signature' };
  }
  const parsed = parseManifest(raw);
  if (!parsed) return { status: 'invalid', reason: 'release manifest is malformed' };
  if (!isReleasePublicKey(parsed.publicKey) || releaseKeyId(parsed.publicKey) !== parsed.keyId) {
    return { status: 'invalid', keyId: parsed.keyId, reason: 'manifest keyId does not match the presented public key' };
  }
  const payload: ReleaseManifestPayload = {
    format: parsed.format,
    v: parsed.v,
    tag: parsed.tag,
    createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
    assets: parsed.assets,
  };
  const digest = computeReleaseManifestDigest(payload);
  const signingString = releaseManifestSigningString(parsed.keyId, digest);
  const trustedKey = trustedPublicKeys.find((k) => isReleasePublicKey(k) && releaseKeyId(k) === parsed.keyId);
  if (trustedKey) {
    return ed25519Verify(trustedKey, signingString, parsed.signature)
      ? { status: 'verified', keyId: parsed.keyId, payload }
      : { status: 'invalid', keyId: parsed.keyId, payload, reason: 'signature does not verify under the trusted release key' };
  }
  return ed25519Verify(parsed.publicKey, signingString, parsed.signature)
    ? {
        status: 'untrusted-key',
        keyId: parsed.keyId,
        payload,
        reason: 'signature is valid but the signing key is not a trusted release key',
      }
    : { status: 'invalid', keyId: parsed.keyId, payload, reason: 'signature does not verify under the presented key' };
}

/** Keys from the KRIYADOT_UPDATE_TRUSTED_KEYS env var (SPKI base64, comma-separated). Malformed entries are ignored. */
export function envUpdateManifestKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.KRIYADOT_UPDATE_TRUSTED_KEYS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => isReleasePublicKey(s));
}

/**
 * Resolve the trusted key set for update manifests: the built-in
 * release key of record + env keys + caller-supplied keys (tests /
 * rotation), de-duplicated by fingerprint.
 */
export function resolveUpdateManifestKeys(
  extra: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const byId = new Map<string, string>();
  for (const key of [UPDATE_MANIFEST_PUBLIC_KEY_B64, ...envUpdateManifestKeys(env), ...extra]) {
    if (isReleasePublicKey(key)) byId.set(releaseKeyId(key), key);
  }
  return [...byId.values()];
}
