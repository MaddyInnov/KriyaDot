// SPDX-License-Identifier: Apache-2.0
'use client';

// Minimal shell sidebar (2026-10-31 redesign, DeepSeek-Harness grammar):
// brand, one prominent New Chat, Plugins/Automation shortcuts, the six
// destinations as a slim icon nav, a Workspaces switcher, the session
// history (recency-sorted, relative times, searchable), and an account
// footer (pause, theme, mode, settings, account). Nothing from the old
// topbar is lost — theme/mode/language/settings live in the footer.
//
// Session opening is decoupled from the chat page: the sidebar dispatches
// `kriyadot:open-session` / `kriyadot:new-session` / `kriyadot:open-universal`
// CustomEvents when already on `/`, and stashes a sessionStorage pending
// key when navigating there from another destination (the chat page
// consumes both — see app/page.tsx).

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getApiBase, getBots, type BotConfig } from '../../lib/api';
import {
  buildSessionHistory,
  buildWorkspaceList,
  filterHistoryByWorkspace,
  readLastBlockTs,
  readStoredConvos,
  relativeTime,
  searchHistory,
  type SessionHistoryEntry,
} from '../../lib/sessions-history';
import { THEMES, useTheme, type ThemeChoice } from '../../lib/theme';
import { useUxMode, type UxMode } from '../../lib/ux-mode';
import { useCollapsed } from '../../lib/use-collapsed';
import { CollapseChevron } from '../collapse';
import { LanguageSwitcher, useI18n } from '../../lib/i18n';
import { BrandPet } from '../pet/BrandPet';
import { PauseControl } from '../pause-control';
import { UpdateBadge } from '../update-badge';

function icon(children: React.ReactNode) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

interface Dest {
  href: string;
  label: string;
  match: (p: string) => boolean;
  icon: React.ReactNode;
}

function getDests(t: (key: string) => string): Dest[] {
  return [
    {
      href: '/',
      label: t('nav.chat'),
      match: (p) => p === '/',
      icon: icon(<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />),
    },
    {
      href: '/bots',
      label: t('nav.bots'),
      match: (p) => p.startsWith('/bots'),
      icon: icon(
        <>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="M9 9h.01M15 9h.01M8 14h8" />
        </>,
      ),
    },
    {
      href: '/workflows',
      label: t('nav.workflows'),
      match: (p) => p.startsWith('/workflows'),
      icon: icon(
        <>
          <circle cx="6" cy="6" r="2.5" />
          <circle cx="18" cy="18" r="2.5" />
          <circle cx="18" cy="6" r="2.5" />
          <path d="M8.5 6H15M6 8.5v7M6 15.5h7.5" />
        </>,
      ),
    },
    {
      href: '/marketplace',
      label: t('nav.marketplace'),
      match: (p) => p.startsWith('/marketplace'),
      icon: icon(
        <>
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </>,
      ),
    },
    {
      href: '/workspace',
      label: t('nav.workspace'),
      match: (p) =>
        p.startsWith('/workspace') ||
        p.startsWith('/notes') ||
        p.startsWith('/tasks') ||
        p.startsWith('/pages') ||
        p.startsWith('/knowledge'),
      icon: icon(<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />),
    },
    {
      href: '/activity',
      label: t('nav.activity'),
      match: (p) => p.startsWith('/activity') || p.startsWith('/approvals') || p.startsWith('/audit'),
      icon: icon(<path d="M22 12h-4l-3 9L9 3l-3 9H2" />),
    },
  ];
}

const MORE_LINKS = [
  { href: '/knowledge', label: 'Knowledge' },
  { href: '/pages', label: 'Pages' },
  { href: '/terminal', label: 'Terminal' },
  { href: '/teams', label: 'Teams' },
];

const SETTINGS_LINKS = [
  { href: '/accounts', label: 'Accounts & API keys' },
  { href: '/providers', label: 'Providers & models' },
  { href: '/messaging', label: 'Messaging' },
  { href: '/usage', label: 'Usage & costs' },
  { href: '/permissions', label: 'Permissions' },
  { href: '/preferences', label: 'Preferences' },
  { href: '/more', label: 'Modules hub' },
];

const WS_ALL = '__all__';

/** Sidebar display mode (collapse pass): full / icon rail / fully hidden.
 *  Persisted under the shared collapse key `kriyadot:collapse:sidebar`
 *  (mode string instead of the boolean flag — the sidebar has 3 states). */
type SbMode = 'full' | 'rail' | 'hidden';
const SB_MODE_KEY = 'kriyadot:collapse:sidebar';

const eyeOffIcon = icon(
  <>
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
    <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
    <path d="m1 1 22 22" />
  </>,
);

/**
 * One row of the Workspaces list: the workspace itself (click = filter
 * the history) plus its own collapse/expand chevron revealing that
 * workspace's sessions inline. Collapsed by default — the flat Sessions
 * list below remains the primary history view. Persisted per workspace
 * as `kriyadot:collapse:sb-ws:<id>`.
 */
function SidebarWorkspaceRow({
  label,
  id,
  sessionCount,
  active,
  sessions,
  activeMap,
  onPick,
  onOpenSession,
}: {
  label: string;
  id: string | null;
  sessionCount: number;
  active: boolean;
  sessions: SessionHistoryEntry[];
  activeMap: Record<string, string>;
  onPick: () => void;
  onOpenSession: (e: SessionHistoryEntry) => void;
}) {
  const { collapsed, toggle } = useCollapsed(`sb-ws:${id ?? '__default__'}`, true);
  return (
    <div className="sb-ws-group">
      <div className="sb-ws-row">
        <button
          className={`sb-ws${active ? ' active' : ''}`}
          role="option"
          aria-selected={active}
          onClick={onPick}
          title={id ?? label}
        >
          <span className="sb-ws-name">{label}</span>
          <span className="sb-ws-count">{sessionCount}</span>
        </button>
        <button
          type="button"
          className="sb-ws-chev"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Show' : 'Hide'} sessions in ${label}`}
          title={`${collapsed ? 'Show' : 'Hide'} sessions in ${label}`}
          onClick={toggle}
        >
          <CollapseChevron collapsed={collapsed} />
        </button>
      </div>
      {!collapsed && (
        <div className="sb-ws-sessions">
          {sessions.map((e) => (
            <button
              key={`${e.botId}:${e.convoId}`}
              className={`sb-session${activeMap[e.botId] === e.convoId ? ' active' : ''}`}
              onClick={() => onOpenSession(e)}
              title={e.title}
            >
              <span className="sb-session-title">
                {e.pinned ? '📌 ' : ''}
                {e.title}
              </span>
              <span className="sb-session-meta">
                <span className="sb-session-bot">{e.botName}</span>
                <span className="sb-session-time">{relativeTime(e.lastActivity, Date.now())}</span>
              </span>
            </button>
          ))}
          {sessions.length === 0 && <p className="sb-empty">No sessions in this workspace.</p>}
        </div>
      )}
    </div>
  );
}

export default function AppSidebar() {
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  const { t } = useI18n();
  const dests = getDests(t);
  const [open, setOpen] = useState(false);
  const [bots, setBots] = useState<BotConfig[]>([]);
  const [history, setHistory] = useState<SessionHistoryEntry[]>([]);
  const [activeMap, setActiveMap] = useState<Record<string, string>>({});
  const [universalOn, setUniversalOn] = useState(false);
  const [query, setQuery] = useState('');
  const [wsSel, setWsSel] = useState<string | null | undefined>(undefined); // undefined = All
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiBase, setApiBase] = useState('');
  const [mode, setMode] = useUxMode();
  const [themeChoice, setThemeChoice] = useTheme();
  const [themeOpen, setThemeOpen] = useState(false);
  const themeRef = useRef<HTMLDivElement>(null);
  // Whole-sidebar mode + section collapse (collapse pass, shared pattern).
  const [sbMode, setSbModeState] = useState<SbMode>('full');
  const lastVisibleMode = useRef<'full' | 'rail'>('full');
  const wsSection = useCollapsed('sb-workspaces');
  const sessSection = useCollapsed('sb-sessions');

  const setSbMode = useCallback((m: SbMode) => {
    setSbModeState(m);
    if (m !== 'hidden') lastVisibleMode.current = m;
    try {
      if (m === 'full') localStorage.removeItem(SB_MODE_KEY);
      else localStorage.setItem(SB_MODE_KEY, m);
    } catch { /* ignore */ }
  }, []);
  const botsRef = useRef<BotConfig[]>([]);
  botsRef.current = bots;

  const refreshHistory = useCallback(() => {
    const { convos, activeConvo } = readStoredConvos();
    setActiveMap(activeConvo);
    setHistory(buildSessionHistory(botsRef.current, convos, readLastBlockTs));
    try {
      setUniversalOn(localStorage.getItem('mvp:universalMode') !== '0');
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    setApiBase(getApiBase() || '(same origin)');
    try {
      const savedMode = localStorage.getItem(SB_MODE_KEY);
      if (savedMode === 'rail' || savedMode === 'hidden') {
        setSbModeState(savedMode);
        if (savedMode === 'rail') lastVisibleMode.current = 'rail';
      }
    } catch { /* ignore */ }
    try {
      const saved = localStorage.getItem('kriyadot:ws-filter');
      if (saved === WS_ALL) setWsSel(undefined);
      else if (saved) setWsSel(JSON.parse(saved) as string | null);
    } catch { /* ignore */ }
    void getBots()
      .then((list) => {
        setBots(list);
        botsRef.current = list;
        refreshHistory();
      })
      .catch(() => refreshHistory());
    refreshHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh when returning to the tab, when storage changes elsewhere, when
  // the chat page announces new/updated sessions, and on route changes.
  useEffect(() => {
    refreshHistory();
    setOpen(false);
  }, [pathname, refreshHistory]);
  useEffect(() => {
    const onFocus = () => refreshHistory();
    const onStorage = () => refreshHistory();
    const onChanged = () => refreshHistory();
    window.addEventListener('focus', onFocus);
    window.addEventListener('storage', onStorage);
    window.addEventListener('kriyadot:sessions-changed', onChanged);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('kriyadot:sessions-changed', onChanged);
    };
  }, [refreshHistory]);

  // Theme menu: close on outside click / Escape.
  useEffect(() => {
    if (!themeOpen) return;
    const onDown = (e: MouseEvent) => {
      if (themeRef.current && !themeRef.current.contains(e.target as Node)) setThemeOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setThemeOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [themeOpen]);

  const workspaces = useMemo(() => buildWorkspaceList(bots, history), [bots, history]);
  const visibleHistory = useMemo(
    () => searchHistory(filterHistoryByWorkspace(history, wsSel), query).slice(0, 40),
    [history, wsSel, query],
  );

  const pickWorkspace = (id: string | null | undefined) => {
    setWsSel(id);
    try {
      localStorage.setItem('kriyadot:ws-filter', id === undefined ? WS_ALL : JSON.stringify(id));
    } catch { /* ignore */ }
  };

  const goHome = useCallback(() => {
    if (pathname !== '/') router.push('/');
  }, [pathname, router]);

  const stash = (key: string, value: unknown) => {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch { /* ignore */ }
  };

  const openSession = (e: SessionHistoryEntry) => {
    const detail = { botId: e.botId, convoId: e.convoId };
    if (pathname === '/') {
      window.dispatchEvent(new CustomEvent('kriyadot:open-session', { detail }));
    } else {
      stash('kriyadot:pending-open', detail);
      goHome();
    }
    setOpen(false);
  };

  const openUniversal = () => {
    if (pathname === '/') {
      window.dispatchEvent(new CustomEvent('kriyadot:open-universal'));
    } else {
      stash('kriyadot:pending-universal', { ts: Date.now() });
      goHome();
    }
    setOpen(false);
  };

  const newChat = () => {
    if (pathname === '/') {
      window.dispatchEvent(new CustomEvent('kriyadot:new-session'));
    } else {
      stash('kriyadot:pending-new', { ts: Date.now() });
      goHome();
    }
    setOpen(false);
  };

  const activeTheme = THEMES.find((x) => x.id === themeChoice) ?? THEMES[0];
  const pickTheme = (c: ThemeChoice) => {
    setThemeChoice(c);
    setThemeOpen(false);
  };

  return (
    <>
      {/* Mobile top strip: brand + menu (sidebar becomes an overlay drawer) */}
      <div className="sb-topstrip">
        <button
          className="sb-burger"
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span />
          <span />
          <span />
        </button>
        <Link href="/" className="sb-topstrip-brand">
          <BrandPet />
          <span>KriyaDot</span>
        </Link>
      </div>
      {open && <button className="sb-scrim" aria-label="Close menu" onClick={() => setOpen(false)} />}

      {sbMode === 'hidden' && (
        <button
          className="sb-reopen"
          onClick={() => setSbMode(lastVisibleMode.current)}
          aria-label="Show sidebar"
          title="Show sidebar"
        >
          {icon(
            <>
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M9.5 4v16" />
            </>,
          )}
        </button>
      )}

      <aside
        className={`app-sidebar${open ? ' open' : ''}${sbMode === 'rail' ? ' kd-rail' : ''}${sbMode === 'hidden' ? ' kd-hidden' : ''}`}
        aria-label="Sidebar"
      >
        <div className="sb-brand">
          <Link href="/" className="sb-brand-link" onClick={() => setOpen(false)}>
            <BrandPet />
            <span className="sb-brand-name">KriyaDot</span>
          </Link>
          <span className="sb-brand-right">
            <span className="sb-mode-btns">
              <button
                className="sb-mode-btn"
                onClick={() => setSbMode('rail')}
                aria-label="Collapse sidebar to icons"
                title="Collapse sidebar to icons"
              >
                {icon(
                  <>
                    <path d="m11 6-6 6 6 6" />
                    <path d="M19 4v16" />
                  </>,
                )}
              </button>
              <button
                className="sb-mode-btn"
                onClick={() => setSbMode('hidden')}
                aria-label="Hide sidebar"
                title="Hide sidebar"
              >
                {eyeOffIcon}
              </button>
            </span>
            <button className="sb-close" aria-label="Close menu" onClick={() => setOpen(false)}>
              ✕
            </button>
          </span>
        </div>

        <button className="sb-new" onClick={newChat}>
          <span aria-hidden="true">＋</span> New Chat
        </button>

        <div className="sb-shortcuts">
          <Link href="/marketplace" className="sb-shortcut" onClick={() => setOpen(false)}>
            {icon(
              <>
                <path d="M9 3H4a1 1 0 0 0-1 1v5h6zM21 9h-6V4a1 1 0 0 0-1-1h-3v6zM15 21h5a1 1 0 0 0 1-1v-5h-6zM3 15v5a1 1 0 0 0 1 1h5v-6z" />
              </>,
            )}
            <span>Plugins</span>
          </Link>
          <Link href="/activity" className="sb-shortcut" onClick={() => setOpen(false)}>
            {icon(
              <>
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 3" />
              </>,
            )}
            <span>Automation</span>
          </Link>
        </div>

        <nav className="sb-nav" aria-label="Primary">
          {dests.map((d) => (
            <Link
              key={d.href}
              href={d.href}
              className={`sb-navlink${d.match(pathname) ? ' active' : ''}`}
              onClick={() => setOpen(false)}
            >
              <span className="sb-nav-icon">{d.icon}</span>
              <span>{d.label}</span>
            </Link>
          ))}
        </nav>

        <div className="sb-section-wrap">
          <button
            type="button"
            className="sb-section sb-section-toggle"
            aria-expanded={!wsSection.collapsed}
            onClick={wsSection.toggle}
          >
            <span>Workspaces</span>
            <CollapseChevron collapsed={wsSection.collapsed} />
          </button>
          <div className={`kd-collapsible${wsSection.collapsed ? ' closed' : ''}`}>
            <div className="kd-collapsible-inner">
              <div className="sb-workspaces" role="listbox" aria-label="Workspaces">
                <button
                  className={`sb-ws${wsSel === undefined ? ' active' : ''}`}
                  role="option"
                  aria-selected={wsSel === undefined}
                  onClick={() => pickWorkspace(undefined)}
                >
                  <span className="sb-ws-name">All workspaces</span>
                  <span className="sb-ws-count">{history.length}</span>
                </button>
                {workspaces.map((w) => (
                  <SidebarWorkspaceRow
                    key={w.id ?? '__default__'}
                    label={w.label}
                    id={w.id}
                    sessionCount={w.sessionCount}
                    active={wsSel !== undefined && wsSel === w.id}
                    sessions={searchHistory(filterHistoryByWorkspace(history, w.id), query).slice(0, 12)}
                    activeMap={pathname === '/' ? activeMap : {}}
                    onPick={() => pickWorkspace(w.id)}
                    onOpenSession={openSession}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="sb-section-wrap grow">
          <button
            type="button"
            className="sb-section sb-section-toggle"
            aria-expanded={!sessSection.collapsed}
            onClick={sessSection.toggle}
          >
            <span>Sessions</span>
            <CollapseChevron collapsed={sessSection.collapsed} />
          </button>
          <div className={`kd-collapsible sb-grow-wrap${sessSection.collapsed ? ' closed' : ''}`}>
            <div className="kd-collapsible-inner">
              <div className="sb-search">
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search sessions"
                  aria-label="Search sessions"
                />
              </div>
              <div className="sb-sessions">
          {universalOn && !query && (
            <button className="sb-session sb-session-universal" onClick={openUniversal}>
              <span className="sb-session-title">✦ Universal Chat</span>
              <span className="sb-session-meta">Ask anything — routed automatically</span>
            </button>
          )}
          {visibleHistory.map((e) => {
            const isActive = pathname === '/' && activeMap[e.botId] === e.convoId;
            return (
              <button
                key={`${e.botId}:${e.convoId}`}
                className={`sb-session${isActive ? ' active' : ''}`}
                onClick={() => openSession(e)}
                title={e.title}
              >
                <span className="sb-session-title">
                  {e.pinned ? '📌 ' : ''}
                  {e.title}
                </span>
                <span className="sb-session-meta">
                  <span className="sb-session-bot">{e.botName}</span>
                  <span className="sb-session-time">{relativeTime(e.lastActivity, Date.now())}</span>
                </span>
              </button>
            );
          })}
          {visibleHistory.length === 0 && !universalOn && (
            <p className="sb-empty">No sessions yet — start a new chat.</p>
          )}
          {visibleHistory.length === 0 && universalOn && (
            <p className="sb-empty">No saved sessions in this view.</p>
          )}
              </div>
            </div>
          </div>
        </div>

        <div className="sb-footer">
          <PauseControl />
          <div className="sb-footer-row">
            <div className="theme-wrap sb-theme" ref={themeRef}>
              <button
                className="theme-btn"
                aria-label={`Theme: ${activeTheme.label}. Change theme`}
                aria-expanded={themeOpen}
                onClick={() => setThemeOpen((v) => !v)}
                title="Change theme"
              >
                <span
                  className="swatch-dot"
                  style={{
                    background: `linear-gradient(135deg, ${activeTheme.swatch[0]} 50%, ${activeTheme.swatch[1]} 50%)`,
                  }}
                  aria-hidden="true"
                />
                {activeTheme.label}
              </button>
              {themeOpen && (
                <div className="theme-menu sb-theme-menu" role="menu" aria-label="Theme">
                  {THEMES.map((x) => (
                    <button
                      key={x.id}
                      className={`theme-opt${x.id === themeChoice ? ' active' : ''}`}
                      role="menuitemradio"
                      aria-checked={x.id === themeChoice}
                      onClick={() => pickTheme(x.id)}
                    >
                      <span className="swatches" aria-hidden="true">
                        <span className="swatch-dot" style={{ background: x.swatch[0] }} />
                        <span className="swatch-dot" style={{ background: x.swatch[1] }} />
                      </span>
                      <span className="tmeta">
                        <span className="tname">{x.label}</span>
                        <br />
                        <span className="thint">{x.hint}</span>
                      </span>
                      {x.id === themeChoice && (
                        <span className="tcheck" aria-hidden="true">
                          ✓
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="mode-toggle sb-mode" role="group" aria-label="Interface mode">
              <button
                className={`mode-opt${mode === 'simple' ? ' active' : ''}`}
                onClick={() => setMode('simple' as UxMode)}
                aria-pressed={mode === 'simple'}
              >
                Simple
              </button>
              <button
                className={`mode-opt${mode === 'pro' ? ' active' : ''}`}
                onClick={() => setMode('pro' as UxMode)}
                aria-pressed={mode === 'pro'}
              >
                Pro
              </button>
            </div>
          </div>
          <button
            className="sb-settings-toggle"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((v) => !v)}
          >
            <span>Settings &amp; more</span>
            <span aria-hidden="true">{settingsOpen ? '▾' : '▸'}</span>
          </button>
          {settingsOpen && (
            <div className="sb-settings">
              {SETTINGS_LINKS.map((s) => (
                <Link key={s.href} href={s.href} className="sb-settings-link" onClick={() => setOpen(false)}>
                  {s.label}
                  {s.href === '/preferences' && <UpdateBadge />}
                </Link>
              ))}
              <div className="sb-settings-sep" />
              {MORE_LINKS.map((s) => (
                <Link key={s.href} href={s.href} className="sb-settings-link" onClick={() => setOpen(false)}>
                  {s.label}
                </Link>
              ))}
              <div className="sb-settings-sep" />
              <div className="sb-lang">
                <LanguageSwitcher />
              </div>
            </div>
          )}
          <Link href="/accounts" className="sb-account" onClick={() => setOpen(false)}>
            <span className="sb-account-dot" aria-hidden="true">
              ◎
            </span>
            <span className="sb-account-meta">
              <span className="sb-account-name">Account</span>
              <span className="sb-account-sub">api: {apiBase}</span>
            </span>
          </Link>
          {/* Rail mode: the only footer content left visible — expand back
              to full, or hide the sidebar entirely (collapse pass). */}
          <div className="sb-rail-actions">
            <button
              className="sb-mode-btn"
              onClick={() => setSbMode('full')}
              aria-label="Expand sidebar"
              title="Expand sidebar"
            >
              {icon(
                <>
                  <path d="m6 6 6 6-6 6" />
                  <path d="m13 6 6 6-6 6" />
                </>,
              )}
            </button>
            <button
              className="sb-mode-btn"
              onClick={() => setSbMode('hidden')}
              aria-label="Hide sidebar"
              title="Hide sidebar"
            >
              {eyeOffIcon}
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
