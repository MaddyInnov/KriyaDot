// SPDX-License-Identifier: Apache-2.0
// iOS companion signing + APNs readiness (Muse parity §4.5 C-13).
//
// CREDENTIAL-GATED: a signed, APNs-capable iOS build cannot be produced
// or verified without the founder's Apple Developer account, signing
// identity, provisioning profile and a physical device / Xcode host.
// This module is the SOURCE-LEVEL preparation: a pure readiness check
// that names exactly what is present and what the founder must supply.
// It never fabricates a "ready" state — `ready` is true only when every
// required item actually checks out.

import express, { type Router } from 'express';
import { resolveApnsConfig } from './push.js';

export interface ReadinessItem {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  /** Who can fix it when not ok. */
  owner: 'founder' | 'config' | 'done';
}
export interface IosReadiness {
  ready: boolean;
  items: ReadinessItem[];
  blockers: string[];
}

export interface IosReadinessEnv {
  env?: NodeJS.ProcessEnv;
  /** Entitlements aps-environment value read from the app (injected for tests). */
  apsEnvironment?: string;
  /** Whether a DEVELOPMENT_TEAM is configured in the Xcode project/xcconfig. */
  hasDevelopmentTeam?: boolean;
  bundleId?: string;
}

/**
 * Evaluate C-13 readiness from environment + project facts. Server APNs
 * reuses the real resolveApnsConfig from push.ts (env APNS_*), so this
 * report can never disagree with the actual sender.
 */
export function checkIosReadiness(input: IosReadinessEnv = {}): IosReadiness {
  const env = input.env ?? process.env;
  const apns = resolveApnsConfig(env, () => { throw new Error('no file reads in readiness check'); });
  // resolveApnsConfig with a throwing reader returns null when the key is
  // path-based; treat APNS_KEY_PEM presence as the checkable signal too.
  const apnsKeyPresent = Boolean(apns) || Boolean(env.APNS_KEY_PEM?.trim());
  const items: ReadinessItem[] = [
    {
      key: 'development-team', label: 'Xcode DEVELOPMENT_TEAM set',
      ok: Boolean(input.hasDevelopmentTeam),
      detail: input.hasDevelopmentTeam ? 'Team configured in project/xcconfig.' : 'No DEVELOPMENT_TEAM — set it in ios-companion/Config/Signing.xcconfig (founder Apple Developer team id).',
      owner: input.hasDevelopmentTeam ? 'done' : 'founder',
    },
    {
      key: 'bundle-id', label: 'Bundle identifier',
      ok: Boolean(input.bundleId),
      detail: input.bundleId ? `Bundle id: ${input.bundleId}.` : 'PRODUCT_BUNDLE_IDENTIFIER missing from the Xcode project.',
      owner: input.bundleId ? 'done' : 'config',
    },
    {
      key: 'aps-entitlement', label: 'aps-environment entitlement',
      ok: input.apsEnvironment === 'development' || input.apsEnvironment === 'production',
      detail: input.apsEnvironment ? `Entitlements declare aps-environment=${input.apsEnvironment}.` : 'KriyaDotCompanion.entitlements has no aps-environment key.',
      owner: input.apsEnvironment ? 'done' : 'config',
    },
    {
      key: 'apns-server-config', label: 'Server APNs provider config (APNS_KEY_ID / APNS_TEAM_ID / APNS_BUNDLE_ID + .p8 key)',
      ok: apnsKeyPresent && Boolean(env.APNS_KEY_ID?.trim()) && Boolean(env.APNS_TEAM_ID?.trim()) && Boolean(env.APNS_BUNDLE_ID?.trim()),
      detail: apnsKeyPresent ? 'APNs env present (sender in push.ts can mint provider tokens).' : 'APNs env absent — PushService logs "APNs not configured" and iOS push is a no-op until the founder supplies the .p8 key.',
      owner: apnsKeyPresent ? 'done' : 'founder',
    },
    {
      key: 'signed-build-verification', label: 'Signed build + device APNs round-trip verified',
      ok: false,
      detail: 'Cannot be verified in this environment: requires Xcode, the founder signing identity, a provisioned device and a live APNs round-trip.',
      owner: 'founder',
    },
  ];
  const blockers = items.filter((i) => !i.ok).map((i) => `${i.label}: ${i.detail}`);
  return { ready: items.every((i) => i.ok), items, blockers };
}

export function createIosReadinessRouter(deps: { facts?: () => IosReadinessEnv } = {}): Router {
  const router = express.Router();
  router.get('/ios/readiness', (_req, res) => {
    res.json({ ok: true, ...checkIosReadiness(deps.facts?.() ?? {}) });
  });
  return router;
}
