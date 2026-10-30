// SPDX-License-Identifier: Apache-2.0
/**
 * 128-tool fitting: some API-key providers reject >128 tools. When the
 * assembled list exceeds the cap, compact deterministically: keep every
 * tool NAME (capability discovery is preserved), truncate descriptions,
 * and stub the largest parameter schemas with a note. Order is the
 * input order (deterministic); stubbing picks largest schemas first.
 */
import type { ToolDefinition } from './types.js';
export const MAX_PROVIDER_TOOLS = 128;
export interface ToolFittingResult { tools: ToolDefinition[]; fitted: boolean; truncatedDescriptions: number; stubbedSchemas: number; originalCount: number; }
function schemaSize(t: ToolDefinition): number { try { return JSON.stringify(t.parameters ?? {}).length; } catch { return 0; } }
export function fitToolsToLimit(tools: ToolDefinition[], limit = MAX_PROVIDER_TOOLS): ToolFittingResult {
  if (tools.length <= limit) return { tools, fitted: false, truncatedDescriptions: 0, stubbedSchemas: 0, originalCount: tools.length };
  let truncated = 0; let stubbed = 0;
  const sized = tools.map((t,i)=>({t,i,size:schemaSize(t)})).sort((a,b)=>b.size-a.size);
  const stubIdx = new Set(sized.slice(0, Math.ceil(tools.length/2)).map(x=>x.i));
  const out = tools.map((t,i)=>{
    const desc = t.description.length > 160 ? (truncated++, t.description.slice(0,157)+'…') : t.description;
    if (stubIdx.has(i)) { stubbed++; return { ...t, description: desc, parameters: { type:'object', description:'Parameters omitted to fit the provider tool limit; call with your best-guess arguments and the tool will validate them.', additionalProperties: true } }; }
    return desc === t.description ? t : { ...t, description: desc };
  });
  return { tools: out, fitted: true, truncatedDescriptions: truncated, stubbedSchemas: stubbed, originalCount: tools.length };
}

// ---------------------------------------------------------------------------
// Intent-driven tool loading (closure #138): at turn start, select the
// turn's tool set by intent instead of loading all then truncating.
// ---------------------------------------------------------------------------

/** Tools that are ALWAYS offered regardless of intent (core set). */
export const CORE_TOOL_NAMES: readonly string[] = [
  'read_file', 'write_file', 'edit_file', 'list_files', 'run_command',
  'search', 'web_search', 'ask_user', 'delegate', 'delegate_background',
];

function intentTokens(intent: string): Set<string> {
  return new Set((intent.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((t) => t.length >= 3));
}

function toolText(t: ToolDefinition): string {
  return `${t.name.replace(/_/g, ' ')} ${t.description}`.toLowerCase();
}

/**
 * Sync (keyword-overlap) intent selection. Rules:
 * - `explicitList: true` (bot declared a small exact tool list) → unchanged.
 * - Lists at/below `maxTools` → unchanged.
 * - Otherwise: core tools always stay; the remaining slots go to the
 *   highest intent-overlap tools (ties keep original order).
 * fitToolsToLimit remains the 128 backstop on the result.
 */
export function selectToolsByIntentSync(
  tools: ToolDefinition[],
  intent: string,
  opts: { maxTools?: number; explicitList?: boolean; coreNames?: readonly string[] } = {},
): { tools: ToolDefinition[]; reduced: boolean; kept: string[] } {
  const maxTools = opts.maxTools ?? 32;
  if (opts.explicitList || tools.length <= maxTools) {
    return { tools, reduced: false, kept: tools.map((t) => t.name) };
  }
  const core = new Set(opts.coreNames ?? CORE_TOOL_NAMES);
  const tokens = intentTokens(intent);
  const scored = tools.map((t, i) => {
    const text = toolText(t);
    let score = core.has(t.name) ? Number.POSITIVE_INFINITY : 0;
    if (score === 0) {
      for (const tok of tokens) if (text.includes(tok)) score += 1;
    }
    return { t, i, score };
  });
  const chosen = [...scored]
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, maxTools)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.t);
  return { tools: chosen, reduced: true, kept: chosen.map((t) => t.name) };
}

/**
 * Embedding-backed intent selection (#138): ranks tools with
 * discoverByIntent over their descriptions; core tools always stay.
 * Falls back to the sync selector when ranking yields nothing.
 */
export async function selectToolsByIntent(
  tools: ToolDefinition[],
  intent: string,
  embedder: import('./hybrid-search.js').SyncEmbedder,
  opts: { maxTools?: number; explicitList?: boolean; coreNames?: readonly string[] } = {},
): Promise<{ tools: ToolDefinition[]; reduced: boolean; kept: string[] }> {
  const maxTools = opts.maxTools ?? 32;
  if (opts.explicitList || tools.length <= maxTools) {
    return { tools, reduced: false, kept: tools.map((t) => t.name) };
  }
  const { discoverByIntent } = await import('./discovery.js');
  const core = new Set(opts.coreNames ?? CORE_TOOL_NAMES);
  const rest = tools.filter((t) => !core.has(t.name));
  const hits = await discoverByIntent(
    intent,
    rest.map((t) => ({ kind: 'capability' as const, id: t.name, name: t.name, description: t.description })),
    embedder,
    { topK: Math.max(0, maxTools - tools.filter((t) => core.has(t.name)).length) },
  );
  if (hits.length === 0) return selectToolsByIntentSync(tools, intent, opts);
  const keepNames = new Set([...core, ...hits.map((h) => h.item.id)]);
  const chosen = tools.filter((t) => keepNames.has(t.name));
  return { tools: chosen, reduced: true, kept: chosen.map((t) => t.name) };
}
