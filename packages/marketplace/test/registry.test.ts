// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MarketplaceRegistry } from '../src/registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(HERE, '..', 'registry', 'registry.json');

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'mkt-reg-test-'));
}

describe('MarketplaceRegistry', () => {
  it('loads the bundled registry', () => {
    const reg = MarketplaceRegistry.fromFile(REGISTRY);
    expect(reg.count()).toBeGreaterThan(0);
    expect(reg.kinds()).toEqual(['bot', 'skill', 'workflow', 'mcp-server', 'capability']);
  });

  it('filters by kind and free-text query', () => {
    const reg = MarketplaceRegistry.fromFile(REGISTRY);
    const bots = reg.list({ kind: 'bot' });
    expect(bots.length).toBeGreaterThan(0);
    expect(bots.every((b) => b.kind === 'bot')).toBe(true);
    const sql = reg.list({ q: 'postgres' });
    expect(sql.length).toBe(1);
    expect(sql[0].id).toBe('postgres-local');
  });

  it('filters by tag', () => {
    const reg = MarketplaceRegistry.fromFile(REGISTRY);
    const tagged = reg.list({ tag: 'data' });
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged.every((e) => e.tags.includes('data'))).toBe(true);
  });

  it('getById finds entries across kinds', () => {
    const reg = MarketplaceRegistry.fromFile(REGISTRY);
    expect(reg.getById('git-hygiene')?.kind).toBe('skill');
    expect(reg.get('mcp-server', 'postgres-local')?.kind).toBe('mcp-server');
    expect(reg.getById('nope')).toBeUndefined();
  });

  it('rejects malformed registry entries', () => {
    const bad = join(tmp(), 'bad.json');
    writeFileSync(bad, JSON.stringify({ entries: [{ id: 'x' }] }), 'utf8');
    expect(() => MarketplaceRegistry.fromFile(bad)).toThrow(/malformed/);
  });

  it('rejects duplicate entries', () => {
    const src = JSON.parse(readFileSync(REGISTRY, 'utf8')) as { entries: unknown[] };
    const dup = join(tmp(), 'dup.json');
    writeFileSync(dup, JSON.stringify({ entries: [src.entries[0], src.entries[0]] }), 'utf8');
    expect(() => MarketplaceRegistry.fromFile(dup)).toThrow(/duplicate/);
  });
});
