// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { ValidationError } from '../errors.js';
import { createStoreZip, readStoreZip, zipPartText, crc32 } from './ooxml.js';
import { renderArtifactDocx } from './docx.js';
import { renderArtifactXlsx, inferXlsxCell, columnRef } from './xlsx.js';
import { renderDeckPptx, exportDeckPptx } from './pptx.js';
import { exportArtifact } from './exports.js';
import type { Artifact } from './index.js';
import type { SlideDeck } from '../slides/index.js';

function makeArtifact(content: string, title = 'Quarterly Report'): Artifact {
  return { id: 'a1', title, version: 1, content, createdAt: 1700000000000, updatedAt: 1700000001000 };
}

const RICH = [
  '# Overview',
  '',
  'Sales grew **strongly** with *steady* margins and `code` plus a [link](https://example.com/report).',
  '',
  '- First win',
  '- Second win',
  '',
  '1. Step one',
  '2. Step two',
  '',
  '```',
  'const x = 1 < 2;',
  '```',
  '',
  '## Numbers',
  '',
  '| Item | Qty | When |',
  '|---|---|---|',
  '| Apples | 42 | 2026-10-30 |',
  '| Pears | 007 | 2026-11-01 |',
  '',
  '## Costs',
  '',
  '| Name | Amount |',
  '|---|---|',
  '| Rent | 1200.50 |',
  '| Misc | -3 |',
].join('\n');

function deckFixture(): SlideDeck {
  return {
    id: 'd1',
    title: 'Launch Plan',
    createdAt: 1700000000000,
    updatedAt: 1700000001000,
    slides: [
      { id: 's1', layout: 'title', heading: 'Launch Plan', bullets: ['By the team'], extra: [], notes: 'Welcome everyone' },
      { id: 's2', layout: 'bullets', heading: 'Agenda', bullets: ['Intro', 'Demo & <QA>'], extra: [], notes: '' },
      { id: 's3', layout: 'two-column', heading: 'Compare', bullets: ['Left A'], extra: ['Right B'], notes: 'Compare carefully' },
      { id: 's4', layout: 'image', heading: 'Photo', bullets: ['Caption'], extra: ['https://example.com/p.png'], notes: '' },
    ],
  };
}

describe('store zip writer', () => {
  it('is deterministic and round-trips', () => {
    const parts = [
      { name: 'a.xml', data: '<a>hi</a>' },
      { name: 'b/c.xml', data: '<c/>' },
    ];
    const one = createStoreZip(parts);
    const two = createStoreZip(parts);
    expect(Buffer.from(one).equals(Buffer.from(two))).toBe(true);
    expect(one[0]).toBe(0x50); // 'P'
    expect(one[1]).toBe(0x4b); // 'K'
    const back = readStoreZip(one);
    expect([...back.keys()]).toEqual(['a.xml', 'b/c.xml']);
    expect(zipPartText(back, 'a.xml')).toBe('<a>hi</a>');
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('rejects unsafe entry names', () => {
    expect(() => createStoreZip([{ name: '../evil', data: 'x' }])).toThrow();
  });
});

describe('renderArtifactDocx (FL-1)', () => {
  it('produces a valid Word package with all required parts', () => {
    const parts = readStoreZip(renderArtifactDocx(makeArtifact(RICH)));
    for (const name of [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/styles.xml',
      'word/numbering.xml',
      'word/_rels/document.xml.rels',
      'docProps/core.xml',
    ]) {
      expect(parts.has(name), name).toBe(true);
    }
    const ct = zipPartText(parts, '[Content_Types].xml');
    expect(ct).toContain('wordprocessingml.document.main+xml');
    const styles = zipPartText(parts, 'word/styles.xml');
    expect(styles).toContain('w:styleId="Heading1"');
    expect(styles).toContain('w:styleId="Title"');
  });

  it('lands content: headings, runs, lists, code, tables, hyperlinks', () => {
    const parts = readStoreZip(renderArtifactDocx(makeArtifact(RICH)));
    const doc = zipPartText(parts, 'word/document.xml');
    expect(doc).toContain('Quarterly Report'); // artifact title
    expect(doc).toContain('Overview');
    expect(doc).toContain('<w:b/>'); // bold run
    expect(doc).toContain('<w:i/>'); // italic run
    expect(doc).toContain('strongly');
    expect(doc).toContain('steady');
    expect(doc).toContain('const x = 1 &lt; 2;'); // escaped code block
    expect(doc).toContain('<w:tbl>'); // markdown table -> Word table
    expect(doc).toContain('Apples');
    expect(doc).toContain('tblHeader'); // header row repeats
    expect(doc).toContain('<w:hyperlink');
    expect(doc).toContain('<w:numPr>'); // real list numbering
    const rels = zipPartText(parts, 'word/_rels/document.xml.rels');
    expect(rels).toContain('https://example.com/report');
    expect(rels).toContain('TargetMode="External"');
    const numbering = zipPartText(parts, 'word/numbering.xml');
    expect(numbering).toContain('w:numFmt w:val="bullet"');
    expect(numbering).toContain('w:numFmt w:val="decimal"');
  });
});

describe('renderArtifactXlsx (FL-2)', () => {
  it('exports ALL tables, one sheet per table, named from headings', () => {
    const parts = readStoreZip(renderArtifactXlsx(makeArtifact(RICH)));
    for (const name of [
      '[Content_Types].xml',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
    ]) {
      expect(parts.has(name), name).toBe(true);
    }
    const wb = zipPartText(parts, 'xl/workbook.xml');
    expect(wb).toContain('<sheet name="Numbers"');
    expect(wb).toContain('<sheet name="Costs"');
    const s1 = zipPartText(parts, 'xl/worksheets/sheet1.xml');
    expect(s1).toContain('Apples');
    expect(s1).toContain('<c r="B2"><v>42</v></c>'); // canonical number -> numeric cell
    expect(s1).toContain('2026-10-30'); // date stays a text string
    expect(s1).toContain('007'); // leading-zero value stays text-safe
    expect(s1).toContain('s="1"'); // header row bold style
    const s2 = zipPartText(parts, 'xl/worksheets/sheet2.xml');
    expect(s2).toContain('<v>1200.50</v>');
    expect(s2).toContain('<v>-3</v>');
    const styles = zipPartText(parts, 'xl/styles.xml');
    expect(styles).toContain('<b/>');
  });

  it('throws when the artifact has no tables', () => {
    expect(() => renderArtifactXlsx(makeArtifact('no tables here'))).toThrow(ValidationError);
  });

  it('infers cells text-safely', () => {
    expect(inferXlsxCell('42')).toEqual({ kind: 'number', value: '42' });
    expect(inferXlsxCell('007').kind).toBe('text');
    expect(inferXlsxCell('2026-10-30').kind).toBe('text');
    expect(inferXlsxCell('1,200').kind).toBe('text');
    expect(inferXlsxCell('12%').kind).toBe('text');
    expect(columnRef(0)).toBe('A');
    expect(columnRef(26)).toBe('AA');
  });
});

describe('renderDeckPptx (FL-3)', () => {
  it('produces a valid presentation package with one slide per deck slide', () => {
    const deck = deckFixture();
    const parts = readStoreZip(renderDeckPptx(deck));
    for (const name of [
      '[Content_Types].xml',
      'ppt/presentation.xml',
      'ppt/_rels/presentation.xml.rels',
      'ppt/slideMasters/slideMaster1.xml',
      'ppt/slideLayouts/slideLayout1.xml',
      'ppt/theme/theme1.xml',
    ]) {
      expect(parts.has(name), name).toBe(true);
    }
    const slideParts = [...parts.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k));
    expect(slideParts).toHaveLength(deck.slides.length);
    const pres = zipPartText(parts, 'ppt/presentation.xml');
    expect((pres.match(/<p:sldId /g) ?? []).length).toBe(deck.slides.length);
    expect(pres).toContain('cx="12192000"'); // 16:9
  });

  it('lands slide content per layout and speaker notes as notes slides', () => {
    const parts = readStoreZip(renderDeckPptx(deckFixture()));
    expect(zipPartText(parts, 'ppt/slides/slide1.xml')).toContain('Launch Plan');
    expect(zipPartText(parts, 'ppt/slides/slide2.xml')).toContain('Demo &amp; &lt;QA&gt;');
    const twoCol = zipPartText(parts, 'ppt/slides/slide3.xml');
    expect(twoCol).toContain('Left A');
    expect(twoCol).toContain('Right B');
    expect(zipPartText(parts, 'ppt/slides/slide4.xml')).toContain('https://example.com/p.png');
    // Two slides carry notes -> two notes slides + a notes master.
    const notesParts = [...parts.keys()].filter((k) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(k));
    expect(notesParts).toHaveLength(2);
    expect(parts.has('ppt/notesMasters/notesMaster1.xml')).toBe(true);
    const allNotes = notesParts.map((n) => zipPartText(parts, n)).join('\n');
    expect(allNotes).toContain('Welcome everyone');
    expect(allNotes).toContain('Compare carefully');
  });

  it('omits notes parts entirely when no slide has notes', () => {
    const deck = deckFixture();
    deck.slides = deck.slides.map((s) => ({ ...s, notes: '' }));
    const parts = readStoreZip(renderDeckPptx(deck));
    expect([...parts.keys()].filter((k) => k.includes('notes'))).toEqual([]);
    const out = exportDeckPptx(deck);
    expect(out.filename).toBe('launch-plan.pptx');
    expect(out.contentType).toContain('presentationml.presentation');
  });
});

describe('exportArtifact OOXML wiring', () => {
  it('offers docx and xlsx alongside the legacy formats', () => {
    const a = makeArtifact(RICH, 'My Report!');
    const docx = exportArtifact(a, 'docx');
    expect(docx.filename).toBe('my-report.docx');
    expect(docx.contentType).toContain('wordprocessingml.document');
    expect(readStoreZip(docx.bytes).has('word/document.xml')).toBe(true);
    const xlsx = exportArtifact(a, 'xlsx');
    expect(xlsx.filename).toBe('my-report.xlsx');
    expect(xlsx.contentType).toContain('spreadsheetml.sheet');
    expect(readStoreZip(xlsx.bytes).has('xl/workbook.xml')).toBe(true);
  });
});
