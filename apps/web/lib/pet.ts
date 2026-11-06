// SPDX-License-Identifier: Apache-2.0
// Companion pet system: 6 selectable mascot styles, persisted in localStorage
// under `mvp:pet`. localStorage is the source of truth (the learned-preferences
// backend API is about tool allow/deny, not UI identity, so no server sync).

'use client';

import { useCallback, useEffect, useState } from 'react';

export type PetId = 'kriyadot' | 'ocky' | 'nubi' | 'plip' | 'bolt' | 'wisp';
export type PetMood =
  | 'idle'
  | 'thinking'
  | 'working'
  | 'happy'
  | 'error'
  | 'sleeping'
  | 'speaking'
  | 'celebrating';

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

/* ------------------------------------------------------------------ */
/* Pet settings (avatar presence toggles)                              */
/* ------------------------------------------------------------------ */

const SETTINGS_KEY = 'mvp:pet:settings';
const SETTINGS_CHANGE_EVENT = 'mvp:pet-settings-change';

export interface PetSettings {
  /** Show the pet as an avatar next to chat messages. */
  chatAvatar: boolean;
  /** Allow the speaking (talking) mood / animation. */
  speaking: boolean;
  /** Allow the celebrating mood / animation. */
  celebration: boolean;
  /** Show the pet as a desktop floating overlay. */
  overlay: boolean;
}

export const DEFAULT_PET_SETTINGS: PetSettings = {
  chatAvatar: true,
  speaking: true,
  celebration: true,
  overlay: true,
};

const PET_SETTING_KEYS = ['chatAvatar', 'speaking', 'celebration', 'overlay'] as const;

function isPetSettingKey(v: unknown): v is keyof PetSettings {
  return typeof v === 'string' && (PET_SETTING_KEYS as readonly string[]).includes(v);
}

function sanitisePetSettings(raw: unknown): PetSettings {
  const next: PetSettings = { ...DEFAULT_PET_SETTINGS };
  if (raw && typeof raw === 'object') {
    const parsed = raw as Partial<Record<keyof PetSettings, unknown>>;
    for (const key of PET_SETTING_KEYS) {
      if (typeof parsed[key] === 'boolean') next[key] = parsed[key] as boolean;
    }
  }
  return next;
}

/** Read the stored pet settings (safe on server / private mode). */
export function getPetSettings(): PetSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_PET_SETTINGS };
    return sanitisePetSettings(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_PET_SETTINGS };
  }
}

/** Persist a partial settings update and notify other mounted hooks in this tab. */
export function setPetSettings(partial: Partial<PetSettings>): PetSettings {
  const current = getPetSettings();
  const next: PetSettings = { ...current };
  if (partial && typeof partial === 'object') {
    for (const key of PET_SETTING_KEYS) {
      const value = partial[key];
      if (typeof value === 'boolean') next[key] = value;
    }
  }
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* private mode etc. — in-memory only */
  }
  try {
    window.dispatchEvent(new Event(SETTINGS_CHANGE_EVENT));
  } catch {
    /* ignore */
  }
  return next;
}

export interface UsePetSettings {
  settings: PetSettings;
  setSetting: (key: keyof PetSettings, value: boolean) => void;
}

/** Reactive hook over the stored pet settings. SSR-safe (hydrates from defaults). */
export function usePetSettings(): UsePetSettings {
  const [settings, setSettings] = useState<PetSettings>({ ...DEFAULT_PET_SETTINGS });

  useEffect(() => {
    setSettings(getPetSettings());
    const onChange = () => setSettings(getPetSettings());
    window.addEventListener(SETTINGS_CHANGE_EVENT, onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(SETTINGS_CHANGE_EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);

  const setSetting = useCallback((key: keyof PetSettings, value: boolean) => {
    if (!isPetSettingKey(key) || typeof value !== 'boolean') return;
    setSettings(setPetSettings({ [key]: value } as Partial<PetSettings>));
  }, []);

  return { settings, setSetting };
}
