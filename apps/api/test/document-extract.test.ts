// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, beforeAll } from 'vitest';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractDocumentText,
  detectDocKind,
  EXTRACT_TEXT_CAP,
} from '../src/document-extract.js';

const FIXTURE_DIR = '/tmp/fixtures';
const WORK_DIR = join(tmpdir(), 'doc-extract-test');

beforeAll(() => {
  mkdirSync(WORK_DIR, { recursive: true });
  for (const f of ['test.pdf', 'test.docx', 'test.xlsx', 'test.pptx']) {
    copyFileSync(join(FIXTURE_DIR, f), join(WORK_DIR, f));
  }
  writeFileSync(join(WORK_DIR, 'hello.txt'), 'plain text file\nsecond line');
  writeFileSync(join(WORK_DIR, 'fake.pdf'), 'not a real pdf');
});

describe('detectDocKind', () => {
  it('detects by mime type', () => {
    expect(detectDocKind('application/pdf', 'x.bin')).toBe('pdf');
    expect(detectDocKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'x.bin')).toBe('docx');
  });
  it('detects by extension fallback', () => {
    expect(detectDocKind('application/octet-stream', 'report.pdf')).toBe('pdf');
    expect(detectDocKind('application/octet-stream', 'data.xlsx')).toBe('xlsx');
    expect(detectDocKind('application/octet-stream', 'deck.pptx')).toBe('pptx');
    expect(detectDocKind('application/octet-stream', 'notes.txt')).toBe('text');
  });
  it('returns unsupported for unknown', () => {
    expect(detectDocKind('application/octet-stream', 'blob.xyz')).toBe('unsupported');
    expect(detectDocKind('image/png', 'pic.png')).toBe('unsupported');
  });
});

describe('PDF extraction', () => {
  it('extracts text per page', async () => {
    const r = await extractDocumentText(join(WORK_DIR, 'test.pdf'), 'application/pdf', 'test.pdf');
    expect(r.kind).toBe('pdf');
    expect(r.text).toContain('Hello PDF world');
    expect(r.text).toContain('Second line of text');
    expect(r.units).toBe(1);
    expect(r.unitLabel).toBe('pages');
  });
  it('returns empty on corrupt pdf without throwing', async () => {
    const r = await extractDocumentText(join(WORK_DIR, 'fake.pdf'), 'application/pdf', 'fake.pdf');
    expect(r.text).toBe('');
  });
});

describe('DOCX extraction', () => {
  it('extracts paragraph text', async () => {
    const r = await extractDocumentText(
      join(WORK_DIR, 'test.docx'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'test.docx',
    );
    expect(r.kind).toBe('docx');
    expect(r.text).toContain('Hello DOCX world');
    expect(r.text).toContain('Second paragraph here');
  });
});

describe('XLSX extraction', () => {
  it('extracts sheets as markdown tables', async () => {
    const r = await extractDocumentText(
      join(WORK_DIR, 'test.xlsx'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'test.xlsx',
    );
    expect(r.kind).toBe('xlsx');
    expect(r.text).toContain('Alice');
    expect(r.text).toContain('Bob');
    expect(r.text).toContain('|');
    expect(r.units).toBe(1);
    expect(r.unitLabel).toBe('sheets');
  });
});

describe('PPTX extraction', () => {
  it('extracts slide text', async () => {
    const r = await extractDocumentText(
      join(WORK_DIR, 'test.pptx'),
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'test.pptx',
    );
    expect(r.kind).toBe('pptx');
    expect(r.text).toContain('Welcome to the presentation');
    expect(r.text).toContain('Slide two content');
    expect(r.units).toBe(2);
    expect(r.unitLabel).toBe('slides');
  });
});

describe('text files', () => {
  it('passes through with cap', async () => {
    const r = await extractDocumentText(join(WORK_DIR, 'hello.txt'), 'text/plain', 'hello.txt');
    expect(r.kind).toBe('text');
    expect(r.text).toContain('plain text file');
    expect(r.truncated).toBe(false);
  });
});

describe('unsupported', () => {
  it('returns empty without throwing', async () => {
    const r = await extractDocumentText(join(WORK_DIR, 'hello.txt'), 'image/png', 'pic.png');
    expect(r.kind).toBe('unsupported');
    expect(r.text).toBe('');
  });
  it('never throws on missing file', async () => {
    const r = await extractDocumentText(join(WORK_DIR, 'nope.pdf'), 'application/pdf', 'nope.pdf');
    expect(r.text).toBe('');
  });
});

describe('EXTRACT_TEXT_CAP', () => {
  it('is 100KB', () => {
    expect(EXTRACT_TEXT_CAP).toBe(100_000);
  });
});
