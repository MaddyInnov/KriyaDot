// SPDX-License-Identifier: Apache-2.0
/**
 * Sub-agent profile library (item 16): ≥150 specialist profiles for
 * ephemeral delegation. Loader validates uniqueness and shape; the
 * delegate/background paths accept a profileId and spawn an ephemeral
 * specialist using the profile's prompt + suggested tools.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
export interface SubagentProfile { id: string; name: string; specialty: string; description: string; systemPrompt: string; suggestedTools: string[]; }
let cache: SubagentProfile[] | null = null;
export function parseSubagentProfiles(raw: unknown): SubagentProfile[] {
  if (!Array.isArray(raw)) throw new Error('subagent profiles must be an array');
  const seen = new Set<string>(); const out: SubagentProfile[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    if (typeof r.id !== 'string' || !r.id || seen.has(r.id)) throw new Error(`duplicate or invalid profile id "${String(r.id)}"`);
    seen.add(r.id);
    if (typeof r.name !== 'string' || typeof r.systemPrompt !== 'string' || !r.systemPrompt) throw new Error(`profile ${r.id} missing name/systemPrompt`);
    out.push({ id: r.id, name: r.name, specialty: String(r.specialty ?? ''), description: String(r.description ?? ''), systemPrompt: r.systemPrompt, suggestedTools: Array.isArray(r.suggestedTools) ? r.suggestedTools.map(String) : [] });
  }
  return out;
}
export function loadSubagentProfiles(): SubagentProfile[] {
  if (cache) return cache;
  const here = dirname(fileURLToPath(import.meta.url));
  // src/ during tests (vitest), dist/ after build — data file is copied
  // alongside both by living in src/profiles-data and referenced relative
  // to src layout; fallback walks to src/profiles-data. (Directory is NOT
  // named "data": the repo sync tooling skips any directory called data.)
  for (const cand of [join(here, 'profiles-data', 'subagent-profiles.json'), join(here, '..', 'src', 'profiles-data', 'subagent-profiles.json')]) {
    try { cache = parseSubagentProfiles(JSON.parse(readFileSync(cand, 'utf8'))); return cache; } catch { /* try next */ }
  }
  throw new Error('subagent-profiles.json not found');
}
export class SubagentProfileRegistry {
  private readonly byId: Map<string, SubagentProfile>;
  constructor(profiles: SubagentProfile[] = loadSubagentProfiles()) { this.byId = new Map(profiles.map(p=>[p.id,p])); }
  get(id: string): SubagentProfile | undefined { return this.byId.get(id); }
  list(): SubagentProfile[] { return [...this.byId.values()]; }
  get size(): number { return this.byId.size; }
  /** Ephemeral bot definition for startBackgroundRun / delegate spawns. */
  ephemeralFor(id: string): { name: string; systemPrompt: string; tools: string[] } | undefined {
    const p = this.get(id); if (!p) return undefined;
    return { name: p.name, systemPrompt: p.systemPrompt, tools: [...p.suggestedTools] };
  }
}
export const subagentProfiles = new SubagentProfileRegistry();
