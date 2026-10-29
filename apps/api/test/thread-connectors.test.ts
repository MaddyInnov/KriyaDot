// SPDX-License-Identifier: Apache-2.0
// Per-conversation connector selection (Octop #110): thread override
// storage + routes, and the Composio tools intersection (thread ∩ bot).

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { beforeEach, describe, expect, it } from 'vitest';
import { createChatThreadsRouter, ThreadTitleStore } from '../src/chat-threads-routes.js';
import { createComposioCallTool, createComposioListActionsTool } from '../src/composio-tools.js';
import type { ComposioClient } from '../src/composio.js';
import type { ToolContext } from '@mvp/agent-runtime';

async function request(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const http = await import('node:http');
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

let dataDir: string;
let titles: ThreadTitleStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'thread-connectors-'));
  titles = new ThreadTitleStore(dataDir);
});

describe('ThreadTitleStore connector overrides', () => {
  it('round-trips, normalizes and clears overrides', () => {
    expect(titles.getConnectorOverride('t1')).toBeUndefined();
    const saved = titles.setConnectorOverride('t1', ['Gmail', ' slack ', 'gmail', '']);
    expect(saved).toEqual(['gmail', 'slack']);
    expect(titles.getConnectorOverride('t1')).toEqual(['gmail', 'slack']);
    titles.clearConnectorOverride('t1');
    expect(titles.getConnectorOverride('t1')).toBeUndefined();
  });

  it('deleteThread drops the override too', () => {
    titles.setConnectorOverride('t2', ['gmail']);
    titles.deleteThread('t2');
    expect(titles.getConnectorOverride('t2')).toBeUndefined();
  });
});

describe('chat threads connector routes', () => {
  function makeApp(): express.Express {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/chat/threads',
      createChatThreadsRouter({
        dataDir,
        titles,
        listThreads: () => [],
        branchSession: () => ({ ok: false, reason: 'thread-not-found' }) as never,
        listThreadMessages: () => [],
        duplicateThread: () => undefined,
        deleteThread: () => false,
        audit: () => undefined,
      }),
    );
    return app;
  }

  it('GET/PUT/DELETE the override', async () => {
    const app = makeApp();
    const before = await request(app, 'GET', '/api/chat/threads/t9/connectors');
    expect(before.json.override).toBeNull();
    const put = await request(app, 'PUT', '/api/chat/threads/t9/connectors', { slugs: ['Gmail'] });
    expect(put.status).toBe(200);
    expect(put.json.override).toEqual(['gmail']);
    const after = await request(app, 'GET', '/api/chat/threads/t9/connectors');
    expect(after.json.override).toEqual(['gmail']);
    const del = await request(app, 'DELETE', '/api/chat/threads/t9/connectors');
    expect(del.json.override).toBeNull();
    expect(titles.getConnectorOverride('t9')).toBeUndefined();
  });

  it('rejects a non-array slugs body', async () => {
    const app = makeApp();
    const res = await request(app, 'PUT', '/api/chat/threads/t9/connectors', { slugs: 'gmail' });
    expect(res.status).toBe(400);
  });
});

describe('composio tools thread intersection', () => {
  const client: ComposioClient = {
    validateApiKey: async () => ({ ok: true }),
    listApps: async () => [],
    createAuthLink: async () => ({ redirectUrl: 'https://example/link' }),
    listConnectedAccounts: async () => [
      { id: 'ca_gmail', toolkitSlug: 'gmail', toolkitName: 'Gmail', status: 'ACTIVE' },
      { id: 'ca_slack', toolkitSlug: 'slack', toolkitName: 'Slack', status: 'ACTIVE' },
    ],
    getConnectedAccount: async (_k, id) =>
      [
        { id: 'ca_gmail', toolkitSlug: 'gmail', toolkitName: 'Gmail', status: 'ACTIVE' },
        { id: 'ca_slack', toolkitSlug: 'slack', toolkitName: 'Slack', status: 'ACTIVE' },
      ].find((a) => a.id === id) ?? null,
    deleteConnectedAccount: async () => {},
    revokeConnectedAccount: async () => {},
    listTools: async (_k, slug) => [
      { slug: `${slug.toUpperCase()}_DO`, name: 'Do', description: '', inputParameters: {} },
    ],
    executeTool: async () => ({ successful: true, data: { done: true } }),
  } as unknown as ComposioClient;

  function ctxFor(threadId: string): ToolContext {
    return { sessionId: threadId, botId: 'bot-1', conversationId: threadId } as ToolContext;
  }

  function setup(override?: string[]) {
    // Bot enablement: both gmail + slack enabled for bot-1.
    writeFileSync(
      join(dataDir, 'composio-enables.json'),
      JSON.stringify({ 'bot-1': { gmail: true, slack: true } }),
    );
    const opts = {
      dataDir,
      getApiKey: () => 'key-1',
      client,
      getThreadConnectorOverride: (id: string) => (id === 'thread-1' ? override : undefined),
    };
    return opts;
  }

  it('no override → bot behavior unchanged (both apps listed)', async () => {
    const tool = createComposioListActionsTool(setup(undefined));
    const out = (await tool.handler({}, ctxFor('thread-2'))) as { accounts: Array<{ toolkitSlug: string }> };
    expect(out.accounts.map((a) => a.toolkitSlug).sort()).toEqual(['gmail', 'slack']);
  });

  it('override narrows the listed accounts to the intersection', async () => {
    const tool = createComposioListActionsTool(setup(['gmail']));
    const out = (await tool.handler({}, ctxFor('thread-1'))) as { accounts: Array<{ toolkitSlug: string }> };
    expect(out.accounts.map((a) => a.toolkitSlug)).toEqual(['gmail']);
  });

  it('override blocks a call to a narrowed-out app but allows an included one', async () => {
    const call = createComposioCallTool(setup(['gmail']));
    await expect(
      call.handler(
        { accountId: 'ca_slack', actionName: 'SLACK_DO', parameters: {} },
        ctxFor('thread-1'),
      ),
    ).rejects.toThrow(/not enabled for this conversation/);
    const ok = (await call.handler(
      { accountId: 'ca_gmail', actionName: 'GMAIL_DO', parameters: {} },
      ctxFor('thread-1'),
    )) as { ok: boolean };
    expect(ok.ok).toBe(true);
  });
});
