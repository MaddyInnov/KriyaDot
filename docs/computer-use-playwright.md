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
