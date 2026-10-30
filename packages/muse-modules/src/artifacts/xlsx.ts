// SPDX-License-Identifier: Apache-2.0
// Real XLSX (OOXML spreadsheet) export for markdown artifacts.
//
// Every markdown table in the artifact becomes its own worksheet (unlike the
// legacy CSV export, which only takes the first table). Sheet names come
// from the heading preceding the table, falling back to "Table N", sanitised
// to Excel's rules (<=31 chars, none of []:*?/\) and de-duplicated.
//
// Cell typing is deliberately text-safe:
//   - canonical numbers (no leading zeros, no thousands separators, no
//     exponent tricks) become real numeric cells so Excel can sum/sort them;
//   - dates, times, percentages, currency amounts and everything else stay
//     inline strings, so values like 2026-10-30 or 007 are never silently
//     reinterpreted or mangled by a spreadsheet's type inference.
// The header row is bold via a real styles part (cellXfs entry 1).

import { ValidationError } from '../errors.js';
import { extractMarkdownTables } from './markdown.js';
import {
  XML_DECL,
  contentTypesXml,
  corePropsXml,
  createStoreZip,
  relsXml,
  xmlAttr,
  xmlEscape,
  REL_TYPE,
  type ZipPart,
} from './ooxml.js';
import type { Artifact } from './index.js';

const S_NS =
  'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** Excel column letters for a 0-based index (0 → A, 26 → AA). */
export function columnRef(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const CANONICAL_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;

export type XlsxCell =
  | { kind: 'number'; value: string }
  | { kind: 'text'; value: string };

/** Infer a cell's XLSX type, text-safe as documented in the file header. */
export function inferXlsxCell(raw: string): XlsxCell {
  const v = raw.replace(/`/g, '').trim();
  if (CANONICAL_NUMBER.test(v) && Number.isFinite(Number(v))) {
    return { kind: 'number', value: v };
  }
  return { kind: 'text', value: v };
}

/** Sanitise + de-duplicate worksheet names per Excel's rules. */
export function sheetName(raw: string, used: Set<string>): string {
  let base = raw.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31);
  if (!base) base = 'Table';
  let name = base;
  let n = 2;
  while (used.has(name.toLowerCase())) {
    const suffix = ` (${n++})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(name.toLowerCase());
  return name;
}

const STYLES_XML =
  XML_DECL +
  `<styleSheet ${S_NS}>` +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  // xf 0 = default, xf 1 = bold header.
  '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
  '</styleSheet>';

function sheetXml(rows: string[][]): string {
  const rowXml = rows
    .map((row, ri) => {
      const cells = row
        .map((raw, ci) => {
          const ref = `${columnRef(ci)}${ri + 1}`;
          const cell = inferXlsxCell(raw);
          const style = ri === 0 ? ' s="1"' : '';
          if (cell.kind === 'number') return `<c r="${ref}"${style}><v>${cell.value}</v></c>`;
          if (cell.value === '' && ri !== 0) return `<c r="${ref}"/>`;
          return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell.value)}</t></is></c>`;
        })
        .join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join('');
  return XML_DECL + `<worksheet ${S_NS}><sheetData>${rowXml}</sheetData></worksheet>`;
}

/** Render ALL of an artifact's markdown tables as an XLSX workbook. */
export function renderArtifactXlsx(artifact: Artifact): Uint8Array {
  const tables = extractMarkdownTables(artifact.content);
  if (tables.length === 0) {
    throw new ValidationError('artifact contains no markdown table to export as XLSX');
  }
  const used = new Set<string>();
  const names = tables.map((t, i) => sheetName(t.heading || `Table ${i + 1}`, used));

  const sheets = names
    .map((name, i) => `<sheet name="${xmlAttr(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');
  const workbookXml = XML_DECL + `<workbook ${S_NS}><sheets>${sheets}</sheets></workbook>`;
  const workbookRels = relsXml([
    ...tables.map((_, i) => ({
      id: `rId${i + 1}`,
      type: REL_TYPE.worksheet,
      target: `worksheets/sheet${i + 1}.xml`,
    })),
    { id: `rId${tables.length + 1}`, type: REL_TYPE.styles, target: 'styles.xml' },
  ]);

  const parts: ZipPart[] = [
    {
      name: '[Content_Types].xml',
      data: contentTypesXml([
        { part: 'xl/workbook.xml', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml' },
        ...tables.map((_, i) => ({
          part: `xl/worksheets/sheet${i + 1}.xml`,
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
        })),
        { part: 'xl/styles.xml', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml' },
        { part: 'docProps/core.xml', type: 'application/vnd.openxmlformats-package.core-properties+xml' },
      ]),
    },
    {
      name: '_rels/.rels',
      data: relsXml([
        { id: 'rId1', type: REL_TYPE.officeDocument, target: 'xl/workbook.xml' },
        { id: 'rId2', type: REL_TYPE.coreProps, target: 'docProps/core.xml' },
      ]),
    },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/styles.xml', data: STYLES_XML },
    ...tables.map((t, i): ZipPart => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(t.rows) })),
    { name: 'docProps/core.xml', data: corePropsXml(artifact.title) },
  ];
  return createStoreZip(parts);
}
