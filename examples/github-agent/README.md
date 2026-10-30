<!-- SPDX-License-Identifier: Apache-2.0 -->

# KriyaDot GitHub-native agent pack (CA-22)

Two ways to drive KriyaDot from GitHub, both governed by the instance:

1. **Comment commands** — copy `.github/workflows/kriyadot.yml` into your
   repo, set the `KRIYADOT_WEBHOOK_URL` (your instance's
   `/api/github-agent/webhook`, exposed via your tunnel of choice) and
   `KRIYADOT_WEBHOOK_SECRET` repo secrets. Then comment on any issue or PR:

   - `/kriyadot run <task>` — dispatch a governed agent run (the instance
     routes it through its existing webhooks→routines executor).
   - `/kriyadot review` — on a PR, generate a review and post it through
     the instance's approval-gated `POST /api/github/pr` review path.
   - `/kriyadot help` — recognised and ignored (documented no-op).

   Signatures are HMAC-SHA256 verified on the instance
   (`apps/api/src/github-agent.ts`); unsigned or badly signed deliveries
   get a 401 and never dispatch.

2. **GitHub Action** — use `action.yml` from a workflow in CI to run a
   task against a bot and optionally post the result as a PR review
   (again via the instance, never directly to the GitHub API).

No GitHub token ever lives in this pack: the instance holds its own
token and its own governance approvals.
