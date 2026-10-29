// SPDX-License-Identifier: Apache-2.0
// TLS options for the API server bootstrap.
//
// INTEGRATION POINT (parent applies — this file deliberately does not
// edit index.ts / cli.ts): in apps/api/src/index.ts, the server is
// created at the end of boot() as:
//
//   const server = app.listen(config.port, '127.0.0.1', () => { ... });
//
// To serve HTTPS instead, replace that one call with:
//
//   import { buildTlsOptions } from './tls-options.js';
//   import { createServer } from 'node:https';
//   const tls = buildTlsOptionsFromEnv();
//   const server = tls
//     ? createServer(tls, app).listen(config.port, '127.0.0.1', () => { ... })
//     : app.listen(config.port, '127.0.0.1', () => { ... });
//
// Everything downstream (the 'upgrade' handler etc.) attaches to
// `server` exactly as today. Static key/cert paths win; otherwise the
// ACME store (acme.ts saveCertificateToStore layout) is consulted.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCertificateFromStore } from './acme.js';

export interface TlsConfig {
  /** Static certificate chain PEM path. */
  certPath?: string;
  /** Static private key PEM path. */
  keyPath?: string;
  /** ACME store dir (fullchain.pem + privkey.pem written by acme.ts). */
  acmeStoreDir?: string;
}

/** Returns { key, cert } buffers for https.createServer, or undefined for plain HTTP. */
export function buildTlsOptions(config: TlsConfig): { key: Buffer; cert: Buffer } | undefined {
  if (config.certPath && config.keyPath) {
    if (existsSync(config.certPath) && existsSync(config.keyPath)) {
      return {
        cert: readFileSync(config.certPath),
        key: readFileSync(config.keyPath),
      };
    }
    return undefined;
  }
  if (config.acmeStoreDir) {
    const stored = loadCertificateFromStore(config.acmeStoreDir);
    if (stored) {
      return { cert: Buffer.from(stored.certPem, 'utf8'), key: Buffer.from(stored.keyPem, 'utf8') };
    }
  }
  return undefined;
}

/**
 * Env-driven variant:
 *   TLS_CERT_PATH + TLS_KEY_PATH — static files
 *   ACME_STORE_DIR               — acme.ts certificate store directory
 *   TLS_ACME_DIR                   — alias for ACME_STORE_DIR
 */
export function buildTlsOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): { key: Buffer; cert: Buffer } | undefined {
  const certPath = (env.TLS_CERT_PATH ?? '').trim() || undefined;
  const keyPath = (env.TLS_KEY_PATH ?? '').trim() || undefined;
  const acmeStoreDir =
    (env.ACME_STORE_DIR ?? '').trim() || (env.TLS_ACME_DIR ?? '').trim() || undefined;
  return buildTlsOptions({ certPath, keyPath, acmeStoreDir });
}

/** Conventional ACME store dir under a data dir: <dataDir>/acme. */
export function defaultAcmeStoreDir(dataDir: string): string {
  return join(dataDir, 'acme');
}
