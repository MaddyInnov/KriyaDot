// SPDX-License-Identifier: Apache-2.0
// Cloud supervisor — wake-on-traffic + keep-state for a cloud-host
// instance. Pure logic with an injected client, an injected health
// probe, and an injected clock: fully unit-tested with
// FakeCloudHostClient, no timers, no network.
//
// HONEST STATE MODEL (read before editing):
// - `alwaysOn` is true only when the host reports an always-on-capable
//   tier AND the instance is reachable. On tiers that may sleep idle
//   instances or restart them periodically (free / unknown), the
//   strongest honest claim is "always reachable": traffic (or this
//   supervisor's probe) wakes the instance, with a cold start that can
//   take a minute or two. `alwaysOn` is therefore false on those tiers,
//   in every state — do not "fix" this to be optimistic.
// - A `waking` state is exposed (never "down") while a start is in
//   flight, so clients can render "waking…" instead of an error.

import {
  DEFAULT_INSTANCE_NAME,
  resolveInstancePublicUrl,
  type CloudHostClient,
  type CloudHostState,
} from './cloud-host.js';
import { startSupervisorCommand } from './cloud-deploy.js';

export type CloudTier = 'free' | 'pro' | 'teams' | 'enterprise' | 'unknown';

export interface CloudInstanceState {
  instance: string;
  /** Mapped state; `waking` covers sleeping/stopped/starting once a wake was requested. */
  state: CloudHostState;
  /** True only when the public URL answered the health probe. */
  reachable: boolean;
  tier: CloudTier;
  /**
   * True only when the tier is always-on-capable AND the instance is
   * reachable. Never true on free/unknown tiers. Do not make this
   * optimistic.
   */
  alwaysOn: boolean;
  publicUrl?: string;
  machine?: string;
  uptimeSeconds?: number;
  lastCheckedAt: number;
  /** Times a host-side restart was detected (uptime/startedAt moved backwards). */
  detectedRestarts: number;
  /** Times this supervisor asked the host to start the instance. */
  wakeAttempts: number;
  /** Times this supervisor (re)started the in-instance supervisor script. */
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
  client: CloudHostClient;
  instanceName?: string;
  tier?: CloudTier;
  port?: number;
  healthProbe?: HealthProbe;
  clock?: CloudClock;
}

/** Tiers on which the host reports always-on capability. */
export function isAlwaysOnCapableTier(tier: CloudTier): boolean {
  return tier === 'pro' || tier === 'teams' || tier === 'enterprise';
}

/**
 * Detect a host-side restart between two observations: the start time
 * moved, or uptime went backwards. Pure; exported for testing.
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
  private readonly instanceName: string;
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
    this.instanceName = opts.instanceName ?? DEFAULT_INSTANCE_NAME;
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
   * 1. Read the instance's mapped state.
   * 2. Sleeping/stopped/starting → ask the host to start it and report
   *    `waking` (wake-on-traffic semantics; the probe counts as traffic).
   * 3. Running → probe the public URL. Unhealthy → (re)start the
   *    in-instance supervisor script once and report `waking`.
   * 4. Running + healthy → `running`/`reachable`. If a host-side restart
   *    is detected since the last pass, run a keep-state pass: restart
   *    the in-instance supervisor so the server comes back under
   *    supervision on the fresh instance.
   */
  async tick(): Promise<CloudInstanceState> {
    const now = this.clock.now();
    const instance = await this.opts.client.getInstance(this.instanceName);

    if (!instance) {
      return this.remember({
        instance: this.instanceName,
        state: 'stopped',
        reachable: false,
        tier: this.tier,
        alwaysOn: false,
        lastCheckedAt: now,
        detectedRestarts: this.detectedRestarts,
        wakeAttempts: this.wakeAttempts,
        supervisorRestarts: this.supervisorRestarts,
        detail: 'Instance does not exist yet — deploy first.',
      });
    }

    const publicUrl = resolveInstancePublicUrl(instance, this.port) ?? instance.publicUrl;
    const base = {
      instance: this.instanceName,
      tier: this.tier,
      ...(publicUrl ? { publicUrl } : {}),
      ...(instance.machine ? { machine: instance.machine } : {}),
      ...(instance.uptimeSeconds !== undefined ? { uptimeSeconds: instance.uptimeSeconds } : {}),
      lastCheckedAt: now,
      detectedRestarts: this.detectedRestarts,
      wakeAttempts: this.wakeAttempts,
      supervisorRestarts: this.supervisorRestarts,
    };

    if (instance.state !== 'running') {
      // Wake-on-traffic: a sleeping/stopped instance gets a start
      // request, and the exposed state is `waking` — never "down".
      await this.opts.client.startInstance(this.instanceName);
      this.wakeAttempts += 1;
      this.wakeRequested = true;
      return this.remember({
        ...base,
        state: 'waking',
        reachable: false,
        alwaysOn: false,
        wakeAttempts: this.wakeAttempts,
        detail: `Instance was ${instance.state}; start requested. Cold start typically takes 1–2 minutes.`,
      });
    }

    // Instance reports running. Did the host restart it underneath us?
    const restarted = detectRestart(this.lastObservation, instance);
    this.lastObservation = {
      ...(instance.startedAt !== undefined ? { startedAt: instance.startedAt } : {}),
      ...(instance.uptimeSeconds !== undefined ? { uptimeSeconds: instance.uptimeSeconds } : {}),
    };
    if (restarted) {
      this.detectedRestarts += 1;
      // Keep-state pass: the fresh instance booted without our server —
      // restart the in-instance supervisor so the app heals itself.
      await this.restartInInstanceSupervisor();
    }

    const healthy = publicUrl ? await this.probe(publicUrl) : false;
    if (!healthy) {
      if (!restarted) await this.restartInInstanceSupervisor();
      return this.remember({
        ...base,
        state: 'waking',
        reachable: false,
        alwaysOn: false,
        detectedRestarts: this.detectedRestarts,
        supervisorRestarts: this.supervisorRestarts,
        detail: publicUrl
          ? 'Instance is running but the app did not answer its health check; in-instance supervisor restarted.'
          : 'Instance is running but no public URL is published yet.',
      });
    }

    this.wakeRequested = false;
    return this.remember({
      ...base,
      state: 'running',
      reachable: true,
      // Honest semantics: always-on only on an always-on-capable tier,
      // and only while reachable (this branch is the reachable one).
      alwaysOn: isAlwaysOnCapableTier(this.tier),
      detectedRestarts: this.detectedRestarts,
      supervisorRestarts: this.supervisorRestarts,
    });
  }

  /** Explicit keep-state pass: a tick that re-checks restart drift. */
  async keepStatePass(): Promise<CloudInstanceState> {
    return this.tick();
  }

  private async restartInInstanceSupervisor(): Promise<void> {
    try {
      await this.opts.client.runOnInstance(this.instanceName, startSupervisorCommand());
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
