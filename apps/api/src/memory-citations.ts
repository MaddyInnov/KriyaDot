// SPDX-License-Identifier: Apache-2.0
// OH-3: cited recall — build user-visible citations from the SAME
// TieredMemoryStore hits a chat turn already recalled for its prompt
// memory block (routes.ts builds a MemoryPack via buildMemoryPackNeural
// and renders it with renderMemoryPack). Citations are derived from the
// pack's atoms, never from a second recall, so what the user sees cited
// is exactly what the model was shown.
//
// Shape (stable contract for the web renderer):
//   memoryUsed: [{ atomId, fact, category, sourceTurn }]
// `fact` is a preview capped at 200 chars. When a turn recalled no
// atoms, callers omit the field entirely (absent, not an empty array).

import type { AtomCard, MemoryPack } from '@mvp/agent-runtime';

export interface MemoryCitation {
  atomId: string;
  /** Fact preview, capped at 200 chars. */
  fact: string;
  category: string;
  sourceTurn: string;
}

export const CITATION_FACT_PREVIEW_CHARS = 200;

export function citationFromAtom(atom: Pick<AtomCard, 'id' | 'fact' | 'category' | 'sourceTurn'>): MemoryCitation {
  const fact = atom.fact.length > CITATION_FACT_PREVIEW_CHARS
    ? `${atom.fact.slice(0, CITATION_FACT_PREVIEW_CHARS - 1)}…`
    : atom.fact;
  return {
    atomId: atom.id,
    fact,
    category: atom.category,
    sourceTurn: atom.sourceTurn,
  };
}

/** Citations for a turn's memory pack (undefined when the pack is empty/absent). */
export function citationsFromPack(pack: MemoryPack | undefined | null): MemoryCitation[] | undefined {
  if (!pack || pack.atoms.length === 0) return undefined;
  return pack.atoms.map(citationFromAtom);
}

/** Citations for an ad-hoc atom list (memory ask endpoint). */
export function citationsFromAtoms(atoms: AtomCard[]): Array<{ atomId: string; fact: string; category: string }> {
  return atoms.map((a) => {
    const c = citationFromAtom(a);
    return { atomId: c.atomId, fact: c.fact, category: c.category };
  });
}
