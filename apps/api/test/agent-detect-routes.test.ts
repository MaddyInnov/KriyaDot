// SPDX-License-Identifier: Apache-2.0
// Tests for the agent auto-detection API routes (listen+fetch pattern).

import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentDetectRouter } from '../src/agent-detect-routes.js';
import { rescanAgents } from '@mvp/agent-runtime';

let baseUrl: string;
let server: { close(cb: () => void): void };

beforeEach(async () => {
  rescanAgents();
  const app = express();
  app.use(express.json());
  app.use('/api/agents', createAgentDetectRouter());
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as {
      close(cb: () => void): void;
    };
  });
  const port = (server as unknown as { address(): AddressInfo | null }).address()?.port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rescanAgents();
});

describe('GET /api/agents/detected', () => {
  it('returns an agents array and scannedAt', async () => {
    const res = await fetch(`${baseUrl}/api/agents/detected`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; agents: unknown[]; scannedAt: number };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.agents)).toBe(true);
    expect(typeof body.scannedAt).toBe('number');
  });

  it('detected entries have required fields', async () => {
    const res = await fetch(`${baseUrl}/api/agents/detected`);
    const body = (await res.json()) as {
      agents: Array<{ id: string; name: string; bin: string; path: string; acpCompatible: boolean }>;
    };
    for (const a of body.agents) {
      expect(a.id).toBeTruthy();
      expect(a.name).toBeTruthy();
      expect(a.bin).toBeTruthy();
      expect(a.path).toBeTruthy();
      expect(typeof a.acpCompatible).toBe('boolean');
    }
  });
});

describe('GET /api/agents', () => {
  it('returns detected first, then not-installed with install hints', async () => {
    const res = await fetch(`${baseUrl}/api/agents`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      agents: Array<{ installed: boolean; installHint?: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.agents.length).toBeGreaterThanOrEqual(30);
    // All detected (installed:true) come before not-installed
    let seenNotInstalled = false;
    for (const a of body.agents) {
      if (!a.installed) seenNotInstalled = true;
      else expect(seenNotInstalled).toBe(false);
    }
    const hinted = body.agents.find((a) => !a.installed);
    if (hinted) expect(hinted.installHint).toBeTruthy();
  });
});

describe('POST /api/agents/rescan', () => {
  it('forces a fresh scan and returns agents', async () => {
    const res = await fetch(`${baseUrl}/api/agents/rescan`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; agents: unknown[]; scannedAt: number };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.agents)).toBe(true);
    expect(body.scannedAt).toBeGreaterThan(0);
  });
});
