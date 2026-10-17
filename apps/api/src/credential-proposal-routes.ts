// SPDX-License-Identifier: Apache-2.0
// Profile/credential proposal cards (OpenMausBot parity).
//
//   GET  /credential-proposals?status=pending|fulfilled|denied|expired
//   POST /credential-proposals/:id   { decision: 'fulfill'|'deny', value? }
//
// When a bot needs a credential it doesn't have, the `request_credential`
// agent tool mints a card here. The user fulfills it by supplying the value
// (which lands straight in the SecureVault under the card's key) or denies
// it. The waiting tool call resolves accordingly and the turn continues —
// the bot never hard-fails on a missing credential.
//
// Security: cards carry metadata only (key, label, reason). The value is
// accepted on the fulfill call, written to the vault, and never persisted
// anywhere else (not the proposals DB, not logs, not audit detail).
//
// HOST WIRING (index.ts):
//   import { createCredentialProposalRouter } from './credential-proposal-routes.js';
//   const credentialProposalStore = new CredentialProposalStore(config.dataDir);
//   router.use('/api', createCredentialProposalRouter({
//     store: credentialProposalStore,
//     dataDir: config.dataDir,
//     audit: (action, fields) => governance.audit(action, fields),
//   }));
//   // Tool + turn wiring:
//   toolRegistry.set('request_credential', createRequestCredentialTool());
//   agentRuntime.setCredentialProposer({
//     requestCredential: async (input) => {
//       const card = credentialProposalStore.propose(input);
//       const ok = await credentialProposalStore.awaitDecision(card.id);
//       return ok ? { ok: true } : { ok: false, reason: 'The user did not provide the credential.' };
//     },
//   });

import express, { type Router } from 'express';
import {
  CredentialProposalStore,
  type CredentialProposalStatus,
} from '@mvp/agent-runtime';
import { SecureVault } from '@mvp/vault';

export interface CredentialProposalRouterDeps {
  store: CredentialProposalStore;
  dataDir: string;
  audit: (action: string, fields: { actor?: string; sessionId?: string; detail?: unknown }) => void;
}

const VALID_STATUSES = new Set(['pending', 'fulfilled', 'denied', 'expired']);

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

export function createCredentialProposalRouter(deps: CredentialProposalRouterDeps): Router {
  const router = express.Router();
  const { store, dataDir, audit } = deps;

  router.get('/credential-proposals', (req, res) => {
    try {
      const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;
      if (statusParam && !VALID_STATUSES.has(statusParam)) {
        res.status(400).json(errorBody(`Invalid status "${statusParam}" — expected pending|fulfilled|denied|expired`));
        return;
      }
      const expired = store.expireStale();
      for (const id of expired) audit('credential-proposal.expired', { detail: { cardId: id } });
      res.json({
        ok: true,
        cards: store.list(statusParam as CredentialProposalStatus | undefined),
      });
    } catch (err) {
      res.status(500).json(errorBody('Failed to list credential proposals', err instanceof Error ? err.message : String(err)));
    }
  });

  router.post('/credential-proposals/:id', (req, res) => {
    const body = (req.body ?? {}) as { decision?: unknown; value?: unknown };
    if (body.decision !== 'fulfill' && body.decision !== 'deny') {
      res.status(400).json(errorBody('Body must be { decision: "fulfill"|"deny", value?: string }'));
      return;
    }
    const card = store.get(req.params.id);
    if (!card) {
      res.status(404).json(errorBody(`Unknown proposal "${req.params.id}"`));
      return;
    }
    if (card.status !== 'pending') {
      res.status(409).json(errorBody(`Proposal is ${card.status}, not pending`));
      return;
    }
    if (body.decision === 'deny') {
      const denied = store.deny(card.id);
      audit('credential-proposal.denied', { sessionId: card.sessionId, detail: { cardId: card.id, key: card.key } });
      res.json({ ok: true, card: denied });
      return;
    }
    // fulfill: value goes straight into the vault, never into the proposals DB.
    const value = typeof body.value === 'string' ? body.value : '';
    if (!value) {
      res.status(400).json(errorBody('"value" is required to fulfill a credential proposal'));
      return;
    }
    if (value.length > 8000) {
      res.status(400).json(errorBody('"value" is too long (max 8000 chars)'));
      return;
    }
    try {
      const vault = new SecureVault(dataDir, 'default-user', 'credential-proposal');
      if (vault.get(card.key)) {
        vault.update(card.key, value, `Supplied via credential proposal ${card.id}`);
      } else {
        vault.create(card.key, value, `Supplied via credential proposal ${card.id}`);
      }
    } catch (err) {
      res.status(500).json(errorBody('Failed to store the credential', err instanceof Error ? err.message : String(err)));
      return;
    }
    const fulfilled = store.fulfill(card.id);
    // Name-only audit: the value never reaches the audit trail.
    audit('credential-proposal.fulfilled', { sessionId: card.sessionId, detail: { cardId: card.id, key: card.key } });
    res.json({ ok: true, card: fulfilled });
  });

  return router;
}
