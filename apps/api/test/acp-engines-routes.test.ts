// SPDX-License-Identifier: Apache-2.0
// ACP engine presets over HTTP (W9 engines pack): GET /engines lists the
// built-in presets (incl. GitHub Copilot CLI) with detection state, and
// POST / with { engine: 'copilot' } creates a session from the preset —
// here against a mock ACP stdio process via command/args overrides, so no
// real Copilot binary is involved.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AcpSessionManager, AcpSessionStore } from '@mvp/agent-runtime';
import { createAcpSessionsRouter } from '../src/acp-sessions-routes.js';

const MOCK_AGENT = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'mock-copilot' } } }) + '\\n');
  } else if (msg.method === 'prompt') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { text: 'hi from mock copilot' } }) + '\\n');
  }
});
`;

let dir: string;
let store: AcpSessionStore;
let manager: AcpSessionManager;
let server: { close(cb: () => void): void } | null = null;
let baseUrl = '';
const audits: Array<{ action: string; fields: unknown }> = [];

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

beforeEach(async () => {
  audits.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'acp-engines-routes-'));
  store = new AcpSessionStore(dir);
  manager = new AcpSessionManager(store);
  const app = express();
  app.use(express.json());
  app.use(
    '/api/acp',
    createAcpSessionsRouter({
      manager,
      workspaceDir: dir,
      governance: {
        requestApproval: () => 'appr_1',
        awaitDecision: async () => 'approved',
      },
      audit: (action, fields) => void audits.push({ action, fields }),
    }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
  });
  const addr = (server as unknown as { address(): AddressInfo }).address();
  baseUrl = `http://127.0.0.1:${addr.port}/api/acp`;
});

afterEach(async () => {
  manager.closeAll();
  store.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

describe('ACP engines routes', () => {
  it('GET /engines lists the copilot preset with detection state', async () => {
    const { status, json } = await api('GET', '/engines');
    expect(status).toBe(200);
    const engines = json.engines as Array<Record<string, unknown>>;
    const copilot = engines.find((e) => e.id === 'copilot');
    expect(copilot).toBeDefined();
    expect(copilot?.name).toBe('GitHub Copilot CLI');
    expect(copilot?.command).toBe('copilot');
    expect(copilot?.args).toEqual(['--acp']);
    expect(copilot?.authId).toBe('copilot');
    expect(typeof copilot?.installed).toBe('boolean');
  });

  it('POST / with engine=copilot creates a session from the preset (mock process)', async () => {
    const { status, json } = await api('POST', '/', {
      engine: 'copilot',
      command: 'node',
      args: ['-e', MOCK_AGENT],
    });
    expect(status).toBe(201);
    const session = json.session as { agentName: string; command: string; label: string };
    expect(session.agentName).toBe('mock-copilot');
    expect(session.command).toBe('node');
    expect(audits.some((a) => a.action === 'acp.session_created')).toBe(true);
  });

  it('POST / with an unknown engine is a 400', async () => {
    const { status } = await api('POST', '/', { engine: 'nope' });
    expect(status).toBe(400);
  });
});
