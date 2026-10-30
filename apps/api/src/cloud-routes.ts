// SPDX-License-Identifier: Apache-2.0
//
// CLOUD_SHIPPING_NOTE — read before enabling this router for the public:
//
//   Building this Lightning cloud layer is authorized. PUBLICLY SHIPPING
//   it is gated on confirming Lightning AI's Terms of Service position on
//   the credential-delegation pattern implemented here — i.e. a user
//   pasting their OWN Lightning programmatic-login credentials (user ID +
//   API key from their account settings) into KriyaDot's encrypted vault,
//   and KriyaDot then acting on that user's own account via the official
//   SDK/CLI. The feasibility report (hidden_files/
//   lightning-ai-cloud-feasibility.md, 2026-10-29) could not retrieve
//   Lightning's ToS text and found no partner/reseller program, so no
//   clause can be quoted in either direction. Until the actual ToS text
//   (or a written OK from Lightning) confirms the pattern, keep this
//   router behind a host-level opt-in and do not market the feature.
//
// Connect flow (no silent auto-sign-in anywhere in this layer):
//   "Connect Lightning" is one explicit tap by the user: they sign in to
//   Lightning themselves (a separate Lightning account — the same Google
//   login works there), copy their user ID + API key from Lightning's
//   Keys settings page (Programmatic Login), and paste them into
//   POST /cloud/lightning/connect. The pair is stored only in the user's
//   encrypted SecureVault and is never returned by any route.
//
// Routes (mount at /api — see the wiring snippet at the bottom):
//   POST /cloud/lightning/connect     { userId, apiKey } → verify + store
//   GET  /cloud/lightning/status      connection + Studio state
//   POST /cloud/lightning/disconnect  delete the stored pair
//   POST /cloud/lightning/studio/ensure | /studio/start | /studio/stop
//   POST /cloud/lightning/deploy      { repoUrl, ollama?, studioName? }
//   GET  /cloud/lightning/usage       SDK-visible facts + billing deep link
//   GET  /cloud/lightning/plans       tier descriptors, NO prices
//   GET  /cloud/lightning/supervisor  wake-on-traffic supervisor state

import { randomBytes } from 'node:crypto';
import express, { type Request, type Router } from 'express';
import {
  CliLightningClient,
  DEFAULT_STUDIO_NAME,
  LIGHTNING_API_KEY_SECRET,
  LIGHTNING_USER_ID_SECRET,
  readLightningCredentials,
  type CloudSecretStore,
  type LightningClient,
  type LightningCredentials,
} from './cloud-lightning.js';
import { deployKriyadot, type DeployResult } from './cloud-deploy.js';
import { CloudSupervisor, type CloudTier } from './cloud-supervisor.js';
import { principalMiddleware, resolvePrincipal, type PrincipalContext } from './principal.js';

/** Lightning's own pages — the only Lightning URLs this layer links to. */
export const LIGHTNING_PRICING_URL = 'https://lightning.ai/pricing';
export const LIGHTNING_HOME_URL = 'https://lightning.ai/';

export interface CloudRouteDeps {
  /** Secret store (host wires VaultCloudSecretStore; tests use in-memory). */
  secretStore: CloudSecretStore;
  /**
   * Build a client for a credential pair. Default: CliLightningClient
   * (the user's installed `lightning` CLI + python lightning_sdk).
   * Tests inject a factory returning FakeLightningClient.
   */
  clientFactory?: (creds: LightningCredentials) => LightningClient;
  /** Fixed client (wins over clientFactory) — the usual test seam. */
  client?: LightningClient;
  /** Studio name inside the user's Lightning account. Default "kriyadot". */
  studioName?: string;
  /** The user's Lightning tier, when the host knows it. Default "free". */
  tier?: CloudTier;
  /**
   * Resolve the user's provider API keys from their vault at deploy time.
   * Their values are injected into the Studio's 0600 env file over the
   * run channel (see cloud-deploy.ts) and never appear in any response.
   */
  providerEnvForUser?: (kriyadotUserId: string) => Record<string, string> | Promise<Record<string, string>>;
  /** Default git source for deploys when the request omits repoUrl. */
  defaultRepoUrl?: string;
  /** Health probe / clock seams, forwarded to the supervisor. */
  healthProbe?: (url: string) => Promise<boolean>;
  /** Principal-resolution context (OPEN-1): data dir (SSO sessions) + owner token. */
  dataDir?: string;
  loopbackToken?: string;
  jwtSecret?: string;
}

/**
 * The verified principal's user id (principal.ts, OPEN-1 fix) — Lightning
 * credentials are stored per verified user, never per asserted header.
 * Only call behind the router's principalMiddleware guard.
 */
function callerOf(req: Request, ctx: PrincipalContext): string {
  const p = resolvePrincipal(req, ctx);
  if (!p) throw new Error('unauthenticated');
  return p.userId;
}

function errorBody(message: string): Record<string, unknown> {
  return { ok: false, error: message };
}

function clientError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Never leak absolute host paths (or anything key-shaped) in API errors.
  return msg.replace(/[A-Za-z]:\\[^\s"']+|\/[^\s"']+/g, (p) => p.split(/[\\/]/).pop() ?? p);
}

interface LightningPlan {
  id: CloudTier;
  name: string;
  summary: string;
  checkoutUrl: string;
}

/**
 * Tier descriptors. Deliberately NO prices: Lightning repriced twice in
 * ~5 weeks before this was written, so any hard-coded price goes stale —
 * the checkout link is the price source. Limits below are the free/paid
 * shape from Lightning's pricing page (feasibility report §1/§6).
 */
export function lightningPlans(): LightningPlan[] {
  const checkoutUrl = LIGHTNING_PRICING_URL;
  return [
    {
      id: 'free',
      name: 'Free',
      summary:
        '1 free active CPU Studio (4-hour session restarts, sleeps when idle, wake-on-traffic), 10 GB free teamspace Drive. Always reachable, not always running.',
      checkoutUrl,
    },
    {
      id: 'pro',
      name: 'Pro',
      summary: 'No session restrictions on the included Studio, customizable auto-sleep, larger persistent storage and GPU access. True uninterrupted always-on.',
      checkoutUrl,
    },
    {
      id: 'teams',
      name: 'Teams',
      summary: 'Everything in Pro with team workspaces, more storage, more concurrent GPUs, and organization cost management.',
      checkoutUrl,
    },
    {
      id: 'enterprise',
      name: 'Enterprise',
      summary: 'Custom plans: bring-your-own cloud/VPC, SAML/SSO, and SLA-backed deployments.',
      checkoutUrl,
    },
  ];
}

export function createCloudLightningRouter(deps: CloudRouteDeps): Router {
  const router = express.Router();
  const pctx: PrincipalContext = { dataDir: deps.dataDir, loopbackToken: deps.loopbackToken, jwtSecret: deps.jwtSecret };
  const caller = (req: Request): string => callerOf(req, pctx);
  // Scoped to this router's own prefix: the router is mounted at '/api'
  // alongside other feature routers, so an unscoped guard would reject
  // requests (e.g. SSO logins, device-token calls) that belong to them.
  router.use('/cloud', principalMiddleware(pctx));
  const studioName = deps.studioName ?? DEFAULT_STUDIO_NAME;
  const tier: CloudTier = deps.tier ?? 'free';

  const clientFor = (creds: LightningCredentials): LightningClient => {
    if (deps.client) return deps.client;
    if (deps.clientFactory) return deps.clientFactory(creds);
    return new CliLightningClient({ credentials: creds });
  };

  const connectedClient = (req: Request): { client: LightningClient; creds: LightningCredentials } | undefined => {
    const creds = readLightningCredentials(deps.secretStore, caller(req));
    if (!creds) return undefined;
    return { client: clientFor(creds), creds };
  };

  const supervisorFor = (client: LightningClient): CloudSupervisor =>
    new CloudSupervisor({
      client,
      studioName,
      tier,
      ...(deps.healthProbe ? { healthProbe: deps.healthProbe } : {}),
    });

  // -- Connect / status / disconnect -------------------------------------

  router.post('/cloud/lightning/connect', async (req, res) => {
    const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';
    const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
    if (!userId || !apiKey) {
      res.status(400).json(errorBody('userId and apiKey are required (from Lightning → Settings → Keys → Programmatic Login)'));
      return;
    }
    const creds: LightningCredentials = { userId, apiKey };
    try {
      // Verify BEFORE storing: a bad pair must not become the stored one.
      const verdict = await clientFor(creds).verifyCredentials();
      if (!verdict.ok) {
        res.status(401).json(errorBody(`Lightning rejected those credentials${verdict.detail ? `: ${clientError(verdict.detail)}` : ''}`));
        return;
      }
      deps.secretStore.set(caller(req), LIGHTNING_USER_ID_SECRET, userId);
      deps.secretStore.set(caller(req), LIGHTNING_API_KEY_SECRET, apiKey);
      // The apiKey is never echoed back — only the (non-secret) user id.
      res.json({ ok: true, connected: true, verified: true, lightningUserId: userId });
    } catch (err) {
      res.status(500).json(errorBody(clientError(err)));
    }
  });

  router.get('/cloud/lightning/status', async (req, res) => {
    const found = connectedClient(req);
    if (!found) {
      res.json({ ok: true, connected: false, studio: null });
      return;
    }
    try {
      const studio = await found.client.getStudio(studioName);
      res.json({
        ok: true,
        connected: true,
        lightningUserId: found.creds.userId,
        studio: studio ?? null,
        tier,
        // Honest semantics (feasibility §4): free is reachable, never always-on.
        alwaysOn: false,
        reachabilityNote:
          tier === 'free'
            ? 'Free tier: always reachable with wake-on-traffic (1–2 min cold start) and 4-hourly restarts — not always running.'
            : 'Paid tier: no free-tier session restrictions.',
      });
    } catch (err) {
      res.status(500).json(errorBody(clientError(err)));
    }
  });

  router.post('/cloud/lightning/disconnect', (req, res) => {
    deps.secretStore.delete(caller(req), LIGHTNING_USER_ID_SECRET);
    deps.secretStore.delete(caller(req), LIGHTNING_API_KEY_SECRET);
    res.json({ ok: true, connected: false });
  });

  // -- Studio lifecycle ----------------------------------------------------

  const lifecycle = (action: 'ensure' | 'start' | 'stop') =>
    async (req: Request, res: express.Response) => {
      const found = connectedClient(req);
      if (!found) {
        res.status(409).json(errorBody('Lightning is not connected — connect first'));
        return;
      }
      try {
        const studio =
          action === 'ensure'
            ? await found.client.ensureStudio(studioName)
            : action === 'start'
              ? await found.client.startStudio(studioName)
              : await found.client.stopStudio(studioName);
        res.json({ ok: true, studio });
      } catch (err) {
        res.status(500).json(errorBody(clientError(err)));
      }
    };
  router.post('/cloud/lightning/studio/ensure', lifecycle('ensure'));
  router.post('/cloud/lightning/studio/start', lifecycle('start'));
  router.post('/cloud/lightning/studio/stop', lifecycle('stop'));

  // -- Deploy ---------------------------------------------------------------

  router.post('/cloud/lightning/deploy', async (req, res) => {
    const found = connectedClient(req);
    if (!found) {
      res.status(409).json(errorBody('Lightning is not connected — connect first'));
      return;
    }
    const repoUrl =
      typeof req.body?.repoUrl === 'string' && req.body.repoUrl.trim()
        ? req.body.repoUrl.trim()
        : deps.defaultRepoUrl;
    if (!repoUrl) {
      res.status(400).json(errorBody('repoUrl is required (no default deploy source configured)'));
      return;
    }
    const ollamaRaw = req.body?.ollama as unknown;
    const ollama =
      ollamaRaw === true
        ? { enabled: true }
        : ollamaRaw && typeof ollamaRaw === 'object'
          ? {
              enabled: (ollamaRaw as { enabled?: unknown }).enabled !== false,
              ...((ollamaRaw as { model?: unknown }).model
                ? { model: String((ollamaRaw as { model: unknown }).model) }
                : {}),
            }
          : undefined;
    try {
      const providerEnv = deps.providerEnvForUser
        ? await deps.providerEnvForUser(caller(req))
        : {};
      // Sync provisioning (front-door Part 4): generate the sync link
      // token HERE (locally, in the owner's own app) and pass it into the
      // deploy — the Studio receives only its SHA-256 hash seeded into
      // its sync-hub.json, and the successful result carries
      // { syncPairing: { instanceUrl, linkToken } } back so the local app
      // can store it as its sync target (POST /api/sync/target). See
      // cloud-deploy.ts for why generation is local rather than in-Studio.
      const syncLinkToken = randomBytes(32).toString('base64url');
      const result: DeployResult = await deployKriyadot(found.client, {
        repoUrl,
        studioName,
        providerEnv,
        syncLinkToken,
        syncOwnerUserId: caller(req),
        ...(ollama ? { ollama } : {}),
      });
      res.status(result.ok ? 200 : 502).json({ ok: result.ok, deploy: result });
    } catch (err) {
      res.status(400).json(errorBody(clientError(err)));
    }
  });

  // -- Usage (SDK-visible facts ONLY) ---------------------------------------

  router.get('/cloud/lightning/usage', async (req, res) => {
    const found = connectedClient(req);
    if (!found) {
      res.status(409).json(errorBody('Lightning is not connected — connect first'));
      return;
    }
    try {
      const studio = await found.client.getStudio(studioName);
      const diskBytes = studio ? await found.client.studioDiskUsageBytes(studioName) : undefined;
      res.json({
        ok: true,
        usage: {
          // ONLY facts the SDK/CLI actually exposes: Studio status,
          // machine type, teamspace, and disk usage measured inside the
          // Studio. There is NO documented Lightning API for credit
          // balances, remaining free hours, or billing-period totals —
          // so this response intentionally contains no balance field,
          // and no number here is estimated or invented. Credits and
          // billing live in Lightning's own UI: see billingUrl.
          studioStatus: studio?.state ?? 'unknown',
          rawStatus: studio?.rawStatus ?? null,
          machine: studio?.machine ?? null,
          teamspace: studio?.teamspace ?? null,
          diskUsageBytes: diskBytes ?? null,
          tier,
          billingUrl: LIGHTNING_HOME_URL,
          plansUrl: LIGHTNING_PRICING_URL,
          balanceNote:
            'KriyaDot cannot read your Lightning credit balance — no such API exists. Check credits and billing in your Lightning account (billingUrl).',
        },
      });
    } catch (err) {
      res.status(500).json(errorBody(clientError(err)));
    }
  });

  // -- Plans (descriptors + deep link, never prices) ------------------------

  router.get('/cloud/lightning/plans', (_req, res) => {
    res.json({
      ok: true,
      plans: lightningPlans(),
      priceNote: 'See current plans on lightning.ai — prices change and are not quoted here',
      plansUrl: LIGHTNING_PRICING_URL,
    });
  });

  // -- Supervisor -------------------------------------------------------------

  router.get('/cloud/lightning/supervisor', async (req, res) => {
    const found = connectedClient(req);
    if (!found) {
      res.status(409).json(errorBody('Lightning is not connected — connect first'));
      return;
    }
    try {
      const state = await supervisorFor(found.client).tick();
      res.json({ ok: true, supervisor: state });
    } catch (err) {
      res.status(500).json(errorBody(clientError(err)));
    }
  });

  return router;
}

// HOST WIRING (parent adds this to apps/api/src/index.ts — this module
// deliberately does not edit index.ts):
//
//   import { createCloudLightningRouter } from './cloud-routes.js';
//   import { VaultCloudSecretStore } from './cloud-lightning.js';
//   // …inside the app assembly, after express.json() is mounted:
//   app.use('/api', createCloudLightningRouter({
//     secretStore: new VaultCloudSecretStore(config.dataDir),
//     // tier: 'free',                       // per-user when known
//     // defaultRepoUrl: '<kriyadot git url>',
//     // providerEnvForUser: async (userId) => ({ /* vault-resolved keys */ }),
//   }));
//
// Mount path: '/api' — the router itself owns the '/cloud/lightning/…'
// prefix, so the public paths are exactly /api/cloud/lightning/connect,
// /api/cloud/lightning/status, /api/cloud/lightning/usage, etc.
