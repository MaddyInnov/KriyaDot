// SPDX-License-Identifier: Apache-2.0

/**
 * Specialist packaging (Octomind parity, Tier 3).
 *
 * Skill BUNDLES: curated sets of marketplace entries (skills + a
 * specialist bot) installed as one unit, instead of hunting entries
 * one by one. Bundle MCP entries ARE installed (#155): they land in
 * the installer's MCP config store DISABLED with checksums — the host
 * enables them after approval — instead of being skipped.
 *
 * SPECIALIST NAMING (#155): a bundle may carry `category` + `variant`
 * and is addressable as `category:variant` (its package name), by id,
 * or by an explicit `packageName`. resolvePackageName() maps a package
 * name to the installed bot/bundle so a host runtime can run a
 * specialist by package name.
 *
 * FIRST-RUN BOOTSTRAP (#156): a fresh data dir gets the
 * 'getting-started' bundle exactly once (marker file). Bootstrap also
 * installs declared dependencies (via an injectable hook), resolves
 * declared credentials (missing env = explicit blockers), and produces
 * the MCP server plan the host must start. bootstrapFirstRun is
 * idempotent and safe to call at every server startup.
 *
 * AUTHORING SCAFFOLD: scaffoldSkill() writes a new skill file in the
 * exact frontmatter format the skill loader reads, so authors start
 * from a valid skeleton instead of a blank page. Full package
 * scaffolding (`tap init` logic) lives in taps.ts (#157).
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { MarketplaceEntry, MarketplaceMcpPayload, MarketplaceRegistry } from './registry.js';
import { entryPackageName } from './registry.js';
import type { InstallResult, MarketplaceInstaller } from './installer.js';
import type { OverrideMap, PlaceholderValues } from './manifest.js';

export interface SkillBundle {
  id: string;
  name: string;
  description: string;
  /** Registry entry ids, in install order. */
  entryIds: string[];
  /** `category:variant` specialist addressing (#155). */
  category?: string;
  variant?: string;
  /** Explicit package name override; defaults to `category:variant`, else the id. */
  packageName?: string;
  /** Declared package dependencies, installed at bootstrap (#156). */
  dependencies?: string[];
  /** Env var names the bundle needs resolved at bootstrap (#156). */
  requiredEnv?: string[];
  /** MCP servers declared inline in the bundle manifest (#155/#156). */
  mcpServers?: MarketplaceMcpPayload[];
}

export const BUNDLES: SkillBundle[] = [
  {
    id: 'getting-started',
    name: 'Getting Started',
    description: 'First-run essentials: a meeting scribe bot plus note-taking, git hygiene, and scheduling skills.',
    entryIds: ['meeting-scribe', 'meeting-notes', 'git-hygiene', 'cron-scheduling'],
    category: 'starter',
    variant: 'essentials',
  },
  {
    id: 'developer-toolkit',
    name: 'Developer Toolkit',
    description: 'Code review and testing specialists with review, git, and API integration skills.',
    entryIds: ['code-reviewer', 'test-writer', 'code-review', 'git-hygiene', 'api-integration'],
    category: 'dev',
    variant: 'toolkit',
  },
  {
    id: 'data-starter',
    name: 'Data Starter',
    description: 'A data analyst bot with CSV cleaning, visualization, and SQL skills.',
    entryIds: ['data-analyst', 'csv-cleaning', 'data-viz', 'sql-helper'],
    category: 'data',
    variant: 'starter',
  },
  {
    id: 'content-starter',
    name: 'Content Starter',
    description: 'Copywriting and documentation specialists with blog and copy skills.',
    entryIds: ['copywriter', 'doc-writer', 'blog-posts', 'copywriting'],
    category: 'content',
    variant: 'starter',
  },
];

export function listBundles(): SkillBundle[] {
  return [...BUNDLES];
}

export function getBundle(id: string): SkillBundle | undefined {
  return BUNDLES.find((b) => b.id === id);
}

// ---------------------------------------------------------------------------
// `category:variant` specialist naming + run-by-package-name (#155)
// ---------------------------------------------------------------------------

export interface ParsedPackageName {
  category: string;
  variant: string;
}

const PACKAGE_NAME_RE = /^([a-z0-9][a-z0-9-_]*):([a-z0-9][a-z0-9-_]*)$/i;

/** Parse a `category:variant` package name; null when it is not one. */
export function parsePackageName(name: string): ParsedPackageName | null {
  const m = PACKAGE_NAME_RE.exec(name.trim());
  return m ? { category: m[1], variant: m[2] } : null;
}

/** The canonical package name of a bundle: explicit, else `category:variant`, else id. */
export function packageNameOf(bundle: SkillBundle): string {
  if (bundle.packageName) return bundle.packageName;
  if (bundle.category && bundle.variant) return `${bundle.category}:${bundle.variant}`;
  return bundle.id;
}

/** Find a bundle by id OR package name (`category:variant`). */
export function findBundleByPackageName(ref: string, bundles: SkillBundle[] = BUNDLES): SkillBundle | undefined {
  const name = ref.trim();
  return bundles.find((b) => b.id === name || packageNameOf(b) === name);
}

export interface PackageResolution {
  ref: string;
  /** Canonical package name when the ref resolved to a bundle/entry with one. */
  packageName?: string;
  bundle?: SkillBundle;
  entry?: MarketplaceEntry;
  /** Bot entries the ref resolves to (the runnable specialists). */
  botEntries: MarketplaceEntry[];
  /** Installed bot artifact paths under the installer's target dir. */
  installedBotPaths: string[];
  installed: boolean;
}

/**
 * Run-by-package-name resolution API (#155). Resolves a ref — a bundle
 * id, a `category:variant` package name, an entry id, or an entry's
 * package name — to the bundle/entry plus the INSTALLED bot artifacts.
 *
 * HOST WIRING (parent/API side): the chat/run endpoint accepts a
 * package name, calls resolvePackageName(ref, { registry, installer })
 * (or with an explicit targetDir), loads the bot JSON at
 * installedBotPaths[0], and runs it as the specialist. A resolution
 * with `installed: false` means "install the bundle first" — call
 * installBundle(resolution.bundle, registry, installer).
 */
export function resolvePackageName(
  ref: string,
  deps: { registry?: MarketplaceRegistry; installer?: MarketplaceInstaller; targetDir?: string; bundles?: SkillBundle[] },
): PackageResolution {
  const bundles = deps.bundles ?? BUNDLES;
  const bundle = findBundleByPackageName(ref, bundles);
  const entry = deps.registry?.getById(ref) ?? (deps.registry ? deps.registry.getByPackageName(ref) : undefined);
  const botEntries: MarketplaceEntry[] = [];
  if (bundle && deps.registry) {
    for (const e of resolveBundle(bundle, deps.registry).entries) if (e.kind === 'bot') botEntries.push(e);
  }
  if (entry?.kind === 'bot' && !botEntries.some((b) => b.id === entry.id)) botEntries.push(entry);
  const targetDir = deps.installer?.getTargetDir() ?? deps.targetDir;
  const installedBotPaths: string[] = [];
  if (targetDir) {
    for (const b of botEntries) {
      const p = join(targetDir, 'installed', 'bots', `${b.id}.json`);
      if (existsSync(p)) installedBotPaths.push(p);
    }
  }
  return {
    ref,
    packageName: bundle ? packageNameOf(bundle) : entry ? entryPackageName(entry) : undefined,
    bundle,
    entry,
    botEntries,
    installedBotPaths,
    installed: installedBotPaths.length > 0,
  };
}

export interface BundleResolution {
  bundle: SkillBundle;
  entries: MarketplaceEntry[];
  /** MCP payloads the bundle carries: registry `mcp-server` entries + inline manifest servers (#155). */
  mcpServers: MarketplaceMcpPayload[];
  /** Entry ids the registry does not carry. */
  missing: string[];
}

export function resolveBundle(bundle: SkillBundle, registry: MarketplaceRegistry): BundleResolution {
  const entries: MarketplaceEntry[] = [];
  const missing: string[] = [];
  const mcpServers: MarketplaceMcpPayload[] = [...(bundle.mcpServers ?? [])];
  for (const id of bundle.entryIds) {
    const entry = registry.getById(id);
    if (entry) {
      entries.push(entry);
      // Retain MCP entries in the bundle manifest resolution (#155) —
      // they are installed by installBundle, never silently dropped.
      if (entry.kind === 'mcp-server') mcpServers.push(entry.payload as MarketplaceMcpPayload);
    } else missing.push(id);
  }
  return { bundle, entries, mcpServers, missing };
}

// ---------------------------------------------------------------------------
// Bootstrap building blocks (#156): dependencies, credentials, MCP plan
// ---------------------------------------------------------------------------

export interface DependencyInstallRecord {
  dependency: string;
  status: 'installed' | 'recorded' | 'failed';
  detail?: string;
}

/**
 * Injectable dependency installer hook (#156). Tests inject a fake —
 * no network. The default implementation shells to npm inside the
 * bundle target dir when one is provided, and only records the
 * declaration otherwise.
 */
export type DependencyInstallerHook = (
  dependency: string,
  ctx: { bundleId: string; targetDir?: string },
) => DependencyInstallRecord;

export const defaultDependencyInstaller: DependencyInstallerHook = (dependency, ctx) => {
  if (!ctx.targetDir) return { dependency, status: 'recorded', detail: 'no target dir; declaration recorded only' };
  try {
    execFileSync('npm', ['install', '--prefix', ctx.targetDir, '--no-save', dependency], { stdio: 'pipe', timeout: 120_000 });
    return { dependency, status: 'installed' };
  } catch (err) {
    return { dependency, status: 'failed', detail: err instanceof Error ? err.message.slice(0, 200) : 'npm install failed' };
  }
};

/** All dependencies a bundle declares: its own + its entries' (#156). */
export function bundleDependencies(bundle: SkillBundle, registry: MarketplaceRegistry): string[] {
  const deps = new Set<string>(bundle.dependencies ?? []);
  for (const e of resolveBundle(bundle, registry).entries) {
    for (const d of e.dependencies ?? []) deps.add(d);
    if (e.kind === 'capability') {
      for (const d of (e.payload as { dependencies?: string[] }).dependencies ?? []) deps.add(d);
    }
  }
  return [...deps];
}

export interface CredentialResolution {
  required: string[];
  present: string[];
  /** Missing env names — bootstrap blockers, reported loudly (#156/#158). */
  missing: string[];
}

/** All env names a bundle needs: bundle + MCP payloads + entry declarations. */
export function bundleRequiredEnv(bundle: SkillBundle, registry: MarketplaceRegistry): string[] {
  const names = new Set<string>(bundle.requiredEnv ?? []);
  const { entries, mcpServers } = resolveBundle(bundle, registry);
  for (const s of mcpServers) for (const n of s.requiredEnv) names.add(n);
  for (const e of entries) for (const n of e.requiredEnv ?? []) names.add(n);
  return [...names];
}

export function resolveBundleCredentials(
  bundle: SkillBundle,
  registry: MarketplaceRegistry,
  env: Record<string, string | undefined>,
): CredentialResolution {
  const required = bundleRequiredEnv(bundle, registry);
  const present = required.filter((n) => env[n] !== undefined && env[n] !== '');
  const missing = required.filter((n) => !present.includes(n));
  return { required, present, missing };
}

/** One MCP server config the host must start (#156). */
export interface McpServerPlanEntry {
  id: string;
  label: string;
  command: string;
  args: string[];
  /** Resolved env values; null = not configured (pairs with credential blockers). */
  env: Record<string, string | null>;
  /** Bundle semantics: servers start disabled; the host enables after approval. */
  enabled: boolean;
  /** SHA-256 over the canonical server definition. */
  checksum: string;
  source: string;
}

/**
 * The MCP startup plan for a bundle (#156): every MCP server the bundle
 * declares (registry entries + inline), with env resolved from the
 * provided map. HOST WIRING: the API/host iterates `mcpPlan` (also on
 * BundleInstallResult / BootstrapResult) and starts each server whose
 * env is fully resolved, via its MCP host, once the user enables it.
 */
export function planBundleMcpServers(
  bundle: SkillBundle,
  registry: MarketplaceRegistry,
  env: Record<string, string | undefined> = {},
): McpServerPlanEntry[] {
  const { mcpServers } = resolveBundle(bundle, registry);
  return mcpServers.map((s) => ({
    id: s.id,
    label: s.label,
    command: s.command,
    args: [...s.args],
    env: Object.fromEntries(s.requiredEnv.map((n) => [n, env[n] ?? null])),
    enabled: false,
    checksum: createHash('sha256').update(JSON.stringify({ id: s.id, command: s.command, args: s.args, requiredEnv: s.requiredEnv })).digest('hex'),
    source: bundle.id,
  }));
}

export interface BootstrapPlan {
  bundleId: string;
  packageName: string;
  dependencies: string[];
  credentials: CredentialResolution;
  mcpServers: McpServerPlanEntry[];
  /** Non-empty = bootstrap cannot fully succeed yet (missing credentials). */
  blockers: string[];
}

export function buildBootstrapPlan(
  bundle: SkillBundle,
  registry: MarketplaceRegistry,
  env: Record<string, string | undefined> = {},
): BootstrapPlan {
  const credentials = resolveBundleCredentials(bundle, registry, env);
  return {
    bundleId: bundle.id,
    packageName: packageNameOf(bundle),
    dependencies: bundleDependencies(bundle, registry),
    credentials,
    mcpServers: planBundleMcpServers(bundle, registry, env),
    blockers: credentials.missing.map((n) => `missing-env:${n}`),
  };
}

export interface BundleInstallOptions {
  /** Install bundle MCP entries into the MCP config store (default true, #155).
   *  false restores the legacy skip-and-report behavior. */
  installMcp?: boolean;
  /** Placeholder substitution values (#158). */
  values?: PlaceholderValues;
  /** Per-capability/model overrides (#158). */
  overrides?: OverrideMap;
  /** Environment for credential resolution + MCP env values (#156). Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Dependency installer hook (#156); default shells to npm / records. */
  depInstaller?: DependencyInstallerHook;
  /** Target dir handed to the dependency hook (bundle install root). */
  targetDir?: string;
  overwrite?: boolean;
}

export interface BundleInstallResult {
  bundleId: string;
  /** Canonical `category:variant` package name (#155). */
  packageName: string;
  installed: InstallResult[];
  /** MCP entries installed into the MCP config store, disabled (#155). */
  installedMcp: InstallResult[];
  /** MCP startup plan for the host (#156). */
  mcpPlan: McpServerPlanEntry[];
  /** Dependency install records (#156). */
  dependencies: DependencyInstallRecord[];
  /** Missing credentials as explicit blockers (#156). */
  credentialBlockers: string[];
  /** All blockers: credentials + unresolved placeholders (#158). */
  blockers: string[];
  /** Legacy field: MCP entries skipped ONLY when installMcp is false. */
  skippedMcp: string[];
  missing: string[];
}

export function installBundle(
  bundle: SkillBundle,
  registry: MarketplaceRegistry,
  installer: MarketplaceInstaller,
  opts: BundleInstallOptions = {},
): BundleInstallResult {
  const { entries, mcpServers, missing } = resolveBundle(bundle, registry);
  const env = opts.env ?? process.env;
  const installed: InstallResult[] = [];
  const installedMcp: InstallResult[] = [];
  const skippedMcp: string[] = [];
  const blockers: string[] = [];
  const overrideKeys = [packageNameOf(bundle), bundle.id];

  for (const entry of entries) {
    if (entry.kind === 'mcp-server') continue; // handled via mcpServers below
    const result = installer.install(entry, {
      overwrite: opts.overwrite,
      values: opts.values,
      overrides: opts.overrides,
      overrideKeys,
      onUnresolvedPlaceholders: 'block',
    });
    installed.push(result);
    for (const b of result.blockers ?? []) blockers.push(`${entry.id}:${b}`);
  }

  // #155: bundle MCP entries are installed (disabled, checksummed),
  // not skipped — unless the caller explicitly opts out.
  if (opts.installMcp === false) {
    for (const s of mcpServers) skippedMcp.push(s.id);
  } else {
    for (const s of mcpServers) {
      installedMcp.push(installer.installMcpServerForBundle(s, { sourceId: bundle.id, env, overwrite: opts.overwrite }));
    }
  }

  // #156: declared dependencies via the injectable hook.
  const hook = opts.depInstaller ?? defaultDependencyInstaller;
  const dependencies = bundleDependencies(bundle, registry).map((d) =>
    hook(d, { bundleId: bundle.id, targetDir: opts.targetDir }),
  );
  for (const d of dependencies) if (d.status === 'failed') blockers.push(`dependency-failed:${d.dependency}`);

  // #156: credential resolution — missing env is a loud blocker.
  const credentials = resolveBundleCredentials(bundle, registry, env);
  const credentialBlockers = credentials.missing.map((n) => `missing-env:${n}`);
  blockers.push(...credentialBlockers);

  return {
    bundleId: bundle.id,
    packageName: packageNameOf(bundle),
    installed,
    installedMcp,
    mcpPlan: planBundleMcpServers(bundle, registry, env),
    dependencies,
    credentialBlockers,
    blockers,
    skippedMcp,
    missing,
  };
}

// ---------------------------------------------------------------------------
// First-run bootstrap
// ---------------------------------------------------------------------------

const BOOTSTRAP_MARKER = 'bootstrap.json';

export interface BootstrapResult {
  alreadyBootstrapped: boolean;
  bundle?: BundleInstallResult;
  /** Dependency/credential/MCP plan computed for this run (#156). */
  plan?: BootstrapPlan;
}

export interface BootstrapDeps {
  dataDir: string;
  registry: MarketplaceRegistry;
  installer: MarketplaceInstaller;
  /** Which bundle to bootstrap. Default 'getting-started'. */
  bundleId?: string;
  /** Environment for credential resolution. Default process.env. */
  env?: Record<string, string | undefined>;
  /** Dependency installer hook (#156); tests inject a fake. */
  depInstaller?: DependencyInstallerHook;
  values?: PlaceholderValues;
  overrides?: OverrideMap;
}

/**
 * Install the getting-started bundle into a fresh install exactly
 * once. The marker records what was installed; later calls are no-ops
 * (even if the user uninstalled pieces — bootstrap never fights the
 * user by reinstalling).
 *
 * #156: bootstrap is a real first-use bootstrap — it installs declared
 * dependencies (injectable hook), resolves declared credentials
 * (missing env surfaces as blockers on the result + marker, never
 * silent), installs bundle MCP entries disabled, and returns the MCP
 * startup plan the host must start. It is IDEMPOTENT and safe to call
 * at every server startup.
 *
 * HOST WIRING (parent/API side): call bootstrapFirstRun once during
 * server startup (apps/api bootstrap sequence) in addition to the
 * existing POST /bootstrap endpoint; then start each entry of
 * result.plan.mcpServers whose env is fully resolved, and surface
 * result.plan.blockers to the user as setup actions.
 */
export function bootstrapFirstRun(deps: BootstrapDeps): BootstrapResult {
  const markerPath = join(deps.dataDir, BOOTSTRAP_MARKER);
  if (existsSync(markerPath)) return { alreadyBootstrapped: true };
  const bundle = getBundle(deps.bundleId ?? 'getting-started') ?? getBundle('getting-started')!;
  const env = deps.env ?? process.env;
  const plan = buildBootstrapPlan(bundle, deps.registry, env);
  const result = installBundle(bundle, deps.registry, deps.installer, {
    env,
    depInstaller: deps.depInstaller,
    values: deps.values,
    overrides: deps.overrides,
  });
  mkdirSync(deps.dataDir, { recursive: true });
  writeFileSync(
    markerPath,
    JSON.stringify(
      {
        bundleId: bundle.id,
        packageName: result.packageName,
        at: new Date().toISOString(),
        installed: result.installed.map((r) => r.entryId),
        installedMcp: result.installedMcp.map((r) => r.entryId),
        skippedMcp: result.skippedMcp,
        missing: result.missing,
        dependencies: result.dependencies,
        blockers: result.blockers,
        mcpPlan: result.mcpPlan.map((s) => s.id),
      },
      null,
      2,
    ) + '\n',
  );
  return { alreadyBootstrapped: false, bundle: result, plan };
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
