// SPDX-License-Identifier: Apache-2.0
'use client';

// Unified Store storefront (closure ADD-1): one catalog merging plugins,
// skills, bots, workflows and MCP servers. Layout grammar — big search,
// category chips, a Featured rail, then per-category sections of
// two-column cards — rendered in KriyaDot's clay/glass identity purely
// through the theme CSS variables (all five themes).
//
// Install semantics are UNCHANGED: this component owns no install logic
// of its own. Each card routes into the existing flow for its kind —
// marketplace installs POST to /api/marketplace (MCP entries stay
// governance-gated with the approvals-inbox confirm step), user skills
// enable through /api/skills, MCP directory entries install through
// /api/mcp/servers, and plugins (installed-only in the catalog) manage
// through the Plugins tab whose form runs the approval flow.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { authedFetch } from '../../lib/api';
import { useCollapsed } from '../../lib/use-collapsed';
import { CollapseChevron } from '../collapse';
import {
  KIND_LABEL,
  STORE_CATEGORIES,
  featuredItems,
  filterStoreItems,
  groupByCategory,
  installDescriptorFor,
  itemMonogram,
  mergeStoreCatalog,
  visibleCategories,
  type McpDirectoryLike,
  type MarketplaceEntryLike,
  type PluginLike,
  type StoreCategoryId,
  type StoreItem,
  type UserSkillLike,
} from '../../lib/store-catalog';

const api = (path: string, init?: RequestInit): Promise<unknown> =>
  authedFetch(path, init).then(async (res) => {
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`API ${res.status}: ${detail || res.statusText}`);
    }
    return res.json() as Promise<unknown>;
  });

const fmtMoney = (cents: number): string =>
  cents === 0 ? 'Free' : `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;

// ---------------------------------------------------------------------------
// Presentational pieces (statically renderable; covered by tests)
// ---------------------------------------------------------------------------

export function StoreCard({
  item,
  busy,
  onInstall,
  onSelect,
}: {
  item: StoreItem;
  busy?: boolean;
  onInstall: (item: StoreItem) => void;
  onSelect: (item: StoreItem) => void;
}): React.JSX.Element {
  const descriptor = installDescriptorFor(item);
  return (
    <div className="card lift" data-store-item={item.id} style={{ marginTop: 0 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div
          aria-hidden
          style={{
            flex: '0 0 46px',
            width: 46,
            height: 46,
            borderRadius: 14,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 800,
            fontSize: 15,
            color: 'var(--accent-ink)',
            background: 'var(--brand-grad)',
            boxShadow: 'var(--clay-shadow-sm)',
          }}
        >
          {itemMonogram(item)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row-between" style={{ alignItems: 'flex-start' }}>
            <strong>{item.name}</strong>
            <span className={`chip ${item.kind === 'mcp-server' ? 'amber' : 'gray'}`}>
              {KIND_LABEL[item.kind]}
            </span>
          </div>
          <p
            className="small muted"
            style={{
              margin: '2px 0 8px',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {item.description}
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {item.installed ? (
              <span className="chip green">Installed</span>
            ) : (
              <button
                className="btn btn-primary btn-sm"
                disabled={busy}
                onClick={() => onInstall(item)}
              >
                {busy
                  ? 'Working…'
                  : descriptor.flow === 'plugin-approval'
                    ? 'Install via Plugins'
                    : descriptor.flow === 'marketplace-install' && descriptor.gated
                      ? 'Request install (approval)'
                      : descriptor.flow === 'skill-enable'
                        ? 'Enable'
                        : 'Install'}
              </button>
            )}
            <button className="btn btn-sm" onClick={() => onSelect(item)}>
              Details
            </button>
            <span className="small muted">
              {fmtMoney(item.priceCents)}
              {item.untrusted ? ' · third-party' : ''}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function StoreDetail({
  item,
  busy,
  onInstall,
  onConfirmMcp,
  onClose,
}: {
  item: StoreItem;
  busy?: boolean;
  onInstall: (item: StoreItem) => void;
  onConfirmMcp?: (item: StoreItem) => void;
  onClose: () => void;
}): React.JSX.Element {
  const descriptor = installDescriptorFor(item);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${item.name} details`}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        background: 'rgba(0,0,0,0.35)',
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{
          maxWidth: 560,
          width: '100%',
          maxHeight: '85vh',
          overflow: 'auto',
          background: 'var(--glass-bg)',
          backdropFilter: 'blur(14px)',
          border: '1px solid var(--glass-border)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <div
              aria-hidden
              style={{
                width: 52,
                height: 52,
                borderRadius: 16,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 800,
                fontSize: 17,
                color: 'var(--accent-ink)',
                background: 'var(--brand-grad)',
              }}
            >
              {itemMonogram(item)}
            </div>
            <div>
              <strong style={{ fontSize: 17 }}>{item.name}</strong>
              <div className="small muted">
                {KIND_LABEL[item.kind]} · {item.categoryLabel}
                {item.version ? ` · v${item.version}` : ''}
              </div>
            </div>
          </div>
          <button className="btn btn-sm" onClick={onClose} aria-label="Close details">
            ✕
          </button>
        </div>

        <p style={{ marginTop: 14 }}>{item.description || 'No description provided.'}</p>

        <dl className="small" style={{ display: 'grid', gap: 6, margin: '12px 0' }}>
          <div>
            <dt className="muted" style={{ display: 'inline' }}>Publisher / source: </dt>
            <dd style={{ display: 'inline', margin: 0 }}>
              <span className="mono">{item.publisher}</span> ({item.source})
            </dd>
          </div>
          {item.license && (
            <div>
              <dt className="muted" style={{ display: 'inline' }}>License: </dt>
              <dd style={{ display: 'inline', margin: 0 }}>{item.license}</dd>
            </div>
          )}
          <div>
            <dt className="muted" style={{ display: 'inline' }}>Price: </dt>
            <dd style={{ display: 'inline', margin: 0 }}>{fmtMoney(item.priceCents)}</dd>
          </div>
          {item.tags.length > 0 && (
            <div>
              <dt className="muted" style={{ display: 'inline' }}>Tags: </dt>
              <dd style={{ display: 'inline', margin: 0 }}>{item.tags.join(', ')}</dd>
            </div>
          )}
        </dl>

        <h4 style={{ margin: '14px 0 6px' }}>Permissions requested</h4>
        {item.permissions.length ? (
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {item.permissions.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : (
          <p className="small muted">No permissions requested.</p>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          {item.installed ? (
            <span className="chip green">Installed</span>
          ) : (
            <button className="btn btn-primary" disabled={busy} onClick={() => onInstall(item)}>
              {busy
                ? 'Working…'
                : descriptor.flow === 'marketplace-install' && descriptor.gated
                  ? 'Request install (approval)'
                  : descriptor.flow === 'skill-enable'
                    ? 'Enable skill'
                    : 'Install'}
            </button>
          )}
          {descriptor.flow === 'marketplace-install' && descriptor.gated && onConfirmMcp && (
            <button className="btn" disabled={busy} onClick={() => onConfirmMcp(item)}>
              Confirm install after approval
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

/**
 * One per-category section of the All view. Collapse pass: the section
 * header is a toggle with the shared chevron, persisted per category
 * (`kriyadot:collapse:store-cat:<id>`).
 */
function StoreCategorySection({
  category,
  items,
  renderItem,
}: {
  category: { id: string; label: string };
  items: StoreItem[];
  renderItem: (item: StoreItem) => React.ReactNode;
}) {
  const col = useCollapsed(`store-cat:${category.id}`);
  return (
    <div>
      <h2 style={{ margin: '20px 0 10px' }}>
        <button
          type="button"
          className="store-section-head"
          aria-expanded={!col.collapsed}
          onClick={col.toggle}
          title={col.collapsed ? `Show ${category.label}` : `Hide ${category.label}`}
        >
          <CollapseChevron collapsed={col.collapsed} />
          <span>{category.label}</span>
        </button>
      </h2>
      {!col.collapsed && <div className="grid-2">{items.map(renderItem)}</div>}
    </div>
  );
}

type ChipSelection = 'featured' | 'all' | StoreCategoryId;

export default function Storefront({
  onGoToPlugins,
}: {
  onGoToPlugins?: () => void;
}): React.JSX.Element {
  const [items, setItems] = useState<StoreItem[]>([]);
  const [query, setQuery] = useState('');
  const [chip, setChip] = useState<ChipSelection>('all');
  const [kind, setKind] = useState('');
  const [selected, setSelected] = useState<StoreItem | null>(null);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loaded, setLoaded] = useState(false);
  // Collapse pass: filter card + Featured rail use the shared pattern.
  const filtersCol = useCollapsed('store-filters');
  const featuredCol = useCollapsed('store-featured');

  const load = useCallback(async () => {
    // Primary feed: the server-side aggregation (GET /api/store). Until
    // the host wires that router, fall back to merging the same existing
    // endpoints client-side — identical items, identical flows.
    try {
      const data = (await api('/api/store')) as { items: StoreItem[] };
      if (Array.isArray(data.items)) {
        setItems(data.items);
        setError('');
        setLoaded(true);
        return;
      }
      throw new Error('unexpected store response');
    } catch {
      try {
        const [marketplace, plugins, skills, mcp] = await Promise.all([
          api('/api/marketplace').catch(() => []),
          api('/api/plugins').catch(() => ({ plugins: [] })),
          api('/api/skills').catch(() => ({ skills: [] })),
          api('/api/mcp/directory').catch(() => []),
        ]);
        setItems(
          mergeStoreCatalog({
            marketplace: marketplace as MarketplaceEntryLike[],
            plugins: (plugins as { plugins: PluginLike[] }).plugins ?? [],
            userSkills: (skills as { skills: UserSkillLike[] }).skills ?? [],
            mcpDirectory: mcp as McpDirectoryLike[],
          }),
        );
        setError('');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoaded(true);
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const markInstalled = useCallback((id: string) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, installed: true } : i)));
    setSelected((prev) => (prev && prev.id === id ? { ...prev, installed: true } : prev));
  }, []);

  const install = useCallback(
    async (item: StoreItem) => {
      const descriptor = installDescriptorFor(item);
      if (descriptor.flow === 'none-installed') return;
      if (descriptor.flow === 'plugin-approval') {
        // Plugin installs belong to the Plugins tab: its form posts into
        // the server-side governance approval flow (deny-by-default).
        onGoToPlugins?.();
        setNotice('Plugin installs run through the Plugins tab so the approval flow can review them first.');
        return;
      }
      setBusyId(item.id);
      setError('');
      setNotice('');
      try {
        if (descriptor.flow === 'marketplace-install') {
          const res = (await api(`/api/marketplace/${encodeURIComponent(descriptor.entryId)}/install`, {
            method: 'POST',
          })) as { approvalId?: string };
          if (descriptor.gated && res.approvalId) {
            sessionStorage.setItem(`mcp-approval-${descriptor.entryId}`, res.approvalId);
            setNotice(
              `Approval requested for "${item.name}" (approval ${res.approvalId}). ` +
                'Approve it in the approvals inbox, then use “Confirm install after approval” in Details.',
            );
          } else {
            markInstalled(item.id);
            setNotice(`Installed "${item.name}"${item.version ? ` v${item.version}` : ''}.`);
          }
        } else if (descriptor.flow === 'skill-enable') {
          await api(`/api/skills/${encodeURIComponent(descriptor.skillName)}/enable`, { method: 'POST' });
          markInstalled(item.id);
          setNotice(`Skill "${item.name}" enabled.`);
        } else if (descriptor.flow === 'mcp-directory-install') {
          await api('/api/mcp/servers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ directoryId: descriptor.directoryId }),
          });
          markInstalled(item.id);
          setNotice(`Installed MCP server "${item.name}" — it starts on first tool call.`);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId('');
      }
    },
    [markInstalled, onGoToPlugins],
  );

  const confirmMcp = useCallback(
    async (item: StoreItem) => {
      const approvalId = sessionStorage.getItem(`mcp-approval-${item.sourceId}`);
      if (!approvalId) {
        setError('No pending approval for this entry — request an install first.');
        return;
      }
      setBusyId(item.id);
      setError('');
      try {
        await api(`/api/marketplace/${encodeURIComponent(item.sourceId)}/install/confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approvalId }),
        });
        sessionStorage.removeItem(`mcp-approval-${item.sourceId}`);
        markInstalled(item.id);
        setNotice(`Installed MCP server "${item.name}".`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId('');
      }
    },
    [markInstalled],
  );

  const chips = useMemo(() => visibleCategories(items), [items]);
  const searching = query.trim().length > 0 || kind !== '';
  const filtered = useMemo(
    () =>
      filterStoreItems(items, {
        q: query,
        kind,
        category: chip !== 'all' && chip !== 'featured' ? chip : '',
      }),
    [items, query, kind, chip],
  );
  const visible = chip === 'featured' && !searching ? featuredItems(filtered) : filtered;
  const featured = useMemo(() => featuredItems(items), [items]);
  const sections = useMemo(() => groupByCategory(visible), [visible]);

  const card = (item: StoreItem) => (
    <StoreCard
      key={item.id}
      item={item}
      busy={busyId === item.id}
      onInstall={(i) => void install(i)}
      onSelect={setSelected}
    />
  );

  return (
    <section aria-label="Store">
      <div
        className="card"
        style={{
          marginBottom: 16,
          background: 'var(--glass-bg)',
          backdropFilter: 'blur(14px)',
          border: '1px solid var(--glass-border)',
        }}
      >
        <button
          type="button"
          className="store-filters-head"
          aria-expanded={!filtersCol.collapsed}
          onClick={filtersCol.toggle}
          title={filtersCol.collapsed ? 'Show search and filters' : 'Hide search and filters'}
        >
          <span className="label" style={{ margin: 0 }}>
            Search &amp; filters
          </span>
          <CollapseChevron collapsed={filtersCol.collapsed} />
        </button>
        {!filtersCol.collapsed && (
          <>
        <label className="label" htmlFor="store-q">
          Search the whole store
        </label>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <input
            id="store-q"
            className="input"
            style={{ flex: '1 1 320px', fontSize: 15, padding: '12px 16px', borderRadius: 999 }}
            placeholder="Search bots, skills, workflows, MCP servers, plugins…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className="input"
            style={{ width: 'auto' }}
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            aria-label="Filter by kind"
          >
            <option value="">All kinds</option>
            <option value="bot">Bots</option>
            <option value="skill">Skills</option>
            <option value="workflow">Workflows</option>
            <option value="mcp-server">MCP servers</option>
            <option value="capability">Capabilities</option>
            <option value="plugin">Plugins</option>
          </select>
        </div>
        <div className="chips" style={{ justifyContent: 'flex-start', margin: '12px 0 0' }}>
          <button
            className="chip-btn"
            aria-pressed={chip === 'featured'}
            style={chip === 'featured' ? { color: 'var(--accent)', borderColor: 'var(--accent)' } : undefined}
            onClick={() => setChip('featured')}
          >
            Featured
          </button>
          <button
            className="chip-btn"
            aria-pressed={chip === 'all'}
            style={chip === 'all' ? { color: 'var(--accent)', borderColor: 'var(--accent)' } : undefined}
            onClick={() => setChip('all')}
          >
            All
          </button>
          {chips.map((c) => (
            <button
              key={c.id}
              className="chip-btn"
              aria-pressed={chip === c.id}
              style={chip === c.id ? { color: 'var(--accent)', borderColor: 'var(--accent)' } : undefined}
              onClick={() => setChip(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
          </>
        )}
      </div>

      {error && <div className="error-box">{error}</div>}
      {notice && <div className="warn-box">{notice}</div>}
      {!loaded && <p className="muted">Loading the store…</p>}
      {loaded && items.length === 0 && !error && <p className="muted">The store catalog is empty.</p>}

      {chip === 'all' && !searching && featured.length > 0 && (
        <>
          <h2 style={{ margin: '8px 0 10px' }}>
            <button
              type="button"
              className="store-section-head"
              aria-expanded={!featuredCol.collapsed}
              onClick={featuredCol.toggle}
              title={featuredCol.collapsed ? 'Show Featured' : 'Hide Featured'}
            >
              <CollapseChevron collapsed={featuredCol.collapsed} />
              <span>Featured</span>
            </button>
          </h2>
          {!featuredCol.collapsed && (
            <div
              style={{
                display: 'flex',
                gap: 14,
                overflowX: 'auto',
                paddingBottom: 8,
                marginBottom: 10,
              }}
            >
              {featured.map((item) => (
                <div key={item.id} style={{ flex: '0 0 min(430px, 88vw)' }}>
                  {card(item)}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {(chip !== 'all' || searching) && (
        <>
          <p className="small muted" role="status">
            {visible.length} {visible.length === 1 ? 'item' : 'items'}
            {chip === 'featured' ? ' featured' : ''}
            {chip !== 'all' && chip !== 'featured'
              ? ` in ${STORE_CATEGORIES.find((c) => c.id === chip)?.label ?? chip}`
              : ''}
            {searching ? ' matching your filters' : ''}
          </p>
          <div className="grid-2">{visible.map(card)}</div>
          {visible.length === 0 && loaded && <p className="muted">Nothing in the store matches.</p>}
        </>
      )}

      {chip === 'all' && !searching &&
        sections.map(({ category, items: sectionItems }) => (
          <StoreCategorySection
            key={category.id}
            category={category}
            items={sectionItems}
            renderItem={card}
          />
        ))}

      {selected && (
        <StoreDetail
          item={selected}
          busy={busyId === selected.id}
          onInstall={(i) => void install(i)}
          onConfirmMcp={(i) => void confirmMcp(i)}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}
