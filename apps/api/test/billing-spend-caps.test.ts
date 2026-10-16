// SPDX-License-Identifier: Apache-2.0
// Spend caps + usage ledger API routes (OpenMausBot parity P1 #21):
// - GET/PUT /usage/spend-caps — global + per-bot daily/monthly caps
// - GET /usage/ledger / /usage/ledger.csv — append-only usage ledger
// Zero paid API usage — local SQLite only.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BillingLedger, CostTracker, MockBillingProvider, SpendCapStore, UsageMeter } from '@mvp/billing';
import { registerBillingRoutes, ledgerToCsv } from '../src/billing.js';

describe('spend caps + ledger routes', () => {
  let dir: string;
  let baseUrl: string;
  let server: ReturnType<import('node:http').Server> | null = null;
  let costTracker: CostTracker;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'billing-spendcaps-'));
    costTracker = new CostTracker(join(dir, 'billing.db'));
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerBillingRoutes(router, {
      dataDir: dir,
      meter: new UsageMeter(join(dir, 'billing.db')),
      ledger: new BillingLedger(join(dir, 'billing.db')),
      provider: new MockBillingProvider(),
      costTracker,
      spendCaps: new SpendCapStore(join(dir, 'billing.db')),
    });
    app.use('/api/billing', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api/billing`;
  });

  afterEach(async () => {
    costTracker.close();
    await new Promise<void>((resolve) => (server as unknown as { close(cb: () => void): void }).close(() => resolve()));
    server = null;
  });

  async function api(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown; text: string; headers: Headers }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // CSV/plaintext responses
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  it('GET /usage/spend-caps returns unlimited config by default', async () => {
    const r = await api('GET', '/usage/spend-caps');
    expect(r.status).toBe(200);
    const body = r.json as { config: { global: { dailyCents: null; monthlyCents: null }; bots: Record<string, unknown> }; statuses: unknown[] };
    expect(body.config.global).toEqual({ dailyCents: null, monthlyCents: null });
    expect(body.config.bots).toEqual({});
    expect(body.statuses).toEqual([]);
  });

  it('PUT /usage/spend-caps sets, reads back, and clears caps', async () => {
    const set = await api('PUT', '/usage/spend-caps', {
      scope: 'global',
      period: 'day',
      capCents: 500,
    });
    expect(set.status).toBe(200);
    expect((set.json as { config: { global: { dailyCents: number } } }).config.global.dailyCents).toBe(500);

    const botSet = await api('PUT', '/usage/spend-caps', {
      scope: 'bot',
      botId: 'scout',
      period: 'month',
      capCents: 2500,
    });
    expect(botSet.status).toBe(200);
    const cfg = (botSet.json as { config: { bots: Record<string, { monthlyCents: number }> } }).config;
    expect(cfg.bots['scout'].monthlyCents).toBe(2500);

    // Statuses reflect current spend (zero) vs caps.
    const statuses = (botSet.json as { statuses: Array<{ scope: string; period: string; capCents: number; spentCents: number; exceeded: boolean }> }).statuses;
    expect(statuses).toHaveLength(2);
    expect(statuses.every((s) => s.spentCents === 0 && s.exceeded === false)).toBe(true);

    // Clear → back to unlimited.
    const cleared = await api('PUT', '/usage/spend-caps', { scope: 'global', period: 'day', capCents: null });
    expect(cleared.status).toBe(200);
    expect((cleared.json as { config: { global: { dailyCents: null } } }).config.global.dailyCents).toBe(null);
  });

  it('PUT /usage/spend-caps validates inputs', async () => {
    expect((await api('PUT', '/usage/spend-caps', { scope: 'nope', period: 'day', capCents: 1 })).status).toBe(400);
    expect((await api('PUT', '/usage/spend-caps', { scope: 'global', period: 'year', capCents: 1 })).status).toBe(400);
    expect((await api('PUT', '/usage/spend-caps', { scope: 'bot', period: 'day', capCents: 1 })).status).toBe(400); // no botId
    expect((await api('PUT', '/usage/spend-caps', { scope: 'global', period: 'day', capCents: -5 })).status).toBe(400);
    expect((await api('PUT', '/usage/spend-caps', { scope: 'global', period: 'day', capCents: 1.5 })).status).toBe(400);
  });

  it('GET /usage/ledger lists metered events newest-first with filters', async () => {
    costTracker.record({ feature: 'chat', step: 'turn', inputTokens: 100, outputTokens: 50, botId: 'scout', model: 'm1', sessionId: 's1' });
    costTracker.record({ feature: 'workflows', step: 'run', inputTokens: 10, outputTokens: 5, botId: 'coder', model: 'm2', sessionId: 's2' });

    const all = (await api('GET', '/usage/ledger')).json as Array<{ botId: string; feature: string; model: string; costCents: number }>;
    expect(all).toHaveLength(2);
    expect(all[0].botId).toBe('coder'); // newest first
    expect(all[0]).toMatchObject({ feature: 'workflows', model: 'm2' });
    expect(typeof all[0].costCents).toBe('number');

    const filtered = (await api('GET', '/usage/ledger?botId=scout')).json as unknown[];
    expect(filtered).toHaveLength(1);
  });

  it('GET /usage/ledger.csv returns a downloadable CSV', async () => {
    costTracker.record({ feature: 'chat', step: 'turn', inputTokens: 100, outputTokens: 50, botId: 'scout', model: 'm1', sessionId: 's1' });
    const r = await api('GET', '/usage/ledger.csv');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    expect(r.headers.get('content-disposition')).toContain('attachment');
    const lines = r.text.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('id,timestamp_utc,bot_id,session_id,feature,step,model,input_tokens,output_tokens,cost_usd');
    expect(lines[1]).toContain('scout');
    expect(lines[1]).toContain('chat');
  });

  it('ledgerToCsv quotes hostile fields (formula/quote injection safe)', () => {
    const csv = ledgerToCsv([
      {
        id: 'ce_1',
        ts: 1_700_000_000_000,
        sessionId: 's1',
        botId: '=cmd|evil',
        feature: 'chat',
        step: 'turn',
        model: 'a"b',
        inputTokens: 1,
        outputTokens: 2,
        costCents: 3,
      },
    ]);
    // Every field is double-quoted, so spreadsheet formula injection via
    // a leading '=' is contained inside a quoted cell.
    expect(csv).toContain('"=cmd|evil"');
    expect(csv).toContain('"a""b"');
    expect(csv).toContain('"0.0300"');
  });
});
