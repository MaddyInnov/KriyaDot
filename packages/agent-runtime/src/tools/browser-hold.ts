// SPDX-License-Identifier: Apache-2.0
// Per-person browser hold (§1.4): "browser hold follows the person".
//
// A browser profile (keyed by profile id — the bot id whose persistent
// Playwright profile it is) can be HELD by a person: while held, bot
// browser actions on that profile are blocked with a clear
// "held by <person>" error until the hold is released. The hold belongs
// to the person, not to a bot or session: it survives across bots/turns
// until that person (or an explicit force release) lets go.
//
// The check lives at the computer layer's choke point
// (PerBotComputerManager's per-bot lazy layer): every action funnels
// through it, so no individual tool needs to know about holds.

export interface BrowserHold {
  /** Browser profile id (the bot id the persistent profile belongs to). */
  profileId: string;
  /** Person id (PeopleStore) holding the browser. */
  personId: string;
  /** Display name for messages; falls back to personId. */
  personName?: string;
  heldAt: number;
  /** Optional human note ("reviewing the checkout flow"). */
  reason?: string;
}

/** Thrown by bot browser actions while a person holds the profile. */
export class BrowserHeldError extends Error {
  readonly hold: BrowserHold;
  constructor(hold: BrowserHold) {
    super(
      `Browser is held by ${hold.personName ?? hold.personId} — bot browser actions on this profile are paused until they release it.`,
    );
    this.name = 'BrowserHeldError';
    this.hold = hold;
  }
}

export class BrowserHoldRegistry {
  private readonly holds = new Map<string, BrowserHold>();
  private readonly clock: () => number;

  constructor(opts: { clock?: () => number } = {}) {
    this.clock = opts.clock ?? (() => Date.now());
  }

  /** Place (or refresh) a hold. Re-holding by the same person is a no-op refresh. */
  hold(input: { profileId: string; personId: string; personName?: string; reason?: string }): BrowserHold {
    if (!input.profileId) throw new Error('profileId is required');
    if (!input.personId) throw new Error('personId is required');
    const existing = this.holds.get(input.profileId);
    if (existing && existing.personId !== input.personId) {
      throw new BrowserHeldError(existing);
    }
    const hold: BrowserHold = {
      profileId: input.profileId,
      personId: input.personId,
      ...(input.personName ? { personName: input.personName } : {}),
      heldAt: existing?.heldAt ?? this.clock(),
      ...(input.reason ? { reason: input.reason } : existing?.reason ? { reason: existing.reason } : {}),
    };
    this.holds.set(input.profileId, hold);
    return hold;
  }

  /**
   * Release a hold. Only the holding person may release, unless
   * `force: true` (an explicit human override from the UI/API).
   * Returns the released hold, or undefined when nothing was held.
   */
  release(profileId: string, opts: { personId?: string; force?: boolean } = {}): BrowserHold | undefined {
    const existing = this.holds.get(profileId);
    if (!existing) return undefined;
    if (!opts.force && opts.personId && existing.personId !== opts.personId) {
      throw new BrowserHeldError(existing);
    }
    this.holds.delete(profileId);
    return existing;
  }

  get(profileId: string): BrowserHold | undefined {
    return this.holds.get(profileId);
  }

  list(): BrowserHold[] {
    return [...this.holds.values()];
  }

  /** The tool-entry check: throws BrowserHeldError when the profile is held. */
  assertNotHeld(profileId: string): void {
    const hold = this.holds.get(profileId);
    if (hold) throw new BrowserHeldError(hold);
  }
}

/**
 * Process-wide default registry: the API's browser-hold routes and the
 * PerBotComputerManager share this instance unless a host injects its own,
 * so a hold placed over HTTP blocks the very next bot browser action.
 */
export const defaultBrowserHoldRegistry = new BrowserHoldRegistry();
