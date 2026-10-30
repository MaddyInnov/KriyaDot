// SPDX-License-Identifier: Apache-2.0
// CA-27: Desktop quick entry — global-shortcut companion window +
// `kriyadot://` deep links (repo + prompt).
//
// *** SOURCE-LEVEL ONLY — UNVERIFIED ***
// Same status as dictation.rs: there is NO cargo/Rust toolchain on the
// build VM, so this file has never been compiled. It is written against
// the Tauri 2 + tauri-plugin-deep-link 2 + tauri-plugin-global-shortcut
// 2 APIs and MUST pass `cargo check` in CI before the feature can be
// claimed as working. The web half (deep-link parsing/routing and the
// /quick page) lives in apps/web/lib/desktop-bridge.ts +
// apps/web/app/quick/ and IS tested there.
//
// Behaviour once compiled:
//   1. Global shortcut Ctrl+Alt+K (Cmd+Option+K on macOS) toggles a
//      small always-on-top companion window loading the web shell's
//      /quick route (apps/web/app/quick/page.tsx).
//   2. Deep links delivered by tauri-plugin-deep-link:
//        kriyadot://chat/<chatId>
//        kriyadot://quick
//        kriyadot://repo/<url-encoded path>?prompt=<url-encoded text>
//      are forwarded to the webview as `deep-link://new-url` payloads
//      ({ urls: [...] }) — the exact shape apps/web/lib/desktop-bridge.ts
//      `wireDeepLinks()` consumes — and the main window is focused.

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

pub const COMPANION_WINDOW_LABEL: &str = "companion";
pub const COMPANION_ROUTE: &str = "quick";

/// The quick-entry shortcut: CommandOrControl+Alt+K.
pub fn quick_entry_shortcut() -> Shortcut {
    #[cfg(target_os = "macos")]
    let modifiers = Modifiers::SUPER | Modifiers::ALT;
    #[cfg(not(target_os = "macos"))]
    let modifiers = Modifiers::CONTROL | Modifiers::ALT;
    Shortcut::new(Some(modifiers), Code::KeyK)
}

/// Show the companion window if it exists, build it otherwise; hide it
/// when it is already visible (toggle semantics for the hotkey).
pub fn toggle_companion_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(COMPANION_WINDOW_LABEL) {
        match win.is_visible() {
            Ok(true) => {
                let _ = win.hide();
            }
            _ => {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
        return;
    }
    let _ = WebviewWindowBuilder::new(
        app,
        COMPANION_WINDOW_LABEL,
        WebviewUrl::App(COMPANION_ROUTE.into()),
    )
    .title("KriyaDot — Quick Entry")
    .inner_size(560.0, 420.0)
    .always_on_top(true)
    .resizable(false)
    .build();
}

/// Global-shortcut handler for quick entry. Wired alongside the
/// dictation handler in main.rs: dictation owns Ctrl/Cmd+Shift+Space,
/// this module owns Ctrl/Cmd+Alt+K; unrelated shortcuts are ignored.
pub fn on_quick_entry_shortcut(
    app: &AppHandle,
    shortcut: &Shortcut,
    event: tauri_plugin_global_shortcut::ShortcutEvent,
) {
    if *shortcut != quick_entry_shortcut() {
        return;
    }
    if event.state() == ShortcutState::Pressed {
        toggle_companion_window(app);
    }
}

/// Register the quick-entry shortcut at startup. Failure is non-fatal
/// (another app may own the chord); deep links remain available.
pub fn register_quick_entry(app: &AppHandle) {
    if let Err(err) = app.global_shortcut().register(quick_entry_shortcut()) {
        eprintln!("[kriyadot] quick-entry shortcut registration failed: {err}");
    }
}

/// Deep-link entry point: focus the main window and forward the URLs
/// to the web shell, which parses/routes them (desktop-bridge.ts).
/// On Linux/Windows debug builds the host must also call the deep-link
/// plugin's register_all() — see PLUGINS-TODO.md / wiring note.
pub fn handle_deep_links(app: &AppHandle, urls: Vec<String>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
    let _ = app.emit(
        "deep-link://new-url",
        serde_json::json!({ "urls": urls }),
    );
}
