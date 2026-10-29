// SPDX-License-Identifier: Apache-2.0
// Documented exit-code contract for the kriyadot CLI (Octomind parity:
// scriptable CLIs publish stable exit codes so CI and shell scripts can
// branch on *why* a run ended, not just that it ended).
//
//   0    success — the command completed.
//   1    generic error — the API was unreachable, the turn failed, a bot
//        or thread was not found, a file could not be read, …
//   2    usage error — the invocation itself is malformed: unknown
//        command, missing required flag, bad --format, unknown -c key.
//        Nothing was sent to the API.
//   75   resumable stop (EX_TEMPFAIL) — the run stopped on a condition
//        that is expected to clear, currently a spend-cap / usage-limit
//        hard stop (`spend_cap_reached` event from the API). The session
//        is intact: re-run later (or with `--daemon <name>` /
//        `send <name>`) to continue where it left off.
//   130  interrupted — the user pressed Ctrl+C (128 + SIGINT).

export const EXIT_SUCCESS = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_RESUMABLE = 75;
export const EXIT_INTERRUPTED = 130;

/** One-line-per-code summary, used by the help text. */
export const EXIT_CODE_LINES: string[] = [
  'Exit codes:',
  '  0    Success',
  '  1    Generic error (API unreachable, turn failed, not found, …)',
  '  2    Usage error (unknown command, missing flag, bad -c key, …)',
  '  75   Resumable stop (spend cap / usage limit reached — the session',
  '       is intact; re-run or continue it with "send <name>")',
  '  130  Interrupted (Ctrl+C / SIGINT)',
];
