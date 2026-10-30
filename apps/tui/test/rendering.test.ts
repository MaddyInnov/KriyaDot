// SPDX-License-Identifier: Apache-2.0
// Tests for the TUI rendering-depth + polish work (#186/#187): the code
// tokenizer, the markdown parser (incl. styled links), the JobManager,
// and thinking-event parsing in the API client.
import { describe, expect, it } from 'vitest';
import { tokenizeCode } from '../src/highlight.js';
import { parseInline, parseMarkdown } from '../src/markdown.js';
import { formatJobDuration, JobManager } from '../src/jobs.js';
import { parseChatEvent } from '../src/api.js';

describe('tokenizeCode (#186)', () => {
  it('classifies keywords, strings, numbers and comments', () => {
    const toks = tokenizeCode('const x = "hi"; // note\nreturn 42');
    const byKind = (k: string) => toks.filter((t) => t.kind === k).map((t) => t.text).join('');
    expect(byKind('keyword')).toContain('const');
    expect(byKind('keyword')).toContain('return');
    expect(byKind('string')).toBe('"hi"');
    expect(byKind('number')).toBe('42');
    expect(byKind('comment')).toBe('// note');
    // lossless: concatenating tokens reproduces the input
    expect(toks.map((t) => t.text).join('')).toBe('const x = "hi"; // note\nreturn 42');
  });

  it('handles python comments and block comments without throwing on unterminated strings', () => {
    expect(tokenizeCode('# py\nx = 1').some((t) => t.kind === 'comment')).toBe(true);
    expect(() => tokenizeCode('const s = "unterminated')).not.toThrow();
  });
});

describe('parseMarkdown / parseInline (#186)', () => {
  it('parses headings, lists, quotes and code fences into blocks', () => {
    const blocks = parseMarkdown('# Title\n\n- one\n- two\n\n> quoted\n\n```ts\nconst a = 1;\n```\n\nplain **bold** text');
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'list', 'quote', 'code', 'paragraph']);
    const code = blocks.find((b) => b.kind === 'code');
    expect(code && code.kind === 'code' && code.code).toBe('const a = 1;');
    expect(code && code.kind === 'code' && code.lang).toBe('ts');
  });

  it('renders links as styled spans carrying their href (incl. bare URLs)', () => {
    const spans = parseInline('see [the docs](https://example.com/d) and https://x.dev');
    const links = spans.filter((s) => s.style === 'link');
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ text: 'the docs', href: 'https://example.com/d' });
    expect(links[1]?.href).toBe('https://x.dev');
  });

  it('parses bold, italic and inline code spans', () => {
    const spans = parseInline('a **b** c *i* d `e`');
    expect(spans.find((s) => s.style === 'bold')?.text).toBe('b');
    expect(spans.find((s) => s.style === 'italic')?.text).toBe('i');
    expect(spans.find((s) => s.style === 'code')?.text).toBe('e');
  });

  it('never throws on arbitrary model output', () => {
    expect(() => parseMarkdown('```\n**[broken](\n# \n- ')).not.toThrow();
    expect(() => parseMarkdown('')).not.toThrow();
  });
});

describe('JobManager (#187)', () => {
  it('tracks lifecycle: start → running → finish', () => {
    const jm = new JobManager();
    const id = jm.start('turn', undefined, 1000);
    expect(jm.running().map((j) => j.id)).toEqual([id]);
    expect(jm.finish(id, 'done', undefined, 4000)).toBe(true);
    expect(jm.list()[0]).toMatchObject({ id, status: 'done', finishedAt: 4000 });
    expect(jm.finish(id)).toBe(false); // already finished
  });

  it('cancel invokes the callback and marks the job cancelled', () => {
    const jm = new JobManager();
    let aborted = false;
    const id = jm.start('turn', () => {
      aborted = true;
    });
    expect(jm.cancel(id)).toBe(true);
    expect(aborted).toBe(true);
    expect(jm.list()[0]?.status).toBe('cancelled');
    expect(jm.cancel(id)).toBe(false);
    expect(jm.cancel('job-999')).toBe(false);
  });

  it('a throwing cancel callback cannot wedge the manager', () => {
    const jm = new JobManager();
    const id = jm.start('x', () => {
      throw new Error('boom');
    });
    expect(jm.cancel(id)).toBe(true);
    expect(jm.list()[0]?.status).toBe('cancelled');
  });

  it('prune drops finished jobs only; durations format for the panel', () => {
    const jm = new JobManager();
    const a = jm.start('a', undefined, 0);
    jm.start('b', undefined, 0);
    jm.finish(a, 'done', undefined, 65_000);
    expect(formatJobDuration(jm.list().find((j) => j.id === a)!, 100_000)).toBe('1m 05s');
    expect(jm.prune()).toBe(1);
    expect(jm.list()).toHaveLength(1);
    expect(jm.running()).toHaveLength(1);
  });
});

describe('thinking events (#186)', () => {
  it('parses thinking and reasoning SSE payloads into thinking events', () => {
    expect(parseChatEvent(JSON.stringify({ type: 'thinking', content: 'hmm' }))).toEqual({ type: 'thinking', content: 'hmm' });
    expect(parseChatEvent(JSON.stringify({ type: 'reasoning', delta: 'step' }))).toEqual({ type: 'thinking', content: 'step' });
  });
});
