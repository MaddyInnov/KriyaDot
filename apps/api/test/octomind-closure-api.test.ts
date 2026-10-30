// SPDX-License-Identifier: Apache-2.0
// Octomind closure, API side: #67/#101 script hooks, #83 evolution
// reject, #114 session commands, #143/#151 workflow surface, #156
// startup bootstrap, #166 intent search, #102 daemon inject, #181
// log-level. All network/process seams are fakes.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { HookBus, loadRoutingRules, TrigramEmbedder } from '@mvp/agent-runtime';
import { installBotScriptHooks, parseScriptHookConfig } from '../src/hooks-config.js';
import { registerScriptHooksFromConfigs } from '../src/plugin-routes.js';
import { createScriptWebhookRouter } from '../src/webhooks.js';
import { createEvolutionRouter } from '../src/evolution-routes.js';
import { SessionCommandService } from '../src/session-commands-routes.js';
import { createWorkflowSurfaceRouter } from '../src/workflow-surface-routes.js';
import { createDiscoveryRouter } from '../src/discovery-routes.js';
import { createDaemonInjectRouter, NamedSessionRegistry } from '../src/daemon-inject-routes.js';
import { createLogLevelRouter, getLogLevel, setLogLevel } from '../src/log-level.js';
import { runStartupBootstrap } from '../src/boot-bootstrap.js';
import { MarketplaceInstaller, MarketplaceRegistry } from '@mvp/marketplace';

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'closure-')); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function serve(router: express.Router, mount = '/api'): Promise<string> {
  const app = express();
  app.use(express.json());
  if (mount === 'ROOT') app.use(router);
  else app.use(mount, router);
  const server = await new Promise<{ address(): AddressInfo; close(cb: () => void): void }>((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv as never));
  });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}${mount === 'ROOT' ? '' : mount}`;
}
const servers: Array<{ close(cb: () => void): void }> = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r())); });
const post = (base: string, path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('#67 script hooks host wiring', () => {
  it('parses bot config hooks and a registered script handler fires on tool.after with stdout-on-failure injection', async () => {
    const parsed = parseScriptHookConfig([
      { kind: 'script', command: ['check.sh'], events: ['tool.after'] },
      { kind: 'script', command: 'not-an-array' },
      { kind: 'other', command: ['x'] },
    ]);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.errors).toHaveLength(1);

    const bus = new HookBus();
    const fakeCreate = () => async () => ({ inject: 'check failed: lint errors' });
    const { registered, unsubs } = installBotScriptHooks(bus, { hooks: [{ kind: 'script', command: ['check.sh'], events: ['tool.after'] }] }, { createHandler: fakeCreate as never });
    expect(registered).toBe(1);
    const result = await bus.emit('tool.after', { toolName: 'write_file' });
    expect(result.injections).toEqual(['check failed: lint errors']);
    for (const u of unsubs) u();
    expect((await bus.emit('tool.after', {})).injections).toEqual([]);
  });

  it('registerScriptHooksFromConfigs in plugin-routes registers across bots', async () => {
    const bus = new HookBus();
    // plugin-routes uses the real createScriptHookHandler; use a config
    // whose command is node with a failing inline script via the hooks
    // module directly instead — here just assert registration counts
    // with no-op entries (empty hooks) to keep tests process-free.
    const r = registerScriptHooksFromConfigs(bus, [{ hooks: [] }, { hooks: [{ kind: 'script', command: ['true'], events: ['session.created'] }] }]);
    expect(r.registered).toBe(1);
    expect(bus.handlerCount('session.created')).toBe(1);
  });
});

describe('#101 webhook → script hook', () => {
  it('POST runs the configured script (fake runner) and returns its injection; unknown hook 404; bad secret 401', async () => {
    const router = createScriptWebhookRouter({
      hooks: [{ kind: 'script', command: ['check.sh'], events: ['tool.after'], name: 'lint' }],
      secrets: { lint: 's3cret' },
      runHook: async (_e, payload) => ({ injections: [`ran with ${JSON.stringify(payload)}`], errors: [] }),
    });
    const base = await serve(router, '/webhooks');
    const bad = await post(base, '/script/lint', { a: 1 });
    expect(bad.status).toBe(401);
    const ok = await fetch(`${base}/script/lint`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': 's3cret' }, body: JSON.stringify({ a: 1 }) });
    expect(ok.status).toBe(202);
    const body = await ok.json() as { fired: boolean; injections: string[] };
    expect(body.fired).toBe(true);
    expect(body.injections[0]).toContain('"a":1');
    expect((await post(base, '/script/nope', {})).status).toBe(404);
  });
});

describe('#83 evolution reject endpoint', () => {
  it('reject is distinct: records a rejection, retires the rule, 404s unknown ids', async () => {
    const dir = tmp();
    const { recordShadowCorrection, saveRoutingRules, loadRoutingRules: load } = await import('@mvp/agent-runtime');
    recordShadowCorrection(dir, { taskType: 'code', routedProviderId: 'p1', routedModelId: 'm1', correctedProviderId: 'p2', correctedModelId: 'm2', message: 'use the other model for code' });
    const rules = load(dir);
    expect(rules.length).toBeGreaterThan(0);
    void saveRoutingRules;
    const base = await serve(createEvolutionRouter({ dataDir: dir, only: ['reject'] }), '/api/routing');
    const id = rules[0]!.id;
    const res = await post(base, `/rules/${id}/reject`, { reason: 'bad rule' });
    expect(res.status).toBe(200);
    const body = await res.json() as { action: string; rules: Array<{ id: string; status: string }> };
    expect(body.action).toBe('rejected');
    expect(body.rules.find((r) => r.id === id)?.status).toBe('rejected');
    expect(loadRoutingRules(dir).find((r) => r.id === id)).toBeDefined(); // kept for audit, retired underneath
    expect((await post(base, '/rules/nope/reject', {})).status).toBe(404);
    const rej = await (await fetch(`${base}/rejections`)).json() as { rejections: Record<string, { reason?: string }> };
    expect(rej.rejections[id]?.reason).toBe('bad rule');
  });
});

describe('#114 session commands', () => {
  const messages = [
    { id: 1, role: 'user', content: 'hello', ts: 't1' },
    { id: 2, role: 'assistant', content: 'hi there', ts: 't2' },
    { id: 3, role: 'assistant', content: 'second answer', ts: 't3' },
  ] as never[];
  function service(extra: Record<string, unknown> = {}) {
    return new SessionCommandService({
      getMessages: () => messages,
      compactNow: async () => true,
      shareSession: async () => ({ slug: 'abc', path: '/p/abc' }),
      learningKickoff: async () => ({ captured: 2 }),
      usageForSession: () => ({ totalTokens: 100, costUsd: 0.05, cacheReadTokens: 40, requests: [{ id: 'r1', totalTokens: 100 }] }),
      statusAggregate: () => ({ workflowRuns: 1, backgroundJobs: 2, monitors: 3, shellJobs: 0 }),
      createSession: () => 'new-session-1',
      scheduleIntoSession: async (_s, _b, cmd) => ({ scheduled: cmd.prompt }),
      learning: {
        list: () => [{ id: 'L1' }], show: (_b, id) => ({ id }), remove: async () => true, clear: async () => 4,
        evolution: async (action, id) => ({ action, id }),
      },
      ...extra,
    } as never);
  }

  it('/copy segments, /share, /analyze (localOnly), /info combines tokens+cost+cache, /usage notes BYOK balance N/A', async () => {
    const svc = service();
    expect((await svc.execute('s1', 'bot-1', '/copy last')).data).toMatchObject({ segment: 'last', text: 'second answer' });
    expect((await svc.execute('s1', 'bot-1', '/copy assistant')).data).toMatchObject({ text: 'hi there\n\nsecond answer' });
    expect((await svc.execute('s1', 'bot-1', '/copy user')).data).toMatchObject({ text: 'hello' });
    expect((await svc.execute('s1', 'bot-1', '/share')).reply).toContain('/p/abc');
    const analyze = await svc.execute('s1', 'bot-1', '/analyze');
    expect(analyze.data).toMatchObject({ localOnly: true, uploaded: false });
    const info = await svc.execute('s1', 'bot-1', '/info');
    expect(info.data).toMatchObject({ costUsd: 0.05, cache: { readTokens: 40 } });
    const usage = await svc.execute('s1', 'bot-1', '/usage');
    expect(usage.reply).toContain('N/A');
    expect(usage.data).toMatchObject({ accountBalance: null });
    const report = await svc.execute('s1', 'bot-1', '/report');
    expect(report.data).toEqual([{ id: 'r1', totalTokens: 100 }]);
    const status = await svc.execute('s1', 'bot-1', '/status');
    expect(status.data).toMatchObject({ monitors: 3, workflowRuns: 1 });
  });

  it('/done compacts + kicks learning via fallback, /compact, /new, /schedule, /learning subcommands', async () => {
    const svc = service();
    const doneRes = await svc.execute('s1', 'bot-1', '/done');
    expect(doneRes.data).toMatchObject({ folded: true, learningVia: 'upkeep-capture' });
    expect((await svc.execute('s1', 'bot-1', '/compact')).data).toMatchObject({ folded: true });
    expect((await svc.execute('s1', 'bot-1', '/new')).data).toMatchObject({ sessionId: 'new-session-1' });
    expect((await svc.execute('s1', 'bot-1', '/schedule in 5m :: check the deploy')).data).toMatchObject({ scheduled: 'check the deploy' });
    expect((await svc.execute('s1', 'bot-1', '/learning list')).data).toEqual([{ id: 'L1' }]);
    expect((await svc.execute('s1', 'bot-1', '/learning clear')).data).toMatchObject({ cleared: 4 });
    expect((await svc.execute('s1', 'bot-1', '/learning evolution reject rule-9')).data).toMatchObject({ action: 'reject', id: 'rule-9' });
    expect((await svc.execute('s1', 'bot-1', '/bogus')).handled).toBe(false);
  });
});

describe('#143/#151 workflow surface', () => {
  const def = {
    id: 'wf-1', name: 'Demo', nodes: [
      { id: 'a', type: 'trigger', name: 'A', config: {} },
      { id: 'b', type: 'set', name: 'B', config: { values: { done: true } } },
    ], edges: [['a', 'b']],
  } as never;
  it('export JSON + TOML, import round-trips, dry-run spawns nothing', async () => {
    const saved: unknown[] = [];
    const base = await serve(createWorkflowSurfaceRouter({ getWorkflow: (id) => (id === 'wf-1' ? def : undefined), saveWorkflow: (d) => { saved.push(d); } }));
    const expJson = await (await fetch(`${base}/workflows/wf-1/export?format=json`)).json() as { content: string };
    expect(expJson.content).toContain('wf-1');
    const expToml = await (await fetch(`${base}/workflows/wf-1/export?format=toml`)).json() as { content: string; format: string };
    expect(expToml.format).toBe('toml');
    expect(expToml.content.length).toBeGreaterThan(10);
    const imp = await post(base, '/workflows/import', { content: expToml.content, format: 'toml' });
    expect(imp.status).toBe(201);
    expect(saved).toHaveLength(1);
    const dry = await (await post(base, '/workflows/wf-1/dry-run', {})).json() as { spawned: boolean; plan: { levels?: unknown } };
    expect(dry.spawned).toBe(false);
    expect(dry.plan).toBeDefined();
    const dryAdhoc = await post(base, '/workflows/dry-run', { definition: def });
    expect(dryAdhoc.status).toBe(200);
    expect((await fetch(`${base}/workflows/nope/export`)).status).toBe(404);
  });
});

describe('#166 intent search', () => {
  it('ranks bots/skills/mcp/capabilities with a fake embedder and filters kinds', async () => {
    const base = await serve(createDiscoveryRouter({
      embedder: new TrigramEmbedder(),
      items: () => [
        { kind: 'bot', id: 'researcher', name: 'Research Bot', description: 'deep research and citations' },
        { kind: 'skill', id: 'cooking', name: 'Cooking', description: 'recipes and meals' },
        { kind: 'mcp', id: 'fetch', name: 'Fetch Server', description: 'fetch web pages' },
      ],
    }));
    const res = await post(base, '/discovery/search', { intent: 'deep research with citations', topK: 3 });
    const body = await res.json() as { hits: Array<{ item: { id: string } }> };
    expect(body.hits.length).toBeGreaterThan(0);
    expect(body.hits[0]!.item.id).toBe('researcher');
    const filtered = await (await post(base, '/discovery/search', { intent: 'recipes', kinds: ['skill'] })).json() as { hits: Array<{ item: { kind: string } }> };
    expect(filtered.hits.every((h) => h.item.kind === 'skill')).toBe(true);
    expect((await post(base, '/discovery/search', {})).status).toBe(400);
  });
});

describe('#102 daemon inject', () => {
  it('injects into a live named session; refuses dead names', async () => {
    const steered: Array<{ id: string; text: string }> = [];
    const registry = new NamedSessionRegistry(60_000);
    const base = await serve(createDaemonInjectRouter({
      registry,
      enqueueSteer: (id, text) => { steered.push({ id, text }); return { id: 'st1', running: true, pending: 1 }; },
      isTurnRunning: (id) => id === 'sess-live',
    }));
    const reg = await post(base, '/daemon/sessions', { name: 'main', sessionId: 'sess-live', pid: 42 });
    expect(reg.status).toBe(201);
    const inj = await post(base, '/daemon/sessions/main/inject', { text: 'also check the tests' });
    expect(inj.status).toBe(202);
    expect((await inj.json())).toMatchObject({ delivery: 'injected-into-live-turn', sessionId: 'sess-live' });
    expect(steered).toEqual([{ id: 'sess-live', text: 'also check the tests' }]);
    expect((await post(base, '/daemon/sessions/ghost/inject', { text: 'x' })).status).toBe(404);
    const list = await (await fetch(`${base}/daemon/sessions`)).json() as { sessions: Array<{ name: string; alive: boolean }> };
    expect(list.sessions[0]).toMatchObject({ name: 'main', alive: true });
  });
});

describe('#181 log level', () => {
  it('GET/PUT the runtime level; invalid levels 400', async () => {
    const base = await serve(createLogLevelRouter(), 'ROOT');
    // createLogLevelRouter already includes /admin in its paths; served at root here.
    const before = await (await fetch(`${base}/admin/log-level`)).json() as { level: string };
    expect(['error', 'warn', 'info', 'debug']).toContain(before.level);
    const put = await fetch(`${base}/admin/log-level`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ level: 'debug' }) });
    expect(put.status).toBe(200);
    expect(getLogLevel()).toBe('debug');
    const bad = await fetch(`${base}/admin/log-level`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ level: 'loud' }) });
    expect(bad.status).toBe(400);
    setLogLevel('info');
  });
});

describe('#156 startup bootstrap', () => {
  it('runs bootstrapFirstRun at startup, is idempotent, and reports MCP plan handling', () => {
    const dir = tmp();
    const registryPath = join(dir, 'registry.json');
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(registryPath, JSON.stringify([]));
    const registry = MarketplaceRegistry.fromFile(registryPath);
    const installer = new MarketplaceInstaller(join(dir, 'marketplace'));
    const started: string[] = [];
    const first = runStartupBootstrap({ dataDir: dir, registry, installer, startMcpServer: (e) => { started.push((e as { id: string }).id); }, log: () => {} });
    expect(first.alreadyBootstrapped).toBe(false);
    expect(Array.isArray(first.blockers)).toBe(true);
    const second = runStartupBootstrap({ dataDir: dir, registry, installer, log: () => {} });
    expect(second.alreadyBootstrapped).toBe(true);
    void started;
  });
});
