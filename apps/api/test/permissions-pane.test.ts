// SPDX-License-Identifier: Apache-2.0
// Permissions pane (Muse parity §4.7: P-3..P-7, P-15/P-16): endpoint
// tests over a real express mount, store tests, allowance evaluation
// tests (exact Ask→Allow conversion only), and a GovernanceAdapter
// integration test proving an allowance never widens a policy deny,
// a hard floor, or a privileged tool.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY, GovernanceGateway } from '@mvp/governance';
import type { BotConfig, ToolCall, ToolContext } from '@mvp/agent-runtime';
import {
  createAllowance,
  createAllowanceLookup,
  findAllowanceForCall,
  listAllowances,
  registerPermissionsPaneRoutes,
  type Allowance,
} from '../src/permissions-pane.js';
import { GovernanceAdapter } from '../src/governance-adapter.js';
import { rememberAllowedTool } from '../src/bot-policies.js';

const OWNER_TOKEN = 'tok-owner';
const BOTS = [
  { id: 'bot-1', name: 'Helper', tools: [] },
  { id: 'bot-2', name: 'Coder', tools: [] },
] as unknown as BotConfig[];

let dir: string;
let server: { close(cb: () => void): void } | null = null;
let baseUrl = '';
const audit = vi.fn();

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${OWNER_TOKEN}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'permissions-pane-'));
  audit.mockClear();
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerPermissionsPaneRoutes(router, {
    dataDir: dir,
    bots: BOTS,
    audit,
    listApprovals: () => [],
    loopbackToken: OWNER_TOKEN,
  });
  app.use('/api', router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server as unknown as { address(): AddressInfo }).address().port}/api`;
      resolve();
    });
  });
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe('overview + surfaces (P-3)', () => {
  it('reports the documented defaults per surface', async () => {
    const { status, json } = await req('GET', '/permissions/overview');
    expect(status).toBe(200);
    const byId = new Map(json.surfaces.map((s: any) => [s.id, s]));
    for (const id of ['chat', 'tools', 'browser', 'channels', 'calls', 'purchases']) {
      expect(byId.has(id)).toBe(true);
    }
    expect(byId.get('chat').defaultEffect).toBe('ask');
    expect(byId.get('purchases').defaultEffect).toBe('ask');
    expect(byId.get('purchases').overridable).toBe(false);
    expect(json.counts.allowances).toBe(0);
  });

  it('persists a surface override and refuses to override purchases', async () => {
    const put = await req('PUT', '/permissions/surfaces/browser', { effect: 'deny' });
    expect(put.status).toBe(200);
    const { json } = await req('GET', '/permissions/overview');
    const browser = json.surfaces.find((s: any) => s.id === 'browser');
    expect(browser.currentEffect).toBe('deny');
    expect(browser.overridden).toBe(true);

    const purchases = await req('PUT', '/permissions/surfaces/purchases', { effect: 'allow' });
    expect(purchases.status).toBe(400);
    const unknown = await req('PUT', '/permissions/surfaces/nope', { effect: 'allow' });
    expect(unknown.status).toBe(404);
  });
});

describe('reset (P-3)', () => {
  it('requires confirm and clears overrides, allowances, item overrides and lasting allows', async () => {
    await req('PUT', '/permissions/surfaces/chat', { effect: 'allow' });
    await req('POST', '/permissions/allowances', { kind: 'website', target: 'example.com', actions: ['web_fetch'] });
    await req('PUT', '/permissions/items/artifact/art-1', { actions: { share: 'ask' } });
    rememberAllowedTool(dir, BOTS as unknown as BotConfig[], 'bot-1', 'web_search');

    const refused = await req('POST', '/permissions/reset', {});
    expect(refused.status).toBe(400);

    const { status, json } = await req('POST', '/permissions/reset', { confirm: true });
    expect(status).toBe(200);
    expect(json.cleared.allowances).toBe(1);
    expect(json.cleared.itemOverrides).toBe(1);
    expect(json.cleared.surfaceOverrides).toBe(1);
    expect(json.cleared.lastingAllows).toBe(1);
    expect(json.counts.allowances).toBe(0);
    expect(json.surfaces.find((s: any) => s.id === 'chat').overridden).toBe(false);
    expect(audit).toHaveBeenCalledWith('permissions.reset', expect.objectContaining({ detail: expect.objectContaining({ allowances: 1 }) }));
  });
});

describe('allowances CRUD (P-6/P-15/P-16)', () => {
  it('creates, lists and revokes website/recipient/task allowances', async () => {
    const created = await req('POST', '/permissions/allowances', {
      kind: 'recipient',
      target: 'friend@example.com',
      actions: ['send'],
      scope: { botId: 'bot-1' },
    });
    expect(created.status).toBe(201);
    expect(created.json.allowance.target).toBe('friend@example.com');

    const site = await req('POST', '/permissions/allowances', {
      kind: 'website',
      target: 'https://www.Example.com/some/page',
      actions: ['web_fetch'],
    });
    expect(site.status).toBe(201);
    expect(site.json.allowance.target).toBe('example.com');

    const list = await req('GET', '/permissions/allowances');
    expect(list.json.allowances).toHaveLength(2);

    const revoked = await req('DELETE', `/permissions/allowances/${created.json.allowance.id}`);
    expect(revoked.status).toBe(200);
    expect((await req('GET', '/permissions/allowances')).json.allowances).toHaveLength(1);
    expect((await req('DELETE', `/permissions/allowances/${created.json.allowance.id}`)).status).toBe(404);
  });

  it('rejects purchase allowances, bad kinds and unknown scope bots', async () => {
    expect((await req('POST', '/permissions/allowances', { kind: 'task', target: 't1', actions: ['request_purchase'] })).status).toBe(400);
    expect((await req('POST', '/permissions/allowances', { kind: 'planet', target: 'x', actions: ['send'] })).status).toBe(400);
    expect((await req('POST', '/permissions/allowances', { kind: 'task', target: 't1', actions: ['send'], scope: { botId: 'ghost' } })).status).toBe(400);
    expect((await req('POST', '/permissions/allowances', { kind: 'task', target: 't1', actions: [] })).status).toBe(400);
  });
});

describe('per-item overrides (P-5)', () => {
  it('put/get/list/delete round-trips, and purchase-allow is refused', async () => {
    const put = await req('PUT', '/permissions/items/task/task-9', { actions: { send: 'allow', delete: 'deny' }, note: 'weekly report' });
    expect(put.status).toBe(200);
    expect(put.json.item.key).toBe('task:task-9');

    const got = await req('GET', '/permissions/items/task/task-9');
    expect(got.json.item.actions).toEqual({ send: 'allow', delete: 'deny' });
    expect((await req('GET', '/permissions/items')).json.items).toHaveLength(1);

    expect((await req('PUT', '/permissions/items/task/task-9', { actions: { purchase: 'allow' } })).status).toBe(400);

    expect((await req('DELETE', '/permissions/items/task/task-9')).status).toBe(200);
    expect((await req('GET', '/permissions/items/task/task-9')).status).toBe(404);
  });
});

describe('connectors (P-4 + CN-10 toggle)', () => {
  it('lists first-party channels with action groups and a background-sync row', async () => {
    const { status, json } = await req('GET', '/permissions/connectors?botId=bot-1');
    expect(status).toBe(200);
    const channels = json.connectors.filter((c: any) => c.kind === 'channel');
    expect(channels.length).toBeGreaterThan(0);
    const first = channels[0];
    expect(first.groups.map((g: any) => g.id)).toContain('send');
    expect(first.backgroundSync).toEqual(expect.objectContaining({ enabled: false }));
  });

  it('persists group effects and the background-sync toggle', async () => {
    const { json: before } = await req('GET', '/permissions/connectors?botId=bot-1');
    const channelId = before.connectors.find((c: any) => c.kind === 'channel').id;
    const put = await req('PUT', `/permissions/connectors/${channelId}`, {
      botId: 'bot-1',
      groups: { send: 'deny' },
      backgroundSync: true,
    });
    expect(put.status).toBe(200);
    const { json } = await req('GET', '/permissions/connectors?botId=bot-1');
    const after = json.connectors.find((c: any) => c.id === channelId);
    expect(after.groups.find((g: any) => g.id === 'send').effect).toBe('deny');
    expect(after.backgroundSync.enabled).toBe(true);

    expect((await req('PUT', `/permissions/connectors/${channelId}`, { botId: 'bot-1', groups: { bogus: 'allow' } })).status).toBe(400);
    expect((await req('GET', '/permissions/connectors?botId=ghost')).status).toBe(404);
  });
});

describe('protocols (P-7)', () => {
  it('exposes read-only rows mapped to existing enforcement, and PUT is refused', async () => {
    const { status, json } = await req('GET', '/permissions/protocols');
    expect(status).toBe(200);
    const ids = json.protocols.map((p: any) => p.id);
    for (const id of ['ssh', 'mail', 'database', 'ftp', 'dns', 'http', 'https']) expect(ids).toContain(id);
    for (const p of json.protocols) {
      expect(p.writable).toBe(false);
      expect(p.policyKey.length).toBeGreaterThan(0);
    }
    const ftp = json.protocols.find((p: any) => p.id === 'ftp');
    expect(ftp.defaultEffect).toBe('deny');
    expect(ftp.enforcement).toBe('sandbox');
    expect((await req('PUT', '/permissions/protocols/ftp', { effect: 'allow' })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Allowance evaluation
// ---------------------------------------------------------------------------

const CTX: ToolContext = { sessionId: 'sess-1', botId: 'bot-1' } as ToolContext;

function allowance(partial: Partial<Allowance>): Allowance {
  return {
    id: 'a-1',
    kind: 'recipient',
    target: 'friend@example.com',
    actions: ['send'],
    scope: {},
    createdAt: 1_000,
    ...partial,
  };
}

describe('findAllowanceForCall', () => {
  it('matches an exact recipient send allowance (incl. via a composio slug)', () => {
    const call: ToolCall = { name: 'composio_call', args: { toolSlug: 'GMAIL_SEND_EMAIL', args: { to: 'friend@example.com' } } };
    expect(findAllowanceForCall([allowance({})], call, CTX, 2_000)?.id).toBe('a-1');
  });

  it('does not match a different recipient, action, bot scope, or after expiry', () => {
    const call: ToolCall = { name: 'phone_send_message', args: { contact: 'friend@example.com', text: 'hi' } };
    expect(findAllowanceForCall([allowance({ target: 'other@example.com' })], call, CTX, 2_000)).toBeUndefined();
    expect(findAllowanceForCall([allowance({ actions: ['web_fetch'] })], call, CTX, 2_000)).toBeUndefined();
    expect(findAllowanceForCall([allowance({ scope: { botId: 'bot-2' } })], call, CTX, 2_000)).toBeUndefined();
    expect(findAllowanceForCall([allowance({ expiresAt: 1_500 })], call, CTX, 2_000)).toBeUndefined();
    expect(findAllowanceForCall([allowance({})], call, CTX, 2_000)?.id).toBe('a-1');
  });

  it('never matches privileged tools, hard-floor sends, or denylist commands', () => {
    const purchase: ToolCall = { name: 'request_purchase', args: { to: 'friend@example.com' } };
    expect(findAllowanceForCall([allowance({ actions: ['request_purchase'] })], purchase, CTX, 2_000)).toBeUndefined();
    // send_email to an external recipient hits the external-send hard floor.
    // (A non-example.com address: the floor itself exempts test addresses.)
    const floored: ToolCall = { name: 'send_email', args: { to: 'friend@realmail.org' } };
    expect(findAllowanceForCall([allowance({ target: 'friend@realmail.org' })], floored, CTX, 2_000)).toBeUndefined();
    const shell: ToolCall = { name: 'run_command', args: { command: 'rm -rf /', to: 'friend@example.com' } };
    expect(findAllowanceForCall([allowance({ actions: ['run_command'] })], shell, CTX, 2_000)).toBeUndefined();
  });

  it('matches website allowances by extracted host', () => {
    const call: ToolCall = { name: 'web_fetch', args: { url: 'https://docs.example.com/guide' } };
    const site = allowance({ kind: 'website', target: 'example.com', actions: ['web_fetch'] });
    expect(findAllowanceForCall([site], call, CTX, 2_000)?.id).toBe('a-1');
    const other = allowance({ kind: 'website', target: 'other.com', actions: ['web_fetch'] });
    expect(findAllowanceForCall([other], call, CTX, 2_000)).toBeUndefined();
  });
});

describe('GovernanceAdapter allowance seam', () => {
  function makeAdapter(bots: BotConfig[]) {
    const real = new GovernanceGateway({ dbPath: ':memory:', policy: DEFAULT_POLICY });
    const byId = new Map(bots.map((b) => [b.id, b]));
    const adapter = new GovernanceAdapter(real, {
      getBotConfig: (id) => byId.get(id),
      globalPolicy: DEFAULT_POLICY,
      getAllowance: createAllowanceLookup({ dataDir: dir, bots }),
    });
    return { real, adapter };
  }

  it('converts Ask → Allow for an exact allowance, and only there', async () => {
    createAllowance(dir, 'default-user', { kind: 'recipient', target: 'friend@example.com', actions: ['send'], scope: {} });
    const bots = [{ id: 'bot-1', name: 'Helper', tools: [] }] as unknown as BotConfig[];
    const { adapter } = makeAdapter(bots);
    const allowed = await adapter.evaluate(
      { name: 'composio_call', args: { toolSlug: 'GMAIL_SEND_EMAIL', args: { to: 'friend@example.com' } } },
      CTX,
    );
    expect(allowed.decision).toBe('allow');
    const other = await adapter.evaluate(
      { name: 'composio_call', args: { toolSlug: 'GMAIL_SEND_EMAIL', args: { to: 'stranger@example.com' } } },
      CTX,
    );
    expect(other.decision).toBe('require-approval');
    expect(listAllowances(dir, 'default-user')).toHaveLength(1);
  });

  it('never widens a bot-policy deny', async () => {
    createAllowance(dir, 'default-user', { kind: 'recipient', target: 'friend@example.com', actions: ['send'], scope: {} });
    const bots = [
      {
        id: 'bot-1',
        name: 'Helper',
        tools: [],
        policy: { rules: [{ id: 'deny-composio', toolPattern: '^composio_call$', effect: 'deny', reason: 'locked' }] },
      },
    ] as unknown as BotConfig[];
    const { adapter } = makeAdapter(bots);
    const res = await adapter.evaluate(
      { name: 'composio_call', args: { toolSlug: 'GMAIL_SEND_EMAIL', args: { to: 'friend@example.com' } } },
      CTX,
    );
    expect(res.decision).toBe('deny');
  });
});
