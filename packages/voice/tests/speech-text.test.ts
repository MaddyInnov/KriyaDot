// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { DEFAULT_CODE_BLOCK_PLACEHOLDER, markdownToSpeechText, prepareSpeechText } from '../src/speech-text.js';

describe('prepareSpeechText', () => {
  it('strips headings, emphasis, and blockquote markers but keeps the words', () => {
    const out = prepareSpeechText('# Big News\n\n> **Bold** claim and *soft* one with __strong__ too.');
    expect(out).toBe('Big News Bold claim and soft one with strong too.');
  });

  it('expands links to their text and images to their alt text', () => {
    const out = prepareSpeechText(
      'Read [the full report](https://example.com/report "Report") and see ![a sleepy cat](https://img.example.com/cat.png) here.',
    );
    expect(out).toBe('Read the full report and see a sleepy cat here.');
    expect(out).not.toContain('example.com');
    expect(out).not.toContain('http');
  });

  it('drops link reference definitions and reference-style links resolve to text', () => {
    const out = prepareSpeechText('See [the docs][d] for details.\n\n[d]: https://example.com/docs');
    expect(out).toBe('See the docs for details.');
  });

  it('replaces fenced code blocks with the spoken placeholder, once per block', () => {
    const input = ['Run this:', '', '```ts', 'const x = doThing();', '```', '', 'Then wait.'].join('\n');
    const out = prepareSpeechText(input);
    expect(out).toContain(DEFAULT_CODE_BLOCK_PLACEHOLDER);
    expect(out).not.toContain('doThing');
    expect(out).not.toContain('const');
    expect(out.indexOf(DEFAULT_CODE_BLOCK_PLACEHOLDER)).toBe(out.lastIndexOf(DEFAULT_CODE_BLOCK_PLACEHOLDER));
    expect(out).toContain('Then wait.');
  });

  it('honours a custom code placeholder and swallows an unterminated fence', () => {
    const out = prepareSpeechText('Before.\n\n```\nnever closed secret()', { codeBlockPlaceholder: 'Code skipped.' });
    expect(out).toBe('Before. Code skipped.');
    expect(out).not.toContain('secret');
  });

  it('keeps inline code text and strips stray backticks', () => {
    expect(prepareSpeechText('Set `VOICE_TTS_PROVIDER` to `fish` first.')).toBe(
      'Set VOICE_TTS_PROVIDER to fish first.',
    );
  });

  it('shrinks bare URLs and autolinks to their host', () => {
    const out = prepareSpeechText('Details at https://example.com/deep/path?q=1 and <https://blog.example.org/post>.');
    expect(out).toContain('example.com');
    expect(out).toContain('blog.example.org');
    expect(out).not.toContain('/deep/path');
    expect(out).not.toContain('q=1');
  });

  it('flattens tables and lists, and drops rules and HTML tags', () => {
    const input = [
      '| Name | Score |',
      '| --- | --- |',
      '| Ana | 3 |',
      '',
      '- first item',
      '1. second item',
      '',
      '---',
      '',
      '<p>Wrapped <b>text</b></p>',
    ].join('\n');
    const out = prepareSpeechText(input);
    expect(out).toContain('Name, Score');
    expect(out).toContain('Ana, 3');
    expect(out).toContain('first item');
    expect(out).toContain('second item');
    expect(out).toContain('Wrapped text');
    expect(out).not.toContain('|');
    expect(out).not.toContain('<');
  });

  it('collapses whitespace and returns empty for unspeakable input', () => {
    expect(prepareSpeechText('  too   many\n\n\n   spaces  ')).toBe('too many spaces');
    expect(prepareSpeechText('')).toBe('');
    expect(prepareSpeechText('   \n  ')).toBe('');
    expect(prepareSpeechText('| --- | --- |')).toBe('');
  });

  it('markdownToSpeechText is the same rewrite', () => {
    expect(markdownToSpeechText('## Hi [there](https://x.example.com)')).toBe('Hi there');
  });
});
