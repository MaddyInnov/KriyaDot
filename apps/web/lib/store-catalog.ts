// SPDX-License-Identifier: Apache-2.0
// Unified Store catalog helpers (closure ADD-1).
//
// The Store's primary feed is the server aggregation at GET /api/store
// (apps/api/src/store-routes.ts). Until that router is wired into the
// host, the page falls back to merging the SAME existing endpoints
// client-side: /api/marketplace, /api/plugins, /api/skills and
// /api/mcp/directory. Both paths produce the StoreItem shape below and
// share this module's classifier + filtering, so the UI never diverges.
//
// Everything exported here is pure (no fetch, no React) and unit-tested
// in store-catalog.test.ts. Installs are NOT implemented here — the
// storefront routes each card into the existing flows (see
// installDescriptorFor).

export type StoreKind = 'bot' | 'skill' | 'workflow' | 'mcp-server' | 'capability' | 'plugin';
export type StoreSource = 'marketplace' | 'plugin' | 'user-skill' | 'mcp-directory';
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

export const STORE_CATEGORIES: readonly StoreCategory[] = [
  { id: 'office', label: 'Office' },
  { id: 'studio', label: 'Studio' },
  { id: 'design', label: 'Design & sites' },
  { id: 'code', label: 'Code' },
  { id: 'biz', label: 'Biz' },
  { id: 'prod', label: 'Prod' },
  { id: 'sci-health', label: 'Sci & health' },
];

export const CATEGORY_LABEL: ReadonlyMap<StoreCategoryId, string> = new Map(
  STORE_CATEGORIES.map((c) => [c.id, c.label] as const),
);

export interface StoreItem {
  id: string;
  sourceId: string;
  kind: StoreKind;
  source: StoreSource;
  name: string;
  description: string;
  version: string;
  publisher: string;
  category: StoreCategoryId;
  categoryLabel: string;
  tags: string[];
  keywords: string[];
  permissions: string[];
  priceCents: number;
  license?: string;
  untrusted?: boolean;
  featured: boolean;
  installed: boolean;
  installVia: 'marketplace' | 'plugin' | 'skill-enable' | 'mcp-directory';
}

// ---------------------------------------------------------------------------
// Category classifier — deterministic mirror of the API aggregation layer.
// ---------------------------------------------------------------------------

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

function bestCategoryForTokens(hay: Set<string>): StoreCategoryId | null {
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

/** Same rules as the server classifier: explicit category first, then keywords. */
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
    const scored = bestCategoryForTokens(tokenize(explicit));
    if (scored) return scored;
  }
  const hay = tokenize(
    [input.name, input.description, ...(input.tags ?? []), input.kind ?? ''].join(' '),
  );
  return bestCategoryForTokens(hay) ?? 'prod';
}

// ---------------------------------------------------------------------------
// Client-side merge of the existing endpoints (fallback feed)
// ---------------------------------------------------------------------------

export interface MarketplaceEntryLike {
  id: string;
  kind: 'bot' | 'skill' | 'workflow' | 'mcp-server' | 'capability';
  name: string;
  version: string;
  creator: string;
  description: string;
  license: string;
  priceCents: number;
  tags: string[];
  untrusted: boolean;
  category?: string;
  requiredEnv?: string[];
  payload?: Record<string, unknown>;
}

export interface PluginLike {
  id: string;
  name: string;
  version: string;
  description: string;
  kinds: string[];
  permissions?: { network?: boolean; env?: string[] };
  enabled: boolean;
  sourceType: string;
}

export interface UserSkillLike {
  name: string;
  description: string;
  version: string;
  status: 'draft' | 'active' | 'disabled' | 'rejected';
  source: string;
}

export interface McpDirectoryLike {
  id: string;
  name: string;
  description: string;
  category: string;
  permissions: string[];
  needsEnv?: string[];
  installed: boolean;
}

export interface StoreMergeInput {
  marketplace?: readonly MarketplaceEntryLike[];
  /** Ids (`kind:id`) the host reports as installed, when known. */
  installedMarketplaceIds?: ReadonlySet<string>;
  plugins?: readonly PluginLike[];
  userSkills?: readonly UserSkillLike[];
  mcpDirectory?: readonly McpDirectoryLike[];
}

function marketplacePermissions(entry: MarketplaceEntryLike): string[] {
  const p = (entry.payload ?? {}) as Record<string, unknown>;
  if (entry.kind === 'bot') {
    const out: string[] = [];
    const tools = (p.tools as string[] | undefined) ?? [];
    const skills = (p.skills as string[] | undefined) ?? [];
    const mcp = (p.mcpServers as string[] | undefined) ?? [];
    if (tools.length) out.push(`Tools: ${tools.join(', ')}`);
    if (skills.length) out.push(`Skills: ${skills.join(', ')}`);
    if (mcp.length) out.push(`MCP servers: ${mcp.join(', ')}`);
    return out.length ? out : ['No tools or servers requested'];
  }
  if (entry.kind === 'mcp-server') {
    const out = [`Runs local command: ${((p.command as string) ?? '').trim()}`.trim()];
    const env = (p.requiredEnv as string[] | undefined) ?? entry.requiredEnv ?? [];
    if (env.length) out.push(`Environment variables: ${env.join(', ')}`);
    out.push('Install requires your approval (governance inbox)');
    return out;
  }
  if (entry.kind === 'skill') return ['Adds instructions a bot follows when the skill is active'];
  if (entry.kind === 'workflow') return ['Runs its steps with the bots and tools named in the workflow'];
  return ['No elevated permissions requested'];
}

function withCategory(
  base: Omit<StoreItem, 'category' | 'categoryLabel' | 'featured'>,
  classifyInput: Parameters<typeof classifyStoreCategory>[0],
): Omit<StoreItem, 'featured'> {
  const category = classifyStoreCategory(classifyInput);
  return { ...base, category, categoryLabel: CATEGORY_LABEL.get(category) ?? category };
}

/** Merge the four existing feeds into one catalog (client fallback path). */
export function mergeStoreCatalog(input: StoreMergeInput): StoreItem[] {
  const raw: Array<Omit<StoreItem, 'featured'>> = [];
  for (const entry of input.marketplace ?? []) {
    raw.push(
      withCategory(
        {
          id: `marketplace:${entry.kind}:${entry.id}`,
          sourceId: entry.id,
          kind: entry.kind,
          source: 'marketplace',
          name: entry.name,
          description: entry.description,
          version: entry.version,
          publisher: entry.creator,
          tags: [...entry.tags],
          keywords: [entry.kind, entry.creator],
          permissions: marketplacePermissions(entry),
          priceCents: entry.priceCents,
          license: entry.license,
          untrusted: entry.untrusted,
          installed: input.installedMarketplaceIds?.has(`${entry.kind}:${entry.id}`) ?? false,
          installVia: 'marketplace',
        },
        {
          name: entry.name,
          description: entry.description,
          tags: entry.tags,
          kind: entry.kind,
          explicitCategory: entry.category,
        },
      ),
    );
  }
  for (const plugin of input.plugins ?? []) {
    const permissions: string[] = [];
    if (plugin.permissions?.network) permissions.push('Network access (declared)');
    if (plugin.permissions?.env?.length) {
      permissions.push(`Environment variables: ${plugin.permissions.env.join(', ')}`);
    }
    if (plugin.kinds.length) permissions.push(`Provides: ${plugin.kinds.join(', ')}`);
    raw.push(
      withCategory(
        {
          id: `plugin:plugin:${plugin.id}`,
          sourceId: plugin.id,
          kind: 'plugin',
          source: 'plugin',
          name: plugin.name,
          description: plugin.description,
          version: plugin.version,
          publisher: plugin.sourceType,
          tags: [...plugin.kinds],
          keywords: ['plugin', plugin.sourceType],
          permissions: permissions.length ? permissions : ['No elevated permissions declared'],
          priceCents: 0,
          installed: true,
          installVia: 'plugin',
        },
        { name: plugin.name, description: plugin.description, tags: plugin.kinds, kind: 'plugin' },
      ),
    );
  }
  const marketplaceSkillNames = new Set(
    raw.filter((i) => i.source === 'marketplace' && i.kind === 'skill').map((i) => i.name.toLowerCase()),
  );
  for (const skill of input.userSkills ?? []) {
    if (skill.status === 'rejected' || skill.status === 'draft') continue;
    if (marketplaceSkillNames.has(skill.name.toLowerCase())) continue;
    raw.push(
      withCategory(
        {
          id: `user-skill:skill:${skill.name}`,
          sourceId: skill.name,
          kind: 'skill',
          source: 'user-skill',
          name: skill.name,
          description: skill.description,
          version: skill.version,
          publisher: skill.source,
          tags: [],
          keywords: ['skill', skill.source, skill.status],
          permissions: ['Adds instructions a bot follows when the skill is active'],
          priceCents: 0,
          installed: skill.status === 'active',
          installVia: 'skill-enable',
        },
        { name: skill.name, description: skill.description, kind: 'skill' },
      ),
    );
  }
  for (const entry of input.mcpDirectory ?? []) {
    const permissions = [...entry.permissions];
    if (entry.needsEnv?.length) permissions.push(`Environment variables: ${entry.needsEnv.join(', ')}`);
    raw.push(
      withCategory(
        {
          id: `mcp-directory:mcp-server:${entry.id}`,
          sourceId: entry.id,
          kind: 'mcp-server',
          source: 'mcp-directory',
          name: entry.name,
          description: entry.description,
          version: '',
          publisher: 'MCP directory',
          tags: entry.category ? [entry.category] : [],
          keywords: ['mcp-server', 'mcp directory'],
          permissions: permissions.length ? permissions : ['Registers config only — runs on first tool call'],
          priceCents: 0,
          installed: entry.installed,
          installVia: 'mcp-directory',
        },
        {
          name: entry.name,
          description: entry.description,
          kind: 'mcp-server',
          explicitCategory: entry.category,
        },
      ),
    );
  }
  return applyFeatured(raw);
}

export const FEATURED_LIMIT = 6;

/**
 * Featured = curated order: an explicit featured flag on the source DTO
 * wins, else highest available signals (trusted before third-party, free
 * before paid), else stable id order. Deterministic.
 */
export function applyFeatured<T extends Omit<StoreItem, 'featured'> & { featured?: boolean }>(
  raw: readonly T[],
): StoreItem[] {
  const scored = raw.map((item) => {
    let score = 0;
    if (item.featured) score += 1000;
    if (item.untrusted === false) score += 10;
    if (item.priceCents === 0) score += 1;
    if (item.installed) score += 0; // installed state never boosts ranking
    return { item, score };
  });
  const ranked = [...scored].sort(
    (a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id),
  );
  const featuredIds = new Set(ranked.slice(0, FEATURED_LIMIT).map((r) => r.item.id));
  return raw.map((item) => ({ ...item, featured: featuredIds.has(item.id) }));
}

// ---------------------------------------------------------------------------
// Filtering / grouping (shared by the storefront UI)
// ---------------------------------------------------------------------------

/** Big search: every query word must hit name + description + keywords. */
export function filterStoreItems(
  items: readonly StoreItem[],
  opts: { q?: string; category?: StoreCategoryId | ''; kind?: string },
): StoreItem[] {
  const words = (opts.q ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (opts.category && item.category !== opts.category) return false;
    if (opts.kind && item.kind !== opts.kind) return false;
    if (words.length) {
      const hay = [item.name, item.description, item.publisher, ...item.tags, ...item.keywords]
        .join(' ')
        .toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

export function featuredItems(items: readonly StoreItem[]): StoreItem[] {
  return items.filter((i) => i.featured);
}

/** Category sections in taxonomy order; empty categories are omitted. */
export function groupByCategory(
  items: readonly StoreItem[],
): Array<{ category: StoreCategory; items: StoreItem[] }> {
  const out: Array<{ category: StoreCategory; items: StoreItem[] }> = [];
  for (const category of STORE_CATEGORIES) {
    const inCategory = items.filter((i) => i.category === category.id);
    if (inCategory.length) out.push({ category, items: inCategory });
  }
  return out;
}

/** Categories that actually have items (chips hide the rest). */
export function visibleCategories(items: readonly StoreItem[]): StoreCategory[] {
  return STORE_CATEGORIES.filter((c) => items.some((i) => i.category === c.id));
}

/** Two-letter tile monogram for a card (icon substitute, original design). */
export function itemMonogram(item: Pick<StoreItem, 'name'>): string {
  const words = item.name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

export const KIND_LABEL: Record<StoreKind, string> = {
  bot: 'Bot',
  skill: 'Skill',
  workflow: 'Workflow',
  'mcp-server': 'MCP server',
  capability: 'Capability',
  plugin: 'Plugin',
};

// ---------------------------------------------------------------------------
// Install routing — the card never installs anything itself; it describes
// which EXISTING flow owns the install so the UI can route into it.
// ---------------------------------------------------------------------------

export type InstallDescriptor =
  | { flow: 'marketplace-install'; entryId: string; gated: boolean }
  | { flow: 'plugin-approval'; tab: 'plugins' }
  | { flow: 'skill-enable'; skillName: string }
  | { flow: 'mcp-directory-install'; directoryId: string }
  | { flow: 'none-installed' };

export function installDescriptorFor(item: StoreItem): InstallDescriptor {
  if (item.installed) return { flow: 'none-installed' };
  switch (item.installVia) {
    case 'marketplace':
      return {
        flow: 'marketplace-install',
        entryId: item.sourceId,
        gated: item.kind === 'mcp-server',
      };
    case 'plugin':
      // Plugins reach the catalog only once installed, so this is a
      // defensive route: installs belong to the Plugins tab, whose form
      // posts into the server-side governance approval flow.
      return { flow: 'plugin-approval', tab: 'plugins' };
    case 'skill-enable':
      return { flow: 'skill-enable', skillName: item.sourceId };
    case 'mcp-directory':
      return { flow: 'mcp-directory-install', directoryId: item.sourceId };
    default:
      return { flow: 'none-installed' };
  }
}
