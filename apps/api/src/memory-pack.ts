// SPDX-License-Identifier: Apache-2.0
/**
 * Memory portability (item 12): pack / adopt / doctor / backup / restore
 * for one bot's tiered memory. Pure logic over a structural store
 * interface (TieredMemoryStore satisfies it); routes live in
 * memory-upkeep-routes.ts.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AtomCard, EntityPage } from '@mvp/agent-runtime';

export interface MemoryPackStoreLike {
  getAtoms: (botId: string, limit?: number, opts?: { includeInactive?: boolean }) => AtomCard[];
  storeAtom: (botId: string, fact: { fact: string; entities: string[]; confidence: number }, sourceTurn: string, tier?: never, opts?: { category?: AtomCard['category']; pinned?: boolean }) => string;
  deleteAtom: (botId: string, id: string) => boolean;
  getEntities?: (botId: string) => EntityPage[];
  findNearDuplicatePairs?: (botId: string, threshold?: number) => Array<unknown>;
}
export interface MemoryPack { kind: 'kriyadot-memory-pack'; version: 1; botId: string; exportedAt: number; atoms: AtomCard[]; entities: EntityPage[]; }
export function exportMemoryPack(store: MemoryPackStoreLike, botId: string): MemoryPack {
  return { kind: 'kriyadot-memory-pack', version: 1, botId, exportedAt: Date.now(), atoms: store.getAtoms(botId, 5000, { includeInactive: true }), entities: store.getEntities?.(botId) ?? [] };
}
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
export interface AdoptConflict { incomingFact: string; existingAtomId: string; reason: 'duplicate' | 'near-duplicate'; }
export interface AdoptResult { applied: string[]; conflicts: AdoptConflict[]; skipped: string[]; overwritten: string[]; }
export function adoptMemoryPack(store: MemoryPackStoreLike, targetBotId: string, pack: MemoryPack, decisions: Record<string, 'overwrite' | 'skip'> = {}): AdoptResult {
  if (!pack || pack.kind !== 'kriyadot-memory-pack' || !Array.isArray(pack.atoms)) throw new Error('invalid memory pack');
  const existing = store.getAtoms(targetBotId, 5000, { includeInactive: true });
  const byNorm = new Map(existing.map(a => [norm(a.fact), a]));
  const result: AdoptResult = { applied: [], conflicts: [], skipped: [], overwritten: [] };
  for (const atom of pack.atoms) {
    const key = norm(atom.fact);
    const hit = byNorm.get(key);
    const decision = decisions[atom.id] ?? decisions[key] ?? decisions[atom.fact];
    if (hit && hit.id !== atom.id) {
      if (decision === 'overwrite') { store.deleteAtom(targetBotId, hit.id); const id = store.storeAtom(targetBotId, { fact: atom.fact, entities: atom.entities, confidence: atom.confidence }, 'memory-pack-adopt', undefined, { category: atom.category, pinned: atom.pinned }); result.overwritten.push(id); byNorm.set(key, { ...atom, id }); continue; }
      if (decision === 'skip') { result.skipped.push(atom.fact); continue; }
      result.conflicts.push({ incomingFact: atom.fact, existingAtomId: hit.id, reason: 'duplicate' }); continue;
    }
    if (hit) { result.skipped.push(atom.fact); continue; }
    const id = store.storeAtom(targetBotId, { fact: atom.fact, entities: atom.entities, confidence: atom.confidence }, 'memory-pack-adopt', undefined, { category: atom.category, pinned: atom.pinned });
    result.applied.push(id); byNorm.set(key, { ...atom, id });
  }
  return result;
}
export interface MemoryDoctorReport { botId: string; atomCount: number; orphanedAtoms: number; nearDuplicates: number; brokenRefs: string[]; entityCount: number; healthy: boolean; }
export function doctorMemory(store: MemoryPackStoreLike, botId: string): MemoryDoctorReport {
  const atoms = store.getAtoms(botId, 5000, { includeInactive: true });
  const entities = store.getEntities?.(botId) ?? [];
  const atomIds = new Set(atoms.map(a => a.id));
  const brokenRefs: string[] = [];
  const referenced = new Set<string>();
  for (const e of entities) for (const id of e.atomIds) { referenced.add(id); if (!atomIds.has(id)) brokenRefs.push(`${e.entity} -> ${id}`); }
  const entityNames = new Set(entities.map(e => e.entity.toLowerCase()));
  // Orphaned: atom mentions entities but none have an entity page, and no page references it.
  const orphanedAtoms = atoms.filter(a => !referenced.has(a.id) && a.entities.length > 0 && !a.entities.some(en => entityNames.has(en.toLowerCase()))).length;
  let nearDuplicates = 0;
  try { nearDuplicates = store.findNearDuplicatePairs?.(botId, 0.92)?.length ?? 0; } catch { nearDuplicates = 0; }
  return { botId, atomCount: atoms.length, orphanedAtoms, nearDuplicates, brokenRefs, entityCount: entities.length, healthy: brokenRefs.length === 0 };
}
export class MemoryBackupStore {
  constructor(private readonly dataDir: string) {}
  private dir(): string { const d = join(this.dataDir, 'memory-backups'); mkdirSync(d, { recursive: true }); return d; }
  create(store: MemoryPackStoreLike, botId: string): { id: string; pack: MemoryPack } {
    const pack = exportMemoryPack(store, botId);
    const id = `backup_${botId}_${pack.exportedAt}`;
    writeFileSync(join(this.dir(), `${id}.json`), JSON.stringify(pack), 'utf8');
    return { id, pack };
  }
  list(botId: string): string[] { return readdirSync(this.dir()).filter(f => f.startsWith(`backup_${botId}_`) && f.endsWith('.json')).map(f => f.slice(0, -5)).sort(); }
  read(id: string): MemoryPack | undefined { const p = join(this.dir(), `${id}.json`); if (!existsSync(p)) return undefined; return JSON.parse(readFileSync(p, 'utf8')) as MemoryPack; }
  /** Restore: delete current atoms, then adopt the snapshot (overwrite semantics). */
  restore(store: MemoryPackStoreLike, botId: string, backupId: string): AdoptResult {
    const pack = this.read(backupId); if (!pack) throw new Error(`unknown backup "${backupId}"`);
    for (const a of store.getAtoms(botId, 5000, { includeInactive: true })) store.deleteAtom(botId, a.id);
    return adoptMemoryPack(store, botId, pack);
  }
}
