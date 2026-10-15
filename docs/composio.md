<!-- SPDX-License-Identifier: Apache-2.0 -->

# Composio connector

Let KriyaDot bots act inside 1,000+ external apps (Gmail, Slack, GitHub,
Notion, Google Calendar, …) through one Composio API key. The API key is
validated against the Composio backend, stored encrypted in the per-user
vault, and never logged or returned. App access is toggled per bot on the
Accounts page.

## 1. Get a Composio API key (free tier available)

1. Sign up at <https://composio.dev> (free to start).
2. Open <https://dashboard.composio.dev> and sign in.
3. In the top-left mode toggle next to the logo, make sure you are in
   **PLATFORM** mode ("Build and manage AI agents with the Composio SDK")
   — not "FOR YOU" mode (that hands out a `ck_…` consumer key for desktop
   AI apps, which KriyaDot cannot use).
4. Go to **Settings → API Keys** and copy your key (a PLATFORM key looks
   like `ak_…`).

> Source docs: Composio README quickstart
> (<https://github.com/sornwarinsonsiri31/composio>) uses a key from the
> dashboard for all backend API calls, which is exactly what KriyaDot uses.

## 2. Connect it in KriyaDot

1. Open the KriyaDot web app → Settings (gear) → **Accounts & API keys**.
2. In the **Composio** section, paste the key and click **Connect**.
3. The key is validated against `https://backend.composio.dev/api/v3` and
   stored in the encrypted vault (secret `composio-api-key`).

## 3. Enable apps per bot

1. Pick a bot in the bot selector on the Composio panel.
2. Use the checkboxes (or the filter box) to enable the apps that bot may
   use — e.g. Gmail and Slack for an assistant bot.
3. Disable with the same checkbox, or disconnect everything with
   **Disconnect** (this deletes the stored key).

## API

| Method | Path                              | Notes                                  |
| ------ | --------------------------------- | -------------------------------------- |
| GET    | `/api/composio/status`            | `{ connected }` — never errors         |
| POST   | `/api/composio/connect`           | `{ apiKey }` → validates → `{ connected: true }` |
| DELETE | `/api/composio/connect`           | Forgets the key → `{ connected: false }` |
| GET    | `/api/composio/apps?botId=`       | App catalog; `enabled` per app when `botId` given |
| POST   | `/api/composio/apps/:appId`       | `{ botId, enabled }` → per-bot toggle  |

Without a configured key every endpoint answers gracefully with
`{ connected: false }` — no 500s. Key values never appear in responses,
logs, or audit detail.
