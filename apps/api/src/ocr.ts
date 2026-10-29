// SPDX-License-Identifier: Apache-2.0
// OCR providers for document ingestion (Octop §2.14 parity).
//
// Provider chain (default): local `tesseract` binary → configured HTTP OCR
// endpoint (env OCR_HTTP_URL) → none. Every provider reports availability
// cleanly; an unavailable provider is a skip, never a crash — extraction
// without OCR simply returns empty text, matching document-extract.ts's
// never-throw contract. Tests inject a fake provider, so no real OCR
// engine or network is needed to exercise the integration.

import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { delimiter, join } from 'node:path';

export class OcrUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrUnavailableError';
  }
}

export interface OcrProvider {
  readonly name: string;
  /** True when this provider can plausibly run right now. */
  isAvailable(): Promise<boolean>;
  /**
   * Recognize text in one image (png/jpg/gif/webp/tiff bytes).
   * Throws OcrUnavailableError when the provider cannot run.
   */
  recognize(image: Buffer, mimeType?: string): Promise<string>;
}

/** Locate an executable on PATH (or return null). */
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (name.includes('/')) {
    try {
      accessSync(name, fsConstants.X_OK);
      return name;
    } catch {
      return null;
    }
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // keep searching
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tesseract (local binary)
// ---------------------------------------------------------------------------

export interface TesseractOcrOptions {
  /** Binary name/path. Default 'tesseract'. */
  binary?: string;
  /** OCR language(s), e.g. 'eng' or 'eng+hin'. Default 'eng'. */
  lang?: string;
  env?: NodeJS.ProcessEnv;
}

export class TesseractOcrProvider implements OcrProvider {
  readonly name = 'tesseract';
  private readonly binary: string;
  private readonly lang: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: TesseractOcrOptions = {}) {
    this.binary = opts.binary ?? 'tesseract';
    this.lang = opts.lang ?? 'eng';
    this.env = opts.env ?? process.env;
  }

  async isAvailable(): Promise<boolean> {
    return findExecutable(this.binary, this.env) !== null;
  }

  async recognize(image: Buffer): Promise<string> {
    const bin = findExecutable(this.binary, this.env);
    if (!bin) {
      throw new OcrUnavailableError(
        `tesseract binary not found (looked for "${this.binary}" on PATH) — install tesseract-ocr or configure an HTTP OCR provider`,
      );
    }
    return new Promise((resolveFn, rejectFn) => {
      const child = spawn(bin, ['stdin', 'stdout', '-l', this.lang], { stdio: ['pipe', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (c: Buffer) => out.push(c));
      child.stderr.on('data', (c: Buffer) => err.push(c));
      child.on('error', (e) => rejectFn(new OcrUnavailableError(`failed to spawn tesseract: ${e.message}`)));
      child.on('close', (code) => {
        if (code !== 0) {
          rejectFn(new Error(`tesseract exited with code ${code}: ${Buffer.concat(err).toString('utf8').slice(0, 300)}`));
          return;
        }
        resolveFn(Buffer.concat(out).toString('utf8'));
      });
      child.stdin.end(image);
    });
  }
}

// ---------------------------------------------------------------------------
// HTTP OCR endpoint
// ---------------------------------------------------------------------------

export interface HttpOcrOptions {
  /** Endpoint that accepts a raw image POST and returns { text } JSON or plain text. */
  url: string;
  headers?: Record<string, string>;
  /** Injectable for tests. Default: global fetch. */
  fetchFn?: typeof fetch;
}

export class HttpOcrProvider implements OcrProvider {
  readonly name = 'http';
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly fetchFn: typeof fetch;

  constructor(opts: HttpOcrOptions) {
    this.url = opts.url;
    this.headers = opts.headers ?? {};
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async isAvailable(): Promise<boolean> {
    return typeof this.url === 'string' && this.url.length > 0;
  }

  async recognize(image: Buffer, mimeType = 'image/png'): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: 'POST',
        headers: { 'content-type': mimeType, ...this.headers },
        body: new Uint8Array(image),
      });
    } catch (err) {
      throw new OcrUnavailableError(
        `HTTP OCR endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) throw new Error(`HTTP OCR request failed: ${res.status}`);
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const data = (await res.json()) as { text?: unknown };
      if (typeof data.text !== 'string') throw new Error('HTTP OCR response JSON has no string "text" field');
      return data.text;
    }
    return res.text();
  }
}

// ---------------------------------------------------------------------------
// Chain
// ---------------------------------------------------------------------------

/** Tries providers in order; the first available one runs. */
export class ChainedOcrProvider implements OcrProvider {
  readonly name: string;
  /** Name of the provider that produced the last result (for result flags). */
  lastProviderName?: string;

  constructor(private readonly providers: OcrProvider[]) {
    this.name = providers.map((p) => p.name).join('+') || 'none';
  }

  async isAvailable(): Promise<boolean> {
    for (const p of this.providers) {
      if (await p.isAvailable().catch(() => false)) return true;
    }
    return false;
  }

  async recognize(image: Buffer, mimeType?: string): Promise<string> {
    const errors: string[] = [];
    for (const p of this.providers) {
      if (!(await p.isAvailable().catch(() => false))) {
        errors.push(`${p.name}: unavailable`);
        continue;
      }
      try {
        const text = await p.recognize(image, mimeType);
        this.lastProviderName = p.name;
        return text;
      } catch (err) {
        errors.push(`${p.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new OcrUnavailableError(`no OCR provider could run (${errors.join('; ') || 'chain is empty'})`);
  }
}

/**
 * Default chain: tesseract → HTTP endpoint from OCR_HTTP_URL → none.
 * Returns null when nothing is configured/available at construction time
 * is NOT checked here — availability is probed lazily per call.
 */
export function createDefaultOcrChain(env: NodeJS.ProcessEnv = process.env): ChainedOcrProvider {
  const providers: OcrProvider[] = [new TesseractOcrProvider({ env })];
  const url = (env.OCR_HTTP_URL ?? '').trim();
  if (url) {
    const headers: Record<string, string> = {};
    const key = (env.OCR_HTTP_API_KEY ?? '').trim();
    if (key) headers['authorization'] = `Bearer ${key}`;
    providers.push(new HttpOcrProvider({ url, headers }));
  }
  return new ChainedOcrProvider(providers);
}

/**
 * Resolve an effective provider from extraction options:
 * explicit single provider > explicit provider list (chained) > default chain.
 */
export function resolveOcrProvider(opts?: {
  ocrProvider?: OcrProvider;
  ocrProviders?: OcrProvider[];
  env?: NodeJS.ProcessEnv;
}): OcrProvider {
  if (opts?.ocrProvider) return opts.ocrProvider;
  if (opts?.ocrProviders && opts.ocrProviders.length > 0) return new ChainedOcrProvider(opts.ocrProviders);
  return createDefaultOcrChain(opts?.env);
}
