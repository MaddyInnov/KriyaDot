// SPDX-License-Identifier: Apache-2.0
// Lightweight i18n for the KriyaDot web console.
//
// Static-export compatible: pure React context + localStorage, no
// next-intl server features, no async locale loading, no middleware. Works
// identically in `next dev`, `next build` (static export), and the Tauri
// desktop shell.
//
// Usage:
//   import { I18nProvider, useI18n, LanguageSwitcher } from '../lib/i18n';
//
//   // Near the root of a page (global mount point: app/layout.tsx around
//   // {children} — see docs/I18N.md):
//   <I18nProvider><MyPage /></I18nProvider>
//
//   // Inside any component under the provider:
//   const { t, locale, setLocale } = useI18n();
//   <h1>{t('bots.title')}</h1>
//
// Without a provider, useI18n() falls back to English so components still
// render (and unit tests don't need a wrapper).

'use client';

import React from 'react';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { en, fill, hi, it, ja, pl, ptBR, ru, type Strings } from './locales';

export type LocaleId = 'en' | 'hi' | 'ru' | 'it' | 'pl' | 'ja' | 'pt-BR';

export interface LocaleDef {
  id: LocaleId;
  /** Label in the locale's own script. */
  label: string;
  /** Label in English (for recognisability). */
  englishLabel: string;
}

export const LOCALES: LocaleDef[] = [
  { id: 'en', label: 'English', englishLabel: 'English' },
  { id: 'hi', label: 'हिन्दी', englishLabel: 'Hindi' },
  { id: 'ru', label: 'Русский', englishLabel: 'Russian' },
  { id: 'it', label: 'Italiano', englishLabel: 'Italian' },
  { id: 'pl', label: 'Polski', englishLabel: 'Polish' },
  { id: 'ja', label: '日本語', englishLabel: 'Japanese' },
  { id: 'pt-BR', label: 'Português (Brasil)', englishLabel: 'Brazilian Portuguese' },
];

const STORAGE_KEY = 'mvp:locale';
const VALID: LocaleId[] = ['en', 'hi', 'ru', 'it', 'pl', 'ja', 'pt-BR'];
export const DEFAULT_LOCALE: LocaleId = 'en';

const DICTS: Record<LocaleId, Strings> = { en, hi, ru, it, pl, ja, 'pt-BR': ptBR };

export function getStoredLocale(): LocaleId {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return (VALID as string[]).includes(v ?? '') ? (v as LocaleId) : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function setStoredLocale(locale: LocaleId): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // ignore (private mode / quota)
  }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
  }
}

/** Resolve a dot-path key inside a string table; undefined when missing. */
function lookup(dict: Strings, key: string): string | undefined {
  let cur: unknown = dict;
  for (const part of key.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

export interface I18n {
  locale: LocaleId;
  setLocale: (l: LocaleId) => void;
  /** Translate `key` (dot path), falling back to English, then the key itself. */
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18n>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  t: (key, vars) => fill(lookup(en, key) ?? key, vars),
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<LocaleId>(DEFAULT_LOCALE);

  useEffect(() => {
    const stored = getStoredLocale();
    setLocaleState(stored);
    setStoredLocale(stored); // sync <html lang>
  }, []);

  const setLocale = useCallback((l: LocaleId) => {
    setStoredLocale(l);
    setLocaleState(l);
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const dict = DICTS[locale] ?? en;
      return fill(lookup(dict, key) ?? lookup(en, key) ?? key, vars);
    },
    [locale],
  );

  const value = useMemo<I18n>(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  return useContext(I18nContext);
}

/**
 * Language switcher: a compact <select> styled like the other top-bar
 * controls. Persists the choice to localStorage (`mvp:locale`).
 *
 * Mount points (not all wired yet — see docs/I18N.md):
 *  - Chat header (app/page.tsx) — wired
 *  - Bots chrome (app/bots/page.tsx) — wired
 *  - Global top bar next to ThemeSwitcher (app/nav.tsx) — reported, nav.tsx is locked
 */
export function LanguageSwitcher({ className = '' }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <label
      className={`lang-switch ${className}`}
      title={t('common.language')}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
    >
      <span aria-hidden="true">🌐</span>
      <select
        className="select"
        value={locale}
        onChange={(e) => setLocale(e.target.value as LocaleId)}
        aria-label={t('common.language')}
        style={{ width: 'auto' }}
      >
        {LOCALES.map((l) => (
          <option key={l.id} value={l.id}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  );
}
