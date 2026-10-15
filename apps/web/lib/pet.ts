// SPDX-License-Identifier: Apache-2.0
// Companion pet system: 6 selectable mascot styles, persisted in localStorage
// under `mvp:pet`. localStorage is the source of truth (the learned-preferences
// backend API is about tool allow/deny, not UI identity, so no server sync).

'use client';

import { useCallback, useEffect, useState } from 'react';

export type PetId = 'kriyadot' | 'ocky' | 'nubi' | 'plip' | 'bolt' | 'wisp';
export type PetMood = 'idle' | 'thinking' | 'working' | 'happy' | 'error' | 'sleeping';

export interface PetDef {
  id: PetId;
  /** Default display name (user can rename). */
  name: string;
  tagline: string;
  blurb: string;
}

export const PETS: PetDef[] = [
  {
    id: 'kriyadot',
    name: 'KriyaDot',
    tagline: 'Eight hands. Zero waiting.',
    blurb: 'The flagship ink-blue blob. Every stubby arm holds a tiny tool, so nothing you ask ever queues.',
  },
  {
    id: 'ocky',
    name: 'Ocky',
    tagline: 'Curious about everything.',
    blurb: 'A purple explorer with big wondering eyes and a trusty headlamp for dark corners of the codebase.',
  },
  {
    id: 'nubi',
    name: 'Nubi',
    tagline: 'The newbie that is expert at everything.',
    blurb: 'A soft rainbow-frilled drifter. Gentle, adaptable, and quietly brilliant at picking up new tricks.',
  },
  {
    id: 'plip',
    name: 'Plip',
    tagline: 'Small blob. Big jobs.',
    blurb: 'A droplet of pure bounce with six wiggly arms. Cannot sit still, will not let your tasks sit still either.',
  },
  {
    id: 'bolt',
    name: 'Bolt',
    tagline: 'Precision, with treads.',
    blurb: 'A geometric robot companion. LED eyes, antenna tuned to your intent, and zero organic mess.',
  },
  {
    id: 'wisp',
    name: 'Wisp',
    tagline: 'Here, but barely.',
    blurb: 'A sleepy ethereal floater that drifts through your work leaving a soft glow and finished tasks behind.',
  },
];

export const DEFAULT_PET_ID: PetId = 'kriyadot';

const KEY = 'mvp:pet';
const CHANGE_EVENT = 'mvp:pet-change';

export interface PetChoice {
  id: PetId;
  /** Custom display name; empty means "use the pet's default name". */
  name: string;
}

function isPetId(v: unknown): v is PetId {
  return typeof v === 'string' && (PETS as PetDef[]).some((p) => p.id === v);
}

/** Read the stored choice (safe on server / private mode). */
export function getStoredPet(): PetChoice {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { id: DEFAULT_PET_ID, name: '' };
    const parsed = JSON.parse(raw) as Partial<PetChoice>;
    // One-time migration: the flagship pet was renamed tentio -> kriyadot.
    // Preserve the stored custom name (if any) and rewrite the id.
    if ((parsed.id as string) === 'tentio') {
      const migrated: PetChoice = {
        id: 'kriyadot',
        name: typeof parsed.name === 'string' ? parsed.name.slice(0, 24) : '',
      };
      try {
        localStorage.setItem(KEY, JSON.stringify(migrated));
      } catch {
        /* private mode etc. — in-memory only */
      }
      return migrated;
    }
    return {
      id: isPetId(parsed.id) ? parsed.id : DEFAULT_PET_ID,
      name: typeof parsed.name === 'string' ? parsed.name.slice(0, 24) : '',
    };
  } catch {
    return { id: DEFAULT_PET_ID, name: '' };
  }
}

/** Persist a choice and notify other mounted hooks in this tab. */
export function setStoredPet(id: PetId, name?: string): PetChoice {
  const choice: PetChoice = {
    id,
    name: typeof name === 'string' ? name.slice(0, 24) : getStoredPet().name,
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(choice));
  } catch {
    /* private mode etc. — in-memory only */
  }
  try {
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    /* ignore */
  }
  return choice;
}

export function petDef(id: PetId): PetDef {
  return PETS.find((p) => p.id === id) ?? PETS[0];
}

/** Display name: custom name if set, otherwise the pet's default name. */
export function petDisplayName(choice: PetChoice): string {
  const custom = choice.name.trim();
  return custom || petDef(choice.id).name;
}

export interface UsePet {
  choice: PetChoice;
  def: PetDef;
  /** Resolved display name. */
  name: string;
  setPet: (id: PetId) => void;
  setName: (name: string) => void;
}

/** Reactive hook over the stored pet choice. SSR-safe (hydrates from default). */
export function usePet(): UsePet {
  const [choice, setChoice] = useState<PetChoice>({ id: DEFAULT_PET_ID, name: '' });

  useEffect(() => {
    setChoice(getStoredPet());
    const onChange = () => setChoice(getStoredPet());
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);

  const setPet = useCallback((id: PetId) => {
    setChoice(setStoredPet(id));
  }, []);

  const setName = useCallback((name: string) => {
    setChoice((prev) => setStoredPet(prev.id, name));
  }, []);

  const def = petDef(choice.id);
  return { choice, def, name: petDisplayName(choice), setPet, setName };
}
