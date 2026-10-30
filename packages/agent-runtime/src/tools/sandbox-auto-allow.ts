// SPDX-License-Identifier: Apache-2.0
/**
 * Sandbox-auto-allow mode (closure CA-3) — OPT-IN, default OFF.
 *
 * Claude Code's sandbox-as-permission-boundary, in KriyaDot's shape:
 * when a bot/session explicitly opts in (`sandboxAutoAllow: true` on
 * the bot config or its policy), shell calls that are FULLY confined
 * by a real sandbox backend (Docker container, Landlock/Seatbelt
 * kernel sandbox, E2B cloud sandbox) skip the approval prompt —
 * containment replaces the prompt for those calls only.
 *
 * Hard lines that this mode NEVER crosses:
 *   - Catastrophic commands stay hard-denied (the governance hard
 *     floor and the tool-level denylist run before/regardless of this
 *     evaluation; this module independently refuses them too).
 *   - Explicit deny rules still apply: this evaluator is consulted
 *     only to convert a would-be 'require-approval' into 'allow' —
 *     the governance adapter checks it AFTER hard floors and never
 *     overrides a policy 'deny' (see governance-adapter wiring).
 *   - Unconfined paths do NOT qualify: host execution (explicit
 *     opt-out or availability fallback) and 'none' always prompt.
 *   - Default OFF: with the flag absent/false, decisions are exactly
 *     what they were before this module existed.
 */

import type { BotPolicy, BotPolicyRule } from '../types.js';
import { isCatastrophicCommand } from './builtin.js';
import { sandboxBackend, type SandboxBackend } from './sandbox.js';
import { isConfinedBackend } from './spawn-shared.js';

export { isConfinedBackend };

/** Tools whose calls may be auto-allowed under this mode. */
export const SANDBOX_AUTO_ALLOW_TOOLS: readonly string[] = ['run_command', 'run_background'];

export interface SandboxAutoAllowInput {
  /** The opt-in flag (bot config / policy / per-session). Default false. */
  enabled?: boolean;
  toolName: string;
  /** The shell command (args.command) for command tools. */
  command?: string;
  /** Backend that WOULD execute the call; default: current probe. */
  backend?: SandboxBackend | string;
}

export interface SandboxAutoAllowResult {
  allow: boolean;
  /** True when execution is confined by a qualifying backend. */
  confined: boolean;
  backend: string;
  reason: string;
  /** Set when the refusal is a hard denial, not a prompt fallback. */
  blockedBy?: 'hard-deny';
}

/**
 * Pure decision for one call. `allow: true` means: skip the approval
 * prompt for this call. Every other outcome falls back to the normal
 * governance path (prompt or deny as policy decides) — except
 * catastrophic commands, which are flagged `blockedBy: 'hard-deny'`
 * so callers keep them denied even if some other layer would allow.
 */
export function evaluateSandboxAutoAllow(input: SandboxAutoAllowInput): SandboxAutoAllowResult {
  const backend = input.backend ?? sandboxBackend();
  const confined = isConfinedBackend(backend);
  if (!SANDBOX_AUTO_ALLOW_TOOLS.includes(input.toolName)) {
    return { allow: false, confined, backend, reason: `tool "${input.toolName}" is not a sandbox command tool` };
  }
  if (typeof input.command === 'string' && isCatastrophicCommand(input.command)) {
    return {
      allow: false,
      confined,
      backend,
      reason: 'catastrophic command — hard-denied regardless of sandbox-auto-allow',
      blockedBy: 'hard-deny',
    };
  }
  if (input.enabled !== true) {
    return { allow: false, confined, backend, reason: 'sandbox-auto-allow is off (default) — normal approval path applies' };
  }
  if (!confined) {
    return {
      allow: false,
      confined,
      backend,
      reason: `backend "${backend}" is not confined — unconfined execution never skips the approval prompt`,
    };
  }
  return {
    allow: true,
    confined,
    backend,
    reason: `sandbox-auto-allow: command fully confined by the ${backend} sandbox (opt-in mode)`,
  };
}

/**
 * computerUsePolicyRules-style static rules for hosts that merge bot
 * policy rules ahead of the global policy. NOTE: a static rule cannot
 * express confinement, so these rules must only be merged when the
 * host ALSO gates on evaluateSandboxAutoAllow() (the API governance
 * adapter does exactly that: it consults the evaluator, which checks
 * the live backend, before allowing). Merging these rules alone,
 * without the evaluator gate, would over-allow on host fallbacks.
 */
export function sandboxAutoAllowPolicyRules(): BotPolicyRule[] {
  return [
    {
      id: 'sandbox-auto-allow-commands',
      toolPattern: '^(run_command|run_background)$',
      effect: 'allow',
      reason:
        'Sandbox-auto-allow (opt-in CA-3): command fully confined by the kernel/Docker/cloud sandbox — ' +
        'valid ONLY together with the evaluateSandboxAutoAllow confinement gate; hard denials still apply',
    },
  ];
}

/** Whether a bot-shaped config has the opt-in switched on. */
export function sandboxAutoAllowEnabled(bot?: {
  sandboxAutoAllow?: boolean;
  policy?: BotPolicy;
} | null): boolean {
  return bot?.sandboxAutoAllow === true || bot?.policy?.sandboxAutoAllow === true;
}

/**
 * Return a copy of `policy` with the sandbox-auto-allow rules prepended
 * when (and only when) the opt-in is on. Flag off → the policy is
 * returned unchanged (same reference), defaults untouched.
 */
export function withSandboxAutoAllowRules<T extends BotPolicy>(policy: T, enabled?: boolean): T {
  if (enabled !== true) return policy;
  return { ...policy, rules: [...sandboxAutoAllowPolicyRules(), ...policy.rules] };
}
