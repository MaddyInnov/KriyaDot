// SPDX-License-Identifier: Apache-2.0
// Tests for bridge-commands.ts (`kriyadot bridge …`): invite, link, list /
// peers, experts, chat, unlink — driven through a stubbed KriyaDotApi that
// records requests, plus the registerBridgeCommands registration helper.

import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { registerBridgeCommands, runBridgeCommand } from '../src/bridge-commands.js';
import type { CommandDeps } from '../src/commands.js';
import { EXIT_ERROR, EXIT_USAGE } from '../src/exits.js';

interface Recorded {
  path: string;
  method: string;
  body?: unknown;
}

const PEER = {
  peerId: 'kd_abc',
  name: 'Remote',
  url: 'http://127.0.0.1:9999/api/federation',
  status: 'active',
  publicKey: 'pk',
  policy: { exposedBotIds: ['helper'], capabilities: ['chat'], rateCapPerMinute: 30 },
  createdAt: 1,
  linkedAt: 2,
};

function makeDeps(responder: (r: Recorded) => unknown) {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const requests: Recorded[] = [];
  const api = {
    request: async (path: string, init?: RequestInit) => {
      const rec: Recorded = {
        path,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      };
      requests.push(rec);
      return responder(rec);
    },
  };
  const deps = {
    cfg: { apiUrl: 'http://localhost:4000', token: 't' },
    api,
    createApi: () => api,
    stdin: {},
    stdout: { write: (s: string) => (outChunks.push(s), true) },
    stderr: { write: (s: string) => (errChunks.push(s), true) },
    isTTY: false,
    readStdinAll: async () => '',
    prompt: async () => null,
    clearScreen: () => undefined,
    createLineSource: () => {
      throw new Error('no line source in this test');
    },
  } as unknown as CommandDeps;
  return { deps, requests, out: () => outChunks.join(''), err: () => errChunks.join('') };
}

function defaultResponder(r: Recorded): unknown {
  if (r.path === '/federation/invites') return { ok: true, payload: 'PAYLOAD123', invite: { inviteId: 'inv_1', expiresAt: 1893456000000 } };
  if (r.path === '/federation/accept') return { ok: true, peer: PEER };
  if (r.path === '/federation/peers') return { ok: true, peers: [PEER] };
  if (r.path.endsWith('/experts')) return { ok: true, experts: [{ id: 'helper', name: 'Helper', description: 'helps' }] };
  if (r.path.endsWith('/chat')) return { ok: true, text: 'peer reply', stub: { remoteSessionId: 'fed_x_1' } };
  if (r.method === 'DELETE') return { ok: true, removed: true };
  throw new Error(`unexpected ${r.method} ${r.path}`);
}

describe('bridge commands', () => {
  it('invite posts the tunnel policy and prints the payload', async () => {
    const { deps, requests, out } = makeDeps(defaultResponder);
    const code = await runBridgeCommand(parseArgs(['bridge', 'invite', '--expose', 'helper,coder']), deps);
    expect(code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ path: '/federation/invites', method: 'POST' });
    expect((requests[0]!.body as { policyForPeer: { exposedBotIds: string[] } }).policyForPeer.exposedBotIds).toEqual(['helper', 'coder']);
    expect(out()).toContain('PAYLOAD123');
  });

  it('link posts the payload to /federation/accept and reports the peer', async () => {
    const { deps, requests, out } = makeDeps(defaultResponder);
    const code = await runBridgeCommand(parseArgs(['bridge', 'link', 'PAYLOAD123', '--expose', 'helper']), deps);
    expect(code).toBe(0);
    expect(requests[0]).toMatchObject({ path: '/federation/accept', method: 'POST' });
    expect((requests[0]!.body as { payload: string }).payload).toBe('PAYLOAD123');
    expect(out()).toContain('Linked to Remote (kd_abc)');
  });

  it('link without a payload is a usage error and calls nothing', async () => {
    const { deps, requests } = makeDeps(defaultResponder);
    const code = await runBridgeCommand(parseArgs(['bridge', 'link']), deps);
    expect(code).toBe(EXIT_USAGE);
    expect(requests).toHaveLength(0);
  });

  it('list and peers both render the peer table', async () => {
    for (const sub of ['list', 'peers']) {
      const { deps, out } = makeDeps(defaultResponder);
      const code = await runBridgeCommand(parseArgs(['bridge', sub]), deps);
      expect(code).toBe(0);
      expect(out()).toContain('kd_abc');
      expect(out()).toContain('exposed: helper');
    }
  });

  it('experts and chat hit the signed proxy routes', async () => {
    const { deps, requests, out } = makeDeps(defaultResponder);
    expect(await runBridgeCommand(parseArgs(['bridge', 'experts', 'kd_abc']), deps)).toBe(0);
    expect(out()).toContain('helper');
    expect(await runBridgeCommand(parseArgs(['bridge', 'chat', 'kd_abc', 'helper', 'hello', 'there']), deps)).toBe(0);
    expect(out()).toContain('peer reply');
    const chatReq = requests.find((r) => r.path.endsWith('/chat'));
    expect(chatReq?.path).toBe('/federation/peers/kd_abc/experts/helper/chat');
    expect((chatReq?.body as { message: string }).message).toBe('hello there');
  });

  it('unlink issues DELETE and confirms', async () => {
    const { deps, requests, out } = makeDeps(defaultResponder);
    const code = await runBridgeCommand(parseArgs(['bridge', 'unlink', 'kd_abc']), deps);
    expect(code).toBe(0);
    expect(requests[0]).toMatchObject({ path: '/federation/peers/kd_abc', method: 'DELETE' });
    expect(out()).toContain('Unlinked kd_abc');
  });

  it('bare bridge prints help; unknown subcommand is a usage error', async () => {
    const { deps, out } = makeDeps(defaultResponder);
    expect(await runBridgeCommand(parseArgs(['bridge']), deps)).toBe(0);
    expect(out()).toContain('bridge link');
    expect(await runBridgeCommand(parseArgs(['bridge', 'bogus']), deps)).toBe(EXIT_USAGE);
  });

  it('API failures surface as exit 1 with the error on stderr', async () => {
    const { deps, err } = makeDeps(() => {
      throw new Error('API 403: bot_not_exposed');
    });
    const code = await runBridgeCommand(parseArgs(['bridge', 'chat', 'kd_abc', 'secret', 'hi']), deps);
    expect(code).toBe(EXIT_ERROR);
    expect(err()).toContain('bot_not_exposed');
  });

  it('registerBridgeCommands registers the bridge handler', () => {
    const registry = new Map();
    registerBridgeCommands(registry);
    expect(registry.get('bridge')).toBe(runBridgeCommand);
  });
});
