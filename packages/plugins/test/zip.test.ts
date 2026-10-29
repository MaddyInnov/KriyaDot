// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ZipError, createZipArchive, extractZipToDir, readZipEntries } from '../src/zip.js';

describe('zip reader/writer', () => {
  it('round-trips stored and deflated entries', () => {
    for (const method of [0, 8] as const) {
      const zip = createZipArchive(
        [
          { name: 'plugin.json', data: '{"id":"x"}' },
          { name: 'sub/file.txt', data: Buffer.from('hello hello hello hello') },
        ],
        { method },
      );
      const entries = readZipEntries(zip);
      expect(entries.map((e) => e.name)).toEqual(['plugin.json', 'sub/file.txt']);
      expect(entries[0]!.data.toString('utf8')).toBe('{"id":"x"}');
      expect(entries[1]!.data.toString('utf8')).toBe('hello hello hello hello');
    }
  });

  it('extracts to a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zip-test-'));
    const zip = createZipArchive([{ name: 'a/b.txt', data: 'deep' }]);
    extractZipToDir(zip, dir);
    expect(readFileSync(join(dir, 'a', 'b.txt'), 'utf8')).toBe('deep');
    expect(existsSync(join(dir, 'a', 'b.txt'))).toBe(true);
  });

  it('rejects traversal entries and garbage input', () => {
    // Hand-rolled writer refuses traversal at write time; craft via stored
    // archive of a safe name then corrupt the name in the central directory.
    const zip = createZipArchive([{ name: 'safe.txt', data: 'x' }], { method: 0 });
    const corrupted = Buffer.from(zip);
    const idx = corrupted.indexOf('safe.txt');
    corrupted.write('../e.txt', idx);
    // Second copy lives in the central directory.
    const idx2 = corrupted.indexOf('safe.txt');
    if (idx2 !== -1) corrupted.write('../e.txt', idx2);
    expect(() => readZipEntries(corrupted)).toThrow(ZipError);
    expect(() => readZipEntries(Buffer.from('not a zip at all, sorry'))).toThrow(ZipError);
  });
});
