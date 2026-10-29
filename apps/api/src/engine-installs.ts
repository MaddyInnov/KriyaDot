// SPDX-License-Identifier: Apache-2.0
// Standalone engine installs (ENGINES pack): engines that publish REAL
// standalone release binaries can be installed without Node/npm —
// download the vendor archive, verify its pinned SHA-256, extract it
// under <dataDir>/engines/<id>/<version>, and mark it active. Detection
// then prefers the installed standalone build over any PATH copy.
//
// Which engines qualify was verified against the vendors' release
// behavior: OpenCode publishes standalone per-platform archives, and
// Google publishes the Antigravity ACP server as standalone zips.
// Cline does NOT (its CLI is npm-only — it needs Node), so it is
// deliberately absent; an engine without real standalone artifacts
// never appears here.
//
// Safety contract:
// - Install is an OUTWARD action: the installer requires an injectable
//   approve hook and the DEFAULT is DENY. The HTTP route additionally
//   audit-logs every install attempt (requested + outcome).
// - Downloads only go to the manifest's own HTTPS URLs; the archive's
//   SHA-256 must match the manifest pin. A manifest entry whose pin is
//   null is NOT installable (fail closed) — pins are filled in only
//   after a maintainer verifies a release archive's digest.
// - Archive entries with absolute or `..` paths are rejected (zip-slip).
// - No new dependencies: tar.gz extracts via the system `tar` when
//   present; zip extracts via the small stored/deflate reader below
//   (integrity comes from the whole-archive SHA-256 pin, so per-entry
//   CRCs are not separately verified).

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import express, { type Router } from 'express';

export type EngineArchiveFormat = 'tar.gz' | 'zip' | 'raw';

export interface EngineInstallAsset {
  /** HTTPS download URL; may contain {version}. */
  url: string;
  /** Pinned SHA-256 of the archive (64 hex), or null = not yet pinned (not installable). */
  sha256: string | null;
  archive: EngineArchiveFormat;
}

export interface EngineInstallManifestEntry {
  id: string;
  name: string;
  version: string;
  /** Executable path inside the install dir (extraction root for archives). */
  executable: string;
  /** Keyed by `${platform}-${arch}` (linux may also use `-musl` suffix keys). */
  assets: Record<string, EngineInstallAsset>;
  notes: string;
}

export const ENGINE_INSTALL_MANIFEST: EngineInstallManifestEntry[] = [
  {
    id: 'opencode',
    name: 'OpenCode',
    version: '1.19.4',
    executable: process.platform === 'win32' ? 'opencode.exe' : 'opencode',
    assets: {
      'darwin-arm64': {
        url: 'https://github.com/anomalyco/opencode/releases/download/v{version}/opencode-darwin-arm64.zip',
        sha256: null,
        archive: 'zip',
      },
      'darwin-x64': {
        url: 'https://github.com/anomalyco/opencode/releases/download/v{version}/opencode-darwin-x64-baseline.zip',
        sha256: null,
        archive: 'zip',
      },
      'linux-x64': {
        url: 'https://github.com/anomalyco/opencode/releases/download/v{version}/opencode-linux-x64-baseline.tar.gz',
        sha256: null,
        archive: 'tar.gz',
      },
      'linux-arm64': {
        url: 'https://github.com/anomalyco/opencode/releases/download/v{version}/opencode-linux-arm64.tar.gz',
        sha256: null,
        archive: 'tar.gz',
      },
      'win32-x64': {
        url: 'https://github.com/anomalyco/opencode/releases/download/v{version}/opencode-windows-x64-baseline.zip',
        sha256: null,
        archive: 'zip',
      },
      'win32-arm64': {
        url: 'https://github.com/anomalyco/opencode/releases/download/v{version}/opencode-windows-arm64.zip',
        sha256: null,
        archive: 'zip',
      },
    },
    notes:
      'OpenCode publishes standalone per-platform release archives (no Node required). ' +
      'SHA-256 pins ship null until a maintainer verifies the release digests; installs fail closed until then.',
  },
  {
    id: 'antigravity',
    name: 'Google Antigravity (ACP server)',
    version: '1.4.3',
    executable: process.platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par',
    assets: {
      'darwin-arm64': {
        url: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-{version}-darwin-arm64.zip',
        sha256: null,
        archive: 'zip',
      },
      'linux-x64': {
        url: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-{version}-linux-x86_64.zip',
        sha256: null,
        archive: 'zip',
      },
      'linux-arm64': {
        url: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-{version}-linux-arm64.zip',
        sha256: null,
        archive: 'zip',
      },
      'win32-x64': {
        url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-{version}-windows-x86_64.zip',
        sha256: null,
        archive: 'zip',
      },
      'win32-arm64': {
        url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-{version}-windows-arm64.zip',
        sha256: null,
        archive: 'zip',
      },
    },
    notes:
      'Google publishes the Antigravity ACP server as standalone zips (server binary + harness). ' +
      'SHA-256 pins ship null until verified; installs fail closed until then.',
  },
];

const SHA256_RE = /^[0-9a-f]{64}$/;
const ENGINE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Validate a manifest (used by tests + boot checks). Returns error strings. */
export function validateEngineInstallManifest(entries: readonly EngineInstallManifestEntry[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const e of entries) {
    if (!ENGINE_ID_RE.test(e.id) || ids.has(e.id)) errors.push(`duplicate/invalid engine id: ${e.id}`);
    ids.add(e.id);
    if (!e.name) errors.push(`missing name for ${e.id}`);
    if (!e.version || /[/\\]/.test(e.version)) errors.push(`invalid version for ${e.id}`);
    if (!e.executable || e.executable.includes('..')) errors.push(`invalid executable for ${e.id}`);
    const keys = Object.keys(e.assets ?? {});
    if (keys.length === 0) errors.push(`no assets for ${e.id}`);
    for (const [key, asset] of Object.entries(e.assets ?? {})) {
      if (!/^(darwin|linux|win32)-(x64|arm64)(-musl)?$/.test(key)) errors.push(`invalid platform key ${key} for ${e.id}`);
      let url: URL;
      try {
        url = new URL(asset.url.replaceAll('{version}', e.version));
      } catch {
        errors.push(`invalid asset url for ${e.id}/${key}`);
        continue;
      }
      if (url.protocol !== 'https:') errors.push(`asset url must be https for ${e.id}/${key}`);
      if (asset.sha256 !== null && !SHA256_RE.test(asset.sha256)) errors.push(`invalid sha256 pin for ${e.id}/${key}`);
      if (!['tar.gz', 'zip', 'raw'].includes(asset.archive)) errors.push(`invalid archive format for ${e.id}/${key}`);
    }
  }
  return errors;
}

export function platformKey(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}

export function resolveAssetUrl(entry: EngineInstallManifestEntry, asset: EngineInstallAsset): string {
  return asset.url.replaceAll('{version}', entry.version);
}

// ---------------------------------------------------------------------------
// Install state on disk: <dataDir>/engines/<id>/<version>/… + active.json
// ---------------------------------------------------------------------------

export interface ActiveEngineInstall {
  id: string;
  version: string;
  executable: string;
  installedAt: string;
}

export function engineInstallDir(dataDir: string, id: string, version: string): string {
  return join(dataDir, 'engines', id, version);
}

export function activeInstallPath(dataDir: string, id: string): string {
  return join(dataDir, 'engines', id, 'active.json');
}

export function readActiveInstall(dataDir: string, id: string): ActiveEngineInstall | null {
  try {
    const parsed = JSON.parse(readFileSync(activeInstallPath(dataDir, id), 'utf8')) as ActiveEngineInstall;
    if (typeof parsed?.version !== 'string' || typeof parsed?.executable !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Absolute path of the active standalone build for an engine, or null.
 * This is the detection-preference resolver: feed it to
 * `detectAcpEngines({ standalonePath })` (agent-runtime) so an installed
 * standalone build wins over the PATH copy.
 */
export function installedEnginePath(dataDir: string, id: string): string | null {
  const active = readActiveInstall(dataDir, id);
  if (!active) return null;
  const exe = join(engineInstallDir(dataDir, id, active.version), active.executable);
  return existsSync(exe) ? exe : null;
}

// ---------------------------------------------------------------------------
// Minimal zip extraction (stored + deflate entries).
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

export function readZipEntries(buf: Buffer): ZipEntry[] {
  // End Of Central Directory: scan from the end for the 0x06054b50 signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compressedSize, localHeaderOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function zipEntryData(buf: Buffer, entry: ZipEntry): Buffer {
  const off = entry.localHeaderOffset;
  if (buf.readUInt32LE(off) !== 0x04034b50) throw new Error('corrupt zip local header');
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`unsupported zip compression method ${entry.method} for ${entry.name}`);
}

/** Extract a zip buffer into destDir. Rejects absolute/`..` entry names. */
export function extractZipBuffer(buf: Buffer, destDir: string): string[] {
  const written: string[] = [];
  for (const entry of readZipEntries(buf)) {
    const name = entry.name.replaceAll('\\', '/');
    if (!name || name.endsWith('/')) continue;
    if (name.startsWith('/') || name.split('/').includes('..')) {
      throw new Error(`unsafe zip entry path: ${entry.name}`);
    }
    const data = zipEntryData(buf, entry);
    const target = join(destDir, ...name.split('/'));
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, data);
    written.push(name);
  }
  return written;
}

function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile('tar', ['-xzf', archivePath, '-C', destDir], { timeout: 120_000, windowsHide: true }, (err) => {
      if (err) rejectPromise(new Error(`tar extraction failed (is tar installed?): ${err.message}`));
      else resolvePromise();
    });
  });
}

// ---------------------------------------------------------------------------
// Installer.
// ---------------------------------------------------------------------------

export interface InstallEngineOptions {
  dataDir: string;
  engineId: string;
  manifest?: readonly EngineInstallManifestEntry[];
  /** Injectable fetch (tests stub it; zero real network in tests). */
  fetchImpl?: typeof fetch;
  /**
   * Approval hook for this outward action. DEFAULT: deny. The host wires
   * a real approval (user confirmation / governance) here.
   */
  approve?: (engineId: string) => boolean | Promise<boolean>;
  platform?: NodeJS.Platform;
  arch?: string;
}

export interface InstallEngineResult {
  id: string;
  version: string;
  path: string;
  executablePath: string;
}

export async function installEngine(opts: InstallEngineOptions): Promise<InstallEngineResult> {
  const manifest = opts.manifest ?? ENGINE_INSTALL_MANIFEST;
  const entry = manifest.find((e) => e.id === opts.engineId);
  if (!entry) throw new Error(`Unknown installable engine "${opts.engineId}".`);
  const approve = opts.approve ?? (() => false);
  if (!(await approve(opts.engineId))) {
    throw new Error(`Install of "${opts.engineId}" was not approved (approve hook denied).`);
  }
  const key = platformKey(opts.platform, opts.arch);
  const asset = entry.assets[key];
  if (!asset) throw new Error(`No standalone build of "${entry.id}" for ${key}.`);
  if (!asset.sha256 || !SHA256_RE.test(asset.sha256)) {
    throw new Error(
      `Refusing to install "${entry.id}": no verified SHA-256 pin for ${key}. ` +
        'Pins are added only after a maintainer verifies the release archive digest.',
    );
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = resolveAssetUrl(entry, asset);
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Download of "${entry.id}" failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const digest = createHash('sha256').update(buf).digest('hex');
  if (digest !== asset.sha256) {
    throw new Error(`Checksum mismatch for "${entry.id}" (${key}): expected ${asset.sha256}, got ${digest}. Nothing installed.`);
  }
  const finalDir = engineInstallDir(opts.dataDir, entry.id, entry.version);
  const stagingDir = `${finalDir}.staging-${Date.now()}`;
  mkdirSync(stagingDir, { recursive: true });
  try {
    if (asset.archive === 'zip') {
      extractZipBuffer(buf, stagingDir);
    } else if (asset.archive === 'tar.gz') {
      const tmpArchive = join(stagingDir, '.download.tar.gz');
      writeFileSync(tmpArchive, buf);
      await extractTarGz(tmpArchive, stagingDir);
      rmSync(tmpArchive, { force: true });
    } else {
      writeFileSync(join(stagingDir, entry.executable), buf);
    }
    const exePath = join(stagingDir, entry.executable);
    if (!existsSync(exePath)) {
      throw new Error(`Archive for "${entry.id}" did not contain the expected executable "${entry.executable}".`);
    }
    if (process.platform !== 'win32') {
      try {
        chmodSync(exePath, 0o755);
      } catch {
        // best effort
      }
    }
    rmSync(finalDir, { recursive: true, force: true });
    renameSync(stagingDir, finalDir);
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }
  const record: ActiveEngineInstall = {
    id: entry.id,
    version: entry.version,
    executable: entry.executable,
    installedAt: new Date().toISOString(),
  };
  mkdirSync(join(opts.dataDir, 'engines', entry.id), { recursive: true });
  writeFileSync(activeInstallPath(opts.dataDir, entry.id), JSON.stringify(record, null, 2), 'utf8');
  return { id: entry.id, version: entry.version, path: finalDir, executablePath: join(finalDir, entry.executable) };
}

// ---------------------------------------------------------------------------
// HTTP routes (router factory; the parent wires the mount + approve hook).
//   HOST WIRING (index.ts):
//     app.use('/api', createEngineInstallsRouter({
//       dataDir: config.dataDir,
//       audit: (action, fields) => governance.audit(action, fields),
//       approve: async () => true, // after the user's install confirmation
//     }));
//   → GET  /api/engines            manifest + install state
//   → POST /api/engines/:id/install  audit-logged install
// ---------------------------------------------------------------------------

export interface EngineInstallsDeps {
  dataDir: string;
  audit: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  approve?: InstallEngineOptions['approve'];
  fetchImpl?: typeof fetch;
  manifest?: readonly EngineInstallManifestEntry[];
  platform?: NodeJS.Platform;
  arch?: string;
}

export function createEngineInstallsRouter(deps: EngineInstallsDeps): Router {
  const router = express.Router();
  const manifest = deps.manifest ?? ENGINE_INSTALL_MANIFEST;

  router.get('/engines', (_req, res) => {
    const key = platformKey(deps.platform, deps.arch);
    res.json({
      ok: true,
      engines: manifest.map((e) => ({
        id: e.id,
        name: e.name,
        version: e.version,
        executable: e.executable,
        notes: e.notes,
        platform: key,
        assetAvailable: Boolean(e.assets[key]),
        pinned: Boolean(e.assets[key]?.sha256),
        installedPath: installedEnginePath(deps.dataDir, e.id),
        active: readActiveInstall(deps.dataDir, e.id),
      })),
    });
  });

  router.post('/engines/:id/install', async (req, res) => {
    const engineId = req.params.id;
    deps.audit('engine.install_requested', { actor: 'user', detail: { engine: engineId } });
    try {
      const result = await installEngine({
        dataDir: deps.dataDir,
        engineId,
        manifest,
        fetchImpl: deps.fetchImpl,
        approve: deps.approve,
        platform: deps.platform,
        arch: deps.arch,
      });
      deps.audit('engine.installed', { actor: 'user', detail: { engine: engineId, version: result.version } });
      res.status(201).json({ ok: true, install: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'install failed';
      deps.audit('engine.install_failed', { actor: 'user', detail: { engine: engineId, error: message } });
      const status = /not approved/i.test(message) ? 403 : /Unknown installable/i.test(message) ? 404 : 502;
      res.status(status).json({ ok: false, error: message });
    }
  });

  return router;
}
