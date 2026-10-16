// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPOSIO_CALL_TOOL,
  COMPOSIO_LIST_ACTIONS_TOOL,
  composioToolPolicies,
  createComposioCallTool,
  createComposioListActionsTool,
  registerComposioTools,
} from '../src/composio-tools.js';
import type { ComposioClient, ComposioConnectedAccount } from '../src/composio.js';
import type { ToolContext } from '@mvp/agent-runtime';

// Zero paid API usage: all Composio HTTP goes through this mock.
function makeMockClient() {
  const state = {
    accounts: [
      { id: 'ca_gmail1', toolkitSlug: 'gmail', toolkitName: 'Gmail', status: 'ACTIVE' },
      { id: 'ca_gmail2', toolkitSlug: 'gmail', toolkitName: 'Gmail', status: 'EXPIRED' },
      { id: 'ca_slack1', toolkitSlug: 'slack', toolkitName: 'Slack', status: 'ACTIVE' },
    ] as ComposioConnectedAccount[],
    executed: [] as Array<{ toolSlug: string; connectedAccountId: string; userId: string; args: Record<string, unknown> }>,
  };
  const client: ComposioClient = {
    validateApiKey: async () => ({ ok: true }),
    listApps: async () => [],
    createAuthLink: async () => ({ redirectUrl: 'https://example/link' }),
    listConnectedAccounts: async () => state.accounts.map((a) => ({ ...a })),
    getConnectedAccount: async (_k, id) => state.accounts.find((a) => a.id === id) ?? null,
    deleteConnectedAccount: async () => {},
    revokeConnectedAccount: async () => {},
    listTools: async (_k, slug) =>
      slug === 'gmail'
        ? [
            {
              slug: 'GMAIL_SEND_EMAIL',
              name: 'Send email',
              description: 'Send an email via Gmail',
              inputParameters: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] },
            },
            {
              slug: 'GMAIL_LIST_MESSAGES',
              name: 'List messages',
              description: 'List Gmail messages',
              inputParameters: { type: 'object', properties: {} },
            },
          ]
        : [],
    executeTool: async (_k, input) => {
      state.executed.push({ ...input });
      if (input.toolSlug === 'GMAIL_FAILS') return { successful: false, error: 'provider exploded' };
      if (input.toolSlug === 'GMAIL_BIG') {
        return { successful: true, data: { blob: 'x'.repeat(20000) } };
      }
      return { successful: true, data: { sent: true, args: input.args } };
    },
  };
  return { client, state };
}

const CTX_BOT1: ToolContext = { sessionId: 's1', botId: 'bot-1' };
const CTX_BOT2: ToolContext = { sessionId: 's2', botId: 'bot-2' };

describe('composio tool policies', () => {
  it('auto-allows discovery, approval-gates execution', () => {
    const rules = composioToolPolicies();
    const list = rules.find((r) => r.toolPattern === '^composio_list_actions$');
    const call = rules.find((r) => r.toolPattern === '^composio_call$');
    expect(list?.effect).toBe('allow');
    expect(call?.effect).toBe('require-approval');
  });
});

describe('registerComposioTools', () => {
  it('registers both tools and rejects collisions', () => {
    const registry = new Map();
    const opts = { dataDir: '/tmp', getApiKey: () => undefined };
    registerComposioTools(registry, opts);
    expect(registry.has(COMPOSIO_CALL_TOOL)).toBe(true);
    expect(registry.has(COMPOSIO_LIST_ACTIONS_TOOL)).toBe(true);
    expect(() => registerComposioTools(registry, opts)).toThrow(/collision/);
  });

  it('marks composio_call as mutating (plan-mode gate)', () => {
    const registry = new Map();
    registerComposioTools(registry, { dataDir: '/tmp', getApiKey: () => undefined });
    expect(registry.get(COMPOSIO_CALL_TOOL).mutating).toBe(true);
    expect(registry.get(COMPOSIO_LIST_ACTIONS_TOOL).mutating).toBeFalsy();
  });
});

describe('composio_call handler', () => {
  let dir: string;
  let mock: ReturnType<typeof makeMockClient>;
  const audit = vi.fn();

  function makeTool(key: string | undefined) {
    return createComposioCallTool({
      dataDir: dir,
      getApiKey: () => key,
      client: mock.client,
      audit,
    });
  }

  function enable(botId: string, appId: string) {
    writeFileSync(join(dir, 'composio-enables.json'), JSON.stringify({ [botId]: { [appId]: true } }));
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'composio-tools-'));
    mock = makeMockClient();
    audit.mockClear();
  });

  it('refuses when Composio is not connected', async () => {
    const tool = makeTool(undefined);
    await expect(tool.handler({ accountId: 'ca_gmail1', actionName: 'GMAIL_SEND_EMAIL', parameters: {} }, CTX_BOT1)).rejects.toThrow(
      /not connected/i,
    );
  });

  it('validates arguments', async () => {
    const tool = makeTool('k');
    await expect(tool.handler({ accountId: 'bad!!', actionName: 'GMAIL_SEND_EMAIL', parameters: {} }, CTX_BOT1)).rejects.toThrow(
      /accountId/,
    );
    await expect(tool.handler({ accountId: 'ca_gmail1', actionName: 'evil;rm', parameters: {} }, CTX_BOT1)).rejects.toThrow(
      /actionName/,
    );
    await expect(tool.handler({ accountId: 'ca_gmail1', actionName: 'GMAIL_SEND_EMAIL' }, CTX_BOT1)).rejects.toThrow(
      /parameters/,
    );
    await expect(
      tool.handler({ accountId: 'ca_gmail1', actionName: 'GMAIL_SEND_EMAIL', parameters: { big: 'x'.repeat(70000) } }, CTX_BOT1),
    ).rejects.toThrow(/cap/i);
  });

  it('refuses unknown accounts', async () => {
    const tool = makeTool('k');
    enable('bot-1', 'gmail');
    await expect(
      tool.handler({ accountId: 'ca_nope', actionName: 'GMAIL_SEND_EMAIL', parameters: {} }, CTX_BOT1),
    ).rejects.toThrow(/unknown Composio account/);
  });

  it('enforces per-bot enablement (bot-2 cannot use bot-1\u2019s app)', async () => {
    const tool = makeTool('k');
    enable('bot-1', 'gmail');
    // bot-1 works
    const ok = await tool.handler(
      { accountId: 'ca_gmail1', actionName: 'GMAIL_SEND_EMAIL', parameters: { to: 'a@b.c' } },
      CTX_BOT1,
    );
    expect((ok as { ok: boolean }).ok).toBe(true);
    // bot-2 is refused before any Composio call
    const before = mock.state.executed.length;
    await expect(
      tool.handler({ accountId: 'ca_gmail1', actionName: 'GMAIL_SEND_EMAIL', parameters: {} }, CTX_BOT2),
    ).rejects.toThrow(/not enabled for this bot/);
    expect(mock.state.executed.length).toBe(before);
  });

  it('executes and audits with redacted parameters', async () => {
    const tool = makeTool('k');
    enable('bot-1', 'gmail');
    const result = (await tool.handler(
      {
        accountId: 'ca_gmail1',
        actionName: 'GMAIL_SEND_EMAIL',
        parameters: { to: 'a@b.c', subject: 'hi', password: 's3cr3t' },
      },
      CTX_BOT1,
    )) as { ok: boolean; data: unknown };
    expect(result.ok).toBe(true);
    expect(mock.state.executed).toHaveLength(1);
    expect(mock.state.executed[0]).toMatchObject({
      toolSlug: 'GMAIL_SEND_EMAIL',
      connectedAccountId: 'ca_gmail1',
    });
    // Audit happened, parameters redacted, key never present.
    expect(audit).toHaveBeenCalledWith(
      'composio.tool_executed',
      expect.objectContaining({ toolName: COMPOSIO_CALL_TOOL }),
    );
    const detail = audit.mock.calls[0][1].detail as Record<string, unknown>;
    expect(detail.parameters).toMatchObject({ password: '[REDACTED]' });
    expect(JSON.stringify(audit.mock.calls)).not.toContain('s3cr3t');
  });

  it('surfaces Composio execution failures as errors', async () => {
    const tool = makeTool('k');
    enable('bot-1', 'gmail');
    await expect(
      tool.handler({ accountId: 'ca_gmail1', actionName: 'GMAIL_FAILS', parameters: {} }, CTX_BOT1),
    ).rejects.toThrow(/provider exploded/);
  });

  it('truncates oversized results for the model', async () => {
    const tool = makeTool('k');
    enable('bot-1', 'gmail');
    const result = (await tool.handler(
      { accountId: 'ca_gmail1', actionName: 'GMAIL_BIG', parameters: {} },
      CTX_BOT1,
    )) as { ok: boolean; truncated?: boolean; totalChars: number; dataPreview: string };
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.totalChars).toBeGreaterThan(8000);
    expect(result.dataPreview.length).toBeLessThanOrEqual(8000);
  });
});

describe('composio_list_actions handler', () => {
  let dir: string;
  let mock: ReturnType<typeof makeMockClient>;

  function makeTool(key: string | undefined) {
    return createComposioListActionsTool({ dataDir: dir, getApiKey: () => key, client: mock.client });
  }

  function enable(botId: string, apps: Record<string, boolean>) {
    writeFileSync(join(dir, 'composio-enables.json'), JSON.stringify({ [botId]: apps }));
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'composio-listactions-'));
    mock = makeMockClient();
  });

  it('reports disconnected gracefully', async () => {
    const tool = makeTool(undefined);
    const result = (await tool.handler({}, CTX_BOT1)) as { ok: boolean; connected: boolean; accounts: unknown[] };
    expect(result).toEqual({ ok: true, accounts: [], connected: false });
  });

  it('lists only ACTIVE accounts whose app is enabled for the bot', async () => {
    const tool = makeTool('k');
    enable('bot-1', { gmail: true });
    const result = (await tool.handler({}, CTX_BOT1)) as {
      accounts: Array<{ accountId: string; tools: Array<{ slug: string }> }>;
    };
    // ca_gmail2 is EXPIRED, ca_slack1's app is not enabled → only ca_gmail1.
    expect(result.accounts.map((a) => a.accountId)).toEqual(['ca_gmail1']);
    expect(result.accounts[0].tools.map((t) => t.slug)).toEqual(['GMAIL_SEND_EMAIL', 'GMAIL_LIST_MESSAGES']);
  });

  it('search filters actions', async () => {
    const tool = makeTool('k');
    enable('bot-1', { gmail: true });
    const result = (await tool.handler({ search: 'send' }, CTX_BOT1)) as {
      accounts: Array<{ tools: Array<{ slug: string }> }>;
    };
    expect(result.accounts[0].tools.map((t) => t.slug)).toEqual(['GMAIL_SEND_EMAIL']);
  });

  it('accountId filter rejects unavailable accounts', async () => {
    const tool = makeTool('k');
    enable('bot-1', { gmail: true });
    await expect(tool.handler({ accountId: 'ca_slack1' }, CTX_BOT1)).rejects.toThrow(/unavailable/);
    const ok = (await tool.handler({ accountId: 'ca_gmail1' }, CTX_BOT1)) as {
      accounts: Array<{ accountId: string }>;
    };
    expect(ok.accounts.map((a) => a.accountId)).toEqual(['ca_gmail1']);
  });
});
