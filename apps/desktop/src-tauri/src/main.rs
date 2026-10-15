// SPDX-License-Identifier: Apache-2.0
// Prevents additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::ShellExt;

/// Fixed loopback port the desktop backend listens on.
/// The bundled frontend detects Tauri (`window.__TAURI__`) and calls
/// `http://127.0.0.1:DESKTOP_API_PORT` for all API traffic.
const DESKTOP_API_PORT: &str = "4567";

struct SidecarState(Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState(Mutex::new(None)))
        .setup(|app| {
            // Data directory for SQLite DBs + providers.local.json (0600).
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&data_dir).expect("failed to create app data dir");

            // Log file for the sidecar's stdout/stderr — if the API doesn't
            // come up, this file shows why (crash, port conflict, etc.).
            // Rotate: keep the previous run's log too (capped so a runaway
            // sidecar can't fill the disk: giant logs are discarded, not kept).
            const MAX_KEPT_LOG_BYTES: u64 = 8 * 1024 * 1024;
            let log_path = data_dir.join("mvp-api.log");
            let prev_log = data_dir.join("mvp-api.prev.log");
            let keep_prev = true;
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
            let log_file =
                std::fs::File::create(&log_path).expect("failed to create sidecar log file");

            // Spawn the runtime API as a Tauri sidecar. The sidecar binary is
            // produced by `scripts/build-desktop.sh` (bun --compile) and placed at
            // src-tauri/binaries/mvp-api-<target-triple>[.exe].
            let (mut rx, child) = app
                .shell()
                .sidecar("mvp-api")
                .expect("failed to locate mvp-api sidecar")
                .args(["--port", DESKTOP_API_PORT])
                .env("DATA_DIR", data_dir.to_string_lossy().to_string())
                .spawn()
                .expect("failed to spawn mvp-api sidecar");

            // Pipe the sidecar's output to the log file. Without this, a
            // sidecar crash on startup is completely invisible.
            let mut log_file = log_file;
            use std::io::Write;
            let _ = writeln!(
                log_file,
                "[sarviq] sidecar spawned; port={} log={}",
                DESKTOP_API_PORT,
                log_path.to_string_lossy()
            );
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_shell::process::CommandEvent;
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            let _ = writeln!(log_file, "{}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Stderr(line) => {
                            let _ =
                                writeln!(log_file, "[stderr] {}", String::from_utf8_lossy(&line));
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
                        }
                        _ => {}
                    }
                    let _ = log_file.flush();
                }
            });

            // Keep the child handle alive so the sidecar isn't reaped early.
            // tauri-plugin-shell also terminates sidecars when the app exits.
            if let Some(state) = app.try_state::<SidecarState>() {
                *state.0.lock().unwrap() = Some(child);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
