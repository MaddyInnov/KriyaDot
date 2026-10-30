// SPDX-License-Identifier: Apache-2.0
// Octomind closure for coding tools:
//   #184 — hashed line identifiers (read_file) + hash-guarded range edit
//   #60  — built-in semantic code search (search_code_semantic)

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearSemanticIndexCache, createCodingTools } from '../src/tools/coding.js';
import { createBuiltInTools } from '../src/tools/builtin.js';
import { lineHash } from '../src/tools/line-hash.js';
import type { SyncEmbedder } from '../src/hybrid-search.js';
import type { ToolContext, ToolDefinition } from '../src/types.js';

const CTX: ToolContext = { sessionId: 's', botId: 'b' };

function byName(tools: ToolDefinition[]): Map<string, ToolDefinition> {
  return new Map(tools.map((t) => [t.name, t]));
}

// ---------------------------------------------------------------------------
// #184 hashed lines + range edit
// ---------------------------------------------------------------------------

describe('hashed lines + range edit (#184)', () => {
  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'hashed-edit-'));
    await writeFile(join(dir, 'code.ts'), 'alpha\nbravo\ncharlie\ndelta\n', 'utf8');
    const builtins = byName(createBuiltInTools({ workspaceDir: dir }));
    const coding = byName(createCodingTools({ workspaceDir: dir }));
    return { dir, read: builtins.get('read_file')!, edit: coding.get('edit')! };
  }

  it('read_file withHashes renders stable `line#hash: content` identifiers', async () => {
    const { read } = await setup();
    const plain = (await read.handler({ path: 'code.ts' }, CTX)) as string;
    expect(plain).toBe('alpha\nbravo\ncharlie\ndelta\n');
    const hashed = (await read.handler({ path: 'code.ts', withHashes: true }, CTX)) as string;
    const lines = hashed.split('\n');
    expect(lines[0]).toBe(`1#${lineHash('alpha')}: alpha`);
    expect(lines[1]).toBe(`2#${lineHash('bravo')}: bravo`);
    expect(lines[3]).toBe(`4#${lineHash('delta')}: delta`);
    // Stability: a second read produces identical identifiers.
    const again = (await read.handler({ path: 'code.ts', withHashes: true }, CTX)) as string;
    expect(again).toBe(hashed);
  });

  it('range edit applies when boundary hashes match', async () => {
    const { dir, edit } = await setup();
    const res = (await edit.handler(
      {
        path: 'code.ts',
        startLine: 2,
        endLine: 3,
        expectedStartHash: lineHash('bravo'),
        expectedEndHash: lineHash('charlie'),
        newText: 'BRAVO-2\nCHARLIE-2',
      },
      CTX,
    )) as { mode?: string; linesReplaced?: number };
    expect(res.mode).toBe('range');
    expect(res.linesReplaced).toBe(2);
    expect(await readFile(join(dir, 'code.ts'), 'utf8')).toBe('alpha\nBRAVO-2\nCHARLIE-2\ndelta\n');
  });

  it('range edit rejects a stale boundary hash and writes nothing', async () => {
    const { dir, edit } = await setup();
    await expect(
      edit.handler(
        {
          path: 'code.ts',
          startLine: 2,
          endLine: 3,
          expectedStartHash: lineHash('bravo-CHANGED'),
          expectedEndHash: lineHash('charlie'),
          newText: 'x',
        },
        CTX,
      ),
    ).rejects.toThrow(/stale file/);
    await expect(
      edit.handler(
        {
          path: 'code.ts',
          startLine: 2,
          endLine: 3,
          expectedStartHash: lineHash('bravo'),
          expectedEndHash: lineHash('charlie-CHANGED'),
          newText: 'x',
        },
        CTX,
      ),
    ).rejects.toThrow(/stale file/);
    expect(await readFile(join(dir, 'code.ts'), 'utf8')).toBe('alpha\nbravo\ncharlie\ndelta\n');
  });

  it('range edit without hashes is refused (unverified range edits are not allowed)', async () => {
    const { edit } = await setup();
    await expect(
      edit.handler({ path: 'code.ts', startLine: 1, endLine: 1, newText: 'x' }, CTX),
    ).rejects.toThrow(/requires expectedStartHash and expectedEndHash/);
  });

  it('exact-string edit behaviour is unchanged', async () => {
    const { dir, edit } = await setup();
    const res = (await edit.handler({ path: 'code.ts', oldText: 'bravo', newText: 'bravo!' }, CTX)) as {
      replacements: number;
    };
    expect(res.replacements).toBe(1);
    expect(await readFile(join(dir, 'code.ts'), 'utf8')).toContain('bravo!');
  });
});

// ---------------------------------------------------------------------------
// #60 semantic code search
// ---------------------------------------------------------------------------

/**
 * Deterministic fake embedder: maps texts to concept vectors. The
 * "vehicle" concept covers car/automobile/motor synonyms; "payment"
 * covers card/checkout. This is exactly the synonym gap lexical search
 * cannot cross.
 */
class FakeConceptEmbedder implements SyncEmbedder {
  readonly name = 'fake-concept';
  readonly dim = 2;
  embedSync(texts: string[]): Float32Array[] {
    return texts.map((t) => {
      const s = t.toLowerCase();
      const vehicle = /\b(car|automobile|vehicle|motor|steering|braking)\b/.test(s) ? 1 : 0;
      const payment = /\b(card|payment|checkout|billing)\b/.test(s) ? 1 : 0;
      const v = new Float32Array([vehicle, payment]);
      const n = Math.hypot(v[0]!, v[1]!) || 1;
      v[0]! /= n;
      v[1]! /= n;
      return v;
    });
  }
  embed(texts: string[]): Float32Array[] {
    return this.embedSync(texts);
  }
}

interface SearchResultShape {
  mode: string;
  note?: string;
  results: Array<{ path: string; score: number; lexicalScore: number; semanticScore?: number }>;
}

describe('search_code_semantic (#60)', () => {
  async function setup(embedder?: SyncEmbedder) {
    clearSemanticIndexCache();
    const dir = await mkdtemp(join(tmpdir(), 'semantic-search-'));
    // Synonym file: about cars without ever saying "car".
    await writeFile(
      join(dir, 'auto.ts'),
      'export function steerAutomobile() { /* automobile steering and braking with a motor */ }\n',
      'utf8',
    );
    // Lexical trap: shares the words "handling" + "code" with the query
    // but is about credit-card payments.
    await writeFile(
      join(dir, 'payments.ts'),
      'export function handlingCodeForCard() { /* card payment checkout handling code */ }\n',
      'utf8',
    );
    const tools = byName(createCodingTools({ workspaceDir: dir, embedder }));
    return { dir, search: tools.get('search_code_semantic')! };
  }

  it('is registered alongside the other coding tools', async () => {
    const { search } = await setup();
    expect(search).toBeDefined();
    expect(search.mutating).toBeFalsy();
  });

  it('semantic ranking beats lexical on a synonym query (fake embedder)', async () => {
    const { search } = await setup(new FakeConceptEmbedder());
    const res = (await search.handler({ query: 'car handling code' }, CTX)) as SearchResultShape;
    expect(res.mode).toBe('hybrid');
    expect(res.results.length).toBeGreaterThanOrEqual(2);
    // Lexically, payments.ts wins (handling + code). Semantically the
    // automobile file is the match — hybrid ranking must put it first.
    const lexicalOnly = [...res.results].sort((a, b) => b.lexicalScore - a.lexicalScore);
    expect(lexicalOnly[0]!.path).toBe('payments.ts');
    expect(res.results[0]!.path).toBe('auto.ts');
    expect(res.results[0]!.semanticScore).toBeGreaterThan(res.results[1]!.semanticScore ?? 0);
  });

  it('degrades to lexical-only (and says so) with no embedder configured', async () => {
    const { search } = await setup(undefined);
    const res = (await search.handler({ query: 'car handling code' }, CTX)) as SearchResultShape;
    expect(res.mode).toBe('lexical-only');
    expect(res.note).toMatch(/No embedder is configured/);
    expect(res.results[0]!.path).toBe('payments.ts'); // pure lexical order
    expect(res.results[0]!.semanticScore).toBeUndefined();
  });

  it('re-indexes a file whose mtime changed (cache invalidation)', async () => {
    const { dir, search } = await setup(new FakeConceptEmbedder());
    const first = (await search.handler({ query: 'card payment checkout' }, CTX)) as SearchResultShape;
    expect(first.results[0]!.path).toBe('payments.ts');
    // Rewrite the automobile file into a payments file; mtime changes.
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(dir, 'auto.ts'), 'export const x = "card payment checkout billing";\n', 'utf8');
    const second = (await search.handler({ query: 'card payment checkout' }, CTX)) as SearchResultShape;
    const auto = second.results.find((r) => r.path === 'auto.ts');
    expect(auto).toBeDefined();
    expect(auto!.lexicalScore).toBeGreaterThan(0);
  });
});
