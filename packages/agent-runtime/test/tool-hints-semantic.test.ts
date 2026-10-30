// SPDX-License-Identifier: Apache-2.0
// Semantic misuse hints (#58): deterministic wrong-tool guidance on
// successful-but-wrong calls, beyond name-typo "did you mean" hints.

import { describe, expect, it } from 'vitest';
import {
  SEMANTIC_HINT_RULE_IDS,
  semanticMisuseHint,
  withSemanticHint,
} from '../src/tool-hints.js';

const run = (command: string) => ({ toolName: 'run_command', args: { command } });

describe('semanticMisuseHint (#58)', () => {
  it('suggests read_file for shell file reads', () => {
    for (const cmd of ['cat src/app.ts', 'head -n 20 README.md', 'tail app.log', 'less notes.txt']) {
      expect(semanticMisuseHint(run(cmd)), cmd).toMatch(/read_file/);
    }
    // Log following is legitimate shell use read_file cannot replace.
    expect(semanticMisuseHint(run('tail -f app.log'))).toBe('');
  });

  it('suggests the grep tool for shell content search', () => {
    expect(semanticMisuseHint(run('grep -rn "token" src'))).toMatch(/grep tool/);
    expect(semanticMisuseHint(run('rg "handleSubmit" src'))).toMatch(/grep tool/);
  });

  it('suggests glob for find -name', () => {
    expect(semanticMisuseHint(run('find src -name "*.test.ts"'))).toMatch(/glob/);
  });

  it('suggests edit for in-place sed', () => {
    expect(semanticMisuseHint(run("sed -i 's/foo/bar/' src/app.ts"))).toMatch(/edit tool/);
    expect(semanticMisuseHint(run("sed --in-place 's/a/b/' f.txt"))).toMatch(/edit tool/);
  });

  it('suggests write_file for heredoc / redirect / tee writes', () => {
    expect(semanticMisuseHint(run('cat > out.txt <<EOF\nhello\nEOF'))).toMatch(/write_file/);
    expect(semanticMisuseHint(run('echo "hello" > out.txt'))).toMatch(/write_file/);
    expect(semanticMisuseHint(run('printf "%s" x | tee out.txt'))).toMatch(/write_file/);
  });

  it('suggests web_fetch for curl/wget URL fetches', () => {
    expect(semanticMisuseHint(run('curl https://example.com/page'))).toMatch(/web_fetch/);
    expect(semanticMisuseHint(run('wget -q https://example.com/a'))).toMatch(/web_fetch/);
  });

  it('suggests web_search when web_fetch is aimed at a search engine', () => {
    expect(
      semanticMisuseHint({ toolName: 'web_fetch', args: { url: 'https://www.google.com/search?q=cats' } }),
    ).toMatch(/web_search/);
    expect(
      semanticMisuseHint({ toolName: 'web_fetch', args: { url: 'https://duckduckgo.com/?q=dogs' } }),
    ).toMatch(/web_search/);
    expect(semanticMisuseHint({ toolName: 'web_fetch', args: { query: 'best cats' } })).toMatch(/web_search/);
  });

  it('suggests web_fetch when web_search is given a bare URL', () => {
    expect(semanticMisuseHint({ toolName: 'web_search', args: { query: 'https://example.com/x' } })).toMatch(
      /web_fetch/,
    );
  });

  it('suggests a hashed re-read when edit fails with oldText-not-found', () => {
    expect(
      semanticMisuseHint({
        toolName: 'edit',
        args: { path: 'a.ts', oldText: 'x', newText: 'y' },
        error: 'edit: oldText not found in "a.ts"',
      }),
    ).toMatch(/read_file/);
  });

  it('covers every rule id at least once in this suite', () => {
    // Guard against silently dropping a rule: the exported id list is
    // the contract other workstreams may rely on.
    expect(SEMANTIC_HINT_RULE_IDS).toEqual([
      'shell-cat-read',
      'shell-grep-search',
      'shell-find-glob',
      'shell-sed-edit',
      'shell-heredoc-write',
      'shell-curl-fetch',
      'fetch-on-search-engine',
      'search-with-url',
      'edit-stale-content',
    ]);
  });

  it('has NO false positives on ordinary shell use', () => {
    const ordinary = [
      'npm test',
      'npm run build',
      'ls -la src',
      'echo hi',
      'git status',
      'git log --oneline -5',
      'node scripts/build.mjs',
      'cat package.json | head -5', // pipeline: not a lone read
      'grep -r foo . | wc -l', // pipeline: legitimate shell composition
      'find . -type d -name node_modules -prune', // prune idiom: -name has no glob chars
      'mkdir -p out && cp a.txt out/',
      'rm -f /tmp/stale.lock',
      'sed -n "1,20p" file.txt', // printing a range is a read, not an in-place edit
      'curl -X POST https://api.example.com/items -d "{}"', // a POST, not a page fetch
    ];
    for (const cmd of ordinary) {
      expect(semanticMisuseHint(run(cmd)), cmd).toBe('');
    }
  });

  it('does not fire on non-shell tools with lookalike args', () => {
    expect(semanticMisuseHint({ toolName: 'read_file', args: { path: 'cat.txt' } })).toBe('');
    expect(semanticMisuseHint({ toolName: 'web_fetch', args: { url: 'https://example.com/article' } })).toBe('');
    expect(semanticMisuseHint({ toolName: 'web_search', args: { query: 'how do cats sleep' } })).toBe('');
  });
});

describe('withSemanticHint', () => {
  it('adds a hint field to object results when a rule fires', () => {
    const out = withSemanticHint(run('cat a.txt'), { exitCode: 0, stdout: 'x' }) as {
      hint?: string;
    };
    expect(out.hint).toMatch(/read_file/);
  });

  it('appends to string results and leaves clean results untouched', () => {
    expect(withSemanticHint(run('cat a.txt'), 'file body')).toMatch(/file body\nHint:/);
    const clean = { exitCode: 0 };
    expect(withSemanticHint(run('npm test'), clean)).toBe(clean);
    expect(withSemanticHint(run('npm test'), 'ok')).toBe('ok');
  });
});
