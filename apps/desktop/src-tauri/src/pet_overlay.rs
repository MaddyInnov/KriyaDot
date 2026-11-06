// SPDX-License-Identifier: Apache-2.0
// Avatar Presence (Worker 4): floating desktop pet overlay window.
//
// *** SOURCE-LEVEL ONLY — UNVERIFIED ***
// Same status as quick_entry.rs / dictation.rs: there is NO cargo/Rust
// toolchain on the build VM, so this file has never been compiled. It is
// written against the Tauri 2 APIs (pattern-matched to quick_entry.rs)
// and MUST pass `cargo check` in CI before the feature can be claimed
// as working. The web half (apps/web/app/overlay/) IS typechecked and
// tested there.
//
// Behaviour once compiled:
//   1. At startup, when the overlay is enabled, a small frameless,
//      transparent, always-on-top window (label `pet-overlay`) loads
//      the web shell's /overlay route. It is non-focusable and skipped
//      from the taskbar, so it never steals focus or clutters Alt-Tab.
//   2. Enabled state + window position persist in the app data dir
//      (`pet-overlay.json`) — Rust-side files, because the overlay's
//      webview localStorage cannot be read before the window exists.
//      The overlay page mirrors the user's `overlay` pet setting into
//      this file through the `pet_overlay_set_enabled` command (it
//      keeps polling its settings even while hidden — hide() does not
//      destroy the webview — so a Preferences toggle-on while running
//      re-shows the window without a restart, as long as the Tauri
//      webviews share one localStorage store, which they do under the
//      default shared webview data directory).
//   3. Commands the web shell invokes via the Tauri core bridge:
//        pet_overlay_show / pet_overlay_hide
//        pet_overlay_set_enabled(bool)  — persist + show/hide
//        pet_overlay_is_enabled()       — read the persisted mirror
//        pet_overlay_focus_main()       — raise the main window
//        pet_overlay_save_position(x,y) — persist after a drag
//
// Platform notes: transparency + always-on-top are plain Tauri builder
// flags and work on Windows/macOS/Linux (Wayland compositors may ignore
// always-on-top / absolute positioning — a compositor limitation, not
// worked around with per-OS code).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const OVERLAY_WINDOW_LABEL: &str = "pet-overlay";
pub const OVERLAY_ROUTE: &str = "overlay";
pub const OVERLAY_SIZE: f64 = 128.0;

const STATE_FILE: &str = "pet-overlay.json";

/// Persisted overlay state (app data dir). `enabled` mirrors the web
/// `mvp:pet:settings` overlay flag (default true, matching
/// DEFAULT_PET_SETTINGS); `x`/`y` are the last window position.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverlayState {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
}

fn default_true() -> bool {
    true
}

impl Default for OverlayState {
    fn default() -> Self {
        Self { enabled: true, x: None, y: None }
    }
}

fn state_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(STATE_FILE))
}

/// Read the persisted state; any failure degrades to defaults (enabled,
/// no saved position) — the overlay must never break app startup.
pub fn load_state(app: &AppHandle) -> OverlayState {
    let Some(path) = state_path(app) else {
        return OverlayState::default();
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => OverlayState::default(),
    }
}

fn save_state(app: &AppHandle, state: &OverlayState) {
    let Some(path) = state_path(app) else { return };
    if let Ok(text) = serde_json::to_string(state) {
        let _ = std::fs::write(&path, text);
    }
}

/// Build the overlay window (hidden callers should use show_overlay).
/// Restores the saved position when one exists.
pub fn create_overlay_window(app: &AppHandle) {
    if app.get_webview_window(OVERLAY_WINDOW_LABEL).is_some() {
        return;
    }
    let state = load_state(app);
    let mut builder = WebviewWindowBuilder::new(
        app,
        OVERLAY_WINDOW_LABEL,
        WebviewUrl::App(OVERLAY_ROUTE.into()),
    )
    .title("KriyaDot Pet")
    .inner_size(OVERLAY_SIZE, OVERLAY_SIZE)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .focusable(false)
    .shadow(false);
    if let (Some(x), Some(y)) = (state.x, state.y) {
        builder = builder.position(x, y);
    }
    if let Err(err) = builder.build() {
        eprintln!("[kriyadot] pet overlay window failed to build: {err}");
    }
}

/// Startup hook (called from main.rs setup): create the overlay only
/// when the persisted mirror says it is enabled.
pub fn init_overlay(app: &AppHandle) {
    if load_state(app).enabled {
        create_overlay_window(app);
    }
}

/// Show the overlay, building it first if needed.
pub fn show_overlay(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(OVERLAY_WINDOW_LABEL) {
        let _ = win.show();
    } else {
        create_overlay_window(app);
    }
}

/// Hide the overlay (the webview keeps running, so the page can keep
/// watching the settings store and re-show itself when re-enabled).
pub fn hide_overlay(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(OVERLAY_WINDOW_LABEL) {
        let _ = win.hide();
    }
}

// ---------------------------------------------------------------------
// Tauri commands (invoked from the web shell via __TAURI__.core.invoke)
// ---------------------------------------------------------------------

#[tauri::command]
pub fn pet_overlay_show(app: AppHandle) {
    show_overlay(&app);
}

#[tauri::command]
pub fn pet_overlay_hide(app: AppHandle) {
    hide_overlay(&app);
}

#[tauri::command]
pub fn pet_overlay_is_enabled(app: AppHandle) -> bool {
    load_state(&app).enabled
}

/// Persist the enabled mirror and apply it immediately. Called by the
/// overlay page when the user flips the overlay pet setting (in either
/// window) and by the overlay's own "Hide overlay" menu item.
#[tauri::command]
pub fn pet_overlay_set_enabled(app: AppHandle, enabled: bool) {
    let mut state = load_state(&app);
    state.enabled = enabled;
    save_state(&app, &state);
    if enabled {
        show_overlay(&app);
    } else {
        hide_overlay(&app);
    }
}

/// Bring the main window forward (overlay click-through action).
#[tauri::command]
pub fn pet_overlay_focus_main(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Persist the window position after a drag (physical pixels as f64,
/// matching WebviewWindowBuilder::position).
#[tauri::command]
pub fn pet_overlay_save_position(app: AppHandle, x: f64, y: f64) {
    let mut state = load_state(&app);
    state.x = Some(x);
    state.y = Some(y);
    save_state(&app, &state);
}
