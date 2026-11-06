// SPDX-License-Identifier: Apache-2.0
// Managed Apps tests: a mock ComposioClient (zero paid API calls) and a
// generated Ed25519 keypair drive the real HTTP server on an ephemeral
// port. Coverage: auth failures, entity derivation + spoofed-id ignoring,
// per-customer isolation, entitlement, quotas + global cap, count-only
// metering (no argument content on disk), usage/operator usage, labels,
// and the operator-key fail-closed path.

import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { deriveEntityId, signServiceToken, type ServiceTokenPayload } from '../src/auth.js';
import type {
  ComposioApp,
  ComposioClient,
  ComposioConnectedAccount,
  ComposioExecuteResult,
  ComposioToolDefinition,
} from '../src/composio.js';
import { createManagedApps, type ManagedApps, type ManagedAppsConfig } from '../src/server.js';

// ---------------------------------------------------------------------------
// Keypair fixtures + token minting
// ---------------------------------------------------------------------------

const keypair = generateKeyPairSync('ed25519');
const PRIVATE_PEM = keypair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUBLIC_PEM = keypair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const otherKeypair = generateKeyPairSync('ed25519');
const OTHER_PRIVATE_PEM = otherKeypair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function mint(
  overrides: Partial<ServiceTokenPayload> = {},
  privatePem: string = PRIVATE_PEM,
): string {
  const iat = Math.floor(Date.now() / 1000);
  const payload: ServiceTokenPayload = {
    v: 1,
    iss: 'kriyadot-frontdoor',
    accountId: 'acct-a',
    email: 'a@example.com',
    plan: 'pro',
    iat,
    exp: iat + 3600,
    ...overrides,
  };
  return signServiceToken(payload, privatePem);
}

const tokenA = () => mint({ accountId: 'acct-a', email: 'a@example.com', plan: 'pro' });
const tokenB = () => mint({ accountId: 'acct-b', email: 'b@example.com', plan: 'pro' });
const ENTITY_A = deriveEntityId('acct-a');
const ENTITY_B = deriveEntityId('acct-b');

// ---------------------------------------------------------------------------
// Mock Composio client
// ---------------------------------------------------------------------------

interface ExecuteCall {
  toolSlug: string;
  connectedAccountId: string;
  userId: string;
  args: Record<string, unknown>;
}

class MockComposio implements ComposioClient {
  accountsByEntity = new Map<string, ComposioConnectedAccount[]>();
  executeCalls: ExecuteCall[] = [];
  deletedIds: string[] = [];
  revokedIds: string[] = [];
  executeBehavior: 'ok' | 'fail-result' | 'throw' = 'ok';
  private seq = 0;

  seed(entityId: string, account: ComposioConnectedAccount): void {
    const list = this.accountsByEntity.get(entityId) ?? [];
    list.push(account);
    this.accountsByEntity.set(entityId, list);
  }

  async validateApiKey(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
  async listApps(): Promise<ComposioApp[]> {
    return [
      { appId: 'gmail', name: 'Gmail' },
      { appId: 'slack', name: 'Slack' },
    ];
  }
  async createAuthLink(
    _apiKey: string,
    opts: { toolkitSlug: string; userId: string; label?: string },
  ): Promise<{ redirectUrl: string }> {
    return { redirectUrl: `https://connect.example.com/${opts.toolkitSlug}?u=${opts.userId}` };
  }
  async listConnectedAccounts(_apiKey: string, userId: string): Promise<ComposioConnectedAccount[]> {
    return [...(this.accountsByEntity.get(userId) ?? [])];
  }
  async getConnectedAccount(_apiKey: string, nanoid: string): Promise<ComposioConnectedAccount | null> {
    for (const list of this.accountsByEntity.values()) {
      const found = list.find((a) => a.id === nanoid);
      if (found) return found;
    }
    return null;
  }
  async deleteConnectedAccount(_apiKey: string, nanoid: string): Promise<void> {
    this.deletedIds.push(nanoid);
    for (const [entity, list] of this.accountsByEntity) {
      this.accountsByEntity.set(entity, list.filter((a) => a.id !== nanoid));
    }
  }
  async revokeConnectedAccount(_apiKey: string, nanoid: string): Promise<void> {
    this.revokedIds.push(nanoid);
  }
  async listTools(_apiKey: string, toolkitSlug?: string): Promise<ComposioToolDefinition[]> {
    const slug = toolkitSlug === 'gmail' ? 'GMAIL_SEND_EMAIL' : 'SLACK_SEND_MESSAGE';
    return [{ slug, name: slug, inputParameters: { type: 'object', properties: {} } }];
  }
  async executeTool(
    _apiKey: string,
    input: { toolSlug: string; connectedAccountId: string; userId: string; args: Record<string, unknown> },
  ): Promise<ComposioExecuteResult> {
    this.executeCalls.push({ ...input });
    if (this.executeBehavior === 'throw') throw new Error('composio exploded');
    if (this.executeBehavior === 'fail-result') return { successful: false, error: 'provider said no' };
    this.seq += 1;
    return { successful: true, data: { messageId: `m-${this.seq}` } };
  }
}

// ---------------------------------------------------------------------------
// Server harness
// ---------------------------------------------------------------------------

const closers: Array<() => Promise<void>> = [];

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  return `http://127.0.0.1:${addr.port}`;
}

interface Started {
  app: ManagedApps;
  base: string;
  mock: MockComposio;
  dataDir: string;
}

async function start(overrides: Partial<ManagedAppsConfig> = {}, mock = new MockComposio()): Promise<Started> {
  const dataDir = mkdtempSync(join(tmpdir(), 'managed-apps-'));
  const app = createManagedApps({
    dataDir,
    frontdoorPublicKeyPem: PUBLIC_PEM,
    operatorKey: 'operator-composio-key',
    operatorToken: 'operator-secret',
    composioClient: mock,
    log: () => undefined,
    ...overrides,
  });
  const base = await listen(app.server);
  return { app, base, mock, dataDir };
}

function authed(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra };
}

async function execute(
  base: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/v1/execute`, {
    method: 'POST',
    headers: authed(token),
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json() as any) as Record<string, unknown> };
}

const GMAIL_A: ComposioConnectedAccount = {
  id: 'ca_gmail_a',
  toolkitSlug: 'gmail',
  toolkitName: 'Gmail',
  status: 'ACTIVE',
  createdAt: '2026-11-01T00:00:00.000Z',
};
const GMAIL_B: ComposioConnectedAccount = {
  id: 'ca_gmail_b',
  toolkitSlug: 'gmail',
  toolkitName: 'Gmail',
  status: 'ACTIVE',
  createdAt: '2026-11-01T00:00:00.000Z',
};

// ---------------------------------------------------------------------------

describe('managed-apps service', () => {
  afterAll(async () => {
    for (const close of closers.splice(0)) await close();
  });

  it('serves /health without auth', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json() as any).toEqual({ ok: true });
  });

  it('rejects missing, malformed, wrong-key, wrong-issuer, account-less, and expired tokens with 401', async () => {
    const { base } = await start();

    const missing = await fetch(`${base}/v1/apps`);
    expect(missing.status).toBe(401);

    const garbage = await fetch(`${base}/v1/apps`, { headers: { authorization: 'Bearer not-a-token' } });
    expect(garbage.status).toBe(401);
    expect((await garbage.json() as any).code).toBe('unauthorized');

    const wrongKey = await fetch(`${base}/v1/apps`, { headers: authed(mint({}, OTHER_PRIVATE_PEM)) });
    expect(wrongKey.status).toBe(401);

    const wrongIss = await fetch(`${base}/v1/apps`, { headers: authed(mint({ iss: 'someone-else' })) });
    expect(wrongIss.status).toBe(401);

    const noAccount = await fetch(`${base}/v1/apps`, { headers: authed(mint({ accountId: '' })) });
    expect(noAccount.status).toBe(401);

    const nowSec = Math.floor(Date.now() / 1000);
    const expired = await fetch(`${base}/v1/apps`, {
      headers: authed(mint({ iat: nowSec - 7200, exp: nowSec - 3600 })),
    });
    expect(expired.status).toBe(401);
  });

  it('derives the entity id server-side as kd_ + sha256(accountId)[:24]', () => {
    const expected = 'kd_' + createHash('sha256').update('acct-a').digest('hex').slice(0, 24);
    expect(ENTITY_A).toBe(expected);
    expect(ENTITY_A).toHaveLength(27);
    expect(ENTITY_A).not.toBe(ENTITY_B);
  });

  it('lists apps and tools through the operator key', async () => {
    const { base } = await start();
    const apps = await (await fetch(`${base}/v1/apps`, { headers: authed(tokenA()) })).json() as any;
    expect(apps.apps.map((a: ComposioApp) => a.appId)).toEqual(['gmail', 'slack']);

    const tools = await (await fetch(`${base}/v1/tools?toolkitSlug=gmail`, { headers: authed(tokenA()) })).json() as any;
    expect(tools.tools).toHaveLength(1);
    expect(tools.tools[0].slug).toBe('GMAIL_SEND_EMAIL');
  });

  it('returns 403 not_entitled for plans/features without managed access', async () => {
    const { base } = await start();
    const free = mint({ accountId: 'acct-free', plan: 'free' });
    const res = await fetch(`${base}/v1/apps`, { headers: authed(free) });
    expect(res.status).toBe(403);
    expect(await res.json() as any).toEqual({ code: 'not_entitled' });

    const unknownPlan = mint({ accountId: 'acct-x', plan: 'enterprise-ish' });
    const res2 = await fetch(`${base}/v1/usage`, { headers: authed(unknownPlan) });
    expect(res2.status).toBe(403);

    // The managed-apps feature flag entitles even an unlisted plan.
    const featured = mint({ accountId: 'acct-f', plan: 'free', features: ['managed-apps'] });
    const res3 = await fetch(`${base}/v1/apps`, { headers: authed(featured) });
    expect(res3.status).toBe(200);
  });

  it('fails closed with 503 operator_key_missing when the operator key is absent', async () => {
    const { base } = await start({ operatorKey: undefined, composioClient: undefined });
    const res = await fetch(`${base}/v1/apps`, { headers: authed(tokenA()) });
    expect(res.status).toBe(503);
    expect(await res.json() as any).toEqual({ code: 'operator_key_missing' });
    // Usage is service-local and still answers.
    const usage = await fetch(`${base}/v1/usage`, { headers: authed(tokenA()) });
    expect(usage.status).toBe(200);
  });

  it('connect-link returns a redirect URL and the pending label lands on the new account', async () => {
    const { base, mock } = await start();
    const res = await fetch(`${base}/v1/connect-link`, {
      method: 'POST',
      headers: authed(tokenA()),
      body: JSON.stringify({ toolkitSlug: 'gmail', label: 'Work Gmail' }),
    });
    expect(res.status).toBe(200);
    const { redirectUrl } = await res.json() as any;
    expect(redirectUrl).toContain('gmail');
    expect(redirectUrl).toContain(ENTITY_A);

    // The account appears after the user completes the provider flow.
    mock.seed(ENTITY_A, { ...GMAIL_A });
    const accounts = await (await fetch(`${base}/v1/accounts`, { headers: authed(tokenA()) })).json() as any;
    expect(accounts.accounts).toHaveLength(1);
    expect(accounts.accounts[0].label).toBe('Work Gmail');
  });

  it('isolates customers: B sees only its own accounts and gets 404 on A\'s account for execute, label, and delete', async () => {
    const { base, mock } = await start();
    mock.seed(ENTITY_A, { ...GMAIL_A });
    mock.seed(ENTITY_B, { ...GMAIL_B });

    const listB = await (await fetch(`${base}/v1/accounts`, { headers: authed(tokenB()) })).json() as any;
    expect(listB.accounts.map((a: ComposioConnectedAccount) => a.id)).toEqual(['ca_gmail_b']);

    // Execute on A's account by guessed id → 404, and Composio is never called.
    const exec = await execute(base, tokenB(), { accountId: 'ca_gmail_a', actionName: 'GMAIL_SEND_EMAIL', arguments: {} });
    expect(exec.status).toBe(404);
    expect(mock.executeCalls).toHaveLength(0);

    // Label A's account → 404.
    const label = await fetch(`${base}/v1/accounts/ca_gmail_a/label`, {
      method: 'POST',
      headers: authed(tokenB()),
      body: JSON.stringify({ label: 'hijacked' }),
    });
    expect(label.status).toBe(404);

    // Delete A's account → 404, and no revoke/delete reaches Composio.
    const del = await fetch(`${base}/v1/accounts/ca_gmail_a`, { method: 'DELETE', headers: authed(tokenB()) });
    expect(del.status).toBe(404);
    expect(mock.deletedIds).not.toContain('ca_gmail_a');
    expect(mock.revokedIds).not.toContain('ca_gmail_a');

    // A's account is untouched and unlabeled.
    const listA = await (await fetch(`${base}/v1/accounts`, { headers: authed(tokenA()) })).json() as any;
    expect(listA.accounts).toHaveLength(1);
    expect(listA.accounts[0].label).toBeUndefined();
  });

  it('ignores spoofed userId/entity fields: execution runs as the caller\'s derived entity', async () => {
    const { base, mock } = await start();
    mock.seed(ENTITY_A, { ...GMAIL_A });
    mock.seed(ENTITY_B, { ...GMAIL_B });

    const res = await execute(base, tokenA(), {
      toolkitSlug: 'gmail',
      actionName: 'GMAIL_SEND_EMAIL',
      arguments: { to: 'x@example.com' },
      userId: ENTITY_B,
      entity: ENTITY_B,
      user_id: ENTITY_B,
    });
    expect(res.status).toBe(200);
    expect(res.json.successful).toBe(true);
    expect(mock.executeCalls).toHaveLength(1);
    expect(mock.executeCalls[0]!.userId).toBe(ENTITY_A);
    expect(mock.executeCalls[0]!.connectedAccountId).toBe('ca_gmail_a');
  });

  it('resolves the ACTIVE account for a toolkit and executes by explicit accountId', async () => {
    const { base, mock } = await start();
    mock.seed(ENTITY_A, { ...GMAIL_A, status: 'INACTIVE', id: 'ca_old' });
    mock.seed(ENTITY_A, { ...GMAIL_A });

    const byToolkit = await execute(base, tokenA(), { toolkitSlug: 'gmail', actionName: 'GMAIL_SEND_EMAIL' });
    expect(byToolkit.status).toBe(200);
    expect(mock.executeCalls[0]!.connectedAccountId).toBe('ca_gmail_a');

    const byId = await execute(base, tokenA(), { accountId: 'ca_old', actionName: 'GMAIL_SEND_EMAIL' });
    expect(byId.status).toBe(200);
    expect(mock.executeCalls[1]!.connectedAccountId).toBe('ca_old');

    const noAccount = await execute(base, tokenA(), { toolkitSlug: 'slack', actionName: 'SLACK_SEND_MESSAGE' });
    expect(noAccount.status).toBe(404);
  });

  it('enforces the per-plan quota with 429 quota_exceeded and does not call Composio past it', async () => {
    const { base, mock } = await start({ quotas: { pro: 2 } });
    mock.seed(ENTITY_A, { ...GMAIL_A });

    expect((await execute(base, tokenA(), { toolkitSlug: 'gmail', actionName: 'GMAIL_SEND_EMAIL' })).status).toBe(200);
    expect((await execute(base, tokenA(), { toolkitSlug: 'gmail', actionName: 'GMAIL_SEND_EMAIL' })).status).toBe(200);
    const third = await execute(base, tokenA(), { toolkitSlug: 'gmail', actionName: 'GMAIL_SEND_EMAIL' });
    expect(third.status).toBe(429);
    expect(third.json).toEqual({ code: 'quota_exceeded', plan: 'pro', used: 2, quota: 2 });
    expect(mock.executeCalls).toHaveLength(2);
  });

  it('enforces the global monthly cap with 429 operator_cap_reached', async () => {
    const { base, mock } = await start({ quotas: { pro: 100 }, globalCap: 1 });
    mock.seed(ENTITY_A, { ...GMAIL_A });
    mock.seed(ENTITY_B, { ...GMAIL_B });

    expect((await execute(base, tokenA(), { toolkitSlug: 'gmail', actionName: 'GMAIL_SEND_EMAIL' })).status).toBe(200);
    const blocked = await execute(base, tokenB(), { toolkitSlug: 'gmail', actionName: 'GMAIL_SEND_EMAIL' });
    expect(blocked.status).toBe(429);
    expect(blocked.json).toEqual({ code: 'operator_cap_reached' });
    expect(mock.executeCalls).toHaveLength(1);

    const usageB = await (await fetch(`${base}/v1/usage`, { headers: authed(tokenB()) })).json() as any;
    expect(usageB.globalCapReached).toBe(true);
  });

  it('meters every attempt — success, failed result, and upstream throw — count-only, never storing arguments', async () => {
    const { base, mock, dataDir, app } = await start({ quotas: { pro: 100 } });
    mock.seed(ENTITY_A, { ...GMAIL_A });
    const SECRET = 'SECRET_ARGUMENT_VALUE_9f3c';

    const okRes = await execute(base, tokenA(), {
      toolkitSlug: 'gmail',
      actionName: 'GMAIL_SEND_EMAIL',
      arguments: { body: SECRET },
      kind: 'routine',
    });
    expect(okRes.status).toBe(200);

    mock.executeBehavior = 'fail-result';
    const failRes = await execute(base, tokenA(), {
      toolkitSlug: 'gmail',
      actionName: 'GMAIL_SEND_EMAIL',
      arguments: { body: SECRET },
      kind: 'bogus-kind',
    });
    expect(failRes.status).toBe(200);
    expect(failRes.json.successful).toBe(false);

    mock.executeBehavior = 'throw';
    const throwRes = await execute(base, tokenA(), {
      toolkitSlug: 'gmail',
      actionName: 'GMAIL_SEND_EMAIL',
      arguments: { body: SECRET },
    });
    expect(throwRes.status).toBe(502);

    const lines = readFileSync(join(dataDir, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines.map((l: { ok: boolean }) => l.ok)).toEqual([true, false, false]);
    expect(lines[0].kind).toBe('routine');
    expect(lines[1].kind).toBe('chat'); // invalid kind normalized
    expect(lines[2].kind).toBe('chat'); // default
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual(['accountId', 'action', 'kind', 'ok', 'toolkit', 'ts']);
      expect(line.accountId).toBe('acct-a');
      expect(line.toolkit).toBe('gmail');
      expect(line.action).toBe('GMAIL_SEND_EMAIL');
    }

    // The secret argument appears NOWHERE on disk (metering or the store).
    expect(readFileSync(join(dataDir, 'usage.jsonl'), 'utf8')).not.toContain(SECRET);
    if (existsSync(app.store.storeFilePath)) {
      expect(readFileSync(app.store.storeFilePath, 'utf8')).not.toContain(SECRET);
    }
  });

  it('reports per-customer usage and operator usage counts', async () => {
    const { base, mock } = await start({ quotas: { pro: 100 } });
    mock.seed(ENTITY_A, { ...GMAIL_A });
    mock.seed(ENTITY_B, { ...GMAIL_B, toolkitSlug: 'slack', toolkitName: 'Slack', id: 'ca_slack_b' });

    await execute(base, tokenA(), { toolkitSlug: 'gmail', actionName: 'GMAIL_SEND_EMAIL' });
    await execute(base, tokenA(), { toolkitSlug: 'gmail', actionName: 'GMAIL_SEND_EMAIL' });
    await execute(base, tokenB(), { toolkitSlug: 'slack', actionName: 'SLACK_SEND_MESSAGE' });

    const month = new Date().toISOString().slice(0, 7);
    const usage = await (await fetch(`${base}/v1/usage`, { headers: authed(tokenA()) })).json() as any;
    expect(usage).toEqual({ plan: 'pro', used: 2, quota: 100, month, globalCapReached: false });

    // Operator endpoint: wrong/absent token → 401; right token → aggregates.
    const anon = await fetch(`${base}/v1/operator/usage`);
    expect(anon.status).toBe(401);
    const wrong = await fetch(`${base}/v1/operator/usage`, { headers: authed(tokenA()) });
    expect(wrong.status).toBe(401);

    const op = await (await fetch(`${base}/v1/operator/usage`, {
      headers: { authorization: 'Bearer operator-secret' },
    })).json() as any;
    expect(op.month).toBe(month);
    expect(op.totalUsed).toBe(3);
    expect(op.globalCap).toBe(100000);
    expect(op.customers).toEqual([
      { accountId: 'acct-a', used: 2, byToolkit: { gmail: 2 } },
      { accountId: 'acct-b', used: 1, byToolkit: { slack: 1 } },
    ]);
    // Counts only: no action names, no arguments.
    expect(JSON.stringify(op)).not.toContain('GMAIL_SEND_EMAIL');
  });

  it('labels persist service-side for the owner\'s account and survive a restart', async () => {
    const { base, mock, dataDir } = await start();
    mock.seed(ENTITY_A, { ...GMAIL_A });

    const labelRes = await fetch(`${base}/v1/accounts/ca_gmail_a/label`, {
      method: 'POST',
      headers: authed(tokenA()),
      body: JSON.stringify({ label: 'Personal Gmail' }),
    });
    expect(labelRes.status).toBe(200);
    expect(await labelRes.json() as any).toEqual({ ok: true, id: 'ca_gmail_a', label: 'Personal Gmail' });

    const listed = await (await fetch(`${base}/v1/accounts`, { headers: authed(tokenA()) })).json() as any;
    expect(listed.accounts[0].label).toBe('Personal Gmail');

    // A fresh service instance over the same data dir sees the same label.
    const restarted = createManagedApps({
      dataDir,
      frontdoorPublicKeyPem: PUBLIC_PEM,
      operatorKey: 'operator-composio-key',
      operatorToken: 'operator-secret',
      composioClient: mock,
      log: () => undefined,
    });
    const base2 = await listen(restarted.server);
    const listed2 = await (await fetch(`${base2}/v1/accounts`, { headers: authed(tokenA()) })).json() as any;
    expect(listed2.accounts[0].label).toBe('Personal Gmail');
  });

  it('deletes the owner\'s account via revoke + delete and drops its label', async () => {
    const { base, mock } = await start();
    mock.seed(ENTITY_A, { ...GMAIL_A });
    await fetch(`${base}/v1/accounts/ca_gmail_a/label`, {
      method: 'POST',
      headers: authed(tokenA()),
      body: JSON.stringify({ label: 'Mine' }),
    });

    const res = await fetch(`${base}/v1/accounts/ca_gmail_a`, { method: 'DELETE', headers: authed(tokenA()) });
    expect(res.status).toBe(200);
    expect(await res.json() as any).toEqual({ ok: true });
    expect(mock.revokedIds).toContain('ca_gmail_a');
    expect(mock.deletedIds).toContain('ca_gmail_a');

    const listed = await (await fetch(`${base}/v1/accounts`, { headers: authed(tokenA()) })).json() as any;
    expect(listed.accounts).toHaveLength(0);
  });
});
