<!-- SPDX-License-Identifier: Apache-2.0 -->
# Desktop plugins: push-to-talk hotkey + deep links — remaining wiring

Status (2026-10-29 build environment): **config-side done, Rust wiring NOT
done — deliberately.** This machine has cargo/rustc 1.99 (stable) and
crates.io access, but:

- the Tauri Linux build deps (webkit2gtk-4.1, gtk+-3.0, libsoup-3.0) are
  NOT installed, so `cargo check` cannot type-check the app crate here;
- `rustc -Zparse-only` needs nightly, which is not installed, so a
  parse-check of `main.rs` is not possible here either.

Per the work order, no un-compilable Rust was committed. `main.rs` and
`Cargo.toml` are untouched.

## Done (pure config)

- `src-tauri/tauri.conf.json` now declares the deep-link scheme:
  `plugins.deep-link.desktop.schemes = ["kriyadot"]`.

## Remaining (on a machine with the Tauri toolchain + system deps)

1. `src-tauri/Cargo.toml` dependencies:
   ```toml
   tauri-plugin-global-shortcut = "2"
   tauri-plugin-deep-link = "2"
   ```
2. `src-tauri/capabilities/default.json` permissions:
   `"global-shortcut:default"` and `"deep-link:default"`.
3. `src-tauri/src/main.rs` builder wiring (conservative sketch):
   ```rust
   use tauri::Emitter;
   use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

   // In Builder chain:
   .plugin(tauri_plugin_deep_link::init())
   .plugin(
       tauri_plugin_global_shortcut::Builder::new()
           .with_handler(|app, _shortcut, event| {
               if event.state() == ShortcutState::Pressed {
                   // Web-shell contract: listen for the Tauri event
                   // named 'push-to-talk' (payload: { source: 'hotkey' }).
                   let _ = app.emit("push-to-talk", serde_json::json!({ "source": "hotkey" }));
               }
           })
           .build(),
   )
   // In setup(): register Ctrl+Alt+Space (⌃⌥Space on macOS):
   //   let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);
   //   app.global_shortcut().register(shortcut)?;
   // Deep links: app.deep_link().on_open_url(|event| { /* route kriyadot://chat/<id> */ })
   //   and register_all() on Windows/Linux debug per the plugin README.
   ```
4. Web shell: subscribe to the Tauri event `push-to-talk` to start/stop
   voice capture, and handle `kriyadot://chat/<chatId>` deep links by
   navigating to that chat (the deep-link plugin delivers URLs via its
   `deep-link://new-url` frontend event / `onOpenUrl`).

## Event contract (fixed by this note)

- Push-to-talk event name: **`push-to-talk`**, payload `{ "source": "hotkey" }`.
- Deep-link scheme: **`kriyadot://`** (`kriyadot://chat/<chatId>` routes to a chat).
