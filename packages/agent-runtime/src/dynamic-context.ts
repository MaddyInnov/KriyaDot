// SPDX-License-Identifier: Apache-2.0
/**
 * Dynamic context injection (CA-15 / CA-16): the `` !`cmd` `` mechanic.
 *
 * Skill bodies and slash-command templates may embed `` !`some command` ``;
 * when the skill/command activates, the command runs and its stdout is
 * spliced into the text in place of the marker. This is a SHELL EXECUTION
 * surface, so it is governance-gated by construction:
 *
 *  - The caller MUST supply a `gate` that classifies the command
 *    ('allow' | 'deny' | 'require-approval'). Anything other than an
 *    explicit 'allow' means the command does NOT run — 'require-approval'
 *    is treated as not-approved here because injection happens inline,
 *    without an approval-card round-trip.
 *  - The caller MUST supply a `runner` (the governed shell path). This
 *    module never spawns a process itself.
 *  - With no gate or no runner, every marker degrades to an explicit
 *    "[not run: …]" note — never to silent execution, never to the raw
 *    marker leaking to the model as if it were output.
 *
 * Output is size-capped per marker and in total.
 */

export type ShellInjectionDecision = 'allow' | 'deny' | 'require-approval';

export interface ShellInjectionGate {
  (command: string): Promise<ShellInjectionDecision> | ShellInjectionDecision;
}

export interface ShellInjectionRunner {
  (command: string): Promise<string> | string;
}

export interface ShellInjectionOptions {
  gate?: ShellInjectionGate;
  runner?: ShellInjectionRunner;
  /** Per-marker output cap (chars). Default 4000. */
  maxPerMarkerChars?: number;
  /** Total injected output cap across all markers (chars). Default 12000. */
  maxTotalChars?: number;
}

/** Marker syntax: !`command` — command may not contain backticks/newlines. */
export const SHELL_INJECTION_PATTERN = /!`([^`\n]+)`/g;

/** True when `text` contains at least one `` !`cmd` `` marker. */
export function hasShellInjections(text: string): boolean {
  SHELL_INJECTION_PATTERN.lastIndex = 0;
  return SHELL_INJECTION_PATTERN.test(text);
}

/** The commands embedded in `text`, in order (no execution). */
export function listShellInjections(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/!`([^`\n]+)`/g)) out.push(m[1]!.trim());
  return out;
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[injected output truncated]` : text;
}

/**
 * Expand every `` !`cmd` `` marker in `text`. Governance-gated: a marker
 * only executes when `gate` returns 'allow' AND a `runner` is present.
 * Runner failures degrade to an explicit error note (the surrounding
 * skill/command still activates — its static text is intact).
 */
export async function expandShellInjections(
  text: string,
  opts: ShellInjectionOptions = {},
): Promise<string> {
  const matches = [...text.matchAll(/!`([^`\n]+)`/g)];
  if (matches.length === 0) return text;
  const perMarker = opts.maxPerMarkerChars ?? 4000;
  let totalBudget = opts.maxTotalChars ?? 12_000;
  let out = '';
  let cursor = 0;
  for (const m of matches) {
    out += text.slice(cursor, m.index);
    cursor = m.index + m[0].length;
    const command = m[1]!.trim();
    if (!opts.gate || !opts.runner) {
      out += `[shell injection not run: no governed shell path available for \`${command}\`]`;
      continue;
    }
    let decision: ShellInjectionDecision;
    try {
      decision = await opts.gate(command);
    } catch {
      decision = 'deny';
    }
    if (decision !== 'allow') {
      out += `[shell injection denied by governance: \`${command}\`]`;
      continue;
    }
    try {
      const raw = String(await opts.runner(command));
      const capped = cap(raw.trim(), Math.min(perMarker, Math.max(0, totalBudget)));
      totalBudget -= capped.length;
      out += capped;
    } catch (err) {
      out += `[shell injection failed: \`${command}\` — ${err instanceof Error ? err.message : String(err)}]`;
    }
  }
  out += text.slice(cursor);
  return out;
}
