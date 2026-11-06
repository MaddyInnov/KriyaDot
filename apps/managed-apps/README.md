<!-- SPDX-License-Identifier: Apache-2.0 -->
# KriyaDot Managed Apps service (`@mvp/managed-apps`)

The operator-hosted **Managed Apps** service. KriyaDot instances can reach
1,000+ apps through Composio in two modes:

- **BYOK (existing):** each user pastes their own Composio key into their
  instance (`apps/api/src/composio.ts`). Nothing changes there.
- **Managed (this service):** KriyaDot operates **one central Composio
  account**. Entitled instances call this service, and this service calls
  Composio with the operator key. The operator key lives **only** in this
  service's environment — it never reaches a user instance, is never
  returned by any endpoint, and is never logged.

The service is a zero-dependency TypeScript Node service in the style of
`apps/frontdoor/` (`node:http`, JSON/JSONL file storage, vitest tests).

## Activation — the only two steps, both Ashutosh-only

1. **Create the KriyaDot operator Composio account** and put its API key in
   `KRIYADOT_MANAGED_COMPOSIO_API_KEY` on the host running this service.
2. **Host this service** (the front-door hosting decision), set the
   front-door public key env (`MANAGED_APPS_FRONTDOOR_PUBLIC_KEY_PEM` or
   `MANAGED_APPS_FRONTDOOR_PUBLIC_KEY_FILE`), and point instances at it via
   `KRIYADOT_MANAGED_APPS_URL`.

Until step 1 is done the service still runs, but every Composio-backed
route fails closed with `503 { "code": "operator_key_missing" }`.

## Auth

Every `/v1` request (except the operator-usage route below) carries:

```
Authorization: Bearer <token>
```

The token is the **front-door handoff token format** — the same Ed25519
scheme as `apps/frontdoor/src/handoff.ts`, reused rather than reinvented:

```
base64url(JSON payload) + "." + base64url(Ed25519 signature)
payload: { v: 1, iss: "kriyadot-frontdoor", accountId, email?, plan?,
           features?, iat, exp }        // iat/exp in seconds
```

It is verified against the front-door **public** key from
`MANAGED_APPS_FRONTDOOR_PUBLIC_KEY_PEM` (or `_FILE`). Bad signature, wrong
`iss`, expired token, or a missing `accountId` all get **401**. Unlike the
single-use instance handoff, service tokens are bearer credentials, so
there is no nonce and no 120-second lifetime cap — the TTL is whatever the
issuer set.

Until the front door mints these tokens in-product, the operator issues
them with the helper (private key stays in env, never printed):

```sh
FRONTDOOR_HANDOFF_PRIVATE_KEY="$(cat frontdoor-key.pem)" \
  node scripts/mint-token.mjs --accountId acct_123 --email user@example.com \
    --plan pro --features managed-apps --ttl 86400
```

### Entity derivation — callers can never act as someone else

The Composio entity id is **derived server-side only**:

```
entityId = "kd_" + sha256(accountId) hex, first 24 chars
```

Any `userId` / `entity` / `user_id` field in a request body or query is
**ignored — never read**. Every Composio object a caller can see or touch
is scoped to their own entity: listing shows only their accounts, and
execute / label / delete first verify the target account belongs to the
caller's entity (membership in their own connected-account list — the
normalized `ComposioConnectedAccount` shape mirrored from `apps/api`
carries no entity field). Someone else's account id, even guessed
correctly, returns **404**.

## Entitlement & quotas

A caller is entitled iff **either**:

- the token's `features` array includes `"managed-apps"`, **or**
- the token's `plan` is in `MANAGED_APPS_ENTITLED_PLANS`
  (default `pro,team,business`).

Non-entitled callers get `403 { "code": "not_entitled" }` on all `/v1/*`
routes (`/health` is public).

Monthly execution quotas come from `MANAGED_APPS_QUOTAS_JSON`
(default `{"free":0,"pro":1000,"team":5000,"business":25000}`); an unknown
plan has quota **0**. Quotas are checked **before** Composio is called:

- customer at quota → `429 { "code": "quota_exceeded", plan, used, quota }`
- global month total at `MANAGED_APPS_GLOBAL_MONTHLY_CAP`
  (default `100000`) → `429 { "code": "operator_cap_reached" }`

## Endpoints

| Route | Behaviour |
| --- | --- |
| `GET /health` | `{ ok: true }`, no auth. |
| `GET /v1/apps` | `{ apps }` — Composio toolkit catalog via the operator key. |
| `POST /v1/connect-link` `{ toolkitSlug, label? }` | `{ redirectUrl }` — hosted Composio OAuth link for the caller's entity. A pending label is remembered and applied when the new account appears. |
| `GET /v1/accounts` | `{ accounts }` — the caller's connected accounts, merged with service-side labels. |
| `POST /v1/accounts/:id/label` `{ label }` | Rename one of the caller's accounts (label stored service-side). Not theirs → 404. |
| `DELETE /v1/accounts/:id` | Revoke + delete one of the caller's accounts → `{ ok: true }`. Not theirs → 404. |
| `GET /v1/tools?toolkitSlug=` | `{ tools }` — executable actions for a toolkit. |
| `POST /v1/execute` `{ toolkitSlug?, accountId?, actionName, arguments?, kind? }` | Executes one action. Target = the given account (ownership-verified) or the caller's **ACTIVE** account for `toolkitSlug`. Every attempt is metered (see below). `kind` ∈ `chat` \| `routine` \| `watch` (default `chat`; anything else becomes `chat`). |
| `GET /v1/usage` | `{ plan, used, quota, month: "YYYY-MM", globalCapReached }` for the caller, current UTC month. |
| `GET /v1/operator/usage` | Operator-only (see below): `{ month, totalUsed, globalCap, customers: [{ accountId, used, byToolkit }] }` — counts only. |

Composio access goes only through the injectable `ComposioClient`
interface in `src/composio.ts`, which mirrors `apps/api`'s interface and
normalized shapes exactly; production uses a fetch implementation against
the same Composio backend base (`https://backend.composio.dev/api/v3`).

### Operator usage

`GET /v1/operator/usage` does **not** use a user token. It requires:

```
Authorization: Bearer <MANAGED_APPS_OPERATOR_TOKEN>
```

Anything else → **401**. If the env var is unset the route always 401s
(fail closed). The response contains counts only — never action arguments,
results, or provider credentials.

## Metering & storage

Everything lives in `MANAGED_APPS_DATA_DIR` (default `./data`):

- **`usage.jsonl`** — append-only, one line per execution attempt
  (success **and** upstream failure; quota-blocked calls never reach
  Composio and are not metered):

  ```json
  { "ts": "2026-11-06T10:15:00.000Z", "accountId": "acct_123",
    "toolkit": "gmail", "action": "GMAIL_SEND_EMAIL",
    "ok": true, "kind": "chat" }
  ```

  Months are the UTC month of `ts`.
- **`store.json`** — small JSON store (atomic write, mode `0600`) with
  account labels and pending connect-link labels, keyed by entity id.

## Privacy note

> In managed mode, tool arguments and results transit this
> KriyaDot-operated service; it stores no provider tokens and no payload
> content — only count-only usage records.

Composio holds the OAuth provider tokens; this service never sees them.
What transits (arguments/results) is forwarded and returned, never
persisted.

## Environment

| Var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PORT` | no | `4400` | Listen port. |
| `KRIYADOT_MANAGED_COMPOSIO_API_KEY` | for Composio routes | — | The operator's central Composio API key. Absent → Composio routes answer `503 operator_key_missing`. |
| `MANAGED_APPS_FRONTDOOR_PUBLIC_KEY_PEM` | yes (or `_FILE`) | — | Front-door Ed25519 **public** key PEM used to verify service tokens. Literal `\n` escapes are accepted. |
| `MANAGED_APPS_FRONTDOOR_PUBLIC_KEY_FILE` | alt | — | Path to a file holding that public key PEM. |
| `MANAGED_APPS_OPERATOR_TOKEN` | for operator route | — | Bearer token for `GET /v1/operator/usage`. Unset → route always 401s. |
| `MANAGED_APPS_ENTITLED_PLANS` | no | `pro,team,business` | Comma-separated entitled plans. |
| `MANAGED_APPS_QUOTAS_JSON` | no | `{"free":0,"pro":1000,"team":5000,"business":25000}` | Per-plan monthly execution quotas (JSON object). |
| `MANAGED_APPS_GLOBAL_MONTHLY_CAP` | no | `100000` | Global monthly execution cap across all customers. |
| `MANAGED_APPS_DATA_DIR` | no | `./data` | Directory for `usage.jsonl` + `store.json`. |
| `FRONTDOOR_HANDOFF_PRIVATE_KEY` | only for `scripts/mint-token.mjs` | — | Front-door Ed25519 **private** key PEM (operator machine only; never set on this service's host for serving). |

Instances point at a hosted deployment with `KRIYADOT_MANAGED_APPS_URL`
(instance-side env; not read by this service).

## Develop

```sh
npm run build --workspace=@mvp/managed-apps   # tsc
npm run test  --workspace=@mvp/managed-apps   # vitest (mock Composio, no paid calls)
npm run start --workspace=@mvp/managed-apps   # node dist/index.js
```
