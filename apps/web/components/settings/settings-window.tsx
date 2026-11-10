// SPDX-License-Identifier: Apache-2.0
'use client';

// Settings window (2026-11-10): Settings used to live only as an
// expanding link list in the sidebar — every settings surface forced a
// full page navigation away from chat. Now the sidebar Settings button
// (and the account footer) opens this modal window over the current
// page: the page/chat state behind it is untouched, Esc / backdrop /
// the ✕ button close it, and the standalone settings routes
// (/accounts, /providers, …) keep working for deep links.
//
// The window hosts the EXISTING settings page components (lazy-loaded,
// not forked): the same default exports the routes render, so anything
// fixed on a settings page is fixed here too.

import Link from 'next/link';
import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { UpdateBadge } from '../update-badge';

export interface SettingsSection {
  href: string;
  label: string;
  hint: string;
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  { href: '/accounts', label: 'Connected Apps', hint: 'Notion, Gmail, Slack & 1,000+ apps · vault · saved logins' },
  { href: '/providers', label: 'Providers & models', hint: 'API keys plus Claude Code, Codex & OpenCode CLI logins' },
  { href: '/messaging', label: 'Messaging', hint: 'WhatsApp, Telegram, Slack & Discord channels' },
  { href: '/usage', label: 'Usage & costs', hint: 'Tokens, spend and budgets' },
  { href: '/permissions', label: 'Permissions', hint: 'What bots may do without asking first' },
  { href: '/preferences', label: 'Preferences', hint: 'Companion, accent, privacy, local models, updates' },
  { href: '/more', label: 'Modules hub', hint: 'Feed, Goals, Research, Knowledge Base & the User Guide' },
];

export const SETTINGS_EVENT = 'kriyadot:open-settings';

/** Open the Settings window from anywhere (sidebar, guide, chat cards…). */
export function openSettings(section?: string) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: { section } }));
}

const PANELS: Record<string, React.LazyExoticComponent<React.ComponentType>> = {
  '/accounts': lazy(() => import('../../app/accounts/page')),
  '/providers': lazy(() => import('../../app/providers/page')),
  '/messaging': lazy(() => import('../../app/messaging/page')),
  '/usage': lazy(() => import('../../app/usage/page')),
  '/permissions': lazy(() => import('../../app/permissions/page')),
  '/preferences': lazy(() => import('../../app/preferences/page')),
  '/more': lazy(() => import('../../app/more/page')),
};

const MORE_DESTINATIONS = [
  { href: '/knowledge', label: 'Knowledge' },
  { href: '/pages', label: 'Pages' },
  { href: '/terminal', label: 'Terminal' },
  { href: '/teams', label: 'Teams' },
  { href: '/more/guide', label: 'User Guide' },
];

export default function SettingsWindowHost() {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<string>('/accounts');

  const show = useCallback((next?: string) => {
    if (next && PANELS[next]) setSection(next);
    setOpen(true);
  }, []);

  useEffect(() => {
    const onEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ section?: string }>).detail;
      show(detail?.section);
    };
    window.addEventListener(SETTINGS_EVENT, onEvent);
    return () => window.removeEventListener(SETTINGS_EVENT, onEvent);
  }, [show]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open ]);

  if (!open) return null;
  const Panel = PANELS[section] ?? PANELS['/accounts'];
  const active = SETTINGS_SECTIONS.find((s) => s.href === section) ?? SETTINGS_SECTIONS[0];

  return (
    <div
      className="modal-overlay settings-window-overlay"
      onClick={() => setOpen(false)}
      data-testid="settings-window-overlay"
    >
      <div
        className="modal-card settings-window"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-window-head">
          <div>
            <strong className="settings-window-title">Settings</strong>
            <span className="small muted settings-window-active">
              {active.label} — {active.hint}
            </span>
          </div>
          <div className="settings-window-head-actions">
            <Link
              className="btn btn-sm"
              href={section}
              onClick={() => setOpen(false)}
              title="Open this section as a full page"
            >
              Full page ↗
            </Link>
            <button
              type="button"
              className="icon-btn"
              aria-label="Close settings"
              autoFocus
              onClick={() => setOpen(false)}
            >
              ✕
            </button>
          </div>
        </div>
        <div className="settings-window-body">
          <nav className="settings-window-nav" aria-label="Settings sections">
            {SETTINGS_SECTIONS.map((s) => (
              <button
                key={s.href}
                type="button"
                className={`settings-window-navlink${s.href === section ? ' active' : ''}`}
                aria-current={s.href === section ? 'true' : undefined}
                onClick={() => setSection(s.href)}
              >
                <span className="settings-window-navlabel">
                  {s.label}
                  {s.href === '/preferences' && <UpdateBadge />}
                </span>
                <span className="settings-window-navhint">{s.hint}</span>
              </button>
            ))}
            <div className="settings-window-navsep" />
            <p className="small muted settings-window-navnote">
              More destinations — these open as full pages:
            </p>
            {MORE_DESTINATIONS.map((d) => (
              <Link
                key={d.href}
                href={d.href}
                className="settings-window-navlink as-link"
                onClick={() => setOpen(false)}
              >
                <span className="settings-window-navlabel">{d.label} ↗</span>
              </Link>
            ))}
          </nav>
          <div className="settings-window-content" data-testid="settings-window-content">
            <Suspense
              fallback={<p className="small muted">Loading {active.label}…</p>}
            >
              <Panel key={section} />
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  );
}
