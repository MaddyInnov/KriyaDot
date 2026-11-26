// SPDX-License-Identifier: Apache-2.0
// A-5 follow-up — ONE shared FederationService for the federation and
// fleet surfaces (A15 residual).
//
// Production wiring (index.ts) constructs a single FederationService
// over <dataDir>/federation.json and passes the SAME object to both
// createFederationRouter({ service }) and createRouter({
// federationService }). This suite reproduces that assembly with the
// shared service's store in a DIFFERENT directory than the router's
// dataDir, so the assertions cannot pass through the old two-instance
// arrangement (routes.ts used to construct its own service over
// <dataDir>/federation.json — a different random identity):
//
//   1. /api/federation/identity and /api/fleet/self report the shared
//      instance's identity (identity assertion on both surfaces).
//   2. A peer unlinked through the federation surface is immediately
//      unknown to the fleet surface: POST /api/fleet/advertise stops
//      targeting it in the very next call, with no store-file mtime
//      reload in between (there is no second instance to reload).
//   3. The shared replay guard rejects a replayed envelope: the guard
//      is keyed by sender id + nonce, so one guard instance covering
//      both surfaces rejects everything either per-instance guard
//      rejected, plus cross-surface nonce reuse — strictly stronger.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, GovernanceGateway } from '@mvp/governance';
import { RunHealthStore } from '@mvp/run-health';
import { FederationService } from '@mvp/agent-runtime/dist/federation.js';
import { createRouter, type RouteDeps } from '../src/routes.js';
import { createFederationRouter } from '../src/federation-routes.js';
import { PauseRegistry } from '../src/system-pause.js';
import type { BotConfig } from '@mvp/agent-runtime';

const bots = [
  { id: 'bot1', name: 'Bot One', description: 'd', systemPrompt: 's', provider: 'p', model: 'm', skills: [], tools: [], mcpServers: [] },
] as unknown as BotConfig[];

let root: string;
let dataDir: string;
let base: string;
let server: { close(cb: () => void): void } | null = null;
let shared: FederationService;
let peer: FederationService;
let peerId: string;

async function api(method: string, path: string): Promise<{ status: number; body: Record<string, never> }> {
  const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, never> };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'fed-fleet-shared-'));
  dataDir = join(root, 'data');
  // The shared instance lives over its OWN store file, deliberately
  // NOT <dataDir>/federation.json: if routes.ts still constructed a
  // second service over the dataDir file, the fleet surface would
  // report that file's (different, random) identity instead.
  shared = new FederationService({ storePath: join(root, 'shared', 'federation.json'), name: 'Shared' });
  peer = new FederationService({
    storePath: join(root, 'peer', 'federation.json'),
    name: 'Peer',
    // Unreachable on purpose: advertise attempts fail fast, but the
    // fleet surface still enumerates the peer as a target.
    publicUrl: 'http://127.0.0.1:1/api/federation',
  });
  peerId = peer.identity().instanceId;
  shared.recordPeerFromInvite(shared.parseInvitePayload(peer.createInvite().payload));
  shared.markPeerActive(peerId);

  const governance = new GovernanceGateway({ dbPath: join(root, 'gov.db'), policy: DEFAULT_POLICY });
  const agentRuntime = {
    addContextProvider: () => {},
    setDefaultSpendCapGateFactory: () => {},
    sessionStore: {
      getWorktree: () => undefined,
      attachWorktree: () => {},
      listThreadMessages: () => [],
      appendMessage: () => {},
    },
    runTurn: async () => ({}),
  };
  const stub = {} as never;
  const deps = {
    config: { dataDir, workspaceDir: root, port: 0 } as RouteDeps['config'],
    bots,
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
    runHealth: new RunHealthStore(join(root, 'run-health.db')),
    omniStore: stub,
    omniCollector: stub,
    computerManager: stub,
    vpsPool: stub,
    pauseRegistry: new PauseRegistry(root),
    // The wiring under test: the host's single instance, injected.
    federationService: shared,
  } as unknown as RouteDeps;

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  // Exactly the index.ts assembly: federation router with the shared
  // service, main router with the same service in its deps.
  app.use(
    '/api/federation',
    createFederationRouter({ service: shared, getBots: () => bots, audit: () => undefined }),
  );
  app.use('/api', createRouter(deps));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => (server as never as { once(e: string, cb: () => void): void }).once('listening', resolve));
  base = `http://127.0.0.1:${(server as never as { address(): AddressInfo }).address().port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  rmSync(root, { recursive: true, force: true });
});

describe('single shared FederationService (federation + fleet surfaces)', () => {
  it('both surfaces report the injected instance identity', async () => {
    const fed = await api('GET', '/api/federation/identity');
    expect(fed.status).toBe(200);
    expect((fed.body.identity as unknown as { instanceId: string }).instanceId).toBe(shared.identity().instanceId);

    const self = await api('GET', '/api/fleet/self');
    expect(self.status).toBe(200);
    expect((self.body.identity as unknown as { instanceId: string }).instanceId).toBe(shared.identity().instanceId);
  });

  it('a peer unlinked via the federation surface is immediately unknown to the fleet surface', async () => {
    // Fleet surface targets the peer while it is linked (the send
    // itself fails — the peer URL is unreachable — but enumeration
    // proves the fleet surface knows the peer).
    const before = await api('POST', '/api/fleet/advertise');
    expect(before.status).toBe(200);
    expect(before.body.results as unknown as unknown[]).toHaveLength(1);
    expect(((before.body.results as unknown as Array<{ peerId: string }>)[0]).peerId).toBe(peerId);

    const unlink = await api('DELETE', `/api/federation/peers/${peerId}`);
    expect(unlink.status).toBe(200);
    expect(shared.getPeer(peerId)).toBeUndefined();

    // No restart, no store-file round-trip: the very next fleet call
    // no longer targets the peer, because there is only one instance.
    const after = await api('POST', '/api/fleet/advertise');
    expect(after.status).toBe(200);
    expect(after.body.results as unknown as unknown[]).toHaveLength(0);
  });

  it('the shared replay guard rejects a replayed envelope', () => {
    const envelope = peer.signEnvelope({ kind: 'fleet-advertise-probe' });
    const peerKey = peer.identity().publicKey;
    expect(shared.verifyEnvelope(envelope, peerKey)).toBe(true);
    // Same sender + nonce a second time: rejected by the one guard
    // both surfaces now share.
    expect(shared.verifyEnvelope(envelope, peerKey)).toBe(false);
  });
});
