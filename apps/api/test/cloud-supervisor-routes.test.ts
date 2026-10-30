// SPDX-License-Identifier: Apache-2.0
// Cloud supervisor + routes tests — FakeLightningClient, in-memory secret
// store, injected clock/probe. No network beyond loopback to the test app.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import {
  FakeLightningClient,
  InMemoryCloudSecretStore,
} from '../src/cloud-lightning.js';
import { CloudSupervisor, detectRestart } from '../src/cloud-supervisor.js';
import { createCloudLightningRouter, lightningPlans } from '../src/cloud-routes.js';
const OWNER_TOKEN = 'test-owner-token'; // OPEN-1: requests authenticate with the loopback owner credential


const clock = { t: 1_000_000, now() { return this.t; } };

function makeSupervisor(fake: FakeLightningClient, healthy: boolean, tier: 'free' | 'pro' = 'free') {
  return new CloudSupervisor({
    client: fake,
    studioName: 'kriyadot',
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
  it('sleeping Studio → waking (never "down"), start requested, alwaysOn false', async () => {
    const fake = new FakeLightningClient([{ name: 'kriyadot', state: 'sleeping' }]);
    const sup = makeSupervisor(fake, true);
    const state = await sup.tick();
    expect(state.state).toBe('waking');
    expect(state.reachable).toBe(false);
    expect(state.alwaysOn).toBe(false);
    expect(state.wakeAttempts).toBe(1);
    expect(fake.calls).toContain('startStudio:kriyadot');
  });

  it('running + healthy → reachable; free tier still never alwaysOn, pro mirrors reachable', async () => {
    const fake = new FakeLightningClient([
      { name: 'kriyadot', state: 'running', publicUrl: 'https://x-8080.lightning.ai/', uptimeSeconds: 60 },
    ]);
    const free = await makeSupervisor(fake, true, 'free').tick();
    expect(free).toMatchObject({ state: 'running', reachable: true, alwaysOn: false });
    const pro = await makeSupervisor(fake, true, 'pro').tick();
    expect(pro.alwaysOn).toBe(true);
  });

  it('running but unhealthy → restarts the in-Studio supervisor and reports waking', async () => {
    const fake = new FakeLightningClient([
      { name: 'kriyadot', state: 'running', publicUrl: 'https://x-8080.lightning.ai/', uptimeSeconds: 60 },
    ]);
    const state = await makeSupervisor(fake, false).tick();
    expect(state.state).toBe('waking');
    expect(state.supervisorRestarts).toBe(1);
    expect(fake.runCommands.some((c) => c.includes('supervisor.sh'))).toBe(true);
  });

  it('4-hour restart detection: uptime regression triggers a keep-state supervisor restart', async () => {
    const fake = new FakeLightningClient([
      { name: 'kriyadot', state: 'running', publicUrl: 'https://x-8080.lightning.ai/', uptimeSeconds: 14_000, startedAt: 111 },
    ]);
    const sup = makeSupervisor(fake, true);
    const first = await sup.tick();
    expect(first.detectedRestarts).toBe(0);
    // Lightning force-restarts the free Studio: uptime resets, start time moves.
    fake.setStudioState('kriyadot', { uptimeSeconds: 30, startedAt: 222 });
    const second = await sup.tick();
    expect(second.detectedRestarts).toBe(1);
    expect(second.supervisorRestarts).toBe(1);
    expect(second.reachable).toBe(true);
  });

  it('missing Studio → stopped with a deploy-first detail', async () => {
    const fake = new FakeLightningClient();
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
  let fake: FakeLightningClient;
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
    fake = new FakeLightningClient([
      { name: 'kriyadot', state: 'running', machine: 'CPU-4', teamspace: 'me/default', publicUrl: 'https://x-8080.lightning.ai/' },
    ]);
    store = new InMemoryCloudSecretStore();
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      createCloudLightningRouter({
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
    const bad = await req('POST', '/api/cloud/lightning/connect', { userId: 'lu' });
    expect(bad.status).toBe(400);
    const good = await req('POST', '/api/cloud/lightning/connect', { userId: 'lu-1', apiKey: 'lk-secret' });
    expect(good.status).toBe(200);
    expect(JSON.stringify(good.json)).not.toContain('lk-secret');
    expect(store.get('default-user', 'lightning-api-key')).toBe('lk-secret');
    expect(fake.calls).toContain('verifyCredentials');
  });

  it('connect rejects credentials the client cannot verify and stores nothing', async () => {
    fake.verifyResult = { ok: false, detail: 'invalid' };
    const res = await req('POST', '/api/cloud/lightning/connect', { userId: 'lu', apiKey: 'bad' });
    expect(res.status).toBe(401);
    expect(store.get('default-user', 'lightning-api-key')).toBeUndefined();
  });

  it('status before connect says connected:false; after connect it maps the Studio', async () => {
    const before = await req('GET', '/api/cloud/lightning/status');
    expect(before.json.connected).toBe(false);
    await req('POST', '/api/cloud/lightning/connect', { userId: 'lu-1', apiKey: 'lk' });
    const after = await req('GET', '/api/cloud/lightning/status');
    expect(after.json.connected).toBe(true);
    expect(after.json.studio.state).toBe('running');
    expect(after.json.alwaysOn).toBe(false);
    expect(JSON.stringify(after.json)).not.toContain('"lk"');
  });

  it('disconnect deletes the stored pair', async () => {
    await req('POST', '/api/cloud/lightning/connect', { userId: 'lu-1', apiKey: 'lk' });
    const res = await req('POST', '/api/cloud/lightning/disconnect');
    expect(res.json.connected).toBe(false);
    expect(store.get('default-user', 'lightning-user-id')).toBeUndefined();
    const status = await req('GET', '/api/cloud/lightning/status');
    expect(status.json.connected).toBe(false);
  });

  it('usage returns ONLY SDK-visible facts + deep links — no balance field anywhere', async () => {
    await req('POST', '/api/cloud/lightning/connect', { userId: 'lu-1', apiKey: 'lk' });
    const res = await req('GET', '/api/cloud/lightning/usage');
    expect(res.status).toBe(200);
    const usage = res.json.usage as Record<string, unknown>;
    expect(usage.studioStatus).toBe('running');
    expect(usage.machine).toBe('CPU-4');
    expect(usage.teamspace).toBe('me/default');
    expect(usage.diskUsageBytes).toBe(123_456_789);
    expect(typeof usage.billingUrl).toBe('string');
    expect(typeof usage.plansUrl).toBe('string');
    const flat = JSON.stringify(res.json).toLowerCase();
    expect(flat).not.toContain('balanceusd');
    expect(flat).not.toContain('creditsremaining');
    expect(usage).not.toHaveProperty('creditBalance');
    expect(usage).not.toHaveProperty('credits');
  });

  it('usage/deploy/supervisor are 409 before connect', async () => {
    expect((await req('GET', '/api/cloud/lightning/usage')).status).toBe(409);
    expect((await req('POST', '/api/cloud/lightning/deploy', { repoUrl: 'https://github.com/e/x.git' })).status).toBe(409);
    expect((await req('GET', '/api/cloud/lightning/supervisor')).status).toBe(409);
  });

  it('deploy drives the fake through the full sequence with vault provider env', async () => {
    await req('POST', '/api/cloud/lightning/connect', { userId: 'lu-1', apiKey: 'lk' });
    const res = await req('POST', '/api/cloud/lightning/deploy', {
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

  it('plans: descriptors + checkout links, the exact priceNote, and NO hard-coded prices', async () => {
    const res = await req('GET', '/api/cloud/lightning/plans');
    expect(res.status).toBe(200);
    expect(res.json.priceNote).toBe(
      'See current plans on lightning.ai — prices change and are not quoted here',
    );
    expect((res.json.plans as { id: string }[]).map((p) => p.id)).toEqual([
      'free',
      'pro',
      'teams',
      'enterprise',
    ]);
    for (const plan of res.json.plans as Record<string, unknown>[]) {
      expect(plan.checkoutUrl).toBe('https://lightning.ai/pricing');
      expect(plan).not.toHaveProperty('price');
      expect(plan).not.toHaveProperty('priceUsd');
    }
    expect(JSON.stringify(lightningPlans())).not.toMatch(/\$\d/);
  });

  it('supervisor route reports the honest free-tier state', async () => {
    await req('POST', '/api/cloud/lightning/connect', { userId: 'lu-1', apiKey: 'lk' });
    const res = await req('GET', '/api/cloud/lightning/supervisor');
    expect(res.status).toBe(200);
    expect(res.json.supervisor).toMatchObject({ state: 'running', reachable: true, alwaysOn: false, tier: 'free' });
  });
});
