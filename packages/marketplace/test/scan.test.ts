// SPDX-License-Identifier: Apache-2.0
// Tests for the offline project scanner (packages/marketplace/src/scan.ts).
// All fixtures are temp dirs on the local filesystem; no network, no keys,
// no account — the scanner must work fully offline.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_KITS, detectSignals, loadCatalog, scanProject } from '../src/scan.js';

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'kriyadot-scan-'));
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  return dir;
}

const ids = (dir: string) => scanProject(dir).recommendations.map((r) => r.id);

describe('detectSignals', () => {
  it('detects a node+typescript project with Dockerfile and CI', () => {
    const dir = fixture({
      'package.json': JSON.stringify({
        name: 'demo',
        dependencies: { express: '^4.0.0', react: '^18.0.0' },
        devDependencies: { typescript: '^5.0.0' },
      }),
      'tsconfig.json': '{}',
      'Dockerfile': 'FROM node:22\n',
      '.github/workflows/ci.yml': 'name: ci\n',
      'src/index.ts': 'export {};\n',
    });
    const s = detectSignals(dir);
    expect(s.languages).toContain('node');
    expect(s.typescript).toBe(true);
    expect(s.apiServer).toBe(true); // express
    expect(s.frontend).toBe(true); // react
    expect(s.hasDockerfile).toBe(true);
    expect(s.hasCI).toBe(true);
    expect(s.hasTests).toBe(false);
    expect(s.hasGit).toBe(false);
    expect(s.hasDocs).toBe(false);
  });

  it('detects python, go, database and csv signals', () => {
    const dir = fixture({
      'pyproject.toml': '[project]\nname="demo"\n',
      'requirements.txt': 'fastapi==0.1\npsycopg2==2.9\n',
      'data/export.csv': 'a,b\n1,2\n',
      'migrations/0001_init.sql': 'CREATE TABLE t (id INT);\n',
    });
    const s = detectSignals(dir);
    expect(s.languages).toContain('python');
    expect(s.apiServer).toBe(true); // fastapi
    expect(s.hasDatabase).toBe(true); // .sql + psycopg2
    expect(s.hasCsv).toBe(true);
  });

  it('detects go.mod, git repo, tests and docs', () => {
    const dir = fixture({
      'go.mod': 'module demo\n\ngo 1.22\n',
      'main_test.go': 'package main\n',
      'README.md': '# demo\n',
    });
    mkdirSync(join(dir, '.git'));
    const s = detectSignals(dir);
    expect(s.languages).toContain('go');
    expect(s.hasGit).toBe(true);
    expect(s.hasTests).toBe(true); // *_test.go
    expect(s.hasDocs).toBe(true); // README.md
  });

  it('survives a corrupt package.json and a missing dir', () => {
    const dir = fixture({ 'package.json': '{ not json' });
    const s = detectSignals(dir);
    expect(s.languages).toEqual([]); // corrupt manifest → no language claim
    expect(detectSignals(join(dir, 'nope')).languages).toEqual([]);
  });

  it('detects docker-compose and Makefile', () => {
    const dir = fixture({ 'docker-compose.yml': 'services: {}\n', 'Makefile': 'all:\n' });
    const s = detectSignals(dir);
    expect(s.hasCompose).toBe(true);
    expect(s.hasMakefile).toBe(true);
  });
});

describe('loadCatalog', () => {
  it('loads the bundled marketplace registry by default', () => {
    const { kits, source } = loadCatalog();
    expect(source).toBe('marketplace-registry');
    expect(kits.length).toBeGreaterThan(10);
    expect(kits.map((k) => k.id)).toContain('code-reviewer');
  });

  it('falls back to the built-in kit list when the registry is unreadable', () => {
    const { kits, source } = loadCatalog({ registryPath: '/nonexistent/registry.json' });
    expect(source).toBe('builtin');
    expect(kits).toEqual(BUILTIN_KITS);
    expect(kits.length).toBeGreaterThan(0);
  });

  it('falls back on corrupt registry JSON', () => {
    const dir = fixture({ 'registry.json': '{ broken' });
    const { source } = loadCatalog({ registryPath: join(dir, 'registry.json') });
    expect(source).toBe('builtin');
  });
});

describe('scanProject', () => {
  it('recommends review + deploy/monitor kits for a Node project with Dockerfile', () => {
    const dir = fixture({
      'package.json': JSON.stringify({ name: 'svc', dependencies: { express: '^4' } }),
      'Dockerfile': 'FROM node:22\n',
      'docker-compose.yml': 'services: {}\n',
    });
    const result = scanProject(dir);
    expect(result.catalogSource).toBe('marketplace-registry');
    const recIds = result.recommendations.map((r) => r.id);
    expect(recIds).toContain('code-reviewer');
    expect(recIds).toContain('uptime-monitor');
    // Every recommendation carries a human reason and a valid kind.
    for (const r of result.recommendations) {
      expect(r.reason.length).toBeGreaterThan(0);
      expect(['bot', 'skill', 'workflow', 'mcp-server']).toContain(r.kind);
    }
  });

  it('suggests test-writer only when no tests exist', () => {
    const noTests = fixture({ 'package.json': JSON.stringify({ name: 'a' }) });
    const withTests = fixture({
      'package.json': JSON.stringify({ name: 'b' }),
      'tests/test_a.py': '',
    });
    // python project without tests
    const dirPy = fixture({ 'pyproject.toml': '[project]\n' });
    expect(ids(noTests)).toContain('test-writer');
    expect(ids(withTests)).not.toContain('test-writer');
    expect(ids(dirPy)).toContain('test-writer');
  });

  it('suggests git kits for repos and sql kits for database projects', () => {
    const dir = fixture({
      'package.json': JSON.stringify({ name: 'db', dependencies: { pg: '^8' } }),
      'schema.sql': 'CREATE TABLE t (id INT);\n',
    });
    mkdirSync(join(dir, '.git'));
    const recIds = ids(dir);
    expect(recIds).toContain('git-hygiene');
    expect(recIds).toContain('git-committer');
    expect(recIds).toContain('sql-helper');
  });

  it('recommends data kits for CSV projects', () => {
    const dir = fixture({ 'data.csv': 'a,b\n' });
    const recIds = ids(dir);
    expect(recIds).toContain('data-analyst');
    expect(recIds).toContain('csv-cleaning');
  });

  it('returns no recommendations for an empty folder (and never throws)', () => {
    const dir = fixture({});
    const result = scanProject(dir);
    expect(result.recommendations).toEqual([]);
    expect(result.signals.languages).toEqual([]);
  });

  it('works identically against the built-in fallback catalog', () => {
    const dir = fixture({
      'package.json': JSON.stringify({ name: 'svc', dependencies: { express: '^4' } }),
      'Dockerfile': 'FROM node:22\n',
    });
    const result = scanProject(dir, { registryPath: '/nonexistent/registry.json' });
    expect(result.catalogSource).toBe('builtin');
    const recIds = result.recommendations.map((r) => r.id);
    // Fallback ids mirror the real registry, so core rules still fire.
    expect(recIds).toContain('code-reviewer');
    expect(recIds).toContain('deploy');
    expect(recIds).toContain('container-ops');
  });

  it('dedupes recommendations when several rules match the same kit', () => {
    const dir = fixture({
      'package.json': JSON.stringify({ name: 'api', dependencies: { express: '^4' } }),
      'Dockerfile': 'FROM node:22\n',
    });
    const recIds = ids(dir);
    expect(recIds.filter((id) => id === 'uptime-monitor')).toHaveLength(1);
  });
});
