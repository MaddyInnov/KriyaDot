// SPDX-License-Identifier: Apache-2.0
// Per-bot governance policy persistence.
//
// Bot configs ship in seed/bots.json (immutable at runtime, and embedded in
// the single-file binary). Per-bot policy edits from the UI are overlaid in
// <dataDir>/bot-policies.json: { "<botId>": { "rules": [...] } }. The file is
// applied onto the in-memory bots at boot (HOST WIRING: call
// applyBotPolicies(seed.bots, config.dataDir) in index.ts before the router
// and the governance adapter are built) and updated by
// PUT /api/bots/:id/policy.
//
// A bot with no entry here (and no policy in seed) evaluates against the
// global governance policy unchanged.

import fs from 'node:fs';
import path from 'node:path';
import type { BotConfig, BotPolicy, BotPolicyRule } from '@mvp/agent-runtime';

const POLICIES_FILE = 'bot-policies.json';

export function botPoliciesPath(dataDir: string): string {
  return path.join(dataDir, POLICIES_FILE);
}

type PolicyFile = Record<string, { rules: BotPolicyRule[] }>;

/** Validate a rules payload from the API. Throws on the first problem. */
export function validatePolicyRules(value: unknown): BotPolicyRule[] {
  if (!Array.isArray(value)) {
    throw new Error('policy.rules must be an array');
  }
  if (value.length > 50) {
    throw new Error('policy.rules: at most 50 rules per bot');
  }
  const ids = new Set<string>();
  return value.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`policy.rules[${i}]: must be an object`);
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id.trim()) {
      throw new Error(`policy.rules[${i}].id: required non-empty string`);
    }
    if (ids.has(r.id)) {
      throw new Error(`policy.rules[${i}].id: duplicate rule id "${r.id}"`);
    }
    ids.add(r.id);
    if (typeof r.toolPattern !== 'string' || !r.toolPattern) {
      throw new Error(`policy.rules[${i}].toolPattern: required non-empty string`);
    }
    try {
      // Compile now: an invalid pattern fails closed later (no match), but
      // the editor should catch typos at save time.
      new RegExp(r.toolPattern, 'i');
    } catch {
      throw new Error(`policy.rules[${i}].toolPattern: invalid regular expression`);
    }
    if (r.effect !== 'allow' && r.effect !== 'deny' && r.effect !== 'require-approval') {
      throw new Error(
        `policy.rules[${i}].effect: must be "allow", "deny", or "require-approval"`,
      );
    }
    const rule: BotPolicyRule = {
      id: r.id.trim(),
      toolPattern: r.toolPattern,
      effect: r.effect,
    };
    if (r.reason !== undefined) {
      if (typeof r.reason !== 'string') {
        throw new Error(`policy.rules[${i}].reason: must be a string`);
      }
      if (r.reason.trim()) rule.reason = r.reason.trim();
    }
    return rule;
  });
}

/** Load the overlay file. Missing/corrupt → {} (warn, fail open to seed). */
export function loadBotPolicies(dataDir: string): PolicyFile {
  try {
    const raw = fs.readFileSync(botPoliciesPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: PolicyFile = {};
    for (const [botId, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null) continue;
      try {
        out[botId] = { rules: validatePolicyRules((entry as { rules?: unknown }).rules) };
      } catch (err) {
        console.warn(
          `[bot-policies] dropping invalid entry for bot "${botId}": ${(err as Error).message}`,
        );
      }
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[bot-policies] could not read ${POLICIES_FILE}: ${(err as Error).message}`);
    }
    return {};
  }
}

/**
 * Apply the overlay onto in-memory bot configs (mutates the array entries).
 * Seed-embedded policies win when present; the overlay fills in bots whose
 * seed entry has no policy.
 */
export function applyBotPolicies(bots: BotConfig[], dataDir: string): void {
  const overlay = loadBotPolicies(dataDir);
  const ids = Object.keys(overlay);
  if (ids.length === 0) return;
  for (const bot of bots) {
    const entry = overlay[bot.id];
    if (entry && !bot.policy) {
      const policy: BotPolicy = { rules: entry.rules };
      bot.policy = policy;
    }
  }
  console.log(`[bot-policies] applied per-bot policies for ${ids.length} bot(s)`);
}

/** Persist one bot's policy (validates first) and update the in-memory bot. */
export function saveBotPolicy(
  dataDir: string,
  bots: BotConfig[],
  botId: string,
  rules: unknown,
): BotPolicy {
  const bot = bots.find((b) => b.id === botId);
  if (!bot) throw new Error(`Unknown bot "${botId}"`);
  const validated = validatePolicyRules(rules);
  const policy: BotPolicy = { rules: validated };
  const file = loadBotPolicies(dataDir);
  file[botId] = { rules: validated };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(botPoliciesPath(dataDir), JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  bot.policy = policy;
  return policy;
}

/**
 * "Always allow this tool" — appends a persistent allow rule for one tool
 * to the bot's policy (deduped). Future calls to the tool skip the approval
 * card entirely. This is the "remember my choice" behind the approval UI.
 */
export function rememberAllowedTool(
  dataDir: string,
  bots: BotConfig[],
  botId: string,
  tool: string,
): BotPolicy {
  const bot = bots.find((b) => b.id === botId);
  if (!bot) throw new Error(`Unknown bot "${botId}"`);
  const file = loadBotPolicies(dataDir);
  const existing = file[botId]?.rules ?? bot.policy?.rules ?? [];
  const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ruleId = `user-allow-${tool}`;
  const already = existing.some((r) => r.id === ruleId);
  const rules = already
    ? existing
    : [
        {
          id: ruleId,
          toolPattern: `^${escaped}$`,
          effect: 'allow' as const,
          reason: `User chose "always allow" for ${tool}`,
        },
        ...existing,
      ];
  return saveBotPolicy(dataDir, bots, botId, rules);
}
