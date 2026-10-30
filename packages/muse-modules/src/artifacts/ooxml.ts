// SPDX-License-Identifier: Apache-2.0
// Shared OOXML plumbing: XML escaping, CRC-32, and a minimal deterministic
// store-only (no compression) ZIP writer/reader.
//
// Why a local writer instead of reusing packages/plugins/src/zip.ts?
// @mvp/plugins is not a dependency of @mvp/muse-modules, and adding a new
// package dependency would need lockfile changes for zero functional gain:
// OOXML parts are small XML files, so stored (uncompressed) entries are
// perfectly valid and every Office reader accepts them. Store-only also
// makes the output byte-for-byte deterministic: entries are written in the
// order given, with a fixed DOS timestamp (1980-01-01) and no extra fields.
//
// The reader exists for tests and round-trip verification; it only accepts
// the stored archives this writer produces (plus any other stored-entry
// ZIP), which is all the export tests need.

/** Escape a string for use as XML character data. */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape a string for use inside a double-quoted XML attribute. */
export function xmlAttr(s: string): string {
  return xmlEscape(s).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipPart {
  name: string;
  data: string | Uint8Array;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
// Fixed DOS date/time: 1980-01-01 00:00:00 (the earliest representable).
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1; // month=1, day=1, year offset 0 (=1980)

function assertSafeName(name: string): void {
  if (
    !name ||
    name.startsWith('/') ||
    name.includes('\\') ||
    /^[A-Za-z]:/.test(name) ||
    name.split('/').some((seg) => seg === '..' || seg === '')
  ) {
    throw new Error(`unsafe zip entry name: ${JSON.stringify(name)}`);
  }
}

/** Build a deterministic store-only ZIP archive from ordered parts. */
export function createStoreZip(parts: ZipPart[]): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    assertSafeName(part.name);
    const data = typeof part.data === 'string' ? Buffer.from(part.data, 'utf8') : Buffer.from(part.data);
    const nameBuf = Buffer.from(part.name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    local.writeUInt16LE(0, 8); // method 0 = stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    localParts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += 30 + nameBuf.length + data.length;
  }
  const cdStart = offset;
  const cd = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(parts.length, 8);
  eocd.writeUInt16LE(parts.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return new Uint8Array(Buffer.concat([...localParts, cd, eocd]));
}

/** Read back a store-only ZIP (e.g. one produced here) into name → bytes. */
export function readStoreZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const buf = Buffer.from(bytes);
  if (buf.length < 22) throw new Error('not a zip file (too small)');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('not a zip file (no end-of-central-directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) throw new Error('corrupt zip: bad central entry');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (method !== 0) throw new Error(`readStoreZip: unsupported method ${method} for ${name} (stored only)`);
    if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error(`corrupt zip: bad local header for ${name}`);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    out.set(name, new Uint8Array(buf.subarray(start, start + size)));
  }
  return out;
}

/** Convenience for tests/callers: read one part as a UTF-8 string. */
export function zipPartText(parts: Map<string, Uint8Array>, name: string): string {
  const data = parts.get(name);
  if (!data) throw new Error(`zip part missing: ${name}`);
  return Buffer.from(data).toString('utf8');
}

export const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** `[Content_Types].xml` for a package: rels/xml defaults + given overrides. */
export function contentTypesXml(overrides: Array<{ part: string; type: string }>): string {
  const ov = overrides
    .map((o) => `<Override PartName="/${o.part}" ContentType="${o.type}"/>`)
    .join('');
  return (
    XML_DECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    ov +
    '</Types>'
  );
}

export const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** A `.rels` part from (id, type, target, optional external) tuples. */
export function relsXml(
  rels: Array<{ id: string; type: string; target: string; external?: boolean }>,
): string {
  const body = rels
    .map(
      (r) =>
        `<Relationship Id="${r.id}" Type="${r.type}" Target="${xmlAttr(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`,
    )
    .join('');
  return XML_DECL + `<Relationships xmlns="${REL_NS}">${body}</Relationships>`;
}

export const REL_TYPE = {
  officeDocument:
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  coreProps: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  extendedProps:
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties',
  styles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
  numbering: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering',
  hyperlink: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
  worksheet: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
  slide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
  slideLayout: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
  slideMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster',
  theme: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
  notesSlide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide',
  notesMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster',
  image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
} as const;

/** Minimal docProps/core.xml part. */
export function corePropsXml(title: string): string {
  return (
    XML_DECL +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${xmlEscape(title)}</dc:title><dc:creator>KriyaDot</dc:creator>` +
    '<cp:lastModifiedBy>KriyaDot</cp:lastModifiedBy></cp:coreProperties>'
  );
}
