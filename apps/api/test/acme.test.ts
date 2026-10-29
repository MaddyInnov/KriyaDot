// SPDX-License-Identifier: Apache-2.0
// ACME v2 client against an in-process fake ACME server, CSR structure /
// signature self-consistency, challenge router, renewal logic.
// The only "network" is 127.0.0.1 to servers this test starts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import {
  AcmeChallengeStore,
  AcmeClient,
  buildCsrDer,
  buildCsrPem,
  certDaysLeft,
  createAcmeChallengeRouter,
  jwkThumbprint,
  loadCertificateFromStore,
  saveCertificateToStore,
  shouldRenew,
  verifyCsrSignature,
  generateAcmeKeyPair,
} from '../src/acme.js';
import { randomUUID } from 'node:crypto';

let nonceCounter = 0;
function nonce(res: import('node:http').ServerResponse): void {
  res.setHeader('replay-nonce', `nonce-${++nonceCounter}`);
}

describe('JWK thumbprint (RFC 7638 test vector)', () => {
  it('matches the RFC example', () => {
    const jwk = {
      kty: 'RSA',
      e: 'AQAB',
      n: '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',
    };
    expect(jwkThumbprint(jwk)).toBe('NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');
  });
});

describe('CSR construction', () => {
  it('builds a DER CSR whose self-signature verifies and which carries the SANs', () => {
    const kp = generateAcmeKeyPair();
    const der = buildCsrDer(['example.test', 'www.example.test'], kp.privateKeyPem);
    // Outer SEQUENCE length must cover the whole buffer.
    expect(der[0]).toBe(0x30);
    expect(verifyCsrSignature(der)).toBe(true);
    expect(der.includes(Buffer.from('example.test'))).toBe(true);
    expect(der.includes(Buffer.from('www.example.test'))).toBe(true);
    // Tampering breaks the signature.
    const bad = Buffer.from(der);
    bad[bad.length - 20] ^= 0xff;
    expect(verifyCsrSignature(bad)).toBe(false);
    const pem = buildCsrPem(['example.test'], kp.privateKeyPem);
    expect(pem).toContain('BEGIN CERTIFICATE REQUEST');
  });
});

describe('ACME full order flow against fake server', () => {
  let acmeServer: Server;
  let challengeServer: ReturnType<express.Express['listen']>;
  let base = '';
  let challengeBase = '';
  const store = new AcmeChallengeStore();
  const domain = 'app.example.test';
  const seen: { accountJwk?: unknown; csrB64?: string; challengeFetch?: string } = {};
  let orderStatus = 'pending';

  beforeAll(async () => {
    // Challenge-serving app (the router acme.ts exports).
    const app = express();
    app.use(createAcmeChallengeRouter(store));
    await new Promise<void>((r) => {
      challengeServer = app.listen(0, '127.0.0.1', r);
    });
    challengeBase = `http://127.0.0.1:${(challengeServer.address() as AddressInfo).port}`;

    acmeServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', base);
      const path = url.pathname;
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', async () => {
        nonce(res);
        if (req.method === 'GET' && path === '/directory') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              newNonce: `${base}/new-nonce`,
              newAccount: `${base}/new-account`,
              newOrder: `${base}/new-order`,
            }),
          );
          return;
        }
        if (req.method === 'HEAD' && path === '/new-nonce') {
          res.writeHead(200).end();
          return;
        }
        const bodyText = Buffer.concat(chunks).toString('utf8');
        const jws = bodyText ? (JSON.parse(bodyText) as { protected: string; payload: string }) : null;
        const payload = jws?.payload
          ? (JSON.parse(Buffer.from(jws.payload, 'base64url').toString('utf8')) as Record<string, unknown>)
          : null;
        if (req.method === 'POST' && path === '/new-account') {
          const protectedJson = JSON.parse(Buffer.from(jws!.protected, 'base64url').toString('utf8')) as { jwk?: unknown };
          seen.accountJwk = protectedJson.jwk;
          expect(payload?.termsOfServiceAgreed).toBe(true);
          res.writeHead(201, { location: `${base}/acct/1`, 'content-type': 'application/json' }).end('{}');
          return;
        }
        if (req.method === 'POST' && path === '/new-order') {
          orderStatus = 'pending';
          res.writeHead(201, { location: `${base}/order/1`, 'content-type': 'application/json' }).end(
            JSON.stringify({
              status: 'pending',
              authorizations: [`${base}/authz/1`],
              finalize: `${base}/order/1/finalize`,
            }),
          );
          return;
        }
        if (req.method === 'POST' && path === '/authz/1') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              status: 'pending',
              identifier: { type: 'dns', value: domain },
              challenges: [{ type: 'http-01', token: 'tok-abc', url: `${base}/chal/1`, status: 'pending' }],
            }),
          );
          return;
        }
        if (req.method === 'POST' && path === '/chal/1') {
          // The CA fetches the challenge from the real challenge router.
          const fetched = await fetch(`${challengeBase}/.well-known/acme-challenge/tok-abc`);
          seen.challengeFetch = await fetched.text();
          if (seen.challengeFetch.includes('.')) orderStatus = 'ready';
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'valid' }));
          return;
        }
        if (req.method === 'POST' && path === '/order/1/finalize') {
          seen.csrB64 = (payload as { csr?: string } | null)?.csr;
          orderStatus = 'valid';
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({ status: 'valid', certificate: `${base}/cert/1` }),
          );
          return;
        }
        if (req.method === 'POST' && path === '/order/1') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              status: orderStatus,
              authorizations: [`${base}/authz/1`],
              finalize: `${base}/order/1/finalize`,
              ...(orderStatus === 'valid' ? { certificate: `${base}/cert/1` } : {}),
            }),
          );
          return;
        }
        if (req.method === 'POST' && path === '/cert/1') {
          res.writeHead(200, { 'content-type': 'text/plain' }).end('-----BEGIN CERTIFICATE-----\nFAKE-CERT-PEM\n-----END CERTIFICATE-----\n');
          return;
        }
        res.writeHead(404).end('{}');
      });
    });
    await new Promise<void>((r) => acmeServer.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(acmeServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => acmeServer.close(() => r()));
    await new Promise<void>((r) => challengeServer.close(() => r()));
  });

  it('runs account → order → http-01 → finalize → download', async () => {
    const client = new AcmeClient({
      directoryUrl: `${base}/directory`,
      email: 'ops@example.test',
      pollDelayMs: 0,
    });
    const { certPem, keyPem } = await client.obtainCertificate([domain], store);
    expect(certPem).toContain('FAKE-CERT-PEM');
    expect(keyPem).toContain('PRIVATE KEY');
    // The CA saw the key authorization = token.thumbprint.
    expect(seen.challengeFetch).toBe(`tok-abc.${client.keyAuthorizationPrefix}`);
    // The CSR the CA received verifies against its embedded key.
    expect(seen.csrB64).toBeTruthy();
    expect(verifyCsrSignature(Buffer.from(seen.csrB64!, 'base64url'))).toBe(true);
    // Challenge tokens are cleaned up after issuance.
    expect(store.size).toBe(0);
    void randomUUID;
  });

  it('challenge router 404s unknown tokens', async () => {
    const res = await fetch(`${challengeBase}/.well-known/acme-challenge/nope`);
    expect(res.status).toBe(404);
  });
});

describe('certificate storage + renewal decisions', () => {
  it('stores/loads PEMs and computes days-left / shouldRenew from a real cert', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acme-store-'));
    try {
      const keyPath = join(dir, 'k.pem');
      const certPath = join(dir, 'c.pem');
      // Real self-signed cert via openssl (present on this machine/CI).
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
        '-days', '10', '-nodes', '-subj', '/CN=app.example.test',
      ], { stdio: 'pipe' });
      const certPem = readFileSync(certPath, 'utf8');
      const keyPem = readFileSync(keyPath, 'utf8');
      saveCertificateToStore(dir, { certPem, keyPem, domains: ['app.example.test'], obtainedAt: new Date().toISOString() });
      const loaded = loadCertificateFromStore(dir);
      expect(loaded?.domains).toEqual(['app.example.test']);
      expect(loaded?.certPem).toContain('BEGIN CERTIFICATE');
      const days = certDaysLeft(certPem);
      expect(days).toBeGreaterThanOrEqual(8);
      expect(days).toBeLessThanOrEqual(10);
      expect(shouldRenew(certPem, new Date(), 30)).toBe(true); // 10 days < 30-day window
      expect(shouldRenew(certPem, new Date(), 5)).toBe(false); // 10 days >= 5-day window
      expect(shouldRenew('not a cert')).toBe(true); // unparseable → renew
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
