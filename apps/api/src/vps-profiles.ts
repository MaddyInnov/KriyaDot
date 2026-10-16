// SPDX-License-Identifier: Apache-2.0
// BYO VPS profiles: persistence overlay (OpenMausBot parity P1 #24).
//
// Bot configs ship in seed/bots.json (immutable at runtime). Like
// computer-surfaces.ts, per-bot VPS profiles live in a dataDir overlay file
// — vps-profiles.json (0600) — applied at boot:
//
//   { "default": { ...VpsProfile },
//     "profiles": { "<botId>": { ...VpsProfile } } }
//
// The file NEVER holds secrets: an SSH private key is referenced by vault
// secret NAME (privateKeyRef); passwords are never stored anywhere. This
// module validates that invariant on every write.

import fs from 'node:fs';
import path from 'node:path';
import { validateVpsProfile } from '@mvp/agent-runtime';
import type { VpsProfile } from '@mvp/agent-runtime';

const PROFILES_FILE = 'vps-profiles.json';

export function vpsProfilesPath(dataDir: string): string {
  return path.join(dataDir, PROFILES_FILE);
}

interface VpsProfilesFile {
  default?: VpsProfile;
  profiles: Record<string, VpsProfile>;
}

function emptyFile(): VpsProfilesFile {
  return { profiles: {} };
}

/** Load + validate the overlay file. Invalid entries are dropped with a warning. */
export function loadVpsProfiles(dataDir: string): VpsProfilesFile {
  const out = emptyFile();
  try {
    const raw = fs.readFileSync(vpsProfilesPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<VpsProfilesFile>;
    if (typeof parsed !== 'object' || parsed === null) return out;
    if (parsed.default !== undefined) {
      try {
        out.default = validateVpsProfile(parsed.default);
      } catch (err) {
        console.warn(`[vps-profiles] dropping invalid default profile: ${(err as Error).message}`);
      }
    }
    const profiles = parsed.profiles;
    if (typeof profiles === 'object' && profiles !== null) {
      for (const [botId, profile] of Object.entries(profiles)) {
        if (typeof botId !== 'string' || botId.length === 0 || botId.length > 128) continue;
        try {
          out.profiles[botId] = validateVpsProfile(profile);
        } catch (err) {
          console.warn(
            `[vps-profiles] dropping invalid profile for "${botId}": ${(err as Error).message}`,
          );
        }
      }
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[vps-profiles] could not read ${PROFILES_FILE}: ${(err as Error).message}`);
    }
    return out;
  }
}

function writeFile(dataDir: string, file: VpsProfilesFile): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = vpsProfilesPath(dataDir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, vpsProfilesPath(dataDir));
}

/**
 * Resolve the effective profile for a bot: per-bot profile, else the global
 * default, else undefined.
 */
export function resolveVpsProfile(
  dataDir: string,
  botId: string,
): VpsProfile | undefined {
  const file = loadVpsProfiles(dataDir);
  return file.profiles[botId] ?? file.default;
}

/** Persist a per-bot profile (validated; secrets rejected). */
export function saveVpsProfile(
  dataDir: string,
  botId: string,
  input: unknown,
): VpsProfile {
  const profile = validateVpsProfile(input);
  const file = loadVpsProfiles(dataDir);
  file.profiles[botId] = profile;
  writeFile(dataDir, file);
  return profile;
}

/** Delete a per-bot profile. Returns true when one existed. */
export function deleteVpsProfile(dataDir: string, botId: string): boolean {
  const file = loadVpsProfiles(dataDir);
  if (!file.profiles[botId]) return false;
  delete file.profiles[botId];
  writeFile(dataDir, file);
  return true;
}

/** Persist the global default profile. */
export function saveVpsDefaultProfile(dataDir: string, input: unknown): VpsProfile {
  const profile = validateVpsProfile(input);
  const file = loadVpsProfiles(dataDir);
  file.default = profile;
  writeFile(dataDir, file);
  return profile;
}

/** Update just the pinned fingerprint of a stored profile (trust flow). */
export function saveVpsFingerprint(
  dataDir: string,
  botId: string | null,
  fingerprint: string,
): void {
  const file = loadVpsProfiles(dataDir);
  if (botId === null) {
    if (!file.default) throw new Error('no default VPS profile to pin a fingerprint on');
    file.default = validateVpsProfile({ ...file.default, fingerprint });
  } else {
    const existing = file.profiles[botId];
    if (!existing) throw new Error(`no VPS profile for bot "${botId}"`);
    file.profiles[botId] = validateVpsProfile({ ...existing, fingerprint });
  }
  writeFile(dataDir, file);
}
