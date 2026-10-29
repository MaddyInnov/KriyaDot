// SPDX-License-Identifier: Apache-2.0
// Connector tools (Octop §2.9) + HighLevel CRM tools: every HTTP call is
// stubbed through the injected fetch; the Obsidian tools run against a
// temp vault. Zero real network.

import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolContext, ToolDefinition } from '@mvp/agent-runtime';
import {
  createConnectorTools,
  createDifyRunAppTool,
  createObsidianReadNoteTool,
  createObsidianSearchTool,
  createOpenAlexSearchTool,
  createTickTickCreateTaskTool,
  createTickTickListTasksTool,
} from '../src/connector-tools.js';
import { createHighLevelCreateContactTool, createHighLevelListContactsTool } from '../src/highlevel-tools.js';

const ctx = {} as ToolContext;

function stubFetch(handler: (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => unknown) {
  const calls: Array<{ url: string; init?: { method?: string; body?: string; headers?: Record<string, string> } }> = [];
  const fetchFn = async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    calls.push({ url: String(url), init });
    const body = handler(String(url), init);
    return { ok: true, status: 200, json: async () => body } as Response;
  };
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

function tool(tools: ToolDefinition[], name: string): ToolDefinition {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} missing`);
  return t;
}

describe('openalex_search', () => {
  it('maps works and needs no key', async () => {
    const { fetchFn, calls } = stubFetch(() => ({
      results: [
        {
          id: 'https://openalex.org/W1',
          display_name: 'Attention Is All You Need',
          publication_year: 2017,
          doi: 'https://doi.org/10.48550/x',
          cited_by_count: 100000,
          authorships: [{ author: { display_name: 'Ashish Vaswani' } }],
        },
      ],
    }));
    const out = (await createOpenAlexSearchTool({ fetchFn, env: {} }).handler({ query: 'attention' }, ctx)) as {
      results: Array<{ title: string; year: number; authors: string[] }>;
    };
    expect(calls[0].url).toContain('api.openalex.org/works');
    expect(out.results[0]).toMatchObject({ title: 'Attention Is All You Need', year: 2017, authors: ['Ashish Vaswani'] });
  });
});

describe('ticktick tools', () => {
  const env = { TICKTICK_ACCESS_TOKEN: 'tt-token' };

  it('list flattens tasks across projects, skipping completed', async () => {
    const { fetchFn } = stubFetch((url) => {
      if (url.endsWith('/project')) return [{ id: 'p1', name: 'Inbox' }];
      return {
        tasks: [
          { id: 't1', title: 'Open one', status: 0, priority: 3 },
          { id: 't2', title: 'Done one', status: 2 },
        ],
      };
    });
    const out = (await createTickTickListTasksTool({ fetchFn, env }).handler({}, ctx)) as {
      tasks: Array<{ title: string; projectName: string }>;
    };
    expect(out.tasks).toEqual([
      expect.objectContaining({ title: 'Open one', projectName: 'Inbox' }),
    ]);
  });

  it('create posts the task body with the bearer token', async () => {
    const { fetchFn, calls } = stubFetch(() => ({ id: 't-new' }));
    const out = (await createTickTickCreateTaskTool({ fetchFn, env }).handler(
      { title: 'Ship it', projectId: 'p1' },
      ctx,
    )) as { taskId: string };
    expect(out.taskId).toBe('t-new');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.headers?.authorization).toBe('Bearer tt-token');
    expect(JSON.parse(calls[0].init?.body ?? '{}')).toMatchObject({ title: 'Ship it', projectId: 'p1' });
  });

  it('missing token is a clear config error', async () => {
    await expect(createTickTickListTasksTool({ env: {} }).handler({}, ctx)).rejects.toThrow(/TICKTICK_ACCESS_TOKEN/);
  });
});

describe('obsidian tools', () => {
  function makeVault(): string {
    const vault = mkdtempSync(join(tmpdir(), 'vault-test-'));
    fs.mkdirSync(join(vault, 'Projects'), { recursive: true });
    fs.writeFileSync(join(vault, 'Projects', 'Plan.md'), '# Plan\n\nThe roadmap mentions quokkas.\n');
    fs.writeFileSync(join(vault, 'Daily.md'), 'Nothing special.\n');
    fs.mkdirSync(join(vault, '.obsidian'), { recursive: true });
    fs.writeFileSync(join(vault, '.obsidian', 'app.json'), '{}');
    return vault;
  }

  it('search finds content matches with snippets', async () => {
    const vault = makeVault();
    const out = (await createObsidianSearchTool({ env: { OBSIDIAN_VAULT_PATH: vault } }).handler(
      { query: 'quokkas' },
      ctx,
    )) as { matches: Array<{ path: string; snippet: string }> };
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0].path).toBe(join('Projects', 'Plan.md'));
    expect(out.matches[0].snippet).toContain('quokkas');
  });

  it('read_note reads inside the vault and refuses traversal', async () => {
    const vault = makeVault();
    const read = createObsidianReadNoteTool({ env: { OBSIDIAN_VAULT_PATH: vault } });
    const out = (await read.handler({ path: 'Daily.md' }, ctx)) as { content: string };
    expect(out.content).toContain('Nothing special');
    await expect(read.handler({ path: '../outside.md' }, ctx)).rejects.toThrow(/outside the Obsidian vault/);
    await expect(read.handler({ path: '/etc/passwd' }, ctx)).rejects.toThrow(/outside the Obsidian vault/);
  });

  it('missing vault config is a clear error', async () => {
    await expect(createObsidianSearchTool({ env: {} }).handler({ query: 'x' }, ctx)).rejects.toThrow(
      /OBSIDIAN_VAULT_PATH/,
    );
  });
});

describe('dify_run_app', () => {
  it('posts inputs in blocking mode and returns outputs', async () => {
    const { fetchFn, calls } = stubFetch(() => ({ data: { status: 'succeeded', outputs: { answer: 'done' } } }));
    const out = (await createDifyRunAppTool({
      fetchFn,
      env: { DIFY_API_URL: 'https://api.dify.ai/v1/', DIFY_API_KEY: 'app-key' },
    }).handler({ inputs: { topic: 'x' } }, ctx)) as { outputs: { answer: string } };
    expect(out.outputs).toEqual({ answer: 'done' });
    expect(calls[0].url).toBe('https://api.dify.ai/v1/workflows/run');
    expect(calls[0].init?.headers?.authorization).toBe('Bearer app-key');
    expect(JSON.parse(calls[0].init?.body ?? '{}')).toMatchObject({ inputs: { topic: 'x' }, response_mode: 'blocking' });
  });

  it('missing config errors name the env vars', async () => {
    await expect(createDifyRunAppTool({ env: {} }).handler({ inputs: {} }, ctx)).rejects.toThrow(/DIFY_API_URL/);
    await expect(
      createDifyRunAppTool({ env: { DIFY_API_URL: 'https://api.dify.ai/v1' } }).handler({ inputs: {} }, ctx),
    ).rejects.toThrow(/DIFY_API_KEY/);
  });
});

describe('highlevel tools', () => {
  const env = { HIGHLEVEL_API_KEY: 'hl-key', HIGHLEVEL_LOCATION_ID: 'loc-1' };

  it('list contacts maps the LeadConnector response', async () => {
    const { fetchFn, calls } = stubFetch(() => ({
      contacts: [
        { id: 'c1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', phone: '+100', tags: ['vip'] },
      ],
    }));
    const out = (await createHighLevelListContactsTool({ fetchFn, env }).handler({}, ctx)) as {
      contacts: Array<{ name: string; email: string }>;
    };
    expect(calls[0].url).toContain('services.leadconnectorhq.com/contacts/');
    expect(calls[0].url).toContain('locationId=loc-1');
    expect(calls[0].init?.headers?.version).toBe('2021-07-28');
    expect(out.contacts[0]).toMatchObject({ name: 'Ada Lovelace', email: 'ada@example.com' });
  });

  it('create contact posts locationId + fields', async () => {
    const { fetchFn, calls } = stubFetch(() => ({ contact: { id: 'c-new' } }));
    const out = (await createHighLevelCreateContactTool({ fetchFn, env }).handler(
      { firstName: 'Grace', email: 'g@example.com', tags: ['lead'] },
      ctx,
    )) as { contactId: string };
    expect(out.contactId).toBe('c-new');
    expect(JSON.parse(calls[0].init?.body ?? '{}')).toMatchObject({
      locationId: 'loc-1',
      firstName: 'Grace',
      email: 'g@example.com',
      tags: ['lead'],
    });
  });

  it('missing config errors are clear; empty create is rejected', async () => {
    await expect(createHighLevelListContactsTool({ env: {} }).handler({}, ctx)).rejects.toThrow(/HIGHLEVEL_API_KEY/);
    await expect(
      createHighLevelListContactsTool({ env: { HIGHLEVEL_API_KEY: 'k' } }).handler({}, ctx),
    ).rejects.toThrow(/HIGHLEVEL_LOCATION_ID/);
    await expect(createHighLevelCreateContactTool({ fetchFn: stubFetch(() => ({})).fetchFn, env }).handler({}, ctx)).rejects.toThrow(
      /at least one of/,
    );
  });
});

describe('createConnectorTools registry shape', () => {
  it('exports all six tools with unique names', () => {
    const tools = createConnectorTools({ env: {} });
    expect(tools.map((t) => t.name).sort()).toEqual([
      'dify_run_app',
      'obsidian_read_note',
      'obsidian_search',
      'openalex_search',
      'ticktick_create_task',
      'ticktick_list_tasks',
    ]);
    expect(tool(tools, 'openalex_search').mutating).toBeFalsy();
    expect(tool(tools, 'ticktick_create_task').mutating).toBe(true);
  });
});
