// SPDX-License-Identifier: Apache-2.0
// #72: spend-threshold approval contract — threshold-ask in
// interactive contexts, resumable exit-75 stop otherwise.

import { describe, expect, it } from 'vitest';
import {
  THRESHOLD_EXIT_CODE,
  THRESHOLD_RESUMABLE_MARKER,
  ThresholdGate,
  evaluateThreshold,
  formatThresholdMessage,
} from '../src/index.js';

describe('ThresholdGate', () => {
  it('allows below the threshold', () => {
    const gate = new ThresholdGate({ thresholdCents: 1000 });
    const d = gate.check({ spentCents: 500, projectedAdditionalCents: 499, interactive: true });
    expect(d.kind).toBe('allow');
    expect(d.projectedCents).toBe(999);
    expect(d.crossedThresholdCents).toBeNull();
    expect(gate.listPending()).toHaveLength(0);
  });

  it('produces a threshold-ask at the threshold in interactive contexts and records it pending', () => {
    const gate = new ThresholdGate({ thresholdCents: 1000 });
    const d = gate.check({ spentCents: 900, projectedAdditionalCents: 100, interactive: true, sessionId: 's1' });
    expect(d.kind).toBe('threshold-ask');
    expect(d.crossedThresholdCents).toBe(1000);
    expect(d.pendingId).toBeTruthy();
    expect(d.exitCode).toBeUndefined();
    const pending = gate.getPending(d.pendingId!);
    expect(pending?.status).toBe('pending');
    expect(pending?.sessionId).toBe('s1');
    expect(pending?.projectedCents).toBe(1000);
  });

  it('approved → allow until the next threshold multiple, then asks again', () => {
    const gate = new ThresholdGate({ thresholdCents: 1000 });
    const ask = gate.check({ spentCents: 1000, interactive: true });
    expect(ask.kind).toBe('threshold-ask');
    const approved = gate.approve(ask.pendingId!);
    expect(approved.kind).toBe('allow');
    expect(approved.approvedUpToCents).toBe(1000);
    expect(gate.getPending(ask.pendingId!)?.status).toBe('approved');

    // Still below the next multiple: no re-ask.
    expect(gate.check({ spentCents: 1999, interactive: true }).kind).toBe('allow');
    // Crossing the next multiple asks again.
    const ask2 = gate.check({ spentCents: 2000, interactive: true });
    expect(ask2.kind).toBe('threshold-ask');
    expect(ask2.crossedThresholdCents).toBe(2000);
    expect(ask2.pendingId).not.toBe(ask.pendingId);
  });

  it('a jump across several multiples approves up to the highest crossed multiple', () => {
    const gate = new ThresholdGate({ thresholdCents: 1000 });
    const ask = gate.check({ spentCents: 3500, interactive: true });
    expect(ask.crossedThresholdCents).toBe(3000);
    gate.approve(ask.pendingId!);
    expect(gate.check({ spentCents: 3999, interactive: true }).kind).toBe('allow');
    expect(gate.check({ spentCents: 4000, interactive: true }).kind).toBe('threshold-ask');
  });

  it('denied → stop carrying the exit-75 resumable marker', () => {
    const gate = new ThresholdGate({ thresholdCents: 1000 });
    const ask = gate.check({ spentCents: 1200, interactive: true });
    const denied = gate.deny(ask.pendingId!);
    expect(denied.kind).toBe('stop');
    expect(denied.exitCode).toBe(THRESHOLD_EXIT_CODE);
    expect(THRESHOLD_EXIT_CODE).toBe(75);
    expect(denied.resumable).toBe(true);
    expect(denied.marker).toBe(THRESHOLD_RESUMABLE_MARKER);
    expect(gate.getPending(ask.pendingId!)?.status).toBe('denied');
    // A denied decision cannot later be approved.
    expect(() => gate.approve(ask.pendingId!)).toThrow(/denied/);
  });

  it('non-interactive → stop with exit-75 semantics, recorded and resumable via approve', () => {
    const gate = new ThresholdGate({ thresholdCents: 500 });
    const d = gate.check({ spentCents: 600, interactive: false, sessionId: 'bg' });
    expect(d.kind).toBe('stop');
    expect(d.exitCode).toBe(75);
    expect(d.resumable).toBe(true);
    expect(d.marker).toBe('exit-75-resumable');
    expect(d.pendingId).toBeTruthy();
    expect(gate.getPending(d.pendingId!)?.status).toBe('stopped');
    // Out-of-band approval makes the session resumable.
    const approved = gate.approve(d.pendingId!);
    expect(approved.kind).toBe('allow');
    expect(gate.check({ spentCents: 600, interactive: false }).kind).toBe('allow');
  });

  it('rejects unknown pending ids and invalid thresholds', () => {
    const gate = new ThresholdGate({ thresholdCents: 100 });
    expect(() => gate.approve('thr_nope')).toThrow(/not found/);
    expect(() => gate.deny('thr_nope')).toThrow(/not found/);
    expect(() => new ThresholdGate({ thresholdCents: 0 })).toThrow(/positive integer/);
    expect(() => new ThresholdGate({ thresholdCents: 10.5 })).toThrow(/positive integer/);
  });
});

describe('evaluateThreshold (stateless)', () => {
  it('mirrors the gate decisions', () => {
    expect(
      evaluateThreshold({ thresholdCents: 1000, spentCents: 10, interactive: true }).kind,
    ).toBe('allow');
    expect(
      evaluateThreshold({ thresholdCents: 1000, spentCents: 1000, interactive: true }).kind,
    ).toBe('threshold-ask');
    const stop = evaluateThreshold({ thresholdCents: 1000, spentCents: 1000, interactive: false });
    expect(stop.kind).toBe('stop');
    expect(stop.exitCode).toBe(75);
    expect(stop.marker).toBe(THRESHOLD_RESUMABLE_MARKER);
    // A persisted approval watermark suppresses the ask.
    expect(
      evaluateThreshold({
        thresholdCents: 1000,
        spentCents: 1500,
        approvedUpToCents: 1000,
        interactive: true,
      }).kind,
    ).toBe('allow');
  });

  it('formatThresholdMessage renders the ask as a y/N question', () => {
    const gate = new ThresholdGate({ thresholdCents: 1000 });
    const ask = gate.check({ spentCents: 1000, interactive: true });
    expect(formatThresholdMessage(ask)).toContain('(y/N)');
    const stop = evaluateThreshold({ thresholdCents: 1000, spentCents: 1000, interactive: false });
    expect(formatThresholdMessage({ ...stop, pendingId: undefined })).toContain('exit 75');
  });
});
