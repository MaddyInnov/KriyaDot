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
