// SPDX-License-Identifier: Apache-2.0
// Runtime configuration: env vars with sane defaults. Everything the server
// needs to boot is derived here so routes stay free of process.env reads.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

export interface AppConfig {
  port: number;
  dataDir: string;
  seedDir: string;
  skillsDir: string;
  workspaceDir: string;
  webOutDir: string;
  /**
   * Public base URL for hosted deployments, from SARVIQ_PUBLIC_URL
   * (e.g. "https://sarviq.example.com"). When set, the companion app's
   * pairing QR encodes this URL so phones can pair over the internet
   * instead of the LAN. When unset, pairing stays LAN-only (zero-config).
   */
  publicBaseUrl?: string;
}

function resolveDir(envValue: string | undefined, fallback: string): string {
  return envValue ? path.resolve(envValue) : fallback;
}

/**
 * Normalize SARVIQ_PUBLIC_URL: trim, drop trailing slashes, require an
 * http(s) scheme and a non-empty host. Returns undefined (with a warning)
 * for anything else — pairing then stays LAN-only.
 */
export function parsePublicBaseUrl(raw: string | undefined): string | undefined {
  if (!raw || !raw.trim()) return undefined;
  const v = raw.trim().replace(/\/+$/, '');
  const m = /^(https?):\/\/([^/\s]+)(\/\S*)?$/i.exec(v);
  if (!m) {
    console.warn(`[config] ignoring invalid SARVIQ_PUBLIC_URL — expected like "https://sarviq.example.com"`);
    return undefined;
  }
  const scheme = m[1].toLowerCase();
  if (scheme !== 'https') {
    console.warn(
      '[config] SARVIQ_PUBLIC_URL is not https — companion device tokens would travel in cleartext. Use https in production.',
    );
  }
  return `${scheme}://${m[2].toLowerCase()}${m[3] ?? ''}`;
}

/**
 * Port resolution order: `--port <n>` CLI arg (the Tauri sidecar spawns the
 * API with `--port 4567`) → PORT env → 4000.
 */
export function parsePort(argv: string[]): number {
  const flagIndex = argv.findIndex((a) => a === '--port');
  const fromFlag = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
  const raw = fromFlag ?? process.env.PORT ?? '4000';
  const port = Number.parseInt(raw, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    console.warn(`[config] invalid port "${raw}" — falling back to 4000`);
    return 4000;
  }
  return port;
}

export function loadConfig(): AppConfig {
  const port = parsePort(process.argv);
  // DATA_DIR defaults to ./data relative to the current working directory
  // (apps/api when started via `bun src/index.ts` from that directory).
  // The Tauri desktop shell passes its app-data dir via DATA_DIR.
  const dataDir = resolveDir(process.env.DATA_DIR, path.resolve(process.cwd(), 'data'));
  // SEED_DIR defaults to ../../seed relative to apps/api (i.e. mvp/seed).
  // import.meta.url points at src/ in dev or dist/ after tsc — both are one
  // level below apps/api, so ../../seed resolves to mvp/seed either way.
  const seedDir = resolveDir(process.env.SEED_DIR, path.resolve(SRC_DIR, '../../seed'));
  return {
    port: Number.isFinite(port) ? port : 4000,
    dataDir,
    seedDir,
    skillsDir: path.join(seedDir, 'skills'),
    workspaceDir: path.join(dataDir, 'workspace'),
    // ../web/out relative to apps/api (src/ and dist/ are both one level deep).
    webOutDir: path.resolve(SRC_DIR, '../../web/out'),
    publicBaseUrl: parsePublicBaseUrl(process.env.SARVIQ_PUBLIC_URL),
  };
}
