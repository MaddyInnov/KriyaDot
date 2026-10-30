// SPDX-License-Identifier: Apache-2.0
// Screenshot verification for real computer actions (closure ADD-5 item 4).
//
// Problem: a computer_* tool handler returns success as soon as the OS
// layer's click/type/key call resolves — but "the call did not throw" is
// not "the screen did what was intended". The ADD-4 execution policy
// (execution-policy.ts) can only retry-differently on failures it can SEE:
// the runtime converts a thrown handler error into a `{ error }` tool
// result, `classifyToolFailure()` classes it 'ordinary', and the
// AttemptLedger counts it toward the per-step bound and arms the
// material-change rule. A silent no-op action was invisible to that loop.
//
// This module is the missing seam: a VerifiedOSLayer decorator that, after
// every mutating action, captures a fresh screenshot and compares it with
// the pre-action frame.
//   - Post-action capture fails / returns no bytes → the action is
//     UNVERIFIED: a ComputerVerificationError is thrown, which the runtime
//     surfaces as an ordinary tool failure → ADD-4 retries differently.
//   - A change-expected action (click/type/key/scroll/drag) whose frame is
//     byte-identical to the pre-action frame is a MISMATCH: same path.
//   - Every outcome is also reported as a ComputerVerificationRecord via
//     the `onVerification` hook, so the host can write it into the span /
//     attempt trail (step name `computer_verify:<action>`) even when the
//     action is allowed to stand (e.g. `move`, where a static frame is
//     legitimate — moving the cursor over an unchanging desktop changes
//     no pixels, so change is recorded but not required).
//
// Governance is untouched: verification runs AFTER the (already approved)
// action inside the OS layer; it can only turn invisible failures into
// visible ones, never approve or widen anything.

import type {
  ClickOptions,
  DisplaySize,
  DragOptions,
  OSScreenLayer,
  RealOSAction,
  Screenshot,
} from './computer.js';
import type { ChordModifier } from './computer-keys.js';

/** FNV-1a frame hash — a change detector, not a security hash. */
export function hashScreenshotBytes(png: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < png.length; i++) {
    h ^= png[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export type ComputerVerificationOutcome = 'verified' | 'mismatch' | 'capture-failed';

export interface ComputerVerificationRecord {
  /** Span/attempt step name for this verification: `computer_verify:<action>`. */
  step: string;
  action: RealOSAction;
  at: number;
  outcome: ComputerVerificationOutcome;
  /** True/false when both frames were captured; null when one is missing. */
  changed: boolean | null;
  beforeHash?: string;
  afterHash?: string;
  detail?: string;
}

/**
 * Thrown when a real action cannot be verified (or its verification
 * mismatches). The message deliberately avoids the credential/approval
 * phrasings `classifyToolFailure()` treats as escalation classes, so the
 * ADD-4 policy classes it 'ordinary' and retries with a material change.
 */
export class ComputerVerificationError extends Error {
  readonly record: ComputerVerificationRecord;
  constructor(record: ComputerVerificationRecord) {
    super(
      `[computer-verify] ${record.action} could not be verified: ${record.detail ?? record.outcome}. ` +
        'The screen did not confirm the action — diagnose from a fresh screenshot and retry with a different approach.',
    );
    this.name = 'ComputerVerificationError';
    this.record = record;
  }
}

export interface VerifiedOSLayerOptions {
  /** Host hook: write the record into spans / the attempt trail / audit. */
  onVerification?: (record: ComputerVerificationRecord) => void;
  /**
   * Actions that must visibly change the frame. Default: click, type,
   * key, scroll, drag. `move` is excluded (cursor motion alone changes
   * no pixels on a static screen).
   */
  requireChangeFor?: readonly RealOSAction[];
  /** Clock (tests inject a fake). */
  now?: () => number;
}

const DEFAULT_REQUIRE_CHANGE: readonly RealOSAction[] = ['click', 'type', 'key', 'scroll', 'drag'];

/** OSScreenLayer decorator adding post-action screenshot verification. */
export class VerifiedOSLayer implements OSScreenLayer {
  private readonly requireChange: ReadonlySet<RealOSAction>;
  private readonly onVerification?: (record: ComputerVerificationRecord) => void;
  private readonly now: () => number;

  constructor(
    private readonly inner: OSScreenLayer,
    opts: VerifiedOSLayerOptions = {},
  ) {
    this.requireChange = new Set(opts.requireChangeFor ?? DEFAULT_REQUIRE_CHANGE);
    this.onVerification = opts.onVerification;
    this.now = opts.now ?? Date.now;
  }

  /** The wrapped layer (inspection / unwrapping by hosts). */
  get wrapped(): OSScreenLayer {
    return this.inner;
  }

  displaySize(): Promise<DisplaySize> {
    return this.inner.displaySize();
  }

  screenshot(): Promise<Screenshot> {
    return this.inner.screenshot();
  }

  private async captureHash(): Promise<{ hash: string; bytes: number } | null> {
    try {
      const shot = await this.inner.screenshot();
      if (!shot.png || shot.png.length === 0) return null;
      return { hash: hashScreenshotBytes(shot.png), bytes: shot.png.length };
    } catch {
      return null;
    }
  }

  private async verify<T>(action: RealOSAction, run: () => Promise<T>): Promise<T> {
    const before = await this.captureHash();
    const result = await run();
    const after = await this.captureHash();
    const record: ComputerVerificationRecord = {
      step: `computer_verify:${action}`,
      action,
      at: this.now(),
      outcome: 'verified',
      changed: before && after ? before.hash !== after.hash : null,
      ...(before ? { beforeHash: before.hash } : {}),
      ...(after ? { afterHash: after.hash } : {}),
    };
    if (!after) {
      record.outcome = 'capture-failed';
      record.detail = 'the post-action screenshot could not be captured, so the result is unconfirmed';
      this.emit(record);
      throw new ComputerVerificationError(record);
    }
    if (this.requireChange.has(action) && before && record.changed === false) {
      record.outcome = 'mismatch';
      record.detail = `the screen is unchanged after ${action} — the action likely missed its target`;
      this.emit(record);
      throw new ComputerVerificationError(record);
    }
    this.emit(record);
    return result;
  }

  private emit(record: ComputerVerificationRecord): void {
    try {
      this.onVerification?.(record);
    } catch {
      // A broken host hook must never break (or fake) the action itself.
    }
  }

  click(x: number, y: number, opts?: ClickOptions): Promise<void> {
    return this.verify('click', () => this.inner.click(x, y, opts));
  }

  type(text: string): Promise<void> {
    return this.verify('type', () => this.inner.type(text));
  }

  key(name: string): Promise<void> {
    return this.verify('key', () => this.inner.key(name));
  }

  keyChord(modifiers: ChordModifier[], key: string): Promise<void> {
    return this.verify('key', () => this.inner.keyChord(modifiers, key));
  }

  scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    return this.verify('scroll', () => this.inner.scroll(x, y, deltaX, deltaY));
  }

  drag(x1: number, y1: number, x2: number, y2: number, opts: DragOptions): Promise<void> {
    return this.verify('drag', () => this.inner.drag(x1, y1, x2, y2, opts));
  }

  move(x: number, y: number): Promise<void> {
    return this.verify('move', () => this.inner.move(x, y));
  }
}
