// SPDX-License-Identifier: Apache-2.0
// Real DOCX (OOXML word-processing) export for markdown artifacts.
//
// Produces a valid Word package with zero dependencies: [Content_Types].xml,
// package rels, word/document.xml, word/styles.xml, word/numbering.xml (real
// bullet/decimal lists), and word/_rels/document.xml.rels for hyperlinks.
// Markdown coverage: headings 1-6, paragraphs, bold/italic/code/link runs,
// bullet + numbered lists, fenced code blocks, blockquotes, rules, and
// markdown tables rendered as shaded-header Word tables.

import { parseInline, parseMarkdown, type InlineRun } from './markdown.js';
import {
  XML_DECL,
  contentTypesXml,
  corePropsXml,
  createStoreZip,
  relsXml,
  xmlEscape,
  REL_TYPE,
  type ZipPart,
} from './ooxml.js';
import type { Artifact } from './index.js';

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function runProps(run: InlineRun): string {
  let rpr = '';
  if (run.bold) rpr += '<w:b/>';
  if (run.italic) rpr += '<w:i/>';
  if (run.code) rpr += '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/>';
  return rpr ? `<w:rPr>${rpr}</w:rPr>` : '';
}

interface DocxCtx {
  /** hyperlink URL → relationship id */
  links: Map<string, string>;
  nextLinkId: number;
  /** numbering instance id counter (numId in numbering.xml). */
  nextNumId: number;
  /** (abstractNumId, numId) pairs actually used: 0 = bullet, 1 = decimal. */
  nums: Array<{ abstract: number; numId: number }>;
}

function runsXml(runs: InlineRun[], ctx: DocxCtx): string {
  return runs
    .map((run) => {
      const inner = `<w:r>${runProps(run)}<w:t xml:space="preserve">${xmlEscape(run.text)}</w:t></w:r>`;
      if (run.link) {
        let rid = ctx.links.get(run.link);
        if (!rid) {
          rid = `rId${ctx.nextLinkId++}`;
          ctx.links.set(run.link, rid);
        }
        return `<w:hyperlink r:id="${rid}">${inner}</w:hyperlink>`;
      }
      return inner;
    })
    .join('');
}

function paraXml(runs: InlineRun[], ctx: DocxCtx, pStyle?: string, extraPpr = ''): string {
  const ppr = pStyle || extraPpr ? `<w:pPr>${pStyle ? `<w:pStyle w:val="${pStyle}"/>` : ''}${extraPpr}</w:pPr>` : '';
  return `<w:p>${ppr}${runsXml(runs, ctx)}</w:p>`;
}

function tableXml(rows: string[][], ctx: DocxCtx): string {
  const cols = Math.max(...rows.map((r) => r.length), 1);
  const grid = Array.from({ length: cols }, () => '<w:gridCol w:w="1800"/>').join('');
  const trs = rows
    .map((row, ri) => {
      const cells = Array.from({ length: cols }, (_, ci) => {
        const text = (row[ci] ?? '').replace(/`/g, '');
        const runs: InlineRun[] =
          ri === 0 ? [{ text, bold: true }] : parseMarkdownInlineCell(text);
        const shade = ri === 0 ? '<w:shd w:val="clear" w:fill="D9E2F3"/>' : '';
        return `<w:tc><w:tcPr><w:tcW w:w="1800" w:type="dxa"/>${shade}</w:tcPr>${paraXml(runs, ctx)}</w:tc>`;
      }).join('');
      const trPr = ri === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
      return `<w:tr>${trPr}${cells}</w:tr>`;
    })
    .join('');
  const borders =
    '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((b) => `<w:${b} w:val="single" w:sz="4" w:space="0" w:color="B0B0B0"/>`)
      .join('') +
    '</w:tblBorders>';
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${borders}</w:tblPr><w:tblGrid>${grid}</w:tblGrid>${trs}</w:tbl>`;
}

function parseMarkdownInlineCell(text: string): InlineRun[] {
  return parseInline(text);
}

const STYLES_XML =
  XML_DECL +
  `<w:styles ${W_NS}>` +
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>' +
  '<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>' +
  '<w:pPr><w:spacing w:after="120" w:line="276"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="52"/><w:color w:val="1F3864"/></w:rPr></w:style>' +
  [1, 2, 3, 4, 5, 6]
    .map((n) => {
      const sizes: Record<number, number> = { 1: 36, 2: 30, 3: 26, 4: 24, 5: 22, 6: 22 };
      return (
        `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/>` +
        `<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/>` +
        `<w:spacing w:before="${n === 1 ? 320 : 240}" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr>` +
        `<w:rPr><w:b/><w:sz w:val="${sizes[n]}"/><w:color w:val="1F3864"/>${n >= 5 ? '<w:i/>' : ''}</w:rPr></w:style>`
      );
    })
    .join('') +
  '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:ind w:left="360"/><w:spacing w:after="120"/></w:pPr><w:rPr><w:i/><w:color w:val="595959"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:shd w:val="clear" w:fill="F2F2F2"/><w:ind w:left="180"/><w:spacing w:after="120"/></w:pPr>' +
  '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="19"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/>' +
  '<w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/></w:pPr></w:style>' +
  '</w:styles>';

function numberingXml(nums: Array<{ abstract: number; numId: number }>): string {
  const abstracts = [0, 1]
    .map((abs) => {
      const fmt = abs === 0 ? 'bullet' : 'decimal';
      const txt = abs === 0 ? '•' : '%1.';
      return (
        `<w:abstractNum w:abstractNumId="${abs}"><w:multiLevelType w:val="singleLevel"/>` +
        `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${txt}"/>` +
        '<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="180"/></w:pPr></w:lvl></w:abstractNum>'
      );
    })
    .join('');
  const instances = nums
    .map((n) => `<w:num w:numId="${n.numId}"><w:abstractNumId w:val="${n.abstract}"/></w:num>`)
    .join('');
  return XML_DECL + `<w:numbering ${W_NS}>${abstracts}${instances}</w:numbering>`;
}

/** Render a markdown artifact as DOCX bytes. */
export function renderArtifactDocx(artifact: Artifact): Uint8Array {
  const ctx: DocxCtx = { links: new Map(), nextLinkId: 10, nextNumId: 1, nums: [] };
  const body: string[] = [];
  body.push(paraXml([{ text: artifact.title, bold: true }], ctx, 'Title'));

  for (const block of parseMarkdown(artifact.content)) {
    switch (block.kind) {
      case 'heading':
        body.push(paraXml(block.runs, ctx, `Heading${Math.min(block.level, 6)}`));
        break;
      case 'paragraph':
        body.push(paraXml(block.runs, ctx));
        break;
      case 'quote':
        body.push(paraXml(block.runs, ctx, 'Quote'));
        break;
      case 'list': {
        const numId = ctx.nextNumId++;
        ctx.nums.push({ abstract: block.ordered ? 1 : 0, numId });
        for (const item of block.items) {
          body.push(
            paraXml(
              item.runs,
              ctx,
              'ListParagraph',
              `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>`,
            ),
          );
        }
        break;
      }
      case 'code': {
        const lines = block.text.split('\n');
        const inner = lines
          .map(
            (ln, idx) =>
              `<w:r><w:t xml:space="preserve">${xmlEscape(ln) || ' '}</w:t></w:r>${idx < lines.length - 1 ? '<w:r><w:br/></w:r>' : ''}`,
          )
          .join('');
        body.push(`<w:p><w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr>${inner}</w:p>`);
        break;
      }
      case 'rule':
        body.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="B0B0B0"/></w:pBdr></w:pPr></w:p>');
        break;
      case 'table':
        body.push(tableXml(block.rows, ctx));
        body.push('<w:p/>');
        break;
    }
  }

  const sectPr =
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" ' +
    'w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>';
  const documentXml =
    XML_DECL + `<w:document ${W_NS}><w:body>${body.join('')}${sectPr}</w:body></w:document>`;

  const docRels: Array<{ id: string; type: string; target: string; external?: boolean }> = [
    { id: 'rId1', type: REL_TYPE.styles, target: 'styles.xml' },
    { id: 'rId2', type: REL_TYPE.numbering, target: 'numbering.xml' },
  ];
  for (const [url, rid] of ctx.links) {
    docRels.push({ id: rid, type: REL_TYPE.hyperlink, target: url, external: true });
  }

  const ctType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
  const parts: ZipPart[] = [
    {
      name: '[Content_Types].xml',
      data: contentTypesXml([
        { part: 'word/document.xml', type: ctType },
        { part: 'word/styles.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml' },
        { part: 'word/numbering.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml' },
        { part: 'docProps/core.xml', type: 'application/vnd.openxmlformats-package.core-properties+xml' },
      ]),
    },
    {
      name: '_rels/.rels',
      data: relsXml([
        { id: 'rId1', type: REL_TYPE.officeDocument, target: 'word/document.xml' },
        { id: 'rId2', type: REL_TYPE.coreProps, target: 'docProps/core.xml' },
      ]),
    },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/styles.xml', data: STYLES_XML },
    { name: 'word/numbering.xml', data: numberingXml(ctx.nums) },
    { name: 'word/_rels/document.xml.rels', data: relsXml(docRels) },
    { name: 'docProps/core.xml', data: corePropsXml(artifact.title) },
  ];
  return createStoreZip(parts);
}
