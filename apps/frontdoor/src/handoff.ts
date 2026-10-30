// SPDX-License-Identifier: Apache-2.0
// Handoff tokens: Ed25519-signed, short-lived (120s), minted by the
// frontdoor so a signed-in user lands in their own instance already
// authenticated. Format (fixed contract):
//   base64url(JSON payload) + "." + base64url(signature over payload segment)
// Payload: { v:1, iss:"kriyadot-frontdoor", accountId, email, name?,
//            instanceUrl, nonce (16B random, b64url), iat, exp } (seconds).

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface HandoffPayload {
  v: 1;
  iss: 'kriyadot-frontdoor';
  accountId: string;
  email: string;
  name?: string;
  instanceUrl: string;
  nonce: string;
  iat: number;
  exp: number;
}

export interface HandoffKeys {
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeyPem: string;
  /** True when no key was configured and a boot-time ephemeral pair is in use. */
  ephemeral: boolean;
}

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString('base64url');
}

export function loadHandoffKeys(opts: {
  pem?: string;
  keyFile?: string;
  log?: (msg: string) => void;
}): HandoffKeys {
  const log = opts.log ?? (() => undefined);
  let pem: string | undefined;
  if (opts.pem) {
    // Env-carried PEMs often arrive with literal "\n" escapes.
    pem = opts.pem.includes('\\n') ? opts.pem.replace(/\\n/g, '\n') : opts.pem;
  } else if (opts.keyFile) {
    pem = readFileSync(opts.keyFile, 'utf8');
  }
  if (pem) {
    const privateKey = createPrivateKey(pem);
    const publicKey = createPublicKey(privateKey);
    return { privateKey, publicKey, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), ephemeral: false };
  }
  const pair = generateKeyPairSync('ed25519');
  log(
    '[frontdoor] WARNING: no handoff signing key configured ' +
      '(FRONTDOOR_HANDOFF_PRIVATE_KEY / FRONTDOOR_HANDOFF_KEY_FILE) — generated an EPHEMERAL keypair. ' +
      'Handoff tokens will stop verifying when this process restarts. The public key is exposed at ' +
      'GET /api/handoff/public-key for development pinning; production instances should pin it via env.',
  );
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    ephemeral: true,
  };
}

export function mintHandoffToken(
  keys: HandoffKeys,
  input: { accountId: string; email: string; name?: string; instanceUrl: string },
): { token: string; payload: HandoffPayload; expiresAt: string } {
  const iat = Math.floor(Date.now() / 1000);
  const payload: HandoffPayload = {
    v: 1,
    iss: 'kriyadot-frontdoor',
    accountId: input.accountId,
    email: input.email,
    ...(input.name ? { name: input.name } : {}),
    instanceUrl: input.instanceUrl,
    nonce: b64url(randomBytes(16)),
    iat,
    exp: iat + 120,
  };
  const payloadSegment = b64url(JSON.stringify(payload));
  const signature = sign(null, Buffer.from(payloadSegment, 'utf8'), keys.privateKey);
  return {
    token: `${payloadSegment}.${b64url(signature)}`,
    payload,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  };
}

/** Verify a handoff token against a PEM public key. Returns the payload or null. */
export function verifyHandoffToken(token: string, publicKeyPem: string, nowSeconds?: number): HandoffPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadSegment, signatureSegment] = parts as [string, string];
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch {
    return null;
  }
  const ok = verify(null, Buffer.from(payloadSegment, 'utf8'), publicKey, Buffer.from(signatureSegment, 'base64url'));
  if (!ok) return null;
  let payload: HandoffPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as HandoffPayload;
  } catch {
    return null;
  }
  if (payload.v !== 1 || payload.iss !== 'kriyadot-frontdoor') return null;
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
  return payload;
}
