// SPDX-License-Identifier: Apache-2.0
// Browser action gate — the composition point for §4.11 (BR-13/9/7/
// 11/8). The browser runner asks ONE question before every action:
// "may I do this, on this profile, right now?" The gate answers by
// composing the pieces in a fixed, fail-closed order:
//
//   1. HOLD (BR-9 / §1.4) — a person holds or is taking over this
//      profile → blocked. Nothing else is even consulted.
//   2. CAPTCHA (BR-8) — the runner reports a challenge on the page →
//      the action does not run; the result tells the caller to
//      escalate to user takeover (BrowserCaptchaHandler).
//   3. CHECKOUT (BR-11) — the action is a submit inside a checkout on
//      a window whose lease belongs to a DIFFERENT checkout → blocked.
//   4. PERMISSIONS (BR-13) — the per-action suite decides allow / ask /
//      deny (hard denials inside it already ran first there).
//   5. FILE GRANT (BR-7) — upload/download additionally require a
//      scoped, size-classified grant; authorize() consumes a use.
//      A permission `allow` never substitutes for a missing grant,
//      and a grant never substitutes for a permission `deny`.
//
// Result is a discriminated union so the runner can act precisely:
// proceed, ask for approval, or stop with a named reason.

import { BrowserHeldError, defaultBrowserHoldRegistry, type BrowserHoldRegistry } from '@mvp/agent-runtime';
import {
  BrowserPermissionStore,
  originHostOf,
  type BrowserActionKind,
} from './browser-permissions.js';
import { BrowserFileGrantStore, FileGrantDeniedError } from './browser-file-grants.js';
import { CheckoutWindowGuard } from './browser-checkout.js';
import type { CaptchaChallengeSignal } from './browser-captcha.js';

export type BrowserGateResult =
  | { decision: 'allow'; action: BrowserActionKind }
  | { decision: 'ask'; action: BrowserActionKind; reason: string }
  | { decision: 'deny'; action: BrowserActionKind; reason: string; code: GateDenyCode };

export type GateDenyCode =
  | 'held-by-user'
  | 'captcha-takeover-required'
  | 'checkout-busy'
  | 'permission-denied'
  | 'file-grant-denied';

export interface BrowserGateInput {
  profileId: string;
  action: BrowserActionKind;
  url?: string;
  /** BR-13 one-time per-action grant token, when the runner holds one. */
  onceToken?: string;
  /** BR-8: challenge signal the driver detected on the current page. */
  challenge?: CaptchaChallengeSignal;
  /** BR-11: set when this action is part of a checkout on a window. */
  checkout?: { windowId: string; checkoutId?: string };
  /** BR-7: required for upload/download. */
  file?: {
    grantToken: string;
    relPath: string;
    sizeBytes: number;
    taskId?: string;
    sessionId?: string;
    workspaceRoot?: string;
  };
}

export class BrowserActionGate {
  private readonly permissions: BrowserPermissionStore;
  private readonly holds: BrowserHoldRegistry;
  private readonly grants?: BrowserFileGrantStore;
  private readonly checkoutGuard?: CheckoutWindowGuard;

  constructor(deps: {
    permissions: BrowserPermissionStore;
    holds?: BrowserHoldRegistry;
    grants?: BrowserFileGrantStore;
    checkoutGuard?: CheckoutWindowGuard;
  }) {
    this.permissions = deps.permissions;
    this.holds = deps.holds ?? defaultBrowserHoldRegistry;
    this.grants = deps.grants;
    this.checkoutGuard = deps.checkoutGuard;
  }

  check(input: BrowserGateInput): BrowserGateResult {
    const { action } = input;

    // 1. Hold / takeover — the person owns the browser right now.
    const hold = this.holds.get(input.profileId);
    if (hold) {
      return {
        decision: 'deny',
        action,
        code: 'held-by-user',
        reason: new BrowserHeldError(hold).message,
      };
    }

    // 2. CAPTCHA — never interact; escalate to user takeover.
    if (input.challenge) {
      return {
        decision: 'deny',
        action,
        code: 'captcha-takeover-required',
        reason:
          `a ${input.challenge.kind} challenge is present on this page — the task pauses and the user ` +
          'takes over the browser to complete it personally (BR-8); the bot does not solve or bypass checks',
      };
    }

    // 3. One checkout per window.
    if (input.checkout && this.checkoutGuard) {
      const active = this.checkoutGuard.activeFor(input.checkout.windowId);
      if (active && active.checkoutId !== input.checkout.checkoutId) {
        return {
          decision: 'deny',
          action,
          code: 'checkout-busy',
          reason:
            `window "${input.checkout.windowId}" is already running checkout ` +
            `${active.checkoutId ?? active.id} — one checkout per window (BR-11)`,
        };
      }
    }

    // 4. Per-action permissions (hard denials are inside, first).
    const evaluation = this.permissions.evaluate({
      profileId: input.profileId,
      action,
      url: input.url,
      origin: originHostOf(input.url),
      onceToken: input.onceToken,
    });
    if (evaluation.effect === 'deny') {
      return { decision: 'deny', action, code: 'permission-denied', reason: evaluation.reason };
    }
    if (evaluation.effect === 'ask') {
      return { decision: 'ask', action, reason: evaluation.reason };
    }

    // 5. Upload/download need a BR-7 grant on top of the permission.
    if (action === 'upload' || action === 'download') {
      if (!this.grants) {
        return {
          decision: 'deny',
          action,
          code: 'file-grant-denied',
          reason: 'no file-grant store is wired — upload/download cannot be authorized (BR-7)',
        };
      }
      if (!input.file) {
        return {
          decision: 'deny',
          action,
          code: 'file-grant-denied',
          reason: `${action} requires a scoped BR-7 file grant (token, path, size) — none was presented`,
        };
      }
      try {
        this.grants.authorize({
          token: input.file.grantToken,
          direction: action,
          profileId: input.profileId,
          taskId: input.file.taskId,
          sessionId: input.file.sessionId,
          relPath: input.file.relPath,
          sizeBytes: input.file.sizeBytes,
          workspaceRoot: input.file.workspaceRoot,
        });
      } catch (err) {
        return {
          decision: 'deny',
          action,
          code: 'file-grant-denied',
          reason: err instanceof FileGrantDeniedError ? err.reason : err instanceof Error ? err.message : String(err),
        };
      }
    }

    return { decision: 'allow', action };
  }
}
