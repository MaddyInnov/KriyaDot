// SPDX-License-Identifier: Apache-2.0
// `kriyadot scan` — one-command offline project scanner.
//
// Walks a project folder, detects its shape from dependency/config files
// (package.json, pyproject.toml, go.mod, Dockerfile, docker-compose.yml,
// .github/workflows, …), and recommends marketplace kits (bots, skills,
// workflows, MCP servers) that fit the project — e.g. "Node project with a
// Dockerfile → code-reviewer bot + uptime-monitor workflow".
//
// Offline by construction: the only inputs are the scanned folder and the
// marketplace registry. The registry is resolved from the package's own
// `registry/registry.json` (bundled, never fetched). When the registry file
// is unreadable, a small built-in kit list is used instead so the command
// still works. No account, no key, no network call — ever.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
// Bundled registry (package-local JSON import — resolves in src under vitest
// and in dist after tsc; never fetched over the network).
import registryJson from '../registry/registry.json';

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/** The kit fields the scanner needs (subset of a registry entry). */
export interface ScanKit {
  id: string;
  kind: 'bot' | 'skill' | 'workflow' | 'mcp-server';
  name: string;
  description: string;
  tags: string[];
}

export type CatalogSource = 'marketplace-registry' | 'builtin';

/**
 * Built-in fallback kit list — used ONLY when the marketplace registry file
 * cannot be read. Kept deliberately small; entry ids mirror the real
 * registry so the matching rules below behave identically.
 */
export const BUILTIN_KITS: ScanKit[] = [
  { id: 'code-reviewer', kind: 'bot', name: 'Code Reviewer', description: 'Automated code review on changes.', tags: ['coding', 'review', 'quality'] },
  { id: 'code-review-flow', kind: 'workflow', name: 'Code review flow', description: 'Automated review pipeline.', tags: ['coding', 'review', 'automation'] },
  { id: 'test-writer', kind: 'bot', name: 'Test Writer', description: 'Generates tests for untested code.', tags: ['coding', 'testing', 'quality'] },
  { id: 'git-hygiene', kind: 'skill', name: 'Git Hygiene', description: 'Keeps history clean.', tags: ['coding', 'git'] },
  { id: 'git-committer', kind: 'bot', name: 'Git Committer', description: 'Writes good commit messages.', tags: ['coding', 'git', 'productivity'] },
  { id: 'changelog-builder', kind: 'workflow', name: 'Changelog builder', description: 'Builds changelogs from git history.', tags: ['coding', 'git', 'automation'] },
  { id: 'doc-writer', kind: 'bot', name: 'Doc Writer', description: 'Writes documentation.', tags: ['writing', 'docs', 'coding'] },
  { id: 'sql-helper', kind: 'skill', name: 'SQL Helper', description: 'Helps with SQL.', tags: ['data', 'sql', 'coding'] },
  { id: 'api-designer', kind: 'bot', name: 'API Designer', description: 'Designs APIs.', tags: ['coding', 'api', 'design'] },
  { id: 'uptime-monitor', kind: 'workflow', name: 'Uptime monitor', description: 'Monitors service uptime.', tags: ['devops', 'monitoring', 'automation'] },
  { id: 'container-ops', kind: 'bot', name: 'Container Ops', description: 'Helps operate containerized services.', tags: ['devops', 'containers'] },
  { id: 'deploy', kind: 'workflow', name: 'Deploy', description: 'Build-and-deploy pipeline.', tags: ['devops', 'deploy', 'automation'] },
];

export interface LoadCatalogOptions {
  /** Override the registry JSON path (tests use this to force the fallback). */
  registryPath?: string;
}

/** Default registry: the bundled JSON imported above. */
function bundledKits(): ScanKit[] {
  return kitsFromEntries((registryJson as { entries?: unknown }).entries);
}

function kitsFromEntries(entries: unknown): ScanKit[] {
  if (!Array.isArray(entries)) throw new Error('registry has no entries array');
  const kits: ScanKit[] = [];
  for (const e of entries) {
    const o = e as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.kind !== 'string' || typeof o.name !== 'string') continue;
    if (!['bot', 'skill', 'workflow', 'mcp-server'].includes(o.kind)) continue;
    kits.push({
      id: o.id,
      kind: o.kind as ScanKit['kind'],
      name: o.name,
      description: typeof o.description === 'string' ? o.description : '',
      tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string') : [],
    });
  }
  if (kits.length === 0) throw new Error('registry yielded no usable kits');
  return kits;
}

/**
 * Load the kit catalog: bundled marketplace registry, else the built-in list.
 * When `registryPath` is given, the registry is read from that file instead
 * (used by tests to force the fallback, and by operators pinning a catalog).
 */
export function loadCatalog(opts: LoadCatalogOptions = {}): { kits: ScanKit[]; source: CatalogSource } {
  if (opts.registryPath === undefined) {
    try {
      return { kits: bundledKits(), source: 'marketplace-registry' };
    } catch {
      return { kits: BUILTIN_KITS, source: 'builtin' };
    }
  }
  try {
    const raw = readFileSync(opts.registryPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return { kits: kitsFromEntries((parsed as { entries?: unknown }).entries), source: 'marketplace-registry' };
  } catch {
    return { kits: BUILTIN_KITS, source: 'builtin' };
  }
}

// ---------------------------------------------------------------------------
// Signal detection
// ---------------------------------------------------------------------------

/** What the scanner learned about a project folder (pure data, no I/O). */
export interface ProjectSignals {
  /** Absolute path that was scanned. */
  dir: string;
  /** Programming languages detected, e.g. ['node', 'python']. */
  languages: string[];
  /** True when TypeScript config or TS sources were found. */
  typescript: boolean;
  /** Web-server framework dependencies detected (express, fastapi, …). */
  apiServer: boolean;
  /** Frontend framework dependencies detected (react, next, vue, …). */
  frontend: boolean;
  hasDockerfile: boolean;
  hasCompose: boolean;
  hasCI: boolean;
  hasGit: boolean;
  hasTests: boolean;
  hasDocs: boolean;
  hasDatabase: boolean;
  hasCsv: boolean;
  hasMakefile: boolean;
  /** Top-level dependency names collected across manifests. */
  dependencies: string[];
}

/** Directories never descended into (dependency/vendor/output). */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor',
  '__pycache__', '.venv', 'venv', '.tox', 'coverage', '.next', '.nuxt',
]);

/** Walk `dir` up to MAX_DEPTH, collecting lowercase relative paths. Bounded: fast and offline. */
const MAX_DEPTH = 3;
const MAX_FILES = 5000;

function walkDir(dir: string, rel: string, depth: number, out: Set<string>): void {
  if (out.size >= MAX_FILES) return;
  let entries: string[];
  try {
    entries = readdirSync(join(dir, rel));
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.size >= MAX_FILES) return;
    const childRel = rel ? `${rel}/${e}` : e;
    out.add(childRel.toLowerCase());
    if (depth >= MAX_DEPTH) continue;
    if (SKIP_DIRS.has(e.toLowerCase())) continue;
    try {
      if (statSync(join(dir, childRel)).isDirectory()) walkDir(dir, childRel, depth + 1, out);
    } catch {
      // unreadable — ignore
    }
  }
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function depNames(pkg: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = pkg[key];
    if (typeof deps === 'object' && deps !== null) out.push(...Object.keys(deps as Record<string, unknown>));
  }
  return out;
}

function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Walk one level of `dir`, plus a one-level peek into PEEK_DIRS. No recursion beyond that. */
export function detectSignals(dir: string): ProjectSignals {
  const signals: ProjectSignals = {
    dir,
    languages: [],
    typescript: false,
    apiServer: false,
    frontend: false,
    hasDockerfile: false,
    hasCompose: false,
    hasCI: false,
    hasGit: false,
    hasTests: false,
    hasDocs: false,
    hasDatabase: false,
    hasCsv: false,
    hasMakefile: false,
    dependencies: [],
  };
  const addLang = (l: string) => {
    if (!signals.languages.includes(l)) signals.languages.push(l);
  };

  let files = new Set<string>();
  try {
    walkDir(dir, '', 0, files);
  } catch {
    files = new Set();
  }
  const has = (name: string) => files.has(name.toLowerCase());
  const hasPrefix = (prefix: string) => [...files].some((f) => f.startsWith(prefix.toLowerCase()));
  const hasExt = (ext: string) => [...files].some((f) => f.endsWith(ext));

  // -- languages -----------------------------------------------------------
  const pkg = has('package.json') ? readJsonFile(join(dir, 'package.json')) : undefined;
  if (pkg) {
    addLang('node');
    signals.dependencies.push(...depNames(pkg));
  }
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py') || has('setup.cfg')) {
    addLang('python');
    const req = readTextFile(join(dir, has('requirements.txt') ? 'requirements.txt' : 'pyproject.toml')) ?? '';
    signals.dependencies.push(...req.split(/\r?\n/).map((l) => l.trim().split(/[=<>~!;\s[]/)[0]).filter(Boolean));
  }
  if (has('go.mod')) addLang('go');
  if (has('cargo.toml')) addLang('rust');
  if (has('composer.json')) addLang('php');
  if (has('gemfile')) addLang('ruby');
  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) addLang('java');
  if (has('tsconfig.json') || hasExt('.ts') || hasExt('.tsx')) signals.typescript = true;

  // -- frameworks -----------------------------------------------------------
  const depSet = new Set(signals.dependencies.map((d) => d.toLowerCase()));
  const hasDep = (...names: string[]) => names.some((n) => depSet.has(n));
  if (hasDep('express', 'fastify', 'koa', 'hapi', 'nestjs', '@nestjs/core')) signals.apiServer = true;
  if (hasDep('fastapi', 'django', 'flask', 'tornado', 'sanic')) signals.apiServer = true;
  if (hasDep('gin-gonic/gin', 'echo', 'fiber')) signals.apiServer = true;
  if (hasDep('react', 'next', 'vue', 'nuxt', 'angular', '@angular/core', 'svelte', 'sveltekit', 'solid-js')) signals.frontend = true;
  if (hasDep('pg', 'mysql2', 'sqlite3', 'better-sqlite3', 'prisma', '@prisma/client', 'knex', 'typeorm', 'sequelize', 'drizzle-orm', 'sqlalchemy', 'psycopg2', 'pymysql')) {
    signals.hasDatabase = true;
  }

  // -- ops ------------------------------------------------------------------
  signals.hasDockerfile = has('dockerfile') || [...files].some((f) => /(^|\/)dockerfile(\.|$)/i.test(f));
  signals.hasCompose = has('docker-compose.yml') || has('docker-compose.yaml') || has('compose.yml') || has('compose.yaml');
  signals.hasCI = hasPrefix('.github/workflows/') || has('.gitlab-ci.yml') || has('jenkinsfile') || has('.circleci/config.yml') || has('.travis.yml');
  // .git is a skipped dir (never walked into); check its presence directly.
  try {
    signals.hasGit = statSync(join(dir, '.git')).isDirectory();
  } catch {
    signals.hasGit = false;
  }
  signals.hasMakefile = has('makefile');

  // -- code shape -------------------------------------------------------------
  const codeExts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.php', '.rb', '.java', '.cs', '.swift', '.kt'];
  const codeFiles = [...files].filter((f) => codeExts.some((e) => f.endsWith(e)));
  signals.hasTests =
    hasPrefix('test/') || hasPrefix('tests/') || hasPrefix('__tests__/') || hasPrefix('spec/') ||
    codeFiles.some((f) => /\.test\.[a-z]+$/.test(f) || /\.spec\.[a-z]+$/.test(f) || f.endsWith('_test.go'));
  signals.hasDocs = has('readme.md') || hasPrefix('docs/') || hasPrefix('doc/') || has('mkdocs.yml') || has('docusaurus.config.js');
  signals.hasDatabase =
    signals.hasDatabase || hasExt('.sql') || hasPrefix('prisma/') || hasPrefix('drizzle/') || hasPrefix('migrations/') || hasExt('.db') || hasExt('.sqlite') || hasExt('.sqlite3');
  signals.hasCsv = hasExt('.csv');

  // Language list is only meaningful alongside code; a stray file should not
  // claim a language. (Manifests already imply code above.)
  return signals;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface ScanRecommendation {
  id: string;
  kind: ScanKit['kind'];
  name: string;
  reason: string;
}

export interface ScanResult {
  dir: string;
  signals: ProjectSignals;
  recommendations: ScanRecommendation[];
  catalogSource: CatalogSource;
  catalogSize: number;
}

interface Rule {
  /** Catalog entry ids to recommend when `when` matches. */
  entryIds: string[];
  when: (s: ProjectSignals) => boolean;
  reason: (s: ProjectSignals) => string;
}

const hasCode = (s: ProjectSignals) => s.languages.length > 0;

const RULES: Rule[] = [
  {
    entryIds: ['code-reviewer', 'code-review-flow'],
    when: hasCode,
    reason: (s) => `source code detected (${s.languages.join(', ')}) — automated review keeps quality high`,
  },
  {
    entryIds: ['test-writer'],
    when: (s) => hasCode(s) && !s.hasTests,
    reason: () => 'no test files found — generate a first test suite',
  },
  {
    entryIds: ['git-hygiene', 'git-committer'],
    when: (s) => s.hasGit,
    reason: () => 'git repository detected — keep history clean with good commits',
  },
  {
    entryIds: ['changelog-builder'],
    when: (s) => s.hasGit && s.hasCI,
    reason: () => 'git + CI detected — build release notes from history automatically',
  },
  {
    entryIds: ['doc-writer'],
    when: (s) => hasCode(s) && !s.hasDocs,
    reason: () => 'code without docs — generate README/API documentation',
  },
  {
    entryIds: ['sql-helper', 'sqlite-server'],
    when: (s) => s.hasDatabase,
    reason: () => 'database usage detected — query help and a local DB MCP server',
  },
  {
    entryIds: ['api-designer'],
    when: (s) => s.apiServer,
    reason: () => 'web-server framework detected — design/extend the API surface',
  },
  {
    entryIds: ['data-analyst', 'csv-cleaning'],
    when: (s) => s.hasCsv,
    reason: () => 'CSV data detected — clean and analyze it',
  },
  {
    entryIds: ['container-ops', 'deploy', 'uptime-monitor'],
    when: (s) => s.hasDockerfile,
    reason: (s) => `Dockerfile detected${s.hasCompose ? ' + compose' : ''} — operate, deploy, and monitor the containerized service`,
  },
  {
    entryIds: ['uptime-monitor'],
    when: (s) => s.apiServer && !s.hasDockerfile,
    reason: () => 'long-running service detected — monitor its uptime',
  },
  {
    entryIds: ['shell-helper'],
    when: (s) => s.hasMakefile,
    reason: () => 'Makefile detected — automate shell/build tasks',
  },
  {
    entryIds: ['link-checker'],
    when: (s) => s.frontend,
    reason: () => 'frontend detected — keep its links healthy',
  },
  {
    entryIds: ['cron-scheduling'],
    when: (s) => s.hasCI,
    reason: () => 'CI detected — schedule recurring automation alongside it',
  },
];

/** Run the full scan: detect signals in `dir`, match catalog kits. Pure fs reads only. */
export function scanProject(dir: string, opts: LoadCatalogOptions = {}): ScanResult {
  const signals = detectSignals(dir);
  const { kits, source } = loadCatalog(opts);
  const byId = new Map(kits.map((k) => [k.id, k]));
  const seen = new Set<string>();
  const recommendations: ScanRecommendation[] = [];
  for (const rule of RULES) {
    let matches = false;
    try {
      matches = rule.when(signals);
    } catch {
      matches = false;
    }
    if (!matches) continue;
    for (const id of rule.entryIds) {
      if (seen.has(id)) continue;
      const kit = byId.get(id);
      if (!kit) continue; // catalog simply doesn't carry this kit — skip
      seen.add(id);
      recommendations.push({ id: kit.id, kind: kit.kind, name: kit.name, reason: rule.reason(signals) });
    }
  }
  return { dir, signals, recommendations, catalogSource: source, catalogSize: kits.length };
}
