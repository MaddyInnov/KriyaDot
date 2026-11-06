// SPDX-License-Identifier: Apache-2.0
// Cloud supervisor + routes tests — FakeCloudHostClient, in-memory secret
// store, injected clock/probe. No network beyond loopback to the test app.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import {
  FakeCloudHostClient,
  InMemoryCloudSecretStore,
} from '../src/cloud-host.js';
import { CloudSupervisor, detectRestart } from '../src/cloud-supervisor.js';
import { createCloudRouter, cloudHostPlans } from '../src/cloud-routes.js';
const OWNER_TOKEN = 'test-owner-token'; // OPEN-1: requests authenticate with the loopback owner credential


const clock = { t: 1_000_000, now() { return this.t; } };

function makeSupervisor(fake: FakeCloudHostClient, healthy: boolean, tier: 'free' | 'pro' = 'free') {
  return new CloudSupervisor({
    client: fake,
    instanceName: 'kriyadot',
    tier,
    clock,
    healthProbe: async () => healthy,
  });
}

describe('detectRestart', () => {
  it('detects startedAt change and uptime regression, ignores first sight', () => {
    expect(detectRestart(undefined, { uptimeSeconds: 5 })).toBe(false);
    expect(detectRestart({ startedAt: 100 }, { startedAt: 200 })).toBe(true);
    expect(detectRestart({ uptimeSeconds: 900 }, { uptimeSeconds: 10 })).toBe(true);
    expect(detectRestart({ uptimeSeconds: 10 }, { uptimeSeconds: 900 })).toBe(false);
  });
});

describe('CloudSupervisor', () => {
  it('sleeping instance → waking (never "down"), start requested, alwaysOn false', async () => {
    const fake = new FakeCloudHostClient([{ name: 'kriyadot', state: 'sleeping' }]);
    const sup = makeSupervisor(fake, true);
    const state = await sup.tick();
    expect(state.state).toBe('waking');
    expect(state.instance).toBe('kriyadot');
    expect(state.reachable).toBe(false);
    expect(state.alwaysOn).toBe(false);
    expect(state.wakeAttempts).toBe(1);
    expect(fake.calls).toContain('startInstance:kriyadot');
  });

  it('running + healthy → reachable; free tier still never alwaysOn, pro mirrors reachable', async () => {
    const fake = new FakeCloudHostClient([
      { name: 'kriyadot', state: 'running', publicUrl: 'https://x-8080.example.com/', uptimeSeconds: 60 },
    ]);
    const free = await makeSupervisor(fake, true, 'free').tick();
    expect(free).toMatchObject({ state: 'running', reachable: true, alwaysOn: false });
    const pro = await makeSupervisor(fake, true, 'pro').tick();
    expect(pro.alwaysOn).toBe(true);
  });

  it('running but unhealthy → restarts the in-instance supervisor and reports waking', async () => {
    const fake = new FakeCloudHostClient([
      { name: 'kriyadot', state: 'running', publicUrl: 'https://x-8080.example.com/', uptimeSeconds: 60 },
    ]);
    const state = await makeSupervisor(fake, false).tick();
    expect(state.state).toBe('waking');
    expect(state.supervisorRestarts).toBe(1);
    expect(fake.runCommands.some((c) => c.includes('supervisor.sh'))).toBe(true);
  });

  it('host restart detection: uptime regression triggers a keep-state supervisor restart', async () => {
    const fake = new FakeCloudHostClient([
      { name: 'kriyadot', state: 'running', publicUrl: 'https://x-8080.example.com/', uptimeSeconds: 14_000, startedAt: 111 },
    ]);
    const sup = makeSupervisor(fake, true);
    const first = await sup.tick();
    expect(first.detectedRestarts).toBe(0);
    // The host restarts the instance: uptime resets, start time moves.
    fake.setInstanceState('kriyadot', { uptimeSeconds: 30, startedAt: 222 });
    const second = await sup.tick();
    expect(second.detectedRestarts).toBe(1);
    expect(second.supervisorRestarts).toBe(1);
    expect(second.reachable).toBe(true);
  });

  it('missing instance → stopped with a deploy-first detail', async () => {
    const fake = new FakeCloudHostClient();
    const state = await makeSupervisor(fake, true).tick();
    expect(state.state).toBe('stopped');
    expect(state.detail).toMatch(/deploy first/);
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

describe('cloud routes', () => {
  let base: string;
  let server: { close: (cb?: () => void) => void };
  let fake: FakeCloudHostClient;
  let store: InMemoryCloudSecretStore;

  async function req(method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER_TOKEN}`, },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  }

  beforeEach(async () => {
    fake = new FakeCloudHostClient([
      { name: 'kriyadot', state: 'running', machine: 'CPU-4', teamspace: 'me/default', publicUrl: 'https://x-8080.example.com/' },
    ]);
    store = new InMemoryCloudSecretStore();
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createCloudRouter({
        secretStore: store,
        client: fake,
        healthProbe: async () => true,
        providerEnvForUser: () => ({ OPENAI_API_KEY: 'sk-from-vault' }),
        loopbackToken: OWNER_TOKEN,
      }),
    );
    const srv = app.listen(0);
    await new Promise<void>((r) => srv.on('listening', r));
    server = srv;
    const addr = srv.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('connect requires both fields, verifies, stores, and never echoes the key', async () => {
    const bad = await req('POST', '/api/cloud/connect', { accountId: 'acct' });
    expect(bad.status).toBe(400);
    const good = await req('POST', '/api/cloud/connect', { accountId: 'acct-1', apiKey: 'key-secret' });
    expect(good.status).toBe(200);
    expect(JSON.stringify(good.json)).not.toContain('key-secret');
    expect(store.get('default-user', 'cloud-host-api-key')).toBe('key-secret');
    expect(fake.calls).toContain('verifyCredentials');
  });

  it('connect rejects credentials the client cannot verify and stores nothing', async () => {
    fake.verifyResult = { ok: false, detail: 'invalid' };
    const res = await req('POST', '/api/cloud/connect', { accountId: 'acct', apiKey: 'bad' });
    expect(res.status).toBe(401);
    expect(store.get('default-user', 'cloud-host-api-key')).toBeUndefined();
  });

  it('status before connect says connected:false; after connect it maps the instance', async () => {
    const before = await req('GET', '/api/cloud/status');
    expect(before.json.connected).toBe(false);
    await req('POST', '/api/cloud/connect', { accountId: 'acct-1', apiKey: 'key' });
    const after = await req('GET', '/api/cloud/status');
    expect(after.json.connected).toBe(true);
    expect(after.json.instance.state).toBe('running');
    expect(after.json.alwaysOn).toBe(false);
    expect(JSON.stringify(after.json)).not.toContain('"key"');
  });

  it('disconnect deletes the stored pair', async () => {
    await req('POST', '/api/cloud/connect', { accountId: 'acct-1', apiKey: 'key' });
    const res = await req('POST', '/api/cloud/disconnect');
    expect(res.json.connected).toBe(false);
    expect(store.get('default-user', 'cloud-host-account')).toBeUndefined();
    const status = await req('GET', '/api/cloud/status');
    expect(status.json.connected).toBe(false);
  });

  it('usage returns ONLY driver-visible facts — no balance field, no billing/plans links', async () => {
    await req('POST', '/api/cloud/connect', { accountId: 'acct-1', apiKey: 'key' });
    const res = await req('GET', '/api/cloud/usage');
    expect(res.status).toBe(200);
    const usage = res.json.usage as Record<string, unknown>;
    expect(usage.instanceStatus).toBe('running');
    expect(usage.machine).toBe('CPU-4');
    expect(usage.teamspace).toBe('me/default');
    expect(usage.diskUsageBytes).toBe(123_456_789);
    expect(usage).not.toHaveProperty('billingUrl');
    expect(usage).not.toHaveProperty('plansUrl');
    const flat = JSON.stringify(res.json).toLowerCase();
    expect(flat).not.toContain('balanceusd');
    expect(flat).not.toContain('creditsremaining');
    expect(usage).not.toHaveProperty('creditBalance');
    expect(usage).not.toHaveProperty('credits');
  });

  it('usage/deploy/supervisor are 409 before connect', async () => {
    expect((await req('GET', '/api/cloud/usage')).status).toBe(409);
    expect((await req('POST', '/api/cloud/deploy', { repoUrl: 'https://github.com/e/x.git' })).status).toBe(409);
    expect((await req('GET', '/api/cloud/supervisor')).status).toBe(409);
  });

  it('deploy drives the fake through the full sequence with vault provider env', async () => {
    await req('POST', '/api/cloud/connect', { accountId: 'acct-1', apiKey: 'key' });
    const res = await req('POST', '/api/cloud/deploy', {
      repoUrl: 'https://github.com/example/kriyadot.git',
      ollama: true,
    });
    expect(res.status).toBe(200);
    expect(res.json.deploy.ok).toBe(true);
    expect(res.json.deploy.ollama.model).toBe('qwen3:4b');
    const envCmd = fake.runCommands.find((c) => c.includes('.env.cloud')) ?? '';
    const b64 = /printf %s '([^']+)'/.exec(envCmd)?.[1] ?? '';
    expect(Buffer.from(b64, 'base64').toString('utf8')).toContain('OPENAI_API_KEY=sk-from-vault');
    // the deploy response itself must not contain the provider key
    expect(JSON.stringify(res.json)).not.toContain('sk-from-vault');
  });

  it('plans: generic descriptors, NO prices, NO checkout links', async () => {
    const res = await req('GET', '/api/cloud/plans');
    expect(res.status).toBe(200);
    expect(res.json.priceNote).toBe('Prices are set by your cloud host and are not quoted here');
    expect((res.json.plans as { id: string }[]).map((p) => p.id)).toEqual([
      'free',
      'pro',
      'teams',
      'enterprise',
    ]);
    for (const plan of res.json.plans as Record<string, unknown>[]) {
      expect(plan).not.toHaveProperty('checkoutUrl');
      expect(plan).not.toHaveProperty('price');
      expect(plan).not.toHaveProperty('priceUsd');
    }
    expect(res.json).not.toHaveProperty('plansUrl');
    expect(JSON.stringify(cloudHostPlans())).not.toMatch(/\$\d/);
  });

  it('supervisor route reports the honest free-tier state with an instance field', async () => {
    await req('POST', '/api/cloud/connect', { accountId: 'acct-1', apiKey: 'key' });
    const res = await req('GET', '/api/cloud/supervisor');
    expect(res.status).toBe(200);
    expect(res.json.supervisor).toMatchObject({ instance: 'kriyadot', state: 'running', reachable: true, alwaysOn: false, tier: 'free' });
    expect(res.json.supervisor).not.toHaveProperty('studio');
  });
});

describe('cloud routes without a configured driver', () => {
  let base: string;
  let server: { close: (cb?: () => void) => void };

  async function req(method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER_TOKEN}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  }

  beforeEach(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createCloudRouter({
        secretStore: new InMemoryCloudSecretStore(),
        loopbackToken: OWNER_TOKEN,
      }),
    );
    const srv = app.listen(0);
    await new Promise<void>((r) => srv.on('listening', r));
    server = srv;
    const addr = srv.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('connect fails honestly with 503 — no default real client exists', async () => {
    const res = await req('POST', '/api/cloud/connect', { accountId: 'acct-1', apiKey: 'key' });
    expect(res.status).toBe(503);
    expect(res.json.error).toBe('no cloud host driver is configured on this instance');
  });
});
