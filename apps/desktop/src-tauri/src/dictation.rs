// SPDX-License-Identifier: Apache-2.0
// OS-level dictation + desktop push-to-talk hotkey (Muse parity
// audit §4.9, V-5) — NATIVE SIDE.
//
// *** SOURCE-LEVEL ONLY — UNVERIFIED ***
// There is NO cargo/Rust toolchain on the build VM, so this file has
// never been compiled. It is written carefully against the Tauri 2 +
// tauri-plugin-global-shortcut 2 + enigo 0.2 APIs and MUST pass
// `cargo check` in CI (the desktop release workflow) before the
// feature can be claimed as working. The TypeScript/web half of V-5
// (hotkey config model, dictation seam, Web Speech fallback,
// push-to-talk state machine) lives in packages/voice/src/dictation.ts
// and is fully tested there.
//
// What this module does once compiled:
//   1. Registers the global push-to-talk shortcut
//      (CommandOrControl+Shift+Space — mirrors DEFAULT_PTT_ACCELERATOR
//      in the TS module) with the OS, so it fires in ANY app.
//   2. Forwards press/release to the webview as `dictation://press` /
//      `dictation://release` events; the frontend runs the
//      PushToTalkController + STT and calls back with the transcript.
//   3. Exposes the `dictation_insert_text` Tauri command, which types
//      the transcript into the currently focused application via
//      enigo (real OS-level text insertion, not a clipboard hack).

use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// The push-to-talk shortcut: CommandOrControl+Shift+Space.
/// CommandOrControl resolves to Super/Cmd on macOS and Control
/// elsewhere — the same semantics as the TS accelerator parser.
pub fn push_to_talk_shortcut() -> Shortcut {
    #[cfg(target_os = "macos")]
    let modifiers = Modifiers::SUPER | Modifiers::SHIFT;
    #[cfg(not(target_os = "macos"))]
    let modifiers = Modifiers::CONTROL | Modifiers::SHIFT;
    Shortcut::new(Some(modifiers), Code::Space)
}

/// Global-shortcut handler: translate OS shortcut events into webview
/// events for the TS PushToTalkController. Registered via the plugin
/// builder in main.rs.
pub fn on_shortcut_event(app: &AppHandle, shortcut: &Shortcut, event: tauri_plugin_global_shortcut::ShortcutEvent) {
    if *shortcut != push_to_talk_shortcut() {
        return;
    }
    match event.state() {
        ShortcutState::Pressed => {
            let _ = app.emit("dictation://press", ());
        }
        ShortcutState::Released => {
            let _ = app.emit("dictation://release", ());
        }
    }
}

/// Register the push-to-talk shortcut at startup. Called from the
/// Tauri setup hook in main.rs. A registration failure (shortcut taken
/// by another app) is logged, not fatal: the web fallback dictation
/// remains available in-app.
pub fn register_push_to_talk(app: &AppHandle) {
    let shortcut = push_to_talk_shortcut();
    if let Err(err) = app.global_shortcut().register(shortcut) {
        eprintln!("[kriyadot] push-to-talk shortcut registration failed: {err}");
    }
}

/// Type `text` into the currently focused application (any app on the
/// user's computer — this is the OS-level half of dictation). Invoked
/// by the frontend once STT produces a final transcript and
/// routeDictationText() (TS) has decided the target is the focused app.
///
/// Platform notes: macOS requires the app to hold Accessibility
/// permission for keystroke injection; without it enigo returns an
/// error, which surfaces to the caller instead of failing silently.
#[tauri::command]
pub fn dictation_insert_text(text: String) -> Result<(), String> {
    use enigo::{Enigo, Keyboard, Settings};
    if text.trim().is_empty() {
        return Err("dictation insert: text is empty".to_string());
    }
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    enigo.text(&text).map_err(|e| e.to_string())
}
