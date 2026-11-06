// SPDX-License-Identifier: Apache-2.0
// mint-token.mjs — operator helper: sign a Managed Apps service token with
// the front-door private key.
//
// This is how the operator issues tokens UNTIL the front door mints them
// in-product. The private key is read from the FRONTDOOR_HANDOFF_PRIVATE_KEY
// env var (a PEM; literal "\n" escapes are accepted) and is never printed.
//
// Usage:
//   FRONTDOOR_HANDOFF_PRIVATE_KEY="$(cat frontdoor-key.pem)" \
//     node scripts/mint-token.mjs --accountId acct_123 --email user@example.com \
//       --plan pro --features managed-apps --ttl 86400
//
// Flags:
//   --accountId  (required) KriyaDot account id the token acts for
//   --email      optional account email
//   --name       optional display name
//   --plan       optional plan string (e.g. pro) — drives entitlement + quota
//   --features   optional comma-separated feature list (e.g. managed-apps)
//   --ttl        optional token lifetime in seconds (default 3600)
//
// The token is printed to stdout, alone, so it can be piped or captured.

import { createPrivateKey, sign } from 'node:crypto';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      out[key] = value;
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rawKey = process.env.FRONTDOOR_HANDOFF_PRIVATE_KEY;
  if (!rawKey || !rawKey.trim()) {
    console.error('error: FRONTDOOR_HANDOFF_PRIVATE_KEY env var is required (front-door Ed25519 private key PEM)');
    process.exit(1);
  }
  const accountId = typeof args.accountId === 'string' ? args.accountId : '';
  if (!accountId) {
    console.error('error: --accountId is required');
    process.exit(1);
  }
  const ttl = Number(args.ttl ?? 3600);
  if (!Number.isFinite(ttl) || ttl <= 0) {
    console.error('error: --ttl must be a positive number of seconds');
    process.exit(1);
  }
  const features =
    typeof args.features === 'string' && args.features !== 'true'
      ? args.features.split(',').map((f) => f.trim()).filter(Boolean)
      : undefined;

  const iat = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    iss: 'kriyadot-frontdoor',
    accountId,
    ...(typeof args.email === 'string' && args.email !== 'true' ? { email: args.email } : {}),
    ...(typeof args.name === 'string' && args.name !== 'true' ? { name: args.name } : {}),
    ...(typeof args.plan === 'string' && args.plan !== 'true' ? { plan: args.plan } : {}),
    ...(features && features.length ? { features } : {}),
    iat,
    exp: iat + Math.floor(ttl),
  };

  const pem = rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey;
  const privateKey = createPrivateKey(pem);
  const payloadSegment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = sign(null, Buffer.from(payloadSegment, 'ascii'), privateKey);
  process.stdout.write(`${payloadSegment}.${Buffer.from(signature).toString('base64url')}\n`);
}

main();
