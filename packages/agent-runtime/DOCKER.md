# Docker computer-use sandbox

The computer-use tools (`computer_screenshot`, `computer_click`, `computer_type`,
`computer_key`, `computer_scroll`, `computer_drag`, `computer_move`) drive an `OSScreenLayer`. By default that layer is the **local**
sandbox (`LocalComputerSandbox`): the mock layer, or the real foreground layer
when `COMPUTER_USE_REAL=1` is set.

Setting `COMPUTER_USE_DOCKER=1` switches to `DockerComputerSandbox`: headless
Chrome runs **inside a Docker container** and is driven over the Chrome DevTools
Protocol (CDP). The agent never touches the host's screen, mouse, or keyboard —
this is the Dots-style isolation backend.

```
agent → computer_* tools → DockerComputerSandbox → CDP (ws://127.0.0.1:<port>)
                                                        → headless Chrome in container
```

## Setup

1. Install Docker (Docker Desktop, or the engine + `dockerd` running).
   Verify: `docker info` succeeds.
2. Pull the image (first run pulls automatically, ~hundreds of MB):
   `docker pull zenika/alpine-chrome:latest`
3. Enable the backend:
   `COMPUTER_USE_DOCKER=1`

No npm install beyond the repo is needed: the CDP client uses the Node 22+
global `WebSocket`, and container management shells out to the `docker` CLI.

## Environment flags

| Variable | Default | Purpose |
|---|---|---|
| `COMPUTER_USE_DOCKER` | unset (local backend) | `1` → use the Docker backend |
| `COMPUTER_DOCKER_IMAGE` | `zenika/alpine-chrome:latest` | Chrome image to run |
| `COMPUTER_DOCKER_WIDTH` | `1280` | Sandboxed viewport width (px) |
| `COMPUTER_DOCKER_HEIGHT` | `720` | Sandboxed viewport height (px) |
| `COMPUTER_USE_REAL` | unset (mock) | `1` → local backend drives the real foreground OS (ignored when Docker is on; Docker wins if both are set) |

Programmatic selection (same rules): `selectComputerSandbox()` from
`@mvp/agent-runtime/dist/tools/computer-sandbox.js`.

## Wiring it into the API host

`apps/api/src/index.ts` currently registers the computer tools with the local
selector. To switch the deployment to the Docker backend (no `index.ts` edit
was made by this workstream — apply when ready):

```ts
import { selectComputerSandbox } from '@mvp/agent-runtime/dist/tools/computer-sandbox.js';

// ... inside the boot function, replacing the selectOSLayer(...) call:
const computerSandbox = selectComputerSandbox({
  onRealAction: (action, detail) => {
    // existing governance audit hook — unchanged
    governance.audit('tool.computer_real_action', { actor: 'agent', toolName: `computer_${action}`, detail });
  },
});
await computerSandbox.launch(); // starts the container when COMPUTER_USE_DOCKER=1; no-op otherwise
registerComputerUseTool(toolRegistry, { os: computerSandbox });
// ... on shutdown:
process.on('SIGTERM', () => { void computerSandbox.kill(); });
```

`COMPUTER_USE_DOCKER=1` can also be set without any code change once the
`selectComputerSandbox` wiring above is in place.

## How it works

`launch()`:

1. `docker info` sanity check (clear error + this doc's pointer if Docker is down).
2. `docker run -d --rm` with:
   - `-p 127.0.0.1::<random host port>:9222` — the debugger port is published
     on **loopback only**, never the LAN;
   - `--shm-size 512m --memory 2g --cpus 2` resource caps;
   - Chrome flags: `--headless=new --no-sandbox --disable-gpu
     --remote-debugging-address=0.0.0.0 --remote-debugging-port=9222
     --window-size=WxH about:blank`.
3. Polls `http://127.0.0.1:<host port>/json/list` for a `page` target, connects
   over its `webSocketDebuggerUrl`, then `Page.enable` +
   `Emulation.setDeviceMetricsOverride` to pin the viewport.

Input mapping:

- `click(x, y)` → `Input.dispatchMouseEvent` press + release (left button).
- `type(text)` → `Input.insertText` (targets the focused editable element —
  click the field first, same focus semantics as the local backend).
- `key(name)` → `Input.dispatchKeyEvent` rawKeyDown + keyUp with the Windows
  virtual-key code for each allowlisted key.
- `screenshot()` → `Page.captureScreenshot` (PNG); real dimensions are parsed
  from the PNG IHDR.

`kill()` closes the CDP connection and `docker stop`s the container
(`--rm` removes it). It is idempotent and best-effort — safe to call on
shutdown paths.

## Governance & safety

- **Approval gating is unchanged.** `computerUsePolicyRules()` still marks
  `computer_click`/`computer_type`/`computer_key`/`computer_scroll`/`computer_drag`/
  `computer_move` as `require-approval`; the
  runtime evaluates policy before the handler runs, whichever backend is active.
- The container is the sandbox: Chrome runs `--no-sandbox` *inside* it because
  the container provides the isolation boundary (same reasoning as CI Chrome).
- Container escape is out of scope for the MVP: run the Docker host on a
  trusted machine, keep the daemon patched, and do not mount host paths into
  the computer container.

## Limitations (MVP)

- **Headless Chrome only — not a full desktop.** There is no X11/VNC desktop,
  no native apps, no file-open dialogs, no audio. If you need a full GUI
  desktop, run a VNC image (e.g. `dorowu/ubuntu-desktop-lxde-vnc`) — that
  requires an RFB/VNC client, which is not implemented here.
- `type()` inserts into the focused element; on a fresh `about:blank` with no
  focus it may be a no-op until something is clicked/focused.
- Screenshots are the *viewport*, not the physical display.
- First launch pulls the image (slow on first run); subsequent launches reuse it.
- One container per `DockerComputerSandbox` instance; concurrent sessions need
  one instance each (host ports are auto-assigned, so they don't collide).
- The default image pins Chrome flags known to work with
  `zenika/alpine-chrome`; other images may need different flags — pass
  `chromeArgs` explicitly (see below).

## Using a different image

Any image that runs Chrome/Chromium with `--remote-debugging-port` works.
Options:

```ts
new DockerComputerSandbox({
  image: 'browserless/chrome:latest',
  chromeArgs: [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-address=0.0.0.0',
    '--remote-debugging-port=9222',
    '--window-size=1280,720',
  ],
  cdpPort: 9222,
});
```

Known alternatives: `browserless/chrome` (purpose-built for automation),
`mcr.microsoft.com/playwright:<ver>-noble` (Chromium at
`/ms-playwright/chromium-*/chrome-linux/chrome` — invoke it explicitly as the
container command since the image entrypoint is a shell).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Docker daemon is not reachable` | Start Docker Desktop / `dockerd`. |
| `Timed out waiting for a debuggable page target` | The image isn't exposing CDP: check the image's Chrome flags, or pass `chromeArgs` explicitly. |
| `docker run failed` | Image can't be pulled (network/proxy) or the daemon denied it; run the printed `docker run` manually to see the error. |
| Clicks land in the wrong place | Viewport is fixed at launch (`COMPUTER_DOCKER_WIDTH/HEIGHT`); the tool layer bounds-checks against it. Device-pixel-ratio scaling is 1 by emulation override. |

## Tests

`packages/agent-runtime/src/tools/computer-sandbox.test.ts` — 25 tests, all
with injected fakes (fake `DockerRunner`, fake CDP transport, fake target
lister, fake WebSocket). No Docker daemon, no network, no paid APIs.
