// SPDX-License-Identifier: Apache-2.0
// W12c "Apply updates when idle": IdleAutoUpdater gating with a mocked
// update source + injected clock (no fake timers needed — tick() is
// driven manually). Cases: setting off → never applies; idle 9min → not
// applied; idle 10min → applied; activity resets the clock; busy blocks;
// no pending update → nothing to apply; ready updates skip download.

import { describe, expect, it, vi } from 'vitest';
import {
  IDLE_APPLY_THRESHOLD_MS,
  IdleAutoUpdater,
  type IdleUpdateSource,
  type UpdateStatus,
} from '../src/self-update.js';

const MIN = 60_000;

function status(state: UpdateStatus['state']): UpdateStatus {
  return {
    state,
    currentVersion: '0.1.0',
    latest: null,
    asset: null,
    downloadedPath: null,
    downloadedBytes: 0,
    totalBytes: 0,
    progress: 0,
    lastCheckedAt: null,
    lastError: null,
    previousInstaller: null,
    platform: 'linux',
    arch: 'x64',
  };
}

function fakeSource(opts: { applyWhenIdle: boolean; state: UpdateStatus['state'] }) {
  let state = opts.state;
  const source: IdleUpdateSource & { calls: string[] } = {
    calls: [],
    getSettings: async () => ({ autoCheck: true, checkIntervalHours: 24, applyWhenIdle: opts.applyWhenIdle }),
    getStatus: async () => status(state),
    download: async () => {
      source.calls.push('download');
      state = 'ready';
      return status(state);
    },
    install: async () => {
      source.calls.push('install');
      state = 'installing';
      return status(state);
    },
  };
  return source;
}

function harness(opts: {
  applyWhenIdle: boolean;
  state: UpdateStatus['state'];
  busy?: () => boolean;
  onApplied?: (status: UpdateStatus) => void;
}) {
  let now = 1_000_000;
  const source = fakeSource(opts);
  const updater = new IdleAutoUpdater({
    source,
    isBusy: opts.busy ?? (() => false),
    now: () => now,
    onApplied: opts.onApplied,
  });
  return {
    source,
    updater,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('IdleAutoUpdater (W12c)', () => {
  it('exposes the 10-minute default threshold', () => {
    expect(IDLE_APPLY_THRESHOLD_MS).toBe(10 * MIN);
  });

  it('setting OFF never auto-applies, even after hours idle with an update pending', async () => {
    const { updater, source, advance } = harness({ applyWhenIdle: false, state: 'ready' });
    advance(3 * 60 * MIN);
    const r = await updater.tick();
    expect(r.applied).toBe(false);
    if (!r.applied) expect(r.reason).toBe('disabled');
    expect(source.calls).toEqual([]);
  });

  it('idle 9 minutes → not applied; 10 minutes → applied (download + install)', async () => {
    const onApplied = vi.fn();
    const { updater, source, advance } = harness({ applyWhenIdle: true, state: 'available', onApplied });
    advance(9 * MIN);
    const early = await updater.tick();
    expect(early.applied).toBe(false);
    if (!early.applied) expect(early.reason).toBe('not-idle-yet');
    expect(source.calls).toEqual([]);
    advance(1 * MIN);
    const r = await updater.tick();
    expect(r.applied).toBe(true);
    expect(source.calls).toEqual(['download', 'install']);
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it('a ready update installs without downloading again', async () => {
    const { updater, source, advance } = harness({ applyWhenIdle: true, state: 'ready' });
    advance(10 * MIN);
    const r = await updater.tick();
    expect(r.applied).toBe(true);
    expect(source.calls).toEqual(['install']);
  });

  it('activity resets the idle clock', async () => {
    const { updater, source, advance } = harness({ applyWhenIdle: true, state: 'ready' });
    advance(9 * MIN);
    updater.recordActivity();
    advance(9 * MIN);
    const r1 = await updater.tick();
    expect(r1.applied).toBe(false);
    expect(source.calls).toEqual([]);
    advance(1 * MIN);
    const r2 = await updater.tick();
    expect(r2.applied).toBe(true);
    expect(source.calls).toEqual(['install']);
  });

  it('busy (running turn/routine) blocks applying and resets idle', async () => {
    let busy = true;
    const { updater, source, advance } = harness({
      applyWhenIdle: true,
      state: 'ready',
      busy: () => busy,
    });
    advance(30 * MIN);
    const r1 = await updater.tick();
    expect(r1.applied).toBe(false);
    if (!r1.applied) expect(r1.reason).toBe('busy');
    busy = false;
    // The busy poll reset the clock: 9 more idle minutes is not enough.
    advance(9 * MIN);
    const r2 = await updater.tick();
    expect(r2.applied).toBe(false);
    advance(1 * MIN);
    const r3 = await updater.tick();
    expect(r3.applied).toBe(true);
    expect(source.calls).toEqual(['install']);
  });

  it('no pending update → nothing applies even when idle', async () => {
    const { updater, source, advance } = harness({ applyWhenIdle: true, state: 'idle' });
    advance(60 * MIN);
    const r = await updater.tick();
    expect(r.applied).toBe(false);
    if (!r.applied) expect(r.reason).toBe('no-pending-update');
    expect(source.calls).toEqual([]);
  });

  it('getIdleStatus reports setting, busy, idle time, and pending state', async () => {
    const { updater, advance } = harness({ applyWhenIdle: true, state: 'available' });
    advance(5 * MIN);
    const s = await updater.getIdleStatus();
    expect(s).toEqual({
      applyWhenIdle: true,
      busy: false,
      idleMs: 5 * MIN,
      idleThresholdMs: IDLE_APPLY_THRESHOLD_MS,
      pendingUpdate: true,
    });
  });
});
