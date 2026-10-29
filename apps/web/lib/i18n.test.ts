// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  de,
  en,
  es,
  fr,
  hi,
  it as itDict,
  ja,
  pl,
  ptBR,
  ru,
  tr,
  uk,
  vi,
  zh,
  zhTW,
  type Strings,
} from './locales';
import { getStoredLocale, setStoredLocale, useI18n, LanguageSwitcher, LOCALES } from './i18n';

/** Every shipped dictionary, keyed by its BCP-47 locale id (en + 14). */
const ALL_DICTS: Record<string, Strings> = {
  en,
  hi,
  ru,
  it: itDict,
  pl,
  ja,
  'pt-BR': ptBR,
  de,
  es,
  fr,
  tr,
  uk,
  vi,
  zh,
  'zh-TW': zhTW,
};
const ALL_LOCALE_IDS = Object.keys(ALL_DICTS).sort();

/** Recursively collect dot-path keys of a string table. */
function keysOf(obj: object, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') out.push(...keysOf(v, path));
    else out.push(path);
  }
  return out.sort();
}

/** Resolve a dot-path key inside a string table. */
function valueAt(dict: Strings, key: string): string {
  let cur: unknown = dict;
  for (const part of key.split('.')) cur = (cur as Record<string, unknown>)[part];
  return cur as string;
}

/** Sorted `{placeholder}` tokens of a template string. */
function tokensOf(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

describe('locale dictionaries', () => {
  it('ships exactly 15 locales: en plus 14 translations', () => {
    expect(ALL_LOCALE_IDS).toEqual(
      [
        'de',
        'en',
        'es',
        'fr',
        'hi',
        'it',
        'ja',
        'pl',
        'pt-BR',
        'ru',
        'tr',
        'uk',
        'vi',
        'zh',
        'zh-TW',
      ].sort(),
    );
    expect(Object.keys(ALL_DICTS).sort()).toEqual(ALL_LOCALE_IDS);
  });

  // NOTE (§1.15 locales workstream): the eight new dictionaries land in
  // lib/locales.ts first; lib/i18n.tsx (LocaleId / LOCALES / DICTS / VALID)
  // is wired by its owning workstream. Until then every runtime-wired
  // locale must still resolve to a shipped dictionary — never the reverse.
  it('every locale wired in i18n.tsx resolves to a shipped dictionary', () => {
    for (const l of LOCALES) {
      expect(ALL_DICTS[l.id], `LOCALES entry ${l.id}`).toBeDefined();
    }
  });

  it('switcher lists every locale under its native language name', () => {
    const byId = new Map(LOCALES.map((l) => [l.id, l.label]));
    expect(byId.get('ru')).toBe('Русский');
    expect(byId.get('it')).toBe('Italiano');
    expect(byId.get('pl')).toBe('Polski');
    expect(byId.get('ja')).toBe('日本語');
    expect(byId.get('pt-BR')).toBe('Português (Brasil)');
  });

  // KEY PARITY: every locale must carry exactly the en key set — deep
  // comparison across the whole catalog (all sections/namespaces).
  it('every locale has exactly the same key set as en (source of truth)', () => {
    const enKeys = keysOf(en);
    expect(enKeys.length).toBeGreaterThan(0);
    for (const [id, dict] of Object.entries(ALL_DICTS)) {
      expect(keysOf(dict), `locale ${id}`).toEqual(enKeys);
    }
  });

  // PLACEHOLDER PARITY: the {tokens} of every translated string must match
  // the en source for that key — a dropped/renamed token breaks fill().
  it('placeholder tokens of every locale match the en source per key', () => {
    for (const key of keysOf(en)) {
      const enTokens = tokensOf(valueAt(en, key));
      for (const [id, dict] of Object.entries(ALL_DICTS)) {
        expect(tokensOf(valueAt(dict, key)), `${id}:${key}`).toEqual(enTokens);
      }
    }
  });

  it('every value in every locale is a non-empty string', () => {
    for (const [id, dict] of Object.entries(ALL_DICTS)) {
      for (const key of keysOf(dict)) {
        const cur = valueAt(dict, key);
        expect(typeof cur, `${id}:${key}`).toBe('string');
        expect(cur.length, `${id}:${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('identifier-like values stay verbatim in every locale', () => {
    // Placeholder-only format strings are copied, never translated.
    for (const dict of Object.values(ALL_DICTS)) {
      expect(dict.voice.duration).toBe('{duration}');
      expect(dict.call.turnAt).toBe('{time}');
      // The vault secret name is an identifier embedded in prose.
      expect(dict.bots.voiceSubtitle).toContain('voice_<id>_api_key');
      // Example voice ids in the hint are identifiers, not prose.
      expect(dict.bots.voiceTtsVoiceHint).toContain('alloy');
      expect(dict.bots.voiceTtsVoiceHint).toContain('Fritz-PlayAI');
    }
  });

  it('translation smoke checks per new locale', () => {
    expect(ru.nav.chat).toBe('Чат');
    expect(ru.common.cancel).toBe('Отмена');
    expect(itDict.common.cancel).toBe('Annulla');
    expect(itDict.chat.send).toBe('Invia');
    expect(pl.common.close).toBe('Zamknij');
    expect(pl.chat.send).toBe('Wyślij');
    expect(ja.bots.title).toBe('ボット');
    expect(ja.common.language).toBe('言語');
    expect(ptBR.chat.send).toBe('Enviar');
    expect(ptBR.nav.activity).toBe('Atividade');
  });

  it('translation smoke checks per §1.15 locale', () => {
    expect(de.common.language).toBe('Sprache');
    expect(de.chat.send).toBe('Senden');
    expect(es.common.cancel).toBe('Cancelar');
    expect(es.chat.send).toBe('Enviar');
    expect(fr.common.close).toBe('Fermer');
    expect(fr.chat.send).toBe('Envoyer');
    expect(tr.common.language).toBe('Dil');
    expect(tr.chat.send).toBe('Gönder');
    expect(uk.common.cancel).toBe('Скасувати');
    expect(uk.nav.chat).toBe('Чат');
    expect(vi.common.language).toBe('Ngôn ngữ');
    expect(vi.chat.send).toBe('Gửi');
    expect(zh.common.language).toBe('语言');
    expect(zh.chat.send).toBe('发送');
    expect(zhTW.common.language).toBe('語言');
    expect(zhTW.chat.send).toBe('傳送');
  });

  it('covers the six top-level destination labels', () => {
    const nav = (en as Strings).nav;
    expect(Object.keys(nav).sort()).toEqual(
      ['activity', 'bots', 'chat', 'marketplace', 'workflows', 'workspace'],
    );
  });
});

// SOURCE-HASH CHECK (audit §1.15): lib/locales.source-hash.json pins a
// SHA-256 of the canonical `en` source strings. If `en` changes without
// regenerating the manifest, this fails at release/test time so stale
// translations are caught instead of silently shipping. Regenerate with:
//   node scripts/gen-locales-hash.mjs   (from apps/web)
// The canonical form here must match that script exactly.
describe('en source-hash manifest (§1.15)', () => {
  interface SourceHashManifest {
    regenerate: string;
    algorithm: string;
    locale: string;
    keyCount: number;
    sourceHash: string;
  }

  function readManifest(): SourceHashManifest {
    const raw = readFileSync(new URL('./locales.source-hash.json', import.meta.url), 'utf8');
    return JSON.parse(raw) as SourceHashManifest;
  }

  /** Same canonical pairs as scripts/gen-locales-hash.mjs. */
  function canonicalPairsOf(dict: Strings): Array<[string, string]> {
    const pairs: Array<[string, string]> = [];
    const walk = (obj: object, prefix: string) => {
      for (const [k, v] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${k}` : k;
        if (v !== null && typeof v === 'object') walk(v, path);
        else pairs.push([path, v as string]);
      }
    };
    walk(dict, '');
    return pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  it('pins the current en source hash and key count', () => {
    const manifest = readManifest();
    const pairs = canonicalPairsOf(en);
    const digest = createHash('sha256').update(JSON.stringify(pairs), 'utf8').digest('hex');
    expect(manifest.algorithm).toBe('sha256');
    expect(manifest.locale).toBe('en');
    expect(manifest.keyCount).toBe(pairs.length);
    expect(manifest.keyCount).toBe(keysOf(en).length);
    expect(manifest.sourceHash).toBe(digest);
  });

  it('documents the regeneration command', () => {
    expect(readManifest().regenerate).toContain('scripts/gen-locales-hash.mjs');
  });
});

function Probe({ k, vars }: { k: string; vars?: Record<string, string | number> }) {
  const { t } = useI18n();
  return React.createElement('span', null, t(k, vars));
}

describe('useI18n without a provider (English fallback)', () => {
  it('translates a known key', () => {
    expect(renderToStaticMarkup(React.createElement(Probe, { k: 'chat.send' }))).toContain('Send');
  });

  it('interpolates {vars}', () => {
    const html = renderToStaticMarkup(
      React.createElement(Probe, { k: 'chat.composerPlaceholder', vars: { bot: 'Aria' } }),
    );
    expect(html).toContain('Aria');
    expect(html).not.toContain('{bot}');
  });

  it('falls back to the key itself for unknown keys', () => {
    expect(renderToStaticMarkup(React.createElement(Probe, { k: 'nope.missing' }))).toContain(
      'nope.missing',
    );
  });
});

describe('locale persistence', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });

  it('defaults to en and round-trips hi and the W11 locales', () => {
    expect(getStoredLocale()).toBe('en');
    setStoredLocale('hi');
    expect(getStoredLocale()).toBe('hi');
    for (const id of ['ru', 'it', 'pl', 'ja', 'pt-BR'] as const) {
      setStoredLocale(id);
      expect(getStoredLocale()).toBe(id);
    }
  });

  it('rejects unknown stored values', () => {
    (globalThis as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem(
      'mvp:locale',
      'xx',
    );
    expect(getStoredLocale()).toBe('en');
  });
});

describe('LanguageSwitcher', () => {
  it('renders every locale option with native labels', () => {
    const html = renderToStaticMarkup(React.createElement(LanguageSwitcher));
    // The switcher renders the locales wired in i18n.tsx (LOCALES); the
    // §1.15 dictionaries join this list once i18n.tsx is wired for them.
    for (const id of LOCALES.map((l) => l.id)) {
      expect(html, id).toContain(`value="${id}"`);
    }
    expect(html).toContain('हिन्दी');
    expect(html).toContain('Русский');
    expect(html).toContain('Italiano');
    expect(html).toContain('Polski');
    expect(html).toContain('日本語');
    expect(html).toContain('Português (Brasil)');
    expect(html).toContain('aria-label="Language"');
  });
});
