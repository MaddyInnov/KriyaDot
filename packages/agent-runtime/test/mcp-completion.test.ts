// SPDX-License-Identifier: Apache-2.0
// MCP completion pass: elicitation routing, health monitor with
// auto-restart, and tool-misuse hints.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LazyMcpManager, type LazyMcpConnector } from '../src/mcp-directory.js';
import { MCPClient } from '../src/mcp.js';
import { didYouMeanSuffix, editDistance, suggestSimilarNames } from '../src/tool-hints.js';
import type { ToolContext } from '../src/types.js';
import type { WidgetHost } from '../src/widgets.js';

describe('tool misuse hints', () => {
  it('computes edit distance', () => {
    expect(editDistance('read_file', 'read_file')).toBe(0);
    expect(editDistance('read_file', 'read_files')).toBe(1);
    expect(editDistance('', 'abc')).toBe(3);
  });

  it('suggests the closest tool names', () => {
    const names = ['read_file', 'write_file', 'run_command', 'web_search'];
    expect(suggestSimilarNames('read_fil', names)).toContain('read_file');
    expect(suggestSimilarNames('zzzzzz', names)).toEqual([]);
    expect(didYouMeanSuffix('web_serch', names)).toContain('web_search');
    expect(didYouMeanSuffix('zzzzzz', names)).toBe('');
  });
});

describe('MCP elicitation', () => {
  it('delegates to a custom handler and fails closed on handler errors', async () => {
    const client = new MCPClient({
      elicitation: async (req) => ({ action: 'accept', content: { got: req.message } }),
    });
    await expect(
      client.handleElicitation({ message: 'need a token', requestedSchema: {} }),
    ).resolves.toEqual({ action: 'accept', content: { got: 'need a token' } });

    const throwing = new MCPClient({
      elicitation: async () => {
        throw new Error('boom');
      },
    });
    await expect(
      throwing.handleElicitation({ message: 'x', requestedSchema: {} }),
    ).resolves.toEqual({ action: 'decline' });
  });

  it('declines when no elicitation mode is configured', async () => {
    const client = new MCPClient({});
    await expect(
      client.handleElicitation({ message: 'x', requestedSchema: {} }),
    ).resolves.toEqual({ action: 'decline' });
  });

  it('widget mode maps an enum answer and free text onto the requested property', async () => {
    const client = new MCPClient({ elicitation: 'widget' });
    const raised: Array<{ title?: string }> = [];
    const host: WidgetHost = {
      raise: async (input) => {
        raised.push(input);
        return {
          id: 'w1',
          kind: input.kind,
          payload: input.payload,
          interactive: true,
          expiresAt: null,
          neverExpire: false,
          createdAt: Date.now(),
        } as never;
      },
      emit: () => undefined,
      awaitAnswer: async () => ({ answered: true, value: ['e1'] }),
    };
    // Simulate an in-flight tool call context.
    (client as unknown as { activeToolCtx: ToolContext }).activeToolCtx = {
      sessionId: 's1',
      botId: 'b1',
      widget: host,
    };
    const result = await client.handleElicitation({
      message: 'Which environment?',
      requestedSchema: {
        type: 'object',
        properties: { env: { type: 'string', enum: ['staging', 'production'] } },
      },
    });
    expect(raised).toHaveLength(1);
    expect(result).toEqual({ action: 'accept', content: { env: 'production' } });
  });

  it('widget mode declines without a widget host (e.g. headless turn)', async () => {
    const client = new MCPClient({ elicitation: 'widget' });
    await expect(
      client.handleElicitation({ message: 'x', requestedSchema: {} }),
    ).resolves.toEqual({ action: 'decline' });
  });
});

describe('LazyMcpManager health monitor', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mvp-mcp-health-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function connector(pingImpl: () => Promise<void>): LazyMcpConnector {
    return {
      listTools: async () => [],
      close: async () => undefined,
      ping: pingImpl,
    };
  }

  it('restarts a server whose probe fails and counts the restart', async () => {
    let generation = 0;
    const manager = new LazyMcpManager({
      dataDir: dir,
      healthCheckIntervalMs: 0,
      connectFn: async () => {
        generation++;
        const gen = generation;
        return connector(async () => {
          if (gen === 1) throw new Error('connection dead');
        });
      },
    });
    try {
      const server = manager.installCustom('flaky', { kind: 'stdio', command: 'true' });
      await manager.warmUp(server.id);
      expect(manager.status(server.id).status).toBe('running');
      await manager.checkHealthOnce();
      const status = manager.status(server.id);
      expect(status.status).toBe('running'); // restarted successfully
      expect(status.restarts).toBe(1);
      expect(status.lastCheckAt).not.toBeNull();
    } finally {
      await manager.close();
    }
  });

  it('leaves a healthy server alone', async () => {
    const manager = new LazyMcpManager({
      dataDir: dir,
      healthCheckIntervalMs: 0,
      connectFn: async () => connector(async () => undefined),
    });
    try {
      const server = manager.installCustom('fine', { kind: 'stdio', command: 'true' });
      await manager.warmUp(server.id);
      await manager.checkHealthOnce();
      expect(manager.status(server.id)).toMatchObject({ status: 'running', restarts: 0 });
    } finally {
      await manager.close();
    }
  });

  it('autoBindExact binds only on an exact label match', async () => {
    const manager = new LazyMcpManager({
      dataDir: dir,
      healthCheckIntervalMs: 0,
      connectFn: async () => connector(async () => undefined),
    });
    try {
      const server = manager.installCustom('fetch-pro', { kind: 'stdio', command: 'true' });
      // Near matches never bind.
      expect(manager.autoBindExact('bot-1', 'fetch')).toBeNull();
      expect(manager.autoBindExact('bot-1', 'Fetch-Pro')).toBeNull();
      expect(manager.autoBindExact('bot-1', 'fetch-pro ')).toBeNull();
      // Exact label binds and allows the bot.
      const bound = manager.autoBindExact('bot-1', 'fetch-pro');
      expect(bound?.id).toBe(server.id);
      expect(manager.store.isBotAllowed(server.id, 'bot-1')).toBe(true);
    } finally {
      await manager.close();
    }
  });

  it('marks error and does not restart when autoRestart is off', async () => {
    const manager = new LazyMcpManager({
      dataDir: dir,
      healthCheckIntervalMs: 0,
      autoRestart: false,
      connectFn: async () =>
        connector(async () => {
          throw new Error('dead');
        }),
    });
    try {
      const server = manager.installCustom('dead', { kind: 'stdio', command: 'true' });
      await manager.warmUp(server.id);
      await manager.checkHealthOnce();
      expect(manager.status(server.id).status).toBe('error');
      expect(manager.status(server.id).lastError).toContain('dead');
    } finally {
      await manager.close();
    }
  });
});
