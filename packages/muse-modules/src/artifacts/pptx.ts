// SPDX-License-Identifier: Apache-2.0
// Real PPTX (OOXML presentation) export for slide decks.
//
// Maps the slides module's deck model onto a valid PowerPoint package:
//   - title layout slides  -> centred large title + subtitle text boxes
//   - bullets slides       -> heading + bulleted body
//   - two-column slides    -> heading + two side-by-side bullet bodies
//   - image slides         -> heading + an image-placeholder box naming the
//                             image URL (remote images are never fetched, so
//                             exports stay offline/deterministic) + bullets
// Speaker notes (Slide.notes) become real notes slides with a notes master,
// present only when at least one slide carries notes. Slide size is 16:9.
// All shapes are absolutely-positioned text boxes on a blank layout, which
// every PowerPoint-compatible renderer (PowerPoint, LibreOffice, Keynote,
// Google Slides import) displays identically.

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
import type { Slide, SlideDeck } from '../slides/index.js';

const P_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

// 16:9 slide size in EMU (13.333in x 7.5in).
const CX = 12192000;
const CY = 6858000;
const MARGIN = 685800; // 0.75in

function txBox(
  id: number,
  name: string,
  x: number,
  y: number,
  cx: number,
  cy: number,
  paras: string,
  fill?: string,
): string {
  const fillXml = fill
    ? `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>`
    : '<a:noFill/>';
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlEscape(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fillXml}</p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody></p:sp>`
  );
}

function para(
  text: string,
  opts: { size?: number; bold?: boolean; color?: string; align?: string; bullet?: boolean } = {},
): string {
  const size = opts.size ?? 2000;
  const align = opts.align ? ` algn="${opts.align}"` : '';
  const bullet = opts.bullet
    ? '<a:buFont typeface="Arial"/><a:buChar char="•"/>'
    : '<a:buNone/>';
  return (
    `<a:p><a:pPr${align} lvl="0"><a:lnSpc><a:spcPct val="120000"/></a:lnSpc>${bullet}</a:pPr>` +
    `<a:r><a:rPr lang="en-US" sz="${size}"${opts.bold ? ' b="1"' : ''}>` +
    `<a:solidFill><a:srgbClr val="${opts.color ?? '262626'}"/></a:solidFill></a:rPr>` +
    `<a:t>${xmlEscape(text)}</a:t></a:r></a:p>`
  );
}

function bulletParas(items: string[], size = 2000): string {
  const clean = items.filter((b) => b.trim() !== '');
  if (clean.length === 0) return para('', { size });
  return clean.map((b) => para(b, { size, bullet: true })).join('');
}

function slideShapes(slide: Slide, deckTitle: string): string {
  const width = CX - MARGIN * 2;
  switch (slide.layout) {
    case 'title':
      return (
        txBox(2, 'Title', MARGIN, 1800000, width, 1400000,
          para(slide.heading || deckTitle, { size: 4400, bold: true, color: '1F3864', align: 'ctr' })) +
        txBox(3, 'Subtitle', MARGIN, 3300000, width, 900000,
          slide.bullets.map((b) => para(b, { size: 2400, color: '595959', align: 'ctr' })).join('') ||
            para('', { size: 2400 }))
      );
    case 'two-column': {
      const colW = Math.floor((width - 457200) / 2);
      return (
        txBox(2, 'Heading', MARGIN, 457200, width, 900000,
          para(slide.heading, { size: 3200, bold: true, color: '1F3864' })) +
        txBox(3, 'Left column', MARGIN, 1600000, colW, 4600000, bulletParas(slide.bullets)) +
        txBox(4, 'Right column', MARGIN + colW + 457200, 1600000, colW, 4600000, bulletParas(slide.extra))
      );
    }
    case 'image': {
      const url = slide.extra[0] ?? '';
      const placeholder = url
        ? txBox(3, 'Image placeholder', MARGIN, 1500000, width, 2000000,
            para(`Image: ${url}`, { size: 1600, color: '808080', align: 'ctr' }), 'F2F2F2')
        : '';
      return (
        txBox(2, 'Heading', MARGIN, 457200, width, 900000,
          para(slide.heading, { size: 3200, bold: true, color: '1F3864' })) +
        placeholder +
        txBox(4, 'Body', MARGIN, url ? 3800000 : 1600000, width, 2600000, bulletParas(slide.bullets))
      );
    }
    case 'bullets':
    default:
      return (
        txBox(2, 'Heading', MARGIN, 457200, width, 900000,
          para(slide.heading, { size: 3200, bold: true, color: '1F3864' })) +
        txBox(3, 'Body', MARGIN, 1600000, width, 4600000, bulletParas(slide.bullets))
      );
  }
}

function slideXml(slide: Slide, deckTitle: string): string {
  return (
    XML_DECL +
    `<p:sld ${P_NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>` +
    `<a:effectLst/></p:bgPr></p:bg><p:spTree>` +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    slideShapes(slide, deckTitle) +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
  );
}

function notesSlideXml(slide: Slide): string {
  return (
    XML_DECL +
    `<p:notes ${P_NS}><p:cSld><p:spTree>` +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    txBox(2, 'Notes', MARGIN, MARGIN, CX - MARGIN * 2, CY - MARGIN * 2,
      slide.notes.split('\n').map((ln) => para(ln, { size: 1800 })).join('')) +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>'
  );
}

const THEME_XML =
  XML_DECL +
  '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="KriyaDot">' +
  '<a:themeElements><a:clrScheme name="KriyaDot">' +
  '<a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="1F3864"/></a:dk2><a:lt2><a:srgbClr val="F2F2F2"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="2E75B6"/></a:accent1><a:accent2><a:srgbClr val="548235"/></a:accent2>' +
  '<a:accent3><a:srgbClr val="BF8F00"/></a:accent3><a:accent4><a:srgbClr val="806000"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="305496"/></a:accent5><a:accent6><a:srgbClr val="595959"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>' +
  '</a:clrScheme><a:fontScheme name="KriyaDot">' +
  '<a:majorFont><a:latin typeface="Calibri"/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme>' +
  '<a:fmtScheme name="KriyaDot"><a:fillStyleLst>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3) +
  '</a:fillStyleLst><a:lnStyleLst>' +
  '<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'.repeat(3) +
  '</a:lnStyleLst><a:effectStyleLst>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3) +
  '</a:effectStyleLst><a:bgFillStyleLst>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3) +
  '</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>';

function masterXml(kind: 'slide' | 'notes'): string {
  const tag = kind === 'slide' ? 'sldMaster' : 'notesMaster';
  return (
    XML_DECL +
    `<p:${tag} ${P_NS}><p:cSld><p:spTree>` +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    '</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" ' +
    'accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" ' +
    'hlink="hlink" folHlink="folHlink"/>' +
    (kind === 'slide'
      ? '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
      : '') +
    '<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>' +
    `</p:${tag}>`
  );
}

const LAYOUT_XML =
  XML_DECL +
  `<p:sldLayout ${P_NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>` +
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
  '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
  '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';

/** Render a slide deck as PPTX bytes. */
export function renderDeckPptx(deck: SlideDeck): Uint8Array {
  const slides = deck.slides;
  const hasNotes = slides.some((s) => s.notes.trim() !== '');
  let notesIdx = 0;
  const notesOf = new Map<number, number>(); // slide index -> notes part number
  slides.forEach((s, i) => {
    if (s.notes.trim() !== '') notesOf.set(i, ++notesIdx);
  });

  const presRels: Array<{ id: string; type: string; target: string }> = [
    { id: 'rId1', type: REL_TYPE.slideMaster, target: 'slideMasters/slideMaster1.xml' },
    ...slides.map((_, i) => ({
      id: `rId${i + 2}`,
      type: REL_TYPE.slide,
      target: `slides/slide${i + 1}.xml`,
    })),
  ];
  if (hasNotes) {
    presRels.push({
      id: `rId${slides.length + 2}`,
      type: REL_TYPE.notesMaster,
      target: 'notesMasters/notesMaster1.xml',
    });
  }
  const sldIds = slides
    .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`)
    .join('');
  const presentationXml =
    XML_DECL +
    `<p:presentation ${P_NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
    (hasNotes ? '<p:notesMasterIdLst><p:notesMasterId r:id="rId' + (slides.length + 2) + '"/></p:notesMasterIdLst>' : '') +
    `<p:sldIdLst>${sldIds}</p:sldIdLst><p:sldSz cx="${CX}" cy="${CY}"/>` +
    `<p:notesSz cx="${CY}" cy="${CX}"/></p:presentation>`;

  const overrides: Array<{ part: string; type: string }> = [
    { part: 'ppt/presentation.xml', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml' },
    { part: 'ppt/slideMasters/slideMaster1.xml', type: 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml' },
    { part: 'ppt/slideLayouts/slideLayout1.xml', type: 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml' },
    { part: 'ppt/theme/theme1.xml', type: 'application/vnd.openxmlformats-officedocument.theme+xml' },
    ...slides.map((_, i) => ({
      part: `ppt/slides/slide${i + 1}.xml`,
      type: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
    })),
    { part: 'docProps/core.xml', type: 'application/vnd.openxmlformats-package.core-properties+xml' },
  ];
  if (hasNotes) {
    overrides.push(
      { part: 'ppt/notesMasters/notesMaster1.xml', type: 'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml' },
      ...[...notesOf.values()].map((n) => ({
        part: `ppt/notesSlides/notesSlide${n}.xml`,
        type: 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml',
      })),
    );
  }

  const parts: ZipPart[] = [
    { name: '[Content_Types].xml', data: contentTypesXml(overrides) },
    {
      name: '_rels/.rels',
      data: relsXml([
        { id: 'rId1', type: REL_TYPE.officeDocument, target: 'ppt/presentation.xml' },
        { id: 'rId2', type: REL_TYPE.coreProps, target: 'docProps/core.xml' },
      ]),
    },
    { name: 'ppt/presentation.xml', data: presentationXml },
    { name: 'ppt/_rels/presentation.xml.rels', data: relsXml(presRels) },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: masterXml('slide') },
    {
      name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      data: relsXml([
        { id: 'rId1', type: REL_TYPE.slideLayout, target: '../slideLayouts/slideLayout1.xml' },
        { id: 'rId2', type: REL_TYPE.theme, target: '../theme/theme1.xml' },
      ]),
    },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: LAYOUT_XML },
    {
      name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      data: relsXml([{ id: 'rId1', type: REL_TYPE.slideMaster, target: '../slideMasters/slideMaster1.xml' }]),
    },
    { name: 'ppt/theme/theme1.xml', data: THEME_XML },
    ...slides.map((s, i): ZipPart => ({
      name: `ppt/slides/slide${i + 1}.xml`,
      data: slideXml(s, deck.title),
    })),
    ...slides.map((s, i): ZipPart => {
      const rels: Array<{ id: string; type: string; target: string }> = [
        { id: 'rId1', type: REL_TYPE.slideLayout, target: '../slideLayouts/slideLayout1.xml' },
      ];
      const n = notesOf.get(i);
      if (n) rels.push({ id: 'rId2', type: REL_TYPE.notesSlide, target: `../notesSlides/notesSlide${n}.xml` });
      void s;
      return { name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: relsXml(rels) };
    }),
  ];
  if (hasNotes) {
    parts.push(
      { name: 'ppt/notesMasters/notesMaster1.xml', data: masterXml('notes') },
      {
        name: 'ppt/notesMasters/_rels/notesMaster1.xml.rels',
        data: relsXml([{ id: 'rId1', type: REL_TYPE.theme, target: '../theme/theme1.xml' }]),
      },
      ...[...notesOf.entries()].map(
        ([slideIdx, n]): ZipPart => ({
          name: `ppt/notesSlides/notesSlide${n}.xml`,
          data: notesSlideXml(slides[slideIdx]!),
        }),
      ),
      ...[...notesOf.entries()].map(
        ([slideIdx, n]): ZipPart => ({
          name: `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`,
          data: relsXml([
            { id: 'rId1', type: REL_TYPE.slide, target: `../slides/slide${slideIdx + 1}.xml` },
            { id: 'rId2', type: REL_TYPE.notesMaster, target: '../notesMasters/notesMaster1.xml' },
          ]),
        }),
      ),
    );
  }
  parts.push({ name: 'docProps/core.xml', data: corePropsXml(deck.title) });
  return createStoreZip(parts);
}

/** Export a deck as PPTX with HTTP-ready metadata (mirrors exportArtifact). */
export function exportDeckPptx(deck: SlideDeck): {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
} {
  const slug =
    deck.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'deck';
  return {
    bytes: renderDeckPptx(deck),
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    filename: `${slug}.pptx`,
  };
}
