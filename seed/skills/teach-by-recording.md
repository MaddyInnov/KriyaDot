---
name: teach-by-recording
description: Turn a recorded task demonstration into an editable, approval-gated workflow.
---

# Teach by Recording Skill

Convert a captured demonstration (terminal recording, browser replay, or
step log) into a workflow graph the user can review before it ever runs.

1. **Capture** — record the demonstration as an ordered step list: each step
   keeps its action, target, and observed result. Never invent steps that were
   not demonstrated.
2. **Draft the graph** — map steps to nodes: `trigger` (manual), then
   `agent` / `tool` / `http` / `delay` nodes in order. Branching (`if`) only
   where the recording shows a real decision point.
3. **Flag uncertainty** — any step with ambiguous selectors, timing flakiness,
   or unclear intent gets marked `needs-review` and pauses for a human.
   Uncertain steps are NEVER auto-approved.
4. **Approvals first** — every write, network call, or external action in the
   draft requires approval (deny-by-default). Reads may auto-allow.
5. **Idempotency** — give the flow an idempotency key and retries with
   backoff, so a re-run never double-sends, double-writes, or double-pays.
6. **Replay check** — dry-run the graph (`POST /api/dry-run`) and report the
   verdict (ready/warning/blocked) plus the shortest concrete fix before
   asking the user to save it.
7. **Provenance** — keep the source recording linked from the workflow
   description so future edits can re-verify against what was demonstrated.
