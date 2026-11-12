// SPDX-License-Identifier: Apache-2.0
// Secrets broker routes (Timon parity programme, item A12).
//
//   GET    /broker/identities                → [{ identity, host, connected }]
//   POST   /broker/identities/github         { token } → connect (vault-stored)
//   DELETE /broker/identities/github         → disconnect (vault delete)
//   GET    /broker/grants                    → standing grants (Settings-made)
//   POST   /broker/grants                    { identity, actionClass, scope? }
//   DELETE /broker/grants/:id                → revoke (effective immediately)
//   GET    /broker/requests?status=...       → per-run grant request cards
//   POST   /broker/requests/:id              { decision: approve|deny }
//   GET    /broker/journal?limit=...         → journal (ids/hashes, no secrets)
//
// The credential VALUE only ever travels from this POST body straight
// into the encrypted vault. It is never returned by any route, never
// journaled, and never written to the governance audit detail — connect
// and disconnect journal entries carry the identity name only.
//
// Standing grants are created ONLY here (the user in Settings); the
// request-card decision endpoint can approve a per-run grant but never
// creates a standing one. Mirrors pc-access-routes.ts.
//
// HOST WIRING (index.ts): see the broker block there — the store, the
// SecretsBroker service (vault-backed credential resolver), the
// broker_action tool, and this router all share one BrokerStore.

import express, { type Router } from 'express';
import {
  BROKER_CANONICAL_BASE,
  BROKER_IDENTITIES,
  GITHUB_BROKER_VAULT_NAME,
  type BrokerActionClass,
  type BrokerIdentity,
  type BrokerRequestStatus,
  type BrokerStore,
} from '@mvp/agent-runtime';
import type { SecureVault } from '@mvp/vault';

export interface BrokerRouterDeps {
  store: BrokerStore;
  /** Vault holding broker credentials (the Settings/tool namespace). */
  vault: () => SecureVault;
  audit: (action: string, fields: { actor?: string; sessionId?: string; detail?: unknown }) => void;
  /** Known bot ids — when provided, per-bot grant scopes are validated. */
  botIds?: () => string[];
}

const VALID_REQUEST_STATUSES = new Set(['pending', 'approved', 'denied', 'expired']);
const ACTION_CLASSES = new Set(['read', 'write']);

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

function parseIdentity(v: unknown): BrokerIdentity | null {
  return typeof v === 'string' && (BROKER_IDENTITIES as readonly string[]).includes(v)
    ? (v as BrokerIdentity)
    : null;
}

export function createBrokerRouter(deps: BrokerRouterDeps): Router {
  const router = express.Router();
  const { store, audit } = deps;

  const connected = (identity: BrokerIdentity): boolean => {
    try {
      return deps.vault().list().some((s) => s.name === GITHUB_BROKER_VAULT_NAME && identity === 'github');
    } catch {
      return false;
    }
  };

  // -- brokered identities ---------------------------------------------------

  router.get('/broker/identities', (_req, res) => {
    try {
      res.json({
        ok: true,
        identities: BROKER_IDENTITIES.map((identity) => ({
          identity,
          host: new URL(BROKER_CANONICAL_BASE[identity]).host,
          connected: connected(identity),
        })),
      });
    } catch (err) {
      res.status(500).json(errorBody('Failed to list brokered identities', err instanceof Error ? err.message : String(err)));
    }
  });

  router.post('/broker/identities/github', (req, res) => {
    const body = (req.body ?? {}) as { token?: unknown };
    if (typeof body.token !== 'string' || body.token.trim().length === 0 || body.token.length > 1024) {
      res.status(400).json(errorBody('Body must be { token: "<GitHub personal access token>" }'));
      return;
    }
    try {
      const vault = deps.vault();
      const existing = vault.list().some((s) => s.name === GITHUB_BROKER_VAULT_NAME);
      if (existing) {
        vault.update(GITHUB_BROKER_VAULT_NAME, body.token, 'Brokered GitHub credential (secrets broker, A12)');
      } else {
        vault.create(GITHUB_BROKER_VAULT_NAME, body.token, 'Brokered GitHub credential (secrets broker, A12)');
      }
      store.appendJournal({
        botId: 'user',
        sessionId: null,
        identity: 'github',
        action: null,
        actionClass: null,
        event: 'identity_connected',
        resource: null,
        argsHash: null,
        detail: null,
      });
      audit('broker.identity_connected', { actor: 'user', detail: { identity: 'github' } });
      res.json({ ok: true, identity: 'github', connected: true });
    } catch (err) {
      // Fixed message: vault errors name the secret, never its value —
      // and we do not echo request data here either.
      res.status(500).json(errorBody('Failed to store the GitHub credential', err instanceof Error ? err.message : String(err)));
    }
  });

  router.delete('/broker/identities/github', (_req, res) => {
    try {
      const removed = deps.vault().delete(GITHUB_BROKER_VAULT_NAME);
      if (!removed) {
        res.status(404).json(errorBody('No GitHub credential is connected'));
        return;
      }
      store.appendJournal({
        botId: 'user',
        sessionId: null,
        identity: 'github',
        action: null,
        actionClass: null,
        event: 'identity_disconnected',
        resource: null,
        argsHash: null,
        detail: null,
      });
      audit('broker.identity_disconnected', { actor: 'user', detail: { identity: 'github' } });
      res.json({ ok: true, identity: 'github', connected: false });
    } catch (err) {
      res.status(500).json(errorBody('Failed to remove the GitHub credential', err instanceof Error ? err.message : String(err)));
    }
  });

  // -- standing grants (Settings only) ----------------------------------------

  router.get('/broker/grants', (_req, res) => {
    try {
      res.json({ ok: true, grants: store.listStandingGrants() });
    } catch (err) {
      res.status(500).json(errorBody('Failed to list broker standing grants', err instanceof Error ? err.message : String(err)));
    }
  });

  router.post('/broker/grants', (req, res) => {
    const body = (req.body ?? {}) as { identity?: unknown; actionClass?: unknown; scope?: unknown };
    const identity = parseIdentity(body.identity ?? 'github');
    if (!identity) {
      res.status(400).json(errorBody(`Unknown identity "${String(body.identity)}" — expected github`));
      return;
    }
    if (typeof body.actionClass !== 'string' || !ACTION_CLASSES.has(body.actionClass)) {
      res.status(400).json(errorBody('"actionClass" must be "read" or "write"'));
      return;
    }
    let botId: string | null = null;
    if (body.scope !== undefined && body.scope !== 'all') {
      if (typeof body.scope !== 'string' || !body.scope) {
        res.status(400).json(errorBody('"scope" must be "all" or a bot id'));
        return;
      }
      if (deps.botIds && !deps.botIds().includes(body.scope)) {
        res.status(400).json(errorBody(`Unknown bot in scope: "${body.scope}"`));
        return;
      }
      botId = body.scope;
    }
    try {
      const grant = store.addStandingGrant({
        identity,
        actionClass: body.actionClass as BrokerActionClass,
        botId,
      });
      store.appendJournal({
        botId: 'user',
        sessionId: null,
        identity,
        action: null,
        actionClass: grant.actionClass,
        event: 'standing_grant_created',
        resource: null,
        argsHash: null,
        detail: grant.id,
      });
      audit('broker.standing_grant_created', {
        actor: 'user',
        detail: { grantId: grant.id, identity, actionClass: grant.actionClass, scope: grant.scope },
      });
      res.json({ ok: true, grant });
    } catch (err) {
      res.status(500).json(errorBody('Failed to create broker standing grant', err instanceof Error ? err.message : String(err)));
    }
  });

  router.delete('/broker/grants/:id', (req, res) => {
    try {
      const revoked = store.revokeStandingGrant(req.params.id);
      if (!revoked) {
        res.status(404).json(errorBody(`Unknown grant: "${req.params.id}"`));
        return;
      }
      store.appendJournal({
        botId: 'user',
        sessionId: null,
        identity: revoked.identity,
        action: null,
        actionClass: revoked.actionClass,
        event: 'standing_grant_revoked',
        resource: null,
        argsHash: null,
        detail: revoked.id,
      });
      audit('broker.standing_grant_revoked', {
        actor: 'user',
        detail: { grantId: revoked.id, identity: revoked.identity, actionClass: revoked.actionClass, scope: revoked.scope },
      });
      res.json({ ok: true, grant: revoked });
    } catch (err) {
      res.status(500).json(errorBody('Failed to revoke broker standing grant', err instanceof Error ? err.message : String(err)));
    }
  });

  // -- per-run grant request cards ----------------------------------------------

  router.get('/broker/requests', (req, res) => {
    try {
      const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;
      if (statusParam && !VALID_REQUEST_STATUSES.has(statusParam)) {
        res.status(400).json(errorBody(`Invalid status "${statusParam}" — expected pending|approved|denied|expired`));
        return;
      }
      const expired = store.expireStale();
      for (const id of expired) audit('broker.request_expired', { detail: { cardId: id } });
      res.json({ ok: true, cards: store.listRequests(statusParam as BrokerRequestStatus | undefined) });
    } catch (err) {
      res.status(500).json(errorBody('Failed to list broker grant requests', err instanceof Error ? err.message : String(err)));
    }
  });

  router.post('/broker/requests/:id', (req, res) => {
    const body = (req.body ?? {}) as { decision?: unknown };
    if (body.decision !== 'approve' && body.decision !== 'deny') {
      res.status(400).json(errorBody('Body must be { decision: "approve"|"deny" } — approve grants this run only; standing grants are made in Settings'));
      return;
    }
    try {
      const existing = store.getRequest(req.params.id);
      if (!existing) {
        res.status(404).json(errorBody(`Unknown broker grant request: "${req.params.id}"`));
        return;
      }
      const settled = store.decide(req.params.id, body.decision);
      if (!settled) {
        res.status(409).json(errorBody('This request was already decided or has expired'));
        return;
      }
      audit('broker.request_decided', {
        actor: 'user',
        sessionId: settled.sessionId,
        detail: {
          cardId: settled.id,
          botId: settled.botId,
          identity: settled.identity,
          actionClass: settled.actionClass,
          action: settled.action,
          resource: settled.resource,
          decision: body.decision,
          status: settled.status,
        },
      });
      res.json({ ok: true, card: settled });
    } catch (err) {
      res.status(500).json(errorBody('Failed to decide broker grant request', err instanceof Error ? err.message : String(err)));
    }
  });

  // -- journal --------------------------------------------------------------------

  router.get('/broker/journal', (req, res) => {
    try {
      const raw = typeof req.query.limit === 'string' ? Number(req.query.limit) : 200;
      const limit = Number.isFinite(raw) ? Math.max(1, Math.min(raw, 1000)) : 200;
      res.json({ ok: true, entries: store.listJournal(limit) });
    } catch (err) {
      res.status(500).json(errorBody('Failed to read the broker journal', err instanceof Error ? err.message : String(err)));
    }
  });

  return router;
}
