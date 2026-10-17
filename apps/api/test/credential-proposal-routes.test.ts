// SPDX-License-Identifier: Apache-2.0
// Tests for the credential proposal routes:
// - GET /credential-proposals lists cards (metadata only, never values)
// - POST /credential-proposals/:id fulfill writes the value to the vault
// - POST /credential-proposals/:id deny rejects the card
// - the value never lands in the proposal DB

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CredentialProposalStore } from '@mvp/agent-runtime';
import { createCredentialProposalRouter } from '../src/credential-proposal-routes.js';

describe('credential proposal routes', () => {
  let dir: string;
  let baseUrl: string;
  let server: { close(cb: () => void): void } | null = null;
  let store: CredentialProposalStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'credpropr-'));
    store = new CredentialProposalStore(dir);
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createCredentialProposalRouter({
        store,
        dataDir: dir,
        audit: () => {},
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api`;
  });

  afterEach(async () => {
    store.close();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists proposals and fulfills one into the vault', async () => {
    const card = store.propose({ botId: 'b1', sessionId: 's1', key: 'API_TOKEN', reason: 'needed' });
    const list = (await (await fetch(`${baseUrl}/credential-proposals`)).json()) as {
      cards: Array<{ id: string; status: string }>;
    };
    expect(list.cards.some((p) => p.id === card.id)).toBe(true);

    const fulfill = await fetch(`${baseUrl}/credential-proposals/${card.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'fulfill', value: 'sekrit-123' }),
    });
    expect(fulfill.status).toBe(200);
    expect(store.get(card.id)?.status).toBe('fulfilled');

    // The value went into the vault (retrievable) but never into the proposals DB.
    const { SecureVault } = await import('@mvp/vault');
    const vault = new SecureVault(dir, 'default-user', 'credential-proposal');
    try {
      expect(vault.get('API_TOKEN')?.value).toBe('sekrit-123');
    } finally {
      vault.close?.();
    }
    const { openDb } = await import('@mvp/agent-runtime');
    const db = openDb(join(dir, 'credential-proposals.db'));
    try {
      const dump = db.prepare('SELECT * FROM credential_proposals').all() as Array<Record<string, unknown>>;
      expect(JSON.stringify(dump)).not.toContain('sekrit-123');
    } finally {
      db.close();
    }
  });

  it('denies a proposal', async () => {
    const card = store.propose({ botId: 'b1', sessionId: 's1', key: 'OTHER', reason: 'x' });
    const deny = await fetch(`${baseUrl}/credential-proposals/${card.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'deny' }),
    });
    expect(deny.status).toBe(200);
    expect(store.get(card.id)?.status).toBe('denied');
  });

  it('rejects fulfill without a value', async () => {
    const card = store.propose({ botId: 'b1', sessionId: 's1', key: 'K', reason: 'x' });
    const res = await fetch(`${baseUrl}/credential-proposals/${card.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'fulfill' }),
    });
    expect(res.status).toBe(400);
  });
});
