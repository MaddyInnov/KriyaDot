// SPDX-License-Identifier: Apache-2.0
/**
 * Environment-gated capabilities (#123): `requiredEnv` for tools.
 *
 * A capability whose required API key is absent should be SKIPPED when
 * a per-bot tool registry is built — not registered and then failed at
 * call time. This sidecar registry maps tool name → required env keys
 * (kept out of types.ts on purpose: ToolDefinition stays unchanged,
 * and hosts opt in by filtering with `filterToolsByRequiredEnv` when
 * they assemble a registry).
 *
 * Semantics:
 *   - A tool with no registry entry has no env requirements.
 *   - Every key in an entry's `requiredEnv` must be present (non-empty)
 *     in the env for the tool to be available (all-of).
 *   - Entries may instead declare `requiredEnvFor(env)` for conditional
 *     requirements (see web_search below).
 *   - Blank/whitespace values count as missing.
 *
 * The same pattern applies to MCP servers (another workstream's
 * files): an MCP server definition should carry `requiredEnv: string[]`
 * in its config, and the host should skip STARTING the server (with a
 * recorded reason, like `filterToolsByRequiredEnv`'s `skipped` list)
 * when any key is missing — rather than connecting and failing on the
 * first tool call. Skills implement the identical contract via
 * frontmatter `requiredEnv` in skills.ts.
 */

export type EnvSource = Record<string, string | undefined>;

export interface ToolEnvRequirement {
  /** All of these keys must be present (non-empty) — static form. */
  requiredEnv?: string[];
  /** Conditional form: compute the required keys for this env. */
  requiredEnvFor?: (env: EnvSource) => string[];
  /** Why the keys are needed (surfaced in skip reasons). */
  reason?: string;
}

const registry = new Map<string, ToolEnvRequirement>();

/** Register (or replace) the env requirement for one tool name. */
export function registerToolRequiredEnv(toolName: string, requirement: ToolEnvRequirement): void {
  registry.set(toolName, requirement);
}

/** The registered requirement for a tool, if any. */
export function getToolEnvRequirement(toolName: string): ToolEnvRequirement | undefined {
  return registry.get(toolName);
}

/** All registered tool names with env requirements (sorted). */
export function listEnvGatedTools(): string[] {
  return [...registry.keys()].sort();
}

/** Required env keys for a tool under `env` ([] when ungated). */
export function requiredEnvForTool(toolName: string, env: EnvSource = process.env): string[] {
  const req = registry.get(toolName);
  if (!req) return [];
  const keys = req.requiredEnvFor ? req.requiredEnvFor(env) : (req.requiredEnv ?? []);
  return [...new Set(keys.map((k) => k.trim()).filter(Boolean))];
}

/** Required keys that are absent/blank in `env` ([] when satisfied). */
export function missingEnvForTool(toolName: string, env: EnvSource = process.env): string[] {
  return requiredEnvForTool(toolName, env).filter((k) => {
    const v = env[k];
    return typeof v !== 'string' || v.trim() === '';
  });
}

/** True when the tool's env requirements are satisfied. */
export function isToolEnvSatisfied(toolName: string, env: EnvSource = process.env): boolean {
  return missingEnvForTool(toolName, env).length === 0;
}

export interface SkippedTool {
  name: string;
  missingEnv: string[];
  reason: string;
}

/**
 * Filter a tool list by env requirements — the helper hosts apply when
 * building per-bot registries. Returns the available tools plus a
 * `skipped` record (name + missing keys + reason) for every gated-out
 * tool, so the skip is visible/loggable instead of silent.
 */
export function filterToolsByRequiredEnv<T extends { name: string }>(
  tools: readonly T[],
  env: EnvSource = process.env,
): { tools: T[]; skipped: SkippedTool[] } {
  const available: T[] = [];
  const skipped: SkippedTool[] = [];
  for (const tool of tools) {
    const missing = missingEnvForTool(tool.name, env);
    if (missing.length === 0) {
      available.push(tool);
    } else {
      const req = registry.get(tool.name);
      skipped.push({
        name: tool.name,
        missingEnv: missing,
        reason:
          `tool "${tool.name}" skipped: required env ${missing.join(', ')} not set` +
          (req?.reason ? ` (${req.reason})` : ''),
      });
    }
  }
  return { tools: available, skipped };
}

// ---------------------------------------------------------------------------
// Built-in registrations — from an audit of env reads in src/tools/.
//
// Deliberately NOT registered:
//   - run_command / E2B: E2B_API_KEY selects ONE sandbox backend among
//     several (Docker/kernel/host-fallback) — the tool works without it.
//   - Tools whose env vars only tune behaviour (COMPUTER_* flags,
//     SANDBOX_* knobs, SSH_AUTH_SOCK for one VPS auth method): none of
//     them is a hard key requirement for the tool to function.
// ---------------------------------------------------------------------------

registerToolRequiredEnv('web_search', {
  // web_search falls back to the keyless DuckDuckGo provider when no
  // keyed provider is SELECTED — but once SEARCH_PROVIDER names a
  // keyed provider, that provider's key is genuinely required for the
  // configured behaviour, so the tool is gated on it.
  requiredEnvFor: (env) => {
    const selected = (env.SEARCH_PROVIDER ?? '').trim().toLowerCase();
    if (selected === 'brave') return ['BRAVE_API_KEY'];
    if (selected === 'tavily') return ['TAVILY_API_KEY'];
    return [];
  },
  reason: 'the SEARCH_PROVIDER-selected web search provider needs its API key',
});
