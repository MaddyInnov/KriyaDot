// SPDX-License-Identifier: Apache-2.0
// Tauri bridge for the /overlay route: every call is defensive — on the
// plain web (no window.__TAURI__) these are no-ops, because a browser
// cannot move/hide a native window. The Rust side lives in
// apps/desktop/src-tauri/src/pet_overlay.rs.

'use client';

interface TauriWindowHandle {
  startDragging?: () => Promise<void>;
  outerPosition?: () => Promise<{ x: number; y: number }>;
  show?: () => Promise<void>;
  hide?: () => Promise<void>;
  onMoved?: (handler: (e: { payload: { x: number; y: number } }) => void) => Promise<() => void>;
}

interface TauriGlobal {
  core?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  window?: { getCurrentWindow: () => TauriWindowHandle };
}

function tauri(): TauriGlobal | null {
  if (typeof window === 'undefined') return null;
  const t = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  return t ?? null;
}

export function isDesktopOverlay(): boolean {
  return tauri() !== null;
}

async function invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const t = tauri();
  const fn = t?.core?.invoke ?? t?.invoke;
  if (!fn) return undefined;
  try {
    return await fn(cmd, args);
  } catch {
    return undefined; // bridge failures must never break the pet
  }
}

function currentWindow(): TauriWindowHandle | null {
  try {
    return tauri()?.window?.getCurrentWindow() ?? null;
  } catch {
    return null;
  }
}

/** Persist + apply the overlay enabled mirror on the Rust side. */
export async function setOverlayEnabled(enabled: boolean): Promise<void> {
  await invoke('pet_overlay_set_enabled', { enabled });
}

/** Ask the shell to raise the main window. */
export async function focusMainWindow(): Promise<void> {
  await invoke('pet_overlay_focus_main');
}

/** Begin a native window drag (follows the pointer until release). */
export async function startWindowDrag(): Promise<void> {
  const win = currentWindow();
  if (win?.startDragging) {
    try {
      await win.startDragging();
    } catch {
      /* not in Tauri / permission missing — drag is best-effort */
    }
  }
}

/** Persist the current window position (Rust app-data JSON). */
export async function saveWindowPosition(): Promise<void> {
  const win = currentWindow();
  if (!win?.outerPosition) return;
  try {
    const pos = await win.outerPosition();
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      await invoke('pet_overlay_save_position', { x: pos.x, y: pos.y });
    }
  } catch {
    /* best-effort */
  }
}

/** Subscribe to native window moves; returns an unsubscribe function. */
export async function onWindowMoved(handler: () => void): Promise<() => void> {
  const win = currentWindow();
  if (!win?.onMoved) return () => {};
  try {
    return await win.onMoved(() => handler());
  } catch {
    return () => {};
  }
}
