// SPDX-License-Identifier: Apache-2.0
// Dev tool: mint a KriyaDot enterprise license (Ed25519-signed).
//
// Usage:
//   KRIYADOT_LICENSE_PRIVATE_KEY=<pkcs8-der-base64> node scripts/make-license.mjs \
//     --org org_123 --features sso,white-label --days 365 --seats 25
//   node scripts/make-license.mjs --gen-keys   # print a fresh keypair (store the private key OUTSIDE the repo)
//
// The private key is read from env KRIYADOT_LICENSE_PRIVATE_KEY or
// --private-key <pkcs8-der-base64>. It is NEVER committed to this repo.

import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}

if (args.includes('--gen-keys')) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  console.log('public (embed in apps/api/src/license.ts):', publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
  console.log('private (store in a secret manager, NOT in git):', privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'));
  process.exit(0);
}

const pkB64 = process.env.KRIYADOT_LICENSE_PRIVATE_KEY || arg('private-key');
if (!pkB64) {
  console.error('Missing private key: set KRIYADOT_LICENSE_PRIVATE_KEY or pass --private-key. Use --gen-keys to create a dev keypair.');
  process.exit(1);
}
const org = arg('org');
if (!org) {
  console.error('--org is required');
  process.exit(1);
}
const days = Number(arg('days', '365'));
const payload = {
  org,
  features: String(arg('features', 'sso')).split(',').map((s) => s.trim()).filter(Boolean),
  expiresAt: Date.now() + days * 24 * 60 * 60 * 1000,
  seats: Number(arg('seats', '10')),
};
const signedPart = Buffer.from(JSON.stringify(payload)).toString('base64url');
const key = createPrivateKey({ key: Buffer.from(pkB64, 'base64'), format: 'der', type: 'pkcs8' });
const signature = sign(null, Buffer.from(signedPart, 'ascii'), key).toString('base64url');
console.log(`${signedPart}.${signature}`);
