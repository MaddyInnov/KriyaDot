// SPDX-License-Identifier: Apache-2.0
// A9: Signed plugin packages (.kdpkg) — Ed25519 origin signatures over a
// content digest, verified at install against trusted publisher keys.
//
// WHY THIS EXISTS
//   Plugins run code (or, for declarative providers, steer credentials and
//   traffic). Before A9 a package was just a zip: anyone could produce one
//   claiming to be anyone. A signature gives the install flow a verifiable
//   ORIGIN: "these exact bytes were produced by the holder of this key."
//
// THREAT MODEL — ORIGIN IS NOT BEHAVIOUR
//   Signing proves origin and integrity, nothing more. A validly signed
//   plugin can still be malicious or buggy; the behaviour controls are
//   (a) the governance install-approval gate, which every install — signed
//   or not — must pass, and (b) the OPEN-2 kernel sandbox, which confines
//   executable plugins to their declared permissions at runtime. Copy in
//   the UI/API says exactly this; nothing here claims signed = safe.
//   Conversely the sandbox does not provide origin: the two controls are
//   complements, not substitutes.
//
// FORMAT
//   A .kdpkg is an ordinary ZIP (the zip.ts reader/writer) whose entries
//   are the plugin's files (plugin.json at the root, as always) plus one
//   reserved entry, `signature.json`, at the root:
//     { format: "kriyadot-plugin-signature", v: 1, keyId, algorithm:
//       "ed25519", signedAt, payloadDigest, signature }
//   The payload digest is SHA-256 over the canonical file list: entries
//   sorted by name (signature.json excluded), each contributing
//   "<name>\n<sha256-hex of contents>\n<byte length>\n". Zip metadata,
//   ordering and compression are NOT covered — irrelevant bytes cannot
//   change what gets installed, and relevant bytes always can (any file
//   change, rename, add or remove flips the digest).
//   The Ed25519 signature covers the string
//     "kriyadot-plugin-package-v1\n<keyId>\n<payloadDigest>"
//   so a signature cannot be transplanted onto another package or another
//   publisher's key id.
//
// KEYS — SAME CONVENTIONS AS THE EXISTING SIGNING MACHINERY
//   Keys are Ed25519, public keys are SPKI DER base64, private keys are
//   PKCS8 DER base64 — byte-for-byte the conventions of the federation
//   identity keys and the enterprise-licence signing (see
//   @mvp/agent-runtime federation.ts and scripts/make-license.mjs). The
//   helpers are re-implemented here rather than imported because
//   @mvp/plugins is deliberately dependency-free; the WIRE conventions
//   are shared, so a key minted for one KriyaDot signing purpose is
//   representable in the others. A key's id is its fingerprint:
//   "kdkey_" + the first 16 hex chars of SHA-256(SPKI DER) — the same
//   derivation style as federation instance ids.
//
// TRUST MODEL
//   Verification NEVER trusts a key presented inside the package (the
//   federation module's rule: verify against a KNOWN key, never a
//   presented one). A signature verifies only when its keyId resolves to
//   a key in the host's trusted set, which is the union of:
//     1. the built-in trust root (BUILTIN_PLUGIN_TRUSTED_KEYS below),
//     2. keys from the KRIYADOT_PLUGIN_TRUSTED_KEYS env var (SPKI base64,
//        comma-separated) — the operator's deployment-level root,
//     3. keys the user has explicitly added to their PluginTrustStore
//        (a JSON file in the data dir; adding a key is a deliberate,
//        host-mediated trust action, surfaced in the API/UI).
//   Verification outcomes (PluginSignatureStatus):
//     verified       signature valid under a trusted key
//     untrusted-key  signature valid, but under a key nobody here trusts
//                    (self-signed / unknown publisher) — the package DOES
//                    carry the signer's public key so the host can offer
//                    "trust this publisher" as an explicit user action
//     unsigned       no signature.json at all
//     invalid        signature.json present but malformed, digest
//                    mismatch (tampered / corrupt), or signature fails
//   The PluginManager refuses unsigned / untrusted-key / invalid PACKAGES
//   by default; the only way in is the manager's separate, explicitly
//   labelled untrusted-install approval hook, which the host wires to
//   governance (see manager.ts). Signing NEVER skips the ordinary
//   install approval.
//
// HONEST LIMITS
//   - The built-in root below is the KriyaDot release key — the same
//     Ed25519 public key that verifies enterprise licences (its private
//     half lives outside this repo, per scripts/make-license.mjs). One
//     key serving two duties is a deliberate v1 simplification, recorded
//     here so a future rotation can split them; the trust store + env
//     root make rotation possible without a code change.
//   - No revocation list in v1: removing a key from the trust store /
//     env stops FUTURE installs from verifying; already-installed
//     plugins are unaffected (uninstall is the remedy).
//   - signedAt is informational only (publisher clocks are untrusted);
//     verification does not check freshness — packages are not licences
//     and do not expire.
//   - Windows note (inherited from OPEN-2): signature verification is
//     platform-independent and works everywhere, but a restrictive
//     executable plugin installed from a verified package is still
//     REFUSED at run time on hosts with no kernel sandbox backend —
//     origin assurance does not conjure behaviour confinement.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createZipArchive, readZipEntries, type ZipEntry } from './zip.js';

export const PLUGIN_SIGNATURE_FILE = 'signature.json';
export const PLUGIN_PACKAGE_FORMAT = 'kriyadot-plugin-signature';

/**
 * Built-in trust root: the KriyaDot release signing key (SPKI DER base64).
 * This is the same public key embedded for enterprise-licence
 * verification in apps/api/src/license.ts; its private half is held
 * outside the repo by the publisher (see the module header).
 */
export const BUILTIN_PLUGIN_TRUSTED_KEYS: readonly string[] = [
  'MCowBQYDK2VwAyEALbdQH9LIHmcj25UvCYmbTeEFH/b23SlKndmsMVorsko=',
];

const SIGNING_PREFIX = 'kriyadot-plugin-package-v1';

// ---------------------------------------------------------------------------
// Ed25519 helpers (federation/licence conventions: SPKI/PKCS8 DER base64)
// ---------------------------------------------------------------------------

export interface PluginPublisherKeyPair {
  /** SPKI DER, base64. */
  publicKey: string;
  /** PKCS8 DER, base64. SECRET — never ship inside a package. */
  privateKey: string;
  keyId: string;
}

/** Mint a fresh publisher keypair (dev tooling / tests / user publishers). */
export function generatePluginPublisherKeyPair(): PluginPublisherKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  return {
    publicKey: pub,
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    keyId: pluginKeyId(pub),
  };
}

/** Fingerprint id for an SPKI-base64 Ed25519 public key. */
export function pluginKeyId(publicKeyB64: string): string {
  return `kdkey_${createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('hex').slice(0, 16)}`;
}

/** True when the value parses as an Ed25519 SPKI public key. */
export function isPluginPublicKey(publicKeyB64: unknown): publicKeyB64 is string {
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
// Payload digest + signing
// ---------------------------------------------------------------------------

export interface PackageFileEntry {
  name: string;
  data: Buffer;
}

/**
 * Canonical payload digest over package files. `signature.json` is always
 * excluded (it carries the digest, so it cannot cover itself). Entry order
 * in the input does not matter; names are sorted.
 */
export function computePackageDigest(files: PackageFileEntry[]): string {
  const hash = createHash('sha256');
  const sorted = [...files]
    .filter((f) => f.name !== PLUGIN_SIGNATURE_FILE)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const f of sorted) {
    const fileHash = createHash('sha256').update(f.data).digest('hex');
    hash.update(`${f.name}\n${fileHash}\n${f.data.length}\n`, 'utf8');
  }
  return hash.digest('hex');
}

export interface PluginSignatureBlock {
  format: typeof PLUGIN_PACKAGE_FORMAT;
  v: 1;
  keyId: string;
  algorithm: 'ed25519';
  /** Publisher clock at signing time. Informational only — never trusted. */
  signedAt: number;
  payloadDigest: string;
  /** Base64 Ed25519 signature over the package signing string. */
  signature: string;
  /**
   * The signer's public key (SPKI base64). INFORMATIONAL: it lets the
   * host offer an explicit "trust this publisher" action and lets a
   * self-signed package verify cryptographically (status untrusted-key).
   * It is NEVER used as a trust root by itself.
   */
  publicKey: string;
}

export function packageSigningString(keyId: string, payloadDigest: string): string {
  return `${SIGNING_PREFIX}\n${keyId}\n${payloadDigest}`;
}

/** Produce the signature block for a set of package files. */
export function signPackageFiles(
  files: PackageFileEntry[],
  keyPair: { publicKey: string; privateKey: string },
  opts: { signedAt?: number } = {},
): PluginSignatureBlock {
  const keyId = pluginKeyId(keyPair.publicKey);
  const payloadDigest = computePackageDigest(files);
  return {
    format: PLUGIN_PACKAGE_FORMAT,
    v: 1,
    keyId,
    algorithm: 'ed25519',
    signedAt: opts.signedAt ?? Date.now(),
    payloadDigest,
    signature: ed25519Sign(keyPair.privateKey, packageSigningString(keyId, payloadDigest)),
    publicKey: keyPair.publicKey,
  };
}

/**
 * Build a signed .kdpkg (ZIP bytes) from package files + a publisher
 * keypair. Any pre-existing signature.json in `files` is replaced.
 */
export function createSignedPluginPackage(
  files: PackageFileEntry[],
  keyPair: { publicKey: string; privateKey: string },
  opts: { signedAt?: number } = {},
): Buffer {
  const block = signPackageFiles(files, keyPair, opts);
  const entries: ZipEntry[] = [
    ...files
      .filter((f) => f.name !== PLUGIN_SIGNATURE_FILE)
      .map((f) => ({ name: f.name, data: f.data, method: 8 as const })),
    { name: PLUGIN_SIGNATURE_FILE, data: Buffer.from(JSON.stringify(block, null, 2), 'utf8'), method: 8 as const },
  ];
  return createZipArchive(entries);
}

/** Sign an existing unsigned package ZIP in memory; returns the signed ZIP. */
export function signPluginPackageZip(
  zipBuf: Buffer,
  keyPair: { publicKey: string; privateKey: string },
  opts: { signedAt?: number } = {},
): Buffer {
  const entries = readZipEntries(zipBuf);
  return createSignedPluginPackage(
    entries.map((e) => ({ name: e.name, data: e.data })),
    keyPair,
    opts,
  );
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type PluginSignatureStatus = 'verified' | 'untrusted-key' | 'unsigned' | 'invalid';

export interface PluginSignatureVerification {
  status: PluginSignatureStatus;
  /** Signing key fingerprint, when a signature block was present. */
  keyId?: string;
  /** True when keyId resolved to the host's trusted set. */
  trusted?: boolean;
  /** The signer's presented public key (informational; see header). */
  signerPublicKey?: string;
  /** Payload digest recomputed from the actual files, when computable. */
  payloadDigest?: string;
  /** Human-readable reason for untrusted-key / invalid outcomes. */
  reason?: string;
}

function parseSignatureBlock(raw: Buffer): PluginSignatureBlock | null {
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as Partial<PluginSignatureBlock>;
    if (
      parsed.format !== PLUGIN_PACKAGE_FORMAT ||
      parsed.v !== 1 ||
      parsed.algorithm !== 'ed25519' ||
      typeof parsed.keyId !== 'string' ||
      typeof parsed.payloadDigest !== 'string' ||
      typeof parsed.signature !== 'string' ||
      typeof parsed.publicKey !== 'string'
    ) {
      return null;
    }
    return parsed as PluginSignatureBlock;
  } catch {
    return null;
  }
}

/**
 * Verify package FILES (already extracted from the zip / read from a
 * directory) against a trusted key set (SPKI base64 public keys).
 * Pure and synchronous: no filesystem, no trust in presented keys beyond
 * the cryptographic self-consistency check that yields `untrusted-key`.
 */
export function verifyPackageFiles(
  files: PackageFileEntry[],
  trustedPublicKeys: readonly string[],
): PluginSignatureVerification {
  const sigEntry = files.find((f) => f.name === PLUGIN_SIGNATURE_FILE);
  if (!sigEntry) return { status: 'unsigned', reason: 'package carries no signature.json' };
  const block = parseSignatureBlock(sigEntry.data);
  if (!block) return { status: 'invalid', reason: 'signature.json is malformed' };
  if (!isPluginPublicKey(block.publicKey) || pluginKeyId(block.publicKey) !== block.keyId) {
    return { status: 'invalid', keyId: block.keyId, reason: 'signature keyId does not match the presented public key' };
  }
  const payloadDigest = computePackageDigest(files);
  if (payloadDigest !== block.payloadDigest) {
    return {
      status: 'invalid',
      keyId: block.keyId,
      payloadDigest,
      signerPublicKey: block.publicKey,
      reason: 'payload digest mismatch — package contents differ from what was signed (tampered or corrupt)',
    };
  }
  const signingString = packageSigningString(block.keyId, block.payloadDigest);
  // Trusted path: verify under the TRUSTED key whose fingerprint matches.
  const trustedKey = trustedPublicKeys.find((k) => isPluginPublicKey(k) && pluginKeyId(k) === block.keyId);
  if (trustedKey) {
    return ed25519Verify(trustedKey, signingString, block.signature)
      ? { status: 'verified', keyId: block.keyId, trusted: true, payloadDigest, signerPublicKey: block.publicKey }
      : { status: 'invalid', keyId: block.keyId, trusted: true, payloadDigest, reason: 'signature does not verify under the trusted key' };
  }
  // Untrusted path: the signature may still be cryptographically genuine
  // under the presented key — that proves a consistent origin claim, just
  // not one this host trusts.
  return ed25519Verify(block.publicKey, signingString, block.signature)
    ? {
        status: 'untrusted-key',
        keyId: block.keyId,
        trusted: false,
        payloadDigest,
        signerPublicKey: block.publicKey,
        reason: 'signature is valid but the publisher key is not in the trusted set',
      }
    : { status: 'invalid', keyId: block.keyId, payloadDigest, reason: 'signature does not verify under the presented key' };
}

/** Verify a whole package ZIP buffer against a trusted key set. */
export function verifyPluginPackage(zipBuf: Buffer, trustedPublicKeys: readonly string[]): PluginSignatureVerification {
  const entries = readZipEntries(zipBuf);
  return verifyPackageFiles(
    entries.map((e) => ({ name: e.name, data: e.data })),
    trustedPublicKeys,
  );
}

// ---------------------------------------------------------------------------
// User trust store (publisher keys the user explicitly chose to trust)
// ---------------------------------------------------------------------------

export interface TrustedPublisherKey {
  keyId: string;
  /** SPKI DER base64. */
  publicKey: string;
  /** User-facing label (e.g. the publisher name shown when trusting). */
  label: string;
  addedAt: number;
}

interface TrustStoreFile {
  version: 1;
  keys: TrustedPublisherKey[];
}

/**
 * File-backed store of publisher keys the USER has explicitly trusted.
 * Deliberately separate from any approval flow: trusting a publisher is a
 * durable decision (future packages from that key verify), so the host
 * surfaces it as its own action — the manager never adds keys on its own,
 * and an install approval never silently becomes publisher trust.
 */
export class PluginTrustStore {
  private readonly filePath: string;
  private keys: TrustedPublisherKey[];

  constructor(filePath: string) {
    this.filePath = filePath;
    this.keys = this.read();
  }

  private read(): TrustedPublisherKey[] {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as TrustStoreFile;
      if (parsed && Array.isArray(parsed.keys)) {
        return parsed.keys.filter(
          (k) => k && typeof k.keyId === 'string' && isPluginPublicKey(k.publicKey) && pluginKeyId(k.publicKey) === k.keyId,
        );
      }
    } catch {
      // missing/corrupt → empty (fail closed: nothing extra is trusted)
    }
    return [];
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, keys: this.keys }, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      /* best effort */
    }
    renameSync(tmp, this.filePath);
  }

  list(): TrustedPublisherKey[] {
    return this.keys.map((k) => ({ ...k }));
  }

  publicKeys(): string[] {
    return this.keys.map((k) => k.publicKey);
  }

  has(keyId: string): boolean {
    return this.keys.some((k) => k.keyId === keyId);
  }

  /** Add (or re-label) a publisher key. Throws on a malformed key. */
  add(publicKey: string, label: string, now: number = Date.now()): TrustedPublisherKey {
    if (!isPluginPublicKey(publicKey)) throw new Error('not a valid Ed25519 public key (SPKI DER base64 expected)');
    const keyId = pluginKeyId(publicKey);
    const existing = this.keys.find((k) => k.keyId === keyId);
    if (existing) {
      existing.label = label;
      this.persist();
      return { ...existing };
    }
    const record: TrustedPublisherKey = { keyId, publicKey, label, addedAt: now };
    this.keys.push(record);
    this.persist();
    return { ...record };
  }

  /** Remove a trusted key by fingerprint. Returns true when one was removed. */
  remove(keyId: string): boolean {
    const before = this.keys.length;
    this.keys = this.keys.filter((k) => k.keyId !== keyId);
    if (this.keys.length !== before) {
      this.persist();
      return true;
    }
    return false;
  }
}

/** Keys from the KRIYADOT_PLUGIN_TRUSTED_KEYS env var (SPKI base64, comma-separated). Malformed entries are ignored, never fatal. */
export function envTrustedPluginKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.KRIYADOT_PLUGIN_TRUSTED_KEYS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => isPluginPublicKey(s));
}

/**
 * Resolve the full trusted key set for a host: built-in root + env root +
 * caller-supplied keys (e.g. a PluginTrustStore's keys). De-duplicated by
 * fingerprint.
 */
export function resolveTrustedPluginKeys(extra: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): string[] {
  const byId = new Map<string, string>();
  for (const key of [...BUILTIN_PLUGIN_TRUSTED_KEYS, ...envTrustedPluginKeys(env), ...extra]) {
    if (isPluginPublicKey(key)) byId.set(pluginKeyId(key), key);
  }
  return [...byId.values()];
}
