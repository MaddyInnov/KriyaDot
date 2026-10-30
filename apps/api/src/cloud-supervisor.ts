// SPDX-License-Identifier: Apache-2.0
// Cloud supervisor — wake-on-traffic + keep-state for a Lightning Studio
// (Octomind-parity closure, C2). Pure logic with an injected client, an
// injected health probe, and an injected clock: fully unit-tested with
// FakeLightningClient, no timers, no network.
//
// HONEST STATE MODEL (feasibility report §4 — read before editing):
// - Free tier is NEVER "always-on". A free Studio sleeps when idle and is
//   force-restarted every 4 hours. The strongest honest claim is
//   "always reachable": traffic (or this supervisor's probe) wakes it,
//   with a cold start that typically takes 1–2 minutes. `alwaysOn` below
//   is therefore hard-false on the free tier, in every state.
// - On paid tiers (Pro and above) Lightning removes the 4-hour session
//   restriction; `alwaysOn` then simply mirrors `reachable`.
// - A `waking` state is exposed (never "down") while a start is in
//   flight, so clients can render "waking…" instead of an error.

import {
  DEFAULT_STUDIO_NAME,
  resolveStudioPublicUrl,
  type LightningClient,
  type LightningStudioState,
} from './cloud-lightning.js';
import { startSupervisorCommand } from './cloud-deploy.js';

export type CloudTier = 'free' | 'pro' | 'teams' | 'enterprise' | 'unknown';

export interface CloudInstanceState {
  studio: string;
  /** Mapped state; `waking` covers sleeping/stopped/starting once a wake was requested. */
  state: LightningStudioState;
  /** True only when the public URL answered the health probe. */
  reachable: boolean;
  tier: CloudTier;
  /**
   * NEVER true on the free tier (4-hour restarts + idle sleep). On paid
   * tiers it mirrors `reachable`. Do not "fix" this to be optimistic.
   */
  alwaysOn: boolean;
  publicUrl?: string;
  machine?: string;
  uptimeSeconds?: number;
  lastCheckedAt: number;
  /** Times a Lightning-side restart was detected (uptime/startedAt moved backwards). */
  detectedRestarts: number;
  /** Times this supervisor asked Lightning to start the Studio. */
  wakeAttempts: number;
  /** Times this supervisor (re)started the in-Studio supervisor script. */
  supervisorRestarts: number;
  detail?: string;
}

export interface CloudClock {
  now(): number;
}

export const systemClock: CloudClock = { now: () => Date.now() };

export type HealthProbe = (url: string) => Promise<boolean>;

/** Real probe: any HTTP response (even 401/404) means the server is up. */
export const fetchHealthProbe: HealthProbe = async (url) => {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual' });
    return res.status > 0;
  } catch {
    return false;
  }
};

export interface CloudSupervisorOptions {
  client: LightningClient;
  studioName?: string;
  tier?: CloudTier;
  port?: number;
  healthProbe?: HealthProbe;
  clock?: CloudClock;
}

/**
 * Detect a Lightning-side restart between two observations: the start
 * time moved, or uptime went backwards. Pure; exported for testing.
 */
export function detectRestart(
  prev: { startedAt?: number; uptimeSeconds?: number } | undefined,
  next: { startedAt?: number; uptimeSeconds?: number },
): boolean {
  if (!prev) return false;
  if (prev.startedAt !== undefined && next.startedAt !== undefined && prev.startedAt !== next.startedAt)
    return true;
  if (
    prev.uptimeSeconds !== undefined &&
    next.uptimeSeconds !== undefined &&
    next.uptimeSeconds < prev.uptimeSeconds
  )
    return true;
  return false;
}

export class CloudSupervisor {
  private readonly studioName: string;
  private readonly tier: CloudTier;
  private readonly port: number;
  private readonly probe: HealthProbe;
  private readonly clock: CloudClock;
  private lastObservation?: { startedAt?: number; uptimeSeconds?: number };
  private wakeRequested = false;
  private detectedRestarts = 0;
  private wakeAttempts = 0;
  private supervisorRestarts = 0;
  private lastState?: CloudInstanceState;

  constructor(private readonly opts: CloudSupervisorOptions) {
    this.studioName = opts.studioName ?? DEFAULT_STUDIO_NAME;
    this.tier = opts.tier ?? 'free';
    this.port = opts.port ?? 8080;
    this.probe = opts.healthProbe ?? fetchHealthProbe;
    this.clock = opts.clock ?? systemClock;
  }

  /** Last computed state without doing any work (undefined before the first tick). */
  snapshot(): CloudInstanceState | undefined {
    return this.lastState;
  }

  /**
   * One supervisor pass:
   * 1. Read the Studio's mapped state.
   * 2. Sleeping/stopped/starting → ask Lightning to start it and report
   *    `waking` (wake-on-traffic semantics; the probe counts as traffic).
   * 3. Running → probe the public URL. Unhealthy → (re)start the
   *    in-Studio supervisor script once and report `waking`.
   * 4. Running + healthy → `running`/`reachable`. If a Lightning-side
   *    restart is detected since the last pass (the 4-hour free-tier
   *    restart), run a keep-state pass: restart the in-Studio supervisor
   *    so the server comes back under supervision on the fresh Studio.
   */
  async tick(): Promise<CloudInstanceState> {
    const now = this.clock.now();
    const studio = await this.opts.client.getStudio(this.studioName);

    if (!studio) {
      return this.remember({
        studio: this.studioName,
        state: 'stopped',
        reachable: false,
        tier: this.tier,
        alwaysOn: false,
        lastCheckedAt: now,
        detectedRestarts: this.detectedRestarts,
        wakeAttempts: this.wakeAttempts,
        supervisorRestarts: this.supervisorRestarts,
        detail: 'Studio does not exist yet — deploy first.',
      });
    }

    const publicUrl = resolveStudioPublicUrl(studio, this.port) ?? studio.publicUrl;
    const base = {
      studio: this.studioName,
      tier: this.tier,
      ...(publicUrl ? { publicUrl } : {}),
      ...(studio.machine ? { machine: studio.machine } : {}),
      ...(studio.uptimeSeconds !== undefined ? { uptimeSeconds: studio.uptimeSeconds } : {}),
      lastCheckedAt: now,
      detectedRestarts: this.detectedRestarts,
      wakeAttempts: this.wakeAttempts,
      supervisorRestarts: this.supervisorRestarts,
    };

    if (studio.state !== 'running') {
      // Wake-on-traffic: a sleeping/stopped Studio gets a start request,
      // and the exposed state is `waking` — never "down".
      await this.opts.client.startStudio(this.studioName);
      this.wakeAttempts += 1;
      this.wakeRequested = true;
      return this.remember({
        ...base,
        state: 'waking',
        reachable: false,
        alwaysOn: false,
        wakeAttempts: this.wakeAttempts,
        detail: `Studio was ${studio.state}; start requested. Cold start typically takes 1–2 minutes.`,
      });
    }

    // Studio reports running. Did Lightning restart it underneath us?
    const restarted = detectRestart(this.lastObservation, studio);
    this.lastObservation = {
      ...(studio.startedAt !== undefined ? { startedAt: studio.startedAt } : {}),
      ...(studio.uptimeSeconds !== undefined ? { uptimeSeconds: studio.uptimeSeconds } : {}),
    };
    if (restarted) {
      this.detectedRestarts += 1;
      // Keep-state pass: the fresh Studio booted without our server —
      // restart the in-Studio supervisor so the app heals itself.
      await this.restartInStudioSupervisor();
    }

    const healthy = publicUrl ? await this.probe(publicUrl) : false;
    if (!healthy) {
      if (!restarted) await this.restartInStudioSupervisor();
      return this.remember({
        ...base,
        state: 'waking',
        reachable: false,
        alwaysOn: false,
        detectedRestarts: this.detectedRestarts,
        supervisorRestarts: this.supervisorRestarts,
        detail: publicUrl
          ? 'Studio is running but the app did not answer its health check; in-Studio supervisor restarted.'
          : 'Studio is running but no public URL is published yet.',
      });
    }

    this.wakeRequested = false;
    return this.remember({
      ...base,
      state: 'running',
      reachable: true,
      // Honest semantics: free tier is reachable, never always-on.
      alwaysOn: this.tier !== 'free' && this.tier !== 'unknown',
      detectedRestarts: this.detectedRestarts,
      supervisorRestarts: this.supervisorRestarts,
    });
  }

  /** Explicit keep-state pass: a tick that re-checks restart drift. */
  async keepStatePass(): Promise<CloudInstanceState> {
    return this.tick();
  }

  private async restartInStudioSupervisor(): Promise<void> {
    try {
      await this.opts.client.runInStudio(this.studioName, startSupervisorCommand());
      this.supervisorRestarts += 1;
    } catch {
      // Best-effort: the next tick retries. Never throw out of a tick for
      // a failed heal attempt — the state report is the product here.
    }
  }

  private remember(state: CloudInstanceState): CloudInstanceState {
    this.lastState = state;
    return state;
  }
}
