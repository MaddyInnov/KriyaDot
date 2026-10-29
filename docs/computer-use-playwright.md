<!-- SPDX-License-Identifier: Apache-2.0 -->
# Computer use: Playwright browser layer (P3-B, open-dots parity)

KriyaDot's computer-use tools (`computer_screenshot` / `computer_click` /
`computer_type` / `computer_key` / `computer_scroll` / `computer_drag` /
`computer_move`) drive an `OSScreenLayer`. Three layers exist:

| Layer | Class | Select with | Install |
|---|---|---|---|
| Mock (default) | `MockOSScreenLayer` | nothing — the default | none |
| Playwright browser | `PlaywrightOSScreenLayer` | `COMPUTER_USE_PLAYWRIGHT=1` | `npm install playwright && npx playwright install chromium` |
| Real foreground desktop | `RealOSScreenLayer` | `COMPUTER_USE_REAL=1` | `npm install screenshot-desktop robotjs` (robotjs needs a C++ toolchain / node-gyp) |

Priority when more than one flag is set: **Playwright > real foreground >
mock** (see `selectOSLayer()` in
`packages/agent-runtime/src/tools/computer-real.ts`).

## Why the Playwright layer

This is the open-dots-style computer runtime option: the browser window
*is* the display (default 1280×720 viewport). It exists for the case where
the robotjs route is impractical:

- Playwright is pure JavaScript — no C++ toolchain, no node-gyp build.
- It bundles its own Chromium, so the target machine needs no display
  server or pre-installed browser.
- It is the natural fit for browser-automation tasks, where the agent's
  whole "computer" is a web page.

## Configuration

```bash
COMPUTER_USE_PLAYWRIGHT=1          # opt in (mock stays the default)
COMPUTER_PLAYWRIGHT_VIEWPORT=1600x900   # optional, default 1280x720
COMPUTER_PLAYWRIGHT_URL=https://example.com  # optional start page
COMPUTER_PLAYWRIGHT_HEADLESS=0     # optional; default 1 (headless). Set 0 for a visible window.
```

`playwright` is an **optional** dependency, lazy-loaded on first use —
importing the module (or setting the flag without the package installed)
never crashes the server at boot. The first screenshot/action throws a
clear install error instead.

## Safety model (unchanged)

The layer choice is orthogonal to governance, exactly like the real
foreground layer:

- Mutating actions (`computer_click`, `computer_type`, `computer_key`,
  `computer_scroll`, `computer_drag`, `computer_move`)
  still evaluate through `computerUsePolicyRules()` → `require-approval`
  **before** the handler runs. The browser does nothing until a human
  approves.
- `computer_screenshot` stays read-only / auto-allowed.
- Coordinate bounds, text length caps, and the key allowlist are enforced
  in the tool handlers (`computer.ts`), not the layer.
- Hosts can wire the `onRealAction` audit hook (already done in
  `apps/api/src/index.ts`) so every real click/type/key/scroll/drag/move lands in the
  governance audit trail.

## Per-bot persistent profiles (W4)

When the browser surface is driven through `PerBotComputerManager` (the
normal API wiring), each bot's Playwright layer launches a **persistent
context** (`chromium.launchPersistentContext`) whose user-data directory
is per bot:

```
<dataDir>/browser-profiles/<botId>/
```

Cookies, localStorage and logins therefore survive browser restarts, API
restarts, and the manager's 30-minute idle teardown. Teardown (surface
change, restart, bot deletion) closes the context but **keeps** the
profile. The only way to delete one is the explicit wipe:
`POST /api/bots/:id/computer/wipe-browser-profile` (also the "Wipe browser
profile" button in Bots → Computer → "Works on"), which closes the bot's
instances, deletes the directory, and is audit-logged. Profile directory
and disk usage are reported in `GET /api/bots/:id/computer`
(`browserProfile`) and in per-instance computer status (`profileDir`,
`profileBytes`). Profiles are keyed strictly by bot id — one bot can
never launch with another bot's directory.

## Sign-in codes (W4b)

The `enter_sign_in_code` agent tool handles sites that ask for a one-time
code sent to the user's email. It is require-approval by governance (the
approval card shows the site and the code source — a code cannot appear
there because it is fetched only after approval). The handler searches
the user's connected Gmail via the Composio path (per-bot enablement
enforced), extracts a single fresh (default ≤10 min), unambiguous code,
types it into the bot's focused browser field, and returns only
`{ entered, outcome, site, sources }` — the code value never appears in
tool results, logs, or audit entries. Ambiguous/stale/missing codes fail
closed with no typing.

## Notes and limits

- Coordinates are **viewport CSS pixels**, not physical screen pixels.
- The layer launches one Chromium instance per process, reused across
  calls (lazy on first use). No tab management is exposed in the MVP —
  for multi-tab work, inject a custom `pageFactory` (see
  `PlaywrightOSLayerOptions`) from host code.
- Key names are the conservative `COMPUTER_KEY_ALLOWLIST` set; the layer
  maps them to Playwright key names (e.g. `Space` → `' '`).
- Tests never touch a real browser: the `PlaywrightPageBackend`
  interface is injectable (`computer-playwright.test.ts` uses a fake).
