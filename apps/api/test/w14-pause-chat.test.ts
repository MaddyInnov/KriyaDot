// SPDX-License-Identifier: Apache-2.0
// W14d: the chat route refuses new bot turns while globally paused —
// the response is a paused notice and the (mock) runtime never runs a
// turn. After resume, the same request reaches the runtime again.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, GovernanceGateway } from '@mvp/governance';
import { RunHealthStore } from '@mvp/run-health';
import { createRouter, type RouteDeps } from '../src/routes.js';
import { PauseRegistry } from '../src/system-pause.js';

let dir: string;
let server: import('node:http').Server;
let base: string;
let turnRan: boolean;
let registry: PauseRegistry;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'w14-pause-chat-'));
  turnRan = false;
  registry = new PauseRegistry(dir);

  const governance = new GovernanceGateway({ dbPath: join(dir, 'gov.db'), policy: DEFAULT_POLICY });
  const agentRuntime = {
    addContextProvider: () => {},
    setDefaultSpendCapGateFactory: () => {},
    sessionStore: { getWorktree: () => undefined },
    runTurn: async (input: { onEvent?: (e: unknown) => void }) => {
      turnRan = true;
      input.onEvent?.({ type: 'token', content: 'hello from the bot' });
      input.onEvent?.({ type: 'done', usage: null });
      return {};
    },
  };
  const stub = {} as never;
  const deps = {
    config: { dataDir: dir, workspaceDir: dir, port: 0 } as RouteDeps['config'],
    bots: [{ id: 'bot1', name: 'Bot One' }] as unknown as RouteDeps['bots'],
    agentRuntime: agentRuntime as unknown as RouteDeps['agentRuntime'],
    governance,
    governanceAdapter: stub,
    workflowRunner: { listRuns: () => [], startRun: async () => ({ id: 'run1' }) } as unknown as RouteDeps['workflowRunner'],
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
    pauseRegistry: registry,
  } as unknown as RouteDeps;

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', createRouter(deps));
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

async function chat(): Promise<string> {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ botId: 'bot1', message: 'hello', sessionId: 'sess-pause' }),
  });
  return res.text();
}

describe('chat route global pause gate', () => {
  it('while paused: returns a paused notice and never runs a turn; after resume the turn runs', async () => {
    registry.pause('user');
    const pausedBody = await chat();
    expect(pausedBody).toContain('paused');
    expect(turnRan).toBe(false);

    registry.resume('user');
    const liveBody = await chat();
    expect(turnRan).toBe(true);
    expect(liveBody).not.toContain('KriyaDot is paused');
  });
});
