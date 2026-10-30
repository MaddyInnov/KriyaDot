// SPDX-License-Identifier: Apache-2.0
// CA-27 + CA-35: desktop bridge for the web shell.
//
// CA-27 (quick entry): parses `kriyadot://` deep links delivered by the
// Tauri deep-link plugin —
//   kriyadot://chat/<chatId>            → open a chat
//   kriyadot://quick                    → open the companion/quick-entry window route
//   kriyadot://repo/<url-encoded path>?prompt=<url-encoded text>
//                                       → open a repo workspace with a prefilled prompt
// and maps them to web routes. Pure parsing lives here so it is unit
// tested without Tauri.
//
// CA-35 (dictation): the desktop shell (apps/desktop/src-tauri/src/
// dictation.rs) emits `dictation://press` / `dictation://release` and
// `push-to-talk` events from the global hotkey. This module subscribes
// through the Tauri event API when present (window.__TAURI__), and
// drives an injected recognizer — in production the existing
// VoiceControls Web Speech / /api/voice/stt stack; in tests a fake.
// On a final transcript inside the desktop app it calls the Tauri
// `dictation_insert_text` command (OS-level insertion); on the web it
// hands the text to the composer callback.

'use client';

export type KriyaDotDeepLink =
  | { kind: 'chat'; chatId: string }
  | { kind: 'quick' }
  | { kind: 'repo'; repo: string; prompt?: string }
  | { kind: 'unknown'; raw: string };

/** Parse a kriyadot:// deep link. Returns 'unknown' (never throws) for anything else. */
export function parseKriyaDotDeepLink(raw: string): KriyaDotDeepLink {
  if (typeof raw !== 'string' || !raw.startsWith('kriyadot://')) return { kind: 'unknown', raw: String(raw ?? '') };
  try {
    const url = new URL(raw);
    const host = url.hostname;
    const segments = url.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
    if (host === 'chat' && segments[0]) return { kind: 'chat', chatId: segments[0] };
    if (host === 'quick') return { kind: 'quick' };
    if (host === 'repo') {
      const repo = segments.join('/');
      if (!repo) return { kind: 'unknown', raw };
      const prompt = url.searchParams.get('prompt') ?? undefined;
      return { kind: 'repo', repo, ...(prompt ? { prompt } : {}) };
    }
    return { kind: 'unknown', raw };
  } catch {
    return { kind: 'unknown', raw };
  }
}

/** Map a parsed deep link to the web route the shell should navigate to. */
export function deepLinkToRoute(link: KriyaDotDeepLink): string | null {
  switch (link.kind) {
    case 'chat': return `/chat/${encodeURIComponent(link.chatId)}`;
    case 'quick': return '/quick';
    case 'repo': return `/workspace?repo=${encodeURIComponent(link.repo)}${link.prompt ? `&prompt=${encodeURIComponent(link.prompt)}` : ''}`;
    default: return null;
  }
}

export interface TauriEventLike {
  listen: (event: string, handler: (e: { payload?: unknown }) => void) => Promise<() => void>;
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

/** Resolve the Tauri event/invoke surface from a window-like object; null on the plain web. */
export function tauriSurface(win: unknown): TauriEventLike | null {
  const w = win as { __TAURI__?: { event?: { listen: TauriEventLike['listen'] }; core?: { invoke: NonNullable<TauriEventLike['invoke']> }; invoke?: NonNullable<TauriEventLike['invoke']> } };
  const t = w?.__TAURI__;
  if (!t?.event?.listen) return null;
  return { listen: t.event.listen, invoke: t.core?.invoke ?? t.invoke };
}

export interface DesktopDictationDeps {
  surface: TauriEventLike | null;
  /** Start/stop the recognizer (Web Speech / STT stack lives behind this seam). */
  recognizer: { start(onFinal: (text: string) => void): void; stop(): void };
  /** Web fallback: insert the transcript into the focused composer. */
  onComposerText: (text: string) => void;
}

/**
 * Wire desktop PTT events to the recognizer. Returns an unsubscribe
 * function. On the plain web (no Tauri surface) this is a no-op —
 * in-page voice controls remain the dictation path there.
 */
export async function wireDesktopDictation(deps: DesktopDictationDeps): Promise<() => void> {
  if (!deps.surface) return () => {};
  const unsubs: Array<() => void> = [];
  const onPress = () => {
    deps.recognizer.start(async (text) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (deps.surface?.invoke) {
        // Desktop: the shell types the transcript into the focused app.
        try { await deps.surface.invoke('dictation_insert_text', { text: trimmed }); return; } catch { /* fall through to composer */ }
      }
      deps.onComposerText(trimmed);
    });
  };
  const onRelease = () => deps.recognizer.stop();
  for (const name of ['dictation://press', 'push-to-talk']) {
    unsubs.push(await deps.surface.listen(name, onPress));
  }
  unsubs.push(await deps.surface.listen('dictation://release', onRelease));
  return () => unsubs.forEach((u) => { try { u(); } catch { /* noop */ } });
}

/** Subscribe to deep links delivered by the Tauri deep-link plugin. */
export async function wireDeepLinks(
  surface: TauriEventLike | null,
  navigate: (route: string, link: KriyaDotDeepLink) => void,
): Promise<() => void> {
  if (!surface) return () => {};
  const un = await surface.listen('deep-link://new-url', (e) => {
    const payload = e.payload as { urls?: string[] } | string[] | undefined;
    const urls = Array.isArray(payload) ? payload : payload?.urls ?? [];
    for (const raw of urls) {
      const link = parseKriyaDotDeepLink(String(raw));
      const route = deepLinkToRoute(link);
      if (route) navigate(route, link);
    }
  });
  return un;
}
