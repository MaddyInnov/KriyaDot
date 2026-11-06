// SPDX-License-Identifier: Apache-2.0
//
// Cloud host routes — host-agnostic cloud layer.
//
// The deploy driver is pluggable: this router talks only to the generic
// CloudHostClient interface (cloud-host.ts). NO real host driver ships
// today — when no client and no client factory are injected, connect and
// every connected route fail honestly with 503
// ("no cloud host driver is configured on this instance") instead of
// constructing a provider-specific client.
//
// Connect flow (no silent auto-sign-in anywhere in this layer):
//   "Connect cloud host" is one explicit tap by the user: they sign in to
//   their cloud host themselves (a separate host account), copy their
//   account id + API key from that host's account settings, and paste
//   them into POST /cloud/connect. The pair is stored only in the user's
//   encrypted SecureVault and is never returned by any route.
//
// Routes (mount at /api — see the wiring snippet at the bottom):
//   POST /cloud/connect            { accountId, apiKey } → verify + store
//   GET  /cloud/status             connection + instance state
//   POST /cloud/disconnect         delete the stored pair
//   POST /cloud/instance/ensure | /cloud/instance/start | /cloud/instance/stop
//   POST /cloud/deploy             { repoUrl, ollama?, instanceName? }
//   GET  /cloud/usage              driver-visible facts only
//   GET  /cloud/plans              generic tier descriptors, NO prices
//   GET  /cloud/supervisor         wake-on-traffic supervisor state

import { randomBytes } from 'node:crypto';
import express, { type Request, type Router } from 'express';
import {
  CLOUD_HOST_ACCOUNT_SECRET,
  CLOUD_HOST_API_KEY_SECRET,
  DEFAULT_INSTANCE_NAME,
  readCloudHostCredentials,
  type CloudHostClient,
  type CloudHostCredentials,
  type CloudSecretStore,
} from './cloud-host.js';
import { deployKriyadot, type DeployResult } from './cloud-deploy.js';
import { CloudSupervisor, type CloudTier } from './cloud-supervisor.js';
import { principalMiddleware, resolvePrincipal, type PrincipalContext } from './principal.js';

/** Honest failure when this KriyaDot instance has no host driver wired. */
export const NO_CLOUD_DRIVER_ERROR = 'no cloud host driver is configured on this instance';

export interface CloudRouteDeps {
  /** Secret store (host wires VaultCloudSecretStore; tests use in-memory). */
  secretStore: CloudSecretStore;
  /**
   * Build a client for a credential pair. There is NO default: when
   * neither this factory nor `client` is provided, the cloud layer has
   * no driver and connect/connected routes return 503. Tests inject a
   * factory returning FakeCloudHostClient.
   */
  clientFactory?: (creds: CloudHostCredentials) => CloudHostClient;
  /** Fixed client (wins over clientFactory) — the usual test seam. */
  client?: CloudHostClient;
  /** Instance name inside the user's cloud-host account. Default "kriyadot". */
  instanceName?: string;
  /** The user's cloud tier, when the host knows it. Default "free". */
  tier?: CloudTier;
  /**
   * Resolve the user's provider API keys from their vault at deploy time.
   * Their values are injected into the instance's 0600 env file over the
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
 * The verified principal's user id (principal.ts, OPEN-1 fix) — cloud
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

interface CloudHostPlan {
  id: CloudTier;
  name: string;
  summary: string;
}

/**
 * Generic tier descriptors. Deliberately NO prices and NO checkout link:
 * pricing belongs to whichever cloud host the user connects, and any
 * hard-coded price or provider URL would go stale (or point at the wrong
 * provider entirely).
 */
export function cloudHostPlans(): CloudHostPlan[] {
  return [
    {
      id: 'free',
      name: 'Free',
      summary:
        'May sleep when idle and restart periodically; wake-on-traffic keeps the instance reachable. Always reachable, not always running.',
    },
    {
      id: 'pro',
      name: 'Pro',
      summary: 'Always-on-capable tier: no idle sleep on the included instance, larger persistent storage.',
    },
    {
      id: 'teams',
      name: 'Teams',
      summary: 'Everything in Pro with team workspaces, more storage, and organization cost management.',
    },
    {
      id: 'enterprise',
      name: 'Enterprise',
      summary: 'Custom plans: bring-your-own cloud/VPC, SAML/SSO, and SLA-backed deployments.',
    },
  ];
}

export function createCloudRouter(deps: CloudRouteDeps): Router {
  const router = express.Router();
  const pctx: PrincipalContext = { dataDir: deps.dataDir, loopbackToken: deps.loopbackToken, jwtSecret: deps.jwtSecret };
  const caller = (req: Request): string => callerOf(req, pctx);
  // Scoped to this router's own prefix: the router is mounted at '/api'
  // alongside other feature routers, so an unscoped guard would reject
  // requests (e.g. SSO logins, device-token calls) that belong to them.
  router.use('/cloud', principalMiddleware(pctx));
  const instanceName = deps.instanceName ?? DEFAULT_INSTANCE_NAME;
  const tier: CloudTier = deps.tier ?? 'free';

  /** The configured driver for a credential pair, or undefined when none ships. */
  const clientFor = (creds: CloudHostCredentials): CloudHostClient | undefined => {
    if (deps.client) return deps.client;
    if (deps.clientFactory) return deps.clientFactory(creds);
    return undefined;
  };

  type Connected =
    | { kind: 'ok'; client: CloudHostClient; creds: CloudHostCredentials }
    | { kind: 'not-connected' }
    | { kind: 'no-driver'; creds: CloudHostCredentials };

  const connectedClient = (req: Request): Connected => {
    const creds = readCloudHostCredentials(deps.secretStore, caller(req));
    if (!creds) return { kind: 'not-connected' };
    const client = clientFor(creds);
    if (!client) return { kind: 'no-driver', creds };
    return { kind: 'ok', client, creds };
  };

  /**
   * Gate for routes that need a live client. Returns the connected pair,
   * or writes the honest error response (409 not connected / 503 no
   * driver) and returns undefined.
   */
  const requireClient = (
    req: Request,
    res: express.Response,
  ): { client: CloudHostClient; creds: CloudHostCredentials } | undefined => {
    const found = connectedClient(req);
    if (found.kind === 'not-connected') {
      res.status(409).json(errorBody('Cloud host is not connected — connect first'));
      return undefined;
    }
    if (found.kind === 'no-driver') {
      res.status(503).json(errorBody(NO_CLOUD_DRIVER_ERROR));
      return undefined;
    }
    return { client: found.client, creds: found.creds };
  };

  const supervisorFor = (client: CloudHostClient): CloudSupervisor =>
    new CloudSupervisor({
      client,
      instanceName,
      tier,
      ...(deps.healthProbe ? { healthProbe: deps.healthProbe } : {}),
    });

  // -- Connect / status / disconnect -------------------------------------

  router.post('/cloud/connect', async (req, res) => {
    const accountId = typeof req.body?.accountId === 'string' ? req.body.accountId.trim() : '';
    const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
    if (!accountId || !apiKey) {
      res.status(400).json(errorBody('accountId and apiKey are required (from your cloud host account settings)'));
      return;
    }
    const creds: CloudHostCredentials = { accountId, apiKey };
    const client = clientFor(creds);
    if (!client) {
      res.status(503).json(errorBody(NO_CLOUD_DRIVER_ERROR));
      return;
    }
    try {
      // Verify BEFORE storing: a bad pair must not become the stored one.
      const verdict = await client.verifyCredentials();
      if (!verdict.ok) {
        res.status(401).json(errorBody(`Cloud host rejected those credentials${verdict.detail ? `: ${clientError(verdict.detail)}` : ''}`));
        return;
      }
      deps.secretStore.set(caller(req), CLOUD_HOST_ACCOUNT_SECRET, accountId);
      deps.secretStore.set(caller(req), CLOUD_HOST_API_KEY_SECRET, apiKey);
      // The apiKey is never echoed back — only the (non-secret) account id.
      res.json({ ok: true, connected: true, verified: true, accountId });
    } catch (err) {
      res.status(500).json(errorBody(clientError(err)));
    }
  });

  router.get('/cloud/status', async (req, res) => {
    const found = connectedClient(req);
    if (found.kind === 'not-connected') {
      res.json({ ok: true, connected: false, instance: null });
      return;
    }
    if (found.kind === 'no-driver') {
      res.status(503).json(errorBody(NO_CLOUD_DRIVER_ERROR));
      return;
    }
    try {
      const instance = await found.client.getInstance(instanceName);
      res.json({
        ok: true,
        connected: true,
        accountId: found.creds.accountId,
        instance: instance ?? null,
        tier,
        // Honest semantics: reachability/always-on are the supervisor's
        // probed verdicts; this status route does not probe, so it never
        // claims always-on.
        alwaysOn: false,
        reachabilityNote:
          tier === 'free' || tier === 'unknown'
            ? 'This tier may sleep or restart idle instances: always reachable with wake-on-traffic — not always running.'
            : 'This tier reports always-on capability; the supervisor probe confirms reachability.',
      });
    } catch (err) {
      res.status(500).json(errorBody(clientError(err)));
    }
  });

  router.post('/cloud/disconnect', (req, res) => {
    deps.secretStore.delete(caller(req), CLOUD_HOST_ACCOUNT_SECRET);
    deps.secretStore.delete(caller(req), CLOUD_HOST_API_KEY_SECRET);
    res.json({ ok: true, connected: false });
  });

  // -- Instance lifecycle --------------------------------------------------

  const lifecycle = (action: 'ensure' | 'start' | 'stop') =>
    async (req: Request, res: express.Response) => {
      const found = requireClient(req, res);
      if (!found) return;
      try {
        const instance =
          action === 'ensure'
            ? await found.client.ensureInstance(instanceName)
            : action === 'start'
              ? await found.client.startInstance(instanceName)
              : await found.client.stopInstance(instanceName);
        res.json({ ok: true, instance });
      } catch (err) {
        res.status(500).json(errorBody(clientError(err)));
      }
    };
  router.post('/cloud/instance/ensure', lifecycle('ensure'));
  router.post('/cloud/instance/start', lifecycle('start'));
  router.post('/cloud/instance/stop', lifecycle('stop'));

  // -- Deploy ---------------------------------------------------------------

  router.post('/cloud/deploy', async (req, res) => {
    const found = requireClient(req, res);
    if (!found) return;
    const repoUrl =
      typeof req.body?.repoUrl === 'string' && req.body.repoUrl.trim()
        ? req.body.repoUrl.trim()
        : deps.defaultRepoUrl;
    if (!repoUrl) {
      res.status(400).json(errorBody('repoUrl is required (no default deploy source configured)'));
      return;
    }
    const deployInstanceName =
      typeof req.body?.instanceName === 'string' && req.body.instanceName.trim()
        ? req.body.instanceName.trim()
        : instanceName;
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
      // deploy — the instance receives only its SHA-256 hash seeded into
      // its sync-hub.json, and the successful result carries
      // { syncPairing: { instanceUrl, linkToken } } back so the local app
      // can store it as its sync target (POST /api/sync/target). See
      // cloud-deploy.ts for why generation is local rather than in-instance.
      const syncLinkToken = randomBytes(32).toString('base64url');
      const result: DeployResult = await deployKriyadot(found.client, {
        repoUrl,
        instanceName: deployInstanceName,
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

  // -- Usage (driver-visible facts ONLY) ------------------------------------

  router.get('/cloud/usage', async (req, res) => {
    const found = requireClient(req, res);
    if (!found) return;
    try {
      const instance = await found.client.getInstance(instanceName);
      const diskBytes = instance ? await found.client.instanceDiskUsageBytes(instanceName) : undefined;
      res.json({
        ok: true,
        usage: {
          // ONLY facts the driver actually exposes: instance status,
          // machine type, teamspace, and disk usage measured inside the
          // instance. There is no assumed host API for credit balances,
          // remaining free hours, or billing-period totals — so this
          // response intentionally contains no balance field and no
          // billing/plans links, and no number here is estimated or
          // invented. Billing lives in the user's own host account.
          instanceStatus: instance?.state ?? 'unknown',
          rawStatus: instance?.rawStatus ?? null,
          machine: instance?.machine ?? null,
          teamspace: instance?.teamspace ?? null,
          diskUsageBytes: diskBytes ?? null,
          tier,
          balanceNote:
            'KriyaDot cannot read your cloud host credit balance — billing lives in your host account.',
        },
      });
    } catch (err) {
      res.status(500).json(errorBody(clientError(err)));
    }
  });

  // -- Plans (generic descriptors, never prices, never a checkout link) -----

  router.get('/cloud/plans', (_req, res) => {
    res.json({
      ok: true,
      plans: cloudHostPlans(),
      priceNote: 'Prices are set by your cloud host and are not quoted here',
    });
  });

  // -- Supervisor -------------------------------------------------------------

  router.get('/cloud/supervisor', async (req, res) => {
    const found = requireClient(req, res);
    if (!found) return;
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
//   import { createCloudRouter } from './cloud-routes.js';
//   import { VaultCloudSecretStore } from './cloud-host.js';
//   // …inside the app assembly, after express.json() is mounted:
//   app.use('/api', createCloudRouter({
//     secretStore: new VaultCloudSecretStore(config.dataDir),
//     // tier: 'free',                       // per-user when known
//     // defaultRepoUrl: '<kriyadot git url>',
//     // providerEnvForUser: async (userId) => ({ /* vault-resolved keys */ }),
//   }));
//
// Mount path: '/api' — the router itself owns the '/cloud/…' prefix, so
// the public paths are exactly /api/cloud/connect, /api/cloud/status,
// /api/cloud/usage, etc.
