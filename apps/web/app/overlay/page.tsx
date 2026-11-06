// SPDX-License-Identifier: Apache-2.0
'use client';

// Avatar Presence (Worker 4): the floating desktop pet overlay page.
//
// Loaded ONLY by the Tauri `pet-overlay` window
// (apps/desktop/src-tauri/src/pet_overlay.rs) — a 128×128 frameless,
// transparent, always-on-top, non-focusable window. The page:
//   - renders ONLY the user's selected pet (~112px) on transparency
//     (the `pet-overlay-mode` class on <html>/<body> strips the app
//     shell chrome via overlay.css — the root layout still mounts it);
//   - polls GET /api/pet-state every ~1.5s for its mood. Polling a tiny
//     local endpoint was chosen over SSE: there is no existing
//     aggregate SSE stream for agent state (chat/workflow streams are
//     per-run), and a 1.5s poll of a read-only aggregate is cheap and
//     keeps working while the main window is hidden because this
//     window talks to the API directly, never to the main window;
//   - drags the native window (pointer travel past a threshold starts
//     a Tauri native drag), treats a clean press as a click that
//     raises the main window, and opens a minimal menu on right-click
//     or long-press: "Open KriyaDot" / "Hide overlay";
//   - honours PetSettings.overlay: when it flips off (in either
//     window — localStorage is shared across this app's Tauri
//     webviews, and a 2s re-read backstops the storage event) it
//     renders nothing and asks the Rust side to hide the window AND
//     persist the disabled mirror, so the next launch agrees. While
//     hidden the webview stays alive, keeps watching the setting, and
//     asks Rust to re-show the window when it flips back on.
//
// Web fallback: in a plain browser this route just shows the pet in a
// normal tab. Browsers cannot overlay other apps, and Document
// Picture-in-Picture would have to be launched from a user gesture in
// the main window (app/page.tsx — another worker's file), so PiP is
// intentionally NOT implemented here; the boundary is recorded in the
// Worker 4 report.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pet } from '../../components/pet/Pet';
import { authedFetch } from '../../lib/api';
import { getPetSettings, usePet, usePetSettings, type PetMood } from '../../lib/pet';
import {
  focusMainWindow,
  onWindowMoved,
  saveWindowPosition,
  setOverlayEnabled,
  startWindowDrag,
} from './overlay-bridge';
import {
  classifyPress,
  gateMood,
  LONG_PRESS_MS,
  moodFromPayload,
  PET_STATE_POLL_MS,
  SETTINGS_RECHECK_MS,
} from './overlay-state';
import './overlay.css';

const PET_SIZE = 112;

export default function OverlayPage() {
  const { choice } = usePet();
  const { settings, setSetting } = usePetSettings();
  const [serverMood, setServerMood] = useState<PetMood>('idle');
  const [menuOpen, setMenuOpen] = useState(false);
  // Local mirror of the enabled flag, re-read on an interval as a
  // fallback for storage events that some webview stacks drop.
  const [overlayOn, setOverlayOn] = useState(settings.overlay);
  const pressRef = useRef<{ x: number; y: number; at: number; dragStarted: boolean } | null>(null);
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastEnabledSyncRef = useRef<boolean | null>(null);

  // Strip the app shell + make the window transparent.
  useEffect(() => {
    document.documentElement.classList.add('pet-overlay-mode');
    document.body.classList.add('pet-overlay-mode');
    return () => {
      document.documentElement.classList.remove('pet-overlay-mode');
      document.body.classList.remove('pet-overlay-mode');
    };
  }, []);

  // Mood polling: direct to the API, independent of the main window.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await authedFetch('/api/pet-state');
        if (!res.ok) return;
        const mood = moodFromPayload(await res.json().catch(() => null));
        if (!cancelled && mood) setServerMood(mood);
      } catch {
        // API unreachable (e.g. sidecar restarting): keep the last mood.
      }
    };
    void tick();
    const id = setInterval(() => void tick(), PET_STATE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Settings re-read backstop (cross-window storage events are the
  // primary channel; usePetSettings already subscribes to them).
  useEffect(() => {
    setOverlayOn(settings.overlay);
  }, [settings.overlay]);
  useEffect(() => {
    const id = setInterval(() => setOverlayOn(getPetSettings().overlay), SETTINGS_RECHECK_MS);
    return () => clearInterval(id);
  }, []);

  // Sync the enabled flag to the Rust mirror + window visibility.
  useEffect(() => {
    if (lastEnabledSyncRef.current === overlayOn) return;
    lastEnabledSyncRef.current = overlayOn;
    void setOverlayEnabled(overlayOn);
  }, [overlayOn]);

  // Persist the window position whenever the native window moves.
  useEffect(() => {
    let unsub: (() => void) | undefined;
    let live = true;
    void onWindowMoved(() => void saveWindowPosition()).then((u) => {
      if (live) unsub = u;
      else u();
    });
    return () => {
      live = false;
      unsub?.();
    };
  }, []);

  const clearLongPress = useCallback(() => {
    if (longPressRef.current) {
      clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 2) return; // right button → contextmenu handler
    pressRef.current = { x: e.clientX, y: e.clientY, at: Date.now(), dragStarted: false };
    clearLongPress();
    longPressRef.current = setTimeout(() => {
      pressRef.current = null;
      setMenuOpen(true);
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const press = pressRef.current;
    if (!press || press.dragStarted) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) {
      clearLongPress();
      press.dragStarted = true;
      void startWindowDrag();
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    clearLongPress();
    const press = pressRef.current;
    pressRef.current = null;
    if (!press) return;
    const outcome = classifyPress({
      dx: e.clientX - press.x,
      dy: e.clientY - press.y,
      durationMs: Date.now() - press.at,
      dragStarted: press.dragStarted,
    });
    if (outcome === 'drag') {
      void saveWindowPosition();
      return;
    }
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    void focusMainWindow();
  };

  const hideOverlay = () => {
    setMenuOpen(false);
    // Flip the setting off so Preferences, this page and the Rust
    // mirror all agree; the sync effect above hides the window.
    setSetting('overlay', false);
    setOverlayOn(false);
    void setOverlayEnabled(false);
  };

  if (!overlayOn) return null;

  const mood = gateMood(serverMood, settings);

  return (
    <div
      className="pet-overlay-root"
      role="presentation"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={clearLongPress}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
    >
      <Pet pet={choice.id} size={PET_SIZE} mood={mood} variant="auto" interactive={false} />
      {menuOpen ? (
        <div className="pet-overlay-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              void focusMainWindow();
            }}
          >
            Open KriyaDot
          </button>
          <button type="button" role="menuitem" onClick={hideOverlay}>
            Hide overlay
          </button>
        </div>
      ) : null}
    </div>
  );
}
