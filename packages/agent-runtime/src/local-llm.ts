// SPDX-License-Identifier: Apache-2.0
//
// Managed local LLM (Atomic Agent parity): zero-config llama.cpp.
//
// Downloads a prebuilt *stock* llama.cpp server binary (ggml-org/llama.cpp —
// no forks) for the current OS/arch/GPU, manages a curated set of small GGUF
// models, and serves them on 127.0.0.1 only via the OpenAI-compatible API.
//
// Safety notes, stated plainly:
//  - Binaries come only from the project's official GitHub releases, pinned
//    to release `b11683` (overridable via KRIYADOT_LLAMACPP_RELEASE).
//  - GitHub does not publish checksums for these assets, so where we could
//    not pre-verify a hash we use trust-on-first-use: the sha256 of the
//    downloaded file is recorded in the local manifest and re-verified on
//    every subsequent use (tamper-evident). Two variants carry genuinely
//    pre-verified pins (downloaded and hashed at build time, 2026-10-16).
//  - Models come only from the curated list below (pinned HuggingFace URLs);
//    the UI cannot download arbitrary URLs. File size is verified exactly
//    after download.
//  - The server binds 127.0.0.1 only — never exposed to the LAN.

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFile as nodeExecFile, spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

/** Pinned llama.cpp release. Override with KRIYADOT_LLAMACPP_RELEASE (pins are then TOFU). */
export function llamacppRelease(): string {
  return (process.env.KRIYADOT_LLAMACPP_RELEASE ?? '').trim() || 'b11683';
}

export type GpuKind = 'cuda' | 'metal' | 'vulkan' | 'cpu';

export interface GpuInfo {
  kind: GpuKind;
  /** Human-readable detail, e.g. "NVIDIA GeForce RTX 4060" or "Apple Metal". */
  detail: string;
}

export interface BinaryAsset {
  /** Release asset file name, e.g. llama-b11683-bin-ubuntu-x64.tar.gz */
  file: string;
  url: string;
  archiveKind: 'tar.gz' | 'zip';
  /** Pre-verified sha256 (present only for variants hashed at build time). */
  sha256?: string;
}

const RELEASE_BASE = 'https://github.com/ggml-org/llama.cpp/releases/download';

// Pre-verified sha256 pins, computed by downloading the assets from the
// official release and hashing them (2026-10-16). Only these two variants
// were small enough to verify in the build environment.
const PINNED_SHA256: Record<string, string> = {
  'llama-b11683-bin-ubuntu-x64.tar.gz':
    '261410c6fa6b4b375e8b904f2169ca4ef5ea620f6b1cee6b2c66cdc1521ac9a6',
  'llama-b11683-bin-macos-arm64.tar.gz':
    '0c0154f043a7fe8fc0d5c100b5067ef9ca42d07d9993ee62fdce451662aa9b35',
};

export interface AssetSelection {
  platform: string; // node platform
  arch: string; // node arch
  gpu: GpuKind;
}

/**
 * Pick the official llama.cpp release asset for this machine.
 * Throws for unsupported platform/arch combinations.
 */
export function selectBinaryAsset(sel: AssetSelection, release = llamacppRelease()): BinaryAsset {
  const { platform, arch, gpu } = sel;
  const rel = release;
  let file = '';
  if (platform === 'linux') {
    if (arch === 'x64') {
      file =
        gpu === 'cuda'
          ? `llama-${rel}-bin-ubuntu-cuda-12.8-x64.tar.gz`
          : gpu === 'vulkan'
            ? `llama-${rel}-bin-ubuntu-vulkan-x64.tar.gz`
            : `llama-${rel}-bin-ubuntu-x64.tar.gz`;
    } else if (arch === 'arm64') {
      file =
        gpu === 'cuda'
          ? `llama-${rel}-bin-ubuntu-cuda-13.4-arm64.tar.gz`
          : gpu === 'vulkan'
            ? `llama-${rel}-bin-ubuntu-vulkan-arm64.tar.gz`
            : `llama-${rel}-bin-ubuntu-arm64.tar.gz`;
    }
  } else if (platform === 'darwin') {
    if (arch === 'arm64') file = `llama-${rel}-bin-macos-arm64.tar.gz`;
    else if (arch === 'x64') file = `llama-${rel}-bin-macos-x64.tar.gz`;
  } else if (platform === 'win32') {
    if (arch === 'x64') {
      file =
        gpu === 'cuda'
          ? `llama-${rel}-bin-win-cuda-12.4-x64.zip`
          : gpu === 'vulkan'
            ? `llama-${rel}-bin-win-vulkan-x64.zip`
            : `llama-${rel}-bin-win-cpu-x64.zip`;
    } else if (arch === 'arm64') {
      file = `llama-${rel}-bin-win-cpu-arm64.zip`;
    }
  }
  if (!file) {
    throw new Error(
      `No prebuilt llama.cpp binary for ${platform}/${arch}. ` +
        `Supported: linux (x64, arm64), macOS (arm64, x64), Windows (x64, arm64).`,
    );
  }
  const archiveKind = file.endsWith('.zip') ? 'zip' : 'tar.gz';
  return {
    file,
    url: `${RELEASE_BASE}/${rel}/${file}`,
    archiveKind,
    sha256: rel === 'b11683' ? PINNED_SHA256[file] : undefined,
  };
}

/** Port the managed llama-server binds to (127.0.0.1 only). */
export function llamacppPort(): number {
  const raw = (process.env.KRIYADOT_LLAMACPP_PORT ?? '').trim();
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 11435;
}

/** Base URL of the managed server's OpenAI-compatible API. */
export function llamacppBaseUrl(): string {
  return `http://127.0.0.1:${llamacppPort()}`;
}

export type ExecFn = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

/** Default execFile wrapper (promisified, small output cap). */
export function defaultExec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    nodeExecFile(cmd, args, { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolvePromise({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export interface GpuDetectOpts {
  platform?: string;
  run?: ExecFn;
}

/**
 * Detect GPU acceleration for llama.cpp.
 * - CUDA: `nvidia-smi` reports a GPU name.
 * - Metal: always available on macOS (Apple Silicon and Intel).
 * - Vulkan: `vulkaninfo` runs successfully.
 * - Otherwise CPU.
 */
export async function detectGpu(opts: GpuDetectOpts = {}): Promise<GpuInfo> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? defaultExec;
  try {
    const { stdout } = await run('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader']);
    const name = stdout.split('\n').map((l) => l.trim()).filter(Boolean)[0];
    if (name) return { kind: 'cuda', detail: name };
  } catch {
    // No NVIDIA driver — keep probing.
  }
  if (platform === 'darwin') {
    return { kind: 'metal', detail: 'Apple Metal' };
  }
  try {
    await run('vulkaninfo', ['--summary']);
    return { kind: 'vulkan', detail: 'Vulkan-capable GPU' };
  } catch {
    // No Vulkan — CPU it is.
  }
  return { kind: 'cpu', detail: 'CPU only' };
}

// ---------------------------------------------------------------------------
// Curated models
// ---------------------------------------------------------------------------

export interface CuratedModel {
  id: string;
  name: string;
  /** Pinned download URL (HuggingFace resolve). The UI cannot use other URLs. */
  url: string;
  /** Exact expected file size in bytes; verified after download. */
  sizeBytes: number;
  params: string;
  contextLength: number;
  blurb: string;
}

/**
 * Curated small instruct GGUF models. URLs and sizes were verified against
 * HuggingFace on 2026-10-16. To add a model, verify the resolve URL and exact
 * byte size first — never accept an arbitrary URL from the UI.
 */
export const CURATED_MODELS: CuratedModel[] = [
  {
    id: 'qwen2.5-0.5b-instruct-q4_k_m',
    name: 'Qwen 2.5 0.5B Instruct (Q4_K_M)',
    url: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf',
    sizeBytes: 491400032,
    params: '0.5B',
    contextLength: 32768,
    blurb: 'Tiny and fast — good for quick drafts and simple tool calls on CPU.',
  },
  {
    id: 'llama-3.2-1b-instruct-q4_k_m',
    name: 'Llama 3.2 1B Instruct (Q4_K_M)',
    url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf',
    sizeBytes: 807694464,
    params: '1B',
    contextLength: 131072,
    blurb: 'Small Meta instruct model with strong tool-calling for its size.',
  },
  {
    id: 'qwen2.5-1.5b-instruct-q4_k_m',
    name: 'Qwen 2.5 1.5B Instruct (Q4_K_M)',
    url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf',
    sizeBytes: 1117320736,
    params: '1.5B',
    contextLength: 32768,
    blurb: 'Solid everyday local model; comfortable on most laptops.',
  },
  {
    id: 'llama-3.2-3b-instruct-q4_k_m',
    name: 'Llama 3.2 3B Instruct (Q4_K_M)',
    url: 'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    sizeBytes: 2019377696,
    params: '3B',
    contextLength: 131072,
    blurb: 'Best quality in the small set; needs ~4GB RAM free.',
  },
  {
    id: 'qwen2.5-3b-instruct-q4_k_m',
    name: 'Qwen 2.5 3B Instruct (Q4_K_M)',
    url: 'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf',
    sizeBytes: 2104932768,
    params: '3B',
    contextLength: 32768,
    blurb: 'Strong multilingual small model, incl. Hindi.',
  },
];

/** sha256 of a file, hex. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  const stream = createReadStream(path);
  await new Promise<void>((resolvePromise, reject) => {
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolvePromise());
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number | null;
}

export type DownloadFn = (
  url: string,
  destPath: string,
  onProgress?: (p: DownloadProgress) => void,
) => Promise<void>;

/** Default downloader: HTTPS GET streamed to disk. Follows redirects. */
export async function defaultDownload(
  url: string,
  destPath: string,
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  let current = url;
  for (let redirects = 0; redirects < 8; redirects++) {
    const res = await fetch(current, { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`download redirect without location: ${current}`);
      current = new URL(loc, current).toString();
      await res.arrayBuffer().catch(() => null);
      continue;
    }
    if (!res.ok || !res.body) {
      throw new Error(`download failed (${res.status}) for ${current}`);
    }
    const total = res.headers.get('content-length');
    const totalBytes = total ? Number.parseInt(total, 10) : null;
    let downloaded = 0;
    const { Transform } = await import('node:stream');
    const progressTap = new Transform({
      transform(chunk, _enc, cb) {
        downloaded += chunk.length;
        try {
          onProgress?.({ downloadedBytes: downloaded, totalBytes });
        } catch {
          // progress callbacks must never break the download
        }
        cb(null, chunk);
      },
    });
    await pipeline(res.body as unknown as NodeJS.ReadableStream, progressTap, createWriteStream(destPath));
    return;
  }
  throw new Error('too many redirects downloading ' + url);
}

export interface LocalLlmDeps {
  exec?: ExecFn;
  spawn?: (cmd: string, args: string[], opts?: Record<string, unknown>) => ChildProcess;
  download?: DownloadFn;
  platform?: string;
  arch?: string;
  /** Base auto-restart backoff in ms (default 2000). Lower in tests. */
  restartBaseDelayMs?: number;
}

export interface ModelEntry extends CuratedModel {
  downloaded: boolean;
  path: string | null;
}

export interface LocalLlmStatus {
  installed: boolean;
  running: boolean;
  port: number;
  model: string | null;
  pid: number | null;
  startedAt: number | null;
  gpu: GpuInfo;
  asset: BinaryAsset | null;
  models: ModelEntry[];
  /** Bytes used by binaries + models. */
  storageBytes: number;
  logTail: string[];
  restarts: number;
  lastError: string | null;
}

interface Manifest {
  release: string;
  asset: string;
  /** sha256 of the downloaded archive (TOFU) or the pre-verified pin. */
  sha256: string;
  /**
   * sha256 of the EXTRACTED llama-server binary, recorded at install time.
   * This is what verifyInstalledBinary() re-checks before every start —
   * the archive hash alone cannot detect a binary swapped after extraction.
   */
  binarySha256: string;
  installedAt: number;
}

const MAX_LOG_LINES = 200;
const MAX_RESTARTS = 3;
const HEALTH_TIMEOUT_MS = 120000;

function serverBinaryName(platform: string): string {
  return platform === 'win32' ? 'llama-server.exe' : 'llama-server';
}

/** Recursively find the server binary (release archives nest it one level deep). */
async function findBinary(dir: string, name: string, depth = 0): Promise<string | null> {
  if (depth > 3) return null;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = join(dir, e);
    if (e === name) return full;
    try {
      const st = await stat(full);
      if (st.isDirectory()) {
        const found = await findBinary(full, name, depth + 1);
        if (found) return found;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  try {
    const entries = await readdir(dir);
    for (const e of entries) {
      try {
        const st = await stat(join(dir, e));
        total += st.isDirectory() ? await dirSizeBytes(join(dir, e)) : st.size;
      } catch {
        // ignore
      }
    }
  } catch {
    // missing dir → 0
  }
  return total;
}

export class LocalLlmManager {
  private readonly dataDir: string;
  private readonly deps: Required<Pick<LocalLlmDeps, 'exec' | 'spawn' | 'download'>> &
    Pick<LocalLlmDeps, 'platform' | 'arch' | 'restartBaseDelayMs'>;
  private child: ChildProcess | null = null;
  private currentModel: string | null = null;
  private startedAt: number | null = null;
  private restarts = 0;
  private lastError: string | null = null;
  private readonly logLines: string[] = [];
  private gpuCache: GpuInfo | null = null;
  private stopping = false;

  constructor(dataDir: string, deps: LocalLlmDeps = {}) {
    this.dataDir = dataDir;
    this.deps = {
      exec: deps.exec ?? defaultExec,
      spawn: deps.spawn ?? nodeSpawn,
      download: deps.download ?? defaultDownload,
      platform: deps.platform,
      arch: deps.arch,
      restartBaseDelayMs: deps.restartBaseDelayMs,
    };
  }

  private get platform(): string {
    return this.deps.platform ?? process.platform;
  }

  private get arch(): string {
    return this.deps.arch ?? process.arch;
  }

  private get rootDir(): string {
    return join(this.dataDir, 'local-llm');
  }

  private get binDir(): string {
    return join(this.rootDir, 'bin');
  }

  private get modelsDir(): string {
    return join(this.rootDir, 'models');
  }

  private get manifestPath(): string {
    return join(this.rootDir, 'manifest.json');
  }

  private log(line: string): void {
    this.logLines.push(`[${new Date().toISOString()}] ${line}`);
    while (this.logLines.length > MAX_LOG_LINES) this.logLines.shift();
  }

  async detectGpu(): Promise<GpuInfo> {
    if (!this.gpuCache) {
      this.gpuCache = await detectGpu({ platform: this.platform, run: this.deps.exec });
    }
    return this.gpuCache;
  }

  selectAsset(): BinaryAsset {
    return selectBinaryAsset({
      platform: this.platform,
      arch: this.arch,
      gpu: this.gpuCache?.kind ?? 'cpu',
    });
  }

  async readManifest(): Promise<Manifest | null> {
    try {
      return JSON.parse(await readFile(this.manifestPath, 'utf8')) as Manifest;
    } catch {
      return null;
    }
  }

  /** Binary installed (the extracted llama-server binary is present). */
  async isBinaryInstalled(): Promise<boolean> {
    const bin = await findBinary(this.binDir, serverBinaryName(this.platform));
    return bin !== null;
  }

  /**
   * Re-verify the installed llama-server binary against the binary hash
   * recorded at install time (TOFU manifest). A swapped or tampered binary
   * refuses to start — the manifest alone is not trusted. Throws on mismatch
   * or when no manifest/binary hash exists (old installs must re-download).
   */
  async verifyInstalledBinary(): Promise<string> {
    const bin = await findBinary(this.binDir, serverBinaryName(this.platform));
    if (!bin) {
      throw new Error('llama.cpp is not installed. Download it first from Settings → Local LLM.');
    }
    const manifest = await this.readManifest();
    const expected = manifest?.binarySha256?.toLowerCase();
    if (!expected) {
      throw new Error(
        'No integrity record for the installed llama.cpp binary — refusing to start. ' +
          'Re-download it from Settings → Local LLM.',
      );
    }
    const actual = await sha256File(bin);
    if (actual !== expected) {
      const msg =
        `llama-server binary failed integrity verification: expected sha256 ` +
        `${expected.slice(0, 16)}…, got ${actual.slice(0, 16)}…. ` +
        `The binary may have been replaced or tampered with — refusing to start. ` +
        `Re-download it from Settings → Local LLM.`;
      this.log(`SECURITY: ${msg}`);
      this.lastError = msg;
      throw new Error(msg);
    }
    return bin;
  }

  /**
   * Download and install the llama.cpp server binary.
   * Verifies sha256 (pinned pin, user env pin, or TOFU-recorded) and archive
   * integrity before extraction.
   */
  async downloadBinary(onProgress?: (p: DownloadProgress) => void): Promise<BinaryAsset> {
    const gpu = await this.detectGpu();
    const asset = selectBinaryAsset({ platform: this.platform, arch: this.arch, gpu: gpu.kind });
    await mkdir(this.binDir, { recursive: true });
    const tmpPath = join(tmpdir(), `llamacpp-${Date.now()}-${asset.file}`);
    this.log(`downloading ${asset.file} (${gpu.kind})`);
    try {
      await this.deps.download(asset.url, tmpPath, onProgress);
      const actual = await sha256File(tmpPath);
      const envPin = (process.env.KRIYADOT_LLAMACPP_SHA256 ?? '').trim().toLowerCase();
      const expected = envPin || asset.sha256;
      if (expected && actual !== expected.toLowerCase()) {
        throw new Error(
          `checksum mismatch for ${asset.file}: expected ${expected.slice(0, 16)}…, got ${actual.slice(0, 16)}…. ` +
            `The download may be corrupted or tampered with — refusing to install.`,
        );
      }
      // Structural integrity check before extraction.
      await this.verifyArchive(tmpPath, asset.archiveKind);
      await this.extractArchive(tmpPath, this.binDir, asset.archiveKind);
      const bin = await findBinary(this.binDir, serverBinaryName(this.platform));
      if (!bin) throw new Error(`archive did not contain ${serverBinaryName(this.platform)}`);
      if (this.platform !== 'win32') await chmod(bin, 0o755).catch(() => undefined);
      // Record the EXTRACTED binary's hash too — verifyInstalledBinary()
      // re-checks it before every start so a post-install swap is caught.
      const binarySha256 = await sha256File(bin);
      await writeFile(
        this.manifestPath,
        JSON.stringify(
          {
            release: llamacppRelease(),
            asset: asset.file,
            sha256: actual,
            binarySha256,
            installedAt: Date.now(),
          } satisfies Manifest,
          null,
          2,
        ),
      );
      this.log(`installed ${asset.file} (sha256 ${actual.slice(0, 16)}…)`);
      return asset;
    } finally {
      await rm(tmpPath, { force: true }).catch(() => undefined);
    }
  }

  private async verifyArchive(path: string, kind: 'tar.gz' | 'zip'): Promise<void> {
    if (kind === 'tar.gz') {
      await this.deps.exec('tar', ['tzf', path]);
    } else if (this.platform === 'win32') {
      // PowerShell can at least list the archive; a corrupt zip throws.
      await this.deps.exec('powershell', [
        '-NoProfile',
        '-Command',
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::OpenRead('${path}').Entries.Count`,
      ]);
    } else {
      await this.deps.exec('unzip', ['-t', path]);
    }
  }

  private async extractArchive(path: string, dest: string, kind: 'tar.gz' | 'zip'): Promise<void> {
    await mkdir(dest, { recursive: true });
    if (kind === 'tar.gz') {
      await this.deps.exec('tar', ['-xzf', path, '-C', dest]);
    } else if (this.platform === 'win32') {
      await this.deps.exec('powershell', [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Path '${path}' -DestinationPath '${dest}' -Force`,
      ]);
    } else {
      await this.deps.exec('unzip', ['-o', '-q', path, '-d', dest]);
    }
  }

  /** Curated models with downloaded state. */
  async listModels(): Promise<ModelEntry[]> {
    await mkdir(this.modelsDir, { recursive: true });
    return Promise.all(
      CURATED_MODELS.map(async (m) => {
        const full = join(this.modelsDir, `${m.id}.gguf`);
        let downloaded = false;
        try {
          const st = await stat(full);
          downloaded = st.size === m.sizeBytes;
        } catch {
          downloaded = false;
        }
        return { ...m, downloaded, path: downloaded ? full : null };
      }),
    );
  }

  /**
   * Download a model by curated id only. Arbitrary URLs are never accepted.
   * Verifies the exact byte size after download.
   */
  async downloadModel(modelId: string, onProgress?: (p: DownloadProgress) => void): Promise<ModelEntry> {
    const model = CURATED_MODELS.find((m) => m.id === modelId);
    if (!model) {
      throw new Error(
        `unknown model "${modelId}". Only curated models can be downloaded: ${CURATED_MODELS.map((m) => m.id).join(', ')}`,
      );
    }
    await mkdir(this.modelsDir, { recursive: true });
    const dest = join(this.modelsDir, `${model.id}.gguf`);
    const tmpPath = `${dest}.part`;
    this.log(`downloading model ${model.id} (${(model.sizeBytes / 1024 / 1024).toFixed(0)} MB)`);
    await this.deps.download(model.url, tmpPath, onProgress);
    const st = await stat(tmpPath);
    if (st.size !== model.sizeBytes) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw new Error(
        `size mismatch for ${model.id}: expected ${model.sizeBytes} bytes, got ${st.size}. Download incomplete or tampered — removed.`,
      );
    }
    await import('node:fs/promises').then((fs) => fs.rename(tmpPath, dest));
    this.log(`model ${model.id} ready`);
    return { ...model, downloaded: true, path: dest };
  }

  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  /**
   * Start llama-server with the given (downloaded) model. Downloads nothing
   * implicitly — call downloadBinary()/downloadModel() first via the UI.
   */
  async start(modelId?: string): Promise<void> {
    if (this.isRunning()) return;
    // HIGH fix: re-verify the binary hash against the TOFU manifest on every
    // start — a binary swapped after download must never be executed.
    const bin = await this.verifyInstalledBinary();
    const models = await this.listModels();
    let chosen: ModelEntry | undefined;
    if (modelId) {
      chosen = models.find((m) => m.id === modelId);
      if (!chosen?.downloaded) {
        throw new Error(`Model "${modelId}" is not downloaded. Download it first from Settings → Local LLM.`);
      }
    } else {
      chosen = models.find((m) => m.downloaded);
      if (!chosen) {
        throw new Error('No model downloaded. Download one first from Settings → Local LLM.');
      }
    }
    const port = llamacppPort();
    const modelPath = chosen.path;
    if (!modelPath) {
      throw new Error(`Model "${chosen.id}" is not downloaded. Download it first from Settings → Local LLM.`);
    }
    const args = [
      '-m',
      modelPath,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '-c',
      '4096',
      '--no-webui',
    ];
    this.log(`starting llama-server (model ${chosen.id}, port ${port})`);
    this.stopping = false;
    const child = this.deps.spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.currentModel = chosen.id;
    this.startedAt = Date.now();
    child.stdout?.on('data', (d) => this.log(`[server] ${String(d).trim()}`));
    child.stderr?.on('data', (d) => this.log(`[server] ${String(d).trim()}`));
    child.on('exit', (code, signal) => {
      this.child = null;
      const reason = `exit code=${code} signal=${signal}`;
      if (this.stopping) {
        this.log(`server stopped (${reason})`);
        return;
      }
      this.lastError = `llama-server exited unexpectedly (${reason})`;
      this.log(this.lastError);
      void this.maybeRestart();
    });
    child.on('error', (err) => {
      this.lastError = `failed to launch llama-server: ${err.message}`;
      this.log(this.lastError);
      this.child = null;
    });
    await this.waitForHealth(port);
    this.log(`llama-server healthy at ${llamacppBaseUrl()}`);
  }

  private get restartBaseDelayMs(): number {
    return this.deps.restartBaseDelayMs ?? 2000;
  }

  private async maybeRestart(): Promise<void> {
    if (this.stopping || this.restarts >= MAX_RESTARTS || !this.currentModel) return;
    this.restarts += 1;
    const delayMs = this.restartBaseDelayMs * this.restarts;
    this.log(`auto-restart attempt ${this.restarts}/${MAX_RESTARTS} in ${delayMs}ms`);
    await new Promise((r) => setTimeout(r, delayMs));
    if (this.stopping) return;
    try {
      // Reset child state before retrying; start() re-spawns.
      await this.start(this.currentModel);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log(`restart failed: ${this.lastError}`);
    }
  }

  private async waitForHealth(port: number): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    let lastErr = '';
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) return;
        lastErr = `HTTP ${res.status}`;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
      if (!this.isRunning()) {
        throw new Error(`llama-server died during startup: ${this.lastError ?? lastErr}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`llama-server did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s: ${lastErr}`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // already gone
          }
          resolvePromise();
        }, 5000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolvePromise();
        });
      });
    }
    this.log('server stopped');
  }

  async restart(modelId?: string): Promise<void> {
    await this.stop();
    this.restarts = 0;
    this.stopping = false;
    await this.start(modelId ?? this.currentModel ?? undefined);
  }

  async getStatus(): Promise<LocalLlmStatus> {
    const gpu = await this.detectGpu();
    const models = await this.listModels();
    const [binBytes, modelBytes] = await Promise.all([dirSizeBytes(this.binDir), dirSizeBytes(this.modelsDir)]);
    let asset: BinaryAsset | null = null;
    try {
      asset = selectBinaryAsset({ platform: this.platform, arch: this.arch, gpu: gpu.kind });
    } catch {
      asset = null;
    }
    return {
      installed: await this.isBinaryInstalled(),
      running: this.isRunning(),
      port: llamacppPort(),
      model: this.currentModel,
      pid: this.child?.pid ?? null,
      startedAt: this.startedAt,
      gpu,
      asset,
      models,
      storageBytes: binBytes + modelBytes,
      logTail: [...this.logLines].slice(-40),
      restarts: this.restarts,
      lastError: this.lastError,
    };
  }

  /** Storage root (for diagnostics). */
  paths(): { root: string; bin: string; models: string } {
    return { root: this.rootDir, bin: this.binDir, models: this.modelsDir };
  }
}

/** Re-resolve a model's on-disk path (used by routes). */
export function modelFileName(model: CuratedModel): string {
  return `${model.id}.gguf`;
}

export function localLlmModelsDir(dataDir: string): string {
  return resolve(dataDir, 'local-llm', 'models');
}
