// SPDX-License-Identifier: Apache-2.0
// Minimal ZIP reader/writer — no third-party dependencies.
//
// Reader: parses the End-Of-Central-Directory record and the central
// directory, then reads each entry via its local header. Supports the two
// compression methods plugins use in practice: 0 (stored) and 8 (deflate,
// via node:zlib inflateRaw). Extraction is traversal-safe: absolute paths,
// drive letters, backslashes and `..` segments are rejected, and size /
// count caps bound zip-bomb damage.
//
// Writer (createZipArchive): just enough ZIP to package a plugin directory
// and to build test fixtures — stored or raw-deflate entries with a proper
// central directory and CRC-32 checksums.

import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipEntry {
  name: string;
  /** Uncompressed contents. */
  data: Buffer;
  /** 0 = stored, 8 = deflate. */
  method: number;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export const MAX_ZIP_ENTRIES = 1000;
export const MAX_ZIP_ENTRY_BYTES = 32 * 1024 * 1024;
export const MAX_ZIP_TOTAL_BYTES = 64 * 1024 * 1024;

function findEocd(buf: Buffer): number {
  // EOCD is at least 22 bytes; a trailing comment can add up to 65535.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function assertSafeEntryName(name: string): void {
  if (!name || name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name)) {
    throw new ZipError(`unsafe zip entry name: ${JSON.stringify(name)}`);
  }
  if (name.includes('\\')) throw new ZipError(`zip entry names must use "/" separators: ${JSON.stringify(name)}`);
  if (name.split('/').some((seg) => seg === '..')) {
    throw new ZipError(`zip entry escapes the target directory: ${JSON.stringify(name)}`);
  }
}

/** Read all entries of a ZIP archive held in memory. Throws ZipError. */
export function readZipEntries(buf: Buffer): ZipEntry[] {
  if (buf.length < 22) throw new ZipError('not a zip file (too small)');
  const eocd = findEocd(buf);
  if (eocd === -1) throw new ZipError('not a zip file (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ZIP_ENTRIES) throw new ZipError(`zip has too many entries (${count} > ${MAX_ZIP_ENTRIES})`);

  const entries: ZipEntry[] = [];
  let total = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) {
      throw new ZipError('corrupt zip: bad central directory entry');
    }
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory entry
    assertSafeEntryName(name);
    if (uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
      throw new ZipError(`zip entry too large: ${name} (${uncompressedSize} bytes)`);
    }
    total += uncompressedSize;
    if (total > MAX_ZIP_TOTAL_BYTES) throw new ZipError('zip expands beyond the total size cap');

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new ZipError(`corrupt zip: bad local header for ${name}`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + compressedSize);
    if (compressed.length !== compressedSize) throw new ZipError(`corrupt zip: truncated data for ${name}`);

    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(compressed);
    } else if (method === 8) {
      try {
        data = inflateRawSync(compressed, { maxOutputLength: MAX_ZIP_ENTRY_BYTES });
      } catch (err) {
        throw new ZipError(`failed to inflate ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      throw new ZipError(`unsupported zip compression method ${method} for ${name} (only stored/deflate)`);
    }
    if (data.length !== uncompressedSize) {
      throw new ZipError(`corrupt zip: size mismatch for ${name}`);
    }
    entries.push({ name, data, method });
  }
  return entries;
}

/** Extract a ZIP archive (in memory) under destDir. Traversal-safe. */
export function extractZipToDir(buf: Buffer, destDir: string): string[] {
  const entries = readZipEntries(buf);
  const root = resolve(destDir);
  const written: string[] = [];
  for (const entry of entries) {
    const target = resolve(join(root, entry.name));
    if (target !== root && !target.startsWith(root + sep)) {
      throw new ZipError(`zip entry escapes the target directory: ${entry.name}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
    written.push(target);
  }
  return written;
}

// ---------------------------------------------------------------------------
// Writer (packaging + test fixtures)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipWriteEntry {
  name: string;
  data: Buffer | string;
}

/** Build a ZIP archive in memory. Default method: deflate. */
export function createZipArchive(entries: ZipWriteEntry[], opts: { method?: 0 | 8 } = {}): Buffer {
  const method = opts.method ?? 8;
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    assertSafeEntryName(entry.name);
    const data = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data;
    const compressed = method === 8 ? deflateRawSync(data) : Buffer.from(data);
    const crc = crc32(data);
    const nameBuf = Buffer.from(entry.name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    localParts.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += 30 + nameBuf.length + compressed.length;
  }
  const cdStart = offset;
  const cd = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...localParts, cd, eocd]);
}
