// SPDX-License-Identifier: Apache-2.0
/**
 * Spend-threshold approval contract (#72).
 *
 * Spend CAPS (spend-caps.ts) are a binary allow / hard-stop. This gate
 * adds the missing middle: a spend THRESHOLD. When a turn/session's
 * projected spend crosses a configured threshold multiple, the gate
 * produces a `threshold-ask` decision instead of silently allowing or
 * hard-stopping:
 *
 * - interactive context → the surface asks the human (y/N). The ask is
 *   recorded as a pending decision ({@link ThresholdGate.pending}).
 *   Approving allows spend up to the NEXT threshold multiple; the
 *   gate asks again when that multiple is crossed. Denying stops.
 * - non-interactive context → there is nobody to ask, so the gate
 *   returns a stop decision carrying the resumable exit-75 semantics
 *   of the CLI contract (packages/cli/src/exits.ts: EXIT_RESUMABLE =
 *   75, EX_TEMPFAIL — the session is intact and can be resumed after
 *   the threshold is approved out of band via {@link ThresholdGate.approve}).
 *
 * This module is deliberately surface-free: CLI/web wiring renders the
 * ask and maps a `stop` decision to process exit 75. All amounts are
 * USD cents (integers), matching the rest of @mvp/billing.
 */

import { randomUUID } from 'node:crypto';

/** Exit code a `stop` decision maps to — the CLI's resumable-stop contract. */
export const THRESHOLD_EXIT_CODE = 75;
/** Marker string surfaces embed in stop events so resumption can recognize them. */
export const THRESHOLD_RESUMABLE_MARKER = 'exit-75-resumable';

export interface ThresholdGateConfig {
  /**
   * Threshold interval in USD cents (positive integer). Every multiple
   * of this value (1×, 2×, 3×, …) is an ask point.
   */
  thresholdCents: number;
}

export interface ThresholdCheckInput {
  /** Spend already recorded for the turn/session scope, USD cents. */
  spentCents: number;
  /** Projected additional spend of the upcoming call, USD cents (default 0). */
  projectedAdditionalCents?: number;
  /** True when a human can be asked right now (interactive surface). */
  interactive: boolean;
  sessionId?: string;
  turnId?: string;
}

export type ThresholdDecisionKind = 'allow' | 'threshold-ask' | 'stop';

export interface ThresholdDecision {
  kind: ThresholdDecisionKind;
  /** spent + projected, USD cents. */
  projectedCents: number;
  /** The threshold multiple that was crossed (USD cents), or null when none. */
  crossedThresholdCents: number | null;
  /** Id of the recorded pending decision — present on 'threshold-ask' and 'stop'. */
  pendingId?: string;
  /** Spend is approved up to (but not including crossing) this amount, USD cents. */
  approvedUpToCents: number;
  /** Present on 'stop': the resumable exit code (75). */
  exitCode?: number;
  /** Present on 'stop': true — the session may be resumed after approval. */
  resumable?: boolean;
  /** Present on 'stop': the resumable marker for stop events. */
  marker?: string;
  reason: string;
}

export type ThresholdPendingStatus = 'pending' | 'approved' | 'denied' | 'stopped';

export interface ThresholdPendingDecision {
  id: string;
  createdAt: number;
  sessionId?: string;
  turnId?: string;
  projectedCents: number;
  /** The threshold multiple whose crossing raised this decision. */
  crossedThresholdCents: number;
  /** Whether the decision was raised in an interactive context. */
  interactive: boolean;
  status: ThresholdPendingStatus;
  decidedAt?: number;
}

function requireThresholdCents(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new Error('thresholdCents must be a positive integer (USD cents)');
  }
  return v;
}

function floorCents(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} must be a finite number`);
  return Math.max(0, Math.floor(v));
}

/**
 * Stateful threshold gate for one turn/session scope. One gate per
 * scope: approvals are remembered, so an approved threshold does not
 * re-ask until the NEXT multiple is crossed.
 */
export class ThresholdGate {
  private readonly thresholdCents: number;
  /** Highest threshold multiple approved so far (USD cents; 0 = none). */
  private approvedMultipleCents = 0;
  private readonly pendingById = new Map<string, ThresholdPendingDecision>();

  constructor(config: ThresholdGateConfig) {
    this.thresholdCents = requireThresholdCents(config.thresholdCents);
  }

  get threshold(): number {
    return this.thresholdCents;
  }

  /** Highest approved threshold multiple (0 when nothing was approved). */
  get approvedUpToCents(): number {
    return this.approvedMultipleCents;
  }

  /** All recorded decisions (pending and decided), oldest first. */
  listPending(): ThresholdPendingDecision[] {
    return [...this.pendingById.values()].map((p) => ({ ...p }));
  }

  /** One recorded decision by id. */
  getPending(id: string): ThresholdPendingDecision | undefined {
    const p = this.pendingById.get(id);
    return p ? { ...p } : undefined;
  }

  /**
   * Check projected spend against the threshold.
   * Below the next unapproved multiple → allow. Crossing one →
   * threshold-ask (interactive) or stop + exit-75 marker
   * (non-interactive); either way a pending decision is recorded.
   */
  check(input: ThresholdCheckInput): ThresholdDecision {
    const projectedCents =
      floorCents(input.spentCents, 'spentCents') +
      floorCents(input.projectedAdditionalCents ?? 0, 'projectedAdditionalCents');
    const crossed =
      projectedCents >= this.thresholdCents
        ? Math.floor(projectedCents / this.thresholdCents) * this.thresholdCents
        : 0;
    if (crossed <= this.approvedMultipleCents) {
      return {
        kind: 'allow',
        projectedCents,
        crossedThresholdCents: crossed > 0 ? crossed : null,
        approvedUpToCents: this.approvedMultipleCents,
        reason:
          crossed === 0
            ? `projected spend ${projectedCents}c is below the ${this.thresholdCents}c threshold`
            : `projected spend ${projectedCents}c is within the approved threshold (approved up to the ${this.approvedMultipleCents}c multiple)`,
      };
    }

    const record: ThresholdPendingDecision = {
      id: `thr_${randomUUID()}`,
      createdAt: Date.now(),
      sessionId: input.sessionId,
      turnId: input.turnId,
      projectedCents,
      crossedThresholdCents: crossed,
      interactive: input.interactive === true,
      status: input.interactive === true ? 'pending' : 'stopped',
    };
    this.pendingById.set(record.id, record);

    if (input.interactive === true) {
      return {
        kind: 'threshold-ask',
        projectedCents,
        crossedThresholdCents: crossed,
        pendingId: record.id,
        approvedUpToCents: this.approvedMultipleCents,
        reason: `projected spend ${projectedCents}c crosses the ${crossed}c spend threshold — ask the user before continuing`,
      };
    }
    return {
      kind: 'stop',
      projectedCents,
      crossedThresholdCents: crossed,
      pendingId: record.id,
      approvedUpToCents: this.approvedMultipleCents,
      exitCode: THRESHOLD_EXIT_CODE,
      resumable: true,
      marker: THRESHOLD_RESUMABLE_MARKER,
      reason: `projected spend ${projectedCents}c crosses the ${crossed}c spend threshold and no interactive user is available — stopping with resumable exit ${THRESHOLD_EXIT_CODE}; approve the threshold to resume`,
    };
  }

  /**
   * Approve a recorded ask/stop: spend is allowed until the NEXT
   * threshold multiple beyond the one that was crossed. Returns the
   * resulting allow decision.
   */
  approve(pendingId: string): ThresholdDecision {
    const record = this.mustGet(pendingId);
    if (record.status === 'approved') {
      return this.allowDecision(record, 'threshold already approved');
    }
    if (record.status === 'denied') {
      throw new Error(`threshold decision ${pendingId} was denied and cannot be approved`);
    }
    record.status = 'approved';
    record.decidedAt = Date.now();
    if (record.crossedThresholdCents > this.approvedMultipleCents) {
      this.approvedMultipleCents = record.crossedThresholdCents;
    }
    return this.allowDecision(record, `threshold ${record.crossedThresholdCents}c approved — allowed until the next threshold multiple`);
  }

  /**
   * Deny a recorded ask: the caller must stop, with the same
   * resumable exit-75 semantics (a later approval of a NEW ask is a
   * fresh decision; this one stays denied).
   */
  deny(pendingId: string): ThresholdDecision {
    const record = this.mustGet(pendingId);
    if (record.status !== 'denied') {
      record.status = 'denied';
      record.decidedAt = Date.now();
    }
    return {
      kind: 'stop',
      projectedCents: record.projectedCents,
      crossedThresholdCents: record.crossedThresholdCents,
      pendingId: record.id,
      approvedUpToCents: this.approvedMultipleCents,
      exitCode: THRESHOLD_EXIT_CODE,
      resumable: true,
      marker: THRESHOLD_RESUMABLE_MARKER,
      reason: `spend threshold ${record.crossedThresholdCents}c was denied — stopping with resumable exit ${THRESHOLD_EXIT_CODE}`,
    };
  }

  private allowDecision(record: ThresholdPendingDecision, reason: string): ThresholdDecision {
    return {
      kind: 'allow',
      projectedCents: record.projectedCents,
      crossedThresholdCents: record.crossedThresholdCents,
      pendingId: record.id,
      approvedUpToCents: this.approvedMultipleCents,
      reason,
    };
  }

  private mustGet(pendingId: string): ThresholdPendingDecision {
    const record = this.pendingById.get(pendingId);
    if (!record) throw new Error(`threshold decision not found: ${pendingId}`);
    return record;
  }
}

/**
 * Stateless one-shot evaluation (no memory of approvals): equivalent
 * to a fresh gate's `check` with `approvedUpToCents` supplied
 * explicitly. Useful for surfaces that persist approvals themselves.
 */
export function evaluateThreshold(opts: {
  thresholdCents: number;
  spentCents: number;
  projectedAdditionalCents?: number;
  approvedUpToCents?: number;
  interactive: boolean;
}): Pick<ThresholdDecision, 'kind' | 'projectedCents' | 'crossedThresholdCents' | 'approvedUpToCents' | 'exitCode' | 'resumable' | 'marker' | 'reason'> {
  const threshold = requireThresholdCents(opts.thresholdCents);
  const projectedCents =
    floorCents(opts.spentCents, 'spentCents') + floorCents(opts.projectedAdditionalCents ?? 0, 'projectedAdditionalCents');
  const approvedUpTo = floorCents(opts.approvedUpToCents ?? 0, 'approvedUpToCents');
  const crossed = projectedCents >= threshold ? Math.floor(projectedCents / threshold) * threshold : 0;
  if (crossed <= approvedUpTo) {
    return {
      kind: 'allow',
      projectedCents,
      crossedThresholdCents: crossed > 0 ? crossed : null,
      approvedUpToCents: approvedUpTo,
      reason: 'projected spend is below or within the approved threshold',
    };
  }
  if (opts.interactive === true) {
    return {
      kind: 'threshold-ask',
      projectedCents,
      crossedThresholdCents: crossed,
      approvedUpToCents: approvedUpTo,
      reason: `projected spend ${projectedCents}c crosses the ${crossed}c spend threshold — ask the user before continuing`,
    };
  }
  return {
    kind: 'stop',
    projectedCents,
    crossedThresholdCents: crossed,
    approvedUpToCents: approvedUpTo,
    exitCode: THRESHOLD_EXIT_CODE,
    resumable: true,
    marker: THRESHOLD_RESUMABLE_MARKER,
    reason: `projected spend ${projectedCents}c crosses the ${crossed}c spend threshold and no interactive user is available — stopping with resumable exit ${THRESHOLD_EXIT_CODE}`,
  };
}

/** Human-readable one-liner for a threshold decision (CLI/web surfaces). */
export function formatThresholdMessage(decision: ThresholdDecision): string {
  const fmt = (c: number): string => `$${(c / 100).toFixed(2)}`;
  switch (decision.kind) {
    case 'allow':
      return `Spend threshold: projected ${fmt(decision.projectedCents)} — allowed.`;
    case 'threshold-ask':
      return `Spend threshold reached: projected ${fmt(decision.projectedCents)} crosses ${fmt(decision.crossedThresholdCents ?? 0)}. Continue? (y/N)`;
    case 'stop':
      return `Spend threshold reached: projected ${fmt(decision.projectedCents)} crosses ${fmt(decision.crossedThresholdCents ?? 0)}. Stopped (resumable, exit ${THRESHOLD_EXIT_CODE}) — approve the threshold and resume the session to continue.`;
  }
}
