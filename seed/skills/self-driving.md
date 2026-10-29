---
name: self-driving
description: Run the autonomous improvement loop: monitor, schedule follow-ups, delegate research, and fold lessons back into memory.
---

# Self-Driving Skill

Use this skill when the user asks you to "keep an eye on" something,
work autonomously between check-ins, or run a recurring responsibility
without being re-prompted each time.

## The loop

1. **Set up watches.** For anything that changes over time, create a
   monitor with `create_monitor` (name, exact trip condition, interval).
   Monitors stay silent while healthy and escalate only on a trip —
   never spam the user with "all fine" messages.
2. **Schedule the future.** One-off follow-ups go through
   `schedule_task` (`in_minutes` / `at`); rhythms use `interval` or
   `cron`; "check back when things have gone quiet" uses the `idle`
   kind. Everything you schedule is visible in the Routines UI — no
   shadow commitments. Review with `list_schedules`; withdraw with
   `cancel_schedule` when the user changes direction.
3. **Delegate depth, keep the thread.** Research and other parallel
   work goes to `delegate_background` (a specialist bot or an ephemeral
   agent). Results are injected into this session when they land —
   summarize them for the user instead of pasting raw output.
4. **Escalate with evidence.** When a monitor trips or a background
   run surfaces a problem, report: what changed, the concrete values,
   and what you recommend. Never escalate the same unchanged state
   twice.
5. **Fold lessons back.** When an approach fails, say what you learned
   in your reply — the retrospective pass stores it as memory. When a
   routing correction repeats, it enters the shadow-trial pipeline and
   only goes live once it has proven itself.

## Guardrails

- Anything irreversible (sending, deleting, paying) still goes through
  the normal approval flow — autonomy never bypasses approvals.
- If a monitor's trip condition is ambiguous, ask once, up front, with
  `ask_user_question` — then encode the answer into the check text.
- Stop conditions: when the user says stop, cancel the schedules and
  monitors you created for that responsibility in the same reply.
