// SPDX-License-Identifier: Apache-2.0
/**
 * Multiple Claude accounts (ENGINES pack): named account profiles for
 * the claude-subscription bridge / Claude Code CLI, each pointing at its
 * OWN credential dir (CLAUDE_CONFIG_DIR-style isolation). Two bots can
 * run on two different Claude logins on the same machine without either
 * login clobbering the other.
 *
 * Hard rules:
 * - A profile is a LABEL + a DIRECTORY PATH. Nothing else is stored,
 *   listed, or returned — no token bytes, no credential file contents.
 * - Selection is explicit: a bot names a profile via
 *   `BotConfig.accountProfile`; an unknown/absent profile falls back to
 *   the machine's default Claude config dir.
 * - The bridge reads the token from the SELECTED profile's dir at
 *   request time (consent-gated, memory-only — see cli-bridge.ts).
 */

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface ClaudeAccountProfile {
  /** Stable profile id (slug). */
  id: string;
  /** Human label shown in pickers, e.g. "Work Claude". */
  label: string;
  /**
   * The profile's Claude config dir (the dir CLAUDE_CONFIG_DIR points
   * at; credentials live at <configDir>/.credentials.json). Absolute, or
   * resolved against the user's home when stored relative.
   */
  configDir: string;
}

const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Validate + normalize a profile (throws with a readable reason). */
export function validateClaudeProfile(input: unknown, homeDir: string = homedir()): ClaudeAccountProfile {
  if (typeof input !== 'object' || input === null) throw new Error('profile must be an object');
  const o = input as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  if (!PROFILE_ID_RE.test(id)) throw new Error(`invalid profile id "${id}" (lowercase slug required)`);
  const label = typeof o.label === 'string' ? o.label.trim().slice(0, 80) : '';
  if (!label) throw new Error('profile label is required');
  const rawDir = typeof o.configDir === 'string' ? o.configDir.trim() : '';
  if (!rawDir) throw new Error('profile configDir is required');
  const configDir = isAbsolute(rawDir) ? resolve(rawDir) : resolve(join(homeDir, rawDir));
  return { id, label, configDir };
}

/** The machine's default Claude config dir (no profile selected). */
export function defaultClaudeConfigDir(homeDir: string = homedir()): string {
  return join(homeDir, '.claude');
}

/** Credential file inside a profile's config dir (existence/shape only — never read here). */
export function claudeProfileCredentialsPath(profile: ClaudeAccountProfile): string {
  return join(profile.configDir, '.credentials.json');
}

/**
 * Pick the profile a bot runs under: the bot's `accountProfile` id when
 * it names a stored profile, else undefined (default login).
 */
export function selectClaudeProfile(
  profiles: readonly ClaudeAccountProfile[],
  accountProfileId: string | undefined,
): ClaudeAccountProfile | undefined {
  if (!accountProfileId) return undefined;
  return profiles.find((p) => p.id === accountProfileId);
}

/** The config dir a spawn/request should use for a bot (profile or default). */
export function resolveClaudeConfigDirForBot(
  profiles: readonly ClaudeAccountProfile[],
  accountProfileId: string | undefined,
  homeDir: string = homedir(),
): string {
  const profile = selectClaudeProfile(profiles, accountProfileId);
  return profile ? profile.configDir : defaultClaudeConfigDir(homeDir);
}

/**
 * Env overrides for spawning Claude under a profile: CLAUDE_CONFIG_DIR
 * isolation. Returns {} when no profile is selected (the CLI's own
 * default resolution applies, exactly as before).
 */
export function claudeProfileSpawnEnv(
  profiles: readonly ClaudeAccountProfile[],
  accountProfileId: string | undefined,
): Record<string, string> {
  const profile = selectClaudeProfile(profiles, accountProfileId);
  if (!profile) return {};
  return { CLAUDE_CONFIG_DIR: profile.configDir };
}

/** Public view of a profile for APIs/UI: label + path only, by construction. */
export function publicClaudeProfile(profile: ClaudeAccountProfile): { id: string; label: string; configDir: string } {
  return { id: profile.id, label: profile.label, configDir: profile.configDir };
}

// ---------------------------------------------------------------------------
// In-memory profile store (the API layer persists it; see
// apps/api/src/engine-accounts-routes.ts). CRUD never touches secrets.
// ---------------------------------------------------------------------------

export class ClaudeProfileStore {
  private readonly profiles = new Map<string, ClaudeAccountProfile>();

  constructor(initial: readonly ClaudeAccountProfile[] = []) {
    for (const p of initial) this.profiles.set(p.id, p);
  }

  list(): ClaudeAccountProfile[] {
    return [...this.profiles.values()].sort((a, b) => a.label.localeCompare(b.label));
  }

  get(id: string): ClaudeAccountProfile | undefined {
    return this.profiles.get(id);
  }

  /** Create or replace a profile (validated). Returns the stored profile. */
  upsert(input: unknown, homeDir?: string): ClaudeAccountProfile {
    const profile = validateClaudeProfile(input, homeDir);
    this.profiles.set(profile.id, profile);
    return profile;
  }

  /** Delete a profile. Returns false when it did not exist. */
  remove(id: string): boolean {
    return this.profiles.delete(id);
  }
}
