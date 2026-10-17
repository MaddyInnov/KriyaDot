// SPDX-License-Identifier: Apache-2.0
// Tests for credential-proposals.ts:
// - propose → pending card with metadata only (no value)
// - fulfill resolves the waiter and returns the value once
// - deny rejects the waiter
// - expireStale expires pending cards past their TTL

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CredentialProposalStore } from '../src/credential-proposals.js';

describe('CredentialProposalStore', () => {
  let dir: string;
  let store: CredentialProposalStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'credprop-'));
    store = new CredentialProposalStore(dir);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('proposes a pending card with metadata only', () => {
    const card = store.propose({
      botId: 'bot-1',
      sessionId: 'sess-1',
      key: 'GITHUB_TOKEN',
      label: 'GitHub token',
      reason: 'Needed to list your repos.',
    });
    expect(card.status).toBe('pending');
    expect(card.key).toBe('GITHUB_TOKEN');
    expect(store.get(card.id)).toMatchObject({ id: card.id, status: 'pending' });
  });

  it('fulfill resolves the awaiter (true) and is one-shot', async () => {
    const card = store.propose({ botId: 'b', sessionId: 's', key: 'K', reason: 'why' });
    const decided = store.awaitDecision(card.id, 5_000);
    const settled = store.fulfill(card.id);
    expect(settled?.status).toBe('fulfilled');
    await expect(decided).resolves.toBe(true);
    // Second settle is a no-op — one-shot semantics.
    expect(store.fulfill(card.id)).toBeNull();
    expect(store.get(card.id)?.status).toBe('fulfilled');
  });

  it('deny resolves the awaiter with false', async () => {
    const card = store.propose({ botId: 'b', sessionId: 's', key: 'K', reason: 'why' });
    const decided = store.awaitDecision(card.id, 5_000);
    store.deny(card.id);
    await expect(decided).resolves.toBe(false);
    expect(store.get(card.id)?.status).toBe('denied');
  });

  it('expireStale expires pending cards past TTL', () => {
    const card = store.propose({ botId: 'b', sessionId: 's', key: 'K', reason: 'why' });
    const expired = store.expireStale(Date.now() + 60_000 + 15 * 60_000);
    expect(expired).toContain(card.id);
    expect(store.get(card.id)?.status).toBe('expired');
  });

  it('awaitDecision on an unknown card resolves false', async () => {
    await expect(store.awaitDecision('nope', 50)).resolves.toBe(false);
  });

  it('reuses the pending card for the same (bot, key)', () => {
    const a = store.propose({ botId: 'b', sessionId: 's', key: 'K', reason: 'why' });
    const b = store.propose({ botId: 'b', sessionId: 's', key: 'K', reason: 'why again' });
    expect(b.id).toBe(a.id);
  });
});
