// SPDX-License-Identifier: Apache-2.0
// KriyaDot desktop shell (Tauri 2).
//
// - Spawns the API as a bundled sidecar on 127.0.0.1:4567, logging its
//   output to the app data dir.
// - System tray icon with menu: Show KriyaDot, API server status,
//   Restart API server (recovery when the sidecar dies), Quit.
// - The sidecar is watched: if it exits unexpectedly the tray menu flips to
//   "API server: STOPPED" and offers a one-click restart, and a periodic
//   loopback health probe catches deaths that emit no Terminated event.
//
// NOTE: no Rust toolchain is available in this build environment — this file
// is written carefully against the Tauri 2 API and must be compiled by CI
// (`cargo check` / the desktop release workflow) before shipping.

// Prevents additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};
use tauri_plugin_shell::ShellExt;

// V-5 dictation: global push-to-talk shortcut + OS-level text
// insertion (src/dictation.rs). SOURCE-LEVEL ONLY — unverified until
// CI compiles it (no cargo toolchain on the build VM).
mod dictation;

// DV-5 quick chat: the tray "Quick Chat" item (below, in both menu
// builders) opens the CA-27 quick-entry companion window from
// quick_entry.rs; the global shortcut + kriyadot:// deep links live
// there too. SOURCE-LEVEL ONLY — unverified until CI compiles it.

// CA-27: quick-entry companion window + kriyadot:// deep links
// (src/quick_entry.rs). SOURCE-LEVEL ONLY — same unverified status as
// dictation.rs until CI compiles it (no cargo toolchain on the build VM).
mod quick_entry;

/// Fixed loopback port the desktop backend listens on.
/// The bundled frontend detects Tauri (`window.__TAURI__`) and calls
/// `http://127.0.0.1:DESKTOP_API_PORT` for all API traffic.
const DESKTOP_API_PORT: &str = "4567";

/// Shared sidecar state: the child handle (kept alive so the sidecar isn't
/// reaped early) plus whether the sidecar is believed to be running.
#[derive(Clone)]
struct SidecarState {
    child: Arc<Mutex<Option<tauri_plugin_shell::process::CommandChild>>>,
    running: Arc<Mutex<bool>>,
    data_dir: PathBuf,
}

impl SidecarState {
    fn new(data_dir: PathBuf) -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            running: Arc::new(Mutex::new(false)),
            data_dir,
        }
    }
    fn set_running(&self, v: bool) {
        if let Ok(mut g) = self.running.lock() {
            *g = v;
        }
    }
    fn is_running(&self) -> bool {
        self.running.lock().map(|g| *g).unwrap_or(false)
    }
}

/// Spawn (or re-spawn) the API sidecar. Called at startup and from the
/// tray's "Restart API server" item.
fn spawn_sidecar(app: &AppHandle, state: &SidecarState) {
    let log_path = state.data_dir.join("mvp-api.log");
    let mut log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .expect("failed to open sidecar log file");

    use std::io::Write;
    let _ = writeln!(log_file, "[kriyadot] spawning sidecar; port={}", DESKTOP_API_PORT);

    let (mut rx, child) = app
        .shell()
        .sidecar("mvp-api")
        .expect("failed to locate mvp-api sidecar")
        .args(["--port", DESKTOP_API_PORT])
        .env("DATA_DIR", state.data_dir.to_string_lossy().to_string())
        .spawn()
        .expect("failed to spawn mvp-api sidecar");

    state.set_running(true);
    if let Some(s) = app.try_state::<SidecarState>() {
        if let Ok(mut g) = s.child.lock() {
            *g = Some(child);
        }
    }

    // Pipe sidecar output to the log file and watch for termination.
    let watch_state = state.clone();
    let watch_app = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let _ = writeln!(log_file, "{}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    let _ = writeln!(log_file, "[stderr] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Error(err) => {
                    let _ = writeln!(log_file, "[sidecar error] {}", err);
                }
                CommandEvent::Terminated(payload) => {
                    let _ = writeln!(
                        log_file,
                        "[terminated] sidecar exited: code={:?} signal={:?}",
                        payload.code, payload.signal
                    );
                    watch_state.set_running(false);
                    refresh_tray_menu(&watch_app, &watch_state);
                }
                _ => {}
            }
            let _ = log_file.flush();
        }
        // Channel closed without a Terminated event — treat as stopped.
        watch_state.set_running(false);
        refresh_tray_menu(&watch_app, &watch_state);
    });
}

/// Rebuild the tray menu to reflect the current sidecar status.
fn refresh_tray_menu(app: &AppHandle, state: &SidecarState) {
    let running = state.is_running();
    let status_label = if running {
        "API server: RUNNING (127.0.0.1:4567)"
    } else {
        "API server: STOPPED"
    };
    let restart_label = if running {
        "Restart API server"
    } else {
        "Start API server"
    };
    let show = MenuItem::with_id(app, "show", "Show KriyaDot", true, None::<&str>);
    let quickchat_item = MenuItem::with_id(app, "quickchat", "Quick Chat", true, None::<&str>);
    let status = MenuItem::with_id(app, "status", status_label, false, None::<&str>);
    let restart = MenuItem::with_id(app, "restart", restart_label, true, None::<&str>);
    let quit = MenuItem::with_id(app, "quit", "Quit KriyaDot", true, None::<&str>);
    // If any item fails to build (shouldn't), keep the old menu.
    let (Ok(show), Ok(quickchat_item), Ok(status), Ok(restart), Ok(quit)) =
        (show, quickchat_item, status, restart, quit)
    else {
        return;
    };
    let Ok(menu) = Menu::with_items(app, &[&show, &quickchat_item, &status, &restart, &quit]) else {
        return;
    };
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_menu(Some(menu));
        let _ = tray.set_tooltip(Some(if running {
            "KriyaDot — API running"
        } else {
            "KriyaDot — API STOPPED, click Restart"
        }));
    }
}

/// Cheap liveness probe on a timer: a loopback TCP connect to the API port.
/// Catches sidecar deaths that emit no Terminated event (e.g. SIGKILL) and
/// also notices when a manually restarted sidecar comes back.
fn start_health_watch(app: AppHandle, state: SidecarState) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(15)).await;
            let alive = tauri::async_runtime::spawn_blocking(|| {
                use std::net::TcpStream;
                TcpStream::connect_timeout(
                    &"127.0.0.1:4567".parse().unwrap(),
                    Duration::from_millis(800),
                )
                .is_ok()
            })
            .await
            .unwrap_or(false);
            if alive != state.is_running() {
                state.set_running(alive);
                refresh_tray_menu(&app, &state);
            }
        }
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        // CA-27: kriyadot:// deep links (scheme declared in tauri.conf.json).
        .plugin(tauri_plugin_deep_link::init())
        // V-5 + CA-27: one global-shortcut plugin, two handlers —
        // dictation owns Ctrl/Cmd+Shift+Space, quick entry owns
        // Ctrl/Cmd+Alt+K; each handler ignores the other's chord.
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    dictation::on_shortcut_event(app, shortcut, event);
                    quick_entry::on_quick_entry_shortcut(app, shortcut, event);
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![dictation::dictation_insert_text])
        .setup(|app| {
            // Data directory for SQLite DBs + providers.local.json (0600).
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&data_dir).expect("failed to create app data dir");

            // Rotate the sidecar log: keep the previous run too, capped so a
            // runaway sidecar can't fill the disk.
            const MAX_KEPT_LOG_BYTES: u64 = 8 * 1024 * 1024;
            let log_path = data_dir.join("mvp-api.log");
            let prev_log = data_dir.join("mvp-api.prev.log");
            let mut keep_prev = true;
            if let Ok(meta) = std::fs::metadata(&log_path) {
                if meta.len() > MAX_KEPT_LOG_BYTES {
                    let _ = std::fs::remove_file(&log_path);
                    let _ = std::fs::remove_file(&prev_log);
                    keep_prev = false;
                }
            }
            if keep_prev {
                let _ = std::fs::rename(&log_path, &prev_log);
            }

            let state = SidecarState::new(data_dir);
            app.manage(state.clone());

            // V-5: register the global push-to-talk shortcut
            // (CommandOrControl+Shift+Space). Failure is non-fatal —
            // dictation.rs logs it and in-app/web dictation still works.
            dictation::register_push_to_talk(app.handle());

            // CA-27: register the quick-entry shortcut and route
            // kriyadot:// deep links into the web shell
            // (apps/web/lib/desktop-bridge.ts wireDeepLinks).
            quick_entry::register_quick_entry(app.handle());
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    let urls: Vec<String> =
                        event.urls().iter().map(|u| u.to_string()).collect();
                    quick_entry::handle_deep_links(&handle, urls);
                });
                #[cfg(any(target_os = "linux", target_os = "windows"))]
                {
                    let _ = app.deep_link().register_all();
                }
            }

            // System tray: Show / Quick Chat (DV-5) / status / Restart API / Quit.
            let show = MenuItem::with_id(app, "show", "Show KriyaDot", true, None::<&str>)?;
            let quickchat_item =
                MenuItem::with_id(app, "quickchat", "Quick Chat", true, None::<&str>)?;
            let status =
                MenuItem::with_id(app, "status", "API server: starting…", false, None::<&str>)?;
            let restart =
                MenuItem::with_id(app, "restart", "Restart API server", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit KriyaDot", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quickchat_item, &status, &restart, &quit])?;

            let tray_state = state.clone();
            // tauri 2.x Image has no from_bytes: decode the bundled PNG to
            // raw RGBA first (the asset is compiled in, so this cannot fail
            // at runtime unless the build itself is broken).
            let icon_img = image::load_from_memory(include_bytes!("../icons/32x32.png"))
                .expect("bundled tray icon decodes")
                .to_rgba8();
            let (icon_w, icon_h) = (icon_img.width(), icon_img.height());
            let icon = tauri::image::Image::new_owned(icon_img.into_raw(), icon_w, icon_h);
            let _tray = TrayIconBuilder::with_id("main")
                .tooltip("KriyaDot")
                .icon(icon)
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    // DV-5: tray entry point to the quick-chat surface —
                    // toggles the CA-27 companion window (quick_entry.rs).
                    "quickchat" => quick_entry::toggle_companion_window(app),
                    "restart" => {
                        // Drop the old child handle (killing it if still
                        // alive) and spawn a fresh sidecar.
                        if let Some(s) = app.try_state::<SidecarState>() {
                            if let Ok(mut guard) = s.child.lock() {
                                if let Some(child) = guard.take() {
                                    let _ = child.kill();
                                }
                            }
                            s.set_running(false);
                        }
                        spawn_sidecar(app, &tray_state);
                        refresh_tray_menu(app, &tray_state);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            spawn_sidecar(app.handle(), &state);
            refresh_tray_menu(app.handle(), &state);
            start_health_watch(app.handle().clone(), state);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
