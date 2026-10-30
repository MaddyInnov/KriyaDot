// SPDX-License-Identifier: Apache-2.0
// Universal per-task cloud placement (Part 5) + cloud deploy sync pairing
// (Part 4). The "cloud instance" is a tiny local stub HTTP server; the
// Lightning client is the existing Fake. No external network.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentRuntime, BotConfig, TokenUsage } from '@mvp/agent-runtime';
import { createUniversalRouter } from '../src/universal-routes.js';
import { UniversalChatStore } from '../src/universal.js';
import { PlacementStore } from '../src/placement.js';
import { mintLinkToken, verifyLinkToken } from '../src/sync-hub.js';
import { writeSyncTarget } from '../src/sync-client.js';
import { deployKriyadot } from '../src/cloud-deploy.js';
import { FakeLightningClient, InMemoryCloudSecretStore } from '../src/cloud-lightning.js';
import { createCloudLightningRouter } from '../src/cloud-routes.js';
import { createHash } from 'node:crypto';

const OWNER = 'owner-token-u';
const U: TokenUsage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const CHIEF = { id: 'chief', name: 'Chief', description: 'Chief of Staff', systemPrompt: 'c', provider: 'ovh-anonymous', model: 'gpt-oss-120b', tools: [], skills: [] } as unknown as BotConfig;

async function listen(app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.on('listening', r));
  const addr = server.address();
  return { server, base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` };
}
function tmp(p: string): string { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

function makeRuntime(appended: Array<{ sessionId: string; role: string; content: string }>) {
  let created = 0;
  return {
    runTurn: async (opts: { bot: BotConfig; onEvent: (e: { type: string; content?: string; usage?: TokenUsage }) => Promise<void> }) => {
      await opts.onEvent({ type: 'token', content: `local reply from ${opts.bot.id}` });
      await opts.onEvent({ type: 'done', usage: U });
      return U;
    },
    sessionStore: {
      createSession: (_botId: string) => `sess_${++created}`,
      appendMessage: (sessionId: string, msg: { role: string; content: string }) => { appended.push({ sessionId, role: msg.role, content: msg.content }); },
    },
  } as unknown as AgentRuntime;
}

describe('universal cloud placement', () => {
  let dir: string;
  let instDir: string;
  beforeEach(() => { dir = tmp('uni-local-'); instDir = tmp('uni-inst-'); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(instDir, { recursive: true, force: true }); });

  /** Stub cloud instance: a REAL universal router on its own data dir, so
   *  the link-token service auth is exercised end to end. */
  async function stubInstance(appended: Array<{ sessionId: string; role: string; content: string }>) {
    const linkToken = mintLinkToken(instDir, 'owner-user');
    const app = express();
    app.use(express.json());
    app.use('/api/universal', createUniversalRouter({
      dataDir: instDir,
      getBots: () => [CHIEF],
      getChiefBotId: () => 'chief',
      agentRuntime: makeRuntime(appended),
      audit: () => undefined,
      loopbackToken: 'inst-owner-token',
      instanceRole: 'cloud',
    }));
    const srv = await listen(app);
    return { ...srv, linkToken };
  }

  function localApp(appended: Array<{ sessionId: string; role: string; content: string }>, store: UniversalChatStore, placement?: PlacementStore) {
    const app = express();
    app.use(express.json());
    app.use('/api/universal', createUniversalRouter({
      dataDir: dir,
      getBots: () => [CHIEF],
      getChiefBotId: () => 'chief',
      agentRuntime: makeRuntime(appended),
      audit: () => undefined,
      loopbackToken: OWNER,
      store,
      ...(placement ? { placementStore: placement } : {}),
      instanceRole: 'local',
    }));
    return app;
  }

  const headers = { 'content-type': 'application/json', authorization: `Bearer ${OWNER}` };

  it('placement cloud without a sync target → 409 cloud-not-connected', async () => {
    const appended: Array<{ sessionId: string; role: string; content: string }> = [];
    const store = new UniversalChatStore(dir);
    const { server, base } = await listen(localApp(appended, store));
    try {
      const res = await fetch(`${base}/api/universal/chat`, { method: 'POST', headers, body: JSON.stringify({ message: 'hi', placement: 'cloud' }) });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('cloud-not-connected');
    } finally { server.close(); }
  });

  it('placement cloud proxies the turn (SSE passthrough), mirrors it locally with a (cloud) attribution', async () => {
    const instAppended: Array<{ sessionId: string; role: string; content: string }> = [];
    const inst = await stubInstance(instAppended);
    const appended: Array<{ sessionId: string; role: string; content: string }> = [];
    const store = new UniversalChatStore(dir);
    writeSyncTarget(dir, { instanceUrl: inst.base, linkToken: inst.linkToken });
    const { server, base } = await listen(localApp(appended, store));
    try {
      const res = await fetch(`${base}/api/universal/message`, { method: 'POST', headers, body: JSON.stringify({ message: 'hello there', placement: 'cloud' }) });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('local reply from chief'); // instance's reply, streamed through
      expect(text).toContain('"type":"routing"');
      // Mirrored into the LOCAL universal thread.
      expect(appended.some((a) => a.role === 'user' && a.content === 'hello there')).toBe(true);
      expect(appended.some((a) => a.role === 'assistant' && a.content === 'local reply from chief')).toBe(true);
      const sessionId = store.getSessionId('default-user');
      expect(sessionId).toBeTruthy();
      const attrs = store.listAttributions(sessionId as string);
      expect(attrs[0]).toMatchObject({ path: 'direct', via: 'cloud', botName: 'Chief (cloud)' });
    } finally { server.close(); inst.server.close(); }
  });

  it('the instance universal endpoint rejects a bad link token and accepts the owner link token as a service credential', async () => {
    const instAppended: Array<{ sessionId: string; role: string; content: string }> = [];
    const inst = await stubInstance(instAppended);
    try {
      const bad = await fetch(`${inst.base}/api/universal/message`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nope' }, body: JSON.stringify({ message: 'hi' }),
      });
      expect(bad.status).toBe(401);
      const good = await fetch(`${inst.base}/api/universal/message`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${inst.linkToken}` }, body: JSON.stringify({ message: 'hi' }),
      });
      expect(good.status).toBe(200);
      expect(await good.text()).toContain('local reply from chief');
    } finally { inst.server.close(); }
  });

  it('cloud-only bot is refused locally (409) and never executes', async () => {
    const appended: Array<{ sessionId: string; role: string; content: string }> = [];
    const store = new UniversalChatStore(dir);
    const placement = new PlacementStore(dir);
    placement.setBot('chief', { placement: 'cloud-only' });
    const { server, base } = await listen(localApp(appended, store, placement));
    try {
      const res = await fetch(`${base}/api/universal/chat`, { method: 'POST', headers, body: JSON.stringify({ message: 'hello there' }) });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('cloud-only-bot');
    } finally { server.close(); }
  });
});

describe('cloud deploy sync provisioning', () => {
  it('deployKriyadot seeds only the token HASH into the Studio and returns the pairing', async () => {
    const fake = new FakeLightningClient([{ name: 'kriyadot', state: 'running', publicUrl: 'https://studio-8080.lightning.ai/' }]);
    const result = await deployKriyadot(fake, {
      repoUrl: 'https://github.com/example/kriyadot.git',
      syncLinkToken: 'pair-token-123',
      syncOwnerUserId: 'user-9',
    });
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.name)).toContain('sync-pairing');
    expect(result.syncPairing).toEqual({ instanceUrl: 'https://studio-8080.lightning.ai/', linkToken: 'pair-token-123' });
    const seedCmd = fake.runCommands.find((c) => c.includes('sync-hub.json')) ?? '';
    expect(seedCmd).toContain('chmod 600');
    const b64 = /printf %s '([^']+)'/.exec(seedCmd)?.[1] ?? '';
    const seed = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as { linkTokenHash: string; ownerUserId: string };
    expect(seed.linkTokenHash).toBe(createHash('sha256').update('pair-token-123').digest('hex'));
    expect(seed.ownerUserId).toBe('user-9');
    expect(JSON.stringify(seed)).not.toContain('pair-token-123');
    // The seeded hash verifies against the hub's own checker shape.
    const dir2 = tmp('seed-verify-');
    try {
      fs.writeFileSync(path.join(dir2, 'sync-hub.json'), JSON.stringify(seed));
      expect(verifyLinkToken(dir2, 'pair-token-123')).toBe(true);
      expect(verifyLinkToken(dir2, 'wrong')).toBe(false);
    } finally { fs.rmSync(dir2, { recursive: true, force: true }); }
    // And the Studio env carries the cloud role for the executor gate.
    const envCmd = fake.runCommands.find((c) => c.includes('.env.cloud')) ?? '';
    const envB64 = /printf %s '([^']+)'/.exec(envCmd)?.[1] ?? '';
    expect(Buffer.from(envB64, 'base64').toString('utf8')).toContain('KRIYADOT_INSTANCE_ROLE=cloud');
  });

  it('cloud deploy route returns a syncPairing the local app can store as its target', async () => {
    const dir = tmp('deploy-route-');
    const fake = new FakeLightningClient([{ name: 'kriyadot', state: 'running', publicUrl: 'https://studio-8080.lightning.ai/' }]);
    const secrets = new InMemoryCloudSecretStore();
    const app = express();
    app.use(express.json());
    app.use('/api', createCloudLightningRouter({ secretStore: secrets, client: fake, dataDir: dir, loopbackToken: OWNER, providerEnvForUser: async () => ({}) }));
    const { server, base } = await listen(app);
    try {
      const h = { 'content-type': 'application/json', authorization: `Bearer ${OWNER}` };
      await fetch(`${base}/api/cloud/lightning/connect`, { method: 'POST', headers: h, body: JSON.stringify({ userId: 'lu-1', apiKey: 'lk-1' }) });
      const res = await fetch(`${base}/api/cloud/lightning/deploy`, { method: 'POST', headers: h, body: JSON.stringify({ repoUrl: 'https://github.com/example/kriyadot.git' }) });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { deploy: { ok: boolean; syncPairing?: { instanceUrl: string; linkToken: string } } };
      expect(json.deploy.ok).toBe(true);
      expect(json.deploy.syncPairing?.instanceUrl).toBe('https://studio-8080.lightning.ai/');
      expect(json.deploy.syncPairing?.linkToken.length).toBeGreaterThan(20);
    } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
