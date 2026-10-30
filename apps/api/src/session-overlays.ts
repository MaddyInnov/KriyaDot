// SPDX-License-Identifier: Apache-2.0
/**
 * Per-session overlays (/role, /skill session commands).
 *
 * A session overlay is user-set, per-session turn shaping that is NOT
 * part of the bot's configuration:
 * - `role`: a free-text role instruction ("answer like a terse
 *   reviewer") appended to the turn's context for this session only.
 * - `skills`: skill names pinned to the session; the chat route merges
 *   them into the turn's bot skill list so the skills activate for this
 *   session without editing the bot.
 *
 * Persistence: one JSON file in the data dir (write-through on every
 * mutation; a corrupt file degrades to an empty store, never a crash).
 * Overlays are keyed by session id and bounded (oldest sessions are
 * evicted past the cap) — they are conveniences, not records.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export interface SessionOverlay {
  role?: string;
  skills: string[];
}

const MAX_SESSIONS = 500;

export class SessionOverlayStore {
  private readonly overlays = new Map<string, SessionOverlay>();

  constructor(private readonly filePath: string) {
    try {
      if (existsSync(filePath)) {
        const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, { role?: unknown; skills?: unknown }>;
        for (const [sessionId, v] of Object.entries(parsed ?? {})) {
          const skills = Array.isArray(v?.skills) ? v.skills.filter((s): s is string => typeof s === 'string') : [];
          const role = typeof v?.role === 'string' && v.role.trim() ? v.role : undefined;
          if (role || skills.length) this.overlays.set(sessionId, { ...(role ? { role } : {}), skills });
        }
      }
    } catch {
      // Corrupt overlay file → start empty; overlays are conveniences.
      this.overlays.clear();
    }
  }

  private persist(): void {
    try {
      const obj: Record<string, SessionOverlay> = {};
      for (const [k, v] of this.overlays) obj[k] = v;
      writeFileSync(this.filePath, JSON.stringify(obj, null, 2), 'utf8');
    } catch {
      // Persistence is best-effort; in-memory state still applies.
    }
  }

  private entry(sessionId: string): SessionOverlay {
    let e = this.overlays.get(sessionId);
    if (!e) {
      e = { skills: [] };
      this.overlays.set(sessionId, e);
      if (this.overlays.size > MAX_SESSIONS) {
        const oldest = this.overlays.keys().next();
        if (!oldest.done) this.overlays.delete(oldest.value);
      }
    }
    return e;
  }

  get(sessionId: string): SessionOverlay | undefined {
    const e = this.overlays.get(sessionId);
    return e ? { ...e, skills: [...e.skills] } : undefined;
  }

  getRole(sessionId: string): string | undefined {
    return this.overlays.get(sessionId)?.role;
  }

  setRole(sessionId: string, role: string | null): void {
    const e = this.entry(sessionId);
    if (role === null || role.trim() === '') delete e.role;
    else e.role = role.trim();
    this.persist();
  }

  listSkills(sessionId: string): string[] {
    return [...(this.overlays.get(sessionId)?.skills ?? [])];
  }

  pinSkill(sessionId: string, skillName: string): void {
    const e = this.entry(sessionId);
    if (!e.skills.includes(skillName)) e.skills.push(skillName);
    this.persist();
  }

  unpinSkill(sessionId: string, skillName: string): boolean {
    const e = this.overlays.get(sessionId);
    if (!e) return false;
    const before = e.skills.length;
    e.skills = e.skills.filter((s) => s !== skillName);
    if (e.skills.length === before) return false;
    this.persist();
    return true;
  }
}
