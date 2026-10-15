# SPDX-License-Identifier: Apache-2.0

# Fast Message Router (`packages/agent-runtime/src/message-router.ts`)

Pure, deterministic, zero-LLM message→bot routing — the "Jev" equivalent for
KriyaDot. Given a message and the bot roster, it returns
`{ botId, confidence, reason }` in microseconds with no model call.

## How it scores

1. **Per-bot keyword set** — tokens from the bot's `name`, `description`, and
   optional `routeKeywords` (per-bot persona keywords, e.g.
   `['billing', 'invoice', 'refund']` on a billing bot).
2. **Built-in topic maps** (`TOPIC_KEYWORDS`: code, writing, finance,
   research, health, travel, music, productivity, shopping) — a bot *covers*
   a topic when its keywords intersect the topic's vocabulary (or its
   name/description mentions the topic word). Message tokens hitting a
   covered topic score for that bot.
3. **Exact phrase bonus** — multi-word `routeKeywords` (e.g. `"pull request"`)
   appearing verbatim in the message score extra.

Direct keyword hit = 2, topic hit = 1, phrase hit = 4. Highest score wins;
ties resolve to the earliest bot (stable). `confidence` is the winner's
share of total score (0 = no match → falls back to the first bot).

This is **message→bot** routing. It is deliberately separate from
`packages/agent-runtime/src/routing.ts`, which is **model routing**
(task→model/provider).

## Wiring

`POST /api/chat` still requires an explicit `botId` (the web UI picks).
The router is the default picker for **inbound messaging mentions**
(Discord/Slack) in `apps/api/src/routes.ts`:

- `MESSAGING_DEFAULT_BOT` set → that bot always wins (manual override).
- Otherwise → `routeMessage()` picks from the message text.
- `MESSAGE_ROUTER_ENABLED=0` → legacy first-bot fallback.

To give a bot better routing, set `routeKeywords` on its `BotConfig`
(`packages/agent-runtime/src/types.ts`).
