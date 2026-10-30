// SPDX-License-Identifier: Apache-2.0
/**
 * Repo-local policy file (Octomind parity — guardrails as code).
 *
 * A bot workspace may carry `.kriyadot/policy.json`:
 *
 *   {
 *     "rules": [
 *       { "id": "no-prod-deploy", "toolPattern": "^deploy$",
 *         "argPattern": { "arg": "env", "pattern": "^prod" },
 *         "effect": "require-approval", "reason": "prod deploys need a human" },
 *       { "id": "publish-after-review", "toolPattern": "^publish$",
 *         "requiresHistory": { "toolPattern": "^review" },
 *         "effect": "allow" }
 *     ]
 *   }
 *
 * Rules may also carry argument-qualified history conditions
 * (`requiresHistory.argDigest` / `.argPattern`, #66) and domain
 * allowlists (`domains`, #122). The top level may carry
 * `"policySnapshot": true` to opt the workspace into snapshot-mode
 * evaluation at session start (#70; default is live evaluation).
 *
 * The file is parsed into BotPolicy rules and merged AHEAD of the bot's
 * own configured rules (the workspace is the most specific scope — the
 * project itself gets the final say on its guardrails), which in turn
 * precede the global policy. Malformed files and invalid rules are
 * skipped with collected error strings — a broken policy file must
 * never break turns, and every skip is surfaced to the caller for
 * display/audit. Results are cached per path on an mtime/size signature.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BotPolicy, BotPolicyRule } from './bot-policy.js';

export interface PolicyFileResult {
  policy: BotPolicy;
  /** Human-readable problems found while loading (skipped rules/files). */
  errors: string[];
  /** Path of the policy file, when one exists. */
  path?: string;
  /**
   * Opt-in policy snapshot mode (#70): true when the policy file
   * carries `"policySnapshot": true`. The host captures an immutable
   * snapshot of the effective merged policy at session start and
   * evaluates against it (see policy-snapshot.ts). Absent = live
   * evaluation (the default, deliberate KriyaDot difference).
   */
  policySnapshot?: boolean;
}

const cache = new Map<string, { signature: string; result: PolicyFileResult }>();

const EFFECTS = new Set(['allow', 'deny', 'require-approval']);

function validRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function parseRule(raw: unknown, index: number, errors: string[]): BotPolicyRule | null {
  if (typeof raw !== 'object' || raw === null) {
    errors.push(`rule ${index}: not an object — skipped`);
    return null;
  }
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && r.id ? r.id : `policy-file-${index}`;
  const toolPattern = typeof r.toolPattern === 'string' ? r.toolPattern : '';
  const effect = typeof r.effect === 'string' ? r.effect : '';
  if (!toolPattern || !validRegex(toolPattern)) {
    errors.push(`rule "${id}": missing or invalid toolPattern — skipped`);
    return null;
  }
  if (!EFFECTS.has(effect)) {
    errors.push(`rule "${id}": invalid effect "${effect}" — skipped`);
    return null;
  }
  const rule: BotPolicyRule = {
    id,
    toolPattern,
    effect: effect as BotPolicyRule['effect'],
    reason: typeof r.reason === 'string' ? r.reason : undefined,
  };
  if (r.argPattern !== undefined) {
    const ap = r.argPattern as Record<string, unknown> | null;
    if (
      typeof ap !== 'object' ||
      ap === null ||
      typeof ap.arg !== 'string' ||
      typeof ap.pattern !== 'string' ||
      !validRegex(ap.pattern)
    ) {
      errors.push(`rule "${id}": invalid argPattern — rule skipped`);
      return null;
    }
    rule.argPattern = { arg: ap.arg, pattern: ap.pattern };
  }
  if (r.requiresHistory !== undefined) {
    const rh = r.requiresHistory as Record<string, unknown> | null;
    if (
      typeof rh !== 'object' ||
      rh === null ||
      typeof rh.toolPattern !== 'string' ||
      !validRegex(rh.toolPattern)
    ) {
      errors.push(`rule "${id}": invalid requiresHistory — rule skipped`);
      return null;
    }
    // Argument-qualified conditions (#66): optional argDigest (exact
    // hex digest) and/or argPattern (RegExp over the entry's summary).
    if (rh.argPattern !== undefined && (typeof rh.argPattern !== 'string' || !validRegex(rh.argPattern))) {
      errors.push(`rule "${id}": invalid requiresHistory.argPattern — rule skipped`);
      return null;
    }
    if (rh.argDigest !== undefined && (typeof rh.argDigest !== 'string' || !/^[0-9a-f]{64}$/i.test(rh.argDigest))) {
      errors.push(`rule "${id}": invalid requiresHistory.argDigest (want 64 hex chars) — rule skipped`);
      return null;
    }
    rule.requiresHistory = {
      toolPattern: rh.toolPattern,
      minCount: typeof rh.minCount === 'number' && rh.minCount > 0 ? Math.floor(rh.minCount) : undefined,
      argDigest: typeof rh.argDigest === 'string' ? rh.argDigest : undefined,
      argPattern: typeof rh.argPattern === 'string' ? rh.argPattern : undefined,
    };
  }
  if (r.domains !== undefined) {
    // Domain-bound capability (#122): a non-empty array of domain strings.
    if (
      !Array.isArray(r.domains) ||
      r.domains.length === 0 ||
      r.domains.some((d) => typeof d !== 'string' || !d.trim())
    ) {
      errors.push(`rule "${id}": invalid domains (want a non-empty string array) — rule skipped`);
      return null;
    }
    rule.domains = (r.domains as string[]).map((d) => d.trim());
  }
  return rule;
}

/** Load `<workspaceDir>/.kriyadot/policy.json`. Never throws. */
export function loadWorkspacePolicy(workspaceDir: string): PolicyFileResult {
  const path = join(workspaceDir, '.kriyadot', 'policy.json');
  let signature = '-';
  try {
    const s = statSync(path);
    signature = `${s.mtimeMs}:${s.size}`;
  } catch {
    return { policy: { rules: [] }, errors: [] };
  }
  const cached = cache.get(path);
  if (cached && cached.signature === signature) return cached.result;

  const errors: string[] = [];
  let policy: BotPolicy = { rules: [] };
  let policySnapshot = false;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      rules?: unknown;
      policySnapshot?: unknown;
    };
    if (parsed.policySnapshot !== undefined) {
      if (typeof parsed.policySnapshot === 'boolean') {
        policySnapshot = parsed.policySnapshot;
      } else {
        errors.push('policy.json: "policySnapshot" must be a boolean — ignored');
      }
    }
    if (Array.isArray(parsed.rules)) {
      const rules: BotPolicyRule[] = [];
      parsed.rules.forEach((raw, i) => {
        const rule = parseRule(raw, i, errors);
        if (rule) rules.push(rule);
      });
      policy = { rules, ...(policySnapshot ? { policySnapshot: true } : {}) };
    } else {
      errors.push('policy.json: "rules" must be an array');
    }
  } catch (err) {
    errors.push(`policy.json: unreadable (${err instanceof Error ? err.message : String(err)})`);
  }
  const result: PolicyFileResult = {
    policy,
    errors,
    path,
    ...(policySnapshot ? { policySnapshot: true } : {}),
  };
  cache.set(path, { signature, result });
  return result;
}

/** Test hook. */
export function clearWorkspacePolicyCache(): void {
  cache.clear();
}
