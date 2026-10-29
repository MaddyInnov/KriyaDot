// SPDX-License-Identifier: Apache-2.0
// OCR ingestion: fake providers only — no real OCR engine, no network.

import { describe, expect, it, beforeAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ChainedOcrProvider,
  HttpOcrProvider,
  OcrUnavailableError,
  TesseractOcrProvider,
  findExecutable,
  type OcrProvider,
} from '../src/ocr.js';
import { extractDocumentText, detectDocKind } from '../src/document-extract.js';

const WORK_DIR = join(tmpdir(), 'ocr-extract-test');

class FakeOcrProvider implements OcrProvider {
  readonly name = 'fake-ocr';
  calls = 0;
  constructor(private readonly text: string) {}
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async recognize(): Promise<string> {
    this.calls += 1;
    return this.text;
  }
}

class UnavailableProvider implements OcrProvider {
  readonly name = 'never';
  async isAvailable(): Promise<boolean> {
    return false;
  }
  async recognize(): Promise<string> {
    throw new OcrUnavailableError('never available');
  }
}

/** Minimal PDF builder (same pattern as document-extract.test.ts). */
function makePdf(lines: string[]): Uint8Array {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const ops = lines.map((l, i) => `BT /F1 12 Tf 72 ${720 - i * 20} Td (${esc(l)}) Tj ET`).join('\n');
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

beforeAll(() => {
  mkdirSync(WORK_DIR, { recursive: true });
  writeFileSync(join(WORK_DIR, 'scan.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  writeFileSync(join(WORK_DIR, 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]));
  writeFileSync(join(WORK_DIR, 'blank.pdf'), makePdf([]));
  writeFileSync(join(WORK_DIR, 'text.pdf'), makePdf(['Real text layer']));
});

describe('OCR providers', () => {
  it('tesseract provider reports a clean unavailable error when the binary is missing', async () => {
    const provider = new TesseractOcrProvider({ binary: 'tesseract-definitely-not-installed-xyz' });
    expect(await provider.isAvailable()).toBe(false);
    await expect(provider.recognize(Buffer.from('x'))).rejects.toThrow(OcrUnavailableError);
  });

  it('http provider posts the image and reads { text } JSON via injected fetch', async () => {
    let seenContentType = '';
    const provider = new HttpOcrProvider({
      url: 'http://ocr.invalid/recognize',
      fetchFn: async (_url, init) => {
        seenContentType = String((init?.headers as Record<string, string>)['content-type']);
        return new Response(JSON.stringify({ text: 'http ocr text' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    expect(await provider.recognize(Buffer.from('img'), 'image/png')).toBe('http ocr text');
    expect(seenContentType).toBe('image/png');
  });

  it('chain skips unavailable providers and names the winner', async () => {
    const fake = new FakeOcrProvider('chained text');
    const chain = new ChainedOcrProvider([new UnavailableProvider(), fake]);
    expect(await chain.isAvailable()).toBe(true);
    expect(await chain.recognize(Buffer.from('img'))).toBe('chained text');
    expect(chain.lastProviderName).toBe('fake-ocr');
  });

  it('chain with nothing available throws OcrUnavailableError', async () => {
    const chain = new ChainedOcrProvider([new UnavailableProvider()]);
    await expect(chain.recognize(Buffer.from('img'))).rejects.toThrow(OcrUnavailableError);
  });
});

describe('OCR extraction integration', () => {
  it('image file → text via injected fake provider, flagged ocr:true', async () => {
    const fake = new FakeOcrProvider('HELLO FROM A SCANNED RECEIPT');
    const r = await extractDocumentText(join(WORK_DIR, 'scan.png'), 'image/png', 'scan.png', {
      ocrProvider: fake,
    });
    expect(r.kind).toBe('image');
    expect(r.text).toContain('SCANNED RECEIPT');
    expect(r.ocr).toBe(true);
    expect(r.ocrProvider).toBe('fake-ocr');
    expect(fake.calls).toBe(1);
  });

  it('jpg by extension also routes to OCR', async () => {
    const r = await extractDocumentText(join(WORK_DIR, 'photo.jpg'), '', 'photo.jpg', {
      ocrProvider: new FakeOcrProvider('jpeg text'),
    });
    expect(r.kind).toBe('image');
    expect(r.text).toBe('jpeg text');
  });

  it('no available provider → legacy unsupported result, no throw', async () => {
    const r = await extractDocumentText(join(WORK_DIR, 'scan.png'), 'image/png', 'scan.png', {
      ocrProvider: new UnavailableProvider(),
    });
    expect(r.kind).toBe('unsupported');
    expect(r.text).toBe('');
    expect(r.ocr).toBeUndefined();
    // detectDocKind legacy contract is unchanged.
    expect(detectDocKind('image/png', 'scan.png')).toBe('unsupported');
  });

  it('PDF with a text layer does NOT invoke OCR', async () => {
    const fake = new FakeOcrProvider('should not be used');
    const r = await extractDocumentText(join(WORK_DIR, 'text.pdf'), 'application/pdf', 'text.pdf', {
      ocrProvider: fake,
    });
    expect(r.text).toContain('Real text layer');
    expect(r.ocr).toBeUndefined();
    expect(fake.calls).toBe(0);
  });

  it('textless PDF → rasterize + OCR when pdftoppm exists (skips gracefully otherwise)', async () => {
    const fake = new FakeOcrProvider('TEXT FROM A SCANNED PAGE');
    const r = await extractDocumentText(join(WORK_DIR, 'blank.pdf'), 'application/pdf', 'blank.pdf', {
      ocrProvider: fake,
    });
    if (findExecutable('pdftoppm') === null) {
      // Graceful degradation: no rasterizer → empty text, still kind pdf.
      expect(r.kind).toBe('pdf');
      expect(r.text).toBe('');
      return;
    }
    expect(r.kind).toBe('pdf');
    expect(r.text).toContain('SCANNED PAGE');
    expect(r.ocr).toBe(true);
    expect(r.ocrProvider).toBe('fake-ocr');
    expect(fake.calls).toBeGreaterThan(0);
  });
});
