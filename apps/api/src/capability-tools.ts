// SPDX-License-Identifier: Apache-2.0
// Capability discovery tool (closure addendum ADD-2): `discover_capabilities`.
//
// Available to EVERY bot (registered into the shared tool registry and
// granted to the whole roster by grantCapabilityToolsToBots — the same
// boot-overlay pattern as applyComposioToolGrants). A bot mid-task asks in
// plain language — "what in KriyaDot can send a WhatsApp message / run
// while the PC is off / turn this into a recurring job?" — and gets back
// the top matching capabilities from the GENERATED registry
// (capabilities.ts): the feature/bot/tool/flow that handles it, how to
// invoke it, and, when the match is a cross-feature flow, a structured
// `handoff` object the agent can act on in place instead of asking the
// user to navigate.
//
// The tool is strictly READ-ONLY (it inspects a registry snapshot; it
// cannot invoke anything), so capabilityToolsPolicyRules() auto-allows it
// like the other read-only inspection tools.
//
// HOST WIRING (index.ts): registerCapabilityTools({ registry: toolRegistry,
// service: capabilityService }) alongside the other register*Tools calls,
// grantCapabilityToolsToBots(seed.bots) with the other boot overlays, and
// prepend capabilityToolsPolicyRules() to the global policy next to
// permissionsToolsPolicyRules().

import type { BotConfig, BotPolicyRule, ToolDefinition } from '@mvp/agent-runtime';
import type { CapabilityService } from './capabilities.js';

export const DISCOVER_CAPABILITIES_TOOL = 'discover_capabilities';

export const CAPABILITY_TOOL_NAMES = [DISCOVER_CAPABILITIES_TOOL] as const;

/** Policy rules auto-allowing the read-only discovery tool (cf. allow-reads). */
export function capabilityToolsPolicyRules(): BotPolicyRule[] {
  return [
    {
      id: 'allow-capability-discovery',
      toolPattern: `^(${CAPABILITY_TOOL_NAMES.join('|')})$`,
      effect: 'allow',
      reason:
        'discover_capabilities is a read-only lookup over the generated capability registry; it cannot invoke or change anything',
    },
  ];
}

export interface CapabilityToolsDeps {
  service: CapabilityService;
}

export function createCapabilityTools(deps: CapabilityToolsDeps): ToolDefinition[] {
  const discoverCapabilities: ToolDefinition = {
    name: DISCOVER_CAPABILITIES_TOOL,
    description: [
      'Discover what in KriyaDot can do something, in plain language.',
      'Ask about a NEED, not a name: "send a WhatsApp message", "run while',
      'the PC is off", "turn this into a recurring job", "publish this as a',
      'shareable page". Returns the top matching capabilities — bots, tools,',
      'skills, workflows, plugins, channels and product features — each with',
      'what it does, when to use it, and exactly how to invoke it (bot id,',
      'tool name, or the flow to start). When the best match belongs to',
      'another feature, the result also carries a `handoff` object: propose',
      'it to the user and start that flow in place instead of asking them',
      'to navigate. Use this whenever you are unsure which feature, bot or',
      'tool handles a request. Read-only: it never invokes anything itself.',
      'Returns { query, matches: [{ id, name, kind, whatItDoes, whenToUse,',
      'howToInvoke, score }], handoff?: { capabilityId, name, label,',
      'action, note } }.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The need, in plain language (e.g. "run this every morning while my PC is off").',
        },
        limit: {
          type: 'number',
          description: 'Max matches to return (default 5, max 10).',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return { error: 'query is required' };
      const limit = typeof args.limit === 'number' && Number.isFinite(args.limit)
        ? Math.max(1, Math.min(10, Math.floor(args.limit)))
        : 5;
      const hits = deps.service.search(query, { limit });
      const handoffs = deps.service.suggestHandoffs(query, { limit: 1 });
      return {
        query,
        matches: hits.map((h) => ({
          id: h.entry.id,
          name: h.entry.name,
          kind: h.entry.kind,
          whatItDoes: h.entry.whatItDoes,
          whenToUse: h.entry.whenToUse,
          howToInvoke: h.entry.howToInvoke,
          score: h.score,
        })),
        ...(handoffs[0] ? { handoff: handoffs[0] } : {}),
      };
    },
  };
  return [discoverCapabilities];
}

/** Register the discovery tool into a tool registry (skips on collision, like registerPermissionsTools). */
export function registerCapabilityTools(
  deps: CapabilityToolsDeps & { registry: Map<string, ToolDefinition> },
): void {
  for (const tool of createCapabilityTools(deps)) {
    if (!deps.registry.has(tool.name)) {
      deps.registry.set(tool.name, tool);
    }
  }
}

/**
 * Grant discover_capabilities to every bot on the roster (in-memory
 * overlay; seed files untouched — same pattern as applyComposioToolGrants
 * and the chief boot overlays). Bots only see tools named in their
 * `tools` allowlist, so registration alone is not enough: the name must
 * ride on every BotConfig. Call at boot; bots created later should be
 * granted by their creation path (or the next boot).
 */
export function grantCapabilityToolsToBots(bots: BotConfig[]): void {
  for (const bot of bots) {
    if (!Array.isArray(bot.tools)) bot.tools = [];
    for (const name of CAPABILITY_TOOL_NAMES) {
      if (!bot.tools.includes(name)) bot.tools.push(name);
    }
  }
}
