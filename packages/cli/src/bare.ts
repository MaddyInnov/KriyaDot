// SPDX-License-Identifier: Apache-2.0
// CA-21: `kriyadot run --bare` — bare mode for deterministic CI runs.
//
// A normal run lets the engine AUTO-DISCOVER context around the turn:
//   hooks     — hook files/handlers that transform or gate the turn
//   skills    — skill catalog auto-activation by intent
//   commands  — slash-command / command-file discovery
//   agents    — agent-definition discovery beyond the named bot
//   mcp       — MCP server catalog auto-activation
//   memory    — memory + turn-context injection
// Auto-discovery is helpful interactively and poison for CI: the same
// command can behave differently on two machines because of what
// happens to be installed. --bare turns ALL of it off. Explicit
// configuration still applies (the named bot, its configured skills/
// tools/MCP servers, governance, approvals): --bare removes
// *discovery*, never *policy*.
//
// Layers:
// - This module is the pure plan + the discovery runner the CLI uses
//   to gate its own discovery call sites (and that tests exercise).
// - The CLI forwards `bare: true` on the chat request; the server maps
//   it to RunTurnOptions.bare in @mvp/agent-runtime, which skips the
//   runtime's skill/MCP auto-activation and memory/context injection
//   (see the wave-6 WIRING note for the one-line server mapping).

/** Every auto-discovery source a bare run disables. */
export const BARE_DISCOVERY_SOURCES = ['hooks', 'skills', 'commands', 'agents', 'mcp', 'memory'] as const;

export type DiscoverySource = (typeof BARE_DISCOVERY_SOURCES)[number];

export interface DiscoveryPlan {
  bare: boolean;
  /** Per-source switch: false for every source when bare. */
  enabled: Record<DiscoverySource, boolean>;
  /** Sources skipped by this plan (all six when bare, none otherwise). */
  skipped: DiscoverySource[];
}

/** Resolve the discovery plan for a run. Pure — no I/O. */
export function resolveDiscoveryPlan(bare: boolean): DiscoveryPlan {
  const enabled = {} as Record<DiscoverySource, boolean>;
  for (const source of BARE_DISCOVERY_SOURCES) enabled[source] = !bare;
  return { bare, enabled, skipped: bare ? [...BARE_DISCOVERY_SOURCES] : [] };
}

/**
 * Run discovery loaders under a plan: a loader is invoked ONLY when
 * its source is enabled in the plan. Returns the results of the
 * loaders that ran, keyed by source. With a bare plan no loader is
 * invoked at all — that is the deterministic-CI guarantee, and the
 * property the tests assert with counting loaders.
 */
export async function runDiscovery<T>(
  plan: DiscoveryPlan,
  loaders: Partial<Record<DiscoverySource, () => Promise<T> | T>>,
): Promise<Partial<Record<DiscoverySource, T>>> {
  const out: Partial<Record<DiscoverySource, T>> = {};
  for (const source of BARE_DISCOVERY_SOURCES) {
    const loader = loaders[source];
    if (!loader || !plan.enabled[source]) continue;
    out[source] = await loader();
  }
  return out;
}

/** One-line stderr note for a bare run (diagnostics never go to stdout). */
export function bareModeNote(plan: DiscoveryPlan): string | null {
  if (!plan.bare) return null;
  return `[bare] auto-discovery disabled (${plan.skipped.join(', ')}) — deterministic CI mode\n`;
}
