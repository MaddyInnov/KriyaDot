// SPDX-License-Identifier: Apache-2.0
// A13 egress journal: API settings persistence, settings routes, and
// audit-store integration (entries land in the governance audit_log —
// the store behind Activity — with kind 'egress' and the run id as the
// session). All traffic is against throwaway 127.0.0.1 servers.

import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, GovernanceGateway } from '@mvp/governance';
import { egressJournalSettings, startEgressProxy, type EgressJournalEntry } from '@mvp/agent-runtime';
import { loadEgressJournalSettings, saveEgressJournalSettings, sanitizeEgressJournalSettings } from '../src/egress-settings.js';
import { createEgressJournalRouter } from '../src/egress-routes.js';

async function request(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('egress journal settings persistence', () => {
  it('defaults OFF, round-trips, and sanitizes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'egress-settings-'));
    expect(loadEgressJournalSettings(dir)).toEqual({ enabled: false });
    saveEgressJournalSettings(dir, { enabled: true });
    expect(loadEgressJournalSettings(dir)).toEqual({ enabled: true });
    expect(sanitizeEgressJournalSettings({ enabled: 'yes' })).toEqual({ enabled: false });
    expect(sanitizeEgressJournalSettings(null)).toEqual({ enabled: false });
    expect(sanitizeEgressJournalSettings({ enabled: true })).toEqual({ enabled: true });
  });
});

describe('egress journal routes', () => {
  afterEach(() => {
    egressJournalSettings.updateSettings({ enabled: false });
  });

  it('GET reports OFF by default with the honest label; PUT enables and persists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'egress-routes-'));
    const app = express();
    app.use(express.json());
    app.use('/api/egress-journal', createEgressJournalRouter({ dataDir: dir }));

    const before = await request(app, 'GET', '/api/egress-journal/settings');
    expect(before.status).toBe(200);
    expect(before.json.settings).toEqual({ enabled: false });
    expect(before.json.label).toBe('Visible, not confined');
    expect(String(before.json.limits)).toContain('NOT covered');

    const put = await request(app, 'PUT', '/api/egress-journal/settings', { enabled: true });
    expect(put.json.settings).toEqual({ enabled: true });
    expect(egressJournalSettings.isEnabled).toBe(true);
    expect(loadEgressJournalSettings(dir)).toEqual({ enabled: true });
  });
});

describe('audit-store integration', () => {
  it('proxy journal entries appear in the governance audit log with the run id', async () => {
    const gateway = new GovernanceGateway({ dbPath: ':memory:', policy: DEFAULT_POLICY });
    const origin = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('audit-origin');
    });
    await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
    const originPort = (origin.address() as AddressInfo).port;

    // The sink exactly as runtime.ts wires it + governance-adapter's
    // audit() translation (type → action, sessionId → session_id).
    const sink = (entry: EgressJournalEntry): void => {
      gateway.audit('egress', {
        actor: 'bot-a13',
        sessionId: entry.runId,
        detail: { ...entry, label: 'Visible, not confined', scope: 'sandboxed-command-path-only' },
      });
    };
    const proxy = await startEgressProxy({ runId: 'run-audit-1', sink });
    try {
      const body = await new Promise<string>((resolvePromise, rejectPromise) => {
        const req = http.request(
          { host: '127.0.0.1', port: proxy.port, method: 'GET', path: `http://127.0.0.1:${originPort}/secret-path?token=x` },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
          },
        );
        req.on('error', rejectPromise);
        req.end();
      });
      expect(body).toBe('audit-origin');
      await waitFor(() => gateway.listAudit(10).some((e) => e.action === 'egress'));
      const entries = gateway.listAudit(10).filter((e) => e.action === 'egress');
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry.sessionId).toBe('run-audit-1');
      expect(entry.actor).toBe('bot-a13');
      const detail = JSON.parse(entry.detail ?? '{}') as Record<string, unknown>;
      expect(detail.host).toBe('127.0.0.1');
      expect(detail.port).toBe(originPort);
      expect(detail.status).toBe('forwarded');
      expect(detail.label).toBe('Visible, not confined');
      // No path/query ever reaches the audit store.
      expect(entry.detail ?? '').not.toContain('secret-path');
      expect(entry.detail ?? '').not.toContain('token');
    } finally {
      await proxy.close();
      origin.close();
      gateway.close();
    }
  });
});
