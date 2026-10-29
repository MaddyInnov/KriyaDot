// SPDX-License-Identifier: Apache-2.0
// ACME v2 client (RFC 8555, public protocol) for built-in TLS:
// account creation (JWK thumbprint), newOrder, http-01 challenges served
// from a token store, finalize with a hand-built PKCS#10 CSR (original
// ASN.1 DER code below — no CSR library), certificate download, PEM
// storage and renewal checks. Default directory is Let's Encrypt STAGING;
// production must be opted into explicitly via config.

import {
  createHash,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
  X509Certificate,
} from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Request, type Response, type Router } from 'express';

export const LETS_ENCRYPT_STAGING_DIRECTORY = 'https://acme-staging-v02.api.letsencrypt.org/directory';
export const LETS_ENCRYPT_PRODUCTION_DIRECTORY = 'https://acme-v02.api.letsencrypt.org/directory';

// ---------------------------------------------------------------------------
// base64url + JWK thumbprint (RFC 7638)
// ---------------------------------------------------------------------------

export function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString('base64url');
}

export interface RsaJwk {
  kty: string;
  n: string;
  e: string;
}

export function jwkFromPublicKey(publicKeyPem: string): RsaJwk {
  const jwk = createPublicKey(publicKeyPem).export({ format: 'jwk' }) as RsaJwk;
  return { kty: jwk.kty, n: jwk.n, e: jwk.e };
}

/** RFC 7638 thumbprint: SHA-256 of the canonical required-members JSON. */
export function jwkThumbprint(jwk: RsaJwk): string {
  const canonical = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
  return createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

export function generateAcmeKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

// ---------------------------------------------------------------------------
// Minimal ASN.1 DER writer (original) + a tiny reader for verification
// ---------------------------------------------------------------------------

function derLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function derTlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}
export const derSeq = (...parts: Buffer[]): Buffer => derTlv(0x30, Buffer.concat(parts));
export const derSet = (...parts: Buffer[]): Buffer => derTlv(0x31, Buffer.concat(parts));
export const derOctetString = (data: Buffer): Buffer => derTlv(0x04, data);
export const derUtf8 = (s: string): Buffer => derTlv(0x0c, Buffer.from(s, 'utf8'));
export const derIa5 = (s: string): Buffer => derTlv(0x16, Buffer.from(s, 'ascii'));
export const derNull = (): Buffer => Buffer.from([0x05, 0x00]);

export function derOid(arcs: number[]): Buffer {
  const bytes: number[] = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const stack: number[] = [arc & 0x7f];
    let n = arc >> 7;
    while (n > 0) {
      stack.unshift(0x80 | (n & 0x7f));
      n >>= 7;
    }
    bytes.push(...stack);
  }
  return derTlv(0x06, Buffer.from(bytes));
}

export function derInteger(value: number): Buffer {
  let bytes: number[] = [];
  let n = value;
  if (n === 0) bytes = [0];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  if (bytes[0] & 0x80) bytes.unshift(0);
  return derTlv(0x02, Buffer.from(bytes));
}

export function derBitString(data: Buffer): Buffer {
  return derTlv(0x03, Buffer.concat([Buffer.from([0]), data]));
}

/** Read one DER element at offset. Returns tag, content range, total length. */
export function readDerElement(buf: Buffer, offset = 0): { tag: number; contentStart: number; contentLength: number; totalLength: number } {
  const tag = buf[offset];
  let pos = offset + 1;
  const first = buf[pos++];
  let length: number;
  if (first < 0x80) {
    length = first;
  } else {
    const nBytes = first & 0x7f;
    length = 0;
    for (let i = 0; i < nBytes; i++) length = (length << 8) | buf[pos++];
  }
  return { tag, contentStart: pos, contentLength: length, totalLength: pos - offset + length };
}

// ---------------------------------------------------------------------------
// PKCS#10 CSR (RFC 2986), hand-built
// ---------------------------------------------------------------------------

const OID_SHA256_WITH_RSA = [1, 2, 840, 113549, 1, 1, 11];
const OID_COMMON_NAME = [2, 5, 4, 3];
const OID_EXTENSION_REQUEST = [1, 2, 840, 113549, 1, 9, 14];
const OID_SUBJECT_ALT_NAME = [2, 5, 29, 17];

/**
 * Build a PKCS#10 CertificationRequest (DER) for `domains` signed with
 * `privateKeyPem` (RSA, sha256WithRSAEncryption). Subject CN = first
 * domain; subjectAltName extension carries every domain.
 */
export function buildCsrDer(domains: string[], privateKeyPem: string): Buffer {
  if (domains.length === 0) throw new Error('CSR requires at least one domain');
  const publicKey = createPublicKey(privateKeyPem);
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;

  // Name ::= RDNSequence with one RDN { CN = domains[0] }
  const subject = derSeq(derSet(derSeq(derOid(OID_COMMON_NAME), derUtf8(domains[0]))));

  // subjectAltName ::= SEQUENCE OF dNSName ([2] IA5String, primitive)
  const sanValue = derSeq(...domains.map((d) => derTlv(0x82, Buffer.from(d, 'ascii'))));
  const sanExtension = derSeq(derOid(OID_SUBJECT_ALT_NAME), derOctetString(sanValue));
  const extensionRequest = derSeq(derOid(OID_EXTENSION_REQUEST), derSet(derSeq(sanExtension)));
  // Attributes are [0] IMPLICIT SET OF — tag A0 wraps the attribute values.
  const attributes = derTlv(0xa0, extensionRequest);

  // Version is [0] EXPLICIT INTEGER 0 in CertificationRequestInfo.
  const version = derTlv(0xa0, derInteger(0));
  const requestInfo = derSeq(version, subject, spki, attributes);

  const signature = createSign('sha256').update(requestInfo).sign(privateKeyPem);
  const algId = derSeq(derOid(OID_SHA256_WITH_RSA), derNull());
  return derSeq(requestInfo, algId, derBitString(signature));
}

export function buildCsrPem(domains: string[], privateKeyPem: string): string {
  const der = buildCsrDer(domains, privateKeyPem);
  const b64 = der.toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE REQUEST-----\n${lines.join('\n')}\n-----END CERTIFICATE REQUEST-----\n`;
}

/**
 * Verify a CSR's self-signature: parse the outer SEQUENCE, re-sign-check
 * the CertificationRequestInfo bytes against the BIT STRING signature
 * using the SPKI embedded in the request info itself.
 */
export function verifyCsrSignature(csrDer: Buffer): boolean {
  try {
    const outer = readDerElement(csrDer, 0);
    if (outer.tag !== 0x30) return false;
    const infoEl = readDerElement(csrDer, outer.contentStart);
    const infoBytes = csrDer.subarray(outer.contentStart, outer.contentStart + infoEl.totalLength);
    const algStart = outer.contentStart + infoEl.totalLength;
    const algEl = readDerElement(csrDer, algStart);
    const sigStart = algStart + algEl.totalLength;
    const sigEl = readDerElement(csrDer, sigStart);
    if (sigEl.tag !== 0x03) return false;
    const signature = csrDer.subarray(sigEl.contentStart + 1, sigEl.contentStart + sigEl.contentLength);
    // SPKI is the 3rd element of CertificationRequestInfo: version [0], subject, spki.
    const info = readDerElement(infoBytes, 0);
    let cursor = info.contentStart;
    for (let i = 0; i < 2; i++) cursor += readDerElement(infoBytes, cursor).totalLength;
    const spkiEl = readDerElement(infoBytes, cursor);
    const spkiDer = infoBytes.subarray(cursor, cursor + spkiEl.totalLength);
    const publicKey = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
    return createVerify('sha256').update(infoBytes).verify(publicKey, signature);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// http-01 challenge token store + serving router
// ---------------------------------------------------------------------------

export class AcmeChallengeStore {
  private readonly tokens = new Map<string, string>();

  set(token: string, keyAuthorization: string): void {
    this.tokens.set(token, keyAuthorization);
  }
  get(token: string): string | undefined {
    return this.tokens.get(token);
  }
  delete(token: string): void {
    this.tokens.delete(token);
  }
  get size(): number {
    return this.tokens.size;
  }
}

/**
 * Router serving http-01 challenges. Mount at the app ROOT (not under
 * /api) so Let's Encrypt can reach /.well-known/acme-challenge/<token>:
 *   app.use(createAcmeChallengeRouter(acmeChallengeStore));
 */
export function createAcmeChallengeRouter(store: AcmeChallengeStore): Router {
  const router = express.Router();
  router.get('/.well-known/acme-challenge/:token', (req: Request, res: Response) => {
    const keyAuth = store.get(req.params.token);
    if (!keyAuth) {
      res.status(404).type('text/plain').send('unknown challenge token');
      return;
    }
    res.type('text/plain').send(keyAuth);
  });
  return router;
}

// ---------------------------------------------------------------------------
// ACME client
// ---------------------------------------------------------------------------

export interface AcmeClientOptions {
  directoryUrl?: string;
  /** Account key (RSA PEM). Generated when omitted — persist it via getAccountKeyPem(). */
  accountKeyPem?: string;
  email?: string;
  fetchFn?: typeof fetch;
  /** Poll delay between order status checks. Default 1000ms (tests pass 0). */
  pollDelayMs?: number;
  maxPollAttempts?: number;
}

export interface AcmeOrder {
  status: string;
  authorizations: string[];
  finalize: string;
  certificate?: string;
  location: string;
  expires?: string;
}

interface AcmeDirectory {
  newNonce: string;
  newAccount: string;
  newOrder: string;
}

export class AcmeClient {
  private readonly directoryUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly pollDelayMs: number;
  private readonly maxPollAttempts: number;
  private readonly email?: string;
  readonly accountKeyPem: string;
  private readonly publicKeyPem: string;
  private directory: AcmeDirectory | null = null;
  private nonce: string | null = null;
  private accountUrl: string | null = null;

  constructor(opts: AcmeClientOptions = {}) {
    this.directoryUrl = opts.directoryUrl ?? LETS_ENCRYPT_STAGING_DIRECTORY;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.pollDelayMs = opts.pollDelayMs ?? 1000;
    this.maxPollAttempts = opts.maxPollAttempts ?? 30;
    this.email = opts.email;
    if (opts.accountKeyPem) {
      this.accountKeyPem = opts.accountKeyPem;
      this.publicKeyPem = createPublicKey(opts.accountKeyPem).export({ type: 'spki', format: 'pem' }).toString();
    } else {
      const kp = generateAcmeKeyPair();
      this.accountKeyPem = kp.privateKeyPem;
      this.publicKeyPem = kp.publicKeyPem;
    }
  }

  getAccountKeyPem(): string {
    return this.accountKeyPem;
  }

  get keyAuthorizationPrefix(): string {
    return jwkThumbprint(jwkFromPublicKey(this.publicKeyPem));
  }

  /** keyAuthorization for an http-01 token: "<token>.<thumbprint>". */
  keyAuthorization(token: string): string {
    return `${token}.${this.keyAuthorizationPrefix}`;
  }

  private async loadDirectory(): Promise<AcmeDirectory> {
    if (this.directory) return this.directory;
    const res = await this.fetchFn(this.directoryUrl);
    if (!res.ok) throw new Error(`ACME directory fetch failed: ${res.status}`);
    const json = (await res.json()) as Record<string, string>;
    this.directory = { newNonce: json.newNonce, newAccount: json.newAccount, newOrder: json.newOrder };
    return this.directory;
  }

  private async freshNonce(): Promise<string> {
    const dir = await this.loadDirectory();
    const res = await this.fetchFn(dir.newNonce, { method: 'HEAD' });
    const nonce = res.headers.get('replay-nonce');
    if (!nonce) throw new Error('ACME server returned no Replay-Nonce');
    this.nonce = nonce;
    return nonce;
  }

  /** JWS-signed POST (RFC 8555 §6.2). payload null = POST-as-GET. */
  private async post(url: string, payload: unknown): Promise<{ status: number; headers: Headers; body: unknown; text: string }> {
    const nonce = this.nonce ?? (await this.freshNonce());
    const jwk = jwkFromPublicKey(this.publicKeyPem);
    const protectedHeader: Record<string, unknown> = {
      alg: 'RS256',
      nonce,
      url,
      ...(this.accountUrl ? { kid: this.accountUrl } : { jwk }),
    };
    const protectedB64 = b64url(JSON.stringify(protectedHeader));
    const payloadB64 = payload === null ? '' : b64url(JSON.stringify(payload));
    const signingInput = `${protectedB64}.${payloadB64}`;
    const signature = createSign('sha256').update(signingInput, 'ascii').sign(this.accountKeyPem, 'base64url');
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/jose+json' },
      body: JSON.stringify({ protected: protectedB64, payload: payloadB64, signature }),
    });
    this.nonce = res.headers.get('replay-nonce') ?? null;
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (!res.ok) {
      const detail = (body as { detail?: string } | null)?.detail ?? text.slice(0, 300);
      throw new Error(`ACME POST ${url} failed (${res.status}): ${detail}`);
    }
    return { status: res.status, headers: res.headers, body, text };
  }

  async createAccount(): Promise<string> {
    if (this.accountUrl) return this.accountUrl;
    const dir = await this.loadDirectory();
    const payload: Record<string, unknown> = { termsOfServiceAgreed: true };
    if (this.email) payload.contact = [`mailto:${this.email}`];
    const res = await this.post(dir.newAccount, payload);
    const location = res.headers.get('location');
    if (!location) throw new Error('ACME newAccount response has no Location (account URL)');
    this.accountUrl = location;
    return location;
  }

  async createOrder(domains: string[]): Promise<AcmeOrder> {
    await this.createAccount();
    const dir = await this.loadDirectory();
    const res = await this.post(dir.newOrder, {
      identifiers: domains.map((d) => ({ type: 'dns', value: d })),
    });
    const body = res.body as Omit<AcmeOrder, 'location'>;
    return { ...body, location: res.headers.get('location') ?? '' };
  }

  async getAuthorization(authzUrl: string): Promise<{
    status: string;
    identifier: string;
    http01?: { token: string; url: string };
  }> {
    const res = await this.post(authzUrl, null);
    const body = res.body as {
      status: string;
      identifier?: { value?: string };
      challenges?: Array<{ type: string; token: string; url: string }>;
    };
    const http01 = body.challenges?.find((c) => c.type === 'http-01');
    return {
      status: body.status,
      identifier: body.identifier?.value ?? '',
      http01: http01 ? { token: http01.token, url: http01.url } : undefined,
    };
  }

  async acceptChallenge(challengeUrl: string): Promise<void> {
    await this.post(challengeUrl, {});
  }

  async getOrder(orderUrl: string): Promise<AcmeOrder> {
    const res = await this.post(orderUrl, null);
    const body = res.body as Omit<AcmeOrder, 'location'>;
    return { ...body, location: orderUrl };
  }

  async finalizeOrder(finalizeUrl: string, csrDer: Buffer): Promise<AcmeOrder> {
    const res = await this.post(finalizeUrl, { csr: csrDer.toString('base64url') });
    const body = res.body as Omit<AcmeOrder, 'location'>;
    return { ...body, location: res.headers.get('location') ?? '' };
  }

  async downloadCertificate(certUrl: string): Promise<string> {
    const res = await this.post(certUrl, null);
    return res.text;
  }

  private async sleep(): Promise<void> {
    if (this.pollDelayMs > 0) await new Promise((r) => setTimeout(r, this.pollDelayMs));
  }

  /**
   * Full issuance flow: account → order → serve http-01 challenges from
   * `challengeStore` → accept → finalize with a fresh domain key + CSR →
   * download. The domain key is generated here and returned so the caller
   * can persist it next to the certificate (see saveCertificateToStore).
   */
  async obtainCertificate(
    domains: string[],
    challengeStore: AcmeChallengeStore,
  ): Promise<{ certPem: string; keyPem: string; order: AcmeOrder }> {
    const order = await this.createOrder(domains);
    const servedTokens: string[] = [];
    try {
      for (const authzUrl of order.authorizations) {
        const authz = await this.getAuthorization(authzUrl);
        if (authz.status === 'valid') continue;
        if (!authz.http01) throw new Error(`no http-01 challenge offered for ${authz.identifier}`);
        challengeStore.set(authz.http01.token, this.keyAuthorization(authz.http01.token));
        servedTokens.push(authz.http01.token);
        await this.acceptChallenge(authz.http01.url);
      }
      return await this.completeOrder(order, domains);
    } finally {
      // Tokens stay in the store until the order leaves the validation
      // stage (completeOrder polls to ready/valid), then are removed.
      for (const token of servedTokens) challengeStore.delete(token);
    }
  }

  private async completeOrder(
    order: AcmeOrder,
    domains: string[],
  ): Promise<{ certPem: string; keyPem: string; order: AcmeOrder }> {
    let current = order;
    for (let i = 0; i < this.maxPollAttempts && current.status !== 'ready' && current.status !== 'valid'; i++) {
      if (current.status === 'invalid') throw new Error('ACME order became invalid during validation');
      await this.sleep();
      current = await this.getOrder(order.location);
    }
    if (current.status !== 'ready' && current.status !== 'valid') {
      throw new Error(`ACME order did not become ready (status: ${current.status})`);
    }
    const domainKey = generateAcmeKeyPair();
    const csrDer = buildCsrDer(domains, domainKey.privateKeyPem);
    let final = await this.finalizeOrder(current.finalize, csrDer);
    for (let i = 0; i < this.maxPollAttempts && final.status !== 'valid'; i++) {
      if (final.status === 'invalid') throw new Error('ACME order became invalid at finalize');
      await this.sleep();
      final = await this.getOrder(order.location);
    }
    if (final.status !== 'valid' || !final.certificate) {
      throw new Error(`ACME order did not finalize (status: ${final.status})`);
    }
    const certPem = await this.downloadCertificate(final.certificate);
    return { certPem, keyPem: domainKey.privateKeyPem, order: final };
  }
}

// ---------------------------------------------------------------------------
// Certificate storage + renewal
// ---------------------------------------------------------------------------

export interface StoredCertificate {
  certPem: string;
  keyPem: string;
  domains: string[];
  obtainedAt: string;
}

/** Store layout inside the ACME store dir: fullchain.pem, privkey.pem, acme-meta.json. */
export function saveCertificateToStore(storeDir: string, cert: StoredCertificate): void {
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, 'fullchain.pem'), cert.certPem, 'utf8');
  writeFileSync(join(storeDir, 'privkey.pem'), cert.keyPem, { encoding: 'utf8', mode: 0o600 });
  writeFileSync(
    join(storeDir, 'acme-meta.json'),
    JSON.stringify({ domains: cert.domains, obtainedAt: cert.obtainedAt }, null, 2),
    'utf8',
  );
}

export function loadCertificateFromStore(storeDir: string): StoredCertificate | null {
  const certPath = join(storeDir, 'fullchain.pem');
  const keyPath = join(storeDir, 'privkey.pem');
  if (!existsSync(certPath) || !existsSync(keyPath)) return null;
  let domains: string[] = [];
  let obtainedAt = '';
  try {
    const meta = JSON.parse(readFileSync(join(storeDir, 'acme-meta.json'), 'utf8')) as {
      domains?: string[];
      obtainedAt?: string;
    };
    domains = meta.domains ?? [];
    obtainedAt = meta.obtainedAt ?? '';
  } catch { /* meta is advisory */ }
  return {
    certPem: readFileSync(certPath, 'utf8'),
    keyPem: readFileSync(keyPath, 'utf8'),
    domains,
    obtainedAt,
  };
}

/** Whole days until the certificate's notAfter (negative = expired). */
export function certDaysLeft(certPem: string, now: Date = new Date()): number {
  const cert = new X509Certificate(certPem);
  const validTo = new Date(cert.validTo);
  return Math.floor((validTo.getTime() - now.getTime()) / 86_400_000);
}

/** Renew when fewer than `renewBeforeDays` (default 30) remain. */
export function shouldRenew(certPem: string, now: Date = new Date(), renewBeforeDays = 30): boolean {
  try {
    return certDaysLeft(certPem, now) < renewBeforeDays;
  } catch {
    return true; // unparseable cert → renew
  }
}
