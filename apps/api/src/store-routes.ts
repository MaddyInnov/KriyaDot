// SPDX-License-Identifier: Apache-2.0
// Unified Store catalog (closure ADD-1, MiniMax-style storefront).
//
// One merged catalog over the EXISTING registries — nothing here is a new
// source of truth and no install semantics live here:
//
//   - marketplace registry entries (bots / skills / workflows / MCP
//     servers / capabilities) via @mvp/marketplace's MarketplaceRegistry,
//     with installed state mirrored from MarketplaceInstaller's on-disk
//     layout (`<targetDir>/installed/<kind-dir>/<id>.<json|md>`);
//   - installed plugins via a host callback over the PluginManager list
//     (plugins install through the governance approval flow in
//     plugin-routes.ts — the Store only ever shows them as installed);
//   - user skills via a host callback over the skill store (enabling a
//     disabled skill is the skills-panel flow, not a Store invention);
//   - the MCP directory via a host callback (installs POST to
//     /api/mcp/servers exactly like McpDirectoryPanel).
//
// Every item carries a `category` derived HERE, in the aggregation layer:
// an explicit category on the source record wins when it maps onto the
// Store taxonomy; otherwise a deterministic keyword classifier scores the
// item's name + description + tags. Source registries are never edited.
//
// HOST WIRING (routes.ts / index.ts — one import + one use; the router is
// register-style like marketplace.ts):
//   import { registerStoreRoutes } from './store-routes.js';
//   const storeRouter = express.Router();
//   registerStoreRoutes(storeRouter, {
//     registry, installer, // the same instances registerMarketplaceRoutes got
//     listPlugins: () => pluginManager.list().map(serializeInstalledPlugin),
//     listUserSkills: () => userSkillStore.list().map((s) => ({ ... })),
//     listMcpDirectory: () => mcpDirectoryEntries, // with `installed` flags
//     installsByCreator: (creator) => revenue.creatorSummary(creator).installs,
//   });
//   app.use('/api/store', storeRouter);
//
// Routes (router mounted at /api/store):
//   GET /            → { ok, items, categories, featuredIds }
//                      (?q=…&category=…&kind=… filters, all optional)
//   GET /categories  → [{ id, label, count }] for categories that have items

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { MarketplaceEntry, MarketplaceInstaller, MarketplaceRegistry } from '@mvp/marketplace';

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

export type StoreCategoryId =
  | 'office'
  | 'studio'
  | 'design'
  | 'code'
  | 'biz'
  | 'prod'
  | 'sci-health';

export interface StoreCategory {
  id: StoreCategoryId;
  label: string;
}

/** Store taxonomy (ADD-1). `featured` is a rail, not a category. */
export const STORE_CATEGORIES: readonly StoreCategory[] = [
  { id: 'office', label: 'Office' },
  { id: 'studio', label: 'Studio' },
  { id: 'design', label: 'Design & sites' },
  { id: 'code', label: 'Code' },
  { id: 'biz', label: 'Biz' },
  { id: 'prod', label: 'Prod' },
  { id: 'sci-health', label: 'Sci & health' },
];

const CATEGORY_LABEL = new Map(STORE_CATEGORIES.map((c) => [c.id, c.label]));

/** Tie-break priority when keyword scores are equal (earlier wins). */
const CATEGORY_PRIORITY: readonly StoreCategoryId[] = [
  'sci-health',
  'design',
  'code',
  'office',
  'biz',
  'studio',
  'prod',
];

const CATEGORY_KEYWORDS: Record<StoreCategoryId, readonly string[]> = {
  'sci-health': [
    'health', 'medical', 'science', 'scientific', 'clinic', 'clinical', 'patient',
    'wellness', 'biology', 'chemistry', 'physics', 'hospital', 'fitness', 'therapy',
    'diagnosis', 'doctor', 'lab', 'research-lab',
  ],
  design: [
    'design', 'website', 'websites', 'site', 'sites', 'ui', 'ux', 'figma', 'visual',
    'chart', 'charts', 'visualization', 'branding', 'logo', 'image', 'images',
    'photo', 'illustration', 'css', 'frontend', 'layout', 'theme',
  ],
  code: [
    'code', 'coding', 'git', 'sql', 'api', 'regex', 'shell', 'devops', 'test',
    'testing', 'debug', 'programming', 'developer', 'database', 'postgres',
    'sqlite', 'deploy', 'lint', 'compiler', 'javascript', 'typescript', 'python',
    'scraping', 'scraper', 'review', 'reviews',
  ],
  office: [
    'office', 'meeting', 'meetings', 'notes', 'standup', 'email', 'inbox',
    'calendar', 'document', 'documents', 'pdf', 'doc', 'docs', 'report',
    'reporting', 'spreadsheet', 'presentation', 'transcript', 'transcripts',
  ],
  biz: [
    'business', 'marketing', 'sales', 'finance', 'financial', 'expense',
    'expenses', 'revenue', 'customer', 'crm', 'strategy', 'competitive',
    'market', 'copy', 'copywriting', 'ads', 'commerce', 'invoice', 'billing',
    'data', 'analysis', 'analytics', 'csv', 'etl', 'research', 'seo',
  ],
  studio: [
    'studio', 'video', 'audio', 'music', 'blog', 'writing', 'write', 'content',
    'translation', 'translate', 'language', 'creative', 'podcast', 'media',
    'story', 'stories', 'prompt', 'prompts', 'song', 'voice',
  ],
  prod: [
    'productivity', 'automation', 'workflow', 'workflows', 'cron', 'scheduling',
    'schedule', 'monitor', 'monitoring', 'backup', 'planning', 'planner', 'task',
    'tasks', 'organize', 'web', 'fetch', 'search', 'tools', 'file', 'files',
    'daily', 'weekly',
  ],
};

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9-]+/)
      .map((t) => t.trim())
      .filter(Boolean),
  );
}

/**
 * Deterministic keyword classifier: score each category by whole-word
 * keyword hits over name + description + tags (+ kind), pick the highest
 * score, break ties by CATEGORY_PRIORITY, fall back to 'prod'. Pure —
 * the same input always yields the same category.
 */
export function classifyStoreCategory(input: {
  name: string;
  description: string;
  tags?: readonly string[];
  kind?: string;
  explicitCategory?: string;
}): StoreCategoryId {
  const explicit = (input.explicitCategory ?? '').trim().toLowerCase();
  if (explicit) {
    const direct = STORE_CATEGORIES.find(
      (c) => c.id === explicit || c.label.toLowerCase() === explicit,
    );
    if (direct) return direct.id;
    // A free-form source category (e.g. "productivity") is classified by
    // the same keyword rules instead of being dropped.
    const scored = scoreText(explicit);
    if (scored) return scored;
  }
  const hay = tokenize(
    [input.name, input.description, ...(input.tags ?? []), input.kind ?? ''].join(' '),
  );
  let best: StoreCategoryId | null = null;
  let bestScore = 0;
  for (const id of CATEGORY_PRIORITY) {
    let score = 0;
    for (const kw of CATEGORY_KEYWORDS[id]) if (hay.has(kw)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best ?? 'prod';
}

function scoreText(text: string): StoreCategoryId | null {
  const hay = tokenize(text);
  let best: StoreCategoryId | null = null;
  let bestScore = 0;
  for (const id of CATEGORY_PRIORITY) {
    let score = 0;
    for (const kw of CATEGORY_KEYWORDS[id]) if (hay.has(kw)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Item DTO
// ---------------------------------------------------------------------------

export type StoreKind = 'bot' | 'skill' | 'workflow' | 'mcp-server' | 'capability' | 'plugin';
export type StoreSource = 'marketplace' | 'plugin' | 'user-skill' | 'mcp-directory';

export interface StoreItemDTO {
  /** Namespaced, stable across sources: `<source>:<kind>:<sourceId>`. */
  id: string;
  /** The id in the source registry — what install calls address. */
  sourceId: string;
  kind: StoreKind;
  source: StoreSource;
  name: string;
  description: string;
  version: string;
  /** Creator handle / plugin source type / skill origin. */
  publisher: string;
  category: StoreCategoryId;
  categoryLabel: string;
  tags: string[];
  /** Extra search fodder (kind, source, category label, payload hints). */
  keywords: string[];
  /** Human-readable permission strings for the detail view. */
  permissions: string[];
  priceCents: number;
  license?: string;
  untrusted?: boolean;
  featured: boolean;
  installed: boolean;
  /**
   * How the card's Install action routes into the EXISTING flows:
   *  - 'marketplace': POST /api/marketplace/:id/install (+ /confirm for MCP)
   *  - 'plugin': already installed; management lives in the Plugins tab
   *    (installs there go through the governance approval flow)
   *  - 'skill-enable': POST /api/skills/:name/enable (skills-panel flow)
   *  - 'mcp-directory': POST /api/mcp/servers { directoryId } (directory flow)
   */
  installVia: 'marketplace' | 'plugin' | 'skill-enable' | 'mcp-directory';
}

// ---------------------------------------------------------------------------
// Host-provided views of the other existing stores (all optional)
// ---------------------------------------------------------------------------

export interface StorePluginLike {
  id: string;
  name: string;
  version: string;
  description: string;
  kinds: string[];
  permissions?: { network?: boolean; env?: string[] };
  enabled: boolean;
  sourceType: string;
}

export interface StoreUserSkillLike {
  name: string;
  description: string;
  version: string;
  status: 'draft' | 'active' | 'disabled' | 'rejected';
  source: string;
}

export interface StoreMcpDirectoryLike {
  id: string;
  name: string;
  description: string;
  category: string;
  permissions: string[];
  needsEnv?: string[];
  installed: boolean;
}

export interface StoreRoutesDeps {
  registry: MarketplaceRegistry;
  installer: MarketplaceInstaller;
  listPlugins?: () => StorePluginLike[];
  listUserSkills?: () => StoreUserSkillLike[];
  listMcpDirectory?: () => StoreMcpDirectoryLike[];
  /** Install counts per creator (revenue ledger) — featured ranking signal. */
  installsByCreator?: (creator: string) => number;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

const KIND_DIR: Record<string, { dir: string; ext: string }> = {
  bot: { dir: 'bots', ext: 'json' },
  skill: { dir: 'skills', ext: 'md' },
  workflow: { dir: 'workflows', ext: 'json' },
  'mcp-server': { dir: 'mcp-servers', ext: 'json' },
  capability: { dir: 'capabilities', ext: 'json' },
};

/** Mirror of MarketplaceInstaller's on-disk installed check. */
export function isMarketplaceEntryInstalled(
  installer: MarketplaceInstaller,
  entry: Pick<MarketplaceEntry, 'id' | 'kind'>,
): boolean {
  const spec = KIND_DIR[entry.kind];
  if (!spec) return false;
  return existsSync(join(installer.getTargetDir(), 'installed', spec.dir, `${entry.id}.${spec.ext}`));
}

function marketplacePermissions(entry: MarketplaceEntry): string[] {
  const p = entry.payload as unknown as Record<string, unknown>;
  switch (entry.kind) {
    case 'bot': {
      const out: string[] = [];
      const tools = (p.tools as string[] | undefined) ?? [];
      const skills = (p.skills as string[] | undefined) ?? [];
      const mcp = (p.mcpServers as string[] | undefined) ?? [];
      if (tools.length) out.push(`Tools: ${tools.join(', ')}`);
      if (skills.length) out.push(`Skills: ${skills.join(', ')}`);
      if (mcp.length) out.push(`MCP servers: ${mcp.join(', ')}`);
      return out.length ? out : ['No tools or servers requested'];
    }
    case 'mcp-server': {
      const out = [`Runs local command: ${(p.command as string) ?? ''}`.trim()];
      const env = (p.requiredEnv as string[] | undefined) ?? [];
      if (env.length) out.push(`Environment variables: ${env.join(', ')}`);
      out.push('Install requires your approval (governance inbox)');
      return out;
    }
    case 'capability': {
      const out: string[] = [];
      const env = (entry.requiredEnv ?? (p.requiredEnv as string[] | undefined)) ?? [];
      if (env.length) out.push(`Environment variables: ${env.join(', ')}`);
      const servers = (p.mcpServers as unknown[] | undefined) ?? [];
      if (servers.length) out.push(`Bundles ${servers.length} MCP server(s), disabled until enabled`);
      return out.length ? out : ['No elevated permissions requested'];
    }
    case 'skill':
      return ['Adds instructions a bot follows when the skill is active'];
    case 'workflow':
      return ['Runs its steps with the bots and tools named in the workflow'];
    default:
      return [];
  }
}

function fromMarketplaceEntry(
  entry: MarketplaceEntry,
  deps: StoreRoutesDeps,
): Omit<StoreItemDTO, 'featured'> {
  const category = classifyStoreCategory({
    name: entry.name,
    description: entry.description,
    tags: entry.tags,
    kind: entry.kind,
    explicitCategory: entry.category,
  });
  return {
    id: `marketplace:${entry.kind}:${entry.id}`,
    sourceId: entry.id,
    kind: entry.kind,
    source: 'marketplace',
    name: entry.name,
    description: entry.description,
    version: entry.version,
    publisher: entry.creator,
    category,
    categoryLabel: CATEGORY_LABEL.get(category) ?? category,
    tags: [...entry.tags],
    keywords: [entry.kind, entry.creator, category, CATEGORY_LABEL.get(category) ?? ''],
    permissions: marketplacePermissions(entry),
    priceCents: entry.priceCents,
    license: entry.license,
    untrusted: entry.untrusted,
    installed: isMarketplaceEntryInstalled(deps.installer, entry),
    installVia: 'marketplace',
  };
}

function fromPlugin(plugin: StorePluginLike): Omit<StoreItemDTO, 'featured'> {
  const category = classifyStoreCategory({
    name: plugin.name,
    description: plugin.description,
    tags: plugin.kinds,
    kind: 'plugin',
  });
  const permissions: string[] = [];
  if (plugin.permissions?.network) permissions.push('Network access (declared)');
  if (plugin.permissions?.env?.length) {
    permissions.push(`Environment variables: ${plugin.permissions.env.join(', ')}`);
  }
  if (plugin.kinds.length) permissions.push(`Provides: ${plugin.kinds.join(', ')}`);
  if (permissions.length === 0) permissions.push('No elevated permissions declared');
  return {
    id: `plugin:plugin:${plugin.id}`,
    sourceId: plugin.id,
    kind: 'plugin',
    source: 'plugin',
    name: plugin.name,
    description: plugin.description,
    version: plugin.version,
    publisher: plugin.sourceType,
    category,
    categoryLabel: CATEGORY_LABEL.get(category) ?? category,
    tags: [...plugin.kinds],
    keywords: ['plugin', plugin.sourceType, category],
    permissions,
    priceCents: 0,
    installed: true, // the plugin list IS the installed list
    installVia: 'plugin',
  };
}

function fromUserSkill(skill: StoreUserSkillLike): Omit<StoreItemDTO, 'featured'> {
  const category = classifyStoreCategory({
    name: skill.name,
    description: skill.description,
    kind: 'skill',
  });
  return {
    id: `user-skill:skill:${skill.name}`,
    sourceId: skill.name,
    kind: 'skill',
    source: 'user-skill',
    name: skill.name,
    description: skill.description,
    version: skill.version,
    publisher: skill.source,
    category,
    categoryLabel: CATEGORY_LABEL.get(category) ?? category,
    tags: [],
    keywords: ['skill', skill.source, skill.status, category],
    permissions: ['Adds instructions a bot follows when the skill is active'],
    priceCents: 0,
    installed: skill.status === 'active',
    installVia: 'skill-enable',
  };
}

function fromMcpDirectory(entry: StoreMcpDirectoryLike): Omit<StoreItemDTO, 'featured'> {
  const category = classifyStoreCategory({
    name: entry.name,
    description: entry.description,
    kind: 'mcp-server',
    explicitCategory: entry.category,
  });
  const permissions = [...entry.permissions];
  if (entry.needsEnv?.length) permissions.push(`Environment variables: ${entry.needsEnv.join(', ')}`);
  return {
    id: `mcp-directory:mcp-server:${entry.id}`,
    sourceId: entry.id,
    kind: 'mcp-server',
    source: 'mcp-directory',
    name: entry.name,
    description: entry.description,
    version: '',
    publisher: 'MCP directory',
    category,
    categoryLabel: CATEGORY_LABEL.get(category) ?? category,
    tags: entry.category ? [entry.category] : [],
    keywords: ['mcp-server', 'mcp directory', category],
    permissions: permissions.length ? permissions : ['Registers config only — runs on first tool call'],
    priceCents: 0,
    installed: entry.installed,
    installVia: 'mcp-directory',
  };
}

/** Featured score: explicit installs win, then trusted, then free. */
function featuredScore(item: Omit<StoreItemDTO, 'featured'>, deps: StoreRoutesDeps): number {
  let score = 0;
  if (deps.installsByCreator && item.source === 'marketplace') {
    score += deps.installsByCreator(item.publisher) * 100;
  }
  if (item.untrusted === false) score += 10;
  if (item.priceCents === 0) score += 1;
  return score;
}

export const FEATURED_LIMIT = 6;

/** Merge every source into one catalog with featured flags resolved. */
export function buildStoreCatalog(deps: StoreRoutesDeps): StoreItemDTO[] {
  const raw: Array<Omit<StoreItemDTO, 'featured'>> = [];
  for (const entry of deps.registry.list()) raw.push(fromMarketplaceEntry(entry, deps));
  for (const plugin of deps.listPlugins?.() ?? []) raw.push(fromPlugin(plugin));
  // User skills that also exist as marketplace entries keep the marketplace
  // card (it carries price/license); the rest merge in as their own items.
  const marketplaceSkillNames = new Set(
    raw.filter((i) => i.source === 'marketplace' && i.kind === 'skill').map((i) => i.name.toLowerCase()),
  );
  for (const skill of deps.listUserSkills?.() ?? []) {
    if (skill.status === 'rejected' || skill.status === 'draft') continue;
    if (marketplaceSkillNames.has(skill.name.toLowerCase())) continue;
    raw.push(fromUserSkill(skill));
  }
  for (const entry of deps.listMcpDirectory?.() ?? []) raw.push(fromMcpDirectory(entry));

  const ranked = [...raw].sort((a, b) => {
    const byScore = featuredScore(b, deps) - featuredScore(a, deps);
    if (byScore !== 0) return byScore;
    return a.id.localeCompare(b.id); // stable order
  });
  const featuredIds = new Set(ranked.slice(0, FEATURED_LIMIT).map((i) => i.id));
  return raw.map((item) => ({ ...item, featured: featuredIds.has(item.id) }));
}

/** Server-side mirror of the Store's search/category/kind filtering. */
export function filterStoreItems(
  items: readonly StoreItemDTO[],
  opts: { q?: string; category?: string; kind?: string },
): StoreItemDTO[] {
  const q = (opts.q ?? '').trim().toLowerCase();
  return items.filter((item) => {
    if (opts.category && item.category !== opts.category) return false;
    if (opts.kind && item.kind !== opts.kind) return false;
    if (q) {
      const hay = [item.name, item.description, item.publisher, ...item.tags, ...item.keywords]
        .join(' ')
        .toLowerCase();
      if (!q.split(/\s+/).every((word) => hay.includes(word))) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Router (register-style, like marketplace.ts)
// ---------------------------------------------------------------------------

export function registerStoreRoutes(router: Router, deps: StoreRoutesDeps): void {
  router.get('/', (req: Request, res: Response) => {
    try {
      const catalog = buildStoreCatalog(deps);
      const items = filterStoreItems(catalog, {
        q: typeof req.query.q === 'string' ? req.query.q : undefined,
        category: typeof req.query.category === 'string' ? req.query.category : undefined,
        kind: typeof req.query.kind === 'string' ? req.query.kind : undefined,
      });
      const counts = new Map<StoreCategoryId, number>();
      for (const item of catalog) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
      res.json({
        ok: true,
        items,
        categories: STORE_CATEGORIES.filter((c) => (counts.get(c.id) ?? 0) > 0).map((c) => ({
          ...c,
          count: counts.get(c.id) ?? 0,
        })),
        featuredIds: catalog.filter((i) => i.featured).map((i) => i.id),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'failed to build store catalog' });
    }
  });

  router.get('/categories', (_req: Request, res: Response) => {
    try {
      const catalog = buildStoreCatalog(deps);
      const counts = new Map<StoreCategoryId, number>();
      for (const item of catalog) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
      res.json({
        ok: true,
        categories: STORE_CATEGORIES.filter((c) => (counts.get(c.id) ?? 0) > 0).map((c) => ({
          ...c,
          count: counts.get(c.id) ?? 0,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'failed to read store categories' });
    }
  });
}

/** Convenience factory mirroring createPluginRouter/createSkillHubRouter. */
export function createStoreRouter(deps: StoreRoutesDeps): Router {
  const router = Router();
  registerStoreRoutes(router, deps);
  return router;
}
