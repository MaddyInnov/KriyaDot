// SPDX-License-Identifier: Apache-2.0
// GFM pipe-table cases for the shared renderer (2026-11-07 brief):
// alignment, inline formatting in cells, escaped pipes, ragged rows,
// graceful degradation for non-tables and malformed tables.
// @vitest-environment jsdom (DOMPurify binds to the window, as in the app)
import { describe, expect, it } from 'vitest';
import { renderMarkdownLite } from './markdown';

describe('renderMarkdownLite — tables', () => {
  it('renders a basic table wrapped for horizontal scrolling', () => {
    const html = renderMarkdownLite('| Name | Age |\n| --- | --- |\n| Ada | 36 |');
    expect(html).toContain('<div class="md-table-wrap"><table>');
    expect(html).toContain('<th>Name</th>');
    expect(html).toContain('<th>Age</th>');
    expect(html).toContain('<td>Ada</td>');
    expect(html).toContain('<td>36</td>');
  });

  it('honours separator-row alignment', () => {
    const html = renderMarkdownLite('| L | C | R |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |');
    expect(html).toContain('<th align="left">L</th>');
    expect(html).toContain('<th align="center">C</th>');
    expect(html).toContain('<th align="right">R</th>');
    expect(html).toContain('<td align="center">2</td>');
  });

  it('renders inline formatting inside cells', () => {
    const html = renderMarkdownLite('| A |\n| --- |\n| **bold** and `code` and [x](https://a.b) |');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<a href="https://a.b"');
  });

  it('does not split a cell on an escaped pipe', () => {
    const html = renderMarkdownLite('| A | B |\n| --- | --- |\n| 1 \\| 2 | 3 |');
    expect(html).toContain('<td>1 | 2</td>');
    expect(html).toContain('<td>3</td>');
  });

  it('pads short rows and truncates long rows to header width (GFM)', () => {
    const short = renderMarkdownLite('| A | B |\n| --- | --- |\n| only |');
    expect(short).toContain('<td>only</td>');
    expect(short).toContain('<td></td>');
    const long = renderMarkdownLite('| A |\n| --- |\n| 1 | 2 | 3 |');
    expect(long).toContain('<td>1</td>');
    expect(long).not.toContain('<td>2</td>');
  });

  it('works without outer pipes and amid other content', () => {
    const html = renderMarkdownLite('Before\n\nA | B\n--- | ---\nx | y\n\nAfter');
    expect(html).toContain('<table>');
    expect(html).toContain('<p>Before</p>');
    expect(html).toContain('<p>After</p>');
  });

  it('does not swallow a pipe-heavy non-table paragraph', () => {
    const html = renderMarkdownLite('run a | b | c in the shell');
    expect(html).not.toContain('<table>');
    expect(html.trim()).toBe('<p>run a | b | c in the shell</p>');
  });

  it('degrades to plain text when the separator row is missing', () => {
    const html = renderMarkdownLite('| A | B |\n| 1 | 2 |');
    expect(html).not.toContain('<table>');
    expect(html).toContain('| A | B |');
  });

  it('degrades when the separator column count mismatches the header', () => {
    const html = renderMarkdownLite('| A | B | C |\n| --- | --- |\n| 1 | 2 | 3 |');
    expect(html).not.toContain('<table>');
  });
});
