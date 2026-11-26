// SPDX-License-Identifier: Apache-2.0
// B-7 residual (API layer): a runtime 'retract' stream event must reach
// the chat client verbatim on the SSE stream, and the route's per-turn
// assistant-text accumulator (tiered-memory ingest + done-push) must
// drop the retracted segment so persistence never stores the dying
// provider's fragment in front of the backup's full answer.

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
import { PauseRegistry } from '../src/system-pause.js';

let dir: string;
let server: import('node:http').Server;
let base: string;
let ingestedAssistantText: string | null;

const PARTIAL = 'partial frag'; // 12 chars streamed by the dying provider

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'chat-retract-'));
  ingestedAssistantText = null;
  const port = await freePort();

  const governance = new GovernanceGateway({ dbPath: join(dir, 'gov.db'), policy: DEFAULT_POLICY });
  const agentRuntime = {
    addContextProvider: () => {},
    setDefaultSpendCapGateFactory: () => {},
    sessionStore: { getWorktree: () => undefined },
    // Scripted mid-stream swap: partial tokens → failover → retract →
    // the backup's full answer → done.
    runTurn: async (input: { onEvent?: (e: unknown) => void | Promise<void> }) => {
      await input.onEvent?.({ type: 'token', content: PARTIAL });
      await input.onEvent?.({
        type: 'failover', fromProvider: 'primary', fromModel: 'pm',
        toProvider: 'backup', toModel: 'bm', reason: 'pre-declared selection backup',
        message: 'primary/pm hit its usage limit — this turn continues on backup/bm.',
      });
      await input.onEvent?.({
        type: 'retract', scope: 'turn-segment', reason: 'provider-swap',
        retractedChars: PARTIAL.length, fromProvider: 'primary', toProvider: 'backup',
      });
      await input.onEvent?.({ type: 'token', content: 'full answer' });
      await input.onEvent?.({ type: 'done', usage: null });
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
      ingestTurn: (_botId: string, _session: string, _user: string, assistantText: string) => {
        ingestedAssistantText = assistantText;
      },
      noteTurnForReflection: () => false,
      runReflectionPass: async () => {},
    } as unknown as RouteDeps['tieredMemoryStore'],
    runHealth: new RunHealthStore(join(dir, 'run-health.db')),
    omniStore: stub,
    omniCollector: stub,
    computerManager: stub,
    vpsPool: stub,
    pauseRegistry: new PauseRegistry(dir),
  } as unknown as RouteDeps;

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', createRouter(deps));
  server = app.listen(port, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function parseSse(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as Record<string, unknown>);
}

describe('chat SSE retraction forwarding (B-7 residual)', () => {
  it('forwards the retract event to the client verbatim, in stream order', async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botId: 'bot1', message: 'hello', sessionId: 'sess-retract' }),
    });
    expect(res.status).toBe(200);
    const frames = parseSse(await res.text());
    const types = frames.map((f) => f.type);
    const retractIdx = types.indexOf('retract');
    expect(retractIdx).toBeGreaterThan(types.indexOf('failover'));
    // Exactly one retraction, with the runtime's payload unchanged.
    expect(types.filter((t) => t === 'retract')).toHaveLength(1);
    expect(frames[retractIdx]).toEqual({
      type: 'retract',
      scope: 'turn-segment',
      reason: 'provider-swap',
      retractedChars: PARTIAL.length,
      fromProvider: 'primary',
      toProvider: 'backup',
    });
    // It sits between the partial delta and the backup's first token.
    const tokenIdxs = frames
      .map((f, i) => (f.type === 'token' ? i : -1))
      .filter((i) => i >= 0);
    expect(tokenIdxs).toHaveLength(2);
    expect(tokenIdxs[0]).toBeLessThan(retractIdx);
    expect(tokenIdxs[1]).toBeGreaterThan(retractIdx);
  });

  it('drops the retracted segment from the persisted turn text', async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botId: 'bot1', message: 'hello', sessionId: 'sess-retract-2' }),
    });
    expect(res.status).toBe(200);
    await res.text();
    // Tiered-memory ingest received only the backup's answer.
    expect(ingestedAssistantText).toBe('full answer');
  });
});
