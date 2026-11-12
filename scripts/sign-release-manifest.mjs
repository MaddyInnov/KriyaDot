// SPDX-License-Identifier: Apache-2.0
// Operator tool: sign a KriyaDot release manifest (Ed25519) — A14.
//
// RELEASE FLOW (the step this adds): after the release assets are built
// and BEFORE the GitHub release is published, run this script over the
// asset directory. It writes kriyadot-release-manifest.json (tag +
// per-asset size + SHA-256, signed). Upload that file as a release
// asset alongside the installers. Clients verify the manifest against
// the built-in release public key BEFORE showing any update offer —
// a release published without this asset (or with a manifest signed
// by another key) simply produces no offer on clients (fail closed).
//
// Usage:
//   node scripts/sign-release-manifest.mjs --gen-keys
//       Print a fresh release keypair. NOTE: clients only trust the
//       built-in release key of record (plus keys operators add via
//       KRIYADOT_UPDATE_TRUSTED_KEYS), so a fresh keypair is for tests
//       or a future, deliberate key rotation — not for production
//       releases until clients trust it.
//
//   KRIYADOT_RELEASE_PRIVATE_KEY=<pkcs8-der-base64> \
//   KRIYADOT_RELEASE_PUBLIC_KEY=<spki-der-base64> \
//     node scripts/sign-release-manifest.mjs --tag v0.3.0 --dir ./release-assets \
//       [--out ./release-assets/kriyadot-release-manifest.json]
//
// Keys use the same conventions as licence/plugin signing (Ed25519,
// SPKI/PKCS8 DER base64 — see scripts/make-license.mjs and
// scripts/sign-plugin.mjs). The private key is read from env or args
// only; it is NEVER committed to this repo and never written into the
// manifest (the manifest carries the public key for identification).
// This manifest signing is KriyaDot's own and does NOT involve Windows
// binary code signing (SSL.com eSigner) — that is a separate track.
// Requires @mvp/agent-runtime to be built (packages/agent-runtime/dist).

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}
function has(name) {
  return args.includes(`--${name}`);
}

let runtime;
try {
  runtime = await import('../packages/agent-runtime/dist/update-manifest.js');
} catch {
  console.error('Could not load packages/agent-runtime/dist — build it first: (cd packages/agent-runtime && npm run build)');
  process.exit(1);
}
const { createSignedReleaseManifest, generateReleaseKeyPair, RELEASE_MANIFEST_ASSET_NAME } = runtime;

if (has('gen-keys')) {
  const kp = generateReleaseKeyPair();
  console.log('keyId  :', kp.keyId);
  console.log('public (clients must trust this before it can sign production releases):', kp.publicKey);
  console.log('private (store in a secret manager, NOT in git):', kp.privateKey);
  process.exit(0);
}

const tag = arg('tag');
const dir = arg('dir');
if (!tag || !dir) {
  console.error('Usage: --tag <vX.Y.Z> --dir <asset-dir> [--out <manifest.json>] (or --gen-keys)');
  process.exit(1);
}
if (!existsSync(dir) || !statSync(dir).isDirectory()) {
  console.error(`asset directory not found: ${dir}`);
  process.exit(1);
}
const publicKey = process.env.KRIYADOT_RELEASE_PUBLIC_KEY || arg('public-key');
const privateKey = process.env.KRIYADOT_RELEASE_PRIVATE_KEY || arg('private-key');
if (!publicKey || !privateKey) {
  console.error('Missing keys: set KRIYADOT_RELEASE_PUBLIC_KEY + KRIYADOT_RELEASE_PRIVATE_KEY or pass --public-key/--private-key. Use --gen-keys to create a keypair.');
  process.exit(1);
}

const assets = [];
for (const entry of readdirSync(dir, { withFileTypes: true })) {
  if (!entry.isFile() || entry.name === RELEASE_MANIFEST_ASSET_NAME) continue;
  const data = readFileSync(join(dir, entry.name));
  assets.push({
    name: entry.name,
    size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
  });
}
if (assets.length === 0) {
  console.error(`no release assets found in ${dir}`);
  process.exit(1);
}
assets.sort((a, b) => (a.name < b.name ? -1 : 1));

const manifest = createSignedReleaseManifest(tag, assets, { publicKey, privateKey });
const out = arg('out', join(dir, RELEASE_MANIFEST_ASSET_NAME));
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`signed release manifest written: ${out}`);
console.log(`  tag: ${tag}  keyId: ${manifest.keyId}  assets: ${assets.map((a) => a.name).join(', ')}`);
console.log('Upload this file as a release asset together with the installers.');
