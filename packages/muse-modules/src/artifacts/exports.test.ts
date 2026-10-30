// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { ValidationError } from '../errors.js';
import {
  renderArtifactHtml,
  renderArtifactCsv,
  renderArtifactPdf,
  exportArtifact,
} from './exports.js';
import type { Artifact } from './index.js';

function makeArtifact(content: string, title = 'Test Doc'): Artifact {
  return {
    id: 'a1',
    title,
    version: 2,
    content,
    createdAt: 1700000000000,
    updatedAt: 1700000001000,
  };
}

describe('renderArtifactHtml', () => {
  it('renders a self-contained page with escaped content', () => {
    const html = renderArtifactHtml(
      makeArtifact('# Hello\n\nSome **bold** and <script>evil</script>.\n\n- one\n- two\n'),
    );
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<h1>Hello</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('&lt;script&gt;evil&lt;/script&gt;');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<style>');
    expect(html).not.toContain('<script>evil</script>');
  });

  it('renders tables and code blocks', () => {
    const html = renderArtifactHtml(
      makeArtifact('| a | b |\n|---|---|\n| 1 | 2 |\n\n```\ncode()\n```\n'),
    );
    expect(html).toContain('<table>');
    expect(html).toContain('<th>a</th>');
    expect(html).toContain('<td>2</td>');
    expect(html).toContain('<pre><code>');
  });
});

describe('renderArtifactCsv', () => {
  it('extracts the first markdown table as CSV', () => {
    const csv = renderArtifactCsv(
      makeArtifact('# T\n\n| name | price |\n|---|---|\n| apple | 1.5 |\n| "pear", ripe | 2 |\n'),
    );
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('name,price');
    expect(lines[1]).toBe('apple,1.5');
    expect(lines[2]).toBe('"""pear"", ripe",2');
  });

  it('throws when there is no table', () => {
    expect(() => renderArtifactCsv(makeArtifact('just text'))).toThrow(ValidationError);
  });
});

describe('renderArtifactPdf', () => {
  it('produces a valid single-page PDF with correct xref offsets', () => {
    const bytes = renderArtifactPdf(makeArtifact('# Title\n\nHello world.\n'));
    const text = Buffer.from(bytes).toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('/BaseFont /Helvetica');
    expect(text).toContain('(Hello world.)');
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    // Every xref offset must point at the right object header.
    // (xref lists object 0 first, then objects 1..N.)
    const xrefStart = text.indexOf('xref\n');
    const entries = text.slice(xrefStart).split('\n').slice(2);
    const objCount = Number(text.match(/\/Size (\d+)/)![1]);
    for (let n = 1; n < objCount; n++) {
      const off = Number(entries[n].slice(0, 10));
      expect(text.slice(off, off + 12)).toContain(`${n} 0 obj`);
    }
  });

  it('typesets: multiple fonts, bold headings, wrapped text, page numbers', () => {
    const longPara = 'word '.repeat(60).trim();
    const bytes = renderArtifactPdf(
      makeArtifact(`# Section\n\n${longPara}\n\n- item one\n\n\`\`\`\nconst a = 1;\n\`\`\`\n`),
    );
    const text = Buffer.from(bytes).toString('latin1');
    expect(text).toContain('/BaseFont /Helvetica-Bold');
    expect(text).toContain('/BaseFont /Courier');
    expect(text).toContain('(Page 1 of 1)');
    expect(text).toContain('(Test Doc)'); // footer title
    expect(text).toContain('(const a = 1;)');
    // The 60-word paragraph wrapped onto more than one display line.
    expect(text.match(/\(word/g)!.length).toBeGreaterThan(1);
  });

  it('paginates long documents', () => {
    const long = Array.from({ length: 200 }, (_, i) => `Line number ${i} of the document.`).join('\n');
    const bytes = renderArtifactPdf(makeArtifact(long));
    const text = Buffer.from(bytes).toString('latin1');
    const count = Number(text.match(/\/Count (\d+)/)![1]);
    expect(count).toBeGreaterThan(1);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });
});

describe('exportArtifact', () => {
  it('returns bytes + content type + filename per format', () => {
    const a = makeArtifact('| x |\n|---|\n| 1 |\n', 'My Report!');
    const html = exportArtifact(a, 'html');
    expect(html.contentType).toContain('text/html');
    expect(html.filename).toBe('my-report.html');
    expect(html.bytes.length).toBeGreaterThan(100);

    const csv = exportArtifact(a, 'csv');
    expect(csv.contentType).toContain('text/csv');
    expect(csv.filename).toBe('my-report.csv');

    const pdf = exportArtifact(a, 'pdf');
    expect(pdf.contentType).toBe('application/pdf');
    expect(pdf.filename).toBe('my-report.pdf');
    expect(Buffer.from(pdf.bytes).toString('latin1', 0, 8)).toBe('%PDF-1.4');
  });

  it('rejects unknown formats', () => {
    expect(() => exportArtifact(makeArtifact('x'), 'rtf' as never)).toThrow(ValidationError);
  });

  it('offers docx/xlsx content types and filenames', () => {
    const a = makeArtifact('| x |\n|---|\n| 1 |\n', 'My Report!');
    const docx = exportArtifact(a, 'docx');
    expect(docx.contentType).toContain('wordprocessingml.document');
    expect(docx.filename).toBe('my-report.docx');
    const xlsx = exportArtifact(a, 'xlsx');
    expect(xlsx.contentType).toContain('spreadsheetml.sheet');
    expect(xlsx.filename).toBe('my-report.xlsx');
  });
});
