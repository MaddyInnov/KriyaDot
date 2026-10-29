// SPDX-License-Identifier: Apache-2.0

/**
 * Specialist packaging (Octomind parity, Tier 3).
 *
 * Skill BUNDLES: curated sets of marketplace entries (skills + a
 * specialist bot) installed as one unit, instead of hunting entries
 * one by one. MCP-server entries are never bundle-installed — they
 * keep their per-install approval gate and are reported as skipped.
 *
 * FIRST-RUN BOOTSTRAP: a fresh data dir gets the 'getting-started'
 * bundle exactly once (marker file), so a new user opens the product
 * with a working specialist instead of an empty marketplace.
 *
 * AUTHORING SCAFFOLD: scaffoldSkill() writes a new skill file in the
 * exact frontmatter format the skill loader reads, so authors start
 * from a valid skeleton instead of a blank page.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { MarketplaceEntry, MarketplaceRegistry } from './registry.js';
import type { InstallResult, MarketplaceInstaller } from './installer.js';

export interface SkillBundle {
  id: string;
  name: string;
  description: string;
  /** Registry entry ids, in install order. */
  entryIds: string[];
}

export const BUNDLES: SkillBundle[] = [
  {
    id: 'getting-started',
    name: 'Getting Started',
    description: 'First-run essentials: a meeting scribe bot plus note-taking, git hygiene, and scheduling skills.',
    entryIds: ['meeting-scribe', 'meeting-notes', 'git-hygiene', 'cron-scheduling'],
  },
  {
    id: 'developer-toolkit',
    name: 'Developer Toolkit',
    description: 'Code review and testing specialists with review, git, and API integration skills.',
    entryIds: ['code-reviewer', 'test-writer', 'code-review', 'git-hygiene', 'api-integration'],
  },
  {
    id: 'data-starter',
    name: 'Data Starter',
    description: 'A data analyst bot with CSV cleaning, visualization, and SQL skills.',
    entryIds: ['data-analyst', 'csv-cleaning', 'data-viz', 'sql-helper'],
  },
  {
    id: 'content-starter',
    name: 'Content Starter',
    description: 'Copywriting and documentation specialists with blog and copy skills.',
    entryIds: ['copywriter', 'doc-writer', 'blog-posts', 'copywriting'],
  },
];

export function listBundles(): SkillBundle[] {
  return [...BUNDLES];
}

export function getBundle(id: string): SkillBundle | undefined {
  return BUNDLES.find((b) => b.id === id);
}

export interface BundleResolution {
  bundle: SkillBundle;
  entries: MarketplaceEntry[];
  /** Entry ids the registry does not carry. */
  missing: string[];
}

export function resolveBundle(bundle: SkillBundle, registry: MarketplaceRegistry): BundleResolution {
  const entries: MarketplaceEntry[] = [];
  const missing: string[] = [];
  for (const id of bundle.entryIds) {
    const entry = registry.getById(id);
    if (entry) entries.push(entry);
    else missing.push(id);
  }
  return { bundle, entries, missing };
}

export interface BundleInstallResult {
  bundleId: string;
  installed: InstallResult[];
  /** MCP-server entries are never bundle-installed (approval gate). */
  skippedMcp: string[];
  missing: string[];
}

export function installBundle(
  bundle: SkillBundle,
  registry: MarketplaceRegistry,
  installer: MarketplaceInstaller,
): BundleInstallResult {
  const { entries, missing } = resolveBundle(bundle, registry);
  const installed: InstallResult[] = [];
  const skippedMcp: string[] = [];
  for (const entry of entries) {
    if (entry.kind === 'mcp-server') {
      skippedMcp.push(entry.id);
      continue;
    }
    installed.push(installer.install(entry));
  }
  return { bundleId: bundle.id, installed, skippedMcp, missing };
}

// ---------------------------------------------------------------------------
// First-run bootstrap
// ---------------------------------------------------------------------------

const BOOTSTRAP_MARKER = 'bootstrap.json';

export interface BootstrapResult {
  alreadyBootstrapped: boolean;
  bundle?: BundleInstallResult;
}

/**
 * Install the getting-started bundle into a fresh install exactly
 * once. The marker records what was installed; later calls are no-ops
 * (even if the user uninstalled pieces — bootstrap never fights the
 * user by reinstalling).
 */
export function bootstrapFirstRun(deps: {
  dataDir: string;
  registry: MarketplaceRegistry;
  installer: MarketplaceInstaller;
}): BootstrapResult {
  const markerPath = join(deps.dataDir, BOOTSTRAP_MARKER);
  if (existsSync(markerPath)) return { alreadyBootstrapped: true };
  const bundle = getBundle('getting-started')!;
  const result = installBundle(bundle, deps.registry, deps.installer);
  mkdirSync(deps.dataDir, { recursive: true });
  writeFileSync(
    markerPath,
    JSON.stringify(
      {
        bundleId: bundle.id,
        at: new Date().toISOString(),
        installed: result.installed.map((r) => r.entryId),
        skippedMcp: result.skippedMcp,
        missing: result.missing,
      },
      null,
      2,
    ) + '\n',
  );
  return { alreadyBootstrapped: false, bundle: result };
}

// ---------------------------------------------------------------------------
// Authoring scaffold
// ---------------------------------------------------------------------------

const SAFE_SLUG = /^[a-z0-9][a-z0-9-_]{0,63}$/;

/**
 * Write a new skill file `<skillsDir>/<slug>.md` in the loader's
 * frontmatter format. Refuses unsafe slugs and existing files.
 * Returns the created path.
 */
export function scaffoldSkill(
  skillsDir: string,
  input: { slug: string; name: string; description: string },
): string {
  const slug = input.slug.trim();
  if (!SAFE_SLUG.test(slug)) {
    throw new Error(`unsafe skill slug "${input.slug}" (lowercase letters, digits, - and _ only)`);
  }
  const name = input.name.trim().slice(0, 120);
  const description = input.description.trim().slice(0, 300);
  if (!name || !description) throw new Error('skill name and description are required');
  mkdirSync(skillsDir, { recursive: true });
  const dir = resolve(skillsDir);
  const full = resolve(dir, `${slug}.md`);
  if (!full.startsWith(dir + sep)) throw new Error('path traversal blocked');
  if (existsSync(full)) throw new Error(`skill "${slug}" already exists — refusing to overwrite`);
  const content = [
    '---',
    `name: ${slug}`,
    `description: ${description}`,
    '---',
    '',
    `# ${name}`,
    '',
    description,
    '',
    '## When to use',
    '',
    '- TODO: the situations where this skill applies.',
    '',
    '## Steps',
    '',
    '1. TODO: first step.',
    '2. TODO: second step.',
    '',
    '## Output expectations',
    '',
    '- TODO: what a good result looks like.',
    '',
  ].join('\n');
  writeFileSync(full, content);
  return full;
}

/** Read back a bootstrap marker (diagnostics/UI); null when absent/corrupt. */
export function readBootstrapMarker(dataDir: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, BOOTSTRAP_MARKER), 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
