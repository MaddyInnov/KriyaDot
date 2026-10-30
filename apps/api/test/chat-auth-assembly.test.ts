// SPDX-License-Identifier: Apache-2.0
// Regression (QA 2026-10-30, defect QA-D01): in the ASSEMBLED server every
// HTTP chat path returned 401. The loopback middleware accepted the
// loopback bearer, but the /api/chat handler then re-interpreted ANY
// Bearer header as a companion device token and rejected the owner's own
// token; symmetrically, the companion /chat/send proxy's inner call to
// /api/chat carried no credential at all and died at the middleware.
// Route tests never saw it because they mount the router without the
// loopback middleware + companion module combination. This suite mounts
// the full stack exactly as index.ts does.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, GovernanceGateway } from '@mvp/governance';
import { RunHealthStore } from '@mvp/run-health';
import { createRouter, type RouteDeps } from '../src/routes.js';
import { requireLoopbackAuth } from '../src/loopback-auth.js';
import { CompanionHub, CompanionStore } from '../src/companion.js';
import { PauseRegistry } from '../src/system-pause.js';

const LOOPBACK_TOKEN = 'a'.repeat(64);

let dir: string;
let server: import('node:http').Server;
let base: string;
let store: CompanionStore;
let deviceToken: string;

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'chat-auth-assembly-'));
  const port = await freePort();

  store = new CompanionStore(dir);
  const ott = store.requestPairingOTT();
  const paired = store.exchangePairing({ ott: ott.ott, deviceName: 'QA Phone', platform: 'android' });
  if (!paired.ok) throw new Error('pairing failed in test setup');
  deviceToken = paired.token;
  const hub = new CompanionHub(store, () => {}, { heartbeatMs: 0 });

  const governance = new GovernanceGateway({ dbPath: join(dir, 'gov.db'), policy: DEFAULT_POLICY });
  const agentRuntime = {
    addContextProvider: () => {},
    setDefaultSpendCapGateFactory: () => {},
    sessionStore: { getWorktree: () => undefined },
    runTurn: async (input: { onEvent?: (e: unknown) => void }) => {
      input.onEvent?.({ type: 'token', content: 'hello from the bot' });
      input.onEvent?.({ type: 'done', usage: null });
      return {};
    },
  };
  const stub = {} as never;
  const deps = {
    config: { dataDir: dir, workspaceDir: dir, port } as RouteDeps['config'],
    bots: [{ id: 'bot1', name: 'Bot One' }] as unknown as RouteDeps['bots'],
    agentRuntime: agentRuntime as unknown as RouteDeps['agentRuntime'],
    governance,
    governanceAdapter: stub,
    workflowRunner: {
      listRuns: () => [],
      startRun: async () => ({ id: 'run1' }),
      onRunUpdate: () => {},
      getWorkflow: () => ({ name: 'wf' }),
    } as unknown as RouteDeps['workflowRunner'],
    threadScheduleStore: stub,
    checkpointStore: stub,
    dotStore: stub,
    preferenceStore: { getPreference: () => undefined } as unknown as RouteDeps['preferenceStore'],
    recordingStore: stub,
    chatQueueStore: {
      enqueue: () => ({ id: 'q1', position: 1 }),
      nextForSession: () => undefined,
      list: () => [],
    } as unknown as RouteDeps['chatQueueStore'],
    mcpServers: {},
    tieredMemoryStore: {
      recallForPrompt: () => '',
      runReflectionPass: async () => {},
    } as unknown as RouteDeps['tieredMemoryStore'],
    runHealth: new RunHealthStore(join(dir, 'run-health.db')),
    omniStore: stub,
    omniCollector: stub,
    computerManager: stub,
    vpsPool: stub,
    pauseRegistry: new PauseRegistry(dir),
    companion: { store, hub },
    loopbackToken: LOOPBACK_TOKEN,
  } as unknown as RouteDeps;

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  // The assembled-server order: loopback middleware first, router under /api.
  app.use(
    requireLoopbackAuth(LOOPBACK_TOKEN, {
      isCompanionChatToken: (bearer) => store.findDeviceByToken(bearer) !== undefined,
    }),
  );
  app.use('/api', createRouter(deps));
  server = app.listen(port, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

async function chatWith(bearer: string | null): Promise<{ status: number; body: string }> {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ botId: 'bot1', message: 'hello', sessionId: 'sess-auth' }),
  });
  return { status: res.status, body: await res.text() };
}

describe('assembled chat auth (loopback middleware + router + companion)', () => {
  it('the owner loopback token reaches the chat handler and completes a turn', async () => {
    const r = await chatWith(LOOPBACK_TOKEN);
    expect(r.status).toBe(200);
    expect(r.body).toContain('hello from the bot');
  });

  it('a paired companion device token may call /api/chat directly', async () => {
    const r = await chatWith(deviceToken);
    expect(r.status).toBe(200);
    expect(r.body).toContain('hello from the bot');
  });

  it('an unknown bearer is rejected', async () => {
    const r = await chatWith('f'.repeat(64));
    expect(r.status).toBe(401);
  });

  it('a missing bearer is rejected', async () => {
    const r = await chatWith(null);
    expect(r.status).toBe(401);
  });

  it('the companion /chat/send proxy completes a turn end-to-end', async () => {
    const res = await fetch(`${base}/api/companion/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ botId: 'bot1', message: 'hello via phone', sessionId: 'sess-proxy' }),
    });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain('hello from the bot');
  });
});
