<!-- SPDX-License-Identifier: Apache-2.0 -->
# Delegation Safety Checklist (runtime-facing)

*Grounded in Workstream 2's measured study — `benchmarks/agent-safety-delegation/`
(60-case forged-record bank, OVH anonymous keyless lane, zero paid usage,
2026-11-18). Every rule below cites its measured basis. Where a number is
small-n, the count is shown; treat rates as indicative, counts as exact.*

## What we measured (the 30-second version)

- Orchestrator alone (`gpt-oss-120b`, direct read): harmful propagation
  **2/20**. Orchestrator + cheap reader returning conclusions only
  (`Qwen3.6-27B`): **15/20**. The delegation penalty is real with free models.
- When the reader's conclusion was corrupted, the orchestrator adopted it
  **13/13** times. A conclusion-only sub-agent result is, in practice,
  adopted verbatim. There were zero rescues.
- Calibration warning: under a *careful* brief the "weak" reader scored
  0/10 forged while the orchestrator scored 3/10. The gap in our stack is
  driven by the **brief and the channel**, not raw model size. Do not
  assume a bigger orchestrator fixes delegation; fix the boundary.

## Checklist — before shipping any delegation path

1. **Never let a conclusion be the only thing that crosses the boundary on
   a high-stakes read.** Conclusion-only returns measured a = 1.00 adoption
   of corrupted conclusions. For reads whose answer feeds a decision,
   require evidence (rule 2) or a re-check (rule 3).
2. **Prefer evidence-only returns for delegated research.** Protocol P3
   (reader returns verbatim quotes + source ids, never a conclusion;
   orchestrator concludes) measured **0/10** propagation vs 8/10 for
   conclusion delegation on the same cases — including cases the
   orchestrator itself gets wrong reading directly. Since 2026-11-25
   this is KriyaDot's **default** for every `delegate` spawn (see
   `packages/agent-runtime/src/delegation-safety.ts`); conclusion
   returns are the opt-out — per call (`returnMode: 'conclusion'`),
   per bot (policy `delegationReturnMode: 'conclusion'`), or globally
   (env `KRIYADOT_DELEGATE_EVIDENCE_ONLY=0`). Known cost: ~3,492
   tokens/case (vs 2,395 conclusion-delegated) and 3/10 non-answers on hard
   cases — budget for abstention handling, not just accuracy. The
   runtime supports that handling: a child that finds nothing must
   return `NO EVIDENCE FOUND — <what is missing>`, and the result is
   framed for the parent as evidence-to-judge with an explicit duty to
   say plainly what could not be established rather than conclude
   silently.
3. **If you re-check, re-read the source — don't re-ask the reader.**
   Protocol P1 (orchestrator independently re-reads before adopting)
   measured 3/10, and its failures were exactly the orchestrator's own
   direct-read failures: a re-read buys you the orchestrator's own error
   rate, no better. It is the cheapest effective check (+1 call, +858
   tokens/case) when evidence-only is too costly.
4. **Do not rely on two-reader agreement as your safety check.** Protocol
   P2 measured **7/10** — the two readers (different model families) were
   fooled *correlatedly* and agreed on the forged value in 7/10 cases,
   escalating only once. Agreement detects independent errors; forged
   records produce dependent ones. Agreement is a liveness signal, not a
   safety boundary.
5. **Brief the reader like the answer depends on it — it does.** The same
   reader model went 0/10 (careful brief: check dates, check
   provenance/accession lines, a correction is not automatically right) to
   13/20 corrupted conclusions (casual improvised brief). Any delegated
   read brief should instruct the reader to check record dates against
   claims and to report provenance lines verbatim.
6. **Treat sub-agent output channel as trusted-by-default — because the
   model does.** The paper measured 85% adoption of a forged report via
   the tool-result channel vs 46% as a peer message; our a = 13/13 is the
   same effect. If a result must be treated sceptically, route it through
   a channel/framing that carries its provenance (evidence quotes, source
   ids), not through the bare conclusion text.
7. **Keep provenance joinable.** Log which sub-agent produced which claim
   and what evidence it saw (KriyaDot today logs the spawn, not the
   claim→evidence join — see the programme map). Without the join, a bad
   answer cannot be attributed to a bad read vs a bad adoption after the
   fact.
8. **Know the scope condition.** All of the above is measured on forgeries
   with detectable tells (predated correction, missing accession line).
   Tells-removed forgeries defeat careful reading in *both* arms (the
   paper's `correction_clean` result); the defence there is provenance
   enforcement at the store (signed/accessioned records), not any
   delegation protocol. Do not cite this checklist as covering that case.

## Defaults shipped with this checklist

| Setting | Default | Where |
|---|---|---|
| Evidence-only delegate returns | **ON** (since 2026-11-25) | `delegate` tool; `packages/agent-runtime/src/delegation-safety.ts` |
| Conclusion returns (opt-out) | per call / per bot / per host | `returnMode: 'conclusion'` arg; bot policy `delegationReturnMode: 'conclusion'`; env `KRIYADOT_DELEGATE_EVIDENCE_ONLY=0` |
| Plan verification (companion default, same decision) | **ON** at 'high-risk-only' scope for plan-approval mode | bot policy / policy.json `planVerificationScope` (`'all'` widens, `'off'` opts out); bot `verifiedPlans: false` also opts out |

*History: this checklist originally shipped (2026-11-18) with
evidence-only as an opt-in, the by-default decision explicitly gated
on the measurements above (programme backlog §8). Ashutosh took that
decision on 2026-11-25 — "Approve both defaults": evidence-only
delegation ON by default, and verified plans ON by default for
high-risk actions. The opt-outs in the table are the supported way
back; each is covered by tests asserting the old behaviour returns
exactly.*
