<!-- SPDX-License-Identifier: Apache-2.0 -->
# Decision: the gateway / balance question (#2) — per-user Lightning accounts

**Status:** decided for the Octomind-parity closure build (2026-10-30).
**Scope:** closure item #2 (unified gateway login + single shared balance)
and cloud rows C2/C3/C4/C10/C12.

## Decision

KriyaDot's answer to Octomind's "Hub" (one login, all models at provider
price, one prepaid balance) is **per-user Lightning accounts**:

- Each user connects **their own** Lightning AI account with one explicit
  "Connect Lightning" step (they paste their own programmatic-login user
  ID + API key into KriyaDot's encrypted vault — see
  `apps/api/src/cloud-routes.ts`). There is no silent auto-sign-in and no
  OAuth connect flow, because Lightning offers neither.
- Their cloud machine is a Studio **in their account**, driven through
  the official SDK/CLI (`apps/api/src/cloud-lightning.ts`), deployed and
  kept reachable by KriyaDot (`cloud-deploy.ts`, `cloud-supervisor.ts`).
- Their **balance lives at Lightning**. Lightning bills the user
  directly; KriyaDot never holds, pools, resells, or margins cloud
  credits. No public Lightning partner/reseller program exists, and
  KriyaDot does not collect money for Lightning capacity.
- The in-app usage surface (`GET /cloud/lightning/usage`) shows only
  SDK-visible facts (Studio status, machine, teamspace, disk usage) and
  **deep-links to Lightning** for credits/billing, because no documented
  Lightning API exposes a credit balance. KriyaDot never fabricates a
  balance number.
- Upgrades are Lightning's own plans, surfaced as descriptors with a
  deep link to Lightning's pricing/checkout
  (`GET /cloud/lightning/plans`). Prices are never hard-coded — they
  change too often to quote honestly.

## Why not a KriyaDot-hosted gateway

A KriyaDot-operated gateway (KriyaDot-funded upstream keys behind a
hosted proxy, one KriyaDot balance for all users) was the alternative.
It is rejected because it:

1. **Contradicts the architecture.** KriyaDot is local-first and
   BYOK: it hosts nothing multi-tenant. A gateway makes KriyaDot a
   hosted intermediary for every user's model traffic.
2. **Creates open-ended cost and abuse exposure.** Anonymous or pooled
   "free" capacity is paid for by someone; a shared KriyaDot balance is
   a shared abuse target (the same lesson as the keyless-LLM research:
   vendor-subsidized free lanes are client-locked or shared-quota, and
   embedding a shared key violates provider key models).
3. **Adds a billing business.** Pooling balances means payments,
   metering-grade accounting, refunds, and fraud handling — none of
   which is the product.
4. **Has no reseller basis.** Surfacing a vendor's plans and linking to
   their checkout is standard; reselling their capacity is not offered.

## Consequences

- #2 stays an honest **deliberate difference**, not a defect: the
  "single balance" a user experiences is their Lightning balance, one
  deep link away, and their model providers remain their own BYOK keys
  in their vault.
- Free tier is described honestly everywhere: one small CPU Studio,
  always *reachable* (wake-on-traffic, 4-hourly restarts), never
  "always-on"; uninterrupted always-on is the user's own Lightning Pro.
- Public shipping of the connect flow remains gated on confirming
  Lightning's ToS position on credential delegation (see the
  `CLOUD_SHIPPING_NOTE` at the top of `cloud-routes.ts`).

## References

- `hidden_files/lightning-ai-cloud-feasibility.md` (2026-10-29) — the
  evidence base for everything above.
- `hidden_files/keyless-free-llm-research.md` (2026-10-29) — why no
  shared-key / Zen-clone gateway ships either; the keyless story is the
  local Ollama sidecar plus documented anonymous lanes, per-user.
