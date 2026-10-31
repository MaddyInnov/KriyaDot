// SPDX-License-Identifier: Apache-2.0
'use client';

// Shared collapse/expand + pane-size state (2026-10-31 collapse pass).
//
// One pattern for every section and divided window in the app (the main
// chat column is the only fixed element): a panel's collapsed flag lives
// in localStorage under `kriyadot:collapse:<panelId>` ('1' = collapsed,
// '0' = expanded) and a resizable pane's width under
// `kriyadot:size:<panelId>` (pixel count; absent = the CSS default).
// Collapse and size compose: collapsing never clears the stored width,
// so re-expanding restores the pane exactly as the user left it.
//
// State loads in an effect (house pattern — the first render uses the
// caller's default, then the persisted value applies), so server and
// first client render agree.

import { useCallback, useEffect, useState } from 'react';

export const COLLAPSE_KEY_PREFIX = 'kriyadot:collapse:';
export const SIZE_KEY_PREFIX = 'kriyadot:size:';

export function collapseStorageKey(panelId: string): string {
  return `${COLLAPSE_KEY_PREFIX}${panelId}`;
}

export function sizeStorageKey(panelId: string): string {
  return `${SIZE_KEY_PREFIX}${panelId}`;
}

export interface CollapsedState {
  collapsed: boolean;
  setCollapsed: (next: boolean) => void;
  toggle: () => void;
}

/** Persisted collapsed flag for one panel/section. */
export function useCollapsed(panelId: string, defaultCollapsed = false): CollapsedState {
  const [collapsed, setState] = useState<boolean>(defaultCollapsed);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(collapseStorageKey(panelId));
      if (raw !== null) setState(raw === '1');
    } catch { /* storage unavailable — stay at the default */ }
  }, [panelId]);

  const setCollapsed = useCallback(
    (next: boolean) => {
      setState(next);
      try {
        localStorage.setItem(collapseStorageKey(panelId), next ? '1' : '0');
      } catch { /* ignore */ }
    },
    [panelId],
  );

  const toggle = useCallback(() => {
    setState((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(collapseStorageKey(panelId), next ? '1' : '0');
      } catch { /* ignore */ }
      return next;
    });
  }, [panelId]);

  return { collapsed, setCollapsed, toggle };
}

export interface PaneSizeState {
  /** Stored width in px, or null when the user has never resized (CSS default applies). */
  width: number | null;
  /** Set an explicit width, or null to reset to the CSS default. Persists immediately. */
  setWidth: (px: number | null) => void;
  reset: () => void;
}

/** Persisted width for one resizable pane. */
export function usePaneSize(panelId: string): PaneSizeState {
  const [width, setState] = useState<number | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(sizeStorageKey(panelId));
      if (raw !== null) {
        const px = Number.parseInt(raw, 10);
        if (Number.isFinite(px) && px > 0) setState(px);
      }
    } catch { /* ignore */ }
  }, [panelId]);

  const setWidth = useCallback(
    (px: number | null) => {
      setState(px);
      try {
        if (px === null) localStorage.removeItem(sizeStorageKey(panelId));
        else localStorage.setItem(sizeStorageKey(panelId), String(Math.round(px)));
      } catch { /* ignore */ }
    },
    [panelId],
  );

  const reset = useCallback(() => setWidth(null), [setWidth]);

  return { width, setWidth, reset };
}
