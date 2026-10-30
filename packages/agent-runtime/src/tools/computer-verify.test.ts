// SPDX-License-Identifier: Apache-2.0
// VerifiedOSLayer (ADD-5 item 4): post-action screenshot verification —
// verified / mismatch / capture-failed outcomes, records for the
// span/attempt trail, and the ADD-4 seam: a verification failure throws,
// the runtime turns a thrown handler error into an `{ error }` tool
// result, and classifyToolFailure classes it 'ordinary' (retry-differently),
// never an escalation class.

import { describe, expect, it, vi } from 'vitest';
import { MockOSScreenLayer, type OSScreenLayer, type Screenshot } from './computer.js';
import {
  ComputerVerificationError,
  VerifiedOSLayer,
  hashScreenshotBytes,
  type ComputerVerificationRecord,
} from './computer-verify.js';
import { classifyToolFailure } from '../execution-policy.js';

/** A layer whose screen content changes after every mutating action. */
class ChangingLayer extends MockOSScreenLayer {
  private frame = 0;
  override async screenshot(): Promise<Screenshot> {
    const png = new Uint8Array([137, 80, 78, 71, this.frame]);
    return { png, width: 1920, height: 1080 };
  }
  private bump(): void {
    this.frame += 1;
  }
  override async click(): Promise<void> {
    this.bump();
  }
  override async type(): Promise<void> {
    this.bump();
  }
  override async move(): Promise<void> {
    this.bump();
  }
}

/** A layer whose screen NEVER changes (actions land nowhere). */
class StaticLayer extends MockOSScreenLayer {
  override async screenshot(): Promise<Screenshot> {
    return { png: new Uint8Array([1, 2, 3]), width: 800, height: 600 };
  }
}

/** A layer whose screenshots start failing after the first capture. */
class CaptureFailsLayer extends MockOSScreenLayer {
  private captures = 0;
  override async screenshot(): Promise<Screenshot> {
    this.captures += 1;
    if (this.captures > 1) throw new Error('screen capture unavailable');
    return { png: new Uint8Array([9, 9]), width: 800, height: 600 };
  }
}

describe('VerifiedOSLayer', () => {
  it('passes a verified action through and records changed=true', async () => {
    const records: ComputerVerificationRecord[] = [];
    const layer = new VerifiedOSLayer(new ChangingLayer(), { onVerification: (r) => records.push(r) });
    await layer.click(10, 10);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ step: 'computer_verify:click', action: 'click', outcome: 'verified', changed: true });
    expect(records[0]!.beforeHash).not.toBe(records[0]!.afterHash);
  });

  it('throws ComputerVerificationError on a mismatch (screen unchanged after a click)', async () => {
    const records: ComputerVerificationRecord[] = [];
    const layer = new VerifiedOSLayer(new StaticLayer(), { onVerification: (r) => records.push(r) });
    await expect(layer.click(5, 5)).rejects.toBeInstanceOf(ComputerVerificationError);
    expect(records[0]).toMatchObject({ outcome: 'mismatch', changed: false });
  });

  it('throws when the post-action screenshot cannot be captured (unverified)', async () => {
    const records: ComputerVerificationRecord[] = [];
    const layer = new VerifiedOSLayer(new CaptureFailsLayer(), { onVerification: (r) => records.push(r) });
    await expect(layer.type('hello')).rejects.toBeInstanceOf(ComputerVerificationError);
    expect(records[0]).toMatchObject({ outcome: 'capture-failed', action: 'type' });
  });

  it('does not require change for move (cursor motion changes no pixels)', async () => {
    const records: ComputerVerificationRecord[] = [];
    const layer = new VerifiedOSLayer(new StaticLayer(), { onVerification: (r) => records.push(r) });
    await expect(layer.move(100, 100)).resolves.toBeUndefined();
    expect(records[0]).toMatchObject({ action: 'move', outcome: 'verified', changed: false });
  });

  it('a broken onVerification hook never breaks the action', async () => {
    const layer = new VerifiedOSLayer(new ChangingLayer(), {
      onVerification: () => {
        throw new Error('host hook broken');
      },
    });
    await expect(layer.click(1, 1)).resolves.toBeUndefined();
  });

  it('read-only calls pass straight through without verification records', async () => {
    const onVerification = vi.fn();
    const layer = new VerifiedOSLayer(new ChangingLayer(), { onVerification });
    await layer.screenshot();
    await layer.displaySize();
    expect(onVerification).not.toHaveBeenCalled();
  });

  it('ADD-4 seam: a verification error becomes an ordinary (retryable) tool failure, never an escalation class', () => {
    // This is exactly the runtime path: handler throws → result { error }
    // → classifyToolFailure(result) feeds AttemptLedger.afterAttempt.
    const err = new ComputerVerificationError({
      step: 'computer_verify:click',
      action: 'click',
      at: 0,
      outcome: 'mismatch',
      changed: false,
      detail: 'the screen is unchanged after click',
    });
    const result = { error: err.message };
    expect(classifyToolFailure(result)).toBe('ordinary');
  });

  it('hashScreenshotBytes changes with content and is stable for identical frames', () => {
    const a = hashScreenshotBytes(new Uint8Array([1, 2, 3]));
    expect(hashScreenshotBytes(new Uint8Array([1, 2, 3]))).toBe(a);
    expect(hashScreenshotBytes(new Uint8Array([1, 2, 4]))).not.toBe(a);
  });

  it('wraps any OSScreenLayer (structural check)', () => {
    const layer: OSScreenLayer = new VerifiedOSLayer(new MockOSScreenLayer());
    expect(typeof layer.click).toBe('function');
  });
});
